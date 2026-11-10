import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { putGrantCredentials } from "../grant-credentials.ts";
import { observeGrantQuotaProbe } from "../grant-quota.ts";
import { recordGrantRuntime } from "../grant-selection.ts";
import { modelRoute } from "../providers.ts";
import { anthropicPricing } from "../anthropic-pricing.ts";
import { actualModelCost, estimateModelCost } from "../pricing.ts";

const id = "anthropic/claude-fable-5-2", upstream = "claude-fable-5-2";
const prompt = { system: "Synthetic fixed prefix.", max_tokens: 10, thinking: { type: "adaptive" }, output_config: { effort: "high" },
  messages: [{ role: "user", content: "Synthetic question." }, { role: "assistant", content: [
    { type: "thinking", thinking: "Synthetic earlier thought.", signature: "synthetic-signature" }, { type: "text", text: "Synthetic earlier answer." },
  ] }, { role: "user", content: "Continue." }] };
const usage = { input_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 }, output_tokens: 10,
  speed: "standard", inference_geo: "global", service_tier: "standard" };
const message = { id: "msg_synthetic", type: "message", role: "assistant", model: upstream,
  content: [{ type: "text", text: "Synthetic answer." }], stop_reason: "end_turn", usage };
const future = "2099-01-01T00:00:00.000Z";

async function setup(t, subscription = false) {
  const f = await fixture(t, { providerId: "anthropic", compiledProvider: true, fixed: null });
  f.policy.monthlyBudgetMicros = 20_000_000; f.policy.models = [id];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await f.authority("/connections/put", { providerId: "anthropic", enabled: true, monthlyBudgetMicros: 20_000_000 });
  if (subscription) f.grant = await putGrantCredentials(f.env, grantKey, { provider: "anthropic", kind: "subscription", enabled: true,
    accessToken: "synthetic-subscription-token", expiresAt: future, maintenance: { keepWarm: false } });
  else f.env.ANTHROPIC_API_KEY = "synthetic-api-key";
  f.upstream = () => Response.json(message);
  return f;
}

for (const subscription of [false, true]) test("Fable 5.2 publishes exact catalog routes and product offers for " + (subscription ? "subscription" : "API"), async t => {
  const f = await setup(t, subscription);
  const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200, await response.clone().text());
  const provider = (await response.json()).providers.find(row => row.id === "anthropic");
  const model = provider.models.find(row => row.id === id); assert.ok(model, "must be declared, not unpriced passthrough");
  assert.equal(model.upstream, upstream); assert.deepEqual(model.capabilities, ["llm.messages", "llm.count_tokens"]);
  assert.deepEqual(model.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(model.nativeCapabilities.endpoints.messages.contextWindow, 1_000_000);
  assert.equal(model.nativeCapabilities.endpoints.messages.maxOutputTokens, 128_000);
  const productId = subscription ? "claude-subscription" : "platform-api";
  assert.deepEqual(provider.products.map(product => product.id), [productId]);
  const offers = provider.offers.filter(offer => offer.modelId === id);
  assert.deepEqual(offers.map(offer => [offer.endpoint, offer.routeKind, offer.route]).sort(), [
    ["count_tokens", "native", "/v1/native/anthropic/v1/messages/count_tokens"],
    ["messages", "native", "/v1/native/anthropic/v1/messages"],
  ]);
  for (const offer of offers) {
    assert.equal(offer.eligible, true);
    const capability = offer.endpoint === "messages" ? "llm.messages" : "llm.count_tokens";
    assert.deepEqual(offer.productOffers, [{ productId, id: "clawrouter.offer.v1:" + JSON.stringify(["anthropic", productId, offer.endpoint, capability, id]) }]);
  }
  const listed = await f.call("/v1/models", null, { headers: { "anthropic-version": "2023-06-01" } });
  assert.equal(listed.status, 200); const row = (await listed.json()).data.find(row => row.id === id);
  assert.ok(row); assert.equal(row.max_input_tokens, 1_000_000); assert.equal(row.max_tokens, 128_000);
  assert.equal(f.sent.length, 0, "discovery never probes upstream"); await f.drain();
});

for (const subscription of [false, true]) for (const route of ["unified", "native", "manifest"]) test(
  "Fable 5.2 " + route + " preserves native thinking and settles exact cache prices with " + (subscription ? "OAuth" : "API key"), async t => {
    const f = await setup(t, subscription);
    const body = { ...prompt, model: route === "native" ? upstream : id };
    const path = route === "unified" ? "/v1/messages" : route === "native" ? "/v1/native/anthropic/v1/messages" : "/v1/proxy/anthropic/messages";
    const response = await f.call(path, route === "manifest" ? { body } : body);
    assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), message);
    assert.equal(f.sent.length, 1); const sent = f.sent[0];
    assert.equal(sent.url, "https://api.anthropic.com/v1/messages"); assert.equal(sent.redirect, "manual");
    const forwarded = await sent.json();
    if (subscription) {
      assert.equal(sent.headers.get("authorization"), "Bearer synthetic-subscription-token"); assert.equal(sent.headers.has("x-api-key"), false);
      assert.equal(sent.headers.get("user-agent"), "claude-cli/2.1.288 (external, cli)");
      assert.match(sent.headers.get("anthropic-beta"), /oauth-2025-04-20/);
      assert.deepEqual(forwarded.system, [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.288; cc_entrypoint=sdk-cli;" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: "text", text: prompt.system },
      ]);
    } else { assert.equal(sent.headers.get("x-api-key"), "synthetic-api-key"); assert.equal(sent.headers.has("authorization"), false); assert.equal(forwarded.system, prompt.system); }
    assert.deepEqual({ ...forwarded, system: prompt.system }, { ...prompt, model: upstream });
    await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].model, id); assert.equal(events[0].actual_cost_micros, 34_600);
    assert.equal(events[0].cost_basis, "manifest_pricing");
    assert.equal(events[0].pricing_ref, "anthropic-claude-fable-5-2-standard-2026-11-09");
  });

