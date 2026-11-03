import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { prepareXaiImage, readXaiImage } from "../xai-images.ts";
const { imageRequestReserve, imageRequestCost } = await import("../pricing.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const original = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/images.json", import.meta.url), "utf8"));
const tariff = {
  unit: "image", protocol: "xai.images", version: "xai-images-2026-11-03", effectiveAt: "2026-11-03",
  source: "https://docs.x.ai/developers/pricing", receipt: "xai.usage.cost_in_usd_ticks",
  alias: { selectedModel: "grok-imagine-image-quality", servingModel: "grok-imagine-image-2.0", quality: "low",
    effectiveAt: "2026-11-02", source: "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2" },
  rates: {
    "grok-imagine-image": { inputMicrosPerImage: 2000, outputMicrosPerImage: { "1k": 20000, "2k": 20000 } },
    "grok-imagine-image-2.0": { inputMicrosPerImage: 10000, outputMicrosPerImage: { low: { "1k": 40000, "2k": 60000 }, medium: { "1k": 60000, "2k": 80000 } } },
  },
};
const contracts = [["images_generations", "xai.images_generations", "generate"], ["images_edits", "xai.images_edits", "edit"]];
function fixture() {
  const manifest = structuredClone(original);
  manifest.capabilities = manifest.capabilities.filter(row => !contracts.some(([id]) => row.endpoint === id));
  manifest.models.entries = manifest.models.entries.filter(row => !row.capabilities?.includes("image.generate"));
  for (const [id, format, mode] of contracts) {
    manifest.endpoints[id] = { path: `/v1/images/${mode === "generate" ? "generations" : "edits"}`, requestFormat: format, responseFormat: "xai.images", requestPricing: structuredClone(tariff) };
    manifest.capabilities.push({ id: "image.generate", endpoint: id, methods: ["POST"] });
  }
  for (const upstream of ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"])
    manifest.models.entries.push({ id: `xai/${upstream}`, upstream, capabilities: ["image.generate"] });
  return manifest;
}
const compile = manifest => compileProviderSnapshot([manifest]);
const prepare = (mode, extra = {}) => {
  const body = { ...wire[mode], ...extra };
  return prepareXaiImage(body.model, mode, body);
};
const result = (request, ticks) => ({ model: request.servingModel, data: Array.from({ length: request.count }, () => ({ b64_json: "AP+A" })), usage: { cost_in_usd_ticks: ticks } });

test("compiled native image contracts preserve codec paths, selected aliases, serving identity and actual receipts", async () => {
  const snapshot = compile(fixture()), provider = snapshot.providers[0];
  for (const [id, format, mode] of contracts) {
    const endpoint = provider.endpoints.find(value => value.id === id), request = prepare(mode);
    assert.equal(endpoint.request_format, format); assert.equal(endpoint.response_format, "xai.images");
    assert.equal(endpoint.path, request.path); assert.deepEqual(endpoint.requestPricing, tariff);
    assert.equal(request.model, "grok-imagine-image-quality"); assert.equal(request.body.model, request.model);
    assert.equal(request.servingModel, tariff.alias.servingModel); assert.equal(request.quality, "low");
    const response = result(request, mode === "generate" ? 400_000_000 : 500_000_000);
    const observation = await readXaiImage(Response.json(response), request, new AbortController().signal);
    assert.equal(observation.selectedModel, request.model); assert.equal(observation.servingModel, request.servingModel);
    assert.deepEqual([...observation.images[0]], [0, 255, 128]);
    assert.deepEqual(imageRequestCost(endpoint.requestPricing, request, observation.body, true), {
      costMicros: mode === "generate" ? 40_000 : 50_000, basis: "provider_reported", pricingVersion: tariff.version,
    });
    const model = snapshot.model_index[`xai/${request.model}`];
    assert.equal(model.pricing, null);
    const estimate = estimateCost(model, request.body, null, "image.generate", endpoint);
    assert.throws(() => validateBudgetReservation("image.generate", estimate, 1_000_000), error => error.code === "pricing_required", "generic admission cannot activate an unsupported tariff");
    for (const fixed of [0, 50_000]) {
      const explicit = estimateCost(model, request.body, fixed, "image.generate", endpoint);
      assert.equal(explicit.basis, "policy_fixed"); assert.equal(explicit.reserveMicros, fixed);
      assert.equal(validateBudgetReservation("image.generate", explicit, 1_000_000), true);
    }
  }
  const baseline = compile(original);
  for (const endpoint of baseline.providers[0].endpoints.filter(row => !contracts.some(([id]) => row.id === id))) assert.deepEqual(provider.endpoints.find(value => value.id === endpoint.id), endpoint);
  for (const [id, row] of Object.entries(baseline.model_index).filter(([, row]) => !row.capabilities.includes("image.generate"))) assert.deepEqual(snapshot.model_index[id], row);
});

test("image reservations separate alias low, explicit quality, service defaults and unaffected 1.0", () => {
  for (const [mode, extra, expected] of [
    ["generate", {}, 40_000], ["edit", {}, 50_000], ["edit", { resolution: "2k" }, 70_000],
    ["generate", { model: "grok-imagine-image-2.0" }, 60_000],
    ["edit", { model: "grok-imagine-image-2.0" }, 70_000],
    ["edit", { model: "grok-imagine-image-2.0", quality: "low" }, 50_000],
    ["edit", { model: "grok-imagine-image-2.0", quality: "medium", resolution: "2k" }, 90_000],
    ["generate", { model: "grok-imagine-image", resolution: "2k" }, 20_000],
    ["edit", { model: "grok-imagine-image" }, 22_000],
  ]) assert.equal(imageRequestReserve(tariff, prepare(mode, extra)), expected, JSON.stringify([mode, extra]));
  const { image, ...edit } = wire.edit;
  for (const [model, expected] of [["grok-imagine-image-quality", 360_000], ["grok-imagine-image-2.0", 440_000], ["grok-imagine-image", 104_000]]) {
    const request = prepareXaiImage(model, "edit", { ...edit, model, n: 4, resolution: "2k", images: [image, image, image] });
    assert.equal(imageRequestReserve(tariff, request), expected, "every reference is conservatively reserved per output, even when repeated");
  }
});

test("image cost uses complete native ticks rather than defaults, counts, refusal text or token-shaped usage", () => {
  const request = prepare("generate", { model: "grok-imagine-image-2.0" });
  assert.equal(imageRequestReserve(tariff, request), 60_000);
  for (const [ticks, expected] of [[0, 0], [1, 1], [10_000, 1], [10_001, 2], [400_000_000, 40_000], [Number.MAX_SAFE_INTEGER, 900_719_925_475]])
    assert.equal(imageRequestCost(tariff, request, result(request, ticks), true).costMicros, expected);
  for (const ticks of [undefined, null, -1, 0.5, "400000000", Number.MAX_SAFE_INTEGER + 1])
    assert.equal(imageRequestCost(tariff, request, result(request, ticks), true), null);
  for (const change of [
    body => { delete body.model; }, body => { body.model = "grok-imagine-image-quality"; },
    body => { body.error = { code: "synthetic_refusal" }; }, body => { body.status = "pending"; },
    body => { body.usage = { input_tokens: 0, output_tokens: 0, cost_in_usd_nanos: 1 }; },
  ]) { const body = result(request, 400_000_000); change(body); assert.equal(imageRequestCost(tariff, request, body, true), null); }
  assert.equal(imageRequestCost(tariff, request, result(request, 400_000_000), false), null);
  const alias = prepare("edit");
  assert.equal(imageRequestCost(tariff, alias, { ...result(alias, 500_000_000), model: alias.model }, true), null);
});

test("unknown image bounds, invalid aliases and unsafe tariff arithmetic cannot become zero-cost reservations", () => {
  const request = prepare("edit");
  for (const change of [
    r => { r.model = "grok-imagine-image-pro"; }, r => { r.servingModel = r.model; },
    r => { r.quality = "medium"; }, r => { r.qualityBasis = "service_default"; },
    r => { r.resolution = "1.5k"; }, r => { r.count = 0; }, r => { r.count = 5; }, r => { r.count = 1.5; },
    r => { r.inputImages = 0; }, r => { r.inputImages = 4; }, r => { r.mode = "generate"; },
  ]) { const selection = { ...request }; change(selection); assert.equal(imageRequestReserve(tariff, selection), null); }
  for (const change of [
    p => { p.unit = "request"; }, p => { p.receipt = "usage.tokens"; }, p => { p.alias.quality = "medium"; },
    p => { p.rates["grok-imagine-image-2.0"].inputMicrosPerImage = null; },
    p => { p.rates["grok-imagine-image-2.0"].outputMicrosPerImage.low["1k"] = 0; },
    p => { p.rates["grok-imagine-image-2.0"].outputMicrosPerImage.low["1k"] = Number.MAX_SAFE_INTEGER; },
    p => { delete p.rates["grok-imagine-image-2.0"]; },
  ]) { const pricing = structuredClone(tariff); change(pricing); assert.equal(imageRequestReserve(pricing, request), null); }
});

test("image declarations reject mixed protocols, raw controls, token cards and credential overrides", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://us.api.x.ai"; },
    m => { m.auth.schemes[0].format = "Token ${secret}"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { Authorization: "synthetic" } } }; },
    m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.models.entries.at(-1).upstream = "grok-imagine-image-pro"; },
    m => { m.models.entries.at(-1).pricing = structuredClone(m.models.entries.find(row => row.upstream === "grok-4.3").pricing); },
    m => { m.capabilities.find(row => row.endpoint === "images_edits").id = "llm.chat"; },
    m => { m.endpoints.chat_completions.requestPricing = structuredClone(tariff); },
  ];
  for (const [id] of contracts) changes.push(
    m => { m.endpoints[id].requestFormat = "openai.images_generations"; }, m => { m.endpoints[id].responseFormat = "other"; },
    m => { m.endpoints[id].path = "/v1/images/${id}"; }, m => { m.endpoints[id].method = "GET"; },
    m => { m.endpoints[id].headers = { Authorization: "synthetic" }; }, m => { m.endpoints[id].requestHeaders = ["Authorization"]; },
    m => { m.endpoints[id].query = { deferred: "true" }; }, m => { m.endpoints[id].streaming = "sse"; },
    m => { m.endpoints[id].nativeProxy = false; }, m => { m.endpoints[id].modelPassthrough = {}; },
    m => { m.endpoints[id].lifecycle = { protocol: "replicate.predictions", retrieve: "get", cancel: "cancel" }; });
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /xAI image|invalid manifest/, String(change)); }
});

test("compiler freezes published per-image rates and alias semantics while preserving explicitly unpriced declarations", () => {
  for (const change of [
    p => { p.alias.quality = "medium"; }, p => { p.alias.effectiveAt = "2026-11-03"; },
    p => { p.receipt = "error.code"; }, p => { p.maximumAdditionalMicros = 50000; },
    p => { p.rates["grok-imagine-image-2.0"].outputMicrosPerImage.low["1k"] = 60000; },
    p => { p.rates["grok-imagine-image"].inputMicrosPerImage = 0; },
    p => { p.rates["grok-imagine-image-quality"] = p.rates["grok-imagine-image-2.0"]; },
  ]) { const manifest = fixture(); change(manifest.endpoints.images_edits.requestPricing); assert.throws(() => compile(manifest), /invalid manifest/); }
  const unpriced = fixture(); for (const [id] of contracts) delete unpriced.endpoints[id].requestPricing;
  assert.ok(compile(unpriced).providers[0].endpoints.filter(endpoint => endpoint.response_format === "xai.images").every(endpoint => endpoint.requestPricing === undefined));
});
