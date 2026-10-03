/**
 * The GitHub App source of the app (`DOKPLOY_SOURCE=github`). Dokploy's
 * GitHub provider clones the repository, and GitHub sends every push to the
 * provider's webhook, `<Dokploy panel>/api/deploy/github`. Dokploy then
 * deploys each application whose GitHub source matches the push (provider,
 * owner, repository, branch) and has auto deploy on with the `push` trigger.
 *
 * - The provider is a GitHub App made in the Dokploy UI; there is no API to
 *   create one. The deploy uses the provider named by
 *   `DOKPLOY_GITHUB_PROVIDER`, or the only one. Only its ID and name are
 *   read from the API response.
 * - The owner and repository come from `--git-url` and must be visible to the
 *   provider. They are saved as the provider spells them, because Dokploy
 *   matches webhooks against that exact text.
 * - A Dokploy panel behind Cloudflare Access needs an Access application with
 *   a Bypass policy on the webhook path, or GitHub's pushes stop at the Access
 *   login. Preflight warns when there is none. Dokploy verifies the webhook
 *   signature itself.
 */

import { isIP } from 'node:net';

import { DeployStop } from './run-context.mjs';

/** Path of the GitHub App webhook on the Dokploy panel. */
export const GITHUB_WEBHOOK_PATH = '/api/deploy/github';
const BUILD_PATH = '/';
const TRIGGER_TYPE = 'push';

/**
 * @typedef {object} GithubSource
 * @property {string} githubId The Dokploy GitHub provider.
 * @property {string} providerName
 * @property {string} owner As the provider spells it.
 * @property {string} repository As the provider spells it.
 */

/**
 * Pick the GitHub provider and find the repository among the ones it can
 * see. Read-only.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @returns {Promise<GithubSource>}
 * @throws {DeployStop} No usable provider, or the provider cannot see the repository.
 */
export async function resolveGithubSource(ctx) {
  const listed = await ctx.dokploy.query('github.githubProviders');
  if (!Array.isArray(listed)) throw new DeployStop('Dokploy github.githubProviders did not return a list.');
  // Only the ID and the name are kept: a provider row can carry the GitHub App's secrets.
  const providers = listed
    .filter(entry => typeof entry?.githubId === 'string' && entry.githubId !== '')
    .map(entry => ({ githubId: entry.githubId, name: typeof entry.gitProvider?.name === 'string' ? entry.gitProvider.name : '' }));
  const provider = pickProvider(providers, ctx.config.git.githubProvider);

  const repositories = await ctx.dokploy.query('github.getGithubRepositories', { githubId: provider.githubId });
  if (!Array.isArray(repositories)) throw new DeployStop('Dokploy github.getGithubRepositories did not return a list.');
  const { owner, repository } = ctx.config.git;
  const match = repositories.find(entry => sameName(entry?.owner?.login, owner) && sameName(entry?.name, repository));
  if (!match) {
    throw new DeployStop(`The GitHub provider ${providerLabel(provider)} cannot see ${owner}/${repository} (it sees ${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}). Give its GitHub App access to that repository (Repository access of the App's installation on GitHub), then re-run.`);
  }
  return { githubId: provider.githubId, providerName: provider.name, owner: match.owner.login, repository: match.name };
}

/**
 * The application's source: the provider, owner, and repository resolved by
 * preflight, `--git-branch`, build path `/`, and the `push` trigger. Saved
 * only when any of them differs (watch paths and submodules are reset with
 * it); auto deploy is turned on when it is off. The environment is never
 * touched here.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {any} app `application.one` result, or the placeholder of an application only planned (dry run).
 * @param {GithubSource|null} github From preflight.
 */
export async function ensureGithubSource(ctx, app, github) {
  if (!github) throw new DeployStop('The preflight did not resolve the GitHub provider; the deploy stops rather than guess the source.');
  const { branch } = ctx.config.git;
  const desired = {
    githubId: github.githubId,
    owner: github.owner,
    repository: github.repository,
    branch,
    buildPath: BUILD_PATH,
    triggerType: TRIGGER_TYPE,
  };
  const label = `GitHub ${github.owner}/${github.repository} branch ${branch} through the provider ${providerLabel({ githubId: github.githubId, name: github.providerName })}`;
  if (app.sourceType === 'github' && Object.entries(desired).every(([key, value]) => app[key] === value)) {
    ctx.report.ok(`Source: ${label}.`);
    if (Array.isArray(app.watchPaths) && app.watchPaths.length > 0) {
      ctx.report.warn(`Watch paths are set on the application (${app.watchPaths.length}): Dokploy deploys only the pushes that change matching files.`);
    }
  } else {
    // Allowed (the branch always comes from --git-branch), but which pushes deploy production must never change silently.
    if (app.sourceType === 'github' && typeof app.branch === 'string' && app.branch !== '' && app.branch !== branch) {
      ctx.report.warn(`The source moves from branch ${app.branch} to ${branch}: from then on only pushes to ${branch} deploy. To keep ${app.branch}, pass --git-branch ${app.branch}.`);
    }
    ctx.change('update', `Source → ${label} (was: ${describeSource(app)})`);
    await ctx.dokploy.mutate('application.saveGithubProvider', ctx.contract.fit('application.saveGithubProvider', {
      applicationId: app.applicationId,
      ...desired,
      watchPaths: null,
      enableSubmodules: false,
    }));
  }

  if (app.autoDeploy === true) {
    ctx.report.ok(`Auto deploy is on: Dokploy deploys every push to ${branch} that reaches its GitHub webhook.`);
  } else if (app.pending) {
    ctx.report.info('A new application has auto deploy on by default; the deploy checks it once the application exists.');
  } else {
    ctx.change('update', `Auto deploy → on (Dokploy deploys every push to ${branch})`);
    await ctx.dokploy.mutate('application.update', ctx.contract.fit('application.update', { applicationId: app.applicationId, autoDeploy: true }));
  }
}

