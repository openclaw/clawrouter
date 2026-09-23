import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markBudgetDispatched, reserveBudget, settleBudget } from "../accounting.ts";
import { budgetLedgerAddress, providerBudgetLedgerAddress } from "../budget-scope.ts";
import { BudgetLedgerObject, budgetStatus, providerBudgetStatus, queue } from "../ledgers.ts";
import { emptyUsageSnapshot } from "../usage-sharding.ts";

const { default: handler } = await import("../index.ts");
const { normalizePolicy } = await import("../admin.ts");
const { modelRoute } = await import("../providers.ts");
const minute = 60_000, day = 86_400_000;
const policy = normalizePolicy({ providers: ["openai"], tenantId: "provider", monthlyBudgetMicros: 100 }, undefined, false);
const auth = { policyId: "openai", policy };
const connection = { providerId: "openai", monthlyBudgetMicros: 100 };
const cost = { reserveMicros: 60, basis: "manifest_pricing" };
const policyAddress = budgetLedgerAddress(auth.policyId, policy), providerAddress = providerBudgetLedgerAddress("openai");
const name = policyAddress.objectName;

test("valid colliding policy and provider names admit and settle independent budgets", async (t) => {
  const f = fixture(t);
  assert.equal(name, providerAddress.objectName);
  assert.equal(policyAddress.windowKey, providerAddress.windowKey);
  assert.notEqual(policyAddress.scopeKey, providerAddress.scopeKey);
  const reserved = await reserveBudget(f.env, auth, "llm.responses", cost, connection);
  await markBudgetDispatched(f.env, reserved);
  await settleBudget(f.env, reserved, 25);
  assert.deepEqual(await f.spent(), [25, 25]);
  await assert.rejects(reserveBudget(f.env, { ...auth, policy: { ...policy, monthlyBudgetMicros: 200 } }, "llm.responses", { ...cost, reserveMicros: 76 }, connection), error => error.code === "provider_budget_exhausted");
  assert.deepEqual(await f.spent(), [25, 25], "provider denial releases only its paired policy reservation");
  await reserveBudget(f.env, auth, "llm.responses", { ...cost, reserveMicros: 75 }, connection);
  assert.deepEqual(await f.spent(), [100, 100]);
});

test("principal and policy scopes keep delimiter aliases isolated without changing storage addresses", async (t) => {
  const f = fixture(t);
  const principalPolicy = normalizePolicy({ providers: ["openai"], tenantId: "org", budgetScope: "principal", monthlyBudgetMicros: 100 }, undefined, false);
  const sharedPolicy = normalizePolicy({ providers: ["openai"], tenantId: "org:team", monthlyBudgetMicros: 100 }, undefined, false);
  const principal = budgetLedgerAddress("team", principalPolicy, "member"), shared = budgetLedgerAddress("member", sharedPolicy);
  assert.equal(principal.objectName, shared.objectName);
  assert.notEqual(principal.windowKey, shared.windowKey);
  assert.notEqual(principal.scopeKey, shared.scopeKey);
  assert.deepEqual(JSON.parse(principal.scopeKey), ["principal", "org", "team", "member"]);
  await reserveBudget(f.env, { policyId: "team", policy: principalPolicy, credentialId: "member" }, "llm.responses", cost);
  await reserveBudget(f.env, { policyId: "member", policy: sharedPolicy }, "llm.responses", cost);
  assert.equal((await budgetStatus(f.env, "team", principalPolicy, "member")).spentMicros, 60);
  assert.equal((await budgetStatus(f.env, "member", sharedPolicy)).spentMicros, 60);
  const escaped = budgetLedgerAddress("team", { ...principalPolicy, tenantId: "org/[\"principal\"]" }, "member:with/slashes@example.com");
  assert.deepEqual(JSON.parse(escaped.scopeKey), ["principal", "org/[\"principal\"]", "team", "member:with/slashes@example.com"]);
});

