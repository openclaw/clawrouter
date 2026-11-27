import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

test("binary speech traverses the actual Worker and settles both durable SQL ledgers", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-speech-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
      export * from "./worker/index.ts";
      export class BudgetLedgerObject extends RealBudgetLedger {
        constructor(state) { super(state); this.sqlFixture = state.storage.sql; }
        async fetch(request) {
          if (new URL(request.url).pathname === "/fixture-reservations") return Response.json([...this.sqlFixture.exec("SELECT settled, dispatch_started, reserved_micros FROM budget_reservations")]);
          return super.fetch(request);
        }
      }
      export default handler;
    `, `export default { async fetch(request) {
      const body = await request.json();
      if (new URL(request.url).pathname !== "/v1/audio/speech" || body.model !== "tts-1" || body.input !== "é😀" || body.voice !== "alloy") throw new Error("unexpected synthetic speech request");
      return new Response(new Uint8Array([0, 255, 128, 42]), { headers: { "content-type": "audio/mpeg" } });
    } };`);
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    const secret = "speech-fixture-secret", limit = 1_000_000;
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    const headers = { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json" };
    const origin = await mf.ready;
    const response = await fetch(new URL("/v1/audio/speech", origin), { method: "POST", headers, body: JSON.stringify({ model: "openai/tts-1", input: "é😀", voice: "alloy" }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(response.headers.get("x-clawrouter-content-retention"), "off");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 128, 42]));
    const deadline = Date.now() + 5_000;
    let usage;
    do {
      const result = await fetch(new URL("/v1/usage", origin), { headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(result.status, 200); usage = await result.json();
      if (usage.usage.events.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(usage.usage.events.length, 1);
    const event = usage.usage.events[0];
    assert.equal(event.reserved_cost_micros, 90); assert.equal(event.actual_cost_micros, 30);
    assert.equal(event.cost_basis, "request_character_estimate"); assert.equal(event.total_tokens, null);
    assert.equal(event.content_retained, false); assert.equal(usage.budget.spentMicros, 30);
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    for (const name of ["default:fixture", "provider:openai"]) {
      const stub = budgets.get(budgets.idFromName(name));
      assert.deepEqual(await (await stub.fetch("https://budget/fixture-reservations")).json(), [{ settled: 1, dispatch_started: 1, reserved_micros: 30 }]);
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
