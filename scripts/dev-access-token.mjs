#!/usr/bin/env node
/**
 * Development helper: sign a Cloudflare Access-style JWT with a local RSA key
 * so the app can run locally with real JWT verification (the app has no
 * authentication bypass).
 *
 * The first run creates a key pair under `.cache/dev-access/` (gitignored):
 * `signing-key.json` (private, owner-only) and `jwks.json` (public). Later
 * runs reuse it. The token is printed to stdout; the environment the app
 * needs to accept it is printed to stderr.
 *
 *   npm run -s dev:token -- --email you@example.com
 *   npm run -s dev:token -- --service-client-id local-agent.access
 *   npm run -s dev:token -- --email you@example.com --ttl 3600
 *
 * Issuer and audience come from ACCESS_TEAM_DOMAIN / the first ACCESS_AUD
 * entry when set (shell or `.env`), otherwise from the dev defaults (the app
 * also defaults ACCESS_TEAM_DOMAIN to the dev issuer when ACCESS_JWKS_FILE is
 * set). These keys are for local development only: production
 * (NODE_ENV=production) refuses ACCESS_JWKS_FILE.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose';

import { DEV_ACCESS_ISSUER } from '../src/app/auth/access-jwt.js';

export { DEV_ACCESS_ISSUER };
export const DEV_ACCESS_AUD = 'content-radar-dev';
export const DEFAULT_DEV_KEY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'dev-access');

const PRIVATE_KEY_FILE = 'signing-key.json';
const JWKS_FILE = 'jwks.json';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Create the dev key pair once and return it.
 * @param {string} [directory]
 * @returns {Promise<{ privateJwk: import('jose').JWK, jwksPath: string, created: boolean }>}
 */
export async function ensureDevKeys(directory = DEFAULT_DEV_KEY_DIR) {
  const privatePath = join(directory, PRIVATE_KEY_FILE);
  const jwksPath = join(directory, JWKS_FILE);
  const [privateText, jwksText] = await Promise.all([readOptional(privatePath), readOptional(jwksPath)]);
  if (privateText !== null && jwksText !== null) {
    try {
      return { privateJwk: JSON.parse(privateText), jwksPath, created: false };
    } catch {
      throw new Error(`Dev Access keys in ${directory} are unreadable; delete the directory to recreate them`);
    }
  }
  if (privateText !== null || jwksText !== null) {
    throw new Error(`Dev Access keys in ${directory} are incomplete; delete the directory to recreate them`);
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const privateJwk = { ...await exportJWK(privateKey), kid, alg: 'RS256', use: 'sig' };
  await writeFile(privatePath, `${JSON.stringify(privateJwk, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(privatePath, 0o600);
  await writeFile(jwksPath, `${JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }, null, 2)}\n`, { flag: 'wx' });
  return { privateJwk, jwksPath, created: true };
}

/**
 * Sign a dev Access token for a person (`email`) or a service token
 * (`serviceClientId`, carried as `common_name` like Cloudflare does).
 * @param {{
 *   privateJwk: import('jose').JWK,
 *   email?: string,
 *   serviceClientId?: string,
 *   issuer?: string,
 *   audience?: string,
 *   ttlSeconds?: number,
 *   now?: Date,
 * }} options
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
export async function signDevAccessToken({
  privateJwk,
  email,
  serviceClientId,
  issuer = DEV_ACCESS_ISSUER,
  audience = DEV_ACCESS_AUD,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = new Date(),
}) {
  if ((email ? 1 : 0) + (serviceClientId ? 1 : 0) !== 1) throw new Error('Pass exactly one of --email or --service-client-id');
  if (email && !EMAIL_PATTERN.test(email)) throw new Error('--email must be an email address');
  if (serviceClientId && !CLIENT_ID_PATTERN.test(serviceClientId)) throw new Error('--service-client-id may contain only letters, digits, ".", "_" and "-"');
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`--ttl must be between 60 and ${MAX_TTL_SECONDS} seconds`);
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  const claims = email
    ? { email: email.toLowerCase(), type: 'app', identity_nonce: 'dev' }
    : { common_name: serviceClientId, type: 'app' };
  const key = await importJWK(privateJwk, 'RS256');
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience([audience])
    .setSubject(email ? `dev:${email.toLowerCase()}` : '')
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(key);
  return { token, expiresAt: new Date((issuedAt + ttlSeconds) * 1000) };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      'service-client-id': { type: 'string' },
      ttl: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stderr.write('Usage: npm run -s dev:token -- (--email <address> | --service-client-id <id>) [--ttl <seconds>]\n');
    return;
  }
  await loadEnvironment();
  const issuer = (process.env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '') || DEV_ACCESS_ISSUER;
  const audience = (process.env.ACCESS_AUD ?? '').split(',').map(entry => entry.trim()).find(Boolean) ?? DEV_ACCESS_AUD;
  const ttlSeconds = values.ttl === undefined ? DEFAULT_TTL_SECONDS : Number(values.ttl);
  const { privateJwk, jwksPath, created } = await ensureDevKeys();
  const { token, expiresAt } = await signDevAccessToken({
    privateJwk,
    email: values.email,
    serviceClientId: values['service-client-id'],
    issuer,
    audience,
    ttlSeconds,
  });

  const subject = values.email ? values.email.toLowerCase() : `service token ${values['service-client-id']}`;
  const roleVariable = values.email
    ? `APP_OPERATOR_EMAILS=${values.email.toLowerCase()}   (or APP_VIEWER_EMAILS for read-only)`
    : `APP_SERVICE_TOKEN_ROLES=${values['service-client-id']}:operator   (or :viewer)`;
  process.stderr.write([
    `${created ? 'Created a dev signing key. ' : ''}Dev Access token for ${subject}, valid until ${expiresAt.toISOString()}.`,
    'Run the app (development only) with:',
    `  ACCESS_JWKS_FILE=${jwksPath}`,
    `  ACCESS_TEAM_DOMAIN=${issuer}`,
    `  ACCESS_AUD=${audience}`,
    `  ${roleVariable}`,
    '  PUBLIC_ORIGIN=http://127.0.0.1:3000   (the origin your browser uses)',
    '  DATA_DIR=.cache/app-data   APP_MASTER_KEY=<base64 of 32 random bytes, e.g. openssl rand -base64 32>',
    'Send the token in the Cf-Access-Jwt-Assertion header:',
    '  curl -H "Cf-Access-Jwt-Assertion: $TOKEN" http://127.0.0.1:3000/api/me',
    '',
  ].join('\n'));
  process.stdout.write(`${token}\n`);
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Could not read ${path} (${error?.code ?? 'unknown error'})`);
  }
}

async function loadEnvironment() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    // dotenv is optional.
  }
}

const isExecutable = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isExecutable) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dev:token failed: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