/**
 * Host and path of the GitHub webhook on the Dokploy panel.
 * @param {string} dokployUrl `config.dokploy.url`.
 * @returns {{ host: string, path: string, isIp: boolean }} Lowercase; `isIp` when the panel is addressed by IP.
 */
export function githubWebhookTarget(dokployUrl) {
  const url = new URL(dokployUrl);
  const host = url.hostname.toLowerCase();
  return {
    host,
    path: `${url.pathname.replace(/\/+$/, '')}${GITHUB_WEBHOOK_PATH}`.toLowerCase(),
    isIp: isIP(host.replace(/^\[|\]$/g, '')) !== 0,
  };
}

/**
 * Names of the Cloudflare Access applications that cover the webhook target
 * and have a Bypass policy. Read-only.
 * @param {ReturnType<typeof import('./run-context.mjs').createRunContext>} ctx
 * @param {{ host: string, path: string }} target From `githubWebhookTarget()`.
 * @returns {Promise<string[]>}
 */
export async function findWebhookBypassApps(ctx, target) {
  const base = `/accounts/${ctx.config.cloudflare.accountId}/access/apps`;
  const names = [];
  for (const listed of await ctx.cloudflare.list(base)) {
    if (!destinationsOf(listed).some(destination => covers(destination, target))) continue;
    // The list embeds each policy with its decision; the application is read only when it does not.
    const app = hasDecisions(listed?.policies) ? listed : await ctx.cloudflare.get(`${base}/${listed.id}`);
    if ((Array.isArray(app?.policies) ? app.policies : []).some(policy => policy?.decision === 'bypass')) {
      names.push(String(app.name ?? listed.name ?? listed.id));
    }
  }
  return names;
}

function pickProvider(providers, wanted) {
  if (providers.length === 0) {
    throw new DeployStop('Dokploy lists no GitHub provider for the user of DOKPLOY_API_KEY. If the GitHub App already exists, check that this user created it; otherwise create it in Dokploy (Settings → Git → GitHub; there is no API for it), install it on the repository, then re-run.');
  }
  const labels = providers.map(providerLabel).join(', ');
  // The configured name is not repeated in messages: configuration values are never echoed.
  if (wanted !== null) {
    const matches = providers.filter(provider => provider.name === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new DeployStop(`${matches.length} Dokploy GitHub providers have the name set in DOKPLOY_GITHUB_PROVIDER; rename the others in Dokploy (Settings → Git), then re-run.`);
    }
    throw new DeployStop(`No Dokploy GitHub provider has the name set in DOKPLOY_GITHUB_PROVIDER; the providers are ${labels}.`);
  }
  if (providers.length === 1) return providers[0];
  throw new DeployStop(`Dokploy has ${providers.length} GitHub providers (${labels}); set DOKPLOY_GITHUB_PROVIDER to the name of the one to use.`);
}

function providerLabel({ githubId, name }) {
  return name ? `"${name}"` : `with githubId ${githubId}`;
}

function sameName(actual, expected) {
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
}

function describeSource(app) {
  if (app.pending) return 'a new application';
  const branch = app.sourceType === 'git' ? app.customGitBranch : app.branch;
  return `${app.sourceType ?? 'no source'}${branch ? `, branch ${branch}` : ''}`;
}

function destinationsOf(app) {
  const destinations = Array.isArray(app?.destinations)
    ? app.destinations.filter(entry => entry?.type === undefined || entry?.type === 'public').map(entry => entry?.uri)
    : [];
  return [app?.domain, ...(Array.isArray(app?.self_hosted_domains) ? app.self_hosted_domains : []), ...destinations]
    .filter(entry => typeof entry === 'string' && entry.trim() !== '');
}

// An Access destination `host[/path]` covers the target when the host matches
// (a leading `*.` matches any subdomain) and its path is the target's path or
// a parent of it (a trailing `*` matches the rest).
function covers(destination, { host, path }) {
  const value = destination.trim().toLowerCase().replace(/^https?:\/\//, '');
  const slash = value.indexOf('/');
  const destinationHost = (slash === -1 ? value : value.slice(0, slash)).replace(/\.$/, '');
  const hostMatches = destinationHost.startsWith('*.') ? host.endsWith(destinationHost.slice(1)) : destinationHost === host;
  if (!hostMatches) return false;
  const destinationPath = slash === -1 ? '' : value.slice(slash).replace(/\/+$/, '');
  if (destinationPath.endsWith('*')) return path.startsWith(destinationPath.slice(0, -1));
  return destinationPath === '' || path === destinationPath || path.startsWith(`${destinationPath}/`);
}

function hasDecisions(policies) {
  return Array.isArray(policies) && policies.every(policy => typeof policy?.decision === 'string');
}