test("migration preserves untyped debt and older writers while receipt scope owns retries", async (t) => {
  const f = fixture(t);
  const object = f.object(name, db => {
    db.exec("CREATE TABLE budget_windows (window_key TEXT PRIMARY KEY, policy_id TEXT NOT NULL, spent_micros INTEGER NOT NULL)");
    db.exec("CREATE TABLE budget_reservations (reservation_id TEXT PRIMARY KEY, window_key TEXT NOT NULL, policy_id TEXT NOT NULL, reserved_micros INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, settled INTEGER NOT NULL, dispatch_started INTEGER NOT NULL DEFAULT 1)");
    db.prepare("INSERT INTO budget_windows VALUES (?, ?, 5)").run(policyAddress.windowKey, policyAddress.policyId);
    db.prepare("INSERT INTO budget_reservations VALUES (?, ?, ?, 10, ?, 0, 1)").run("legacy", policyAddress.windowKey, policyAddress.policyId, Date.now());
  });
  assert.deepEqual(await f.spent(), [15, 15]);
  const reserved = await reserveBudget(f.env, auth, "llm.responses", { ...cost, reserveMicros: 25 }, connection);
  await markBudgetDispatched(f.env, reserved);
  await settleBudget(f.env, reserved, 25);
  assert.deepEqual(await f.spent(), [40, 40]);
  assert.equal((await f.status(policyAddress, null)).spentMicros, 65);
  // The prior binary names its insert columns and aggregates the entire window.
  object.db.prepare("INSERT INTO budget_reservations (reservation_id, window_key, policy_id, reserved_micros, created_at_ms, settled, dispatch_started) VALUES (?, ?, ?, 7, ?, 0, 1)").run("older-writer", policyAddress.windowKey, policyAddress.policyId, Date.now());
  assert.equal(f.rows(name).find(row => row.reservation_id === "older-writer").budget_scope_key, null);
  const legacyRequest = { ...reserveRequest("untyped", 3), scopeKey: undefined };
  assert.equal((await (await f.call(name, "/reserve", legacyRequest)).json()).allowed, true);
  assert.deepEqual(await f.spent(), [50, 50]);
  assert.equal((await (await f.call(name, "/reserve", { ...legacyRequest, reservationId: "too-much", costMicros: 26 })).json()).allowed, false);
  const replay = await (await f.call(name, "/reserve", { ...reserveRequest(reserved.reservations[0].reservationId, 99), scopeKey: providerAddress.scopeKey, windowKey: "other-month" })).json();
  assert.equal(replay.windowKey, policyAddress.windowKey);
  assert.equal(replay.chargedMicros, 25);
  assert.equal(replay.spentMicros, 50);
  const oldReplay = await (await f.call(name, "/reserve", reserveRequest("legacy", 99))).json();
  assert.equal(oldReplay.spentMicros, 75, "typed replay must not adopt an untyped receipt");
  await f.call(name, "/settle", { reservationId: "legacy", actualCostMicros: 7 });
  assert.deepEqual(await f.spent(), [47, 47]);
  assert.equal(object.db.prepare("SELECT SUM(reserved_micros) AS spent FROM budget_reservations WHERE window_key = ?").get(policyAddress.windowKey).spent + 5, 72);
  f.restart(name);
  assert.deepEqual(await f.spent(), [47, 47]);
  assert.equal(f.rows(name).find(row => row.reservation_id === "legacy").budget_scope_key, null);
  assert.equal(f.rows(name).find(row => row.reservation_id === reserved.reservations[0].reservationId).budget_scope_key, policyAddress.scopeKey);
  assert.equal(object.db.prepare("SELECT spent_micros FROM budget_windows").get().spent_micros, 5);
});

for (const failedScope of ["policy", "provider"]) {
  test(`${failedScope} settlement recovers independently inside a colliding storage shard`, async (t) => {
    const f = fixture(t);
    const reserved = await reserveBudget(f.env, auth, "llm.responses", cost, connection);
    await markBudgetDispatched(f.env, reserved);
    const failed = reserved.reservations[failedScope === "policy" ? 0 : 1];
    f.failures.add(failed.reservationId);
    await settleBudget(f.env, reserved, 25);
    assert.deepEqual(await f.spent(), failedScope === "policy" ? [60, 25] : [25, 60]);
    f.advance(4 * day);
    assert.deepEqual(await f.spent(), failedScope === "policy" ? [60, 25] : [25, 60]);
    assert.equal(f.rows(name).find(row => row.reservation_id === failed.reservationId).settled, 2);
    const message = queued(f.messages[0]);
    await queue({ messages: [message] }, f.env);
    assert.equal(message.retries, 1);
    f.failures.clear();
    await queue({ messages: [message] }, f.env);
    await queue({ messages: [message] }, f.env);
    assert.equal(message.acks, 2);
    assert.deepEqual(await f.spent(), [25, 25]);
    assert.equal((await f.call(name, "/settle", { reservationId: failed.reservationId, actualCostMicros: 24 })).status, 409);
  });
}

