// Run directly, so --cpu-prof captures the handler rather than a test-runner child.
// HTTP_CPU_OUT=/absolute/proof/dir node --cpu-prof --cpu-prof-dir=/absolute/proof/dir test/diagnostics/http-responses-cpu.test.mjs
import '../../worker/test/typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Session } from 'node:inspector';
import { promisify } from 'node:util';
import { usageEnv, proxyKey } from '../../worker/test/usage-budget-fixture.mjs';
import { createGrantAuthority } from '../../worker/test/grant-authority-fixture.mjs';
import { authorityCall } from '../../worker/authority.ts';
import { sha256Hex } from '../../worker/utils.ts';
import { clearHotCaches, pendingBackgroundWork, setHotCacheClock } from '../../worker/hot-cache.ts';
const { default: handler } = await import('../../worker/index.ts');

const encoder = new TextEncoder();
const model = 'gpt-5.6';
const repetitions = Number(process.env.HTTP_CPU_RUNS ?? 30);
const warmups = Number(process.env.HTTP_CPU_WARMUPS ?? 30);
const sizes = (process.env.HTTP_CPU_SIZES ?? '0.5,2,5').split(',').map(Number);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
assert.ok(Number.isSafeInteger(warmups) && warmups > 0);
assert.ok(sizes.every(size => size > 0 && size <= 5));
const out = process.env.HTTP_CPU_OUT && resolve(process.env.HTTP_CPU_OUT);

function codexBody(size, native) {
  const input = [], text = 'Synthetic repository context: café 🦊. Inspect code, preserve behavior.\n'.repeat(45);
  const group = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'c3ludGhldGlj'.repeat(150) },
    { type: 'function_call', call_id: 'call_fixture', name: 'exec_command', arguments: JSON.stringify({ cmd: 'read synthetic source' }) },
    { type: 'function_call_output', call_id: 'call_fixture', output: text },
  ];
  const body = { model: native ? model : `openai/${model}`, stream: true, max_output_tokens: 4096,
    instructions: 'Use only synthetic fixtures.', tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }], input };
  const target = Math.round(size * 1024 * 1024), groupBytes = encoder.encode(JSON.stringify(group)).length;
  for (let n = 0; n < Math.floor((target - 1024) / groupBytes); n++) input.push(...group);
  const remaining = target - encoder.encode(JSON.stringify(body)).length - 60;
  if (remaining > 0) input.push({ role: 'user', content: 'x'.repeat(remaining) });
  return JSON.stringify(body);
}

function upstreamChunks() {
  const frame = value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
  const delta = 'Synthetic output with Unicode 🦊 and escaped syntax "\\\n'.repeat(10);
  const output = [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: delta.repeat(600), annotations: [] }] }];
  let wire = frame({ type: 'response.created', response: { id: 'resp_cpu_fixture', object: 'response', status: 'in_progress', output: [] } });
  wire += frame({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } });
  for (let n = 0; n < 600; n++) wire += frame({ type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, sequence_number: n, delta });
  wire += frame({ type: 'response.output_item.done', output_index: 0, item: output[0] });
  wire += frame({ type: 'response.completed', response: { id: 'resp_cpu_fixture', object: 'response', status: 'completed', output,
    usage: { input_tokens: 123456, output_tokens: 4096, total_tokens: 127552, input_tokens_details: { cached_tokens: 100000 } } } });
  const bytes = encoder.encode(wire), chunks = [];
  // Deliberately cross UTF-8, JSON escape and CRLF boundaries.
  for (let n = 0; n < bytes.length; n += 4093) chunks.push(bytes.subarray(n, n + 4093));
  return { chunks, bytes: bytes.length };
}

