import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

const upstream = `let calls = 0; export default { async fetch(request) {
  if (new URL(request.url).pathname === "/fixture-count") return Response.json(calls);
  calls++;
  if (new URL(request.url).pathname === "/v1/messages/count_tokens") return Response.json({ input_tokens: 10 });
  const body = await request.json(), scenario = body.metadata?.user_id;
  if (new URL(request.url).pathname !== "/v1/messages" || request.headers.get("x-api-key") !== "fixture-anthropic-key") throw new Error("unexpected fixture request");
  if (scenario === "rejected") return Response.json({ type: "error", error: { type: "overloaded_error", message: "fixture" } }, { status: 529 });
  const usage = { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 }, output_tokens: 20,
    speed: scenario === "standard" ? "standard" : body.speed ?? "standard",
    inference_geo: scenario === "global" ? "global" : body.inference_geo ?? "us",
    service_tier: scenario === "priority" ? "priority" : "standard" };
  if (scenario === "invalid") usage.inference_geo = "unknown";
  if (scenario === "missing") delete usage.inference_geo;
  if (scenario === "null") usage.speed = null;
  if (scenario === "batch") usage.service_tier = "batch";
  if (scenario === "long") usage.input_tokens = 200001;
  if (scenario === "refusal") { usage.output_tokens = 0; delete usage.inference_geo; }
  const message = { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text: "fixture" }], stop_reason: "end_turn", usage };
  if (scenario === "refusal") { message.content = []; message.stop_reason = "refusal"; }
  if (scenario === "oversized") message.content[0].text = "x".repeat(2 * 1024 * 1024 + 1);
  if (!body.stream) return Response.json(message);
  const events = [ { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    ...(scenario === "refusal" ? [] : [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: message.content[0].text } }]),
    { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" } ];
  if (scenario === "late-invalid") events[2].usage.speed = "unknown";
  const newline = scenario === "cr" ? "\\r" : scenario === "lf" ? "\\n" : "\\r\\n";
  const bytes = new TextEncoder().encode(events.map(event => "event: " + event.type + newline + "data: " + JSON.stringify(event) + newline + newline).join("")); let offset = 0;
  const stride = scenario === "oversized" ? 65536 : 7;
  return new Response(new ReadableStream({ pull(controller) { if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + stride)); offset += stride; } else controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
} };`;

