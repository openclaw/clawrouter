import { sqliteFixture } from "./sqlite-storage.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { finalizeAccounting, reserveBudget, settleBudget } from "../accounting.ts";
import { queue, UsageLedgerObject, usageSnapshot } from "../ledgers.ts";
import { caughtResponse, HttpError } from "../utils.ts";

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
  const { db, sql, transactionSync } = sqliteFixture(t);
  const ledger = new UsageLedgerObject({ storage: { sql, transactionSync, getAlarm: async () => 1 } });
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

const budgetKinds = ["policy", "daily", "weekly", "provider"];
const fourLegAuth = { policyId: "fixture", policy: { monthlyBudgetMicros: 100, dailyBudgetMicros: 100, weeklyBudgetMicros: 100, tenantId: "default" } };
const budgetCost = { reserveMicros: 1, basis: "manifest_pricing" };
const budgetConnection = { providerId: "openai", monthlyBudgetMicros: 100 };

test("all budget legs overlap and retain plan order, with attempted IDs recorded before I/O", { timeout: 5_000 }, async () => {
  const observations = [], calls = [], completed = [];
  const gates = budgetKinds.map(() => Promise.withResolvers()), done = budgetKinds.map(() => Promise.withResolvers());
  let active = 0, peak = 0;
  const env = mockEnv(async () => assert.fail("no recovery needed"));
  env.BUDGET_LEDGER.get = name => ({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body), index = calls.length;
    calls.push(body.reservationId);
    assert.deepEqual(observations[index], [body.reservationId, "attempted"]);
    peak = Math.max(peak, ++active);
    await gates[index].promise;
    assert.equal(observations.length, 4, "every attempt precedes the first completed reserve");
    active--;
    completed.push(body.reservationId);
    done[index].resolve();
    return Response.json({ allowed: true, chargedMicros: 1 });
  } });
  const pending = reserveBudget(env, fourLegAuth, "llm.responses", budgetCost, budgetConnection, (leg, state) => observations.push([leg.request.reservationId, state]));
  assert.equal(calls.length, 4, "every reserve starts before any response is released");
  assert.equal(peak, 4);
  for (let index = gates.length - 1; index >= 0; index--) { gates[index].resolve(); await done[index].promise; }
  const result = await pending;
  assert.deepEqual(completed, [...calls].reverse(), "responses complete in reverse plan order");
  assert.deepEqual(result.reservations.map(item => item.reservationId), calls);
});

for (const rollbackFails of [false, true]) test(`parallel denial waits for late successes and ${rollbackFails ? "reports failed rollback" : "preserves plan-order errors"}`, async () => {
  const gates = budgetKinds.map(() => Promise.withResolvers()), calls = [], settled = [], observations = [];
  const env = mockEnv(async () => { throw new Error("recovery unavailable"); });
  env.BUDGET_LEDGER.get = name => ({ fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (new URL(url).pathname === "/settle") {
      assert.equal(calls.length, 4);
      assert.equal(gates.every(gate => gate.done), true, "rollback waits for every reserve");
      assert.equal(body.actualCostMicros, 0);
      settled.push(body.reservationId);
      if (rollbackFails) throw new Error("ledger unavailable");
      return Response.json({ settled: true });
    }
    const index = calls.length;
    calls.push(body.reservationId);
    await gates[index].promise;
    return Response.json({ allowed: index === 0 || index === 3, chargedMicros: 1 });
  } });
  const pending = reserveBudget(env, fourLegAuth, "llm.responses", budgetCost, budgetConnection, (leg, state) => observations.push([leg.kind, state]));
  const rejected = assert.rejects(pending, error => error.code === (rollbackFails ? "accounting_unavailable" : "daily_budget_exhausted"));
  assert.equal(calls.length, 4);
  assert.deepEqual(observations, budgetKinds.map(kind => [kind, "attempted"]));
  // Weekly fails first in time; daily must still win by plan order.
  for (const index of [2, 1, 0, 3]) { gates[index].done = true; gates[index].resolve(); await new Promise(resolve => setImmediate(resolve)); }
  await rejected;
  assert.deepEqual(settled, [calls[0], calls[3]]);
  assert.deepEqual(observations.filter(([, state]) => state === "denied").map(([kind]) => kind), ["weekly", "daily"]);
});

