/**
 * Cloudflare side of the deploy, each step looked up by name first so a
 * re-run creates nothing twice:
 * - Access: one-time PIN login, reusable policies (emails; the agent's
 *   service token), and the self-hosted Access application whose `aud` the
 *   app verifies. Access exists before DNS, so the hostname is never served
 *   unprotected.
 * - Tunnel: a remotely managed tunnel whose ingress points straight at the
 *   app's service on `dokploy-network` and makes cloudflared require a valid
 *   Access token as well.
 * - DNS, last: a proxied CNAME to the tunnel. An existing record that points
 *   anywhere else is never overwritten.
 */

import { ApiError, isDryRun } from './api-clients.mjs';
import { APP_PORT, NAMES } from './config.mjs';
import { DeployStop } from './run-context.mjs';

const TUNNEL_DOMAIN = 'cfargotunnel.com';

/**
 * Access applications that protect exactly `APP_HOSTNAME`.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<any[]>}
 */
export async function findAccessApps(ctx) {
  const { accountId } = ctx.config.cloudflare;
  const apps = await ctx.cloudflare.list(`/accounts/${accountId}/access/apps`, { domain: ctx.config.hostname });
  return apps.filter(app => coversHostname(app, ctx.config.hostname));
}

/**
 * Tunnels named `content-radar` that are not deleted.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<any[]>}
 */
export async function findTunnels(ctx) {
  const { accountId } = ctx.config.cloudflare;
  const tunnels = await ctx.cloudflare.list(`/accounts/${accountId}/cfd_tunnel`, { name: NAMES.tunnel, is_deleted: false });
  return tunnels.filter(tunnel => tunnel?.name === NAMES.tunnel && !tunnel.deleted_at);
}

/**
 * DNS records whose name is exactly `APP_HOSTNAME`.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<any[]>}
 */
export async function findDnsRecords(ctx) {
  const { zoneId } = ctx.config.cloudflare;
  const records = await ctx.cloudflare.list(`/zones/${zoneId}/dns_records`, { name: ctx.config.hostname });
  return records.filter(record => sameHost(record?.name, ctx.config.hostname));
}

/**
 * @param {any} tunnel
 * @returns {boolean} True when the tunnel's configuration is managed through the API.
 */
export function isRemotelyManaged(tunnel) {
  return tunnel?.remote_config === true || tunnel?.config_src === 'cloudflare';
}

/**
 * @param {string} tunnelId
 * @returns {string}
 */
export function tunnelTarget(tunnelId) {
  return `${tunnelId}.${TUNNEL_DOMAIN}`;
}

/**
 * @param {any} record
 * @param {string} target
 * @returns {boolean}
 */
export function isCnameTo(record, target) {
  return record?.type === 'CNAME' && sameHost(record.content, target);
}

/**
 * Short, non-secret description of DNS records for messages.
 * @param {any[]} records
 * @returns {string}
 */
export function describeDnsRecords(records) {
  return records.map(record => `${record?.type ?? '?'} ${record?.content ?? '?'}${record?.proxied ? ' (proxied)' : ''}`).join(', ');
}

/**
 * One-time PIN login, the two reusable policies, and the Access application.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {{ serviceTokenId: string }} facts
 * @returns {Promise<{ aud: string, applicationId: string, allowPolicyId: string, servicePolicyId: string, identityProviderId: string|null }>}
 */
export async function ensureAccess(ctx, { serviceTokenId }) {
  const { accountId } = ctx.config.cloudflare;
  const base = `/accounts/${accountId}/access`;

  const providers = await ctx.cloudflare.list(`${base}/identity_providers`);
  let provider = providers.find(entry => entry?.type === 'onetimepin') ?? null;
  if (provider) {
    ctx.report.ok(`One-time PIN login is available (identity provider ${provider.id}).`);
  } else {
    ctx.change('create', 'Access identity provider: one-time PIN (email code login)');
    const created = await ctx.cloudflare.post(`${base}/identity_providers`, { name: NAMES.otpProvider, type: 'onetimepin', config: {} });
    provider = isDryRun(created) ? null : created;
  }

  const policies = await ctx.cloudflare.list(`${base}/policies`);
  const emails = [...new Set([...ctx.config.operatorEmails, ...ctx.config.viewerEmails])].sort();
  const allow = await ensurePolicy(ctx, policies, {
    name: NAMES.allowPolicy,
    decision: 'allow',
    include: emails.map(email => ({ email: { email } })),
  }, `${emails.length} email address${emails.length === 1 ? '' : 'es'}`);
  const service = await ensurePolicy(ctx, policies, {
    name: NAMES.servicePolicy,
    decision: 'non_identity',
    include: [{ service_token: { token_id: serviceTokenId } }],
  }, 'the agent service token');

  const app = await ensureAccessApp(ctx, [allow.id, service.id]);
  return {
    aud: app.aud,
    applicationId: app.id,
    allowPolicyId: allow.id,
    servicePolicyId: service.id,
    identityProviderId: provider?.id ?? null,
  };
}

