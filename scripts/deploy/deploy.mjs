/**
 * The deploy, in the order that never serves the hostname unprotected:
 *   (a) Cloudflare Access (login method, policies, application → aud);
 *   (b) the Dokploy app, configured with that aud, deployed and finished;
 *   (c) the app's Traefik domain for the hostname, which Dokploy applies at
 *       once;
 *   (d) DNS last: the hostname as a proxied A record to the VPS (ORIGIN_IP).
 * Preflight runs first and must report no blockers.
 */

import { ensureAccess, ensureDnsRecord } from './cloudflare-steps.mjs';
import { ensureAppDomain, ensureMainApplication, ensureProjectEnvironment } from './dokploy-steps.mjs';

/**
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {import('./preflight.mjs').PreflightFacts} facts From a preflight without blockers.
 * @returns {Promise<{ appName: string, aud: string }>}
 */
export async function runDeploy(ctx, facts) {
  const { authDomain, serviceTokenId } = facts.cloudflare;
  ctx.contract = facts.dokploy.contract;

  ctx.report.section('1/4 Cloudflare Access');
  const access = await ensureAccess(ctx, { serviceTokenId });
  if (!ctx.dryRun) ctx.state.access = { ...access };

  ctx.report.section('2/4 Dokploy application');
  const location = await ensureProjectEnvironment(ctx);
  const app = await ensureMainApplication(ctx, location, { authDomain, aud: access.aud }, facts.dokploy.github ?? null);

  ctx.report.section('3/4 Traefik domain');
  const domainId = await ensureAppDomain(ctx, app);
  if (!ctx.dryRun && domainId) ctx.state.dokploy = { ...(ctx.state.dokploy ?? {}), domainId };

  ctx.report.section('4/4 DNS');
  const record = await ensureDnsRecord(ctx);
  // The record ID only: the address it points to is never written.
  if (!ctx.dryRun && record?.id) ctx.state.dns = { recordId: record.id, type: 'A', proxied: true };
  return { appName: app.appName, aud: access.aud };
}
