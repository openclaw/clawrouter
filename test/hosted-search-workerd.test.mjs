import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

test("hosted search JSON and fragmented SSE traverse real HTTP/workerd, queue and durable SQL once", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-hosted-search-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
      export * from "./worker/index.ts";
      export class BudgetLedgerObject extends RealBudgetLedger {
        constructor(state) { super(state); this.sqlFixture = state.storage.sql; }
        async fetch(request) {
          if (new URL(request.url).pathname === "/fixture-charges") return Response.json([...this.sqlFixture.exec("SELECT settled, reserved_micros FROM budget_reservations")]);
          return super.fetch(request);
        }
      }
      export default handler;
    `, `let calls = 0; export default { async fetch(request) {
      if (new URL(request.url).pathname === "/fixture-count") return Response.json(calls);
      calls++;
      const body = await request.json();
      if (new URL(request.url).pathname !== "/v1/responses" || body.model !== "gpt-4.1-mini" || request.headers.get("authorization") !== "Bearer fixture-upstream-key") throw new Error("unexpected synthetic hosted search request");
      const item = { type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", query: "synthetic private query" } };
      const response = { object: "response", id: "resp_fixture_" + calls, status: "completed", service_tier: "default", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
      if (!body.stream) return Response.json(response);
      const events = [{ type: "response.output_item.added", output_index: 0, item: { ...item, action: undefined, status: "in_progress" } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
      const bytes = new TextEncoder().encode(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join("")); let offset = 0;
      return new Response(new ReadableStream({ pull(controller) { if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } else controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    } };`);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), limit = 1_000_000, secret = "search-fixture-secret";
    for (const [id, mode] of [["fixture", "soft"], ["reserve", "reserve"]]) {
      await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false, budgetMode: mode }));
      await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: id, policyGeneration: "g1" }));
    }
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    const headers = { authorization: "Bearer clawrouter-live-fixture-" + secret, "content-type": "application/json" }, origin = await mf.ready;
    const body = stream => JSON.stringify({ model: "openai/gpt-4.1-mini", input: "synthetic private input", tools: [{ type: "web_search" }], max_output_tokens: 32, stream });
    for (const stream of [false, true]) {
      const response = await fetch(new URL("/v1/responses", origin), { method: "POST", headers, body: body(stream), signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("x-clawrouter-content-retention"), "off");
      const value = await response.text(); assert.match(value, /web_search_call/);
    }
    const deadline = Date.now() + 5_000; let snapshot;
    do {
      const response = await fetch(new URL("/v1/usage", origin), { headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200); snapshot = await response.json();
      if (snapshot.usage.events.length === 2 && snapshot.budget.spentMicros === 20_112) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(snapshot.budget.spentMicros, 20_112); assert.equal(snapshot.usage.events.length, 2);
    for (const event of snapshot.usage.events) {
      assert.deepEqual(event.hosted_tool_calls, { web_search: 1 }); assert.equal(event.hosted_tool_calls_complete, true);
      assert.equal(event.hosted_tool_cost_micros, 10_000); assert.equal(event.actual_cost_micros, 10_056);
      assert.equal(event.cost_basis, "unpriced_usage"); assert.equal(event.content_retained, false);
      assert.equal(event.auth_type, "proxy_key"); assert.equal(event.credential_id, "fixture");
      assert.doesNotMatch(JSON.stringify(event), /synthetic private|fixture-upstream-key/);
    }
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    for (const name of ["default:fixture", "provider:openai"]) {
      const stub = budgets.get(budgets.idFromName(name));
      assert.deepEqual(await (await stub.fetch("https://budget/fixture-charges")).json(), [{ settled: 1, reserved_micros: 10_056 }, { settled: 1, reserved_micros: 10_056 }]);
    }
    const upstream = await mf.getWorker("upstream");
    assert.equal(await (await upstream.fetch("https://api.openai.com/fixture-count")).json(), 2);
    const denied = await fetch(new URL("/v1/responses", origin), { method: "POST", headers: { ...headers, authorization: "Bearer clawrouter-live-reserve-" + secret }, body: body(false), signal: AbortSignal.timeout(5_000) });
    assert.equal(denied.status, 400); assert.equal((await denied.json()).error.code, "pricing_required");
    assert.equal(await (await upstream.fetch("https://api.openai.com/fixture-count")).json(), 2);
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
