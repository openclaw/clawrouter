import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

const router = `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.sqlFixture = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-charges") return Response.json([...this.sqlFixture.exec("SELECT settled, reserved_micros FROM budget_reservations")]);
    return super.fetch(request);
  }
}
export default handler;`;
const upstream = `
let calls = 0;
export default { async fetch(request) {
  if (new URL(request.url).pathname === "/fixture-count") return Response.json(calls);
  calls++;
  const body = await request.json(), mode = body.messages[0].content;
  if (new URL(request.url).pathname !== "/v1/messages" || request.headers.get("x-api-key") !== "fixture-pool-anthropic-key" || body.model !== "claude-opus-5-5") throw new Error("unexpected synthetic request");
  const search = body.tools.some(tool => tool.name === "web_search");
  const usage = { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, server_tool_use: search ? { web_search_requests: mode === "invalid" ? -1 : mode === "zero" ? 0 : 2 } : { web_fetch_requests: 3 } };
  if (mode === "missing") delete usage.server_tool_use;
  const message = { type: "message", content: [{ type: "server_tool_use", name: search ? "web_search" : "web_fetch", id: "srvtoolu_fixture", input: { query: "synthetic private query" } }], stop_reason: "end_turn", usage };
  if (mode === "reject") return Response.json({ type: "error", error: { type: "invalid_request_error", message: "synthetic rejection" } }, { status: 400 });
  if (!body.stream) return Response.json(message);
  const initial = { ...usage, output_tokens: 0, input_tokens: 100, server_tool_use: search ? { web_search_requests: 0 } : { web_fetch_requests: 0 } };
  if (mode === "missing") delete initial.server_tool_use;
  const events = [{ type: "message_start", message: { type: "message", content: [], usage: initial } }, { type: "content_block_start", index: 0, content_block: message.content[0] }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }, { type: "message_delta", delta: {}, usage: { output_tokens: 20 } }];
  if (mode !== "truncated") events.push({ type: "message_stop" });
  const bytes = new TextEncoder().encode(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } else controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
} };`;

async function fixture(t, providerLimit = null) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-anthropic-web-tools-"));
  const mf = await startWorkerdFixture(temporary, router, upstream);
  t.after(async () => { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); });
  const kv = await mf.getKVNamespace("POLICY_KV", "router"), secret = "web-tools-fixture-secret", limit = 1_000_000;
  for (const [id, mode, fixed, policyLimit] of [["soft", "soft", null, limit], ["reserve", "reserve", null, limit], ["unmetered", "reserve", null, null], ["fixed", "reserve", 7, limit]]) {
    await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "fixture", monthlyBudgetMicros: policyLimit, requestCostMicros: fixed, retainRequestContent: false, budgetMode: mode }));
    await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: id, policyGeneration: "g1" }));
    await kv.put("oauth/" + id + "/anthropic", JSON.stringify({ provider: "anthropic", kind: "api_key", enabled: true, credential: "fixture-pool-anthropic-key", updatedAt: "2026-01-01T00:00:00Z" }));
  }
  await kv.put("connections/anthropic", JSON.stringify({ providerId: "anthropic", enabled: true, monthlyBudgetMicros: providerLimit }));
  const origin = await mf.ready;
  const headers = id => ({ authorization: "Bearer clawrouter-live-" + id + "-" + secret, "content-type": "application/json" });
  const send = (id, { stream = false, fetchOnly = false, mode = "normal", maxUses = 3, route = "/v1/messages" } = {}) => fetch(new URL(route, origin), { method: "POST", headers: { ...headers(id), "x-request-id": id + "-" + mode + "-" + stream }, body: JSON.stringify({ model: route.startsWith("/v1/native/") ? "claude-opus-5-5" : "anthropic/claude-opus-5-5", max_tokens: 32, messages: [{ role: "user", content: mode }], stream, tools: [{ type: fetchOnly ? "web_fetch_20250910" : "web_search_20250305", name: fetchOnly ? "web_fetch" : "web_search", ...(maxUses === null ? {} : { max_uses: maxUses }) }] }), signal: AbortSignal.timeout(10_000) });
  const usage = async (id, count) => {
    const deadline = Date.now() + 5000; let value;
    do {
      value = await (await fetch(new URL("/v1/usage", origin), { headers: headers(id), signal: AbortSignal.timeout(5000) })).json();
      if (value.usage.events.length === count) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail("usage event count not observed: " + JSON.stringify(value));
  };
  const ledger = async id => { const ns = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router"); return (await ns.get(ns.idFromName("fixture:" + id)).fetch("https://budget/fixture-charges")).json(); };
  const count = async () => (await (await mf.getWorker("upstream")).fetch("https://api.anthropic.com/fixture-count")).json();
  return { send, usage, ledger, count };
}

// $4/M input, $0.20/M cache read, $5/M 5m write, $8/M 1h write, $20/M output.
const tokenCost = 4000 + 20 + 50 + 160 + 400;
test("Claude web search bills authoritative cumulative JSON/SSE usage once, including unmetered keys", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const id of ["soft", "unmetered"]) {
    for (const stream of [false, true]) {
      const response = await f.send(id, { stream, route: stream ? "/v1/native/anthropic/v1/messages" : "/v1/messages" });
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(await response.text(), /server_tool_use/);
    }
    const report = await f.usage(id, 2);
    for (const event of report.usage.events) {
      assert.equal(event.input_tokens, 1130); assert.equal(event.output_tokens, 20);
      assert.deepEqual(event.hosted_tool_calls, { web_search: 2 }); assert.equal(event.hosted_tool_calls_complete, true);
      assert.equal(event.hosted_tool_cost_micros, 20000); assert.equal(event.actual_cost_micros, 20000 + tokenCost);
      assert.equal(event.cost_basis, "manifest_pricing"); assert.equal(event.content_retained, false);
      assert.doesNotMatch(JSON.stringify(event), /synthetic private query|fixture-pool-anthropic-key/);
    }
    if (id === "soft") { assert.equal(report.budget.spentMicros, 2 * (20000 + tokenCost)); assert.deepEqual(await f.ledger(id), Array.from({ length: 2 }, () => ({ settled: 1, reserved_micros: 20000 + tokenCost }))); }
    else assert.equal(report.budget.spentMicros, null);
  }
  assert.equal(await f.count(), 4);
});

