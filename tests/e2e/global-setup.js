/**
 * Playwright global setup and teardown of the E2E server.
 *
 * Setup:
 * 1. Build the dashboard (`npm run web:build`) when `web/dist` is missing or
 *    older than the web sources.
 * 2. Make sure the fixed port is free. A leftover E2E harness of this
 *    repository (recognized by its command line) is stopped; any other owner is
 *    left alone and setup fails, naming it.
 * 3. Start `start-test-server.js` as a child process, wait for its ready
 *    line, and hand the harness description to the specs through
 *    `E2E_HARNESS_INFO_FILE`. Server output goes to `.cache/e2e/server.log`.
 *
 * Teardown (the function setup returns): SIGTERM the harness, wait for it to
 * close the app and delete its temp directory (SIGKILL only if it ignores the
 * signal), then verify the port is free. The harness also stops on its own when
 * its stdin pipe closes, so a runner that dies leaves no orphan behind.
 */

import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  E2E_HOST,
  E2E_PORT,
  HARNESS_INFO_ENV,
  HARNESS_LIFELINE_ENV,
  HARNESS_READY_PREFIX,
  HARNESS_TEMP_PREFIX,
} from './fixtures/constants.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB_DIR = join(REPO_ROOT, 'web');
const WEB_BUILD_INDEX = join(WEB_DIR, 'dist', 'index.html');
const WEB_BUILD_INPUTS = ['src', 'public', 'index.html', 'package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json'];
const STATE_DIR = join(REPO_ROOT, '.cache', 'e2e');
const PROCESS_FILE = join(STATE_DIR, 'harness-process.json');
const LOG_FILE = join(STATE_DIR, 'server.log');
const HARNESS_SCRIPT = fileURLToPath(new URL('./start-test-server.js', import.meta.url));
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 20_000;
const KILL_TIMEOUT_MS = 5_000;
const LOG_TAIL_LINES = 30;

export default async function globalSetup() {
  await mkdir(STATE_DIR, { recursive: true });
  await ensureWebBuild();
  await releasePort();
  const harness = await startHarness();
  process.env[HARNESS_INFO_ENV] = harness.infoFile;
  return () => harness.stop();
}

async function ensureWebBuild() {
  const builtAt = existsSync(WEB_BUILD_INDEX) ? statSync(WEB_BUILD_INDEX).mtimeMs : 0;
  const changedAt = Math.max(...WEB_BUILD_INPUTS.map(entry => newestModification(join(WEB_DIR, entry))));
  if (builtAt > 0 && builtAt >= changedAt) return;
  console.log(`[E2E] ${builtAt ? 'web/dist is older than the web sources' : 'web/dist is missing'}; running npm run web:build`);
  await runCommand('npm', ['run', 'web:build'], REPO_ROOT);
  if (!existsSync(WEB_BUILD_INDEX)) throw new Error('npm run web:build finished without web/dist/index.html');
}

function newestModification(path) {
  if (!existsSync(path)) return 0;
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  return readdirSync(path).reduce((newest, entry) => Math.max(newest, newestModification(join(path, entry))), stats.mtimeMs);
}

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit code ${code}`})`));
    });
  });
}

/** Free the E2E port of a leftover harness from an earlier run; refuse to touch anything else. */
async function releasePort() {
  const recorded = await readProcessFile();
  if (recorded && isAlive(recorded.pid) && await isHarnessProcess(recorded.pid)) {
    console.log(`[E2E] Stopping a leftover E2E server from an earlier run (pid ${recorded.pid})`);
    await stopPid(recorded.pid);
  }
  if (await isPortOpen(E2E_PORT)) {
    for (const { pid } of await portListeners(E2E_PORT)) {
      if (!(await isHarnessProcess(pid))) continue;
      console.log(`[E2E] Stopping a leftover E2E server that still holds port ${E2E_PORT} (pid ${pid})`);
      await stopPid(pid);
    }
  }
  if (await isPortOpen(E2E_PORT)) {
    const owners = [];
    for (const { pid, command } of await portListeners(E2E_PORT)) {
      owners.push(`"${(await commandLine(pid)) || command || 'unknown command'}" (pid ${pid})`);
    }
    throw new Error(`E2E port ${E2E_PORT} is in use by ${owners.join(', ') || 'an unidentified process'}. `
      + 'The E2E runner did not start it, so it was left running; '
      + `stop it or free port ${E2E_PORT}, then run npm run test:e2e again.`);
  }
  if (recorded?.tempRoot) await removeHarnessTempRoot(recorded.tempRoot);
  await rm(PROCESS_FILE, { force: true });
}

