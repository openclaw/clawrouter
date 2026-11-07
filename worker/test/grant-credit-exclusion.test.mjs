import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionFixture, admissionHeaders } from './admission-fixture.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { putGrantCredentials } from '../grant-credentials.ts';
import { clearHotCaches } from '../hot-cache.ts';
import { flushSelections } from '../admission-cache.ts';
import { observeProviderGrantQuota } from '../provider-quota.ts';
import { mergeGrantRuntimeState } from '../grant-runtime.ts';
import { providerById } from '../providers.ts';
import { grantQuotaExhausted } from '../grant-quota.ts';
const { default: worker } = await import('../index.ts');

const creditBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });
const rejected = () => new Response(creditBody, { status: 400, headers: { 'content-type': 'application/json' } });
const healthy = () => Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
async function fixture(t, routing = {}, subscription = false) {
  let now = Date.parse('2030-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = await admissionFixture();
  attachGrantCredentialNamespace(f.env, { useExistingAuthority: true });
  f.policy.grantRouting = { stickiness: 'session', ...routing };
  await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  for (const ref of ['anthropic', 'backup']) await putGrantCredentials(f.env, `oauth/fixture/${ref}`, {
    provider: 'anthropic', enabled: true, ...(subscription ? { kind: 'subscription', accessToken: `synthetic-${ref}` } : { kind: 'api_key', credential: `synthetic-${ref}` }),
  });
  const calls = []; let reject = () => false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const key = new Headers(init.headers).get('x-api-key'); calls.push(key);
    return reject(key) ? rejected() : healthy();
  });
  const send = async (session = 'sticky-fixture', stream = false, headers = admissionHeaders) => {
    const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: { ...headers, 'x-clawrouter-session-id': session }, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, stream, messages: [{ role: 'user', content: 'synthetic' }] }) }), f.env, f.context);
    const body = await response.text(); await Promise.all(f.pending.splice(0));
    return { status: response.status, body, failover: response.headers.get('x-clawrouter-grant-failover'), retryAfter: response.headers.get('retry-after') };
  };
  return { ...f, calls, send, reject(fn) { reject = fn; }, advance(ms) { now += ms; } };
}

for (const stream of [false, true]) test(`credit rejection reselects before delivery and keeps healthy stickiness (stream=${stream})`, async t => {
  const f = await fixture(t);
  assert.equal((await f.send()).status, 200);
  const original = f.calls[0];
  await f.send(); assert.equal(f.calls[1], original);
  f.reject(key => key === original);
  const result = await f.send('sticky-fixture', stream);
  assert.equal(result.status, 200);
  assert.equal(result.failover, '1');
  assert.equal(f.calls.length, 4);
  const alternate = f.calls[3]; assert.notEqual(alternate, original);
  await f.send(); assert.equal(f.calls.at(-1), alternate);
  assert.equal(f.calls.length, 5, 'warm snapshot excludes depleted grant without another failed attempt');
  await flushSelections(f.env);
  clearHotCaches();
  await f.send(); assert.equal(f.calls.at(-1), alternate, 'authority retains exclusion across cold admission');
  f.advance(300_000); f.reject(() => false);
  await f.send(); assert.equal(f.calls.at(-1), original, 'bounded exclusion expires and restores deterministic stickiness');
});

test('all depleted grants stop dispatching and return a timed pool error', async t => {
  const f = await fixture(t); f.reject(() => true);
  const first = await f.send();
  assert.equal(first.status, 400); assert.equal(first.body, creditBody);
  assert.equal(f.calls.length, 2, 'at most one alternate');
  const next = await f.send();
  assert.equal(next.status, 429); assert.equal(next.retryAfter, '300');
  assert.match(next.body, /no available scoped upstream grant/);
  assert.equal(f.calls.length, 2);
});

test('failover-disabled policy records exclusion for the next request', async t => {
  const f = await fixture(t, { failover: false });
  await f.send(); const original = f.calls[0]; f.reject(key => key === original);
  assert.equal((await f.send()).status, 400);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.send()).status, 200);
  assert.notEqual(f.calls.at(-1), original);
});

for (const shared of [false, true]) test(`exclusion crosses tenant scope only for explicitly shared grants (shared=${shared})`, async t => {
  const f = await fixture(t, {}, shared); f.reject(() => true);
  await f.send(); await flushSelections(f.env);
  await f.call('/policies/put', { policyId: 'other', policy: { ...f.policy, tenantId: 'other', ...(shared ? { grantRouting: { sharedGrants: { anthropic: ['oauth/fixture/anthropic'] } } } : {}) } });
  await f.call('/credentials/mutate', { operation: 'create', scope: 'admin', actor: { auth: 'admin_token', role: 'admin', email: 'admin@example.com' }, credentialId: 'other', credential: { ...f.credential, policyId: 'other' } });
  if (!shared) await putGrantCredentials(f.env, 'oauth/other/anthropic', { provider: 'anthropic', kind: 'api_key', enabled: true, credential: 'synthetic-other' });
  f.reject(() => false);
  const otherHeaders = { ...admissionHeaders, authorization: admissionHeaders.authorization.replace('fixture-', 'other-') };
  const other = await f.send('sticky-fixture', false, otherHeaders);
  assert.equal(other.status, shared ? 429 : 200, other.body);
  if (shared) assert.equal(f.calls.length, 2);
  else assert.equal(f.calls.at(-1), 'synthetic-other');
});