test('diagnostic: warm HTTP Responses CPU (synthetic only)', async t => {
  if (out) await mkdir(out, { recursive: true });
  const upstream = upstreamChunks(), results = [];
  for (const native of [false, true]) for (const size of sizes) for (const retention of [false, true]) {
    if (retention && size !== sizes.at(-1)) continue;
    clearHotCaches();
    // CPU profiling is a warm-isolate experiment; wall scheduling must not
    // turn a long cell into an admission-refresh experiment halfway through.
    const cacheTime = Date.now(); setHotCacheClock(() => cacheTime);
    const body = codexBody(size, native), pending = [], events = [], backend = [];
    let archiveWrites = 0, dispatched = false;
    const env = usageEnv([], { budgetMode: 'soft', fixedCost: null, retainContent: retention, limit: 1e12 });
    env.OPENAI_API_KEY = 'synthetic-profile-key';
    env.BUDGET_LEDGER = { idFromName: name => name, get: () => ({ fetch: async (url, init) =>
      Response.json(new URL(url).pathname === '/status' ? { spentMicros: 0, remainingMicros: 1e12 } : { charged: true, chargeId: JSON.parse(init.body).chargeId }) }) };
    env.USAGE_QUEUE = { send: async event => { events.push(event); } };
    env.CONTENT_ARCHIVE = { put: async (_key, bytes) => { assert.equal(typeof bytes, 'string'); archiveWrites++; } };
    const authority = createGrantAuthority(undefined, env);
    env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch: authority.fetch }) };
    await authorityCall(env, '/policies/initialize-all', [{ policyId: 'maintainer_access', policy: {
      enabled: true, generation: 'policy_v1', providers: ['openai'], tenantId: 'tenant', monthlyBudgetMicros: 1e12,
      budgetMode: 'soft', retainRequestContent: retention,
    } }]);
    await authorityCall(env, '/credentials/initialize-all', [{ credentialId: 'maintainer_key', credential: {
      enabled: true, secretSha256: await sha256Hex('abcdefgh'), policyId: 'maintainer_access', policyGeneration: 'policy_v1', principalId: 'owner@example.com',
    } }]);
    await authorityCall(env, '/users/initialize-all', [{ email: 'owner@example.com', record: { enabled: true } }]);
    await authorityCall(env, '/connections/initialize-all', [{ providerId: 'openai', enabled: true, monthlyBudgetMicros: 1e12 }]);
    const get = env.ACCESS_CONTROL.get;
    env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname; backend.push({ path, dispatched });
      if (path === '/http-continuations') {
        const { action } = JSON.parse(init.body);
        return Response.json(action === 'register' ? { outcome: 'stored', claim: 'owned' } : { outcome: 'qualified' });
      }
      return get(name).fetch(url, init);
    } });
    let kvReads = 0;
    env.POLICY_KV.get = async keys => { kvReads++; return Array.isArray(keys) ? new Map() : null; };
    t.mock.method(globalThis, 'fetch', async () => {
      dispatched = true;
      let index = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (index < upstream.chunks.length) controller.enqueue(upstream.chunks[index++]);
        else controller.close();
      } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    });
    // Optional audit pass only: leave JSON builtins untouched for CPU timings.
    const largeJson = { parse: 0, stringify: 0 };
    if (process.env.HTTP_CPU_COUNT_JSON === '1') {
      const parse = JSON.parse, stringify = JSON.stringify;
      t.mock.method(JSON, 'parse', function (text, ...args) {
        if (typeof text === 'string' && text.length > 100_000) largeJson.parse++;
        return parse.call(this, text, ...args);
      });
      t.mock.method(JSON, 'stringify', function (...args) {
        const text = stringify.apply(this, args);
        if (text?.length > 100_000) largeJson.stringify++;
        return text;
      });
    }
    const context = { waitUntil(promise) { pending.push(promise); } };
    async function invoke() {
      dispatched = false;
      const request = new Request(`https://fixture${native ? '/v1/native/openai' : ''}/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${proxyKey()}`, 'content-type': 'application/json' }, body,
      });
      const start = process.cpuUsage();
      const response = await handler.fetch(request, env, context);
      const headersCpu = process.cpuUsage(start);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      let delivered = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; delivered += next.value.byteLength; }
      while (pending.length) await Promise.all(pending.splice(0));
      await pendingBackgroundWork();
      const cpu = process.cpuUsage(start);
      assert.equal(delivered, upstream.bytes);
      assert.equal(events.at(-1)?.input_tokens, 123456);
      assert.equal(events.at(-1)?.output_tokens, 4096);
      assert.equal(events.at(-1)?.status, 'success');
      return { cpuMs: (cpu.user + cpu.system) / 1000, headersCpuMs: (headersCpu.user + headersCpu.system) / 1000,
        warm: /cr-cache;desc=hit/.test(response.headers.get('server-timing')) };
    }
    for (let n = 0; n < warmups; n++) await invoke();
    backend.length = 0; kvReads = 0; largeJson.parse = 0; largeJson.stringify = 0;
    const label = `${native ? 'native' : 'unified'}-${size}MiB-retention-${retention ? 'on' : 'off'}`;
    let session, post;
    if (out && process.env.HTTP_CPU_PROFILE === '1') {
      session = new Session(); session.connect(); post = promisify(session.post).bind(session);
      await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 }); await post('Profiler.start');
    }
    const samples = [];
    for (let n = 0; n < repetitions; n++) samples.push(await invoke());
    if (session) {
      const { profile } = await post('Profiler.stop'); session.disconnect();
      await writeFile(resolve(out, `${label}.cpuprofile`), JSON.stringify(profile));
    }
    assert.ok(samples.every(sample => sample.warm), 'measured requests must hit the warm admission cache');
    assert.equal(backend.filter(call => !call.dispatched).length, 0, 'zero foreground authority calls');
    assert.equal(kvReads, 0, 'zero warm KV reads');
    assert.equal(archiveWrites, retention ? repetitions + warmups : 0);
    assert.equal(events.length, repetitions + warmups, 'one accounting event per invocation');
    const mean = key => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
    const result = { label, requestBytes: encoder.encode(body).length, responseBytes: upstream.bytes, repetitions,
      cpuMs: mean('cpuMs'), headersCpuMs: mean('headersCpuMs'), samples,
      ...(process.env.HTTP_CPU_COUNT_JSON === '1' ? { largeJsonPerRequest: { parse: largeJson.parse / repetitions, stringify: largeJson.stringify / repetitions } } : {}) };
    results.push(result); console.log(JSON.stringify({ ...result, samples: undefined }));
    t.mock.restoreAll();
    setHotCacheClock();
  }
  if (out) await writeFile(resolve(out, 'results.json'), JSON.stringify({ node: process.version, warmups, results }, null, 2));
});
