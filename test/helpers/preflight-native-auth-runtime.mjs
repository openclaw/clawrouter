// Only Cloudflare host primitives are substituted. Exercise the actual
// rehearsal entry, ordinary Worker router, authorization and native pool.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import './typescript-resolver.mjs';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
    'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}; export class WorkerEntrypoint {}') };
  return next(specifier, context);
} });
const { default: handler, LargeHttpPool } = await import('../../worker/native-rehearsal-entry.ts');
hooks.deregister();

export function authenticationRuntime({ origin, worker, selected, hash, enabled = true }) {
  const effects = { poolAccesses: 0, slotAccesses: 0, stateWrites: 0, alarms: 0, nativeStarts: 0, otherBindings: 0 };
  const data = new Map(); let alarm = null, pool;
  const storage = {
    async setAlarm(at) { effects.alarms++; alarm = at; },
    async transaction(fn) { return fn({ get: async key => structuredClone(data.get(key)),
      put: async (key, value) => { effects.stateWrites++; data.set(key, structuredClone(value)); },
      getAlarm: async () => alarm, setAlarm: async at => { effects.alarms++; alarm = at; } }); },
  };
  const forbidden = new Proxy({}, { get() { effects.otherBindings++; throw Error('Unexpected binding access'); } });
  const env = { LARGE_HTTP_ENABLED: enabled ? '1' : '0', LARGE_HTTP_INGRESS_ENABLED: enabled ? '1' : '0',
    LARGE_HTTP_ORIGIN: origin, CLAWROUTER_PUBLIC_ORIGIN: origin, LARGE_HTTP_CAPACITY: '8', LARGE_HTTP_TESTING: '1',
    LARGE_HTTP_TOKEN: 'f'.repeat(64), CLAWROUTER_ADMIN_TOKEN_SHA256: hash, CF_VERSION_METADATA: { id: selected },
    LARGE_HTTP_RUNTIME_SHA: 'e'.repeat(64), LARGE_HTTP_RUNTIME_BYTES: '1000',
    NATIVE_REHEARSAL: JSON.stringify({ schema: 1, worker, origin, createdAt: Date.now() - 3_600_000,
      expiresAt: Date.now() - 1, maxStarts: 40, maxRequests: 64 }),
    NATIVE_REHEARSAL_STATE: forbidden, POLICY_KV: forbidden, CONTENT_ARCHIVE: forbidden,
    ACCESS_CONTROL: forbidden, BUDGET_LEDGER: forbidden, GRANT_CREDENTIALS: forbidden, USAGE_LEDGER: forbidden,
    LARGE_HTTP_SLOTS: { getByName() { effects.slotAccesses++; return { async fetch(input) {
      if (new URL(input).pathname === '/control/prepare') effects.nativeStarts++;
      return Response.json({ schema: 1, generation: 0, phase: 'idle', boot: '', fingerprint: 'b'.repeat(64) });
    } }; } },
    LARGE_HTTP_POOL: { getByName() { effects.poolAccesses++; pool ??= new LargeHttpPool({ storage }, env);
      return { fetch: (input, init) => pool.fetch(new Request(input, init)) }; } },
  };
  const pending = [];
  return { effects, env, storage,
    async fetch(request) {
      const response = await handler.fetch(request, env, { waitUntil: p => pending.push(p) });
      await Promise.all(pending.splice(0)); return response;
    },
    async tick() { assert(pool); await pool.alarm(); },
    assertUntouched() { assert.deepEqual(effects, { poolAccesses: 0, slotAccesses: 0, stateWrites: 0, alarms: 0, nativeStarts: 0, otherBindings: 0 }); assert.equal(data.size, 0); assert.equal(alarm, null); },
  };
}
