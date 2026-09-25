import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
const { default: handler } = await import("../index.ts");
const { proxyResponsesWebSocket } = await import("../responses-websocket.ts");
import { putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { assertBudgets, endpointDeadline, fixture, grantKeys } from "./http-continuation-fixture.mjs";

async function setExpiry(f, expiresAt, websocket = false) {
  for (const key of grantKeys) await putGrantCredentials(f.env, key, {
    ...f.values.get(key), ...(websocket ? { kind: "oauth" } : {}), refreshToken: null, expiresAt,
  }, true);
}

test("authenticated subscription PUT cannot revive inherited expiry and fresh token recovery authorizes actual HTTP dispatch", async t => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const expiresAt = new Date(clock + 1_000).toISOString(), f = await fixture(t, true, { limit: 1_000_000 });
  await setExpiry(f, expiresAt);
  await revokeGrantCredentials(f.env, grantKeys[1]);
  clock += 1_001;
  const put = async body => {
    const response = await handler.fetch(new Request("https://router.example/v1/admin/upstream-grants/policies/fixture/account-a", {
      method: "PUT", headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" }, body: JSON.stringify(body),
    }), f.env, { waitUntil() {} });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const edited = await put({ credential: "alternate-primary-fixture", label: "retained subscription" });
  const own = f.env.GRANT_CREDENTIALS.objects.get(grantKeys[0]);
  assert.equal(edited.usable, false);
  assert.equal(own.values.get("credential").kind, "subscription");
  assert.equal(own.values.get("credential").accessToken, "synthetic-access-0");
  assert.equal(own.values.get("credential").expiresAt, expiresAt);
  const denied = await f.request();
  assert.equal(denied.status, 503);
  assert.equal(JSON.parse(await f.consume(denied)).error.code, "upstream_grant_pool_unavailable");
  assert.equal(f.sent.length, 0, "neither the retained token, alternate form nor environment fallback may leave the router");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].actual_cost_micros, 0);
  for (const owner of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(owner).reservations().length, 0);
  const recovered = await put({ accessToken: "operator-fresh-access-fixture" });
  assert.equal(recovered.usable, true);
  assert.equal(own.values.get("credential").credential, "alternate-primary-fixture", "merge-form retention and dispatch precedence are unchanged");
  const accepted = await f.request();
  assert.equal(accepted.status, 200);
  await f.consume(accepted);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer operator-fresh-access-fixture");
  assert.equal(f.sent[0].headers.get("chatgpt-account-id"), "synthetic-account-0");
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].status, "success");
  await assertBudgets(f, [7]);
});

for (const phase of ["reserve", "retention", "dispatch"]) for (const continuation of [false, true]) test(`HTTP ${phase} expiry remains unsent with ${continuation ? "continuation recovery" : "actionable denial"} and zero held budgets`, async t => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const expires = clock + 1_000;
  const f = await fixture(t, true, { limit: 1_000_000, retainContent: phase === "retention" });
  await setExpiry(f, new Date(expires).toISOString());
  f.env.CONTENT_ARCHIVE = { put: async () => {} };
  if (continuation) await f.consume(await f.request());
  const before = f.sent.length, get = f.env.BUDGET_LEDGER.get;
  f.env.BUDGET_LEDGER.get = name => {
    const ledger = get(name);
    return { ...ledger, fetch: async (url, init) => {
      const response = await ledger.fetch(url, init);
      if (name === "provider:openai" && new URL(url).pathname === (phase === "reserve" ? "/reserve" : "/dispatch") && phase !== "retention") clock = expires;
      return response;
    } };
  };
  f.env.CONTENT_ARCHIVE.put = async () => { clock = expires; };
  const response = await f.request(continuation ? { previous_response_id: "resp_1" } : {});
  assert.equal(response.status, continuation ? 409 : 502);
  assert.equal(JSON.parse(await f.consume(response)).error.code, continuation ? "continuation_restart_required" : "grant_refresh_failed");
  assert.equal(f.sent.length, before);
  assert.equal(f.events.length, continuation ? 2 : 1);
  assert.equal(f.events.at(-1).status_code, continuation ? 409 : 502);
  assert.equal(f.events.at(-1).status, continuation ? "client_error" : "provider_error");
  assert.equal(f.events.at(-1).actual_cost_micros, 0);
  assert.equal(f.events.at(-1).cost_basis, "none");
  await assertBudgets(f, continuation ? [7, 0] : [0]);
});

