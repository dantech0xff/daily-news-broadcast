import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDatabase, openDatabase } from '../../../src/app/db/open-database.js';

/**
 * Create a unique data directory for one test. Every connection opened through
 * the returned `open()` is closed, and the directory removed, when the test ends.
 */
export async function createTempDataDir(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-radar-app-'));
  const connections = [];
  t.after(async () => {
    for (const db of connections) closeDatabase(db);
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    open(options = {}) {
      const db = openDatabase({ dataDir, ...options });
      connections.push(db);
      return db;
    },
  };
}
