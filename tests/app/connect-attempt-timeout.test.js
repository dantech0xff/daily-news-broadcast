import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_CONNECT_ATTEMPT_TIMEOUT_MS, raiseConnectAttemptTimeout } from '../../src/app/server.js';

const SERVER_PATH = fileURLToPath(new URL('../../src/app/server.js', import.meta.url));

function fakeNet(initialMs) {
  let value = initialMs;
  return {
    getDefaultAutoSelectFamilyAttemptTimeout: () => value,
    setDefaultAutoSelectFamilyAttemptTimeout: next => { value = next; },
  };
}

test('Node\'s 250 ms per-address connect attempt timeout is raised to the minimum', () => {
  assert.equal(raiseConnectAttemptTimeout(fakeNet(250)), MIN_CONNECT_ATTEMPT_TIMEOUT_MS);
});

test('a larger per-address connect attempt timeout set on the command line is kept', () => {
  assert.equal(raiseConnectAttemptTimeout(fakeNet(10_000)), 10_000);
});

test('the server executable raises the connect attempt timeout before it starts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'content-radar-connect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Prints the process-wide value on exit; startup itself fails fast on the empty environment.
  const probe = "import net from 'node:net'; process.on('exit', () => console.log('attempt-timeout=' + net.getDefaultAutoSelectFamilyAttemptTimeout()));";
  const child = spawn(process.execPath, ['--no-warnings', '--import', `data:text/javascript,${encodeURIComponent(probe)}`, SERVER_PATH], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1, output);
  assert.match(output, new RegExp(`attempt-timeout=${MIN_CONNECT_ATTEMPT_TIMEOUT_MS}\\b`));
});