test("Claude fetch has token costs only; missing search counters keep measured tokens without inventing a fee", { timeout: 60_000 }, async t => {
  const f = await fixture(t); let n = 0, expected = 0;
  for (const stream of [false, true]) for (const mode of ["fetch", "zero", "missing", "invalid", "reject", ...(stream ? ["truncated"] : [])]) {
    const response = await f.send("soft", { stream, fetchOnly: mode === "fetch", mode });
    assert.equal(response.status, mode === "reject" ? 400 : 200); await response.text();
    const report = await f.usage("soft", ++n), event = report.usage.events.find(row => row.request_id === "soft-" + mode + "-" + stream);
    assert.ok(event);
    const charged = mode === "reject" || mode === "truncated" ? 0 : tokenCost; expected += charged;
    assert.equal(report.budget.spentMicros, expected);
    assert.equal(report.usage.events.reduce((sum, row) => sum + row.actual_cost_micros, 0), expected);
    assert.equal(event.actual_cost_micros, charged);
    assert.equal(event.cost_basis, mode === "reject" ? "none" : ["missing", "invalid", "truncated"].includes(mode) ? "unpriced_usage" : "manifest_pricing");
    if (mode === "fetch") assert.equal(event.hosted_tool_cost_micros, undefined);
    else if (mode !== "reject") {
      assert.equal(event.hosted_tool_cost_micros, mode === "zero" ? 0 : null);
      assert.equal(event.hosted_tool_calls_complete, mode === "zero");
    }
  }
  assert.equal((await f.ledger("soft")).length, n);
});

test("max_uses bounds search fees but not cumulative server-loop tokens: hard budgets never dispatch", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const fetchOnly of [false, true]) for (const maxUses of [1, null, -1, "2"]) {
    const response = await f.send("reserve", { fetchOnly, maxUses });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
  }
  assert.equal(await f.count(), 0); assert.deepEqual(await f.ledger("reserve"), []);
  const fixed = await f.send("fixed"); assert.equal(fixed.status, 200); await fixed.text();
  const report = await f.usage("fixed", 1);
  assert.equal(report.usage.events[0].actual_cost_micros, 7); assert.equal(report.usage.events[0].cost_basis, "policy_fixed");
  assert.equal(report.budget.spentMicros, 7); assert.equal(await f.count(), 1);
});

test("a provider-only hard budget also rejects an unqualified Claude server loop before dispatch", { timeout: 60_000 }, async t => {
  const f = await fixture(t, 1_000_000);
  for (const fetchOnly of [false, true]) for (const maxUses of [1, null]) {
    const response = await f.send("unmetered", { fetchOnly, maxUses });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
  }
  assert.equal(await f.count(), 0); assert.deepEqual(await f.ledger("unmetered"), []);
});
