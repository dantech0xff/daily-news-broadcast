/**
 * Preflight: read-only checks that everything the deploy needs is in place.
 * Anything that would make the deploy fail midway or expose the app is a
 * blocker; nothing is changed. The deploy command runs this first and stops
 * on any blocker.
 */

import { ApiError } from './api-clients.mjs';
import { describeDnsRecords, findAccessApps, findDnsRecords, findTunnels, isCnameTo, isRemotelyManaged, tunnelTarget } from './cloudflare-steps.mjs';
import { MIN_DOKPLOY_VERSION, NAMES, SHUTDOWN_WAIT_SECONDS, STOP_GRACE_SECONDS, compareVersions, parseVersion } from './config.mjs';
import { DOKPLOY_CALLS, analyzeDokployContract } from './dokploy-contract.mjs';
import { locateDokployResources, publicRoutesOf, readApplication } from './dokploy-steps.mjs';
import { parseEnvText } from './env-text.mjs';
import { errorMessage } from './run-context.mjs';
import { VaultKeyError, parseMasterKey } from '../../src/app/secrets/vault.js';

const ACCESS_TEAM_SUFFIX = '.cloudflareaccess.com';
const SERVICE_TOKEN_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} PreflightFacts
 * @property {{ version?: number[], contract?: import('./dokploy-contract.mjs').DokployContract }} dokploy
 * @property {{ authDomain?: string, teamName?: string, serviceTokenId?: string, zoneName?: string, tunnelId?: string }} cloudflare
 */

/**
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<{ blockers: string[], warnings: string[], facts: PreflightFacts }>}
 */
export async function runPreflight(ctx) {
  const result = { blockers: [], warnings: [], facts: { dokploy: {}, cloudflare: {} } };
  const checks = {
    ok: text => ctx.report.ok(text),
    info: text => ctx.report.info(text),
    warn: text => {
      result.warnings.push(text);
      ctx.report.warn(text);
    },
    blocker: text => {
      result.blockers.push(text);
      ctx.report.blocker(text);
    },
  };

  ctx.report.section('Preflight: Dokploy');
  await checkDokploy(ctx, checks, result.facts.dokploy);
  ctx.report.section('Preflight: Cloudflare');
  await checkCloudflare(ctx, checks, result.facts.cloudflare);
  return result;
}

