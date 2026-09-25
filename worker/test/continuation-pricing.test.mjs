import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../utils.ts";
import { fixture } from "./http-continuation-fixture.mjs";

const limit = 100_000_000;
const request = { input: [], service_tier: "priority", max_output_tokens: 32 };
const usage = { input_tokens: 14, output_tokens: 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
const rows = f => ["default:fixture", "provider:openai"].map(name => f.env.BUDGET_LEDGER.get(name).reservations());
const completed = id => ({ id, object: "response", status: "completed", output: [], service_tier: "priority", usage });

async function consume(f, body, status = 200) {
  const response = await f.request({ ...request, ...body });
  assert.equal(response.status, status, await response.clone().text());
  return JSON.parse(await f.consume(response));
}

for (const [name, policyLimit, providerLimit] of [["policy", limit, null], ["provider", null, limit], ["both", limit, limit]]) {
  test(`HTTP inherited hosted tools reject after ${name} budget activation without a new reservation`, async t => {
    const f = await fixture(t, false, { fixedCost: null });
    f.response = (_request, index) => Response.json(completed(`parent_${index}`));
    const parent = await consume(f, { input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }] });
    assert.equal(f.events[0].cost_basis, "unpriced_usage");
    const before = rows(f);
    if (policyLimit != null) await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, monthlyBudgetMicros: policyLimit } });
    await f.authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: providerLimit });
    const owners = f.bindings().flatMap(([, state]) => state.db.prepare("SELECT owner_json FROM http_continuations").all());
    assert.ok(owners.every(row => JSON.parse(row.owner_json).policyGeneration === "g1"));
    const policies = await (await f.authority("/policies/resolve", { policyIds: ["fixture"] })).json();
    assert.equal(policies.policies[0].policy.generation, "g1");
    const child = await consume(f, { previous_response_id: parent.id }, 400);
    assert.equal(child.error.code, "pricing_required");
    assert.equal(f.sent.length, 1);
    assert.equal(f.events.length, 2);
    assert.deepEqual([f.events[1].actual_cost_micros, f.events[1].cost_basis, f.events[1].status_code], [0, "none", 400]);
    assert.deepEqual(rows(f), before);
  });
}

for (const fixed of [null, 0, 7]) test(`inherited hosted work retains the explicit ${fixed ?? "unmetered"} tariff contract`, async t => {
  const f = await fixture(t, false, { fixedCost: 0 });
  f.response = (_request, index) => Response.json(completed(`response_${index}`));
  const parent = await consume(f, { input: [{ type: "tool_search_output", call_id: "call_fixture", execution: "client", tools: [{ type: "mcp" }] }] });
  const before = rows(f);
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, requestCostMicros: fixed, monthlyBudgetMicros: fixed == null ? null : limit } });
  await f.authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: fixed == null ? null : limit });
  await consume(f, { previous_response_id: parent.id });
  assert.equal(f.events.length, 2); assert.equal(f.sent.length, 2);
  assert.deepEqual([f.events[1].actual_cost_micros, f.events[1].cost_basis], [fixed ?? 0, fixed == null ? "unpriced_usage" : "policy_fixed"]);
  if (fixed == null) assert.deepEqual(rows(f), before);
  else for (const ledger of rows(f)) {
    assert.equal(ledger.length, 1);
    assert.deepEqual([ledger[0].reserved_micros, ledger[0].settled], [fixed, 1]);
  }
});

for (const state of ["legacy", "pending", "corrupt", "future", "unknown", "expired"]) test(`HTTP ${state} ancestry keeps routing and pricing outcomes distinct`, async t => {
  const f = await fixture(t, false, { limit, fixedCost: null });
  f.response = (_request, index) => Response.json(completed(`response_${index}`));
  const parent = await consume(f, {}), key = await sha256Hex(JSON.stringify(["response", parent.id]));
  const before = rows(f);
  for (const [, owner] of f.bindings()) {
    const row = owner.db.prepare("SELECT pricing_evidence_json FROM http_continuations WHERE binding_key = ?").get(key);
    if (!row) continue;
    const evidence = JSON.parse(row.pricing_evidence_json);
    const value = state === "legacy" ? null : state === "corrupt" ? "{" : JSON.stringify(state === "pending" ? { version: 1, producerId: evidence.producerId, state: "pending" } : { ...evidence, ...(state === "future" ? { version: 2 } : { knowledge: "unknown" }) });
    owner.db.prepare("UPDATE http_continuations SET pricing_evidence_json = ? WHERE binding_key = ?").run(value, key);
    if (state === "expired") owner.db.prepare("UPDATE http_continuations SET expires_at_ms = 0 WHERE binding_key = ?").run(key);
    owner.restart();
  }
  const child = await consume(f, { previous_response_id: parent.id }, state === "expired" ? 409 : 400);
  assert.equal(child.error.code, state === "expired" ? "continuation_restart_required" : "pricing_required");
  assert.equal(f.sent.length, 1); assert.equal(f.events.length, 2);
  assert.deepEqual([f.events[1].actual_cost_micros, f.events[1].cost_basis], [0, "none"]);
  assert.deepEqual(rows(f), before);
});

