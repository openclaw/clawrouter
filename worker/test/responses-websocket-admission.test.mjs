import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKeys } from "./http-continuation-fixture.mjs";
import { putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { overrideHotCacheConfig, pendingBackgroundWork, setHotCacheClock } from "../hot-cache.ts";
import { invalidateAdmissions } from "../admission-cache.ts";
import { sha256Hex } from "../utils.ts";
import { authenticateProxyKey, proxyAdmission, proxySessionHash } from "../proxy-auth.ts";
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

async function websocketFixture(t, { cache = "off", budgets = 4, budgetMode = "reserve", limit = budgets ? 100_000 : null, fixedCost = 7, retain = false, path = "/v1/responses" } = {}) {
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
  const f = await fixture(t, false, { limit, fixedCost });
  if (cache === "off") f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = "0";
  for (const [index, key] of grantKeys.entries()) await putGrantCredentials(f.env, key, { provider: "openai", kind: "api_key", enabled: true, credential: `synthetic-key-${index}` });
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, budgetMode, retainRequestContent: retain, limitHint: "Use the team policy.", dailyBudgetMicros: budgets === 4 ? limit : null, weeklyBudgetMicros: budgets === 4 ? limit : null } });
  await f.authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: budgets >= 2 ? limit : null });
  const [upstream, provider] = pair(), frames = [], messages = [], pending = [];
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => init?.method === "GET"
    ? new Response(null, { status: 101, webSocket: upstream }) : fetch(url, init));
  provider.addEventListener("message", ({ data }) => {
    const body = JSON.parse(data); frames.push(body); f.onSend?.();
    const response = { id: `ws_${frames.length}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } };
    if (f.onFrame?.(body, response) === false) return;
    provider.send(JSON.stringify({ type: "response.created", response }));
    provider.send(JSON.stringify({ type: "response.completed", response }));
  });
  const response = await proxyResponsesWebSocket(new Request(`https://router.example${path}`, { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "x-request-id": "fixture-upgrade", "session-id": "fixture-session" } }), f.env, { waitUntil: promise => pending.push(promise) }, path);
  const client = response.webSocket;
  client.addEventListener("message", ({ data }) => messages.push(JSON.parse(data)));
  const drainHttp = f.drain;
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); await drainHttp(); await pendingBackgroundWork(); };
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
  return Object.assign(f, { client, create, frames, messages, provider, drain });
}

test("created reaches the client while its binding write is held", async t => {
  const f = await websocketFixture(t, { cache: "warm", budgetMode: "soft", budgets: 0 });
  const gate = Promise.withResolvers(), writing = Promise.withResolvers(), created = Promise.withResolvers();
  t.after(() => gate.resolve());
  let committed = false;
  f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
    if (new URL(request.url).pathname === "/http-continuations" && (await request.clone().json()).action === "register") {
      writing.resolve(); await gate.promise; committed = true;
    }
  };
  f.client.addEventListener("message", ({ data }) => { if (JSON.parse(data).type === "response.created") created.resolve(); });
  const turn = f.create();
  await Promise.all([writing.promise, created.promise]);
  assert.equal(committed, false);
  assert.deepEqual(f.messages.map(frame => frame.type), ["response.created"]);
  assert.equal(f.events.length, 0);
  gate.resolve();
  assert.equal((await turn).type, "response.completed");
  assert.equal(committed, true);
});

for (const native of [false, true]) for (const revoked of [false, true]) test(`${native ? "native create with unsupported model" : "unified create with unknown model"} returns ${revoked ? "revoked-key authentication error" : "selection error for a valid key"}`, async t => {
  const f = await websocketFixture(t, { cache: "warm", budgets: 0, path: native ? "/v1/native/openai/v1/responses" : "/v1/responses" });
  assert.equal((await f.create()).type, "response.completed");
  if (revoked) {
    await f.mutateCredential({ operation: "revoke", credentialId: "fixture" });
    invalidateAdmissions();
  }
  const result = await f.create({ model: native ? "openai/omni-moderation-latest" : "unknown-model" });
  assert.equal(result.type, "error");
  assert.equal(result.status, revoked ? 403 : native ? 400 : 404);
  assert.equal(result.error.code, revoked ? "proxy_key_revoked" : native ? "model_capability_unsupported" : "model_not_found");
  assert.equal(f.frames.length, 1);
  assert.equal(f.client.closed, false);
});

