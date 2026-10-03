/**
 * The deploy, in the order that never serves the hostname unprotected:
 *   (a) Cloudflare Access (login method, policies, application → aud);
 *   (b) the Dokploy app, deployed and finished;
 *   (c) the tunnel ingress pointing at the app, then cloudflared, until the
 *       tunnel is healthy;
 *   (d) DNS last.
 * Preflight runs first and must report no blockers.
 */

import { ensureAccess, ensureDnsRecord, ensureTunnel, ensureTunnelIngress, tunnelTarget } from './cloudflare-steps.mjs';
import { NAMES } from './config.mjs';
import { ensureCloudflaredApplication, ensureMainApplication, ensureProjectEnvironment, locateDokployResources } from './dokploy-steps.mjs';

/**
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {import('./preflight.mjs').PreflightFacts} facts From a preflight without blockers.
 * @returns {Promise<{ appName: string, tunnelId: string, aud: string }>}
 */
export async function runDeploy(ctx, facts) {
  const { authDomain, teamName, serviceTokenId } = facts.cloudflare;
  ctx.contract = facts.dokploy.contract;

  ctx.report.section('1/4 Cloudflare Access');
  const access = await ensureAccess(ctx, { serviceTokenId });
  if (!ctx.dryRun) ctx.state.access = { ...access };

  ctx.report.section('2/4 Dokploy application');
  const location = await ensureProjectEnvironment(ctx);
  const app = await ensureMainApplication(ctx, location, { authDomain, aud: access.aud }, facts.dokploy.github ?? null);

  ctx.report.section('3/4 Cloudflare Tunnel and cloudflared');
  const tunnel = await ensureTunnel(ctx);
  if (!ctx.dryRun) ctx.state.tunnel = { id: tunnel.id, name: NAMES.tunnel };
  await ensureTunnelIngress(ctx, tunnel, { appName: app.appName, teamName, aud: access.aud });
  // Read again: the app created above is now part of the environment.
  const current = location.pending ? location : await locateDokployResources(ctx);
  await ensureCloudflaredApplication(ctx, current, tunnel);

  ctx.report.section('4/4 DNS');
  const record = await ensureDnsRecord(ctx, tunnel);
  if (!ctx.dryRun && record?.id) ctx.state.dns = { recordId: record.id, target: tunnelTarget(tunnel.id) };
  return { appName: app.appName, tunnelId: tunnel.id, aud: access.aud };
}
