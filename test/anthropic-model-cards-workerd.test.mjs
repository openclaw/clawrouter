import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };

const sonnet = "anthropic/claude-sonnet-5-5", haiku = "anthropic/claude-haiku-5-5";
const usage = (input = 70_000) => ({ input_tokens: input, cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 10_000 }, output_tokens: 1_000 });
const message = counts => ({ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text: "synthetic reply" }], stop_reason: "end_turn", usage: counts });
const sse = (...events) => events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("");
const stream = (counts, complete = true) => sse(
  { type: "message_start", message: { ...message(counts), stop_reason: null, usage: { ...counts, output_tokens: 1 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: counts.output_tokens } },
  ...(complete ? [{ type: "message_stop" }] : []));
const card = id => snapshot.model_index[id];

// Real Worker, authority, queue ingestion and SQLite ledgers. Only the upstream
// is synthetic; its strict wire checks also catch accidental proxy-key forwarding.
const router = [
  'import worker from "./worker/index.ts";',
  'import { providerBudgetStatus } from "./worker/ledgers.ts";',
  'export * from "./worker/index.ts";',
  'export default { ...worker, fetch(request, env, ctx) { const configured = { ...env, ANTHROPIC_API_KEY: "fixture-anthropic-key" }; if (new URL(request.url).pathname === "/fixture/provider-budget") return providerBudgetStatus(configured, "anthropic", 100000000).then(Response.json); return worker.fetch(request, configured, ctx); } };',
].join("\n");
const upstream = [
  'let reply, calls = []; export default { async fetch(request) { const path = new URL(request.url).pathname;',
  'if (path === "/fixture/reply") { reply = await request.json(); return new Response("ok"); }',
  'if (path === "/fixture/calls") return Response.json(calls);',
  'const body = await request.json(); calls.push({ url: request.url, method: request.method, body, key: request.headers.get("x-api-key"), version: request.headers.get("anthropic-version"), authorization: request.headers.get("authorization") });',
  'return new Response(reply.body, { status: reply.status ?? 200, headers: { "content-type": reply.contentType } }); } };',
].join("\n");

test("new Claude cards project and settle through actual workerd without changing endpoints", { timeout: 90_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-anthropic-models-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, router, upstream);
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), service = await mf.getWorker("upstream");
    const secret = "synthetic-anthropic-model-card-secret", headers = { authorization: "Bearer clawrouter-live-fixture-" + secret };
    const namespace = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router"), authority = namespace.get(namespace.idFromName("policy-bindings"));
    const putPolicy = async limit => {
      const response = await authority.fetch("https://authority/policies/put", { method: "POST", body: JSON.stringify({ policyId: "fixture", policy: {
        enabled: true, generation: "g1", providers: ["anthropic"], monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false,
      } }) });
      assert.equal(response.status, 200);
    };
    await putPolicy(100_000_000);
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/anthropic", JSON.stringify({ providerId: "anthropic", enabled: true, monthlyBudgetMicros: 100_000_000 }));
    const get = async (path, extra = {}) => {
      const response = await mf.dispatchFetch("https://router" + path, { headers: { ...headers, ...extra } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const calls = async () => (await service.fetch("https://upstream/fixture/calls")).json();
    const setReply = reply => service.fetch("https://upstream/fixture/reply", { method: "POST", body: JSON.stringify(reply) });
    const post = (id, stream = false, path = "/v1/messages") => mf.dispatchFetch("https://router" + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: id, max_tokens: 1_000, service_tier: "standard_only", stream, messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(110_000), cache_control: { type: "ephemeral", ttl: "1h" } }] }] }) });
    let spent = 0, eventCount = 0;
    const settled = async expected => {
      let body;
      for (let attempt = 0; attempt < 200; attempt++) {
        body = await get("/v1/usage");
        if (body.usage.events.length >= expected) return body;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail("usage did not settle: " + JSON.stringify(body));
    };
    await t.test("authenticated catalog and Anthropic models list expose exact cards and endpoint facts", async () => {
      const catalog = await get("/v1/catalog"), provider = catalog.providers.find(provider => provider.id === "anthropic");
      const models = await get("/v1/models", { "anthropic-version": "2023-06-01" });
      for (const id of [sonnet, haiku]) {
        const model = provider.models.find(model => model.id === id);
        assert.ok(model, "missing catalog card: " + id);
        assert.deepEqual(model.capabilities, ["llm.messages", "llm.count_tokens"]);
        assert.equal(model.pricing.maxInputTokens, 1_000_000);
        assert.equal(model.pricing.longContext?.thresholdInputTokens ?? null, id === haiku ? 100_000 : null);
        const facts = model.nativeCapabilities.endpoints;
        assert.deepEqual(Object.keys(facts), ["messages", "count_tokens"]);
        for (const endpoint of Object.values(facts)) { assert.deepEqual(endpoint.input, ["text", "image"]); assert.equal(endpoint.contextWindow, 1_000_000); }
        assert.equal(facts.messages.maxOutputTokens, 128_000);
        assert.equal(facts.count_tokens.maxOutputTokens, undefined, "token counting is not generation");
        const listed = models.data.find(model => model.id === id);
        assert.equal(listed.max_input_tokens, 1_000_000); assert.equal(listed.max_tokens, 128_000);
        assert.ok(provider.offers.some(offer => offer.modelId === id && offer.endpoint === "messages" && offer.eligible));
      }
      assert.equal((await calls()).length, 0, "catalog never probes paid upstream");
    });
    for (const [id, input, isStream, path, cost] of [
      [haiku, 70_000, false, "/v1/messages", 10_850],
      [haiku, 70_001, false, "/v1/messages", 54_251],
      [haiku, 70_000, true, "/v1/native/anthropic/v1/messages", 10_850],
      [haiku, 70_001, true, "/v1/native/anthropic/v1/messages", 54_251],
      [sonnet, 70_001, false, "/v1/messages", 216_002],
      [sonnet, 70_001, true, "/v1/native/anthropic/v1/messages", 216_002],
    ]) await t.test(id + " " + (isStream ? "SSE" : "JSON") + " at " + (input + 30_000) + " input tokens delivers upstream bytes and settles both real budgets", async () => {
      const counts = usage(input), wire = isStream ? stream(counts) : JSON.stringify(message(counts));
      await setReply({ body: wire, contentType: isStream ? "text/event-stream" : "application/json" });
      const before = (await calls()).length, response = await post(id, isStream, path);
      assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), wire);
      const body = await settled(++eventCount), event = body.usage.events[0];
      assert.equal((await calls()).length, before + 1);
      const sent = (await calls()).at(-1);
      assert.equal(sent.url, "https://api.anthropic.com/v1/messages"); assert.equal(sent.method, "POST");
      assert.equal(sent.key, "fixture-anthropic-key"); assert.equal(sent.authorization, null); assert.equal(sent.version, "2023-06-01");
      assert.equal(sent.body.model, id.slice("anthropic/".length)); assert.equal(sent.body.service_tier, "standard_only");
      assert.equal(sent.body.stream, isStream); assert.equal(sent.body.messages[0].content[0].cache_control.ttl, "1h");
      assert.equal(event.model, id); assert.equal(event.actual_cost_micros, cost); assert.equal(event.cost_basis, "manifest_pricing");
      assert.equal(event.pricing_ref, card(id).pricing_ref); assert.ok(event.reserved_cost_micros >= cost);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.cached_input_tokens, event.cache_write_input_tokens], [input + 30_000, 1_000, 10_000, 20_000]);
      spent += cost; assert.equal(body.budget.spentMicros, spent); assert.equal((await get("/fixture/provider-budget")).spentMicros, spent);
    });
    await t.test("truncated long-context SSE cannot settle at the cheaper partial price", async () => {
      const wire = stream(usage(70_001), false);
      await setReply({ body: wire, contentType: "text/event-stream" });
      const response = await post(haiku, true); assert.equal(response.status, 200); assert.equal(await response.text(), wire);
      const body = await settled(++eventCount), event = body.usage.events[0];
      assert.equal(event.cost_basis, "manifest_reservation"); assert.ok(event.actual_cost_micros > 54_251);
      assert.equal(event.actual_cost_micros, event.reserved_cost_micros);
      spent += event.actual_cost_micros; assert.equal(body.budget.spentMicros, spent); assert.equal((await get("/fixture/provider-budget")).spentMicros, spent);
    });
    for (const owner of ["policy", "provider"]) await t.test(owner + " hard budget blocks long-context reservation before provider dispatch", async () => {
      await putPolicy(owner === "policy" ? spent + 60_000 : 100_000_000);
      const connection = await authority.fetch("https://authority/connections/put", { method: "POST", body: JSON.stringify({ providerId: "anthropic", enabled: true, monthlyBudgetMicros: owner === "provider" ? spent + 60_000 : 100_000_000 }) });
      assert.equal(connection.status, 200);
      const before = (await calls()).length, response = await post(haiku);
      assert.equal(response.status, 402); assert.equal((await response.json()).error.code, owner === "policy" ? "budget_exhausted" : "provider_budget_exhausted");
      assert.equal((await calls()).length, before); assert.equal((await get("/v1/usage")).budget.spentMicros, spent);
      assert.equal((await get("/fixture/provider-budget")).spentMicros, spent);
    });
  } finally {
    if (mf) await mf.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