for (const cache of ["warm", "off"]) for (const budgetMode of ["reserve", "soft"]) for (const budgets of [0, 1, 2, 4]) {
  test(`warm chained admission: cache ${cache}, ${budgetMode}, ${budgets} budget legs`, async t => {
    const f = await websocketFixture(t, { cache, budgets, budgetMode });
    const first = await f.create();
    assert.equal(first.type, "response.completed", JSON.stringify(first));
    assert.equal(first.response.id, "ws_1");
    const expected = [
      ...(cache === "off" ? [["admission"]] : []),
      ...(cache === "off" ? [["materialize"]] : []),
      ...(budgetMode === "reserve" && budgets ? [Array(budgets).fill("reserve-dispatched")] : []),
    ];
    const rounds = [], waiting = [];
    let measuring = true, problem = null, watchdog;
    const flush = () => {
      clearTimeout(watchdog);
      const batch = waiting.splice(0);
      rounds.push(batch.map(item => item.label).sort());
      for (const item of batch) item.resolve();
    };
    // Causal, not wall-clock: a round is released only once exactly its expected
    // hops are all waiting, so concurrency is proven independent of host speed.
    // A serialized hop never completes its round; an unexpected one fails fast.
    const hop = label => {
      if (!measuring) return;
      return new Promise(resolve => {
        waiting.push({ label, resolve });
        if (problem) return flush();
        const want = expected[rounds.length] ?? [], labels = waiting.map(item => item.label).sort();
        const left = [...want];
        if (!labels.every(item => { const at = left.indexOf(item); return at >= 0 && left.splice(at, 1); })) {
          problem = `round ${rounds.length + 1}: waiting [${labels}], expected [${want}]`;
          return flush();
        }
        clearTimeout(watchdog);
        if (!left.length) return flush();
        watchdog = setTimeout(() => { problem = `round ${rounds.length + 1} stalled: waiting [${labels}], expected [${want}]`; flush(); }, 2_000);
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
          if (path === "/reserve") {
            assert.equal(JSON.parse(init.body).dispatched, true);
            await hop("reserve-dispatched");
          } else if (path === `/${operation}` || path === "/dispatch") await hop(path.slice(1));
          return stub.fetch(url, init);
        } };
      };
    }
    f.onSend = () => { measuring = false; };
    assert.equal((await f.create({ previous_response_id: "ws_1" })).response.id, "ws_2");
    clearTimeout(watchdog);
    assert.equal(problem, null);
    assert.deepEqual(rounds, expected);
    assert.equal(f.events.at(-1).session_id, "fixture-session");
    const counters = f.env.ACCESS_CONTROL.objects.get("policy-bindings").db.prepare("SELECT grant_key, selected_count FROM upstream_grant_selection").all();
    assert.deepEqual(counters.map(row => [row.grant_key, row.selected_count]), [[f.events[0].grant_key, 2]], "both creates select only the pinned owner; local counters flush in the background");
    t.diagnostic(`cache ${cache}, ${budgetMode}, ${budgets} budget legs: ${rounds.length} sequential storage rounds`);
  });
}

