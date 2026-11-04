import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { speechAudio, speechBody } from "./openrouter-speech-runtime-fixture.mjs";
const { modelSupportsEndpoint } = await import("../providers.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const source = parse(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"));
const models = ["hexgrad/kokoro-82m", "elevenlabs/eleven-turbo-v2", "mistralai/voxtral-mini-tts-2603"];
const compile = value => compileProviderSnapshot([value]);
const compiled = () => compile(source).providers[0];
const audio = speechAudio(), nativePath = "/v1/native/openrouter/v1/audio/speech", manifestPath = "/v1/proxy/openrouter/speech";

async function setup(t, fixed = 700) {
  const f = await fixture(t, { pooled: true, fixed, providerId: "openrouter", compiledProvider: true,
    configure: provider => Object.assign(provider, compiled()) });
  f.env.OPENROUTER_API_KEY = "synthetic-environment-must-not-replace-owner";
  f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.request = (body, manifest = false, query = "") => f.call((manifest ? manifestPath : nativePath) + query,
    manifest ? { body: { ...body, model: `openrouter/${body.model}` } } : body);
  f.upstream = async request => {
    f.upload = await request.json();
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(audio.length) } });
  };
  t.after(f.drain); return f;
}

test("OpenRouter MP3 declaration preserves existing inference and compiles exactly three unpriced speech cards", () => {
  const before = structuredClone(source);
  delete before.endpoints.speech;
  before.capabilities = before.capabilities.filter(value => value.endpoint !== "speech");
  before.models.entries = before.models.entries.filter(value => !models.includes(value.upstream));
  const result = compile(source), baseline = compile(before), provider = result.providers[0], original = baseline.providers[0];
  for (const key of ["auth", "adapter", "routing", "base_urls", "billing", "config_keys", "optional_config_keys"])
    assert.deepEqual(provider[key], original[key]);
  assert.deepEqual(provider.endpoints.filter(value => value.id !== "speech"), original.endpoints);
  assert.deepEqual(provider.capabilities.filter(value => value.endpoint !== "speech"), original.capabilities);
  assert.deepEqual(provider.models.filter(value => !models.includes(value.upstream)), original.models);
  for (const [id, model] of Object.entries(baseline.model_index)) assert.deepEqual(result.model_index[id], model);
  const endpoint = provider.endpoints.find(value => value.id === "speech");
  assert.equal(endpoint.path, "/v1/audio/speech"); assert.equal(endpoint.method, "POST"); assert.deepEqual(endpoint.methods, ["POST"]);
  assert.equal(endpoint.request_format, "openai.audio_speech"); assert.equal(endpoint.response_format, "audio.binary");
  assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.timeout_ms, 120000); assert.equal(endpoint.streaming, null);
  assert.equal(endpoint.upstreamPath, undefined); assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []);
  assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.requestPricing, undefined);
  const cards = provider.models.filter(model => model.capabilities.includes("audio.speech"));
  assert.deepEqual(cards.map(model => model.upstream), models);
  for (const model of cards) {
    assert.equal(model.id, `openrouter/${model.upstream}`); assert.deepEqual(model.capabilities, ["audio.speech"]);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null); assert.equal(model.endpointPricing, undefined);
    assert.ok(modelSupportsEndpoint(provider, model, endpoint));
    for (const id of ["chat_completions", "responses"])
      assert.equal(modelSupportsEndpoint(provider, model, provider.endpoints.find(value => value.id === id)), false);
  }
});

for (const model of models) for (const manifest of [false, true]) {
  test(`compiled ${model} ${manifest ? "manifest" : "native"} returns exact MP3 through its original credential`, async t => {
    const f = await setup(t), body = speechBody(model), response = await f.request(body, manifest);
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].url, "https://openrouter.ai/api/v1/audio/speech");
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(f.sent[0].redirect, "manual"); assert.deepEqual(f.upload, body);
    await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].model, `openrouter/${model}`); assert.equal(events[0].capability, "audio.speech");
    assert.equal(events[0].grant_key, grantKey); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.equal(events[0].actual_cost_micros, 700);
    for (const key of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(events[0][key], null);
  });

  test(`compiled ${model} ${manifest ? "manifest" : "native"} denies unknown hard-dollar speech before egress`, async t => {
    const f = await setup(t, null), response = await f.request(speechBody(model), manifest);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
    assert.equal(f.sent.length, 0);
  });
}

test("compiled speech catalog keeps all three selected cards ineligible under unknown hard-dollar pricing", async t => {
  const f = await setup(t, null), response = await f.call("/v1/catalog", null);
  assert.equal(response.status, 200); const catalog = await response.json();
  const offers = catalog.providers.find(provider => provider.id === "openrouter").offers.filter(offer => offer.endpoint === "speech");
  assert.deepEqual([...new Set(offers.map(offer => offer.modelId).filter(Boolean))].sort(), models.map(model => `openrouter/${model}`).sort());
  assert.ok(offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required"));
  assert.equal(f.sent.length, 0);
});

for (const mutation of ["missing-voice", "missing-format", "pcm", "gemini", "query", "generic-chat"]) {
  test(`compiled OpenRouter speech keeps ${mutation} outside its qualified operation`, async t => {
    const f = await setup(t), body = speechBody();
    if (mutation === "missing-voice") delete body.voice;
    if (mutation === "missing-format") delete body.response_format;
    if (mutation === "pcm") body.response_format = "pcm";
    if (mutation === "gemini") body.model = "google/gemini-3.1-flash-tts-preview";
    for (const manifest of [false, true]) {
      const response = mutation === "generic-chat"
        ? await f.call(manifest ? "/v1/proxy/openrouter/chat_completions" : "/v1/chat/completions",
          manifest ? { body: { model: `openrouter/${body.model}`, messages: [{ role: "user", content: "Synthetic." }] } }
            : { model: `openrouter/${body.model}`, messages: [{ role: "user", content: "Synthetic." }] })
        : await f.request(body, manifest, mutation === "query" ? "?voice=foreign" : "");
      assert.ok(response.status >= 400, await response.text());
    }
    assert.equal(f.sent.length, 0);
  });
}

test("compiled speech cannot replace a revoked original owner with environment credentials", async t => {
  const f = await setup(t); f.policy.grantRouting = { eligibleGrants: { openrouter: ["replicate"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); await revokeGrantCredentials(f.env, grantKey);
  for (const manifest of [false, true]) {
    const response = await f.request(speechBody(), manifest); assert.ok(response.status >= 400, await response.text());
  }
  assert.equal(f.sent.length, 0);
});

test("compiled manifest speech quarantines an incomplete MP3 without paid POST replay", async t => {
  const f = await setup(t);
  f.upstream = () => new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(audio.length + 1) } });
  const response = await f.request(speechBody(), true); assert.equal(response.status, 502);
  assert.equal(response.headers.get("content-type").includes("audio"), false); await response.text(); assert.equal(f.sent.length, 1);
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].actual_cost_micros, 700);
});
