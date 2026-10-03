/**
 * Dokploy side of the deploy. Resources are looked up by name on every run
 * (project → production environment → applications), so a re-run creates
 * nothing twice, and each setting is written only when it differs.
 *
 * - The app: this repository's Dockerfile from public Git (or, with
 *   `DOKPLOY_SOURCE=github`, from the Dokploy GitHub App provider, so pushes
 *   deploy; see `github-source.mjs`), one replica, Swarm update `stop-first`
 *   (read back before deploying: start-first would run two schedulers on one
 *   SQLite file), a health check on `/healthz`, a named volume at `/data`,
 *   and the production environment. The existing `APP_MASTER_KEY` is always
 *   reused; a new one is generated only when none exists, passed straight to
 *   Dokploy, and never printed.
 * - cloudflared: the pinned image, `TUNNEL_TOKEN` passed straight from the
 *   Cloudflare API into Dokploy, and the arguments `tunnel run`.
 * - Neither gets a Dokploy domain (Traefik route) or a published port.
 */

import { CLOUDFLARED_ARGS, DATA_MOUNT_PATH, NAMES, NANOSECONDS_PER_SECOND, STOP_GRACE_SECONDS, SHUTDOWN_WAIT_SECONDS, SWARM_HEALTHCHECK, SWARM_UPDATE_CONFIG, managedAppEnv } from './config.mjs';
import { ApiError, isDryRun } from './api-clients.mjs';
import { fetchTunnelToken, readTunnelStatus } from './cloudflare-steps.mjs';
import { EnvTextError, generateMasterKey, mergeEnvText, parseEnvText } from './env-text.mjs';
import { ensureGithubSource } from './github-source.mjs';
import { REDACTED } from './redaction.mjs';
import { DeployStop, errorMessage } from './run-context.mjs';
import { VaultKeyError, parseMasterKey } from '../../src/app/secrets/vault.js';

