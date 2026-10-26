// Native Anthropic messages variant of http-responses-cpu (synthetic only).
// Run directly, so --cpu-prof captures the handler rather than a test-runner child.
// HTTP_CPU_OUT=/absolute/proof/dir node test/diagnostics/http-anthropic-cpu.test.mjs
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
const model = 'claude-sonnet-5-5';
const repetitions = Number(process.env.HTTP_CPU_RUNS ?? 30);
const warmups = Number(process.env.HTTP_CPU_WARMUPS ?? 30);
const sizes = (process.env.HTTP_CPU_SIZES ?? '0.75,2').split(',').map(Number);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
assert.ok(Number.isSafeInteger(warmups) && warmups > 0);
assert.ok(sizes.every(size => size > 0 && size <= 5));
const out = process.env.HTTP_CPU_OUT && resolve(process.env.HTTP_CPU_OUT);

function claudeBody(size) {
  const text = 'Synthetic repository context: café 🦊. Inspect code, preserve behavior.\n'.repeat(45);
  const messages = [];
  const tools = Array.from({ length: 12 }, (_, n) => ({ name: `tool_${n}`, description: text.slice(0, 600), input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } }));
  const body = { model, max_tokens: 4096, stream: true, system: [{ type: 'text', text: 'Use only synthetic fixtures.' }, { type: 'text', text, cache_control: { type: 'ephemeral' } }], tools, messages };
  const turn = n => [
    { role: 'user', content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: text.slice(0, 400), signature: 'c3ludGhldGlj'.repeat(40) }, { type: 'tool_use', id: `toolu_${n}`, name: 'tool_1', input: { path: 'src/fixture.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: text }] },
  ];
  const target = Math.round(size * 1024 * 1024);
  for (let n = 0; encoder.encode(JSON.stringify(body)).length < target; n++) messages.push(...turn(n));
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.', cache_control: { type: 'ephemeral' } }] });
  return JSON.stringify(body);
}

function upstreamChunks() {
  const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  let wire = frame({ type: 'message_start', message: { id: 'msg_cpu_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1234, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  wire += frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (let n = 0; n < 2000; n++) wire += frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${n % 7} ` } });
  wire += frame({ type: 'content_block_stop', index: 0 });
  wire += frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2000 } });
  wire += frame({ type: 'message_stop' });
  const bytes = encoder.encode(wire), chunks = [];
  for (let n = 0; n < bytes.length; n += 1400) chunks.push(bytes.subarray(n, n + 1400));
  return { chunks, bytes: bytes.length };
}

test('diagnostic: warm native Anthropic messages CPU (synthetic only)', async t => {
  if (out) await mkdir(out, { recursive: true });
  const upstream = upstreamChunks(), results = [];
  for (const size of sizes) for (const retention of [false, true]) {
    if (retention && size !== sizes.at(-1)) continue;
    clearHotCaches();
    // CPU profiling is a warm-isolate experiment; wall scheduling must not
    // turn a long cell into an admission-refresh experiment halfway through.
    const cacheTime = Date.now(); setHotCacheClock(() => cacheTime);
    const body = claudeBody(size), pending = [], events = [], backend = [];
    let archiveWrites = 0, dispatched = false;
    const env = usageEnv([], { budgetMode: 'soft', fixedCost: null, retainContent: retention, limit: 1e12 });
    env.ANTHROPIC_API_KEY = 'synthetic-profile-key';
    env.BUDGET_LEDGER = { idFromName: name => name, get: () => ({ fetch: async (url, init) =>
      Response.json(new URL(url).pathname === '/status' ? { spentMicros: 0, remainingMicros: 1e12 } : { charged: true, chargeId: JSON.parse(init.body).chargeId }) }) };
    env.USAGE_QUEUE = { send: async event => { events.push(event); } };
    env.CONTENT_ARCHIVE = { put: async (_key, bytes) => { assert.equal(typeof bytes, 'string'); archiveWrites++; } };
    const authority = createGrantAuthority(undefined, env);
    env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch: authority.fetch }) };
    await authorityCall(env, '/policies/initialize-all', [{ policyId: 'maintainer_access', policy: {
      enabled: true, generation: 'policy_v1', providers: ['anthropic'], tenantId: 'tenant', monthlyBudgetMicros: 1e12,
      budgetMode: 'soft', retainRequestContent: retention,
    } }]);
    await authorityCall(env, '/credentials/initialize-all', [{ credentialId: 'maintainer_key', credential: {
      enabled: true, secretSha256: await sha256Hex('abcdefgh'), policyId: 'maintainer_access', policyGeneration: 'policy_v1', principalId: 'owner@example.com',
    } }]);
    await authorityCall(env, '/users/initialize-all', [{ email: 'owner@example.com', record: { enabled: true } }]);
    await authorityCall(env, '/connections/initialize-all', [{ providerId: 'anthropic', enabled: true, monthlyBudgetMicros: 1e12 }]);
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
      const request = new Request('https://fixture/v1/native/anthropic/v1/messages', {
        method: 'POST', headers: { authorization: `Bearer ${proxyKey()}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body,
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
      assert.ok(events.at(-1)?.input_tokens > 0, JSON.stringify(events.at(-1)));
      assert.equal(events.at(-1)?.output_tokens, 2000);
      assert.equal(events.at(-1)?.status, 'success');
      return { cpuMs: (cpu.user + cpu.system) / 1000, headersCpuMs: (headersCpu.user + headersCpu.system) / 1000,
        warm: /cr-cache;desc=hit/.test(response.headers.get('server-timing')) };
    }
    for (let n = 0; n < warmups; n++) await invoke();
    backend.length = 0; kvReads = 0; largeJson.parse = 0; largeJson.stringify = 0;
    const label = `anthropic-${size}MiB-retention-${retention ? 'on' : 'off'}`;
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
