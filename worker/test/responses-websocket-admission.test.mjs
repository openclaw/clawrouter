import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKeys } from "./http-continuation-fixture.mjs";
import { putGrantCredentials } from "../grant-credentials.ts";
import { overrideHotCacheConfig, setHotCacheClock } from "../hot-cache.ts";
import { authenticateProxyKey, proxyAdmission } from "../proxy-auth.ts";
import { assertProviderAccess, providerById } from "../providers.ts";
const { concreteOpenAiSelection } = await import("../proxy-selection.ts");
const { prepareSelected } = await import("../proxy.ts");
import { grantRevision } from "../grant-eligibility.ts";
const { proxyResponsesWebSocket } = await import("../responses-websocket.ts");

class Socket extends EventTarget {
  closed = false;
  accept() {}
  send(data) { const event = new Event("message"); event.data = data; queueMicrotask(() => this.peer.dispatchEvent(event)); }
  close() {
    if (this.closed) return;
    this.closed = this.peer.closed = true;
    this.dispatchEvent(new Event("close")); this.peer.dispatchEvent(new Event("close"));
  }
}
function pair() { const a = new Socket(), b = new Socket(); a.peer = b; b.peer = a; return [a, b]; }

async function websocketFixture(t, { cache = "off", budgets = 4 } = {}) {
  overrideHotCacheConfig();
  // Keep warmed entries fresh independently of host load or the injected waits.
  const now = Date.now();
  setHotCacheClock(() => now);
  const NativeResponse = globalThis.Response;
  t.mock.method(globalThis, "Response", class extends NativeResponse {
    constructor(body, init) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) { Object.defineProperty(this, "status", { value: 101 }); this.webSocket = init.webSocket; }
    }
  });
  globalThis.WebSocketPair = function () { return pair(); };
  t.after(() => { delete globalThis.WebSocketPair; });
  const limit = budgets ? 100_000 : null;
  const f = await fixture(t, false, { limit, fixedCost: 7 });
  if (cache === "off") f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = "0";
  for (const [index, key] of grantKeys.entries()) await putGrantCredentials(f.env, key, { provider: "openai", kind: "api_key", enabled: true, credential: `synthetic-key-${index}` });
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, dailyBudgetMicros: budgets === 4 ? limit : null, weeklyBudgetMicros: budgets === 4 ? limit : null } });
  await f.authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: budgets >= 2 ? limit : null });
  const [upstream, provider] = pair(), frames = [], messages = [], pending = [];
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => init?.method === "GET"
    ? new Response(null, { status: 101, webSocket: upstream }) : fetch(url, init));
  provider.addEventListener("message", ({ data }) => {
    const body = JSON.parse(data); frames.push(body); f.onSend?.();
    const response = { id: `ws_${frames.length}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } };
    provider.send(JSON.stringify({ type: "response.created", response }));
    provider.send(JSON.stringify({ type: "response.completed", response }));
  });
  const response = await proxyResponsesWebSocket(new Request("https://router.example/v1/responses", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil: promise => pending.push(promise) }, "/v1/responses");
  const client = response.webSocket;
  client.addEventListener("message", ({ data }) => messages.push(JSON.parse(data)));
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); await f.drain(); };
  const create = async (body = {}) => {
    const before = messages.length;
    client.send(JSON.stringify({ type: "response.create", model: "openai/gpt-5.6-sol", input: "fixture", ...body }));
    for (let i = 0; !messages.slice(before).some(event => ["response.completed", "error"].includes(event.type)); i++) {
      assert.ok(i < 1000, "create timed out");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await drain();
    return messages.at(-1);
  };
  t.after(async () => { client.close(); await drain(); });
  return Object.assign(f, { client, create, frames, messages });
}

for (const cache of ["warm", "off"]) for (const budgets of [0, 1, 2, 4]) {
  test(`warm chained admission: cache ${cache}, ${budgets} budget legs`, async t => {
    const f = await websocketFixture(t, { cache, budgets });
    const first = await f.create();
    assert.equal(first.type, "response.completed", JSON.stringify(first));
    assert.equal(first.response.id, "ws_1");
    const rounds = [], waiting = [];
    let timer, measuring = true;
    const hop = label => {
      if (!measuring) return;
      return new Promise(resolve => {
        waiting.push({ label, resolve });
        timer ??= setTimeout(() => {
          const batch = waiting.splice(0); timer = undefined;
          rounds.push(batch.map(item => item.label).sort());
          for (const item of batch) item.resolve();
        }, 20);
      });
    };
    f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
      const path = new URL(request.url).pathname;
      if (path === "/admission/resolve") await hop("admission");
      if (path === "/grant-pools/select") await hop("select");
      if (path === "/http-continuations" && (await request.clone().json()).action === "resolve") await hop("continuation");
    };
    const get = f.env.POLICY_KV.get.bind(f.env.POLICY_KV);
    f.env.POLICY_KV.get = async key => { if (Array.isArray(key)) await hop("kv"); return get(key); };
    for (const [binding, operation] of [["GRANT_CREDENTIALS", "materialize"], ["BUDGET_LEDGER", "reserve"]]) {
      const namespace = f.env[binding], get = namespace.get.bind(namespace);
      namespace.get = name => {
        const stub = get(name);
        return { ...stub, fetch: async (url, init) => {
          const path = new URL(url).pathname;
          if (path === `/${operation}` || path === "/dispatch") await hop(path.slice(1));
          return stub.fetch(url, init);
        } };
      };
    }
    let elapsed;
    const started = performance.now();
    f.onSend = () => { elapsed = performance.now() - started; measuring = false; };
    assert.equal((await f.create({ previous_response_id: "ws_1" })).response.id, "ws_2");
    const expected = [
      ...(cache === "off" ? [["admission"]] : []),
      ["continuation", "kv"],
      [...Array(budgets).fill("reserve"), "select"],
      ...(cache === "off" ? [["materialize"]] : []),
      ...(budgets ? [Array(budgets).fill("dispatch")] : []),
    ];
    assert.deepEqual(rounds, expected);
    t.diagnostic(`cache ${cache}, ${budgets} budget legs: ${rounds.length} sequential storage rounds; ${Math.round(elapsed)} ms with 20 ms per round`);
  });
}

for (const cache of ["warm", "off"]) test(`pinned preparation reuses the admitted provider connection without I/O: cache ${cache}`, async t => {
  const f = await websocketFixture(t, { cache });
  await f.create();
  const provider = providerById("openai");
  const request = new Request("https://router.example/v1/responses", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "x-request-id": "fixture-connection-check" } });
  const auth = await authenticateProxyKey(request.headers, f.env, [{ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id }]);
  assert.ok(!(auth instanceof Response));
  const admitted = proxyAdmission(auth).connections.find(item => item.providerId === provider.id);
  assert.equal(admitted.monthlyBudgetMicros, 100_000);
  const selection = concreteOpenAiSelection("/v1/responses", { model: "openai/gpt-5.6-sol", input: "fixture" }, f.env);
  // Any extra connection lookup would be a scalar KV read or an authority RPC.
  const get = f.env.POLICY_KV.get.bind(f.env.POLICY_KV);
  f.env.POLICY_KV.get = key => { assert.ok(Array.isArray(key), "no connection KV lookup"); return get(key); };
  f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => assert.equal(new URL(request.url).pathname, "/grant-pools/select");
  const connection = await assertProviderAccess(provider, auth, f.env);
  const key = f.events.at(-1).grant_key;
  const prepared = await prepareSelected(request, f.env, selection, {}, auth, new Set(), true, undefined, { key, revision: grantRevision(f.values.get(key)) }, "websocket");
  assert.equal(connection, admitted);
  assert.equal(prepared.connection, connection);
});

test("a continuation on another grant returns a restart without sending or retaining reservations", async t => {
  const f = await websocketFixture(t);
  await f.create();
  const foreign = JSON.parse(await f.consume(await f.request()));
  const result = await f.create({ previous_response_id: foreign.id });
  assert.equal(result.error.code, "continuation_restart_required");
  assert.equal(result.status, 409);
  assert.equal(f.frames.length, 1);
  assert.equal(f.client.closed, false);
  assertReleased(f);
  assert.equal((await f.create({ previous_response_id: "ws_1" })).response.id, "ws_2");
});

for (const rollbackFails of [false, true]) test(`failed pinned materialization ${rollbackFails ? "cannot hide failed budget rollback" : "releases concurrent reservations before returning an error"}`, async t => {
  const f = await websocketFixture(t);
  await f.create();
  const send = f.env.USAGE_QUEUE.send;
  f.env.USAGE_QUEUE.send = async event => {
    if (rollbackFails && event.kind === "budget_settlement") throw new Error("fixture recovery unavailable");
    return send(event);
  };
  const reserved = Promise.withResolvers(), getBudget = f.env.BUDGET_LEDGER.get.bind(f.env.BUDGET_LEDGER);
  f.env.BUDGET_LEDGER.get = name => {
    const stub = getBudget(name);
    return { ...stub, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (rollbackFails && path === "/settle") throw new Error("fixture ledger unavailable");
      if (rollbackFails && name === "provider:openai" && path === "/reserve") return Response.json({ allowed: false });
      const response = await stub.fetch(url, init);
      if (path === "/reserve") reserved.resolve();
      return response;
    } };
  };
  const getGrant = f.env.GRANT_CREDENTIALS.get.bind(f.env.GRANT_CREDENTIALS);
  f.env.GRANT_CREDENTIALS.get = name => ({ fetch: async (url, init) => {
    if (new URL(url).pathname !== "/materialize") return getGrant(name).fetch(url, init);
    await reserved.promise;
    return Response.json({ error: { code: "grant_disabled", message: "fixture disabled" } }, { status: 403 });
  } });
  assert.equal((await f.create({ previous_response_id: "ws_1" })).error.code, rollbackFails ? "accounting_unavailable" : "continuation_restart_required");
  assert.equal(f.frames.length, 1);
  if (rollbackFails) assert.equal(f.client.closed, true); else assertReleased(f);
  assert.equal(f.events.at(-1).actual_cost_micros, 0);
  assert.equal(f.events.at(-1).cost_basis, "none");
});

function assertReleased(f) {
  for (const name of ["default:fixture", "provider:openai"]) {
    const rows = f.env.BUDGET_LEDGER.get(name).reservations();
    assert.ok(rows.length >= 2);
    assert.ok(rows.every(row => row.settled === 1));
    assert.ok(rows.filter(row => row.reserved_micros === 0).length >= 1);
  }
}
