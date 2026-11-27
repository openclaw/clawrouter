// Peak isolate memory for image-heavy turns (synthetic only).
// node --expose-gc test/diagnostics/http-image-memory.test.mjs
// IMAGE_PROVIDERS=openai,anthropic IMAGE_COUNT=20 IMAGE_KIB=1024 IMAGE_CONCURRENCY=1 IMAGE_RETENTION=0
import '../../worker/test/typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { usageEnv, proxyKey } from '../../worker/test/usage-budget-fixture.mjs';
import { createGrantAuthority } from '../../worker/test/grant-authority-fixture.mjs';
import { authorityCall } from '../../worker/authority.ts';
import { sha256Hex } from '../../worker/utils.ts';
import { pendingBackgroundWork } from '../../worker/hot-cache.ts';
const { default: handler } = await import('../../worker/index.ts');

const providers = (process.env.IMAGE_PROVIDERS ?? 'openai,anthropic').split(',');
const count = Number(process.env.IMAGE_COUNT ?? 20), kib = Number(process.env.IMAGE_KIB ?? 1024);
const concurrency = Number(process.env.IMAGE_CONCURRENCY ?? 1), retention = process.env.IMAGE_RETENTION === '1';
const encoder = new TextEncoder();

// A decodable PNG header (IHDR then IDAT) padded to the requested size.
function png(index, bytes) {
  const buffer = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(1568, 16); buffer.writeUInt32BE(980, 20); buffer[24] = 8; buffer[25] = 6;
  buffer.writeUInt32BE(bytes - 57, 33); buffer.write('IDAT', 37, 'latin1');
  for (let offset = 41; offset < bytes - 16; offset += 4) buffer.writeUInt32LE((index * 2654435761 + offset * 40503) >>> 0, offset);
  buffer.writeUInt32BE(0, bytes - 12); buffer.write('IEND', bytes - 8, 'latin1');
  return buffer.toString('base64');
}

function body(provider) {
  const images = Array.from({ length: count }, (_, index) => png(index, kib * 1024));
  const text = 'Compare these synthetic screenshots.';
  if (provider === 'openai') return { path: '/v1/native/openai/v1/responses', json: { model: 'gpt-5.6', stream: true, max_output_tokens: 512,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }, ...images.map(data => ({ type: 'input_image', image_url: `data:image/png;base64,${data}`, detail: 'auto' }))] }] } };
  return { path: '/v1/native/anthropic/v1/messages', json: { model: 'claude-sonnet-5-5', stream: true, max_tokens: 512,
    messages: [{ role: 'user', content: [...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })), { type: 'text', text }] }] } };
}

