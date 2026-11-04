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

const upstreams = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"];
const referenceImage = { required: false, count: 1, encoding: "base64_data_url",
  mimeTypes: ["image/png", "image/jpeg", "image/webp"], maxDecodedBytes: 8388608,
  maxJsonBytes: 12582912, https: false, assetHandles: false };
const sourceBytes = readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8");
const source = parse(sourceBytes);
function manifest(profiled = true, native = true) {
  const value = structuredClone(source);
  value.capabilities = value.capabilities.filter(item => item.endpoint !== "music_generate");
  value.capabilities.push({ id: "music.generate", endpoint: "music_generate", methods: ["POST"] });
  value.endpoints.music_generate = { path: "/v1/chat/completions", method: "POST", pathParams: [],
    requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions",
    streaming: "sse", nativeProxy: native, timeoutMs: 600000 };
  value.models.entries = value.models.entries.filter(model => !upstreams.includes(model.upstream));
  value.models.entries.push(...upstreams.map(upstream => ({ id: `openrouter/${upstream}`, upstream,
    capabilities: ["music.generate"], nativeCapabilities: { version: "clawrouter.native-capabilities.v1",
      endpoints: { music_generate: {
        sources: ["https://github.com/openclaw/clawrouter/blob/23aaaff55343ec0d94d5786557196ef99be04941/docs/openrouter-music-contract.md"],
        checkedAt: "2026-11-04", input: profiled ? ["text", "image"] : ["text"],
        ...(profiled ? { referenceImage: structuredClone(referenceImage) } : {}),
      } },
    } })));
  return value;
}
const entry = value => value.models.entries.find(model => model.upstream === upstreams[0]);
const facts = value => entry(value).nativeCapabilities.endpoints.music_generate;
const compile = value => compileProviderSnapshot([value]);

test("both Lyria models preserve the exact optional inline reference record through compilation and JSON", () => {
  const input = manifest(), original = structuredClone(input), result = compile(input);
  assert.deepEqual(input, original);
  for (const upstream of upstreams) {
    const id = `openrouter/${upstream}`;
    for (const model of [result.providers[0].models.find(model => model.id === id), JSON.parse(JSON.stringify(result)).model_index[id]]) {
      assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.referenceImage, referenceImage);
      assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.input, ["text", "image"]);
      assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    }
  }
});

