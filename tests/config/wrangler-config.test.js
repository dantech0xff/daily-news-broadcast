import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const production = await readFile(new URL('../../wrangler.toml', import.meta.url), 'utf8');
const quiesce = await readFile(new URL('../../wrangler.quiesce.toml', import.meta.url), 'utf8');
const activePaused = await readFile(new URL('../../wrangler.active-paused.toml', import.meta.url), 'utf8');

test('quiesce and final configs target the same worker/runtime/KV/triggers', () => {
  for (const key of ['name', 'main', 'compatibility_date', 'compatibility_flags']) {
    assert.equal(setting(quiesce, key), setting(production, key), `${key} drifted`);
  }
  assert.equal(section(quiesce, 'triggers'), section(production, 'triggers'));
  assert.equal(kvBinding(quiesce), kvBinding(production));
  assert.equal(setting(quiesce, 'OPERATOR_KEY_ID'), setting(production, 'OPERATOR_KEY_ID'));
  assert.equal(setting(production, 'OPERATOR_KEY_ID'), '"operator-main"');
});

test('quiesce is reversible pre-lifecycle and hard-disables both writers', () => {
  assert.match(quiesce, /NEWS_RUNTIME_MODE\s*=\s*"quiesced"/);
  assert.match(quiesce, /TOKEN_MAINTENANCE_MODE\s*=\s*"disabled"/);
  assert.doesNotMatch(quiesce, /durable_objects|\[exports\.|new_sqlite_classes|\[\[migrations\]\]/);
});

test('final config declares SQLite coordinator in bootstrap and paused mode', () => {
  assert.match(production, /\[\[durable_objects\.bindings\]\]/);
  assert.match(production, /name\s*=\s*"NEWS_COORDINATOR"/);
  assert.match(production, /\[exports\.ChannelDeliveryCoordinator\]/);
  assert.match(production, /type\s*=\s*"durable-object"/);
  assert.match(production, /storage\s*=\s*"sqlite"/);
  assert.match(production, /NEWS_RUNTIME_MODE\s*=\s*"bootstrap"/);
  assert.match(production, /NEWS_DEFAULT_PAUSED\s*=\s*"true"/);
  assert.match(production, /TOKEN_MAINTENANCE_MODE\s*=\s*"disabled"/);
});

test('active-paused config changes only the runtime gate from the bootstrap artifact', () => {
  assert.match(activePaused, /NEWS_RUNTIME_MODE\s*=\s*"active"/);
  assert.match(activePaused, /NEWS_DEFAULT_PAUSED\s*=\s*"true"/);
  assert.match(activePaused, /TOKEN_MAINTENANCE_MODE\s*=\s*"disabled"/);
  assert.equal(
    activePaused.replace(
      'NEWS_RUNTIME_MODE = "active"',
      'NEWS_RUNTIME_MODE = "bootstrap"',
    ).replace(
      '# Channel runner remains durably paused; active mode only unlocks audited migration/canary controls.',
      '# Channel runner: every 30min + hourly token refresh for X/Threads',
    ),
    production,
  );
});

function setting(text, key) {
  return text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();
}

function section(text, name) {
  return text.match(new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1]?.trim();
}

function kvBinding(text) {
  return text.match(/\[\[kv_namespaces\]\]([\s\S]*?)(?=\n\[|$)/)?.[1]?.trim();
}