function upstream(provider) {
  const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  if (provider === 'openai') return frame({ type: 'response.created', response: { id: 'resp_image_fixture', object: 'response', status: 'in_progress', output: [] } })
    + frame({ type: 'response.completed', response: { id: 'resp_image_fixture', object: 'response', status: 'completed', output: [], usage: { input_tokens: 40000, output_tokens: 10, total_tokens: 40010 } } });
  return frame({ type: 'message_start', message: { id: 'msg_image_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 40000, output_tokens: 1 } } })
    + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }) + frame({ type: 'message_stop' });
}

const used = () => { const { heapUsed, external } = process.memoryUsage(); return heapUsed + external; };
const mib = bytes => Math.round(bytes / 1048576 * 10) / 10;

for (const provider of providers) test(`diagnostic: ${provider} ${count}×${kib} KiB images, concurrency ${concurrency}, retention ${retention ? 'on' : 'off'}`, async t => {
  const env = usageEnv([], { budgetMode: 'soft', fixedCost: null, retainContent: retention, limit: 1e12 });
  env.OPENAI_API_KEY = env.ANTHROPIC_API_KEY = 'synthetic-profile-key';
  env.BUDGET_LEDGER = { idFromName: name => name, get: () => ({ fetch: async (url, init) =>
    Response.json(new URL(url).pathname === '/status' ? { spentMicros: 0, remainingMicros: 1e12 } : { charged: true, chargeId: JSON.parse(init.body).chargeId }) }) };
  const events = [];
  env.USAGE_QUEUE = { send: async event => { events.push(event); } };
  let archived = 0;
  env.CONTENT_ARCHIVE = { put: async (_key, value) => {
    if (typeof value === 'string') archived += value.length;
    else for await (const chunk of value) archived += chunk.byteLength;
  } };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch: authority.fetch }) };
  await authorityCall(env, '/policies/initialize-all', [{ policyId: 'maintainer_access', policy: {
    enabled: true, generation: 'policy_v1', providers: [provider], tenantId: 'tenant', monthlyBudgetMicros: 1e12, budgetMode: 'soft', retainRequestContent: retention,
  } }]);
  await authorityCall(env, '/credentials/initialize-all', [{ credentialId: 'maintainer_key', credential: {
    enabled: true, secretSha256: await sha256Hex('abcdefgh'), policyId: 'maintainer_access', policyGeneration: 'policy_v1', principalId: 'owner@example.com',
  } }]);
  await authorityCall(env, '/users/initialize-all', [{ email: 'owner@example.com', record: { enabled: true } }]);
  await authorityCall(env, '/connections/initialize-all', [{ providerId: provider, enabled: true, monthlyBudgetMicros: 1e12 }]);
  const get = env.ACCESS_CONTROL.get;
  env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => {
    if (new URL(url).pathname === '/http-continuations') {
      const { action } = JSON.parse(init.body);
      return Response.json(action === 'register' ? { outcome: 'stored', claim: 'owned' } : { outcome: 'qualified' });
    }
    return get(name).fetch(url, init);
  } });
  const sent = [], live = { dispatch: -Infinity, upload: -Infinity };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, { ...init, duplex: 'half' });
    global.gc?.(); live.dispatch = Math.max(live.dispatch, used());
    if (process.env.IMAGE_HEAP_SNAPSHOT) (await import('node:v8')).writeHeapSnapshot(process.env.IMAGE_HEAP_SNAPSHOT);
    let bytes = 0, gcAt = 8 << 20;
    if (request.body) for await (const chunk of request.body) {
      bytes += chunk.byteLength;
      if (bytes >= gcAt) { gcAt += 8 << 20; global.gc?.(); live.upload = Math.max(live.upload, used()); }
    }
    sent.push(bytes);
    return new Response(upstream(provider), { headers: { 'content-type': 'text/event-stream' } });
  });
  // The client's bytes live outside the isolate in production; allocate them
  // before the baseline (as Buffer, outside the JS heap) and stream views so
  // only Worker-held memory counts. No fixture string may outlive this line.
  const { path, wire } = (({ path, json }) => ({ path, wire: Buffer.from(JSON.stringify(json)) }))(body(provider));
  const request = () => new Request(`https://fixture${path}`, { method: 'POST', duplex: 'half',
    headers: { authorization: `Bearer ${proxyKey()}`, 'content-type': 'application/json', 'content-length': String(wire.length) },
    body: new ReadableStream({ start(controller) { for (let offset = 0; offset < wire.length; offset += 65536) controller.enqueue(wire.subarray(offset, offset + 65536)); controller.close(); } }) });
  const pending = [], context = { waitUntil(promise) { pending.push(promise); } };
  global.gc?.(); global.gc?.();
  const baseline = used();
  if (process.env.IMAGE_BASELINE) console.log(JSON.stringify({ baselineHeapMiB: mib(process.memoryUsage().heapUsed) }));
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, used()); }, 1);
  const results = await Promise.all(Array.from({ length: concurrency }, async () => {
    const response = await handler.fetch(request(), env, context);
    peak = Math.max(peak, used());
    const text = await response.text();
    return { status: response.status, error: response.status === 200 ? undefined : text.slice(0, 200) };
  }));
  while (pending.length) await Promise.all(pending.splice(0));
  await pendingBackgroundWork();
  peak = Math.max(peak, used());
  clearInterval(sampler);
  const result = { provider, images: count, imageKiB: kib, requestMiB: mib(wire.length), concurrency, retention,
    statuses: results.map(item => item.status), error: results.find(item => item.error)?.error,
    upstreamMiB: sent.map(mib), archivedMiB: mib(archived), liveAtDispatchMiB: mib(live.dispatch - baseline), liveDuringUploadMiB: mib(live.upload - baseline), peakDeltaMiB: mib(peak - baseline), peakPerRequestMiB: mib((peak - baseline) / concurrency),
    amplification: Math.round((peak - baseline) / concurrency / wire.length * 100) / 100 };
  console.log(JSON.stringify(result));
  assert.ok(result.statuses.length === concurrency);
});