test("adding reference support preserves legacy text declarations, Chat, auth, endpoints and prices byte-for-byte", () => {
  const baseline = compile(manifest(false)), stripped = compile(manifest());
  for (const model of [...stripped.providers[0].models, ...Object.values(stripped.model_index)]) {
    if (!upstreams.includes(model.upstream)) continue;
    const metadata = model.nativeCapabilities.endpoints.music_generate;
    delete metadata.referenceImage; metadata.input = ["text"];
  }
  assert.equal(JSON.stringify(stripped), JSON.stringify(baseline));
  assert.equal(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"), sourceBytes);
  assert.equal(stripped.providers[0].endpoints.find(endpoint => endpoint.id === "music_generate").referenceImage, undefined);
});

test("reference metadata is closed, retains false, and rejects missing fields, larger bounds and asset authority", () => {
  const invalid = [null, {}, { ...referenceImage, required: true }, { ...referenceImage, count: 0 },
    { ...referenceImage, count: 2 }, { ...referenceImage, count: "1" },
    { ...referenceImage, encoding: "url" }, { ...referenceImage, mimeTypes: ["image/png"] },
    { ...referenceImage, mimeTypes: ["image/png", "image/jpeg", "image/gif"] },
    { ...referenceImage, maxDecodedBytes: 8388609 }, { ...referenceImage, maxJsonBytes: 12582913 },
    { ...referenceImage, https: true }, { ...referenceImage, https: "false" },
    { ...referenceImage, assetHandles: true },
    ...["allowed", "admitted", "retention", "pricing", "upload", "grant"].map(key => ({ ...referenceImage, [key]: true })),
    ...Object.keys(referenceImage).map(key => { const value = structuredClone(referenceImage); delete value[key]; return value; }),
  ];
  for (const record of invalid) {
    const value = manifest(); facts(value).referenceImage = record;
    assert.throws(() => compile(value), /invalid manifest/);
  }
});

test("reference facts cannot move to a foreign provider, selected model, global endpoint or model root", () => {
  for (const change of [
    value => { value.id = "foreign"; },
    value => { entry(value).id = "openrouter/google/another-model"; },
    value => { entry(value).upstream = "google/another-model"; },
    value => { entry(value).capabilities.push("llm.chat"); },
    value => { facts(value).input = ["image"]; },
    value => { facts(value).input = ["text"]; },
    value => { facts(value).input = ["text", "image", "audio"]; },
  ]) { const value = manifest(); change(value); assert.throws(() => compile(value), /referenceImage/); }
  for (const change of [
    value => { value.endpoints.music_generate.referenceImage = structuredClone(referenceImage); },
    value => { entry(value).referenceImage = structuredClone(referenceImage); },
  ]) { const value = manifest(); change(value); assert.throws(() => compile(value), /invalid manifest/); }
});

test("reference facts require the registered music endpoint and cannot broaden shared Chat or another wire contract", () => {
  for (const change of [
    value => { value.baseUrls.default = "https://example.com/api"; },
    value => { value.endpoints.music_generate.path = "/v1/other"; },
    value => { value.endpoints.music_generate.method = "GET"; },
    value => { value.endpoints.music_generate.requestFormat = "openai.responses"; },
    value => { value.endpoints.music_generate.responseFormat = "openai.responses"; },
    value => { delete value.endpoints.music_generate.streaming; },
    value => { value.endpoints.music_generate.query = { mode: "other" }; },
    value => { value.endpoints.music_generate.modelPassthrough = {}; },
    value => { value.capabilities.find(item => item.endpoint === "music_generate").methods = ["POST", "GET"]; },
    value => { value.capabilities.push({ id: "llm.chat", endpoint: "music_generate", methods: ["POST"] }); },
    value => {
      const metadata = facts(value);
      entry(value).nativeCapabilities.endpoints = { chat_completions: metadata };
      entry(value).capabilities = ["llm.chat"];
    },
    value => {
      value.endpoints.foreign_music = value.endpoints.music_generate; delete value.endpoints.music_generate;
      value.capabilities.find(item => item.endpoint === "music_generate").endpoint = "foreign_music";
      for (const model of value.models.entries.filter(model => upstreams.includes(model.upstream))) {
        model.nativeCapabilities.endpoints = { foreign_music: model.nativeCapabilities.endpoints.music_generate };
      }
    },
  ]) { const value = manifest(); change(value); assert.throws(() => compile(value), /referenceImage/); }
});

// Only in-memory declarations: no bundled route, image dispatch or client claim.
for (const native of [false, true]) test(`public ${native ? "native" : "manifest"} projection keeps image modality inseparable from inline-only facts`, async t => {
  const original = snapshot.providers;
  snapshot.providers = original.map(provider => provider.id === "openrouter" ? structuredClone(provider) : provider);
  t.after(() => { snapshot.providers = original; });
  const compiled = compile(manifest(true, native)).providers[0];
  const f = await fixture(t, { providerId: "openrouter", pooled: true, compiledProvider: true,
    configure(provider) { Object.assign(provider, compiled); } });
  t.after(f.drain);
  f.upstream = () => { throw new Error("metadata projection cannot dispatch music"); };
  const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
  const catalog = await response.json(), provider = catalog.providers.find(provider => provider.id === "openrouter");
  for (const upstream of upstreams) {
    const model = provider.models.find(model => model.upstream === upstream); assert.ok(model);
    assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.input, ["text", "image"]);
    assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.referenceImage, referenceImage);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    const offers = provider.offers.filter(offer => offer.endpoint === "music_generate" && offer.modelId === model.id);
    assert.deepEqual(offers.map(offer => [offer.routeKind, offer.route]), [[native ? "native" : "manifest",
      native ? "/v1/native/openrouter/v1/chat/completions" : "/v1/proxy/openrouter/music_generate"]]);
    assert.ok(offers.every(offer => offer.referenceImage === undefined));
  }
  assert.equal(provider.routes.find(route => route.endpoint === "music_generate").referenceImage, undefined);
  for (const model of provider.models.filter(model => !upstreams.includes(model.upstream)))
    assert.ok(Object.values(model.nativeCapabilities?.endpoints ?? {}).every(facts => facts.referenceImage === undefined));
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-original-key/);
  await revokeGrantCredentials(f.env, grantKey);
  const denied = await (await f.call("/v1/catalog", null)).json();
  assert.ok(!denied.providers.find(provider => provider.id === "openrouter")?.offers.some(offer => offer.eligible));
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});
