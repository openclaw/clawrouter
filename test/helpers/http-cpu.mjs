import '../../worker/test/typescript-setup.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Session } from 'node:inspector';
import { promisify } from 'node:util';
import { usageEnv, proxyKey } from '../../worker/test/usage-budget-fixture.mjs';
import { createGrantAuthority } from '../../worker/test/grant-authority-fixture.mjs';
import { authorityCall } from '../../worker/authority.ts';
import { sha256Hex } from '../../worker/utils.ts';
import { clearHotCaches, pendingBackgroundWork, setHotCacheClock } from '../../worker/hot-cache.ts';
const { default: handler } = await import('../../worker/index.ts');

export async function consumeCpuArchive(body) {
  if (typeof body === 'string') return;
  const reader = body.getReader(), cleanup = [];
  let bytes = 0, hasPrimary = false, primary;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      assert.ok(next.value instanceof Uint8Array);
      assert.ok(next.value.buffer.byteLength <= 32768, 'bounded original archive backing');
      bytes += next.value.byteLength;
      assert.ok(bytes <= 8 * 1024 * 1024 + 65536, 'complete admitted archive bytes');
    }
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    try { await reader.cancel(); } catch (error) { cleanup.push(error); }
    try { reader.releaseLock(); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError(hasPrimary ? [primary, ...cleanup] : cleanup, 'CPU archive cleanup failed');
  if (hasPrimary) throw primary;
}

export async function runHttpCpuCase(t, { provider, credentialBinding, createBody, path, headers = {}, upstream, repetitions, warmups, retention, label, out, assertUsage }) {
  clearHotCaches();
  // Freeze cache age so scheduling cannot turn CPU samples into refresh tests.
  const cacheTime = Date.now(); setHotCacheClock(() => cacheTime);
  let session;
  try {
    const body = createBody(), pending = [], events = [], backend = [];
    let archiveWrites = 0, dispatched = false;
    const env = usageEnv([], { budgetMode: 'soft', fixedCost: null, retainContent: retention, limit: 1e12 });
    env[credentialBinding] = 'synthetic-profile-key';
    env.BUDGET_LEDGER = { idFromName: name => name, get: () => ({ fetch: async (url, init) =>
      Response.json(new URL(url).pathname === '/status' ? { spentMicros: 0, remainingMicros: 1e12 } : { charged: true, chargeId: JSON.parse(init.body).chargeId }) }) };
    env.USAGE_QUEUE = { send: async event => { events.push(event); } };
    env.CONTENT_ARCHIVE = { put: async (_key, body) => { await consumeCpuArchive(body); archiveWrites++; } };
    const authority = createGrantAuthority(undefined, env);
    env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch: authority.fetch }) };
    await authorityCall(env, '/policies/initialize-all', [{ policyId: 'maintainer_access', policy: {
      enabled: true, generation: 'policy_v1', providers: [provider], tenantId: 'tenant', monthlyBudgetMicros: 1e12,
      budgetMode: 'soft', retainRequestContent: retention,
    } }]);
    await authorityCall(env, '/credentials/initialize-all', [{ credentialId: 'maintainer_key', credential: {
      enabled: true, secretSha256: await sha256Hex('abcdefgh'), policyId: 'maintainer_access', policyGeneration: 'policy_v1', principalId: 'owner@example.com',
    } }]);
    await authorityCall(env, '/users/initialize-all', [{ email: 'owner@example.com', record: { enabled: true } }]);
    await authorityCall(env, '/connections/initialize-all', [{ providerId: provider, enabled: true, monthlyBudgetMicros: 1e12 }]);
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
    // Leave JSON builtins untouched for CPU timings unless explicitly auditing.
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
      const request = new Request(`https://fixture${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${proxyKey()}`, 'content-type': 'application/json', ...headers }, body,
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
      assertUsage(events.at(-1));
      assert.equal(events.at(-1)?.status, 'success');
      return { cpuMs: (cpu.user + cpu.system) / 1000, headersCpuMs: (headersCpu.user + headersCpu.system) / 1000,
        warm: /cr-cache;desc=hit/.test(response.headers.get('server-timing')) };
    }
    for (let n = 0; n < warmups; n++) await invoke();
    backend.length = 0; kvReads = 0; largeJson.parse = 0; largeJson.stringify = 0;
    let post;
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
    // Zero warmups intentionally includes one cold admission sample.
    assert.ok(samples.slice(warmups ? 0 : 1).every(sample => sample.warm), 'measured requests must hit the warm admission cache');
    if (warmups) {
      assert.equal(backend.filter(call => !call.dispatched).length, 0, 'zero foreground authority calls');
      assert.equal(kvReads, 0, 'zero warm KV reads');
    }
    assert.equal(archiveWrites, retention ? repetitions + warmups : 0);
    assert.equal(events.length, repetitions + warmups, 'one accounting event per invocation');
    const mean = key => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
    return { label, requestBytes: new TextEncoder().encode(body).length, responseBytes: upstream.bytes, repetitions,
      cpuMs: mean('cpuMs'), headersCpuMs: mean('headersCpuMs'), samples,
      ...(process.env.HTTP_CPU_COUNT_JSON === '1' ? { largeJsonPerRequest: { parse: largeJson.parse / repetitions, stringify: largeJson.stringify / repetitions } } : {}) };
  } finally {
    session?.disconnect();
    t.mock.restoreAll();
    setHotCacheClock();
  }
}
