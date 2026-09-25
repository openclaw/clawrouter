import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { finalizeAccounting, reserveBudget, settleBudget } from "../accounting.ts";
import { queue, UsageLedgerObject, usageSnapshot } from "../ledgers.ts";

const reservation = {
  reservations: [{ reservationId: "reservation", objectName: "tenant:policy" }],
  reservedMicros: 100,
};
const event = { id: "usage", type: "clawrouter.usage.v1", tenant_id: "tenant", policy_id: "policy", request_id: "request-safe" };

test("thrown ledger settlement queues a retry", async () => {
  for (const objectName of ["tenant:policy", "tenant:policy:user@example.com", "provider:openai"]) {
    const sent = [], destinations = [];
    let available = false, acknowledged = false;
    const env = mockEnv(async message => { sent.push(message); });
    env.BUDGET_LEDGER.get = name => ({ fetch: async (_url, init) => {
      destinations.push(name);
      assert.deepEqual(JSON.parse(init.body), { reservationId: "reservation", actualCostMicros: 42 });
      if (!available) throw new Error("synthetic outage");
      return Response.json({ settled: true });
    } });
    await settleBudget(env, { ...reservation, reservations: [{ reservationId: "reservation", objectName }] }, 42);
    assert.deepEqual(sent, [{ kind: "budget_settlement", ledger: { objectName }, request: { reservationId: "reservation", actualCostMicros: 42 } }]);
    available = true;
    await queue({ messages: [{ body: sent[0], ack() { acknowledged = true; }, retry() { assert.fail("settlement should succeed"); } }] }, env);
    assert.equal(acknowledged, true);
    assert.deepEqual(destinations, [objectName, objectName]);
  }
});

test("settlement retry failure does not suppress the usage event", async () => {
  const sent = [];
  const env = mockEnv(async (message) => {
    if (message.kind === "budget_settlement") throw new Error("queue settlement unavailable");
    sent.push(message);
  });
  const errors = [];
  const original = console.error;
  console.error = (...values) => errors.push(JSON.stringify(values));
  try {
    assert.equal(await finalizeAccounting(env, reservation, 42, event), false);
  } finally {
    console.error = original;
  }
  assert.deepEqual(sent, [event]);
  assert.match(errors.join("\n"), /accounting finalization failed/);
  assert.match(errors.join("\n"), /request-safe/);
  assert.doesNotMatch(errors.join("\n"), /queue settlement unavailable/);
});

test("finalization reports durable recovery success and independent usage publication failure", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const usageFails of [false, true]) {
    const sent = [];
    const env = mockEnv(async (message) => {
      if (usageFails && message.type === "clawrouter.usage.v1") throw new Error("usage unavailable");
      sent.push(message);
    });
    assert.equal(await finalizeAccounting(env, reservation, 42, event), !usageFails);
    assert.ok(sent.some((message) => message.kind === "budget_settlement"));
    assert.equal(sent.includes(event), !usageFails);
  }
});

test("rejected usage publication recovers the exact event in its policy shard and deduplicates redelivery", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const sql = { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } };
  const ledger = new UsageLedgerObject({ storage: { sql, getAlarm: async () => 1 } });
  const body = { ...event, occurred_at_ms: Date.now(), provider: "openai", model: "openai/gpt-6-astra", capability: "llm.responses", status: "success", status_code: 200, input_tokens: 3, output_tokens: 2, total_tokens: 5, actual_cost_micros: 42, cost_basis: "manifest_pricing", requested_service_tier: "priority", served_service_tier: "fast", session_id: "fixture-session", credential_id: "fixture-credential", principal_id: "fixture-principal", content_retained: false, content_ref: null };
  const accepted = [], calls = [];
  const env = mockEnv(async message => { accepted.push(structuredClone(message)); throw new Error("ambiguous queue acceptance"); });
  env.BUDGET_LEDGER.get = () => ({ fetch: async () => Response.json({ settled: true }) });
  env.USAGE_LEDGER = { idFromName: name => name, get: name => ({ fetch: async (url, init) => { calls.push({ name, url, init }); return ledger.fetch(new Request(url, init)); } }) };
  assert.equal(await finalizeAccounting(env, reservation, 42, body), true);
  assert.deepEqual(accepted, [body]);
  assert.deepEqual(calls.map(({ name, url, init }) => ({ name, url, method: init.method, body: JSON.parse(init.body) })), [{ name: "policy:tenant:policy", url: "https://clawrouter.internal/ingest", method: "POST", body }]);
  let acknowledged = 0;
  for (let delivery = 0; delivery < 2; delivery++) await queue({ messages: [{ body: accepted[0], ack() { acknowledged++; }, retry() { assert.fail("redelivery must succeed"); } }] }, env);
  assert.equal(acknowledged, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get().count, 1);
  assert.deepEqual(JSON.parse(db.prepare("SELECT event_json FROM usage_events").get().event_json), body);
  const snapshot = await usageSnapshot(env, "tenant", "policy", { kind: "admin" });
  assert.equal(snapshot.summary.requestCount, 1);
  assert.equal(snapshot.summary.actualCostMicros, 42);
  assert.equal(snapshot.providers[0].requestCount, 1);
  assert.equal(snapshot.providers[0].actualCostMicros, 42);
  assert.equal(snapshot.daily[0].requestCount, 1);
  assert.equal(snapshot.daily[0].actualCostMicros, 42);
  assert.deepEqual(snapshot.events, [body]);
});