for (let failedLeg = 0; failedLeg < 4; failedLeg++) test(`reserve leg ${budgetKinds[failedLeg]} failure joins every reserve and acknowledged cleanup`, { timeout: 5_000 }, async t => {
  const owner = accountingOwner(t);
  await owner.run(async () => {
    const original = new HttpError(402, "budget_exhausted", "synthetic reservation denial");
    const reserves = budgetKinds.map(() => owner.gate()), cleanups = budgetKinds.map(() => owner.gate());
    const cleanupEntered = owner.gate(), calls = [], settled = [], observations = [];
    const env = mockEnv(async () => assert.fail("successful ledger cleanup needs no queue"));
    env.BUDGET_LEDGER.get = name => ({ fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (new URL(url).pathname === "/reserve") {
        const index = calls.length;
        calls.push({ name, id: body.reservationId });
        assert.deepEqual(observations[index], [body.reservationId, "attempted"]);
        await reserves[index].promise;
        if (index === failedLeg) throw original;
        return Response.json({ allowed: true, chargedMicros: 1 });
      }
      const index = calls.findIndex(item => item.id === body.reservationId);
      settled.push({ name, ...body });
      if (settled.length === 3) cleanupEntered.resolve();
      await cleanups[index].promise;
      return Response.json({ settled: true });
    } });
    const root = owner.start(reserveBudget(env, fourLegAuth, "llm.responses", budgetCost, budgetConnection,
      (leg, state) => observations.push([leg.request.reservationId, state])), result => result.failed && result.reason === original);
    assert.equal(calls.length, 4);
    reserves[failedLeg].resolve();
    await accountingTurn();
    assert.equal(root.settled, false);
    assert.deepEqual(settled, [], "no rollback before all reserve outcomes");
    for (const gate of reserves) gate.resolve();
    await owner.arrival(cleanupEntered.promise, root);
    const successes = calls.filter((_, index) => index !== failedLeg);
    assert.deepEqual(settled, successes.map(({ name, id }) => ({ name, reservationId: id, actualCostMicros: 0 })));
    assert.equal(root.settled, false, "all three cleanups started concurrently and remain held");
    const last = calls.findLastIndex((_, index) => index !== failedLeg);
    for (let index = 0; index < 4; index++) if (index !== last) cleanups[index].resolve();
    await accountingTurn();
    assert.equal(root.settled, false, "one held cleanup still owns completion");
    cleanups[last].resolve();
    const result = await root.outcome;
    assert.equal(result.failed, true);
    assert.equal(result.reason, original);
    assert.deepEqual(observations.filter(([, state]) => state === "denied"), [[calls[failedLeg].id, "denied"]]);
    assert.equal(calls.length, 4);
    assert.equal(settled.length, 3);
  });
});