async function ensurePolicy(ctx, policies, desired, what) {
  const { accountId } = ctx.config.cloudflare;
  const base = `/accounts/${accountId}/access/policies`;
  const matches = policies.filter(policy => policy?.name === desired.name);
  if (matches.length > 1) {
    throw new DeployStop(`Cloudflare has ${matches.length} reusable Access policies named "${desired.name}"; delete the extra ones, then re-run.`);
  }
  if (matches.length === 0) {
    ctx.change('create', `Access policy "${desired.name}" (${desired.decision}: ${what})`);
    const created = await ctx.cloudflare.post(base, desired);
    if (isDryRun(created)) return { id: `<new-policy-id:${desired.name}>` };
    return requireId(created, `policy "${desired.name}"`);
  }
  let current = matches[0];
  if (!Array.isArray(current.include)) current = await ctx.cloudflare.get(`${base}/${current.id}`);
  const unchanged = current?.decision === desired.decision
    && sameRules(current.include, desired.include)
    && !hasRules(current.exclude)
    && !hasRules(current.require);
  if (unchanged) {
    ctx.report.ok(`Access policy "${desired.name}" is up to date (${desired.decision}: ${what}).`);
    return current;
  }
  ctx.change('update', `Access policy "${desired.name}" (${desired.decision}: ${what})`);
  const updated = await ctx.cloudflare.put(`${base}/${matches[0].id}`, desired);
  return isDryRun(updated) ? current : requireId(updated, `policy "${desired.name}"`);
}

async function ensureAccessApp(ctx, policyIds) {
  const { accountId } = ctx.config.cloudflare;
  const base = `/accounts/${accountId}/access/apps`;
  const hostname = ctx.config.hostname;
  const desired = {
    name: NAMES.accessApp,
    type: 'self_hosted',
    domain: hostname,
    destinations: [{ type: 'public', uri: hostname }],
    policies: policyIds.map((id, index) => ({ id, precedence: index + 1 })),
  };
  const apps = await findAccessApps(ctx);
  if (apps.length > 1) {
    throw new DeployStop(`Cloudflare has ${apps.length} Access applications for ${hostname}; keep one, then re-run.`);
  }
  if (apps.length === 0) {
    ctx.change('create', `Access application "${NAMES.accessApp}" (self-hosted) for ${hostname} with both policies`);
    const created = await ctx.cloudflare.post(base, desired);
    if (isDryRun(created)) return { id: '<new-access-app-id>', aud: '<new-access-app-aud>' };
    return requireAud(created);
  }

  let app = apps[0];
  if (app.type !== 'self_hosted') {
    throw new DeployStop(`An Access application of type "${app.type}" already covers ${hostname}; the deploy needs a self-hosted one. Remove it, then re-run.`);
  }
  if (!Array.isArray(app.policies) || typeof app.aud !== 'string') app = await ctx.cloudflare.get(`${base}/${app.id}`);
  const attached = (Array.isArray(app?.policies) ? app.policies : []).map(policy => (typeof policy === 'string' ? policy : policy?.id));
  const missing = policyIds.filter(id => !attached.includes(id));
  const extra = (Array.isArray(app?.policies) ? app.policies : []).filter(policy => {
    const id = typeof policy === 'string' ? policy : policy?.id;
    return id && !policyIds.includes(id);
  });
  if (extra.length > 0) {
    const names = extra.map(policy => (typeof policy === 'object' && policy?.name ? `"${policy.name}"${policy.decision ? ` (${policy.decision})` : ''}` : 'unnamed'));
    ctx.report.warn(`The Access application for ${hostname} also has ${extra.length} other polic${extra.length === 1 ? 'y' : 'ies'}: ${names.join(', ')}. The deploy keeps them; review them, because an extra allow or bypass policy widens who can reach the app.`);
  }
  if (missing.length === 0) {
    ctx.report.ok(`Access application "${app.name}" protects ${hostname} with both policies.`);
    return requireAud(app);
  }
  if (app.name !== NAMES.accessApp) {
    throw new DeployStop(`The Access application "${app.name}" covers ${hostname} without the content-radar policies; attach "${NAMES.allowPolicy}" and "${NAMES.servicePolicy}" in the Zero Trust dashboard or delete that application, then re-run.`);
  }
  const others = attached.filter(id => id && !policyIds.includes(id));
  ctx.change('update', `Access application "${app.name}": attach ${missing.length} content-radar polic${missing.length === 1 ? 'y' : 'ies'}`);
  const updated = await ctx.cloudflare.put(`${base}/${app.id}`, {
    ...desired,
    policies: [...policyIds, ...others].map((id, index) => ({ id, precedence: index + 1 })),
  });
  return isDryRun(updated) ? requireAud(app) : requireAud(updated?.aud ? updated : app);
}