for (const [name, body] of [
  ['unrelated invalid request', JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is invalid' } })],
  ['credit words outside the error message', JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid input' }, input: creditBody })],
  ['malformed JSON', creditBody.slice(0, -1)],
  ['oversized error', creditBody.slice(0, -1) + ',"padding":"' + 'x'.repeat(65536) + '"}'],
]) test(`${name} stays byte-identical and never excludes or retries`, async t => {
  const f = await fixture(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { calls.push(new Headers(init.headers).get('x-api-key')); return new Response(body, { status: 400 }); });
  for (let i = 0; i < 2; i++) { const result = await f.send(); assert.equal(result.status, 400); assert.equal(result.body, body); }
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
});

test('credit error after SSE message bytes never replays generation', async t => {
  const f = await fixture(t);
  const body = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\nevent: error\ndata: ' + creditBody + '\n\n';
  const upstream = t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const result = await f.send('sticky-fixture', true);
  assert.equal(result.status, 200); assert.equal(result.body, body); assert.equal(upstream.mock.callCount(), 1);
});

test('cancellation while reading rejection never dispatches an alternate', async t => {
  const f = await fixture(t), controller = new AbortController();
  let canceled = false;
  const upstream = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode(creditBody.slice(0, 20))); setTimeout(() => controller.abort(), 5); },
    cancel() { canceled = true; },
  }), { status: 400 }));
  const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: admissionHeaders, signal: controller.signal,
    body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'synthetic' }] }) }), f.env, f.context);
  await response.text().catch(error => assert.equal(error.name, 'AbortError')); await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1); assert.equal(canceled, true);
});

for (const width of [17, 1]) test(`fragmented credit errors respect the 128-read inspection bound (chunk width=${width})`, async t => {
  const f = await fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls > 1 && width === 17) return healthy();
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === creditBody.length) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(creditBody.slice(offset, offset + width)));
      offset = Math.min(offset + width, creditBody.length);
    } }), { status: 400 });
  });
  const result = await f.send();
  assert.equal(result.status, width === 17 ? 200 : 400);
  assert.equal(calls, width === 17 ? 2 : 1);
  if (width === 1) assert.equal(result.body, creditBody);
});

test('late pre-credit admission refresh cannot replace the warm exclusion after feedback flush', async t => {
  const f = await fixture(t);
  await f.send(); const original = f.calls[0];
  const captured = Promise.withResolvers(), release = Promise.withResolvers();
  const get = f.env.ACCESS_CONTROL.get;
  let hold = true;
  f.env.ACCESS_CONTROL.get = id => {
    const stub = get(id);
    return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (hold && new URL(url).pathname === '/admission/resolve') {
        hold = false; captured.resolve(); await release.promise;
      }
      return response;
    } };
  };
  t.after(() => release.resolve());
  f.advance(10_001);
  // This stale hit starts a refresh which captured the pre-credit authority state.
  const pending = worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: { ...admissionHeaders, 'x-clawrouter-session-id': 'sticky-fixture' },
    body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [] }) }), f.env, f.context);
  await captured.promise;
  await (await pending).text();
  f.reject(key => key === original);
  assert.equal((await f.send()).status, 200);
  await flushSelections(f.env);
  release.resolve(); await Promise.all(f.pending.splice(0));
  const before = f.calls.length;
  assert.equal((await f.send()).status, 200);
  assert.equal(f.calls.length, before + 1, 'late refresh must not cause another depleted attempt');
  assert.notEqual(f.calls.at(-1), original);
});


for (const creditFirst of [true, false]) test(`credit and weekly-only feedback merge without overwriting either window (creditFirst=${creditFirst})`, () => {
  const now = Date.parse('2030-01-01T00:00:00Z'), quota = providerById('anthropic').quota;
  const credit = observeProviderGrantQuota('anthropic', { status: 400, headers: new Headers() }, quota, 'claude-sonnet-5', now + (creditFirst ? 0 : 1), true);
  const weekly = observeProviderGrantQuota('anthropic', { status: 200, headers: new Headers({
    'anthropic-ratelimit-unified-7d-utilization': '1',
    'anthropic-ratelimit-unified-7d-reset': new Date(now + 3600000).toISOString(),
  }) }, quota, 'claude-sonnet-5', now + (creditFirst ? 1 : 0));
  const merged = mergeGrantRuntimeState(creditFirst ? credit : weekly, creditFirst ? weekly : credit, now + 2);
  assert.deepEqual(merged.windows.map(window => window.id).sort(), ['credit-balance', 'subscription-seven-day']);
  assert.equal(grantQuotaExhausted(merged, 'claude-sonnet-5', 0, true, now + 300002), true);
  assert.equal(grantQuotaExhausted(merged, 'claude-sonnet-5', 0, true, now + 3600001), false);
});