async function checkDokploy(ctx, checks, facts) {
  let rawVersion;
  try {
    rawVersion = await ctx.dokploy.query('settings.getDokployVersion');
  } catch (error) {
    checks.blocker(`Cannot use the Dokploy API at DOKPLOY_URL: ${errorMessage(error)}`);
    return;
  }
  const version = parseVersion(rawVersion);
  const minimum = MIN_DOKPLOY_VERSION.join('.');
  if (!version) {
    checks.blocker('Dokploy returned a version the script cannot read (settings.getDokployVersion).');
  } else if (compareVersions(version, MIN_DOKPLOY_VERSION) < 0) {
    checks.blocker(`Dokploy is v${version.join('.')}; the deploy needs v${minimum} or later (deployment log API).`);
  } else {
    checks.ok(`Dokploy v${version.join('.')} (v${minimum} or later required).`);
    facts.version = version;
  }

  try {
    const contract = analyzeDokployContract(await ctx.dokploy.query('settings.getOpenApiDocument'));
    facts.contract = contract;
    ctx.contract = contract;
    for (const problem of contract.problems) checks.blocker(`Dokploy API drift: ${problem}`);
    if (contract.problems.length === 0) {
      checks.ok(`The instance OpenAPI document has every procedure and field the deploy uses (${Object.keys(DOKPLOY_CALLS).length} procedures).`);
    }
    for (const note of contract.notes) checks.info(note);
    if (contract.stopGrace) {
      checks.ok(`application.update has a Swarm stop grace period field, "${contract.stopGrace.field}" (${contract.stopGrace.types.join('/') || 'untyped'}); the deploy sets it to ${STOP_GRACE_SECONDS} s.`);
    } else {
      checks.warn(`application.update has no Swarm stop grace period field (looked for a name like stopGracePeriodSwarm). Docker's 10 s default would apply, but the app waits up to ${SHUTDOWN_WAIT_SECONDS} s for a run in flight, so a redeploy during a send could kill it mid-send. Plan to set at least ${STOP_GRACE_SECONDS} s another way.`);
    }
  } catch (error) {
    checks.blocker(`Cannot read the instance OpenAPI document (settings.getOpenApiDocument): ${errorMessage(error)}`);
  }

  let location;
  try {
    location = await locateDokployResources(ctx);
  } catch (error) {
    checks.blocker(`Cannot look up the Dokploy project: ${errorMessage(error)}`);
    return;
  }
  if (!location.project) {
    checks.info(`Dokploy project "${NAMES.project}" does not exist yet; the deploy creates it.`);
    return;
  }
  checks.ok(`Dokploy project "${NAMES.project}" exists with its ${NAMES.environment} environment.`);
  if (!location.apps.cloudflared) checks.info(`Application "${NAMES.cloudflared}" does not exist yet; the deploy creates it.`);
  if (!location.apps.main) {
    checks.info(`Application "${NAMES.app}" does not exist yet; the deploy creates it.`);
    return;
  }
  try {
    const app = await readApplication(ctx, location.apps.main.applicationId, NAMES.app);
    checks.ok(`Application "${NAMES.app}" exists (service ${app.appName}).`);
    const routes = publicRoutesOf(app);
    if (routes.length > 0) checks.blocker(`Application "${NAMES.app}" has ${routes.join(', ')}, which would expose it without Access; remove them in Dokploy.`);
    if (!Object.hasOwn(app, 'env')) {
      checks.blocker('application.one returns no env field, so the deploy could not tell whether APP_MASTER_KEY exists.');
    } else {
      const key = parseEnvText(app.env).values.get('APP_MASTER_KEY') ?? '';
      if (!key) {
        checks.info('APP_MASTER_KEY is not set on the application yet; the deploy generates one.');
      } else {
        ctx.redactor.add(key);
        try {
          parseMasterKey(key);
          checks.ok('APP_MASTER_KEY is set on the application; the deploy reuses it.');
        } catch (error) {
          if (!(error instanceof VaultKeyError)) throw error;
          checks.blocker(`The APP_MASTER_KEY set on the application is invalid (${error.message}); fix it in Dokploy. The deploy never replaces an existing key.`);
        }
      }
    }
  } catch (error) {
    checks.blocker(`Cannot read application "${NAMES.app}": ${errorMessage(error)}`);
  }
}

