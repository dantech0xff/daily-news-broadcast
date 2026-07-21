import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { buildOutputTopology } from '../../src/core/delivery.js';

const ARTICLE = {
  id: 'legacy-article',
  title: 'Legacy queued article',
  url: 'https://example.invalid/legacy-article',
  content: 'Legacy content',
  source: 'Legacy Source',
  publishedAt: '2026-07-20T00:00:00.000Z',
};

describe('paused legacy migration and resume gate', () => {
  it('maps allowlisted state atomically, excludes tokens, replays idempotently, and gates resume', async () => {
    const channelId = 'legacy-migration-channel';
    const stub = env.NEWS_COORDINATOR.getByName(channelId);

    await runInDurableObject(stub, async instance => {
      const output = {
        id: 'telegram',
        deliveryKey: 'telegram:legacy-fixture',
        supportsSingleMutation: true,
      };
      instance._findChannel = () => ({ id: channelId, output });
      await instance._ensureIdentity(channelId);
      const machine = instance._machine(channelId);
      let channel = await machine.getChannelState();
      if (!channel.paused) {
        await machine.setPaused(true, {
          expectedVersion: channel.version,
          idempotencyKey: 'pause-before-migration',
          operatorId: 'fixture-operator',
          reason: 'offline migration fixture',
        });
      }
      channel = await machine.getChannelState();

      await expect(instance.control({
        action: 'resume',
        channelId,
        expectedVersion: channel.version,
        idempotencyKey: 'premature-resume',
        operatorId: 'fixture-operator',
        reason: 'must remain blocked before migration',
      })).rejects.toThrow(/migration is not committed/i);
      expect((await machine.getChannelState()).paused).toBe(true);

      const prefix = `news:${channelId}:`;
      await env.NEWS_CACHE.put(`${prefix}seen:legacy-hash`, '1');
      await env.NEWS_CACHE.put(`${prefix}digest:2026-07-20`, JSON.stringify({ sentAt: '2026-07-20T01:00:00Z' }));
      await env.NEWS_CACHE.put(`${prefix}drip:queue:2026-07-20`, JSON.stringify([ARTICLE]));
      await env.NEWS_CACHE.put(`${prefix}seen:token-secret-must-be-excluded`, 'private-token-value');

      const action = {
        action: 'migrate-legacy',
        channelId,
        expectedVersion: channel.version,
        idempotencyKey: 'legacy-migration-key',
        operatorId: 'fixture-operator',
        reason: 'import stable legacy snapshot',
      };
      const migrated = await instance.control(action);
      await env.NEWS_CACHE.put(`${prefix}seen:v2:post-migration-mirror`, '1');
      const replay = await instance.control(action);

      expect(replay).toEqual(migrated);
      expect(migrated).toMatchObject({
        status: 'committed',
        counts: {
          keys: 3,
          seen: 1,
          digests: 1,
          queues: 1,
          importedQueueItems: 1,
        },
      });
      await expect(instance.control({
        ...action,
        reason: 'different payload under the same migration key',
      })).rejects.toThrow(/idempotency key conflicts/i);
      const secondOperatorResult = await instance.control({
        ...action,
        idempotencyKey: 'legacy-migration-second-operator-key',
        operatorId: 'fixture-operator-two',
        reason: 'independent review of the committed migration',
      });
      expect(secondOperatorResult).toEqual(migrated);
      const migrationAudits = (await instance.store.list('operator_actions'))
        .filter(row => row.action === 'migrate-legacy');
      expect(migrationAudits).toHaveLength(2);
      expect(migrationAudits.map(row => row.operatorId).sort()).toEqual([
        'fixture-operator',
        'fixture-operator-two',
      ]);
      expect(migrationAudits.every(row => row.migrationId === migrated.migrationId)).toBe(true);
      expect(JSON.stringify(migrationAudits)).not.toMatch(/stable legacy snapshot|independent review/);
      await instance.store.transact(tx => {
        for (const audit of tx.query('operator_actions', { channelId, state: 'minimized' })) {
          if (audit.action !== 'migrate-legacy') continue;
          tx.put('operator_actions', audit.actionId, {
            ...audit,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }, { expectedVersion: audit.version });
        }
      });
      await machine.compactHistory();
      expect(await instance.control(action)).toEqual(migrated);
      const legacySeen = await instance.store.list('legacy_seen_compat');
      expect(legacySeen).toHaveLength(1);
      expect(Date.parse(legacySeen[0].expiresAt)).toBeGreaterThan(Date.parse(legacySeen[0].importedAt));
      expect(await instance.store.list('legacy_digest_compat')).toHaveLength(1);
      expect(await instance.store.list('day_batches')).toHaveLength(1);
      expect(await instance.store.list('batch_items')).toHaveLength(1);
      expect(await instance.store.list('deliveries')).toHaveLength(1);
      expect(await env.NEWS_CACHE.get(`${prefix}drip:queue:2026-07-20`)).toBe(JSON.stringify([ARTICLE]));
      expect(await env.NEWS_CACHE.get(`${prefix}seen:token-secret-must-be-excluded`)).toBe('private-token-value');

      await expect(instance.control({
        action: 'resume',
        channelId,
        expectedVersion: (await machine.getChannelState()).version,
        idempotencyKey: 'resume-without-canary',
        operatorId: 'fixture-operator',
        reason: 'must remain blocked without canary evidence',
      })).rejects.toThrow(/canary is required/i);

      const canaryChannel = await machine.getChannelState();
      const topology = await buildOutputTopology([output]);
      await instance.store.transact(tx => tx.put('canary_state', channelId, {
        channelId,
        requestId: 'offline-successful-canary',
        deliveryId: 'offline-canary-delivery',
        destinationFingerprint: topology.fingerprint,
        channelVersion: canaryChannel.version,
        state: 'succeeded',
        completedAt: '2026-07-20T02:00:00.000Z',
        updatedAt: '2026-07-20T02:00:00.000Z',
      }, { expectedVersion: 0 }));

      const resumed = await instance.control({
        action: 'resume',
        channelId,
        expectedVersion: (await machine.getChannelState()).version,
        idempotencyKey: 'resume-after-migration',
        operatorId: 'fixture-operator',
        reason: 'migration and topology verified',
      });
      expect(resumed).toMatchObject({ status: 'resumed' });
      expect((await machine.getChannelState()).paused).toBe(false);
    });
  });
});