test("a caller cancellation already owns late HTTP expiry", async t => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const expires = clock + 1_000, caller = new AbortController();
  const f = await fixture(t, true, { limit: 1_000_000 });
  await setExpiry(f, new Date(expires).toISOString());
  const get = f.env.BUDGET_LEDGER.get;
  f.env.BUDGET_LEDGER.get = name => {
    const ledger = get(name);
    return { ...ledger, fetch: async (url, init) => {
      const result = await ledger.fetch(url, init);
      if (name === "provider:openai" && new URL(url).pathname === "/dispatch") { clock = expires; caller.abort(); }
      return result;
    } };
  };
  const response = await f.request({}, {}, "/v1/responses", caller.signal);
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(await f.consume(response)).error.code, "provider_unavailable");
  assert.equal(f.sent.length, 0);
  assert.equal(f.events[0].status, "client_error");
  await assertBudgets(f, [0]);
});

for (const firstCause of ["expiry", "caller", "deadline"]) test(`alternate expiry preserves known rejection accounting and ${firstCause} precedence`, async t => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const expires = clock + 1_000, caller = new AbortController(), deadline = await endpointDeadline(t);
  const f = await fixture(t, true, { limit: 1_000_000 });
  await setExpiry(f, new Date(expires).toISOString());
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = name => {
    const owner = get(name);
    return { ...owner, fetch: async (url, init) => {
      const response = await owner.fetch(url, init);
      if (name === grantKeys[1] && new URL(url).pathname === "/materialize") {
        clock = expires;
        if (firstCause === "caller") caller.abort(new Error("fixture caller during expired alternate selection"));
        if (firstCause === "deadline") deadline();
      }
      return response;
    } };
  };
  let cancels = 0;
  const rejected = '{"error":{"code":"fixture_original_rejection"}}';
  f.response = () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode(rejected)); controller.close(); },
    cancel() { cancels++; },
  }, { highWaterMark: 0 }), { status: 429, headers: { "content-type": "application/json", "retry-after": "17" } });
  const response = await f.request({}, {}, "/v1/responses", caller.signal);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
  if (firstCause === "expiry") {
    assert.equal(await f.consume(response), rejected);
    assert.equal(cancels, 0);
  } else {
    await assert.rejects(response.text(), firstCause === "caller" ? /fixture caller/ : /deadline/);
    await f.drain();
    assert.equal(cancels, 1);
  }
  assert.equal(f.sent.length, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, firstCause === "deadline" ? "timeout" : "client_error");
  assert.equal(f.events[0].status_code, 429);
  assert.equal(f.events[0].actual_cost_micros, 0);
  assert.equal(f.events[0].cost_basis, "none");
  await assertBudgets(f, [0]);
});

class UpgradeSocket extends EventTarget {
  sent = [];
  closed = false;
  accept() {}
  send(value) { assert.equal(this.closed, false); this.sent.push(JSON.parse(value)); }
  receive(value) { const event = new Event("message"); event.data = JSON.stringify(value); this.dispatchEvent(event); }
  close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event("close")); } }
}

async function websocketFixture(t, f, headers = {}) {
  const NativeResponse = globalThis.Response, previousPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  let server;
  // Node lacks Workers' 101 constructor and socket pair. Keep the real router,
  // owner, admission and SQL ledgers; only provide those transport primitives.
  globalThis.Response = new Proxy(NativeResponse, { construct(target, [body, init]) {
    if (init?.status !== 101) return new target(body, init);
    const response = new target(body, { ...init, status: 200 });
    Object.defineProperties(response, { status: { value: 101 }, webSocket: { value: init.webSocket } });
    return response;
  } });
  globalThis.WebSocketPair = class { constructor() { this[0] = new UpgradeSocket(); this[1] = server = new UpgradeSocket(); } };
  t.after(() => {
    globalThis.Response = NativeResponse;
    if (previousPair) Object.defineProperty(globalThis, "WebSocketPair", previousPair); else delete globalThis.WebSocketPair;
  });
  const pending = [];
  const response = await proxyResponsesWebSocket(new Request("https://router.example/v1/responses", {
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", upgrade: "websocket", ...headers },
  }), f.env, { waitUntil: promise => pending.push(promise) }, "/v1/responses");
  assert.equal(response.status, 101);
  return { server, async drain() { while (pending.length) await Promise.all(pending.splice(0)); await f.drain(); } };
}

