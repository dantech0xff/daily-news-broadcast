import { exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import testWranglerConfig from '../../wrangler.test.toml?raw';
import { NETWORK_DENIAL } from './setup.js';

describe('Workers test isolation', () => {
  it('fails fast when same-isolate code attempts an unexpected fetch', async () => {
    const response = await exports.default.fetch('https://worker.test/__test/unexpected-outbound');
    expect(response.status).toBe(599);
    expect(await response.text()).toContain(NETWORK_DENIAL);
  });

  it('routes outbound requests to the local denial service when fetch is not stubbed', async () => {
    vi.unstubAllGlobals();
    const response = await exports.default.fetch('https://worker.test/__test/unexpected-outbound');
    expect(response.status).toBe(598);
    expect(response.headers.get('x-newsengine-network')).toBe('blocked');
    expect(await response.text()).toContain('Unexpected outbound request blocked by Workers test harness');
  });

  it('keeps the standalone Wrangler test config free of production bindings and schedules', () => {
    expect(testWranglerConfig).toContain('name = "news-engine-workers-test"');
    expect(testWranglerConfig).toContain('main = "tests/fixtures/cloudflare-worker.js"');
    expect(testWranglerConfig).toContain('id = "00000000000000000000000000000000"');
    expect(testWranglerConfig).not.toMatch(/^\s*\[triggers\]/m);
    expect(testWranglerConfig).not.toMatch(/^\s*crons\s*=/m);
    expect(testWranglerConfig).not.toMatch(/(API_KEY|BOT_TOKEN|CHAT_ID|TRIGGER_SECRET|OPERATOR_SECRET)\s*=/);

    const namespaceIds = [...testWranglerConfig.matchAll(/^\s*id\s*=\s*"([^"]+)"/gm)]
      .map(match => match[1]);
    expect(namespaceIds).toEqual(['00000000000000000000000000000000']);
  });
});
