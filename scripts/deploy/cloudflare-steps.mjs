/**
 * Cloudflare side of the deploy, each step looked up by name first so a
 * re-run creates nothing twice:
 * - Access: one-time PIN login, reusable policies (emails; the agent's
 *   service token), and the self-hosted Access application whose `aud` the
 *   app verifies. Access exists before DNS, so the hostname is never served
 *   unprotected.
 * - DNS, last: the hostname as a proxied A record to the VPS (ORIGIN_IP),
 *   where Dokploy's Traefik routes it to the app. An existing record for the
 *   hostname is updated in place (same record id), whatever it pointed to.
 */

import { isDryRun } from './api-clients.mjs';
import { NAMES } from './config.mjs';
import { ORIGIN_MASK } from './redaction.mjs';
import { DeployStop } from './run-context.mjs';

/** Comment on the DNS record, so the dashboard says what owns it. */
export const DNS_COMMENT = 'Content Radar on Dokploy Traefik (scripts/deploy/dokploy-cloudflare.mjs)';
const ADDRESS_TYPES = new Set(['A', 'AAAA']);

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
 * @param {any} record
 * @param {string} originIp
 * @returns {boolean} True for the record the hostname needs: a proxied A record to the origin.
 */
export function isOriginRecord(record, originIp) {
  return record?.type === 'A' && record.content === originIp && record.proxied === true;
}

/**
 * Short description of DNS records for messages. Addresses are never shown:
 * the origin appears as `ORIGIN_MASK`, any other address as `<other address>`.
 * @param {any[]} records
 * @param {string} originIp
 * @returns {string}
 */
export function describeDnsRecords(records, originIp) {
  return records.map(record => {
    const type = record?.type ?? '?';
    const target = !ADDRESS_TYPES.has(type) ? (record?.content ?? '?')
      : record.content === originIp ? ORIGIN_MASK : '<other address>';
    return `${type} ${target}${record?.proxied ? ' (proxied)' : ''}`;
  }).join(', ');
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
 * The proxied A record to the origin, created last. A record of another type
 * (such as an earlier CNAME), address, or proxy setting is updated in place;
 * several records for the hostname stop the deploy, which never deletes one.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<any>} The record, or `null` when its creation is only planned.
 */
export async function ensureDnsRecord(ctx) {
  const { zoneId } = ctx.config.cloudflare;
  const { hostname, originIp } = ctx.config;
  const desired = { type: 'A', name: hostname, content: originIp, proxied: true, ttl: 1, comment: DNS_COMMENT };
  const records = await findDnsRecords(ctx);
  if (records.length > 1) {
    throw new DeployStop(`DNS has ${records.length} records for ${hostname} (${describeDnsRecords(records, originIp)}). The deploy updates one record in place and never deletes any: remove the extra ones, then re-run.`);
  }
  if (records.length === 0) {
    ctx.change('create', `DNS: proxied A record ${hostname} → ${ORIGIN_MASK} (ORIGIN_IP)`);
    const created = await ctx.cloudflare.post(`/zones/${zoneId}/dns_records`, desired);
    return isDryRun(created) ? null : created;
  }
  const [record] = records;
  if (isOriginRecord(record, originIp)) {
    ctx.report.ok(`DNS: ${hostname} is a proxied A record to ${ORIGIN_MASK}.`);
    return record;
  }
  ctx.change('update', `DNS: ${hostname} ${describeDnsRecords([record], originIp)} → proxied A record to ${ORIGIN_MASK} (ORIGIN_IP), same record`);
  const updated = await ctx.cloudflare.put(`/zones/${zoneId}/dns_records/${record.id}`, desired);
  return isDryRun(updated) ? record : updated;
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

function requireId(value, what) {
  if (typeof value?.id !== 'string' || value.id === '') throw new DeployStop(`Cloudflare returned no id for ${what}.`);
  return value;
}

function requireAud(app) {
  if (typeof app?.aud !== 'string' || app.aud === '') throw new DeployStop('The Access application has no AUD tag in the API response.');
  return app;
}