for (const status of [401, 403, 429]) for (const cleanup of ["normal", "errored", "rejecting", "deferred"]) test(`upstream WebSocket upgrade ${status} remains an uncharged provider failure with ${cleanup} cleanup`, async t => {
  const f = await fixture(t, true, { limit: 1_000_000 });
  await setExpiry(f, "2099-01-01T00:00:00.000Z", true);
  const entered = Promise.withResolvers(), disposal = Promise.withResolvers();
  let cancels = 0;
  f.response = () => new Response(new ReadableStream({
    start(controller) { if (cleanup === "errored") controller.error(new Error("fixture body already failed")); },
    cancel() {
      cancels++; entered.resolve();
      if (cleanup === "rejecting") return Promise.reject(new Error("fixture cleanup rejection"));
      if (cleanup === "deferred") return disposal.promise;
    },
  }), { status });
  const ws = await websocketFixture(t, f);
  let finished = false, settling;
  try {
    ws.server.receive({ type: "response.create", model: "openai/gpt-6-astra", input: "fixture" });
    settling = ws.drain().then(() => { finished = true; });
    if (cleanup === "deferred") {
      await entered.promise;
      await setImmediate();
      assert.equal(finished, true, "known rejection settles before body cleanup is released");
    }
    await settling;
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].method, "GET");
    assert.equal(cancels, cleanup === "errored" ? 0 : 1);
    assert.equal(ws.server.sent.length, 1);
    assert.equal(ws.server.sent.at(-1).status, status);
    assert.equal(ws.server.sent.at(-1).error.code, "upstream_upgrade_failed");
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, "provider_error");
    assert.equal(f.events[0].status_code, status);
    assert.equal(f.events[0].actual_cost_micros, 0);
    assert.equal(f.events[0].cost_basis, "none");
    await assertBudgets(f, [0]);
  } finally {
    disposal.resolve();
    ws.server.close();
    await settling;
    await ws.drain();
  }
  await setImmediate();
  assert.equal(f.events.length, 1, "late cleanup never publishes a second receipt");
});

