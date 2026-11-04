import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Validator } from "@cfworker/json-schema";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const schema = JSON.parse(readFileSync(new URL("../../providers/_schema/service-provider.schema.json", import.meta.url)));
const validator = new Validator(schema), profile = "clawrouter.pixverse-image-input.v1";
// Preserve the original text-only source as an independent compatibility fixture.
const source = {
  schema: "clawrouter.service-provider.v1", id: "pixverse", displayName: "PixVerse", status: "experimental", class: "rest_json",
  service: { platform: "pixverse", kind: "tool_provider", upstreamService: "pixverse", configKeys: ["PIXVERSE_API_KEY"] },
  auth: { schemes: [{ type: "api_key", header: "API-KEY", secretKind: "api_key" }] },
  baseUrls: { default: "https://app-api.pixverse.ai", cn: "https://app-api.pixverseai.cn" },
  routing: { nativePrefixes: ["clawrouter-pixverse", "pixverse"], modelPrefixes: ["pixverse/"] },
  adapter: { request: "pixverse", response: "pixverse", error: "pixverse_error" },
  capabilities: [{ id: "media.predict", endpoint: "text_video", methods: ["POST"] }],
  endpoints: {
    text_video: { path: "/openapi/v2/video/text/generate", requestFormat: "pixverse.text_video", responseFormat: "pixverse.video",
      lifecycle: { protocol: "pixverse.video", retrieve: "video" }, timeoutMs: 120000 },
    video: { method: "GET", path: "/openapi/v2/video/result/${video_id}", pathParams: ["video_id"],
      requestFormat: "pixverse.video_get", responseFormat: "pixverse.video", timeoutMs: 120000 },
  },
  models: { entries: ["v6", "c1"].map(model => ({ id: `pixverse/${model}`, upstream: model, capabilities: ["media.predict"] })) },
  billing: { meter: "clawrouter.requests", dimensions: ["provider", "model", "endpoint", "key", "service", "subject"] },
};
function fixture() {
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "video.generate", endpoint: "image_video", methods: ["POST"] });
  manifest.endpoints.image_video = { method: "POST", path: "/openapi/v2/video/img/generate", pathParams: [],
    requestFormat: "pixverse.image_video", responseFormat: "pixverse.video", inputProfile: profile,
    lifecycle: { protocol: "pixverse.video", retrieve: "video" } };
  for (const model of manifest.models.entries) model.capabilities.push("video.generate");
  return manifest;
}
const compile = manifest => compileProviderSnapshot([manifest]);

test("optional input profile leaves the existing text-only contract unchanged and unprojected", () => {
  const provider = compile(structuredClone(source)).providers[0];
  assert.ok(provider.endpoints.every(endpoint => !Object.hasOwn(endpoint, "inputProfile")));
  assert.deepEqual(provider.models.map(model => model.capabilities), [["media.predict"], ["media.predict"]]);
  assert.ok(createRouteCatalog([provider]).manifestProxy.every(offer => !Object.hasOwn(offer, "inputProfile")));
});

