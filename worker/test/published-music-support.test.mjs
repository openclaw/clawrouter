import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { overrideHotCacheConfig, clearHotCaches } = await import("../hot-cache.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");

const upstreams = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"];
const inline = { required: false, count: 1, encoding: "base64_data_url", mimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxDecodedBytes: 8388608, maxJsonBytes: 12582912, https: false, assetHandles: false };
const support = {
  version: "clawrouter.published-input.v1",
  publication: { method: "POST", path: "/v1/input-assets/openrouter/music", query: false, body: "native_plan",
    idempotencyKey: { header: "Idempotency-Key", pattern: "^[A-Za-z0-9._:-]{1,128}$" } },
  slot: "messages[0].content[1].image_url.url", count: 1, encoding: "base64_data_url",
  mimeTypes: ["image/png", "image/jpeg", "image/webp"], maxDecodedBytes: 8388608, maxJsonBytes: 12582912,
  maxForwardJsonBytes: 262144, maxLifetimeSeconds: 900, renewable: false, destinationAttempts: 1,
};
const sourcePath = new URL("../../providers/openrouter.provider.yaml", import.meta.url);
const sourceBytes = readFileSync(sourcePath, "utf8"), source = parse(sourceBytes);
function manifest(published = true, native = true) {
  const value = structuredClone(source);
  value.capabilities = value.capabilities.filter(item => item.endpoint !== "music_generate");
  value.capabilities.push({ id: "music.generate", endpoint: "music_generate", methods: ["POST"] });
  value.endpoints.music_generate = { path: "/v1/chat/completions", method: "POST", pathParams: [],
    requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions", streaming: "sse", nativeProxy: native };
  value.models.entries = value.models.entries.filter(model => !upstreams.includes(model.upstream));
  value.models.entries.push(...upstreams.map(upstream => ({ id: `openrouter/${upstream}`, upstream, capabilities: ["music.generate"],
    nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: { music_generate: {
      sources: ["https://github.com/openclaw/clawrouter/blob/e47cf8093205304d803d7e2278dceb006cbb4a9d/docs/published-music-input.md"],
      checkedAt: "2026-11-04", input: ["text", "image"], referenceImage: structuredClone(inline),
      ...(published ? { publishedInput: structuredClone(support) } : {}),
    } } } })));
  return value;
}
const entry = value => value.models.entries.find(model => model.upstream === upstreams[0]);
const facts = value => entry(value).nativeCapabilities.endpoints.music_generate;
const compile = value => compileProviderSnapshot([value]);

test("both models roundtrip closed publication support without changing inline defaults or pricing", () => {
  const value = manifest(), before = structuredClone(value), compiled = compile(value);
  assert.deepEqual(value, before);
  for (const upstream of upstreams) for (const model of [compiled.providers[0].models.find(row => row.upstream === upstream),
    JSON.parse(JSON.stringify(compiled)).model_index[`openrouter/${upstream}`]]) {
    assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.publishedInput, support);
    assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.referenceImage, inline);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  }
});

test("publication metadata is additive and preserves the entire legacy compiled declaration byte-for-byte", () => {
  const baseline = compile(manifest(false)), added = compile(manifest());
  for (const model of [...added.providers[0].models, ...Object.values(added.model_index)])
    if (upstreams.includes(model.upstream)) delete model.nativeCapabilities.endpoints.music_generate.publishedInput;
  assert.equal(JSON.stringify(added), JSON.stringify(baseline));
  assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes);
});

