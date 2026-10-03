/**
 * Dokploy side of the deploy. Resources are looked up by name on every run
 * (project → production environment → application), so a re-run creates
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
 * - Its Dokploy domain: the Traefik route for APP_HOSTNAME (`TRAEFIK_DOMAIN`),
 *   set once the app is deployed. Dokploy rewrites the Traefik configuration
 *   on every domain change, so no redeploy follows. Traefik serves the app on
 *   the VPS address too, where the app's own Access JWT check guards every
 *   route except `/healthz`.
 * - Never a published port: it would serve the app beside Traefik.
 */

import { DATA_MOUNT_PATH, NAMES, NANOSECONDS_PER_SECOND, STOP_GRACE_SECONDS, SHUTDOWN_WAIT_SECONDS, SWARM_HEALTHCHECK, SWARM_UPDATE_CONFIG, TRAEFIK_DOMAIN, managedAppEnv } from './config.mjs';
import { ApiError, isDryRun } from './api-clients.mjs';
import { EnvTextError, generateMasterKey, mergeEnvText, parseEnvText } from './env-text.mjs';
import { ensureGithubSource } from './github-source.mjs';
import { REDACTED } from './redaction.mjs';
import { DeployStop, errorMessage } from './run-context.mjs';
import { VaultKeyError, parseMasterKey } from '../../src/app/secrets/vault.js';

export const POLL_INTERVAL_MS = 5_000;
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
 * @property {any|null} app Summary of the application named `NAMES.app`.
 * @property {boolean} [pending] The project is only planned (dry run).
 */

/**
 * Find the project, its production environment, and the application by name.
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
  if (!project) return { project: null, environment: null, app: null };
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
  return { project, environment, app: pickApplication(environment, NAMES.app) };
}

/**
 * Published ports of an application: each one serves the app on the VPS
 * beside Traefik.
 * @param {any} app `application.one` result.
 * @returns {string[]} Human-readable findings; empty when there are none.
 */
export function publishedPortsOf(app) {
  const ports = Array.isArray(app?.ports) ? app.ports : [];
  return ports.map(port => `published port ${port?.publishedPort ?? '?'} → ${port?.targetPort ?? '?'}`);
}

/**
 * @param {string[]} ports From `publishedPortsOf`; not empty.
 * @returns {string} Why they block the deploy, and what to do.
 */
export function publishedPortsProblem(ports) {
  const one = ports.length === 1;
  return `Application "${NAMES.app}" has ${ports.join(', ')}, which serve${one ? 's' : ''} the app on the VPS beside Traefik; remove ${one ? 'it' : 'them'} in Dokploy`;
}

/**
 * The application's Dokploy domains (Traefik routes).
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {string} applicationId
 * @returns {Promise<any[]>}
 */
export async function readDomains(ctx, applicationId) {
  const domains = await ctx.dokploy.query('domain.byApplicationId', { applicationId });
  if (!Array.isArray(domains)) throw new DeployStop('Dokploy domain.byApplicationId did not return a list.');
  return domains;
}

/**
 * Split domains into the ones for `hostname` and the others.
 * @param {any[]} domains
 * @param {string} hostname Lowercase.
 * @returns {{ matching: any[], others: any[] }}
 */
export function partitionDomains(domains, hostname) {
  const matching = [];
  const others = [];
  for (const domain of domains) {
    (String(domain?.host ?? '').trim().toLowerCase().replace(/\.$/, '') === hostname ? matching : others).push(domain);
  }
  return { matching, others };
}

/**
 * Settings of a stored domain that differ from `TRAEFIK_DOMAIN`. A disabled
 * domain has no Traefik route, so `enabled: false` differs too.
 * @param {any} domain
 * @returns {string[]} Field names; empty when the domain is as desired.
 */
export function domainDifferences(domain) {
  const differing = Object.keys(TRAEFIK_DOMAIN).filter(key => !sameSetting(domain?.[key], TRAEFIK_DOMAIN[key]));
  if (domain?.enabled === false) differing.push('enabled');
  return differing;
}

/**
 * @param {string} hostname
 * @returns {string} The desired domain, for messages.
 */