test("exact profile compiles the registered native image route alongside its original text route", () => {
  const manifest = fixture(), result = validator.validate(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(manifest.endpoints.image_video.inputProfile, profile);
  const provider = compile(manifest).providers[0];
  const image = provider.endpoints.find(endpoint => endpoint.id === "image_video");
  assert.equal(image.inputProfile, profile);
  assert.deepEqual(image.lifecycle, { protocol: "pixverse.video", retrieve: "video" });
  assert.ok(!createRouteCatalog([provider]).manifestProxy.some(offer => offer.endpoint === "image_video"));
  const original = compile(source).providers[0];
  for (const endpoint of original.endpoints) assert.deepEqual(provider.endpoints.find(value => value.id === endpoint.id), endpoint);
});

test("input profile schema rejects aliases, wrong native pairs and caller transport controls", () => {
  for (const change of [
    e => { e.inputProfile = "pixverse.image"; }, e => { e.inputProfile = true; }, e => { e.inputProfile = null; },
    e => { e.path = "/openapi/v2/image/upload"; }, e => { e.path = "/openapi/v2/video/text/generate"; },
    e => { e.requestFormat = "pixverse.text_video"; }, e => { e.responseFormat = "openai.chat_completions"; },
    e => { e.method = "GET"; }, e => { delete e.method; }, e => { delete e.pathParams; },
    e => { e.pathParams = ["img_id"]; }, e => { e.query = { img_id: "1" }; },
    e => { e.headers = { "content-type": "multipart/form-data" }; }, e => { e.requestHeaders = ["API-KEY"]; },
    e => { e.auth = "none"; }, e => { e.upstreamPath = "/openapi/v2/video/img/generate"; },
    e => { e.streaming = "sse"; }, e => { e.modelPassthrough = {}; }, e => { delete e.lifecycle; },
    e => { e.lifecycle.protocol = "replicate.predictions"; }, e => { e.nativeProxy = false; },
  ]) {
    const manifest = fixture(); change(manifest.endpoints.image_video);
    assert.equal(validator.validate(manifest).valid, false, String(change));
    assert.throws(() => compile(manifest), /invalid manifest/);
  }
});

test("profile semantics require its provider and explicit finite video capability without authority backfill", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.capabilities.at(-1).id = "media.predict"; },
    m => { delete m.capabilities.at(-1).methods; }, m => { m.capabilities.at(-1).methods.push("GET"); },
    m => { m.capabilities.push({ id: "media.predict", endpoint: "image_video", methods: ["POST"] }); },
    m => { for (const model of m.models.entries) model.capabilities = ["media.predict"]; },
    m => { m.models.entries[0].upstream = "future"; }, m => { m.models.entries[0].id = "pixverse/alias"; },
    m => { m.models.entries[0].pricingRef = "synthetic-unqualified-price"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /inputProfile/); }
});

test("catalog type support alone never advertises a composed input profile", () => {
  const provider = compile(structuredClone(source)).providers[0];
  // Type carriers may receive metadata before the common projection is released.
  // This deliberately does not claim the injected text endpoint is eligible.
  for (const endpoint of provider.endpoints) endpoint.inputProfile = profile;
  const catalog = createRouteCatalog([provider]);
  assert.ok(catalog.manifestProxy.every(offer => !Object.hasOwn(offer, "inputProfile")));
  assert.deepEqual(catalog.openaiCompatible, []);
});


test("profiled image creation requires its exact shared-control pair in either declaration order", () => {
  const manifest = fixture(), expected = compile(manifest);
  assert.deepEqual(compile({ ...manifest, endpoints: Object.fromEntries(Object.entries(manifest.endpoints).reverse()) }), expected);
  for (const change of [
    m => { delete m.endpoints.image_video.inputProfile; },
    m => { m.endpoints.image_video.lifecycle.retrieve = "text_video"; },
    m => { m.endpoints.video.inputProfile = profile; },
    m => { m.capabilities.push({ id: "video.generate", endpoint: "video", methods: ["GET"] }); },
    m => { m.endpoints.extra_text = structuredClone(m.endpoints.text_video); m.capabilities.push({ id: "media.predict", endpoint: "extra_text", methods: ["POST"] }); },
    m => { m.endpoints.extra_image = structuredClone(m.endpoints.image_video); m.capabilities.push({ id: "video.generate", endpoint: "extra_image", methods: ["POST"] }); },
    m => { m.endpoints.image_video.lifecycle.cancel = "video"; },
    m => { m.endpoints.image_video.requestPricing = { unit: "request", successfulResponseMicros: 0 }; },
  ]) { const changed = structuredClone(manifest); change(changed); assert.throws(() => compile(changed), /inputProfile|lifecycle|invalid manifest/, String(change)); }
});