test("schema rejects unknown fields, missing bounds, changed routes, widened limits and permission fields", () => {
  const records = [null, {}, { ...support, version: "future" },
    ...Object.keys(support).map(key => { const copy = structuredClone(support); delete copy[key]; return copy; }),
    ...["origin", "allowed", "admitted", "grant", "automatic"].map(key => ({ ...support, [key]: true })),
    ...["maxDecodedBytes", "maxJsonBytes", "maxForwardJsonBytes", "maxLifetimeSeconds", "count", "destinationAttempts"].map(key => ({ ...support, [key]: support[key] + 1 })),
    { ...support, renewable: true }, { ...support, publication: { ...support.publication, method: "GET" } },
    { ...support, publication: { ...support.publication, query: true } },
    { ...support, publication: { ...support.publication, body: "manifest_envelope" } },
    { ...support, publication: { ...support.publication, path: "/v1/other" } },
    { ...support, publication: { ...support.publication, idempotencyKey: { header: "Other", pattern: ".*" } } },
    { ...support, mimeTypes: ["image/png"] }, { ...support, slot: "other" },
  ];
  for (const record of records) { const value = manifest(); facts(value).publishedInput = record; assert.throws(() => compile(value), /invalid manifest/); }
  for (const change of [value => { value.endpoints.music_generate.publishedInput = support; },
    value => { entry(value).publishedInput = support; }, value => { facts(value).publishedInputOrigin = { version: support.version, origin: "https://forged.example" }; }]) {
    const value = manifest(); change(value); assert.throws(() => compile(value), /invalid manifest/);
  }
});

test("compiler binds publication facts to only the frozen provider, models and registered music route", () => {
  for (const change of [
    value => { value.id = "foreign"; }, value => { value.baseUrls.default = "https://foreign.example/api"; },
    value => { entry(value).upstream = "google/lyria-4"; }, value => { entry(value).id = "openrouter/google/lyria-4"; },
    value => { entry(value).capabilities.push("llm.chat"); }, value => { facts(value).input = ["text"]; },
    value => { value.endpoints.music_generate.path = "/v1/other"; }, value => { value.endpoints.music_generate.method = "GET"; },
    value => { value.endpoints.music_generate.query = { mode: "other" }; }, value => { delete value.endpoints.music_generate.streaming; },
    value => { value.endpoints.music_generate.requestFormat = "openai.responses"; },
    value => { value.endpoints.music_generate.responseFormat = "openai.responses"; },
    value => { value.capabilities.push({ id: "llm.chat", endpoint: "music_generate", methods: ["POST"] }); },
    value => { entry(value).capabilities = ["llm.chat"]; entry(value).nativeCapabilities.endpoints = { chat_completions: facts(value) }; },
  ]) {
    const value = manifest(); delete facts(value).referenceImage; change(value);
    assert.throws(() => compile(value), /publishedInput/);
  }
});

async function setup(t, { published = true, native = true } = {}) {
  const original = snapshot.providers;
  snapshot.providers = original.map(provider => provider.id === "openrouter" ? structuredClone(provider) : provider);
  t.after(() => { snapshot.providers = original; });
  const compiled = compile(manifest(published, native)).providers[0];
  const f = await fixture(t, { providerId: "openrouter", pooled: true, compiledProvider: true,
    configure(provider) { Object.assign(provider, compiled); } });
  f.advance(1);
  f.upstream = () => { throw new Error("support metadata cannot publish or dispatch"); };
  t.after(f.drain);
  f.catalog = async (headers = {}) => {
    const response = await f.call("/v1/catalog", null, { headers }); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.has("etag"), false);
    return (await response.json()).providers.find(provider => provider.id === "openrouter");
  };
  return f;
}
const musicOffers = provider => provider?.offers.filter(offer => offer.endpoint === "music_generate" && offer.modelId) ?? [];
function origins(provider, origin) {
  const offers = musicOffers(provider); assert.equal(offers.length, 2);
  for (const offer of offers) assert.deepEqual(offer.publishedInputOrigin, origin ? { version: support.version, origin } : undefined);
  for (const offer of provider.offers.filter(offer => offer.endpoint !== "music_generate" || !offer.modelId)) assert.equal(offer.publishedInputOrigin, undefined);
}

