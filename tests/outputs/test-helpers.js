import assert from 'node:assert/strict';

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function textResponse(status, body = '', headers = {}) {
  const responseBody = [204, 205, 304].includes(status) ? null : body;
  return new Response(responseBody, { status, headers });
}

export function sequenceFetch(responses) {
  const calls = [];
  let index = 0;

  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.ok(index < responses.length, `Unexpected fetch call ${index + 1}: ${url}`);
    const response = responses[index++];
    return typeof response === 'function' ? response(url, init) : response;
  };

  return { fetch, calls };
}

export function noDelay() {
  return Promise.resolve();
}

export function assertCanonicalResult(result, deliveryState, retryDisposition) {
  assert.equal(result.meta.deliveryState, deliveryState);
  assert.equal(result.meta.retryDisposition, retryDisposition);
  assert.equal(result.success, deliveryState === 'success');
  assert.equal(Object.hasOwn(result, 'deliveryState'), false);
  assert.equal(Object.hasOwn(result, 'retryDisposition'), false);
}