export function describeTraefikDomain(hostname) {
  const { path, port, certificateType } = TRAEFIK_DOMAIN;
  return `https://${hostname}${path} → port ${port} (certificateType ${certificateType}: Traefik's default certificate)`;
}

/**
 * Warning about the application's domains for other hostnames, which the
 * deploy keeps.
 * @param {any[]} others From `partitionDomains`.
 * @returns {string|null}
 */
export function otherDomainsWarning(others) {
  if (others.length === 0) return null;
  const hosts = others.map(domain => domain?.host ?? '?').join(', ');
  return `Application "${NAMES.app}" also has Traefik domains for other hostnames (${hosts}); the deploy keeps them. A hostname that Cloudflare Access does not cover reaches the app with only its own Access JWT check in front.`;
}

/**
 * The app's Traefik domain for APP_HOSTNAME: created when missing, updated
 * when any setting differs. Domains for other hostnames are kept, with a
 * warning; several domains for APP_HOSTNAME stop the deploy.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {{ applicationId: string, pending?: boolean }} app
 * @returns {Promise<string|null>} The domain ID, or `null` when it is only planned.
 */
export async function ensureAppDomain(ctx, app) {
  const { hostname } = ctx.config;
  const desired = { host: hostname, ...TRAEFIK_DOMAIN };
  const { matching, others } = partitionDomains(app.pending ? [] : await readDomains(ctx, app.applicationId), hostname);
  const warning = otherDomainsWarning(others);
  if (warning) ctx.report.warn(warning);
  if (matching.length > 1) {
    throw new DeployStop(`Application "${NAMES.app}" has ${matching.length} Traefik domains for ${hostname}; keep one in Dokploy, then re-run.`);
  }
  if (matching.length === 0) {
    ctx.change('create', `Traefik domain ${describeTraefikDomain(hostname)}`);
    const created = await ctx.dokploy.mutate('domain.create', ctx.contract.fit('domain.create', { ...desired, applicationId: app.applicationId }));
    return typeof created?.domainId === 'string' ? created.domainId : null;
  }
  const [domain] = matching;
  const differing = domainDifferences(domain);
  if (differing.length === 0) {
    ctx.report.ok(`Traefik domain ${describeTraefikDomain(hostname)}.`);
    return domain.domainId;
  }
  ctx.change('update', `Traefik domain ${describeTraefikDomain(hostname)} (was different in: ${differing.join(', ')})`);
  await ctx.dokploy.mutate('domain.update', ctx.contract.fit('domain.update', { domainId: domain.domainId, ...desired, enabled: true }));
  return domain.domainId;
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
      app: null,
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
 * @returns {Promise<{ applicationId: string, appName: string, pending: boolean }>} `pending`: the
 *   application is only planned (dry run).
 */
export async function ensureMainApplication(ctx, location, access, github = null) {
  const applicationId = await ensureApplication(ctx, location);
  const app = await readApplication(ctx, applicationId, NAMES.app);
  const ports = publishedPortsOf(app);
  if (ports.length > 0) throw new DeployStop(`${publishedPortsProblem(ports)}, then re-run.`);
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
  return { applicationId: app.applicationId, appName: app.appName, pending: app.pending === true };
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

// The application's ID, creating it when missing; `null` when its creation is only planned.
async function ensureApplication(ctx, location) {
  const name = NAMES.app;
  if (location.app) {
    ctx.report.ok(`Dokploy application "${name}" exists.`);
    return location.app.applicationId;
  }
  ctx.change('create', `Dokploy application "${name}"`);
  const created = await ctx.dokploy.mutate('application.create', ctx.contract.fit('application.create', {
    name, appName: name, description: DESCRIPTION, environmentId: location.environment.environmentId, serverId: null,
  }));
  if (isDryRun(created)) return null;
  const applicationId = typeof created?.applicationId === 'string'
    ? created.applicationId
    : (await locateDokployResources(ctx)).app?.applicationId ?? null;
  if (!applicationId) throw new DeployStop(`Dokploy application.create for "${name}" returned no applicationId, and the application cannot be found by name.`);
  return applicationId;
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