for (const stream of [false, true]) test(`clean ${stream ? "done-only sparse SSE" : "JSON"} ancestry remains measured once in both ledgers`, async t => {
  const f = await fixture(t, false, { limit, fixedCost: null });
  f.response = (_request, index) => {
    const id = `response_${index}`;
    if (!stream) return Response.json(completed(id));
    const frames = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "fixture", arguments: "{}" } },
      { type: "response.completed", response: { id, status: "completed", service_tier: "priority", usage } },
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const tools = [{ type: "function", name: "fixture" }, { type: "custom", name: "custom_fixture" }, { type: "tool_search", execution: "client" }];
  for (const body of [{ input: [{ type: "additional_tools", tools }] }, { previous_response_id: "response_1", input: [{ type: "function_call_output", call_id: "call_fixture", output: "result" }] }]) {
    const response = await f.request({ ...request, stream, ...body });
    assert.equal(response.status, 200); await f.consume(response);
  }
  assert.equal(f.events.length, 2); assert.equal(f.sent.length, 2);
  assert.ok(f.events.every(event => event.cost_basis === "manifest_pricing" && event.actual_cost_micros === 1_080));
  for (const ledger of rows(f)) {
    assert.equal(ledger.length, 2);
    assert.ok(ledger.every(row => row.settled === 1));
    assert.equal(ledger.reduce((sum, row) => sum + row.reserved_micros, 0), 2_160);
  }
});

test("a turn-only full-input reconnect uses routing affinity without inheriting response pricing", async t => {
  const f = await fixture(t, false, { fixedCost: 0 });
  f.response = (_request, index) => Response.json(completed(`response_${index}`), { headers: { "x-codex-turn-state": "turn_fixture" } });
  await consume(f, { input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }] });
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, requestCostMicros: null, monthlyBudgetMicros: limit } });
  await f.authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: limit });
  const response = await f.request({ ...request, input: "complete standalone input" }, { "x-codex-turn-state": "turn_fixture" });
  assert.equal(response.status, 200); await f.consume(response);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.previous_response_id, undefined);
  assert.equal(f.sent[1].headers.get("x-codex-turn-state"), "turn_fixture");
  assert.equal(f.events.length, 2);
  assert.deepEqual([f.events[1].cost_basis, f.events[1].actual_cost_micros], ["manifest_pricing", 1_080]);
  for (const ledger of rows(f)) {
    assert.equal(ledger.length, 1);
    assert.deepEqual([ledger[0].reserved_micros, ledger[0].settled], [1_080, 1]);
  }
});

for (const phase of ["resolve", "prepare"]) test(`${phase} failure preserves the original duration and one unsent receipt`, async t => {
  const f = await fixture(t, false, { limit, fixedCost: null });
  f.response = (_request, index) => Response.json(completed(`response_${index}`));
  await consume(f, {});
  let now = Date.now(), delayed = false;
  t.mock.method(Date, "now", () => now);
  f.env.ACCESS_CONTROL.beforeFetch = async (name, request) => {
    const path = new URL(request.url).pathname;
    if (delayed || (phase === "resolve" ? !name.startsWith("http-continuations:") : path !== "/connections/resolve")) return;
    delayed = true; now += 1234; throw new Error("fixture preflight outage");
  };
  const before = rows(f), child = await consume(f, { previous_response_id: "response_1" }, 503);
  assert.equal(child.error.code, phase === "resolve" ? "continuation_unavailable" : "provider_unavailable");
  assert.equal(delayed, true); assert.equal(f.sent.length, 1); assert.equal(f.events.length, 2);
  assert.equal(f.events[1].duration_ms, 1234);
  assert.deepEqual([f.events[1].actual_cost_micros, f.events[1].cost_basis], [0, "none"]);
  assert.deepEqual(rows(f), before);
});