for (const cache of ["warm", "off"]) test(`pinned preparation reuses the admitted provider connection without I/O: cache ${cache}`, async t => {
  const f = await websocketFixture(t, { cache });
  await f.create();
  const provider = providerById("openai");
  const request = new Request("https://router.example/v1/responses", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "x-request-id": "fixture-connection-check" } });
  const key = f.events.at(-1).grant_key;
  const selection = concreteOpenAiSelection("/v1/responses", { model: "openai/gpt-5.6-sol", input: "fixture" }, f.env);
  const auth = await authenticateProxyKey(request.headers, f.env, [{ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id }], false, "fixture-session", {
    providerId: provider.id, endpointId: selection.endpoint.id, mode: "websocket", model: selection.body.model,
    catalogModelId: selection.model.id, capability: selection.capability, pinnedKey: key,
  });
  assert.ok(!(auth instanceof Response));
  const admitted = proxyAdmission(auth).connections.find(item => item.providerId === provider.id);
  assert.equal(admitted.monthlyBudgetMicros, 100_000);
  assert.equal(proxySessionHash(auth), await sha256Hex("session:fixture-session"));
  assert.equal(proxyAdmission(auth).selection.selected.key, key);
  // Any extra connection lookup would be a scalar KV read or an authority RPC.
  f.env.POLICY_KV.get = () => assert.fail("no KV lookup during preparation");
  f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => assert.equal(new URL(request.url).pathname, "/grant-pools/record");
  const connection = await assertProviderAccess(provider, auth, f.env);
  const prepared = await prepareSelected(request, f.env, selection, {}, auth, new Set(), true, undefined, { key, revision: grantRevision(f.values.get(key)) }, "websocket");
  assert.equal(connection, admitted);
  assert.equal(prepared.connection, connection);
});

async function primeAdmission(f, pinnedKey) {
  const provider = providerById("openai");
  const selection = concreteOpenAiSelection("/v1/responses", { model: "openai/gpt-5.6-sol", input: "fixture" }, f.env);
  const auth = await authenticateProxyKey(new Headers({ authorization: "Bearer clawrouter-live-fixture-fixture-secret" }), f.env, [{ id: provider.id, tokenRef: "openai" }], false, "fixture-session", {
    providerId: provider.id, endpointId: selection.endpoint.id, mode: "websocket", model: selection.body.model,
    catalogModelId: selection.model.id, capability: selection.capability, pinnedKey,
  });
  assert.ok(!(auth instanceof Response));
  assert.ok(proxyAdmission(auth).snapshots?.openai, "current admission contains a local-selection snapshot");
  return auth;
}

function forbidSelectionIO(f) {
  f.env.POLICY_KV.get = () => assert.fail("warm selection must not read KV");
  f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
    assert.ok(["/grant-pools/record", "/http-continuations"].includes(new URL(request.url).pathname), "warm selection must not call admission or select");
  };
}

for (const change of ["missing", "ineligible", "revision", "transport"]) for (const chained of [false, true]) test(`local selection rejects ${change} pinned grant${chained ? " with continuation restart" : " without switching owners"}`, async t => {
  const f = await websocketFixture(t, { cache: "warm", budgetMode: "soft", budgets: 0 });
  await f.create();
  const key = f.events.at(-1).grant_key;
  if (change === "missing") await revokeGrantCredentials(f.env, key);
  else if (change === "ineligible") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, budgetMode: "soft", grantRouting: { ...f.policy.grantRouting, eligibleGrants: { openai: [grantKeys.find(other => other !== key).split("/").at(-1)] } } } });
  else await putGrantCredentials(f.env, key, change === "transport"
    ? { provider: "openai", kind: "subscription", enabled: true, accessToken: "synthetic-subscription", accountId: "synthetic-account" }
    : { provider: "openai", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  // Model another isolate observing the changed authority snapshot at refresh.
  invalidateAdmissions();
  const auth = await primeAdmission(f, key);
  if (change !== "revision") assert.equal(proxyAdmission(auth).selection.selected, null);
  forbidSelectionIO(f);
  f.env.GRANT_CREDENTIALS.get = () => assert.fail("changed snapshot pin must fail before materialization");
  const result = await f.create(chained ? { previous_response_id: "ws_1" } : {});
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.error.code, chained ? "continuation_restart_required" : "upstream_grant_changed");
  assert.equal(f.frames.length, 1);
  assert.equal(f.client.closed, false);
  assert.equal(f.events.length, 2);
  assert.equal(f.events.at(-1).actual_cost_micros, 0);
});

