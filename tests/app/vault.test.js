import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { CredentialRepository } from '../../src/app/secrets/credential-repository.js';
import {
  SecretVault,
  VAULT_FINGERPRINT_SETTING,
  VaultDecryptionError,
  VaultKeyError,
  keyFingerprint,
  parseMasterKey,
} from '../../src/app/secrets/vault.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const MASTER_KEY = Buffer.from('fake-master-key-for-tests-only!!').toString('base64');
const OTHER_MASTER_KEY = Buffer.from('another-fake-master-key-for-test').toString('base64');
const START = '2026-10-03T00:00:00.000Z';
const AAD = 'content-radar:credential:v1\u001fcredential-1\u001fai_api_key';

async function setup(t, masterKey = MASTER_KEY) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: new Date(START) });
  const storage = createNodeSqlStorage(db);
  const clock = () => new Date(START);
  return { workspace, db, storage, clock, vault: new SecretVault({ storage, masterKey, clock }) };
}

function flipFirstByte(base64) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

async function readDataFiles(directory) {
  const files = [];
  for (const name of await readdir(directory, { recursive: true })) {
    const path = join(directory, name);
    if ((await stat(path)).isFile()) files.push({ name, bytes: await readFile(path) });
  }
  return files;
}

test('the master key must be canonical base64 of exactly 32 bytes', () => {
  assert.equal(parseMasterKey(MASTER_KEY).length, 32);
  assert.equal(parseMasterKey(`  ${MASTER_KEY}\n`).length, 32);

  for (const value of [undefined, null, '', '   ', 42]) {
    assert.throws(() => parseMasterKey(value), error => error instanceof VaultKeyError && error.code === 'vault_key_missing');
  }
  const invalid = [
    Buffer.alloc(31, 1).toString('base64'),
    Buffer.alloc(33, 1).toString('base64'),
    MASTER_KEY.replace(/=+$/, ''),
    Buffer.alloc(32, 0xfb).toString('base64url'),
    'not-base64-at-all-but-long-enough-to-matter!!',
  ];
  for (const value of invalid) {
    assert.throws(() => parseMasterKey(value), error => {
      assert.ok(error instanceof VaultKeyError);
      assert.equal(error.code, 'vault_key_invalid');
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test('the key fingerprint is a stable keyed digest that reveals nothing about the key', () => {
  const key = parseMasterKey(MASTER_KEY);
  const fingerprint = keyFingerprint(key);
  assert.match(fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(keyFingerprint(parseMasterKey(MASTER_KEY)), fingerprint);
  assert.notEqual(keyFingerprint(parseMasterKey(OTHER_MASTER_KEY)), fingerprint);
  assert.ok(!key.toString('hex').includes(fingerprint));
});

test('encryption round-trips with a fresh random IV every time', async t => {
  const { vault } = await setup(t);
  const plaintext = 'fake-ai-key-for-tests — tiếng Việt ✓';
  const first = vault.encrypt(plaintext, AAD);
  const second = vault.encrypt(plaintext, AAD);

  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  assert.equal(Buffer.from(first.authTag, 'base64').length, 16);
  assert.equal(first.keyFingerprint, vault.fingerprint);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes('fake-ai-key-for-tests'));
  assert.equal(vault.decrypt(first, AAD), plaintext);
  assert.equal(vault.decrypt(second, AAD), plaintext);
});

test('tampered ciphertext, IV, tag, or associated data fails authentication', async t => {
  const { vault } = await setup(t);
  const sealed = vault.encrypt('fake-gateway-token-for-tests', AAD);

  const tampered = [
    { ...sealed, ciphertext: flipFirstByte(sealed.ciphertext) },
    { ...sealed, iv: flipFirstByte(sealed.iv) },
    { ...sealed, authTag: flipFirstByte(sealed.authTag) },
    { ...sealed, authTag: Buffer.from(sealed.authTag, 'base64').subarray(0, 12).toString('base64') },
    { ...sealed, ciphertext: '***' },
  ];
  for (const record of tampered) {
    assert.throws(() => vault.decrypt(record, AAD), error => {
      assert.ok(error instanceof VaultDecryptionError);
      assert.equal(error.code, 'vault_decrypt_failed');
      assert.ok(!error.message.includes('fake-gateway-token-for-tests'));
      return true;
    });
  }
  assert.throws(() => vault.decrypt(sealed, `${AAD}-other`), VaultDecryptionError);
  assert.equal(vault.decrypt(sealed, AAD), 'fake-gateway-token-for-tests');
});

test('the first use records the key fingerprint and later starts verify it', async t => {
  const { storage, vault, clock } = await setup(t);
  assert.deepEqual(vault.initialize(), { recorded: true });
  assert.deepEqual(
    storage.sql.exec('SELECT key, value, updated_at FROM app_settings').toArray(),
    [{ key: VAULT_FINGERPRINT_SETTING, value: vault.fingerprint, updated_at: START }],
  );
  assert.deepEqual(vault.initialize(), { recorded: false });
  assert.deepEqual(new SecretVault({ storage, masterKey: MASTER_KEY, clock }).initialize(), { recorded: false });
});

test('a different master key fails fast without exposing key material', async t => {
  const { storage, vault, clock } = await setup(t);
  const sealed = vault.encrypt('fake-ai-key-for-tests', AAD);
  const wrong = new SecretVault({ storage, masterKey: OTHER_MASTER_KEY, clock });

  for (const action of [() => wrong.initialize(), () => wrong.decrypt(sealed, AAD), () => wrong.encrypt('x', AAD)]) {
    assert.throws(action, error => {
      assert.ok(error instanceof VaultKeyError);
      assert.equal(error.code, 'vault_key_mismatch');
      for (const secret of [MASTER_KEY, OTHER_MASTER_KEY, vault.fingerprint, wrong.fingerprint]) {
        assert.ok(!error.message.includes(secret));
      }
      return true;
    });
  }
});

test('credentials sealed by another key fail fast even without a recorded fingerprint', async t => {
  const { storage, vault, clock } = await setup(t);
  const credentials = new CredentialRepository({ storage, vault, clock });
  credentials.create({ label: 'AI key', kind: 'ai_api_key', value: 'fake-ai-key-for-tests', actor: 'ops@example.test' });
  storage.sql.exec('DELETE FROM app_settings WHERE key = ?', VAULT_FINGERPRINT_SETTING);

  const wrong = new SecretVault({ storage, masterKey: OTHER_MASTER_KEY, clock });
  assert.throws(() => wrong.initialize(), error => error instanceof VaultKeyError && error.code === 'vault_key_mismatch');
  assert.deepEqual(storage.sql.exec('SELECT key FROM app_settings').toArray(), []);
  assert.deepEqual(new SecretVault({ storage, masterKey: MASTER_KEY, clock }).initialize(), { recorded: true });
});

test('the vault never exposes its key through inspection or serialization', async t => {
  const { vault } = await setup(t);
  const key = parseMasterKey(MASTER_KEY);
  for (const rendered of [inspect(vault, { showHidden: true, depth: 5 }), JSON.stringify(vault), String(Object.keys(vault))]) {
    assert.ok(!rendered.includes(MASTER_KEY));
    assert.ok(!rendered.includes(key.toString('hex')));
    assert.ok(!rendered.includes('fake-master-key'));
  }
});

test('credential plaintext never reaches the database files or returned metadata', async t => {
  const { workspace, db, storage, vault, clock } = await setup(t);
  const credentials = new CredentialRepository({ storage, vault, clock });
  const first = 'FAKE-plaintext-marker-0001';
  const second = 'FAKE-plaintext-marker-0002';
  const label = 'Label-marker-visible-7f3a';

  const created = credentials.create({ label, kind: 'ai_api_key', value: first, actor: 'ops@example.test' });
  const replaced = credentials.replace(created.id, { value: second, actor: 'ops@example.test' });
  const metadata = JSON.stringify([created, replaced, credentials.get(created.id), credentials.list()]);
  for (const secret of [first, second]) assert.ok(!metadata.includes(secret));
  const row = storage.sql.exec('SELECT ciphertext, iv, auth_tag FROM app_credentials').one();
  for (const sealedValue of Object.values(row)) assert.ok(!metadata.includes(sealedValue));
  assert.equal(credentials.resolvePlaintext(created.id), second);

  const assertNoPlaintextOnDisk = async () => {
    const files = await readDataFiles(workspace.dataDir);
    assert.ok(files.some(file => file.bytes.includes(Buffer.from(label))), 'scan reaches the stored rows');
    for (const file of files) {
      for (const secret of [first, second]) {
        assert.ok(!file.bytes.includes(Buffer.from(secret)), `${secret} found in ${file.name}`);
        assert.ok(!file.bytes.includes(Buffer.from(Buffer.from(secret).toString('base64'))), `${secret} (base64) found in ${file.name}`);
      }
    }
  };
  await assertNoPlaintextOnDisk();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  await assertNoPlaintextOnDisk();
});
