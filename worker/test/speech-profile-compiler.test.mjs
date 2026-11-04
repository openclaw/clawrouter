import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");

const upstream = "google/gemini-3.1-flash-tts-preview", modelId = `openrouter/${upstream}`;
const mp3Models = ["hexgrad/kokoro-82m", "elevenlabs/eleven-turbo-v2", "mistralai/voxtral-mini-tts-2603"];
const profile = { voiceRequired: true, responseFormat: "pcm",
  output: { kind: "opaque", mimeType: "audio/pcm", sampleRate: null, voiceCompatible: false } };
const source = parse(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"));
function manifest(native = true) {
  const value = structuredClone(source);
  value.capabilities = value.capabilities.filter(item => item.endpoint !== "speech");
  value.capabilities.push({ id: "audio.speech", endpoint: "speech", methods: ["POST"] });
  value.endpoints.speech = { path: "/v1/audio/speech", method: "POST", requestFormat: "openai.audio_speech",
    responseFormat: "audio.binary", nativeProxy: native, timeoutMs: 120000 };
  value.models.entries = value.models.entries.filter(model => ![upstream, ...mp3Models].includes(model.upstream));
  value.models.entries.push(...mp3Models.map(upstream => ({ id: `openrouter/${upstream}`, upstream, capabilities: ["audio.speech"] })),
    { id: modelId, upstream, capabilities: ["audio.speech"], nativeCapabilities: {
      version: "clawrouter.native-capabilities.v1", endpoints: { speech: {
        sources: ["https://openrouter.ai/docs/guides/overview/multimodal/tts"], checkedAt: "2026-11-04",
        input: ["text"], speech: structuredClone(profile),
      } },
    } });
  return value;
}
const entry = value => value.models.entries.find(model => model.id === modelId);
const facts = value => entry(value).nativeCapabilities.endpoints.speech;
const compile = value => compileProviderSnapshot([value]);

test("opaque PCM facts preserve explicit false/null in compiled models and JSON model index without changing prices or peers", () => {
  const input = manifest(), original = structuredClone(input), result = compile(input);
  const model = result.providers[0].models.find(model => model.id === modelId);
  assert.deepEqual(input, original);
  for (const actual of [model, JSON.parse(JSON.stringify(result)).model_index[modelId]]) {
    assert.deepEqual(actual.nativeCapabilities.endpoints.speech.speech, profile);
    assert.equal(actual.nativeCapabilities.endpoints.speech.speech.output.sampleRate, null);
    assert.equal(actual.nativeCapabilities.endpoints.speech.speech.output.voiceCompatible, false);
    assert.equal(actual.pricing, null); assert.equal(actual.pricing_ref, null);
  }
  const without = manifest(); delete facts(without).speech;
  const baseline = compile(without), stripped = structuredClone(result);
  delete stripped.providers[0].models.find(model => model.id === modelId).nativeCapabilities.endpoints.speech.speech;
  delete stripped.model_index[modelId].nativeCapabilities.endpoints.speech.speech;
  assert.deepEqual(stripped, baseline, "support metadata changes neither peers, endpoints, capabilities nor accounting");
  assert.ok(result.providers[0].models.filter(model => mp3Models.includes(model.upstream)).every(model => model.nativeCapabilities === undefined));
  assert.equal(result.providers[0].endpoints.find(endpoint => endpoint.id === "speech").speech, undefined);
});

test("speech profile is closed and rejects defaults, playback claims, invented sample facts and authority", () => {
  const changes = [
    value => { facts(value).speech = null; },
    value => { facts(value).speech.voiceRequired = false; },
    value => { facts(value).speech.voiceRequired = "true"; },
    value => { facts(value).speech.responseFormat = "mp3"; },
    value => { facts(value).speech.responseFormat = ["pcm", "wav"]; },
    value => { facts(value).speech.output.kind = "playable"; },
    value => { facts(value).speech.output.mimeType = "audio/wav"; },
    value => { facts(value).speech.output.sampleRate = 24000; },
    value => { facts(value).speech.output.sampleRate = 0; },
    value => { facts(value).speech.output.voiceCompatible = true; },
    value => { facts(value).speech.output.voiceCompatible = "false"; },
    ...["voiceRequired", "responseFormat", "output"].map(key => value => { delete facts(value).speech[key]; }),
    ...Object.keys(profile.output).map(key => value => { delete facts(value).speech.output[key]; }),
    ...["defaultVoice", "voices", "allowed", "admitted", "pricing"].map(key => value => { facts(value).speech[key] = "synthetic"; }),
    ...["channels", "byteOrder", "bitsPerSample", "signed", "playback", "talk"].map(key => value => { facts(value).speech.output[key] = "synthetic"; }),
    value => { delete facts(value).sources; },
    value => { delete facts(value).checkedAt; },
  ];
  for (const change of changes) { const value = manifest(); change(value); assert.throws(() => compile(value), /invalid manifest/); }
});

test("speech facts cannot attach globally, to another model's endpoint, or to a non-unary speech protocol", () => {
  for (const change of [
    value => { value.endpoints.speech.speech = structuredClone(profile); },
    value => { entry(value).speech = structuredClone(profile); },
  ]) { const value = manifest(); change(value); assert.throws(() => compile(value), /invalid manifest/); }
  for (const change of [
    value => { entry(value).capabilities = ["llm.chat"]; },
    value => { entry(value).nativeCapabilities.endpoints.missing = facts(value); },
  ]) { const value = manifest(); change(value); assert.throws(() => compile(value), /supported endpoint/); }
  for (const change of [
    value => { value.endpoints.speech.requestFormat = "openai.chat_completions"; },
    value => { value.endpoints.speech.responseFormat = "openai.chat_completions"; },
    value => { value.endpoints.speech.method = "GET"; },
    value => { value.endpoints.speech.streaming = "sse"; },
    value => { value.capabilities.find(item => item.endpoint === "speech").methods = ["POST", "GET"]; },
    value => {
      value.capabilities.find(item => item.endpoint === "speech").id = "llm.chat";
      entry(value).capabilities = ["llm.chat"];
    },
  ]) { const value = manifest(); change(value); assert.throws(() => compile(value), /speech profile requires/); }
});

// In-memory declarations exercise catalog projection only. They do not activate
// bundled YAML or invoke the pending common PCM dispatch path.
for (const native of [false, true]) test(`public ${native ? "native" : "manifest"} catalog preserves model-scoped opaque PCM facts without granting authority`, async t => {
  const original = snapshot.providers;
  snapshot.providers = original.map(provider => provider.id === "openrouter" ? structuredClone(provider) : provider);
  t.after(() => { snapshot.providers = original; });
  const compiled = compile(manifest(native)).providers[0];
  const f = await fixture(t, { providerId: "openrouter", pooled: true, compiledProvider: true,
    configure(provider) { Object.assign(provider, compiled); } });
  t.after(f.drain);
  f.upstream = () => { throw new Error("metadata projection cannot dispatch audio"); };
  const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
  const catalog = await response.json(), provider = catalog.providers.find(provider => provider.id === "openrouter");
  const model = provider.models.find(model => model.id === modelId); assert.ok(model);
  assert.deepEqual(model.nativeCapabilities.endpoints.speech.speech, profile);
  assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  for (const upstream of mp3Models) assert.equal(provider.models.find(model => model.upstream === upstream)?.nativeCapabilities, undefined);
  assert.equal(provider.routes.find(route => route.endpoint === "speech").speech, undefined);
  const offers = provider.offers.filter(offer => offer.endpoint === "speech" && offer.modelId === modelId);
  assert.ok(offers.length); assert.ok(offers.every(offer => offer.routeKind === (native ? "native" : "manifest")));
  assert.ok(offers.every(offer => offer.speech === undefined));
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-original-key/);
  await revokeGrantCredentials(f.env, grantKey);
  const denied = await (await f.call("/v1/catalog", null)).json();
  assert.ok(!denied.providers.find(provider => provider.id === "openrouter")?.offers.some(offer => offer.eligible));
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});
