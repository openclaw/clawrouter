import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { fixture } = await import("./http-continuation-fixture.mjs");
const { providerById } = await import("../providers.ts");
const { assertServiceTier } = await import("../service-tiers.ts");
const { estimateModelCost } = await import("../pricing.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { concreteOpenAiSelection } = await import("../proxy-selection.ts");
const { prepareSelected } = await import("../proxy.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { DEFAULT_FUSION_CONFIG, buildAggregatorBody, buildFusionReservationProposals } = await import("../fusion.ts");

const modelId = "openai/gpt-6.1-sol";
const usage = { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
const realModel = () => providerById("openai").models.find(model => model.id === modelId);

for (const route of ["/v1/responses", "/v1/chat/completions", "/v1/native/openai/v1/responses", "/v1/proxy/openai/responses"]) {
  for (const tier of [undefined, "auto", "fast"]) test(`${route}: ${tier ?? "omitted"} reserves and forwards its admitted OpenAI tier`, async t => {
    const model = realModel(), f = await fixture(t, false, { limit: 5_000_000, fixedCost: null });
    const chat = route.endsWith("chat/completions");
    const body = { model: modelId, ...(chat ? { messages: [], max_completion_tokens: 16 } : { input: "fixture", max_output_tokens: 16 }), ...(tier === undefined ? {} : { service_tier: tier }) };
    const wireTier = tier === "fast" ? "fast" : "default", servedTier = tier === "fast" ? "priority" : "default";
    f.response = () => Response.json(chat
      ? { choices: [], service_tier: servedTier, usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }
      : { id: "resp_fixture", object: "response", status: "completed", output: [], service_tier: servedTier, usage });
    const response = await f.request(route.includes("/proxy/") ? { body } : body, {}, route);
    assert.equal(response.status, 200, await response.clone().text());
    await f.consume(response);
    assert.equal(f.sent.length, 1);
    const sent = f.sent[0].body;
    assert.equal(sent.service_tier, wireTier);
    assert.equal(body.service_tier, tier);
    const event = f.events[0];
    assert.equal(event.actual_cost_micros, tier === "fast" ? 80 : 40);
    assert.equal(event.cost_basis, "manifest_pricing");
    assert.equal(event.reserved_cost_micros, estimateModelCost(model.pricing, sent).reserveMicros);
  });
}

test("tier admission pins only resolved OpenAI API transports and copies only changed bodies", t => {
  const model = realModel(), auth = { policy: {} };
  for (const provider of ["openai", "openrouter"]) for (const format of ["openai.responses", "openai.chat_completions", "openai.decisions", "openai.audio_speech", "openai.embeddings", "google.generate_content"]) {
    for (const transport of [undefined, null, { baseUrl: "https://chatgpt.com/backend-api/codex" }]) for (const tier of [undefined, null, "auto", "AUTO", "default", "DEFAULT", "fast"]) {
      const body = Object.freeze({ input: [{ content: "fixture" }], ...(tier === undefined ? {} : { service_tier: tier }) });
      const selection = { provider: { id: provider }, endpoint: { request_format: format }, model, body };
      assertServiceTier(auth, selection, transport);
      const pinned = provider === "openai" && ["openai.responses", "openai.chat_completions"].includes(format) && transport === null && (tier == null || tier.toLowerCase() === "auto");
      assert.equal(selection.body.service_tier, pinned ? "default" : tier);
      assert.equal(selection.body === body, !pinned);
      assert.equal(selection.body.input, body.input, "nested content is shared");
      assert.equal(body.service_tier, tier);
    }
  }
});

for (const tier of [undefined, "auto", "fast"]) test(`Responses WebSocket preparation pins ${tier ?? "omitted"} before pricing`, async t => {
  const model = realModel(), f = await fixture(t, false, { limit: 5_000_000, fixedCost: null });
  const request = correlateIngressRequest(new Request("https://router.example/v1/responses", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } })).request;
  const auth = await authenticateProxyKey(request.headers, f.env);
  const selection = concreteOpenAiSelection("/v1/responses", { model: modelId, input: "fixture", max_output_tokens: 16, ...(tier === undefined ? {} : { service_tier: tier }) }, f.env);
  const upstream = await prepareSelected(request, f.env, selection, {}, auth, new Set(), true, undefined, undefined, "websocket");
  assert.equal(upstream.websocket, true);
  const payload = { type: "response.create", ...selection.body };
  assert.equal(payload.service_tier, tier === "fast" ? "fast" : "default");
  assert.equal(JSON.parse(upstream.requestBody).service_tier, payload.service_tier);
  const cost = estimateModelCost(model.pricing, selection.body);
  assert.equal(cost.reserveMicros, Math.ceil(cost.inputTokens * (tier === "fast" ? 5 : 2.5) + cost.outputTokens * (tier === "fast" ? 20 : 10)));
});

for (const tier of [undefined, "auto", "fast"]) test(`subscription transport preserves ${tier ?? "omitted"}`, async t => {
  const f = await fixture(t, true, { fixedCost: null });
  const response = await f.request({ model: modelId, ...(tier === undefined ? {} : { service_tier: tier }) });
  assert.equal(response.status, 200, await response.clone().text());
  await f.consume(response);
  assert.equal(f.sent[0].body.service_tier, tier);
  assert.ok(f.sent[0].url.startsWith("https://chatgpt.com/backend-api/codex/"));
});

test("Fusion aggregator reserves its explicitly pinned default tier before advisers run", async t => {
  const model = realModel(), f = await fixture(t, false, { limit: 5_000_000, fixedCost: null });
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: [modelId], aggregatorModel: modelId, maxProposalChars: 256 };
  f.values.set("config/fusion", config);
  const body = { model: "clawrouter/fusion", input: "fixture", messages: [{ role: "user", content: "fixture" }], max_completion_tokens: 16 };
  f.response = () => Response.json({ choices: [{ message: { content: "fixture proposal" } }], service_tier: "default", usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
  const response = await f.request(body, {}, "/v1/chat/completions");
  assert.equal(response.status, 200, await response.clone().text());
  await f.consume(response);
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(sent => sent.body.service_tier === "default"));
  const event = f.events.find(event => event.compound_request_stage === "fusion_synthesizer");
  const reservedBody = buildAggregatorBody(body, config, buildFusionReservationProposals(config));
  reservedBody.model = model.upstream;
  reservedBody.service_tier = "default";
  assert.equal(event.reserved_cost_micros, estimateModelCost(model.pricing, reservedBody).reserveMicros);
});
