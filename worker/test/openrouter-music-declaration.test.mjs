import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { musicBody, musicModels, musicWire } from "./openrouter-music-runtime-fixture.mjs";
const { modelSupportsEndpoint } = await import("../providers.ts");
const source = parse(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"));
const compile = value => compileProviderSnapshot([value]);
const compiled = () => compile(source).providers[0];
const nativePath = "/v1/native/openrouter/v1/chat/completions";
const manifestPath = "/v1/proxy/openrouter/music_generate";

async function setup(t, fixed = 700) {
  const f = await fixture(t, { pooled: true, fixed, providerId: "openrouter", compiledProvider: true,
    configure: provider => Object.assign(provider, compiled()) });
  f.env.OPENROUTER_API_KEY = "synthetic-environment-must-not-replace-owner";
  f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.request = (body, manifest = false, suffix = "") => f.call((manifest ? manifestPath : nativePath) + suffix,
    manifest ? { body: { ...body, model: `openrouter/${body.model}` } } : body);
  f.upstream = async request => {
    f.upload = await request.json();
    return new Response(musicWire(f.upload.model), { headers: { "content-type": "text/event-stream" } });
  };
  t.after(f.drain); return f;
}

test("bundled OpenRouter music preserves inference and declares only two text-only unpriced cards", () => {
  const before = structuredClone(source);
  delete before.endpoints.music_generate;
  before.capabilities = before.capabilities.filter(value => value.id !== "music.generate");
  before.models.entries = before.models.entries.filter(value => !musicModels.includes(value.upstream));
  const result = compile(source), baseline = compile(before), provider = result.providers[0], original = baseline.providers[0];
  for (const key of ["auth", "adapter", "routing", "base_urls", "billing", "config_keys", "optional_config_keys"])
    assert.deepEqual(provider[key], original[key]);
  assert.deepEqual(provider.models.filter(value => !musicModels.includes(value.upstream)), original.models);
  assert.deepEqual(provider.endpoints.filter(value => value.id !== "music_generate"), original.endpoints);
  assert.deepEqual(provider.capabilities.filter(value => value.id !== "music.generate"), original.capabilities);
  for (const [id, model] of Object.entries(baseline.model_index)) assert.deepEqual(result.model_index[id], model);
  const endpoint = provider.endpoints.find(value => value.id === "music_generate");
  assert.equal(endpoint.path, "/v1/chat/completions"); assert.equal(endpoint.method, "POST");
  assert.equal(endpoint.request_format, "openai.chat_completions"); assert.equal(endpoint.response_format, "openai.chat_completions");
  assert.equal(endpoint.streaming, "sse"); assert.equal(endpoint.timeout_ms, 600000);
  assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.requestPricing, undefined);
  assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []);
  const models = provider.models.filter(value => value.capabilities.includes("music.generate"));
  assert.deepEqual(models.map(value => value.upstream), musicModels);
  for (const model of models) {
    assert.equal(model.id, `openrouter/${model.upstream}`); assert.deepEqual(model.capabilities, ["music.generate"]);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    const facts = model.nativeCapabilities.endpoints.music_generate;
    assert.deepEqual(facts.input, ["text"]);
    assert.deepEqual(Object.keys(facts).sort(), ["checkedAt", "input", "sources"]);
    assert.ok(modelSupportsEndpoint(provider, model, endpoint));
    for (const id of ["chat_completions", "responses"])
      assert.equal(modelSupportsEndpoint(provider, model, provider.endpoints.find(value => value.id === id)), false);
  }
});

for (const model of musicModels) for (const manifest of [false, true]) {
  test(`compiled ${model} ${manifest ? "manifest" : "native"} uses original credential and policy-fixed complete SSE`, async t => {
    const f = await setup(t), body = musicBody(model), response = await f.request(body, manifest);
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    assert.equal(await response.text(), musicWire(model)); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(f.sent[0].redirect, "manual"); assert.deepEqual(f.upload, body);
    await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].model, `openrouter/${model}`); assert.equal(events[0].capability, "music.generate");
    assert.equal(events[0].grant_key, grantKey); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.equal(events[0].actual_cost_micros, 700);
    for (const key of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(events[0][key], null);
  });

  test(`compiled ${model} ${manifest ? "manifest" : "native"} denies unknown hard-dollar cost before egress`, async t => {
    const f = await setup(t, null), response = await f.request(musicBody(model), manifest);
    assert.ok(response.status >= 400); assert.equal((await response.json()).error.code, "pricing_required");
    assert.equal(f.sent.length, 0);
  });
}

for (const mutation of ["reference-image", "nonstream", "query", "generic-chat"]) {
  test(`compiled music keeps ${mutation} outside its qualified text-only operation`, async t => {
    const f = await setup(t), body = musicBody();
    if (mutation === "reference-image") body.messages[0].content = [{ type: "text", text: "Synthetic music." },
      { type: "image_url", image_url: { url: "https://assets.example/unowned.png" } }];
    if (mutation === "nonstream") body.stream = false;
    const response = mutation === "generic-chat"
      ? await f.call("/v1/chat/completions", { ...body, model: `openrouter/${body.model}` })
      : await f.request(body, false, mutation === "query" ? "?account=other" : "");
    assert.ok(response.status >= 400, await response.text()); assert.equal(f.sent.length, 0);
  });
}

test("compiled music selection is independent of endpoint order and preserves the existing Chat card", async t => {
  const f = await setup(t); f.provider.endpoints.reverse();
  const music = await f.request(musicBody()); assert.equal(music.status, 200, music.ok ? undefined : await music.text());
  await music.text();
  const model = f.provider.models.find(value => value.capabilities.includes("llm.chat")); assert.ok(model);
  f.upstream = () => Response.json({ model: model.upstream,
    choices: [{ message: { role: "assistant", content: "Synthetic response." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  const chat = await f.call(nativePath, { model: model.upstream, messages: [{ role: "user", content: "Synthetic request." }] });
  assert.equal(chat.status, 200, chat.ok ? undefined : await chat.text()); await chat.text();
  assert.equal(f.sent.length, 2); await f.drain();
  assert.deepEqual((await f.events()).map(event => event.capability).sort(), ["llm.chat", "music.generate"]);
});