for (const acknowledged of [false, true]) test(`plan-order undefined reservation rejection survives ${acknowledged ? "held cleanup" : "zero acknowledged successes"}`, { timeout: 5_000 }, async t => {
  const owner = accountingOwner(t);
  await owner.run(async () => {
    const gates = budgetKinds.map(() => owner.gate()), cleanup = owner.gate(), entered = owner.gate();
    const reasons = [undefined, new Error("second plan failure"), new Error("third plan failure"), new Error("fourth plan failure")];
    const calls = [], completed = [], settled = [];
    const env = mockEnv(async () => assert.fail("no queue needed"));
    env.BUDGET_LEDGER.get = () => ({ fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (new URL(url).pathname === "/settle") {
        settled.push(body); entered.resolve(); await cleanup.promise;
        return Response.json({ settled: true });
      }
      const index = calls.length; calls.push(body.reservationId);
      await gates[index].promise; completed.push(index);
      if (acknowledged && index === 3) return Response.json({ allowed: true, chargedMicros: 1 });
      throw reasons[index];
    } });
    const root = owner.start(reserveBudget(env, fourLegAuth, "llm.responses", budgetCost, budgetConnection), result => result.failed && result.reason === undefined);
    for (const index of [2, 1, 0]) { gates[index].resolve(); await accountingTurn(); assert.equal(root.settled, false); }
    assert.deepEqual(settled, []);
    gates[3].resolve();
    if (acknowledged) {
      await owner.arrival(entered.promise, root);
      assert.deepEqual(settled, [{ reservationId: calls[3], actualCostMicros: 0 }]);
      assert.equal(root.settled, false);
      cleanup.resolve();
    }
    assert.deepEqual(await root.outcome, { failed: true, reason: undefined });
    assert.deepEqual(completed, [2, 1, 0, 3]);
    assert.equal(settled.length, acknowledged ? 1 : 0);
  });
});

for (const serial of [false, true]) test(`${serial ? "Search" : "generic"} rollback retains every ordered ledger/queue failure privately`, { timeout: 5_000 }, async t => {
  const owner = accountingOwner(t);
  await owner.run(async () => {
    const shared = new Error("synthetic-private-shared-reason"), original = serial ? new HttpError(402, "budget_exhausted", "synthetic-private-reserve-reason") : undefined;
    const ledgerReasons = [undefined, null, shared, shared], queueReasons = [shared, null, undefined, shared];
    const gates = budgetKinds.map(() => owner.gate()), entries = budgetKinds.map(() => owner.gate()), entered = owner.gate();
    const calls = [], ledgerCalls = [], queueCalls = [], completed = [];
    const env = mockEnv(async message => {
      const index = calls.findIndex(item => item.id === message.request.reservationId);
      queueCalls.push(message);
      entries[index].resolve();
      if (queueCalls.length === 3) entered.resolve();
      await gates[index].promise; completed.push(index);
      throw queueReasons[index];
    });
    env.BUDGET_LEDGER.get = name => ({ fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (new URL(url).pathname === "/reserve") {
        const index = calls.length; calls.push({ name, id: body.reservationId });
        if (index === 1) throw original;
        return Response.json({ allowed: true, chargedMicros: 1 });
      }
      ledgerCalls.push({ name, ...body });
      throw ledgerReasons[calls.findIndex(item => item.id === body.reservationId)];
    } });
    const search = serial ? {
      operation: { signal: new AbortController().signal },
      controlJson: async (body, invoke, _required, signal) => (await invoke(JSON.stringify(body), signal)).json(),
      task: async start => start(),
    } : undefined;
    const root = owner.start(reserveBudget(env, fourLegAuth, "llm.responses", budgetCost, budgetConnection, undefined, { search }), result => result.failed && result.reason instanceof HttpError && result.reason.code === "accounting_unavailable");
    if (serial) {
      for (const index of [0, 2, 3]) {
        await owner.arrival(entries[index].promise, root);
        assert.equal(queueCalls.length, [0, 2, 3].indexOf(index) + 1);
        assert.equal(ledgerCalls.length, queueCalls.length);
        assert.equal(root.settled, false);
        gates[index].resolve();
      }
    } else {
      await owner.arrival(entered.promise, root);
      assert.equal(root.settled, false);
      for (const index of [3, 0]) { gates[index].resolve(); await accountingTurn(); assert.equal(root.settled, false); }
      gates[2].resolve();
    }
    const result = await root.outcome;
    assert.equal(result.failed, true);
    const error = result.reason;
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "accounting_unavailable");
    assert.equal(error.message, "Budget reservation rollback could not finish; retry after accounting recovers.");
    const symbols = Object.getOwnPropertySymbols(error);
    assert.equal(symbols.length, 1);
    const descriptor = Object.getOwnPropertyDescriptor(error, symbols[0]), diagnostics = descriptor.value;
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(Object.hasOwn(diagnostics, "reservationReason"), true);
    assert.equal(diagnostics.reservationReason, original);
    assert.equal(Object.isFrozen(diagnostics), true);
    assert.equal(Object.isFrozen(diagnostics.cleanupFailures), true);
    assert.deepEqual(diagnostics.cleanupFailures, [0, 2, 3].map(index => ({
      reservationId: calls[index].id, objectName: calls[index].name,
      ledgerReason: ledgerReasons[index], queueReason: queueReasons[index],
    })));
    for (const failure of diagnostics.cleanupFailures) {
      assert.equal(Object.isFrozen(failure), true);
      const index = calls.findIndex(item => item.id === failure.reservationId);
      assert.equal(failure.ledgerReason, ledgerReasons[index]);
      assert.equal(failure.queueReason, queueReasons[index]);
      assert.equal(Object.hasOwn(failure, "ledgerReason"), true);
      assert.equal(Object.hasOwn(failure, "queueReason"), true);
    }
    assert.deepEqual(completed, serial ? [0, 2, 3] : [3, 0, 2]);
    assert.deepEqual(ledgerCalls, [0, 2, 3].map(index => ({ name: calls[index].name, reservationId: calls[index].id, actualCostMicros: 0 })));
    assert.deepEqual(queueCalls, [0, 2, 3].map(index => ({ kind: "budget_settlement", ledger: { objectName: calls[index].name }, request: { reservationId: calls[index].id, actualCostMicros: 0 } })));
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { status: 503, code: "accounting_unavailable" });
    const response = caughtResponse(error, "fixture-request");
    const publicBody = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(publicBody, { error: { code: error.code, message: error.message } });
    assert.doesNotMatch(JSON.stringify(publicBody), /synthetic-private|reservationReason|cleanupFailures|ledgerReason|queueReason/);
  });
});

