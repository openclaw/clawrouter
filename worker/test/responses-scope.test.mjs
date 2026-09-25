import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { planBudgetReservation } from "../accounting.ts";
import { UsageLedgerObject } from "../ledgers.ts";
const { createProxyAccounting } = await import("../proxy-accounting.ts");

const owner = { providerId: "fixture", endpointId: "create", grantKey: "oauth/fixture/key", lineage: "lineage", routeSha256: "a".repeat(64), policyGeneration: "generation" };
const auth = { policyId: "policy", credentialId: "key", principalId: null, authType: "proxy_key", policy: { monthlyBudgetMicros: 5000, generation: "generation" } };
const cost = { reserveMicros: 100, basis: "manifest_pricing", inputTokens: 40, outputTokens: 60 };
const pricing = { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 };
const terminal = () => ({ occurredAtMs: Date.now(), statusCode: 200, status: "success", billable: true, tokens: { input: 10, output: 15, total: 25, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }, contentRef: null });

function fixture(t) {
  let now = Date.parse("2026-09-25T00:00:00Z"), sequence = 0;
  t.mock.method(Date, "now", () => now);
  const budgets = sqlBudgetNamespace(t), usageDb = new DatabaseSync(":memory:"); t.after(() => usageDb.close());
  const usageState = { storage: { sql: { exec(query, ...bindings) { const statement = usageDb.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } }, getAlarm: async () => 1 } };
  let usage = new UsageLedgerObject(usageState);
  const calls = [], controls = { budget: async (_name, _url, _init, dispatch) => dispatch(), usage: async (_init, dispatch) => dispatch() };
  const env = {
    BUDGET_LEDGER: { idFromName: name => name, get: name => ({ fetch: async (url, init) => { calls.push({ name, path: new URL(url).pathname, body: JSON.parse(init.body) }); return controls.budget(name, url, init, () => budgets.get(name).fetch(url, init)); } }) },
    USAGE_LEDGER: { idFromName: name => name, get: () => ({ fetch: async (url, init) => { calls.push({ path: "/ingest", body: JSON.parse(init.body) }); return controls.usage(init, () => usage.fetch(new Request(url, init))); } }) },
    USAGE_QUEUE: { send() { assert.fail("durable outbox requires sink ACK, never queue acceptance"); } },
  };
  const namespace = continuationAuthority(t, env), stub = namespace.get("scope"), state = namespace.objects.get("scope");
  const call = async (action, extra = {}) => {
    const response = await stub.fetch("https://clawrouter.internal/responses-background", { method: "POST", body: JSON.stringify({ action, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  const input = () => {
    const facts = createProxyAccounting({ env, context: {}, auth, cost, selection: { provider: { id: "fixture" }, model: { id: "fixture/model", pricing }, capability: "llm.responses", endpoint: { request_format: "openai.responses" }, body: {} }, request: new Request("https://router.example/v1/responses", { headers: { "x-request-id": "fixture-request" } }) }).facts;
    return { id: `bg_${(++sequence).toString(16).padStart(32, "0")}`, admittedAt: now, owner, facts, plan: planBudgetReservation(auth, "llm.responses", cost, { providerId: "fixture", monthlyBudgetMicros: 5000 }, now), route: { pathParams: {}, organization: null, project: null }, stream: true };
  };
  return { call, input, state, calls, controls, budgets, usageDb, advance(ms) { now += ms; }, restart() { state.restart(); usage = new UsageLedgerObject(usageState); },
    async admit(admission) { assert.equal((await call("admit", { admission })).status, 200); },
    async dispatch(id) { assert.equal((await call("dispatch", { id })).status, 200); },
    async bind(admission, key = "b".repeat(64)) {
      const response = await stub.fetch("https://clawrouter.internal/http-continuations", { method: "POST", body: JSON.stringify({ action: "register", keys: [key], owner, responseClaim: { key, producerId: "c".repeat(64) }, backgroundJobId: admission.id }) });
      assert.equal(response.status, 200); assert.equal((await response.json()).outcome, "stored");
    },
  };
}

test("lost reserve ACK persists sent intent and recovers the original receipt without dispatch or another reserve", async t => {
  const f = fixture(t), input = f.input();
  f.controls.budget = async (_name, url, _init, dispatch) => { const response = await dispatch(); if (new URL(url).pathname === "/reserve") throw new Error("lost reserve ACK"); return response; };
  assert.equal((await f.call("admit", { admission: input })).status, 503);
  const frozen = (await f.call("get", { id: input.id })).body;
  assert.equal(frozen.legs[0].reserve, "sent"); assert.equal(frozen.egress, false);
  assert.equal(frozen.event.actual_cost_micros, 0);
  assert.deepEqual(f.calls.map(call => call.path), ["/reserve"]);
  f.restart(); await f.state.object.alarm();
  const done = (await f.call("get", { id: input.id })).body;
  assert.equal(done.phase, "complete"); assert.equal(done.eventId, frozen.event.id);
  assert.deepEqual(f.calls.map(call => call.path), ["/reserve", "/settle", "/ingest"]);
  const row = f.budgets.get(input.plan.legs[0].objectName).reservations()[0];
  assert.equal(row.reservation_id, input.plan.legs[0].request.reservationId); assert.equal(row.reserved_micros, 0); assert.equal(row.settled, 1); assert.equal(row.dispatch_started, 0);
});

test("independent SQL commits and lost ACKs replay the frozen event after reconstruction", async t => {
  const f = fixture(t), input = f.input(); await f.admit(input); await f.dispatch(input.id); await f.bind(input);
  const original = (await f.call("freeze", { id: input.id, outcome: terminal() })).body.event;
  const binding = f.state.db.prepare("SELECT * FROM http_continuations").get();
  assert.equal(binding.background_closed, 1);
  let failed = true;
  f.controls.budget = async (name, url, _init, dispatch) => {
    if (new URL(url).pathname !== "/settle" || !failed) return dispatch();
    if (name === input.plan.legs[1].objectName) return new Response("unavailable", { status: 503 });
    await dispatch(); throw new Error("lost financial ACK");
  };
  f.controls.usage = async (_init, dispatch) => { const response = await dispatch(); if (failed) throw new Error("lost usage ACK"); return response; };
  await f.state.object.alarm();
  const pending = (await f.call("get", { id: input.id })).body;
  assert.deepEqual(pending.settlements, ["unavailable", "unavailable"]); assert.equal(pending.usage, "unavailable"); assert.deepEqual(pending.event, original);
  const stored = f.usageDb.prepare("SELECT * FROM usage_events").get(); assert.deepEqual(JSON.parse(stored.event_json), original);
  f.restart(); for (const leg of input.plan.legs) f.budgets.get(leg.objectName).restart(); failed = false; f.advance(60_000);
  await f.state.object.alarm();
  assert.equal((await f.call("get", { id: input.id })).body.phase, "complete");
  assert.deepEqual(f.usageDb.prepare("SELECT * FROM usage_events").all(), [stored]);
  for (const leg of input.plan.legs) { const [row] = f.budgets.get(leg.objectName).reservations(); assert.equal(row.reservation_id, leg.request.reservationId); assert.equal(row.reserved_micros, 25); assert.equal(row.settled, 1); }
  assert.deepEqual(f.calls.filter(call => call.path === "/ingest").map(call => call.body), [original, original]);
  assert.equal(f.state.db.prepare("SELECT expires_at_ms FROM http_continuations").get().expires_at_ms, binding.expires_at_ms);
});

for (const reverse of [false, true]) test(`shared alarm preserves background deadlines when continuation cleanup empties its table (${reverse ? "background first" : "continuation first"})`, async t => {
  const f = fixture(t), input = f.input();
  // Admission precedes the association, but independently registered foreground
  // bindings can exist in either order relative to a background job.
  const foreground = async () => {
    const { PolicyBindingIndexObject } = await import("../authority.ts");
    assert.ok(f.state.object instanceof PolicyBindingIndexObject);
    const response = await f.state.object.fetch(new Request("https://scope/http-continuations", { method: "POST", body: JSON.stringify({ action: "register", keys: ["d".repeat(64)], owner }) }));
    assert.equal(response.status, 200);
  };
  if (!reverse) await foreground();
  await f.admit(input); await f.dispatch(input.id);
  if (reverse) await foreground();
  f.state.db.prepare("UPDATE http_continuations SET expires_at_ms = ?").run(Date.now() + 5_000);
  f.advance(5_000); f.restart(); await f.state.object.alarm();
  assert.equal(f.state.db.prepare("SELECT count(*) AS count FROM http_continuations").get().count, 0);
  assert.equal(f.state.scheduled, input.admittedAt + 3_600_000);
  f.advance(3_595_000); await f.state.object.alarm();
  const done = (await f.call("get", { id: input.id })).body;
  assert.equal(done.phase, "complete"); assert.equal(done.amount, 100); assert.equal(done.basis, "manifest_reservation");
  assert.equal(f.state.scheduled, null);
});

test("outbox network waits release serialization and cannot overwrite a newly earlier deadline", { timeout: 2000 }, async t => {
  const f = fixture(t), first = f.input(); await f.admit(first); await f.dispatch(first.id);
  await f.call("freeze", { id: first.id, outcome: terminal() });
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.controls.usage = async (_init, dispatch) => { entered.resolve(); await gate.promise; return dispatch(); };
  const running = f.state.object.alarm(); await entered.promise;
  const second = f.input(); await f.admit(second); await f.dispatch(second.id);
  assert.equal((await f.call("identity", { id: second.id, responseId: "response-second" })).status, 200);
  assert.equal(f.state.scheduled, Date.now() + 5_000);
  gate.resolve(); await running;
  assert.equal(f.state.scheduled, Date.now() + 5_000);
  assert.equal((await f.call("get", { id: first.id })).body.phase, "complete");
});
