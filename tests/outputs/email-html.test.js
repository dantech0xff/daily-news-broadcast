import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EmailOutput } from '../../src/outputs/channels.js';
import { jsonResponse, sequenceFetch } from './test-helpers.js';

test('email HTML escapes hostile content and drops dangerous markdown destinations', async () => {
  const transport = sequenceFetch([jsonResponse(200, { id: 'mail-1' })]);
  const output = new EmailOutput({
    provider: 'resend',
    apiKey: 'secret',
    from: 'from@example.test',
    to: 'to@example.test',
    fetch: transport.fetch,
  });
  const content = [
    '<img src=x onerror=alert(1)><script>alert(2)</script>',
    '[script](javascript:alert(3)) [data](data:text/html,<svg onload=alert(4)>) [relative](/admin)',
    '&lt;iframe srcdoc="hostile"&gt;',
  ].join('\n');

  const result = await output.send(content);
  const html = requestHTML(transport);

  assert.equal(result.success, true);
  assert.doesNotMatch(html, /<(?:img|script|svg|iframe)\b/i);
  assert.doesNotMatch(html, /href=/i);
  assert.doesNotMatch(html, /(?:javascript|data):/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&amp;lt;iframe srcdoc=&quot;hostile&quot;&amp;gt;/);
  assert.match(html, /script data relative/);
});

test('email HTML retains safe basic markdown using only allowlisted markup', async () => {
  const transport = sequenceFetch([jsonResponse(200, { id: 'mail-2' })]);
  const output = new EmailOutput({
    provider: 'resend',
    apiKey: 'secret',
    from: 'from@example.test',
    to: 'to@example.test',
    fetch: transport.fetch,
  });

  await output.send([
    '**Bold** *also bold* _italic_ `<tag attr="x">`',
    '[Docs & help](https://example.test/docs?q=one&lang=en)',
    '',
    'Second paragraph',
  ].join('\n'));
  const html = requestHTML(transport);

  assert.equal(html, [
    '<p><strong>Bold</strong> <strong>also bold</strong> <em>italic</em> ',
    '<code>&lt;tag attr=&quot;x&quot;&gt;</code><br>',
    '<a href="https://example.test/docs?q=one&amp;lang=en">Docs &amp; help</a></p>',
    '<p>Second paragraph</p>',
  ].join(''));
  const tags = [...html.matchAll(/<\/?([a-z]+)(?:\s[^>]*)?>/gi)]
    .map(match => match[1].toLowerCase());
  assert.equal(tags.length > 0, true);
  assert.equal(tags.every(tag => ['p', 'strong', 'em', 'code', 'br', 'a'].includes(tag)), true);
});

function requestHTML(transport) {
  assert.equal(transport.calls.length, 1);
  return JSON.parse(transport.calls[0].init.body).html;
}