for (const phase of ["before upgrade", "connecting", "reused"]) test(`actual WebSocket ${phase} expiry sends no expired create and releases both budgets`, async t => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const expires = clock + 1_000, f = await fixture(t, true, { limit: 1_000_000 });
  await setExpiry(f, new Date(expires).toISOString(), true);
  const upstream = new UpgradeSocket(), entered = Promise.withResolvers(), connection = Promise.withResolvers();
  f.response = async () => {
    entered.resolve();
    if (phase === "connecting") await connection.promise;
    return new Response(null, { status: 101, webSocket: upstream });
  };
  let dispatches = 0;
  const get = f.env.BUDGET_LEDGER.get;
  f.env.BUDGET_LEDGER.get = name => {
    const ledger = get(name);
    return { ...ledger, fetch: async (url, init) => {
      const response = await ledger.fetch(url, init);
      if (name === "provider:openai" && new URL(url).pathname === "/dispatch" && ++dispatches === (phase === "reused" ? 2 : 1) && phase !== "connecting") clock = expires;
      return response;
    } };
  };
  const ws = await websocketFixture(t, f);
  const create = () => ws.server.receive({ type: "response.create", model: "openai/gpt-6-astra", input: "fixture" });
  try {
    create();
    if (phase === "connecting") { await entered.promise; clock = expires; connection.resolve(); }
    await ws.drain();
    if (phase === "reused") {
      assert.equal(upstream.sent.length, 1);
      upstream.receive({ type: "response.created", response: { id: "resp_ws_first" } });
      upstream.receive({ type: "response.completed", response: { id: "resp_ws_first", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
      await ws.drain();
      create();
      await ws.drain();
    }
    assert.equal(f.sent.length, phase === "before upgrade" ? 0 : 1);
    assert.equal(upstream.sent.length, phase === "reused" ? 1 : 0);
    assert.equal(ws.server.sent.at(-1).status, 502);
    assert.equal(ws.server.sent.at(-1).error.code, "grant_refresh_failed");
    assert.equal(f.events.length, phase === "reused" ? 2 : 1);
    assert.equal(f.events.at(-1).status, "provider_error");
    assert.equal(f.events.at(-1).status_code, 502);
    assert.equal(f.events.at(-1).actual_cost_micros, 0);
    assert.equal(f.events.at(-1).cost_basis, "none");
    await assertBudgets(f, phase === "reused" ? [7, 0] : [0]);
  } finally {
    connection.resolve();
    ws.server.close();
    await ws.drain();
  }
});

for (const carrier of ["response", "metadata", "header"]) for (const phase of ["before upgrade", "connecting", "reused"]) test(`WebSocket ${carrier} continuation crossing expiry ${phase} requests full-input restart without dispatch`, async t => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const expires = clock + 1_000, f = await fixture(t, true, { limit: 1_000_000 });
  await setExpiry(f, new Date(expires).toISOString(), true);
  f.response = () => Response.json({ object: "response", id: "resp_http_seed", status: "completed", output: [] }, { headers: { "x-codex-turn-state": "turn_seed" } });
  await f.consume(await f.request());
  const upstream = new UpgradeSocket(), entered = Promise.withResolvers(), connection = Promise.withResolvers();
  f.response = async () => {
    entered.resolve();
    if (phase === "connecting") await connection.promise;
    return new Response(null, { status: 101, webSocket: upstream });
  };
  let dispatches = 0;
  const get = f.env.BUDGET_LEDGER.get;
  f.env.BUDGET_LEDGER.get = name => {
    const ledger = get(name);
    return { ...ledger, fetch: async (url, init) => {
      const response = await ledger.fetch(url, init);
      if (name === "provider:openai" && new URL(url).pathname === "/dispatch" && ++dispatches === (phase === "reused" ? 2 : 1) && phase !== "connecting") clock = expires;
      return response;
    } };
  };
  const ws = await websocketFixture(t, f, carrier === "header" ? { "x-codex-turn-state": "turn_seed" } : {});
  const create = previous => ws.server.receive({ type: "response.create", model: "openai/gpt-6-astra", input: "fixture",
    ...(carrier === "response" ? { previous_response_id: previous } : carrier === "metadata" ? { client_metadata: { "x-codex-turn-state": "turn_seed" } } : {}),
  });
  try {
    create("resp_http_seed");
    if (phase === "connecting") { await entered.promise; clock = expires; connection.resolve(); }
    await ws.drain();
    if (phase === "reused") {
      assert.equal(upstream.sent.length, 1);
      upstream.receive({ type: "response.created", response: { id: "resp_ws_first" } });
      upstream.receive({ type: "response.completed", response: { id: "resp_ws_first", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
      await ws.drain();
      create("resp_ws_first");
      await ws.drain();
    }
    assert.equal(f.sent.length, phase === "before upgrade" ? 1 : 2, "only the successful seed and permitted handshake may leave the router");
    assert.equal(upstream.sent.length, phase === "reused" ? 1 : 0);
    const notice = ws.server.sent.at(-1);
    assert.equal(notice.status, 409);
    assert.equal(notice.error.code, "continuation_restart_required");
    assert.match(notice.error.message, /restart with full input and omit previous_response_id and x-codex-turn-state/);
    assert.equal(f.events.length, phase === "reused" ? 3 : 2);
    assert.equal(f.events.at(-1).status, "client_error");
    assert.equal(f.events.at(-1).status_code, 409);
    assert.equal(f.events.at(-1).actual_cost_micros, 0);
    assert.equal(f.events.at(-1).cost_basis, "none");
    await assertBudgets(f, phase === "reused" ? [7, 7, 0] : [7, 0]);
  } finally {
    connection.resolve();
    ws.server.close();
    await ws.drain();
  }
});