for (const native of [true, false]) test(`eligible ${native ? "native" : "manifest"} offers project only the configured origin without granting permission`, async t => {
  const f = await setup(t, { native }); f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://media.example:8443";
  assert.equal(f.policy.inputPublication, undefined);
  const catalog = await f.catalog({ origin: "https://forged.example", "x-forwarded-host": "forged.example", "x-forwarded-proto": "https" });
  origins(catalog, f.env.CLAWROUTER_PUBLIC_ORIGIN);
  for (const model of catalog.models.filter(model => upstreams.includes(model.upstream))) {
    assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.publishedInput, support);
    assert.deepEqual(model.nativeCapabilities.endpoints.music_generate.referenceImage, inline);
  }
  assert.ok(musicOffers(catalog).every(offer => offer.routeKind === (native ? "native" : "manifest")));
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
  await revokeGrantCredentials(f.env, grantKey);
  const denied = await f.catalog();
  assert.ok(!denied?.offers.some(offer => offer.eligible || offer.publishedInputOrigin));
});

test("missing or invalid configured origin omits publication origin while text and inline catalog remain identical", async t => {
  const f = await setup(t), baseline = await f.catalog(); origins(baseline, null);
  for (const origin of [undefined, "", "http://media.example", "https://media.example/", " https://media.example",
    "https://MEDIA.example", "https://media.example:443", "https://u:p@media.example", "https://media.example/path",
    "https://media.example?x=1", "https://media.example#fragment", "not a URL"]) {
    f.env.CLAWROUTER_PUBLIC_ORIGIN = origin;
    const catalog = await f.catalog({ origin: "https://forged.example", forwarded: "host=forged.example;proto=https", "if-none-match": '"stale"' });
    assert.deepEqual(catalog, baseline);
  }
  assert.equal(f.sent.length, 0);
});

test("an origin alone cannot attach publication support to legacy offers", async t => {
  const f = await setup(t, { published: false }), baseline = await f.catalog();
  f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://media.example";
  assert.deepEqual(await f.catalog(), baseline);
});

test("malformed and foreign compiled support cannot gain public publication facts", async t => {
  const f = await setup(t); f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://media.example";
  const model = f.provider.models.find(model => upstreams.includes(model.upstream));
  model.nativeCapabilities.endpoints.music_generate.publishedInput = { ...support, permission: true };
  const other = f.provider.models.find(model => !upstreams.includes(model.upstream) && model.capabilities.includes("llm.chat"));
  assert.ok(other);
  other.nativeCapabilities = { version: "clawrouter.native-capabilities.v1", endpoints: { chat_completions: {
    sources: ["https://example.com"], checkedAt: "2026-11-04", input: ["text", "image"], publishedInput: support } } };
  const catalog = await f.catalog();
  for (const id of [model.id, other.id]) {
    assert.ok(catalog.offers.filter(offer => offer.modelId === id).every(offer => !offer.publishedInputOrigin));
    assert.ok(Object.values(catalog.models.find(model => model.id === id)?.nativeCapabilities?.endpoints ?? {}).every(facts => !facts.publishedInput));
  }
});

test("configured origin participates in warm and cross-isolate catalog cache identity", async t => {
  const f = await setup(t); overrideHotCacheConfig({ maxAgeMs: 60_000, freshMs: 10_000 });
  const previous = globalThis.caches, entries = new Map(); let hits = 0;
  globalThis.caches = { default: {
    async match(url) { const body = entries.get(String(url)); if (body) hits++; return body ? new Response(body) : undefined; },
    async put(url, response) { entries.set(String(url), await response.text()); },
  } };
  t.after(() => { globalThis.caches = previous; overrideHotCacheConfig(); clearHotCaches(); });
  f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://first.example";
  const first = await f.catalog(); origins(first, f.env.CLAWROUTER_PUBLIC_ORIGIN); await f.drain();
  assert.deepEqual(await f.catalog(), first);
  f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://second.example";
  origins(await f.catalog(), f.env.CLAWROUTER_PUBLIC_ORIGIN); await f.drain();
  clearHotCaches(); f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://first.example";
  const before = hits; assert.deepEqual(await f.catalog(), first); assert.ok(hits > before, "qualified same-origin colo snapshot was exercised");
  clearHotCaches(); f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://third.example";
  origins(await f.catalog(), f.env.CLAWROUTER_PUBLIC_ORIGIN); await f.drain();
  clearHotCaches(); delete f.env.CLAWROUTER_PUBLIC_ORIGIN;
  origins(await f.catalog({ "if-none-match": '"old-origin"' }), null);
  assert.equal(f.sent.length, 0);
});