async function checkCloudflare(ctx, checks, facts) {
  const { accountId, zoneId } = ctx.config.cloudflare;
  const hostname = ctx.config.hostname;

  try {
    const verified = await verifyToken(ctx);
    if (verified.status !== 'active') {
      checks.blocker(`CF_API_TOKEN is not active (status "${verified.status ?? 'unknown'}").`);
      return;
    }
    checks.ok(`CF_API_TOKEN is active (${verified.kind} token).`);
  } catch (error) {
    checks.blocker(`Cloudflare rejected CF_API_TOKEN: ${errorMessage(error)}`);
    return;
  }

  try {
    const organization = await ctx.cloudflare.get(`/accounts/${accountId}/access/organizations`);
    const authDomain = typeof organization?.auth_domain === 'string' ? organization.auth_domain.trim().toLowerCase() : '';
    if (!authDomain) {
      checks.blocker(humanOrganizationAction('the organization has no auth_domain'));
    } else if (!authDomain.endsWith(ACCESS_TEAM_SUFFIX) || authDomain === ACCESS_TEAM_SUFFIX.slice(1)) {
      checks.blocker(`The Zero Trust team domain ${authDomain} is not a <team>${ACCESS_TEAM_SUFFIX} domain; cloudflared's Access check needs the team name.`);
    } else {
      facts.authDomain = authDomain;
      facts.teamName = authDomain.slice(0, -ACCESS_TEAM_SUFFIX.length);
      checks.ok(`Zero Trust organization exists: team domain ${authDomain} (ACCESS_TEAM_DOMAIN=https://${authDomain}).`);
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      checks.blocker(`CF_API_TOKEN cannot read the Zero Trust organization; it needs "Access: Organizations, Identity Providers, and Groups" (${errorMessage(error)}).`);
    } else {
      checks.blocker(humanOrganizationAction(errorMessage(error)));
    }
  }

  await check(checks, 'Cannot list Access identity providers', async () => {
    const providers = await ctx.cloudflare.list(`/accounts/${accountId}/access/identity_providers`);
    if (providers.some(provider => provider?.type === 'onetimepin')) checks.ok('One-time PIN login is available.');
    else checks.info('No one-time PIN login yet; the deploy adds it.');
  });

  await check(checks, `Cannot read zone CF_ZONE_ID`, async () => {
    let zone;
    try {
      zone = await ctx.cloudflare.get(`/zones/${zoneId}`);
    } catch (error) {
      // Zone details may need "Zone: Read", which the deploy itself does not use; the DNS check below still runs.
      if (!(error instanceof ApiError && (error.status === 401 || error.status === 403))) throw error;
      checks.warn(`CF_API_TOKEN cannot read the details of zone CF_ZONE_ID (add "Zone: Read" to enable this check), so the check that APP_HOSTNAME is in that zone is skipped.`);
      return;
    }
    const zoneName = typeof zone?.name === 'string' ? zone.name.toLowerCase() : '';
    if (!zoneName) {
      checks.blocker('Zone CF_ZONE_ID has no name in the API response.');
      return;
    }
    facts.zoneName = zoneName;
    if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) {
      checks.blocker(`APP_HOSTNAME ${hostname} is not in zone ${zoneName} (CF_ZONE_ID).`);
    } else {
      checks.ok(`APP_HOSTNAME ${hostname} is in zone ${zoneName}.`);
    }
    if (zone.account?.id && String(zone.account.id).toLowerCase() !== accountId) {
      checks.blocker(`Zone ${zoneName} belongs to another account than CF_ACCOUNT_ID; the tunnel CNAME must be in the tunnel's account.`);
    }
    if (zone.status && zone.status !== 'active') checks.warn(`Zone ${zoneName} has status "${zone.status}", not active.`);
  });

  await check(checks, 'Cannot list Access service tokens', async () => {
    const tokens = await ctx.cloudflare.list(`/accounts/${accountId}/access/service_tokens`);
    const token = tokens.find(entry => entry?.client_id === ctx.config.serviceToken.clientId);
    if (!token) {
      checks.blocker('No Access service token has CF_ACCESS_CLIENT_ID as its client ID; create one in Zero Trust → Access → Service credentials and set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.');
      return;
    }
    const expiresAt = token.expires_at ? Date.parse(token.expires_at) : NaN;
    const expiry = Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : 'no expiry';
    if (Number.isFinite(expiresAt) && expiresAt <= ctx.now()) {
      checks.blocker(`Service token "${token.name}" (id ${token.id}) expired at ${expiry}; renew it.`);
      return;
    }
    facts.serviceTokenId = token.id;
    checks.ok(`Service token "${token.name}" (id ${token.id}) exists; expires: ${expiry}.`);
    if (Number.isFinite(expiresAt) && expiresAt - ctx.now() < SERVICE_TOKEN_EXPIRY_WARNING_DAYS * DAY_MS) {
      checks.warn(`Service token "${token.name}" expires within ${SERVICE_TOKEN_EXPIRY_WARNING_DAYS} days.`);
    }
  });

  await check(checks, 'Cannot list Access policies and applications', async () => {
    const policies = await ctx.cloudflare.list(`/accounts/${accountId}/access/policies`);
    for (const name of [NAMES.allowPolicy, NAMES.servicePolicy]) {
      const count = policies.filter(policy => policy?.name === name).length;
      if (count > 1) checks.blocker(`There are ${count} reusable Access policies named "${name}"; delete the extra ones.`);
      else checks.info(count === 1 ? `Access policy "${name}" exists; the deploy keeps it in sync.` : `Access policy "${name}" does not exist yet; the deploy creates it.`);
    }
    const apps = await findAccessApps(ctx);
    if (apps.length > 1) {
      checks.blocker(`There are ${apps.length} Access applications for ${hostname}; keep one.`);
    } else if (apps.length === 1 && apps[0].type !== 'self_hosted') {
      checks.blocker(`The Access application for ${hostname} is of type "${apps[0].type}", not self_hosted.`);
    } else if (apps.length === 1 && apps[0].name !== NAMES.accessApp) {
      // The deploy updates only its own application; another one must already carry both policies.
      const app = Array.isArray(apps[0].policies) ? apps[0] : await ctx.cloudflare.get(`/accounts/${accountId}/access/apps/${apps[0].id}`);
      const attached = new Set((Array.isArray(app?.policies) ? app.policies : []).map(policy => policy?.name));
      if (attached.has(NAMES.allowPolicy) && attached.has(NAMES.servicePolicy)) {
        checks.ok(`Access application "${apps[0].name}" already covers ${hostname} with the content-radar policies.`);
      } else {
        checks.blocker(`The Access application "${apps[0].name}" covers ${hostname} without the content-radar policies; attach "${NAMES.allowPolicy}" and "${NAMES.servicePolicy}" to it in the Zero Trust dashboard or delete it.`);
      }
    } else if (apps.length === 1) {
      checks.ok(`Access application "${apps[0].name}" already covers ${hostname}.`);
    } else {
      checks.info(`No Access application covers ${hostname} yet; the deploy creates it before DNS.`);
    }
  });

  let tunnelId = null;
  await check(checks, 'Cannot list Cloudflare Tunnels', async () => {
    const tunnels = await findTunnels(ctx);
    if (tunnels.length > 1) {
      checks.blocker(`There are ${tunnels.length} tunnels named "${NAMES.tunnel}"; delete the extra ones.`);
    } else if (tunnels.length === 1 && !isRemotelyManaged(tunnels[0])) {
      checks.blocker(`Tunnel "${NAMES.tunnel}" is managed by a local config file; the deploy manages ingress through the API.`);
    } else if (tunnels.length === 1) {
      tunnelId = tunnels[0].id;
      facts.tunnelId = tunnelId;
      checks.ok(`Tunnel "${NAMES.tunnel}" exists (id ${tunnelId}, status ${tunnels[0].status ?? 'unknown'}).`);
    } else {
      checks.info(`Tunnel "${NAMES.tunnel}" does not exist yet; the deploy creates it.`);
    }
  });

  await check(checks, 'Cannot list DNS records', async () => {
    const records = await findDnsRecords(ctx);
    if (records.length === 0) {
      checks.ok(`No DNS record for ${hostname} yet; the deploy creates the proxied CNAME last.`);
    } else if (records.length === 1 && tunnelId && isCnameTo(records[0], tunnelTarget(tunnelId))) {
      checks.ok(`DNS: ${hostname} already points to the content-radar tunnel${records[0].proxied ? ' (proxied)' : ' (not proxied yet; the deploy turns the proxy on)'}.`);
    } else {
      checks.blocker(`DNS already has ${describeDnsRecords(records)} for ${hostname}, which is not the content-radar tunnel. The deploy never overwrites DNS records: delete it or choose another APP_HOSTNAME.`);
    }
  });
}

async function verifyToken(ctx) {
  try {
    const result = await ctx.cloudflare.get(`/accounts/${ctx.config.cloudflare.accountId}/tokens/verify`);
    return { status: result?.status, kind: 'account' };
  } catch (error) {
    // A user token is verified on the user endpoint instead.
    if (!(error instanceof ApiError) || error.status === null) throw error;
  }
  const result = await ctx.cloudflare.get('/user/tokens/verify');
  return { status: result?.status, kind: 'user' };
}

async function check(checks, failure, run) {
  try {
    await run();
  } catch (error) {
    checks.blocker(`${failure}: ${errorMessage(error)}`);
  }
}

function humanOrganizationAction(reason) {
  return `Human action needed: no usable Zero Trust organization (${reason}). Create it in the Cloudflare dashboard (Zero Trust: pick a team name and a plan; payment details are required even for the Free plan), then re-run.`;
}