/**
 * Find the `content-radar` tunnel or create a remotely managed one.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<{ id: string, created: boolean, pending?: boolean }>}
 */
export async function ensureTunnel(ctx) {
  const { accountId } = ctx.config.cloudflare;
  const tunnels = await findTunnels(ctx);
  if (tunnels.length > 1) {
    throw new DeployStop(`Cloudflare has ${tunnels.length} tunnels named "${NAMES.tunnel}"; delete the extra ones, then re-run.`);
  }
  if (tunnels.length === 1) {
    const [tunnel] = tunnels;
    if (!isRemotelyManaged(tunnel)) {
      throw new DeployStop(`Tunnel "${NAMES.tunnel}" is managed by a local config file; the deploy sets ingress through the API. Migrate it to dashboard management or delete it, then re-run.`);
    }
    ctx.report.ok(`Tunnel "${NAMES.tunnel}" exists (id ${tunnel.id}, status ${tunnel.status ?? 'unknown'}).`);
    return { id: tunnel.id, created: false };
  }
  ctx.change('create', `Cloudflare Tunnel "${NAMES.tunnel}" (config_src: cloudflare)`);
  const created = await ctx.cloudflare.post(`/accounts/${accountId}/cfd_tunnel`, { name: NAMES.tunnel, config_src: 'cloudflare' });
  if (isDryRun(created)) return { id: '<new-tunnel-id>', created: true, pending: true };
  if (typeof created?.token === 'string') ctx.redactor.add(created.token);
  if (typeof created?.id !== 'string' || created.id === '') throw new DeployStop('Creating the tunnel returned no tunnel id.');
  return { id: created.id, created: true };
}

/**
 * Ingress: `APP_HOSTNAME` → the app's service on `dokploy-network`, with
 * cloudflared also requiring a valid Access token; everything else 404.
 * @param {{ hostname: string, appName: string, teamName: string, aud: string }} values
 * @returns {object[]}
 */
export function desiredIngress({ hostname, appName, teamName, aud }) {
  return [
    {
      hostname,
      service: `http://${appName}:${APP_PORT}`,
      originRequest: { access: { required: true, teamName, audTag: [aud] } },
    },
    { service: 'http_status:404' },
  ];
}

/**
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {{ id: string, pending?: boolean }} tunnel
 * @param {{ appName: string, teamName: string, aud: string }} values
 */