for (const original of [new HttpError(402, "budget_exhausted", "synthetic denied budget"), new Error("synthetic reserve failure")]) test(`successful queue recovery preserves original ${original instanceof HttpError ? "402" : "Error"} identity`, { timeout: 5_000 }, async t => {
  const owner = accountingOwner(t);
  await owner.run(async () => {
    const gate = owner.gate(), entered = owner.gate(), calls = [], queued = [], settled = [];
    const env = mockEnv(async message => { queued.push(message); if (queued.length === 3) entered.resolve(); await gate.promise; });
    env.BUDGET_LEDGER.get = name => ({ fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (new URL(url).pathname === "/reserve") {
        const index = calls.length; calls.push({ name, id: body.reservationId });
        if (index === 0) throw original;
        return Response.json({ allowed: true, chargedMicros: 1 });
      }
      settled.push(body); throw undefined;
    } });
    const root = owner.start(reserveBudget(env, fourLegAuth, "llm.responses", budgetCost, budgetConnection), result => result.failed && result.reason === original);
    await owner.arrival(entered.promise, root);
    assert.equal(root.settled, false);
    gate.resolve();
    const result = await root.outcome;
    assert.equal(result.failed, true);
    assert.equal(result.reason, original);
    assert.deepEqual(settled, calls.slice(1).map(({ id }) => ({ reservationId: id, actualCostMicros: 0 })));
    assert.deepEqual(queued, calls.slice(1).map(({ name, id }) => ({ kind: "budget_settlement", ledger: { objectName: name }, request: { reservationId: id, actualCostMicros: 0 } })));
    assert.deepEqual(Object.getOwnPropertySymbols(original), []);
  });
});