test("Fable 5.2 qualifies standard, fast and US prices without borrowing legacy Fable rates", () => {
  const model = modelRoute(id, "llm.messages")?.model; assert.ok(model?.pricing);
  const pricing = model.pricing;
  assert.deepEqual([pricing.inputMicrosPerMillion, pricing.outputMicrosPerMillion, pricing.cachedInputMicrosPerMillion,
    pricing.cacheWrite5mInputMicrosPerMillion, pricing.cacheWrite1hInputMicrosPerMillion], [8_000_000, 40_000_000, 200_000, 10_000_000, 16_000_000]);
  const counts = { input: 4000, cached: 1000, cacheWrite: 2000, cacheWrite5m: 1000, cacheWrite1h: 1000, output: 10 };
  for (const [speed, inferenceGeo, expected] of [["standard", "global", 34_600], ["fast", "global", 69_200], ["fast", "us", 76_120]]) {
    const modifiers = { speed, inferenceGeo, serviceTier: "standard_only" };
    assert.equal(actualModelCost(anthropicPricing(pricing, upstream, modifiers), counts), expected);
    assert.equal(actualModelCost(anthropicPricing(pricing, upstream, modifiers, { speed, inferenceGeo, serviceTier: "standard" }), counts), expected);
  }
  const bound = anthropicPricing(pricing, upstream, {});
  assert.equal(bound.inputMicrosPerMillion, 8_800_000, "omitted geography retains conservative US bound");
  assert.equal(anthropicPricing(pricing, upstream, { serviceTier: "priority" }), null);
  assert.equal(anthropicPricing(pricing, upstream, {}, { speed: "future" }), null);
  const estimate = estimateModelCost(pricing, { messages: [{ role: "user", content: "x".repeat(1_000_000) }] }, { request_format: "anthropic.messages" });
  assert.deepEqual(estimate, { inputTokens: 1_000_000, outputTokens: 128_000, reserveMicros: 13_120_000 });
});

test("Fable 5.2 denies disallowed models and exhausted hard budgets before upstream", async t => {
  const f = await setup(t);
  f.policy.models = ["anthropic/claude-fable-5-1"]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  let response = await f.call("/v1/messages", { ...prompt, model: id }); assert.equal(response.status, 403); await response.text();
  f.policy.models = [id]; f.policy.monthlyBudgetMicros = 0;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  response = await f.call("/v1/messages", { ...prompt, model: id }); assert.equal(response.status, 402); await response.text();
  assert.equal(f.sent.length, 0); await f.drain();
});

test("Fable 5.2 shares the existing Fable quota and never enables API overage fallback", async t => {
  const f = await setup(t, true);
  f.env.ANTHROPIC_API_KEY = "synthetic-unselected-api-key";
  const state = observeGrantQuotaProbe({ five_hour: { utilization: 10, resets_at: future }, seven_day: { utilization: 20, resets_at: future },
    limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 100, resets_at: future }] }, f.provider.quota.probes[0]);
  state.grantRevision = f.grant.updatedAt;
  await recordGrantRuntime(f.env, grantKey, state);
  const response = await f.call("/v1/messages", { ...prompt, model: id });
  assert.equal(response.status, 429, await response.clone().text()); await response.text();
  assert.equal(f.sent.length, 0); await f.drain();
});

test("Fable 5.2 fast SSE preserves bytes and charges the qualified US cache tariff", async t => {
  const f = await setup(t);
  const counts = { ...usage, speed: "fast", inference_geo: "us" };
  const wire = [
    { type: "message_start", message: { ...message, usage: { ...counts, output_tokens: 0 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic answer." } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }, { type: "message_stop" },
  ].map(event => "data: " + JSON.stringify(event) + "\n\n").join("");
  f.upstream = async request => {
    const body = await request.json(); assert.equal(body.model, upstream); assert.equal(body.speed, "fast"); assert.equal(body.inference_geo, "us");
    return new Response(wire, { headers: { "content-type": "text/event-stream" } });
  };
  const response = await f.call("/v1/messages", { ...prompt, model: id, stream: true, speed: "fast", inference_geo: "us" });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(await response.text(), wire);
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 76_120); assert.equal(events[0].cost_basis, "manifest_pricing");
});

test("Fable 5.2 count_tokens maps the registered ID without generation billing", async t => {
  const f = await setup(t);
  f.upstream = async request => {
    assert.equal(request.url, "https://api.anthropic.com/v1/messages/count_tokens");
    assert.equal((await request.json()).model, upstream); return Response.json({ input_tokens: 100 });
  };
  const response = await f.call("/v1/native/anthropic/v1/messages/count_tokens", { model: upstream, messages: prompt.messages });
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), { input_tokens: 100 });
  assert.equal(f.sent.length, 1); await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].model, id); assert.equal(events[0].actual_cost_micros, 0);
});

test("Fable 5.2 upstream signature rejection is delivered without rewriting history or retrying", async t => {
  const f = await setup(t);
  const error = { type: "error", error: { type: "invalid_request_error", message: "Synthetic prefix binding mismatch." } };
  f.upstream = () => Response.json(error, { status: 400 });
  const response = await f.call("/v1/messages", { ...prompt, model: id });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), error);
  assert.equal(f.sent.length, 1); assert.deepEqual((await f.sent[0].json()).messages, prompt.messages); await f.drain();
});