export const POLL_INTERVAL_MS = 5_000;
export const CLOUDFLARED_WAIT_MS = 10 * 60_000;
export const TUNNEL_HEALTH_WAIT_MS = 5 * 60_000;
const LOG_TAIL_LINES = 120;
// The GitHub provider clones with an installation token in the URL, which a failing clone can echo.
const LOG_CREDENTIALS = Object.freeze([
  [/(\/\/)[^\s/@]+@/g, `$1${REDACTED}@`],
  [/\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
]);
// Deployment statuses: running → done | error | cancelled. Anything else is drift and stops the wait.
const WAITING_STATUSES = new Set(['running', 'queued', 'pending']);
const DESCRIPTION = 'Managed by scripts/deploy/dokploy-cloudflare.mjs';
// Structurally valid stand-in used only to validate a dry run's environment; never sent.
const VALIDATION_KEY = Buffer.alloc(32).toString('base64');

/**
 * @typedef {object} DokployLocation
 * @property {any|null} project
 * @property {any|null} environment The project's production environment.
 * @property {{ main: any|null, cloudflared: any|null }} apps Application summaries by role.
 * @property {boolean} [pending] The project is only planned (dry run).
 */

/**
 * Find the project, its production environment, and both applications by name.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<DokployLocation>}
 */
export async function locateDokployResources(ctx) {
  const projects = await ctx.dokploy.query('project.all');
  if (!Array.isArray(projects)) throw new DeployStop('Dokploy project.all did not return a list of projects.');
  const matches = projects.filter(project => project?.name === NAMES.project);
  if (matches.length > 1) {
    throw new DeployStop(`Dokploy has ${matches.length} projects named "${NAMES.project}"; remove the extra ones, then re-run.`);
  }
  const [project = null] = matches;
  if (!project) return { project: null, environment: null, apps: { main: null, cloudflared: null } };
  if (!Array.isArray(project.environments)) {
    throw new DeployStop(`Dokploy project.all returned no environments for "${NAMES.project}"; this Dokploy version is not supported.`);
  }
  const environments = project.environments.filter(environment => String(environment?.name ?? '').toLowerCase() === NAMES.environment);
  if (environments.length !== 1) {
    throw new DeployStop(`Dokploy project "${NAMES.project}" has ${environments.length} environments named "${NAMES.environment}"; expected exactly one.`);
  }
  const [environment] = environments;
  if (!Array.isArray(environment.applications)) {
    throw new DeployStop('Dokploy project.all returned no applications for the production environment; this Dokploy version is not supported.');
  }
  return {
    project,
    environment,
    apps: { main: pickApplication(environment, NAMES.app), cloudflared: pickApplication(environment, NAMES.cloudflared) },
  };
}

/**
 * Traefik domains and published ports of an application: either one would
 * make the app reachable without Access.
 * @param {any} app `application.one` result.
 * @returns {string[]} Human-readable findings; empty when there are none.
 */
export function publicRoutesOf(app) {
  const domains = Array.isArray(app?.domains) ? app.domains : [];
  const ports = Array.isArray(app?.ports) ? app.ports : [];
  return [
    ...domains.map(domain => `Traefik domain ${domain?.host ?? '?'}`),
    ...ports.map(port => `published port ${port?.publishedPort ?? '?'} → ${port?.targetPort ?? '?'}`),
  ];
}

/**
 * The project and its production environment (created when missing).
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<DokployLocation>}
 */
export async function ensureProjectEnvironment(ctx) {
  const found = await locateDokployResources(ctx);
  if (found.environment) {
    ctx.report.ok(`Dokploy project "${NAMES.project}" exists with its ${NAMES.environment} environment.`);
    recordState(ctx, { projectId: found.project.projectId, environmentId: found.environment.environmentId });
    return found;
  }
  ctx.change('create', `Dokploy project "${NAMES.project}" (with its ${NAMES.environment} environment)`);
  const created = await ctx.dokploy.mutate('project.create', ctx.contract.fit('project.create', { name: NAMES.project, description: DESCRIPTION }));
  if (isDryRun(created)) {
    return {
      project: { projectId: '<new-project-id>' },
      environment: { environmentId: '<new-environment-id>', applications: [] },
      apps: { main: null, cloudflared: null },
      pending: true,
    };
  }
  const again = await locateDokployResources(ctx);
  if (!again.environment) throw new DeployStop(`Dokploy created project "${NAMES.project}", but it has no ${NAMES.environment} environment.`);
  recordState(ctx, { projectId: again.project.projectId, environmentId: again.environment.environmentId });
  return again;
}

/**
 * The app: create, configure, read the Swarm settings back, deploy, and wait.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {DokployLocation} location
 * @param {{ authDomain: string, aud: string }} access
 * @param {import('./github-source.mjs').GithubSource|null} [github] With `DOKPLOY_SOURCE=github`: the
 *   provider and repository resolved by preflight.
 * @returns {Promise<{ applicationId: string, appName: string }>}
 */
export async function ensureMainApplication(ctx, location, access, github = null) {
  const { applicationId } = await ensureApplication(ctx, location, NAMES.app, location.apps.main);
  const app = await readApplication(ctx, applicationId, NAMES.app);
  const routes = publicRoutesOf(app);
  if (routes.length > 0) {
    throw new DeployStop(`Application "${NAMES.app}" has ${routes.join(', ')}; that would expose the app without Access. Remove them in Dokploy, then re-run.`);
  }
  if (!app.pending) recordState(ctx, { app: { applicationId: app.applicationId, appName: app.appName } });
  ctx.report.info(`Service name of "${NAMES.app}" on dokploy-network: ${app.appName}`);

  if (ctx.config.git.source === 'github') await ensureGithubSource(ctx, app, github);
  else await ensureGitSource(ctx, app);
  await ensureDockerfileBuild(ctx, app);
  await ensureAppEnvironment(ctx, app, access);
  await ensureDataVolume(ctx, app);
  const expectStopGrace = await ensureSwarmSettings(ctx, app);
  if (!ctx.dryRun) await confirmSwarmSettings(ctx, app.applicationId, { expectStopGrace });
  await deployAndWait(ctx, app, { label: NAMES.app, timeoutMs: ctx.config.waitMs });
  return { applicationId: app.applicationId, appName: app.appName };
}

/**
 * cloudflared: create, configure, deploy when anything changed or the tunnel
 * is not healthy, then wait until Cloudflare reports the tunnel healthy.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {DokployLocation} location
 * @param {{ id: string, pending?: boolean }} tunnel
 */
export async function ensureCloudflaredApplication(ctx, location, tunnel) {
  const { applicationId, created } = await ensureApplication(ctx, location, NAMES.cloudflared, location.apps.cloudflared);
  const app = await readApplication(ctx, applicationId, NAMES.cloudflared);
  if (!app.pending) recordState(ctx, { cloudflared: { applicationId: app.applicationId, appName: app.appName } });
  const fit = (procedure, payload) => ctx.contract.fit(procedure, payload);
  let changed = created;

  const image = ctx.config.cloudflaredImage;
  if (app.sourceType === 'docker' && app.dockerImage === image) {
    ctx.report.ok(`cloudflared image is ${image}.`);
  } else {
    ctx.change('update', `cloudflared image → ${image}`);
    await ctx.dokploy.mutate('application.saveDockerProvider', fit('application.saveDockerProvider', {
      applicationId: app.applicationId, dockerImage: image, username: null, password: null, registryUrl: null,
    }));
    changed = true;
  }

  if (ctx.dryRun) {
    if (parseEnvText(app.env).values.has('TUNNEL_TOKEN')) {
      ctx.report.info('TUNNEL_TOKEN is rewritten only when it differs from the tunnel token (not fetched in a dry run).');
    } else {
      ctx.change('update', 'cloudflared environment: TUNNEL_TOKEN from the tunnel token API');
      await ctx.dokploy.mutate('application.saveEnvironment', fit('application.saveEnvironment', {
        applicationId: app.applicationId, env: 'TUNNEL_TOKEN=<tunnel-token>', buildArgs: null, buildSecrets: null, createEnvFile: false,
      }));
      changed = true;
    }
  } else {
    // Straight from the Cloudflare API into the Dokploy request; registered with the redactor, never stored.
    const token = await fetchTunnelToken(ctx, tunnel.id);
    const { text, changed: envChanged } = mergeEnvironment(app.env, { TUNNEL_TOKEN: token });
    if (envChanged) {
      ctx.change('update', 'cloudflared environment: TUNNEL_TOKEN');
      await ctx.dokploy.mutate('application.saveEnvironment', fit('application.saveEnvironment', {
        applicationId: app.applicationId, env: text, buildArgs: app.buildArgs ?? null, buildSecrets: app.buildSecrets ?? null, createEnvFile: false,
      }));
      changed = true;
    } else {
      ctx.report.ok('cloudflared TUNNEL_TOKEN matches the tunnel.');
    }
  }

  if (sameSetting(app.args, CLOUDFLARED_ARGS)) {
    ctx.report.ok(`cloudflared arguments are "${CLOUDFLARED_ARGS.join(' ')}".`);
  } else {
    ctx.change('update', `cloudflared arguments → "${CLOUDFLARED_ARGS.join(' ')}"`);
    await ctx.dokploy.mutate('application.update', fit('application.update', { applicationId: app.applicationId, args: [...CLOUDFLARED_ARGS] }));
    changed = true;
  }

  // Redeploying cloudflared briefly drops the tunnel, so it happens only when needed.
  const status = tunnel.pending ? null : await readTunnelStatus(ctx, tunnel.id);
  const hasDeployment = !app.pending && (await listDeployments(ctx, app.applicationId)).some(deployment => deployment.status === 'done');
  const deploy = changed || !hasDeployment || status?.status !== 'healthy';
  if (deploy) {
    await deployAndWait(ctx, app, { label: NAMES.cloudflared, timeoutMs: CLOUDFLARED_WAIT_MS });
  } else {
    ctx.report.ok('cloudflared is up to date and the tunnel is healthy; no redeploy needed.');
  }
  if (!ctx.dryRun) await waitForHealthyTunnel(ctx, tunnel.id, deploy);
}

/**
 * Trigger a deployment and wait for it to finish. On failure the deployment
 * log is printed (redacted) and the run stops.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {{ applicationId: string, pending?: boolean }} app
 * @param {{ label: string, timeoutMs: number, procedure?: 'application.deploy'|'application.redeploy' }} options
 * @returns {Promise<any|null>} The finished deployment, or `null` in a dry run.
 */
export async function deployAndWait(ctx, app, { label, timeoutMs, procedure = 'application.deploy' }) {
  ctx.change('deploy', `${label} (${procedure})`);
  const payload = ctx.contract ? ctx.contract.fit(procedure, { applicationId: app.applicationId }) : { applicationId: app.applicationId };
  if (ctx.dryRun) {
    await ctx.dokploy.mutate(procedure, payload);
    ctx.report.info(`Would wait up to ${Math.round(timeoutMs / 60_000)} min for the ${label} deployment.`);
    return null;
  }
  const known = new Set((await listDeployments(ctx, app.applicationId)).map(deployment => deployment.deploymentId));
  await ctx.dokploy.mutate(procedure, payload);
  const started = ctx.now();
  let latest = null;
  for (;;) {
    await ctx.sleep(POLL_INTERVAL_MS);
    // Newest first: the first deployment not seen before is the one just triggered.
    latest = (await listDeployments(ctx, app.applicationId)).find(deployment => !known.has(deployment.deploymentId)) ?? null;
    if (latest && !WAITING_STATUSES.has(latest.status)) break;
    if (ctx.now() - started >= timeoutMs) {
      throw new DeployStop(`The ${label} deployment is still ${latest ? `"${latest.status}"` : 'not started'} after ${Math.round(timeoutMs / 60_000)} min; check it in Dokploy, then re-run.`);
    }
  }
  if (latest.status !== 'done') {
    await printDeploymentLog(ctx, latest.deploymentId, label);
    throw new DeployStop(`The ${label} deployment ended with status "${latest.status}" (deployment ${latest.deploymentId}). Fix the cause shown in the log, then re-run.`);
  }
  ctx.report.ok(`${label} deployed (deployment ${latest.deploymentId}).`);
  return latest;
}

/**
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {string} applicationId
 * @returns {Promise<any[]>} Newest first.
 */
export async function listDeployments(ctx, applicationId) {
  const deployments = await ctx.dokploy.query('deployment.all', { applicationId });
  if (!Array.isArray(deployments)) throw new DeployStop('Dokploy deployment.all did not return a list.');
  return deployments.filter(deployment => typeof deployment?.deploymentId === 'string');
}

/**
 * `application.one`, or a placeholder for an application only planned in a dry run.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {string|null} applicationId
 * @param {string} name
 * @returns {Promise<any>}
 */
export async function readApplication(ctx, applicationId, name) {
  if (applicationId === null) {
    return {
      applicationId: `<new-application-id:${name}>`,
      appName: `<service-name-of:${name}>`,
      env: null,
      mounts: [],
      domains: [],
      ports: [],
      pending: true,
    };
  }
  const app = await ctx.dokploy.query('application.one', { applicationId });
  if (!app || typeof app !== 'object' || app.applicationId !== applicationId) {
    throw new DeployStop(`Dokploy application.one did not return application "${name}".`);
  }
  // Never printed, but registered so that no output can show them: the deploy webhook token and,
  // for a GitHub-sourced application, the GitHub App credentials that come with it.
  for (const secret of [app.refreshToken, app.github?.githubClientSecret, app.github?.githubWebhookSecret, app.github?.githubPrivateKey]) {
    ctx.redactor.add(secret);
  }
  if (typeof app.appName !== 'string' || app.appName === '') {
    throw new DeployStop(`Dokploy application "${name}" has no appName (service name).`);
  }
  return app;
}

function pickApplication(environment, name) {
  const matches = environment.applications.filter(app => app?.name === name);
  if (matches.length > 1) {
    throw new DeployStop(`Dokploy environment "${NAMES.environment}" has ${matches.length} applications named "${name}"; remove the extra ones, then re-run.`);
  }
  return matches[0] ?? null;
}

async function ensureApplication(ctx, location, name, existing) {
  if (existing) {
    ctx.report.ok(`Dokploy application "${name}" exists.`);
    return { applicationId: existing.applicationId, created: false };
  }
  ctx.change('create', `Dokploy application "${name}"`);
  const created = await ctx.dokploy.mutate('application.create', ctx.contract.fit('application.create', {
    name, appName: name, description: DESCRIPTION, environmentId: location.environment.environmentId, serverId: null,
  }));
  if (isDryRun(created)) return { applicationId: null, created: true };
  let applicationId = typeof created?.applicationId === 'string' ? created.applicationId : null;
  if (!applicationId) {
    const again = await locateDokployResources(ctx);
    applicationId = (name === NAMES.app ? again.apps.main : again.apps.cloudflared)?.applicationId ?? null;
  }
  if (!applicationId) throw new DeployStop(`Dokploy application.create for "${name}" returned no applicationId, and the application cannot be found by name.`);
  return { applicationId, created: true };
}

async function ensureGitSource(ctx, app) {
  const { url, branch } = ctx.config.git;
  if (app.sourceType === 'git' && app.customGitUrl === url && app.customGitBranch === branch && app.customGitBuildPath === '/') {
    ctx.report.ok(`Source: ${url} branch ${branch}.`);
    return;
  }
  ctx.change('update', `Source → ${url} branch ${branch}`);
  await ctx.dokploy.mutate('application.saveGitProvider', ctx.contract.fit('application.saveGitProvider', {
    applicationId: app.applicationId,
    customGitUrl: url,
    customGitBranch: branch,
    customGitBuildPath: '/',
    customGitSSHKeyId: null,
    watchPaths: null,
    enableSubmodules: false,
  }));
}

async function ensureDockerfileBuild(ctx, app) {
  if (app.buildType === 'dockerfile' && app.dockerfile === 'Dockerfile' && app.dockerContextPath === '.' && !app.dockerBuildStage) {
    ctx.report.ok('Build: Dockerfile "Dockerfile", context ".".');
    return;
  }
  ctx.change('update', 'Build → Dockerfile "Dockerfile", context "."');
  await ctx.dokploy.mutate('application.saveBuildType', ctx.contract.fit('application.saveBuildType', {
    applicationId: app.applicationId,
    buildType: 'dockerfile',
    dockerfile: 'Dockerfile',
    dockerContextPath: '.',
    dockerBuildStage: null,
    herokuVersion: null,
    railpackVersion: null,
    publishDirectory: null,
    isStaticSpa: false,
  }));
}

async function ensureAppEnvironment(ctx, app, { authDomain, aud }) {
  if (!app.pending && !Object.hasOwn(app, 'env')) {
    throw new DeployStop('Dokploy application.one returned no env field, so the deploy cannot tell whether APP_MASTER_KEY exists; it stops rather than risk replacing the key that encrypts stored secrets.');
  }
  const existingKey = parseEnvText(app.env).values.get('APP_MASTER_KEY') ?? '';
  let masterKey;
  let generated = false;
  if (existingKey) {
    ctx.redactor.add(existingKey);
    try {
      parseMasterKey(existingKey);
    } catch (error) {
      if (!(error instanceof VaultKeyError)) throw error;
      throw new DeployStop(`The APP_MASTER_KEY already set on "${NAMES.app}" is invalid (${error.message}). The deploy never replaces an existing key; fix it in Dokploy, then re-run.`);
    }
    masterKey = existingKey;
    ctx.report.ok('APP_MASTER_KEY is already set on the application and is reused.');
  } else if (ctx.dryRun) {
    masterKey = '<generated-at-apply-time>';
    ctx.report.info('APP_MASTER_KEY is not set yet: the deploy will generate 32 random bytes and pass them straight to Dokploy.');
  } else {
    masterKey = ctx.redactor.add(generateMasterKey(ctx.randomBytes));
    generated = true;
  }

  const managed = managedAppEnv({
    masterKey,
    authDomain,
    aud,
    operatorEmails: ctx.config.operatorEmails,
    viewerEmails: ctx.config.viewerEmails,
    serviceClientId: ctx.config.serviceToken.clientId,
    hostname: ctx.config.hostname,
  });
  const { text, changed, kept } = mergeEnvironment(app.env, managed);
  await validateAppEnvironment(text, (existingKey || generated) ? masterKey : VALIDATION_KEY);
  if (kept.length > 0) ctx.report.info(`Keeping variables the deploy does not manage: ${kept.join(', ')}.`);
  if (!changed && app.createEnvFile !== true) {
    ctx.report.ok(`Environment is up to date (${Object.keys(managed).length} managed variables).`);
    return;
  }
  ctx.change('update', `Environment: ${Object.keys(managed).length} managed variables${generated ? ', including a new APP_MASTER_KEY' : ''}`);
  await ctx.dokploy.mutate('application.saveEnvironment', ctx.contract.fit('application.saveEnvironment', {
    applicationId: app.applicationId,
    env: text,
    buildArgs: app.buildArgs ?? null,
    buildSecrets: app.buildSecrets ?? null,
    // Never write the environment into the build context.
    createEnvFile: false,
  }));
  if (generated) {
    recordState(ctx, { masterKeyGeneratedAt: new Date(ctx.now()).toISOString() });
    ctx.report.warn(`A new APP_MASTER_KEY was generated and stored only in Dokploy. Copy it now from the Environment tab of application "${NAMES.app}" (project "${NAMES.project}") into a password manager: losing it means re-entering every secret.`);
  }
}

async function ensureDataVolume(ctx, app) {
  if (!app.pending && !Array.isArray(app.mounts)) {
    throw new DeployStop('Dokploy application.one returned no mounts list; the deploy stops rather than add a mount that may duplicate an existing one.');
  }
  const existing = app.mounts.filter(mount => mount?.mountPath === DATA_MOUNT_PATH);
  if (existing.length > 0) {
    if (existing[0].type === 'volume') ctx.report.ok(`Volume "${existing[0].volumeName}" is mounted at ${DATA_MOUNT_PATH}.`);
    else ctx.report.warn(`${DATA_MOUNT_PATH} is a ${existing[0].type ?? 'non-volume'} mount, not a named volume; it is left as is.`);
    return;
  }
  ctx.change('create', `Named volume "${NAMES.volume}" mounted at ${DATA_MOUNT_PATH}`);
  await ctx.dokploy.mutate('mounts.create', ctx.contract.fit('mounts.create', {
    type: 'volume',
    volumeName: NAMES.volume,
    mountPath: DATA_MOUNT_PATH,
    serviceId: app.applicationId,
    serviceType: 'application',
  }));
}

function desiredSwarmSettings(ctx) {
  const settings = {
    replicas: 1,
    updateConfigSwarm: { ...SWARM_UPDATE_CONFIG },
    healthCheckSwarm: { ...SWARM_HEALTHCHECK, Test: [...SWARM_HEALTHCHECK.Test] },
  };
  const grace = ctx.contract.stopGrace;
  if (grace) settings[grace.field] = stopGraceValue(grace);
  return settings;
}

/**
 * @returns {Promise<boolean>} Whether the stop grace period is expected to be stored.
 */
async function ensureSwarmSettings(ctx, app) {
  const grace = ctx.contract.stopGrace;
  if (!grace) {
    ctx.report.warn(`!!! This Dokploy instance has no Swarm stop grace period setting. Docker's default of 10 s applies, but the app waits up to ${SHUTDOWN_WAIT_SECONDS} s for a run in flight: a redeploy during a Telegram send can kill it mid-send and leave an ambiguous output. Set a stop grace period of at least ${STOP_GRACE_SECONDS} s outside the API, or upgrade Dokploy. !!!`);
  }
  const payload = ctx.contract.fit('application.update', { applicationId: app.applicationId, ...desiredSwarmSettings(ctx) });
  const differing = Object.keys(payload).filter(key => key !== 'applicationId' && !sameSetting(app[key], payload[key]));
  if (differing.length === 0) {
    ctx.report.ok(`Swarm settings: 1 replica, update ${SWARM_UPDATE_CONFIG.Order}, health check on /healthz${grace ? `, stop grace ${STOP_GRACE_SECONDS} s` : ''}.`);
    return Boolean(grace);
  }
  ctx.change('update', `Swarm settings (${differing.join(', ')}): 1 replica, update ${SWARM_UPDATE_CONFIG.Order}, health check on /healthz${grace ? `, stop grace ${STOP_GRACE_SECONDS} s` : ''}`);
  try {
    await ctx.dokploy.mutate('application.update', payload);
    return Boolean(grace);
  } catch (error) {
    // The field exists but its value cannot be expressed in JSON on this instance (for example a bigint schema).
    if (!grace || !(error instanceof ApiError) || error.status !== 400 || !error.message.includes(grace.field)) throw error;
    ctx.report.warn(`!!! Dokploy rejected ${grace.field} (${error.message}). The other Swarm settings are saved without it; set a stop grace period of at least ${STOP_GRACE_SECONDS} s another way, because a redeploy can otherwise kill a run in flight. !!!`);
    const { [grace.field]: _rejected, ...withoutGrace } = payload;
    await ctx.dokploy.mutate('application.update', withoutGrace);
    return false;
  }
}

// Read the settings back: the deploy never starts with start-first.
async function confirmSwarmSettings(ctx, applicationId, { expectStopGrace }) {
  const app = await readApplication(ctx, applicationId, NAMES.app);
  const update = app.updateConfigSwarm;
  if (update?.Order !== SWARM_UPDATE_CONFIG.Order || Number(update?.Parallelism) !== SWARM_UPDATE_CONFIG.Parallelism) {
    throw new DeployStop(`Dokploy did not keep updateConfigSwarm {Parallelism: 1, Order: "stop-first"}; the deploy stops, because start-first would run two schedulers on one database.`);
  }
  if (Number(app.replicas) !== 1) throw new DeployStop(`Dokploy reports ${app.replicas} replicas for "${NAMES.app}"; the app must run exactly one.`);
  if (!sameSetting(app.healthCheckSwarm?.Test, SWARM_HEALTHCHECK.Test)) {
    ctx.report.warn('Dokploy did not keep the Swarm health check; the image HEALTHCHECK (/healthz) still applies.');
  }
  const grace = ctx.contract.stopGrace;
  if (expectStopGrace && String(app[grace.field] ?? '') !== String(stopGraceValue(grace))) {
    ctx.report.warn(`!!! Dokploy did not keep ${grace.field} = ${STOP_GRACE_SECONDS} s; a redeploy can kill a run in flight. Check the setting in Dokploy. !!!`);
  }
  ctx.report.ok('Swarm settings read back: stop-first, 1 replica.');
}

async function waitForHealthyTunnel(ctx, tunnelId, deployed) {
  const started = ctx.now();
  for (;;) {
    const { status, connections } = await readTunnelStatus(ctx, tunnelId);
    if (status === 'healthy') {
      ctx.report.ok(`Tunnel is healthy (${connections} connection${connections === 1 ? '' : 's'}).`);
      return;
    }
    if (ctx.now() - started >= TUNNEL_HEALTH_WAIT_MS) {
      throw new DeployStop(`The tunnel is still "${status}" after ${TUNNEL_HEALTH_WAIT_MS / 60_000} min${deployed ? ' since cloudflared was deployed' : ''}; check the "${NAMES.cloudflared}" logs in Dokploy. DNS was not created.`);
    }
    await ctx.sleep(POLL_INTERVAL_MS);
  }
}

async function printDeploymentLog(ctx, deploymentId, label) {
  try {
    const raw = await ctx.dokploy.query('deployment.readLogs', ctx.contract
      ? ctx.contract.fit('deployment.readLogs', { deploymentId, tail: LOG_TAIL_LINES })
      : { deploymentId });
    const text = typeof raw === 'string' ? raw
      : typeof raw?.logs === 'string' ? raw.logs
        : Array.isArray(raw) ? raw.map(String).join('\n')
          : JSON.stringify(raw);
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '').slice(-LOG_TAIL_LINES);
    ctx.report.fail(`Last ${lines.length} log lines of the ${label} deployment (redacted):`);
    for (const line of lines) ctx.report.log(LOG_CREDENTIALS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), line));
  } catch (error) {
    ctx.report.warn(`Could not read the ${label} deployment log: ${errorMessage(error)}`);
  }
}