test("warm first-create selection cannot use HTTP-only grant transports or environment fallback", async t => {
  const f = await websocketFixture(t, { cache: "warm", budgetMode: "soft", budgets: 0 });
  for (const key of grantKeys) await putGrantCredentials(f.env, key, { provider: "openai", kind: "subscription", enabled: true, accessToken: "synthetic-subscription", accountId: "synthetic-account" });
  invalidateAdmissions();
  const auth = await primeAdmission(f);
  assert.equal(proxyAdmission(auth).selection.selected, null);
  assert.equal(proxyAdmission(auth).selection.hasConfiguredGrant, true);
  forbidSelectionIO(f);
  const result = await f.create();
  assert.equal(result.error.code, "upstream_grant_pool_unavailable");
  assert.equal(f.frames.length, 0);
  assert.equal(f.client.closed, false);
});

test("a continuation-pinned first create keeps its owner despite another local selection", async t => {
  const f = await websocketFixture(t, { cache: "warm", budgetMode: "soft", budgets: 0 });
  const parent = JSON.parse(await f.consume(await f.request()));
  const owner = f.events.at(-1).grant_key;
  assert.equal((await f.create({ previous_response_id: parent.id })).type, "response.completed");
  assert.equal(f.events.at(-1).grant_key, owner);
  assert.equal(f.frames.length, 1);
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

async function until(predicate) {
  for (let i = 0; !predicate(); i++) {
    assert.ok(i < 1000, "fixture event timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("soft WebSocket sends without awaiting status; exhaustion charges this turn and denies the next", async t => {
  const f = await websocketFixture(t, { cache: "warm", budgetMode: "soft", budgets: 1, limit: 7 });
  const gate = Promise.withResolvers(), calls = [];
  const get = f.env.BUDGET_LEDGER.get.bind(f.env.BUDGET_LEDGER);
  f.env.BUDGET_LEDGER.get = name => {
    const stub = get(name);
    return { ...stub, fetch: async (url, init) => {
      const path = new URL(url).pathname; calls.push(path);
      if (path === "/status") { await gate.promise; return Response.json({ spentMicros: 7 }); }
      return stub.fetch(url, init);
    } };
  };
  let terminal;
  f.onFrame = (_body, response) => {
    terminal = response;
    f.provider.send(JSON.stringify({ type: "response.created", response }));
    return false;
  };
  f.client.send(JSON.stringify({ type: "response.create", model: "openai/gpt-5.6-sol", input: "fixture" }));
  await until(() => f.frames.length === 1);
  assert.deepEqual(calls, ["/status"]);
  gate.resolve();
  await f.drain();
  assert.equal(f.client.closed, false);
  f.provider.send(JSON.stringify({ type: "response.completed", response: terminal }));
  await until(() => f.messages.some(message => message.type === "response.completed"));
  await f.drain();
  assert.equal(f.messages.at(-1).type, "response.completed");
  assert.equal(f.events[0].actual_cost_micros, 7);
  assert.deepEqual(calls, ["/status", "/charge"]);
  const denied = await f.create({ previous_response_id: "ws_1" });
  assert.equal(denied.status, 402);
  assert.equal(denied.error.code, "budget_exhausted");
  assert.match(denied.error.message, /resets at.*Use the team policy/);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(calls, ["/status", "/charge"]);
});

test("zero soft WebSocket budget denies before dispatch without ledger calls", async t => {
  const f = await websocketFixture(t, { budgetMode: "soft", budgets: 1, limit: 0 });
  f.env.BUDGET_LEDGER.get = () => assert.fail("zero limit needs no ledger");
  const result = await f.create();
  assert.equal(result.status, 402);
  assert.equal(result.error.code, "budget_exhausted");
  assert.match(result.error.message, /resets at.*Use the team policy/);
  assert.equal(f.frames.length, 0);
  assert.equal(f.events[0].actual_cost_micros, 0);
});

for (const recoveryFails of [false, true]) test(`soft WebSocket failed charge ${recoveryFails ? "and recovery closes the socket" : "uses durable recovery"}`, async t => {
  t.mock.method(console, "error", () => {});
  const f = await websocketFixture(t, { budgetMode: "soft", budgets: 1 });
  const get = f.env.BUDGET_LEDGER.get.bind(f.env.BUDGET_LEDGER);
  f.env.BUDGET_LEDGER.get = name => ({ fetch: async (url, init) => {
    if (new URL(url).pathname === "/charge") throw new Error("fixture charge failure");
    return get(name).fetch(url, init);
  } });
  const send = f.env.USAGE_QUEUE.send;
  const recovered = [];
  f.env.USAGE_QUEUE.send = async event => {
    if (event.kind === "budget_charge") {
      recovered.push(event);
      if (recoveryFails) throw new Error("fixture recovery failure");
    }
    return send(event);
  };
  await f.create();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].request.amountMicros, 7);
  assert.equal(f.client.closed, recoveryFails);
  if (recoveryFails) assert.ok(f.messages.some(message => message.error?.code === "accounting_unavailable"));
});

test("soft WebSocket missing usage has no invented reservation charge", async t => {
  const f = await websocketFixture(t, { budgetMode: "soft", budgets: 1, fixedCost: null });
  f.onFrame = () => { f.provider.close(); return false; };
  f.client.send(JSON.stringify({ type: "response.create", model: "openai/gpt-5.6-sol", input: "fixture" }));
  await until(() => f.events.length > 0);
  await f.drain();
  assert.equal(f.events[0].actual_cost_micros, 0);
  assert.equal(f.events[0].reserved_cost_micros, 0);
  assert.equal(f.events[0].cost_basis, "unpriced_usage");
});

test("retention-required WebSocket keeps reserve, retention, dispatch, send ordering", async t => {
  const f = await websocketFixture(t, { budgets: 1, retain: true });
  const order = [], get = f.env.BUDGET_LEDGER.get.bind(f.env.BUDGET_LEDGER);
  f.env.CONTENT_ARCHIVE = { put: async () => { order.push("retention"); } };
  f.env.BUDGET_LEDGER.get = name => ({ fetch: async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/reserve") {
      assert.equal(JSON.parse(init.body).dispatched, undefined);
      order.push("reserve");
    }
    if (path === "/dispatch") order.push("dispatch");
    return get(name).fetch(url, init);
  } });
  f.onSend = () => order.push("send");
  assert.equal((await f.create()).type, "response.completed");
  assert.deepEqual(order, ["reserve", "retention", "dispatch", "send"]);
});