async function startHarness() {
  const log = createWriteStream(LOG_FILE, { flags: 'w' });
  const recent = [];
  const remember = line => {
    if (!log.writableEnded) log.write(`${line}\n`);
    recent.push(line);
    if (recent.length > LOG_TAIL_LINES) recent.shift();
  };
  const child = spawn(process.execPath, [HARNESS_SCRIPT], {
    cwd: REPO_ROOT,
    env: harnessEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // `close` (not `exit`): the process ended and its output has been fully read.
  const exited = new Promise(resolvePromise => child.once('close', (code, signal) => resolvePromise({ code, signal })));
  createInterface({ input: child.stderr }).on('line', remember);

  let info;
  try {
    info = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready signal within ${READY_TIMEOUT_MS / 1_000} s`)), READY_TIMEOUT_MS);
      createInterface({ input: child.stdout }).on('line', line => {
        if (!line.startsWith(HARNESS_READY_PREFIX)) {
          remember(line);
          return;
        }
        remember(`${HARNESS_READY_PREFIX.trim()} (harness description written)`);
        clearTimeout(timer);
        try {
          resolvePromise(JSON.parse(line.slice(HARNESS_READY_PREFIX.length)));
        } catch (error) {
          reject(new Error(`unreadable ready line (${error.message})`));
        }
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      void exited.then(({ code, signal }) => {
        clearTimeout(timer);
        reject(new Error(`it exited during startup (${signal ?? `exit code ${code}`})`));
      });
    });
  } catch (error) {
    await stopChild(child, exited);
    log.end();
    throw new Error(`The E2E server did not start: ${error.message}\n${recent.join('\n')}\nFull log: ${LOG_FILE}`);
  }

  await writeFile(PROCESS_FILE, `${JSON.stringify({ pid: child.pid, tempRoot: info.tempRoot, startedAt: new Date().toISOString() })}\n`);
  console.log(`[E2E] Server ready at ${info.url} (pid ${child.pid}; log ${LOG_FILE})`);
  const { blockedFile } = JSON.parse(await readFile(info.infoFile, 'utf8'));

  return {
    infoFile: info.infoFile,
    async stop() {
      // Read before stopping: the harness deletes its temp directory on exit.
      const blocked = existsSync(blockedFile) ? (await readFile(blockedFile, 'utf8')).split('\n').filter(Boolean) : [];
      const { code, signal, forced } = await stopChild(child, exited);
      log.end();
      const problems = [];
      if (blocked.length > 0) problems.push(`the server tried to reach the network ${blocked.length} time(s): ${blocked.slice(0, 5).join(' ')}`);
      if (forced) problems.push(`the E2E server ignored SIGTERM for ${STOP_TIMEOUT_MS / 1_000} s and was killed`);
      else if (code !== 0) problems.push(`the E2E server exited with ${signal ?? `code ${code}`} while shutting down`);
      if (existsSync(info.tempRoot)) {
        await removeHarnessTempRoot(info.tempRoot);
        if (!forced) problems.push(`the E2E server left its temp directory behind (${info.tempRoot}; now removed)`);
      }
      await rm(PROCESS_FILE, { force: true });
      if (await isPortOpen(E2E_PORT)) problems.push(`port ${E2E_PORT} is still in use after teardown`);
      if (problems.length > 0) throw new Error(`E2E teardown: ${problems.join('; ')}. Server log: ${LOG_FILE}`);
    },
  };
}

/** Only what the harness needs: none of the developer's secrets or app settings reach it. */
function harnessEnvironment() {
  const env = { [HARNESS_LIFELINE_ENV]: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG', 'TZ']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function stopChild(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return { ...(await exited), forced: false };
  child.kill('SIGTERM');
  let result = await withTimeout(exited, STOP_TIMEOUT_MS);
  let forced = false;
  if (!result) {
    forced = true;
    child.kill('SIGKILL');
    result = await withTimeout(exited, KILL_TIMEOUT_MS) ?? { code: null, signal: 'SIGKILL' };
  }
  return { ...result, forced };
}

async function stopPid(pid) {
  if (!signal(pid, 'SIGTERM') || await waitUntil(() => !isAlive(pid), STOP_TIMEOUT_MS)) return;
  if (!signal(pid, 'SIGKILL') || await waitUntil(() => !isAlive(pid), KILL_TIMEOUT_MS)) return;
  throw new Error(`Could not stop the leftover E2E server (pid ${pid})`);
}

/** Send `name` to `pid`; `false` when the process is already gone. */
function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

/** Delete a harness temp directory, refusing any path that is not one. */
async function removeHarnessTempRoot(path) {
  const target = resolve(String(path));
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(HARNESS_TEMP_PREFIX)) return;
  await rm(target, { recursive: true, force: true });
}

async function readProcessFile() {
  try {
    const recorded = JSON.parse(await readFile(PROCESS_FILE, 'utf8'));
    return Number.isSafeInteger(recorded?.pid) && recorded.pid > 0 ? recorded : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Whether `pid` is an E2E server this runner starts: `node <absolute path of
 * this repository's start-test-server.js>`. A reused pid, or a harness a
 * developer started by hand, never matches.
 */
async function isHarnessProcess(pid) {
  return (await commandLine(pid)).includes(HARNESS_SCRIPT);
}

async function commandLine(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]);
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Processes listening on `port` (needs `lsof`; empty when it is unavailable). */
async function portListeners(port) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
    const listeners = [];
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) listeners.push({ pid: Number(line.slice(1)), command: '' });
      else if (line.startsWith('c') && listeners.length > 0) listeners.at(-1).command = line.slice(1);
    }
    return listeners.filter(listener => Number.isSafeInteger(listener.pid));
  } catch {
    return [];
  }
}

/** Whether something accepts connections on the E2E address (a timeout counts as busy). */
function isPortOpen(port) {
  return new Promise(resolvePromise => {
    const socket = net.connect({ host: E2E_HOST, port });
    const settle = open => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(1_000, () => settle(true));
    socket.once('connect', () => settle(true));
    socket.once('error', error => settle(error?.code !== 'ECONNREFUSED'));
  });
}

async function waitUntil(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  return condition();
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolvePromise => {
      timer = setTimeout(() => resolvePromise(null), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