for (const serial of [false, true]) test(`exported settlement preserves first undefined failure and ${serial ? "Search serial" : "generic concurrent"} cleanup`, { timeout: 5_000 }, async t => {
  const owner = accountingOwner(t);
  await owner.run(async () => {
    const items = [0, 1, 2].map(index => ({ reservationId: `fixture-${index}`, objectName: `fixture-ledger-${index}` }));
    const gates = items.map(() => owner.gate()), entries = items.map(() => owner.gate()), ledgers = [], queues = [], mandatory = [];
    const reasons = [undefined, new Error("second settlement failure"), new Error("third settlement failure")];
    const env = mockEnv(async message => {
      const index = items.findIndex(item => item.reservationId === message.request.reservationId);
      queues.push(message); entries[index].resolve(); await gates[index].promise; throw reasons[index];
    });
    env.BUDGET_LEDGER.get = name => ({ fetch: async (_url, init) => { ledgers.push({ name, body: JSON.parse(init.body) }); throw new Error("synthetic ledger rejection"); } });
    // Model the existing Search call interface; this is not a Search physical-owner proof.
    const search = serial ? {
      controlJson: async (body, invoke, required) => { mandatory.push(required); return (await invoke(JSON.stringify(body))).json(); },
      task: async (start, required) => { mandatory.push(required); return start(); },
    } : undefined;
    const root = owner.start(settleBudget(env, { reservations: items, reservedMicros: 3 }, 7, search), result => result.failed && result.reason === undefined);
    if (serial) {
      for (let index = 0; index < 3; index++) {
        await owner.arrival(entries[index].promise, root);
        assert.equal(ledgers.length, index + 1);
        assert.equal(queues.length, index + 1);
        assert.equal(root.settled, false);
        gates[index].resolve();
      }
      assert.deepEqual(mandatory, Array(6).fill(true));
    } else {
      await owner.arrival(Promise.all(entries.map(entry => entry.promise)), root);
      assert.equal(ledgers.length, 3);
      assert.equal(queues.length, 3);
      for (const index of [2, 1]) { gates[index].resolve(); await accountingTurn(); assert.equal(root.settled, false); }
      gates[0].resolve();
    }
    assert.deepEqual(await root.outcome, { failed: true, reason: undefined });
    assert.deepEqual(ledgers, items.map(item => ({ name: item.objectName, body: { reservationId: item.reservationId, actualCostMicros: 7 } })));
    assert.deepEqual(queues, items.map(item => ({ kind: "budget_settlement", ledger: { objectName: item.objectName }, request: { reservationId: item.reservationId, actualCostMicros: 7 } })));
  });
});

function accountingOwner(t) {
  const gates = [], roots = [];
  let hasPrimary = false, primary;
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    const outcomes = await Promise.all(roots.map(root => root.outcome));
    const errors = [];
    for (let index = 0; index < roots.length; index++) {
      const outcome = outcomes[index];
      if (outcome.failed && (hasPrimary || !roots[index].expected(outcome))) errors.push(outcome.reason);
      else if (!outcome.failed && !roots[index].expected(outcome)) errors.push(new Error("unexpected accounting root fulfillment"));
    }
    if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, "accounting test and independent root outcomes");
  });
  return {
    gate() { const gate = Promise.withResolvers(); gates.push(gate); return gate; },
    start(promise, expected) {
      const root = { settled: false, expected };
      root.outcome = promise.then(value => { root.settled = true; return { failed: false, value }; }, reason => { root.settled = true; return { failed: true, reason }; });
      roots.push(root); return root;
    },
    async run(body) { try { await body(); } catch (error) { hasPrimary = true; primary = error; throw error; } },
    async arrival(promise, root) {
      let timer;
      try {
        await Promise.race([promise, root.outcome.then(result => { if (result.failed) throw result.reason; throw new Error("accounting root completed before expected phase"); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("accounting phase did not arrive")), 1_000); })]);
      } finally { clearTimeout(timer); }
    },
  };
}

function accountingTurn() { return new Promise(resolve => setImmediate(resolve)); }

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