for (const budgetMode of ["soft", "reserve"]) test(`first-turn failover uses refreshed ${budgetMode} policy for reservation and dispatch`, async t => {
  const f = await websocketFixture(t, { budgets: 1, budgetMode: budgetMode === "soft" ? "reserve" : "soft" });
  const getGrant = f.env.GRANT_CREDENTIALS.get.bind(f.env.GRANT_CREDENTIALS);
  let failed = false;
  f.env.GRANT_CREDENTIALS.get = name => ({ fetch: async (url, init) => {
    if (!failed && new URL(url).pathname === "/materialize") {
      failed = true;
      return Response.json({ error: { code: "grant_credential_missing", message: "fixture failover" } }, { status: 503 });
    }
    return getGrant(name).fetch(url, init);
  } });
  const getAuthority = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
  let refreshed = false;
  f.env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => {
    const request = url instanceof Request ? url : new Request(url, init);
    const response = await getAuthority(name).fetch(request);
    if (new URL(request.url).pathname === "/admission/resolve" && failed) {
      const body = await response.json();
      body.policy.policy.budgetMode = budgetMode;
      refreshed = true;
      return Response.json(body);
    }
    return response;
  } });
  const calls = [], getBudget = f.env.BUDGET_LEDGER.get.bind(f.env.BUDGET_LEDGER);
  f.env.BUDGET_LEDGER.get = name => ({ fetch: (url, init) => { calls.push(new URL(url).pathname); return getBudget(name).fetch(url, init); } });
  const result = await f.create();
  assert.equal(result.type, "response.completed", JSON.stringify(result));
  assert.equal(refreshed, true);
  assert.equal(calls.includes("/reserve"), budgetMode === "reserve");
  assert.equal(calls.includes("/charge"), budgetMode === "soft");
  assert.equal(calls.includes("/dispatch"), false);
});