test("scope and month remain immutable through expiry and late completion", async (t) => {
  const f = fixture(t, Date.parse("2026-09-30T23:59:00Z"));
  const oldWindow = "provider/openai/2026-09", nextWindow = "provider/openai/2026-10";
  for (const [kind, address] of [["policy", policyAddress], ["provider", providerAddress]]) {
    await f.call(name, "/reserve", { ...reserveRequest(kind, 60, address), windowKey: oldWindow });
    await f.call(name, "/dispatch", { reservationId: kind });
  }
  f.advance(20 * minute);
  for (const [kind, address] of [["policy", policyAddress], ["provider", providerAddress]]) {
    await f.call(name, "/reserve", { ...reserveRequest(`next-${kind}`, 90, address), windowKey: nextWindow });
    assert.equal(f.rows(name).find(row => row.reservation_id === kind).settled, 2);
    const settled = await (await f.call(name, "/settle", { reservationId: kind, actualCostMicros: 25 })).json();
    assert.equal(settled.spentMicros, 25);
    assert.equal((await f.status({ ...address, windowKey: oldWindow })).spentMicros, 25);
    assert.equal((await f.status({ ...address, windowKey: nextWindow })).spentMicros, 90);
    assert.equal((await f.call(name, "/dispatch", { reservationId: kind })).status, 409);
  }
});

test("typed and legacy final receipts share the bounded 45-day cleanup", async (t) => {
  const f = fixture(t);
  for (const typed of [false, true]) for (const state of ["abandoned", "conservative", "final"]) {
    const reservationId = `${typed}-${state}`;
    await f.call(name, "/reserve", { ...reserveRequest(reservationId, 10), scopeKey: typed ? policyAddress.scopeKey : undefined });
    if (state !== "abandoned") await f.call(name, "/dispatch", { reservationId });
    if (state === "final") await f.call(name, "/settle", { reservationId, actualCostMicros: 5 });
  }
  f.advance(20 * minute);
  await f.object(name).ledger.alarm();
  for (const row of f.rows(name)) {
    assert.equal(row.settled, row.reservation_id.endsWith("conservative") ? 2 : 1);
    if (row.reservation_id.endsWith("abandoned")) assert.equal(row.reserved_micros, 0);
  }
  f.advance(45 * day);
  await f.object(name).ledger.alarm();
  assert.deepEqual(f.rows(name), []);
  const message = queued({ kind: "budget_settlement", ledger: { objectName: name }, request: { reservationId: "true-conservative", actualCostMicros: 5 } });
  await queue({ messages: [message] }, f.env);
  assert.equal(message.acks, 0);
  assert.equal(message.retries, 1);
});