function mergeEnvironment(currentText, managed) {
  try {
    return mergeEnvText(currentText, managed);
  } catch (error) {
    if (error instanceof EnvTextError) throw new DeployStop(error.message);
    throw error;
  }
}

async function validateAppEnvironment(text, masterKey) {
  // Loaded on demand: the app config module pulls in the runtime (and node:sqlite).
  const { AppConfigError, loadAppConfig } = await import('../../src/app/config/env.js');
  const env = Object.fromEntries(parseEnvText(text).values);
  env.APP_MASTER_KEY = masterKey;
  try {
    loadAppConfig(env);
  } catch (error) {
    if (error instanceof AppConfigError) throw new DeployStop(`The app would refuse this environment: ${error.problems.join(' ')}`);
    throw error;
  }
}

function stopGraceValue(grace) {
  const nanoseconds = STOP_GRACE_SECONDS * NANOSECONDS_PER_SECOND;
  return grace.types.includes('integer') || grace.types.includes('number') || !grace.types.includes('string')
    ? nanoseconds
    : String(nanoseconds);
}

/**
 * Compare a stored setting with the desired one: arrays element by element,
 * objects by the desired keys (defaults Dokploy adds are ignored), numbers
 * and strings by text.
 * @param {unknown} current
 * @param {unknown} desired
 * @returns {boolean}
 */
export function sameSetting(current, desired) {
  if (Array.isArray(desired)) {
    return Array.isArray(current) && current.length === desired.length && desired.every((value, index) => sameSetting(current[index], value));
  }
  if (desired !== null && typeof desired === 'object') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    return Object.keys(desired).every(key => sameSetting(current[key], desired[key]));
  }
  if (desired === null || desired === undefined) return current === null || current === undefined;
  return current !== null && current !== undefined && String(current) === String(desired);
}

function recordState(ctx, values) {
  ctx.state.dokploy = { ...(ctx.state.dokploy ?? {}), ...values };
}