test("Anthropic modifiers traverse real Worker admission, usage inspection, queue and durable budgets", { timeout: 90_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-anthropic-modifiers-")); let mf;
  try {
    mf = await startWorkerdFixture(temporary, `export { default } from "./worker/index.ts"; export * from "./worker/index.ts";`, upstream);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), origin = await mf.ready;
    await kv.put("connections/anthropic", JSON.stringify({ providerId: "anthropic", enabled: true, monthlyBudgetMicros: null }));
    const service = await mf.getWorker("upstream"), calls = async () => (await service.fetch("https://api.anthropic.com/fixture-count")).json();
    let serial = 0;
    async function fixture(overrides = {}, policy = {}, path = "/v1/messages") {
      const id = "case" + ++serial, secret = "modifier-fixture-secret", headers = { authorization: `Bearer clawrouter-live-${id}-${secret}`, "content-type": "application/json", "anthropic-beta": "fast-mode-2026-02-01" };
      await kv.put("policies/" + id, JSON.stringify({ enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "fixture", monthlyBudgetMicros: 10_000_000, requestCostMicros: null, retainRequestContent: false, ...policy }));
      await kv.put("credentials/" + id, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: id, policyGeneration: "g1" }));
      await kv.put("oauth/" + id + "/anthropic", JSON.stringify({ provider: "anthropic", kind: "api_key", enabled: true, credential: "fixture-anthropic-key", updatedAt: "2026-01-01T00:00:00Z" }));
      const body = { model: "anthropic/claude-opus-5-5", max_tokens: 1000, speed: "fast", inference_geo: "us", service_tier: "standard_only", messages: [{ role: "user", content: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral", ttl: "1h" } }] }], ...overrides };
      const response = await fetch(new URL(path, origin), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      const deadline = Date.now() + 5_000; let snapshot;
      do {
        snapshot = await (await fetch(new URL("/v1/usage", origin), { headers, signal: AbortSignal.timeout(5_000) })).json();
        if (snapshot.usage.events.length === 1 && (!snapshot.budget.configured || snapshot.budget.spentMicros === snapshot.usage.events[0].actual_cost_micros)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.equal(snapshot.usage.events.length, 1, JSON.stringify({ status: response.status, text, snapshot }));
      return { response, text, event: snapshot.usage.events[0], budget: snapshot.budget, body };
    }
    for (const stream of [false, true]) {
      await t.test(`fast + US composes all cache buckets (${stream ? "SSE" : "JSON"})`, async () => {
        const { response, text, event, budget, body } = await fixture({ stream });
        assert.equal(response.status, 200, text);
        assert.match(text, /fixture/);
        // $4 input, $.2 reads, $5 5m writes, $8 1h writes, $20 output per MTok, times 2 * 1.1.
        assert.equal(event.actual_cost_micros, 6160);
        assert.equal(event.served_service_tier, "standard");
        assert.equal(event.cost_basis, "manifest_pricing");
        assert.equal(budget.spentMicros, 6160);
        const input = Buffer.byteLength(JSON.stringify({ ...body, model: "claude-opus-5-5" })) + 1024;
        assert.equal(event.reserved_cost_micros, Math.ceil(input * 17.6) + 44000);
      });
      await t.test(`response speed and geo override request (${stream ? "SSE" : "JSON"})`, async () => {
        const standard = await fixture({ stream, metadata: { user_id: "standard" } });
        assert.equal(standard.event.actual_cost_micros, 3080);
        const global = await fixture({ stream, inference_geo: undefined, metadata: { user_id: "global" } });
        assert.equal(global.event.actual_cost_micros, 5600);
        const input = Buffer.byteLength(JSON.stringify({ ...global.body, model: "claude-opus-5-5" })) + 1024;
        assert.equal(global.event.reserved_cost_micros, Math.ceil(input * 17.6) + 44000);
      });
      for (const scenario of ["priority", "batch", "invalid", "null", "missing", "oversized", ...(stream ? ["late-invalid"] : [])]) {
        await t.test(`unknown response price fails safe: ${scenario} (${stream ? "SSE" : "JSON"})`, async () => {
          const { response, text, event, budget } = await fixture({ stream, ...(scenario === "missing" ? { inference_geo: undefined } : {}), metadata: { user_id: scenario } });
          assert.equal(response.status, stream ? 200 : 502);
          assert.match(text, /pricing_required/);
          assert.equal(event.cost_basis, "unpriced_usage");
          assert.equal(event.status, "provider_error");
          assert.equal(event.actual_cost_micros, event.reserved_cost_micros);
          assert.equal(budget.spentMicros, event.reserved_cost_micros);
        });
      }
    }
    for (const [model, actual] of [["claude-opus-5", 8250], ["claude-opus-4-8", 8250]]) await t.test(`published fast rate: ${model}`, async () => {
      const { response, event } = await fixture({ model: `anthropic/${model}` });
      assert.equal(response.status, 200); assert.equal(event.actual_cost_micros, actual);
    });
    for (const scenario of ["cr", "lf"]) await t.test(`SSE preserves ${scenario} delimiters`, async () => {
      const { response, event, text } = await fixture({ stream: true, metadata: { user_id: scenario } });
      assert.equal(response.status, 200); assert.equal(event.actual_cost_micros, 6160);
      assert.match(text, /message_stop/); assert.doesNotMatch(text, /pricing_required/);
    });
    for (const stream of [false, true]) await t.test(`known free refusal needs no geo tariff (${stream})`, async () => {
      const { response, event } = await fixture({ stream, inference_geo: undefined, metadata: { user_id: "refusal" } });
      assert.equal(response.status, 200); assert.equal(event.actual_cost_micros, 0); assert.equal(event.cost_basis, "none");
    });
    await t.test("fast rate stays flat above 200k context and multiplies every category", async () => {
      const { response, event } = await fixture({ messages: [{ role: "user", content: "x".repeat(210000) }], metadata: { user_id: "long" } });
      assert.equal(response.status, 200); assert.equal(event.actual_cost_micros, 1765289);
    });
    await t.test("explicit request geo remains a qualified fallback when usage omits geo", async () => {
      const { response, event } = await fixture({ metadata: { user_id: "missing" } });
      assert.equal(response.status, 200); assert.equal(event.actual_cost_micros, 6160);
    });
    await t.test("unmetered unknown modifiers stay passthrough but explicitly unpriced", async () => {
      const { response, event } = await fixture({ metadata: { user_id: "priority" } }, { monthlyBudgetMicros: null });
      assert.equal(response.status, 200); assert.equal(event.cost_basis, "unpriced_usage"); assert.equal(event.actual_cost_micros, 0);
    });
    await t.test("soft auto may settle an authoritative standard response", async () => {
      const { response, event, budget } = await fixture({ model: "anthropic/claude-opus-4-8", service_tier: "auto" }, { budgetMode: "soft" });
      assert.equal(response.status, 200); assert.equal(event.cost_basis, "manifest_pricing");
      assert.equal(event.actual_cost_micros, 8250); assert.equal(budget.spentMicros, 8250);
    });
    await t.test("count_tokens remains free without a generation price contract", async () => {
      const { response, event, budget } = await fixture({ model: "anthropic/claude-haiku-4-5", speed: undefined, inference_geo: undefined, service_tier: undefined }, {}, "/v1/messages/count_tokens");
      assert.equal(response.status, 200); assert.equal(event.cost_basis, "none"); assert.equal(event.actual_cost_micros, 0); assert.equal(budget.spentMicros, 0);
    });
    for (const modifiers of [ { speed: "turbo" }, { inference_geo: "eu" }, { service_tier: "priority" },
      { model: "anthropic/claude-sonnet-5", speed: "fast" }, { model: "anthropic/claude-opus-4-8", service_tier: "auto" },
      { model: "anthropic/claude-opus-4-8", service_tier: undefined }, { model: "anthropic/claude-haiku-4-5", speed: "standard", inference_geo: "us" } ]) {
      await t.test(`unpriced request denied before dispatch: ${JSON.stringify(modifiers)}`, async () => {
        const before = await calls(), { response, text, event } = await fixture(modifiers);
        assert.equal(response.status, 400, text); assert.match(text, /pricing_required/);
        assert.equal(await calls(), before); assert.equal(event.actual_cost_micros, 0);
      });
    }
    await t.test("higher reservation denies a request that would fit base price", async () => {
      const before = await calls(), { response, text } = await fixture({}, { monthlyBudgetMicros: 40_000 });
      assert.equal(response.status, 402, text); assert.equal(await calls(), before);
    });
    await t.test("upstream rejection releases the multiplied reservation", async () => {
      const { response, event, budget } = await fixture({ metadata: { user_id: "rejected" } });
      assert.equal(response.status, 529); assert.equal(event.actual_cost_micros, 0); assert.equal(budget.spentMicros, 0);
    });
    await t.test("fixed price preserves its explicit policy contract", async () => {
      const { response, event, budget } = await fixture({ metadata: { user_id: "priority" } }, { requestCostMicros: 1234 });
      assert.equal(response.status, 200); assert.equal(event.actual_cost_micros, 1234); assert.equal(budget.spentMicros, 1234); assert.equal(event.cost_basis, "policy_fixed");
    });
    await t.test("soft budgets report unknown priority without inventing a rate", async () => {
      const { response, event, budget } = await fixture({ metadata: { user_id: "priority" } }, { budgetMode: "soft" });
      assert.equal(response.status, 200); assert.equal(event.cost_basis, "unpriced_usage"); assert.equal(event.served_service_tier, "priority");
      assert.equal(event.actual_cost_micros, 0); assert.equal(budget.spentMicros, 0);
    });
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