test("HTTP and native requests reserve 60 in each colliding budget and settle 25 in each", async (t) => {
  const model = modelRoute("openai/gpt-4.1-mini").model, originalPricing = model.pricing;
  // Synthetic per-output-token rates keep this scope test independent of rate-card changes.
  model.pricing = { ...originalPricing, inputMicrosPerMillion: 0, outputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: null, serviceTiers: [] };
  t.after(() => { model.pricing = originalPricing; });
  const secret = "fixture_key_material", digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  for (const path of ["/v1/responses", "/v1/native/openai/v1/responses"]) {
    const f = fixture(t), events = [], pending = [];
    Object.assign(f.env, {
      OPENAI_API_KEY: "fixture-upstream-key",
      POLICY_KV: { get: async keys => Array.isArray(keys) ? new Map() : null },
      USAGE_QUEUE: { send: async event => events.push(event) },
      USAGE_LEDGER: { idFromName: value => value, get: () => ({ fetch: async () => Response.json(emptyUsageSnapshot()) }) },
      ACCESS_CONTROL: { idFromName: value => value, get: () => ({ fetch: async url => {
        const route = new URL(url).pathname;
        if (route === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture_key", credential: { enabled: true, secretSha256: digest, policyId: "openai", policyGeneration: policy.generation } }], missingCredentialIds: [] });
        if (route === "/policies/resolve") return Response.json({ initialized: true, policies: [auth], missingPolicyIds: [] });
        if (route === "/connections/resolve") return Response.json({ initialized: true, connections: [{ ...connection, enabled: true }], missingProviderIds: [] });
        if (route === "/grant-pools/resolve") return Response.json({ keys: [], states: {}, ready: true });
        throw new Error(`unexpected authority path ${route}`);
      } }) },
    });
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      assert.deepEqual(await f.spent(), [60, 60]);
      assert.equal(f.rows(name).length, 2);
      assert.ok(f.rows(name).every(row => row.dispatch_started === 1));
      return Response.json({ status: "completed", usage: { input_tokens: 0, output_tokens: 25, total_tokens: 25 } });
    });
    const headers = { authorization: `Bearer clawrouter-live-fixture_key-${secret}`, "content-type": "application/json" };
    const response = await handler.fetch(new Request(`https://router.example${path}`, { method: "POST", headers, body: JSON.stringify({ model: model.id, input: "fixture", max_output_tokens: 60 }) }), f.env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].reserved_cost_micros, 60);
    assert.equal(events[0].actual_cost_micros, 25);
    assert.equal(events[0].cost_basis, "manifest_pricing");
    const usage = await handler.fetch(new Request("https://router.example/v1/usage", { headers }), f.env, {});
    assert.equal((await usage.json()).budget.spentMicros, 25);
    assert.deepEqual(await f.spent(), [25, 25]);
    upstream.mock.restore();
  }
});

function reserveRequest(reservationId, costMicros, address = policyAddress) {
  return { reservationId, policyId: address.policyId, windowKey: address.windowKey, scopeKey: address.scopeKey, limitMicros: 100, costMicros, capability: "llm.responses" };
}

function queued(body) { return { body, acks: 0, retries: 0, ack() { this.acks++; }, retry() { this.retries++; } }; }

function fixture(t, initialNow = Date.now()) {
  let now = initialNow;
  t.mock.method(Date, "now", () => now);
  const objects = new Map(), failures = new Set(), messages = [];
  function object(objectName, seed) {
    if (!objects.has(objectName)) {
      const db = new DatabaseSync(":memory:");
      t.after(() => db.close());
      seed?.(db);
      const sql = { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } };
      const state = { storage: { sql, getAlarm: async () => 1 } };
      objects.set(objectName, { db, state, ledger: new BudgetLedgerObject(state) });
    }
    return objects.get(objectName);
  }
  const call = (objectName, path, body) => object(objectName).ledger.fetch(new Request(`https://budget${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined));
  const env = {
    BUDGET_LEDGER: { idFromName: value => value, get: objectName => ({ fetch: async (url, init) => {
      if (new URL(url).pathname === "/settle" && failures.has(JSON.parse(init.body).reservationId)) throw new Error("fixture settlement outage");
      return object(objectName).ledger.fetch(new Request(url, init));
    } }) },
    USAGE_QUEUE: { send: async message => messages.push(message) },
  };
  return {
    env, messages, failures, object, call, advance: delta => { now += delta; },
    restart: objectName => { const current = object(objectName); current.ledger = new BudgetLedgerObject(current.state); },
    rows: objectName => object(objectName).db.prepare("SELECT * FROM budget_reservations ORDER BY reservation_id").all(),
    spent: async () => [(await budgetStatus(env, auth.policyId, policy)).spentMicros, (await providerBudgetStatus(env, "openai", 100)).spentMicros],
    status: async (address, scope = address.scopeKey) => {
      const query = new URLSearchParams({ policy_id: address.policyId, window_key: address.windowKey, limit_micros: "100" });
      if (scope != null) query.set("scope_key", scope);
      return (await call(address.objectName, `/status?${query}`)).json();
    },
  };
}
