import test from 'node:test';
import assert from 'node:assert/strict';

import { createDokployClient, createPlanner } from '../../scripts/deploy/api-clients.mjs';
import { Redactor } from '../../scripts/deploy/redaction.mjs';

const API_KEY = 'fake-dokploy-api-key-0123456789';
const CLIENT_ID = 'fake-client-id.access';
const CLIENT_SECRET = 'fake-client-secret-abcdefghijklmnop';

function client({ fetch, accessServiceToken }) {
  const redactor = new Redactor();
  redactor.add(API_KEY);
  redactor.add(CLIENT_SECRET);
  return createDokployClient({
    baseUrl: 'https://dokploy.example.test',
    apiKey: API_KEY,
    accessServiceToken,
    fetch,
    planner: createPlanner({ dryRun: false, report: { plan() {} } }),
    redactor,
  });
}

function recordingFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify('v0.30.8'), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('Dokploy requests carry the Access service-token headers when a token is configured', async () => {
  const calls = [];
  const dokploy = client({ fetch: recordingFetch(calls), accessServiceToken: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
  assert.equal(await dokploy.query('settings.getDokployVersion'), 'v0.30.8');
  const { headers, redirect } = calls[0].init;
  assert.equal(headers['x-api-key'], API_KEY);
  assert.equal(headers['CF-Access-Client-Id'], CLIENT_ID);
  assert.equal(headers['CF-Access-Client-Secret'], CLIENT_SECRET);
  assert.equal(redirect, 'error', 'redirects are still never followed');
});

test('Dokploy requests send no Access headers without a complete service token', async () => {
  for (const accessServiceToken of [undefined, { clientId: CLIENT_ID, clientSecret: '' }]) {
    const calls = [];
    await client({ fetch: recordingFetch(calls), accessServiceToken }).query('settings.getDokployVersion');
    assert.equal('CF-Access-Client-Id' in calls[0].init.headers, false);
    assert.equal('CF-Access-Client-Secret' in calls[0].init.headers, false);
  }
});

test('a redirected Dokploy request explains the Cloudflare Access fix without leaking secrets', async () => {
  const redirecting = async () => {
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  };
  const dokploy = client({ fetch: redirecting, accessServiceToken: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
  await assert.rejects(dokploy.query('settings.getDokployVersion'), error => {
    assert.match(error.message, /unexpected redirect/);
    assert.match(error.message, /Service Auth policy/);
    assert.match(error.message, /CF_ACCESS_CLIENT_ID/);
    assert.equal(error.message.includes(API_KEY), false);
    assert.equal(error.message.includes(CLIENT_SECRET), false);
    return true;
  });
});