test("usage recovery cannot conceal failed budget settlement or exhausted publication", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const settlementFails of [false, true]) for (const direct of ["stored", "duplicate", "expired_by_retention", "throw", "non-2xx", "unconfirmed"]) {
    let writes = 0, settlements = 0;
    const env = mockEnv(async () => { throw new Error("queue unavailable"); });
    env.BUDGET_LEDGER.get = () => ({ fetch: async () => { settlements++; if (settlementFails) throw new Error("settlement unavailable"); return Response.json({ settled: true }); } });
    env.USAGE_LEDGER.get = () => ({ fetch: async () => {
      writes++;
      if (direct === "throw") throw new Error("ingest unavailable");
      if (direct === "non-2xx" || direct === "unconfirmed") return new Response("accepted", { status: direct === "non-2xx" ? 503 : 200 });
      return Response.json({ eventId: event.id, outcome: direct });
    } });
    assert.equal(await finalizeAccounting(env, reservation, 42, event), !settlementFails && ["stored", "duplicate", "expired_by_retention"].includes(direct));
    assert.equal(writes, 1);
    assert.equal(settlements, 1);
  }
});

test("accepted queue publication does not also write directly", async () => {
  const env = mockEnv(async message => assert.equal(message, event));
  env.USAGE_LEDGER.get = () => assert.fail("accepted publication must stay queue-only");
  assert.equal(await finalizeAccounting(env, { reservations: [], reservedMicros: 0 }, 42, event), true);
});

test("HTTP success without a settlement receipt remains retryable", async () => {
  for (const body of [{ settled: false }, {}, "invalid JSON"]) {
    const sent = [], env = mockEnv(async message => sent.push(message));
    env.BUDGET_LEDGER.get = () => ({ fetch: async () => typeof body === "string" ? new Response(body) : Response.json(body) });
    await settleBudget(env, reservation, 42);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "budget_settlement");
    let retried = false;
    await queue({ messages: [{ body: sent[0], ack() { assert.fail("unconfirmed settlement cannot be acknowledged"); }, retry() { retried = true; } }] }, env);
    assert.equal(retried, true);
  }
});

test("provider admission denial preserves queued rollback but surfaces exhausted rollback", async () => {
  for (const recovered of [true, false]) {
    const queued = [];
    const env = mockEnv(async (message) => { if (!recovered) throw new Error("fixture queue outage"); queued.push(message); });
    env.BUDGET_LEDGER.get = (name) => ({ fetch: async (url) => {
      if (new URL(url).pathname === "/reserve") return Response.json({ allowed: !name.startsWith("provider:"), chargedMicros: 1 });
      return new Response("fixture ledger outage", { status: 503 });
    } });
    const auth = { policyId: "fixture", policy: { monthlyBudgetMicros: 100, tenantId: "default", budgetScope: "policy" } };
    await assert.rejects(reserveBudget(env, auth, "llm.responses", { reserveMicros: 1, basis: "manifest_pricing" }, { providerId: "openai", monthlyBudgetMicros: 100 }), (error) => error.code === (recovered ? "provider_budget_exhausted" : "accounting_unavailable"));
    assert.equal(queued.length, recovered ? 1 : 0);
    if (recovered) assert.equal(queued[0].request.actualCostMicros, 0);
  }
});

function mockEnv(send) {
  return {
    BUDGET_LEDGER: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => { throw new Error("ledger unavailable"); } }),
    },
    USAGE_QUEUE: { send },
    USAGE_LEDGER: { idFromName: name => name, get: () => ({ fetch: async () => { throw new Error("usage ledger unavailable"); } }) },
  };
}