export async function ensureTunnelIngress(ctx, tunnel, { appName, teamName, aud }) {
  const { accountId } = ctx.config.cloudflare;
  const path = `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`;
  const ingress = desiredIngress({ hostname: ctx.config.hostname, appName, teamName, aud });
  let config = {};
  if (!tunnel.pending) {
    try {
      const current = await ctx.cloudflare.get(path);
      if (current?.config && typeof current.config === 'object') config = current.config;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  if (sameIngress(config.ingress, ingress)) {
    ctx.report.ok(`Tunnel ingress routes ${ctx.config.hostname} to http://${appName}:${APP_PORT} with Access required.`);
    return;
  }
  ctx.change('update', `Tunnel ingress: ${ctx.config.hostname} → http://${appName}:${APP_PORT} (Access token required), everything else 404`);
  await ctx.cloudflare.put(path, { config: { ...config, ingress } });
}

/**
 * The tunnel token, registered with the redactor. Never printed or stored.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {string} tunnelId
 * @returns {Promise<string>}
 */
export async function fetchTunnelToken(ctx, tunnelId) {
  const { accountId } = ctx.config.cloudflare;
  const token = await ctx.cloudflare.get(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
  if (typeof token !== 'string' || token.length < 20) throw new DeployStop('The tunnel token API returned no token.');
  return ctx.redactor.add(token);
}

/**
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {string} tunnelId
 * @returns {Promise<{ status: string, connections: number }>}
 */
export async function readTunnelStatus(ctx, tunnelId) {
  const { accountId } = ctx.config.cloudflare;
  const tunnel = await ctx.cloudflare.get(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
  return {
    status: typeof tunnel?.status === 'string' ? tunnel.status : 'unknown',
    connections: Array.isArray(tunnel?.connections) ? tunnel.connections.length : 0,
  };
}

/**
 * The proxied CNAME, created last. Stops instead of touching a record that
 * points anywhere else.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {{ id: string }} tunnel
 * @returns {Promise<any>}
 */
export async function ensureDnsRecord(ctx, tunnel) {
  const { zoneId } = ctx.config.cloudflare;
  const hostname = ctx.config.hostname;
  const target = tunnelTarget(tunnel.id);
  const records = await findDnsRecords(ctx);
  if (records.length === 0) {
    ctx.change('create', `DNS: proxied CNAME ${hostname} → ${target}`);
    const created = await ctx.cloudflare.post(`/zones/${zoneId}/dns_records`, {
      type: 'CNAME',
      name: hostname,
      content: target,
      proxied: true,
      ttl: 1,
      comment: 'Content Radar tunnel (scripts/deploy/dokploy-cloudflare.mjs)',
    });
    return isDryRun(created) ? null : created;
  }
  if (records.length === 1 && isCnameTo(records[0], target)) {
    if (records[0].proxied === true) {
      ctx.report.ok(`DNS: ${hostname} is a proxied CNAME to the tunnel.`);
      return records[0];
    }
    ctx.change('update', `DNS: turn on the Cloudflare proxy for the tunnel CNAME of ${hostname}`);
    const updated = await ctx.cloudflare.patch(`/zones/${zoneId}/dns_records/${records[0].id}`, { proxied: true });
    return isDryRun(updated) ? records[0] : updated;
  }
  throw new DeployStop(`DNS already has ${describeDnsRecords(records)} for ${hostname}, which does not point to the content-radar tunnel (${target}). The deploy never overwrites DNS records: delete it or choose another APP_HOSTNAME, then re-run.`);
}

function coversHostname(app, hostname) {
  const destinations = Array.isArray(app?.destinations)
    ? app.destinations.filter(entry => entry?.type === undefined || entry?.type === 'public').map(entry => entry?.uri)
    : [];
  const hosts = [app?.domain, ...(Array.isArray(app?.self_hosted_domains) ? app.self_hosted_domains : []), ...destinations];
  return hosts.some(host => sameHost(host, hostname));
}

function sameHost(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = value => value.trim().toLowerCase().replace(/\.$/, '').replace(/\/+$/, '');
  return normalize(left) === normalize(right);
}

function ruleKey(rule) {
  if (typeof rule?.email?.email === 'string') return `email:${rule.email.email.toLowerCase()}`;
  if (typeof rule?.service_token?.token_id === 'string') return `service_token:${rule.service_token.token_id}`;
  return JSON.stringify(rule);
}

function sameRules(current, desired) {
  if (!Array.isArray(current)) return false;
  const left = current.map(ruleKey).sort();
  const right = desired.map(ruleKey).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function hasRules(rules) {
  return Array.isArray(rules) && rules.length > 0;
}

function sameIngress(current, desired) {
  if (!Array.isArray(current) || current.length !== desired.length) return false;
  return desired.every((rule, index) => {
    const actual = current[index];
    const access = actual?.originRequest?.access;
    const wanted = rule.originRequest?.access;
    if ((actual?.hostname ?? null) !== (rule.hostname ?? null) || actual?.service !== rule.service) return false;
    if (!wanted) return !access?.required;
    return access?.required === true
      && access.teamName === wanted.teamName
      && Array.isArray(access.audTag)
      && access.audTag.length === wanted.audTag.length
      && wanted.audTag.every(tag => access.audTag.includes(tag));
  });
}

function requireId(value, what) {
  if (typeof value?.id !== 'string' || value.id === '') throw new DeployStop(`Cloudflare returned no id for ${what}.`);
  return value;
}

function requireAud(app) {
  if (typeof app?.aud !== 'string' || app.aud === '') throw new DeployStop('The Access application has no AUD tag in the API response.');
  return app;
}
