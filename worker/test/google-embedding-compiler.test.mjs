import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { prepareGoogleEmbedding, readGoogleEmbedding } from "../provider-google-embeddings.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/embeddings.json", import.meta.url), "utf8"));
const existing = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
const contracts = [
  ["embed_content", "google.embed_content", "embedContent", "unary"],
  ["batch_embed_contents", "google.batch_embed_contents", "batchEmbedContents", "batch"],
];
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(value => value.id !== "llm.embeddings");
  manifest.models.entries = manifest.models.entries.filter(value => !value.capabilities.includes("llm.embeddings"));
  for (const [id, format, method] of contracts) {
    manifest.endpoints[id] = { path: `/v1beta/models/\${model}:${method}`, pathParams: ["model"], requestFormat: format, responseFormat: format };
    manifest.capabilities.push({ id: "llm.embeddings", endpoint: id, methods: ["POST"] });
  }
  for (const upstream of ["gemini-embedding-001", "gemini-embedding-2"]) manifest.models.entries.push({ id: `google/${upstream}`, upstream, capabilities: ["llm.embeddings"] });
  return manifest;
}

test("Google embedding format handshake preserves the actual unary/batch paths, model identity and ordered native vectors", async () => {
  const snapshot = compile(fixture()), provider = snapshot.providers[0];
  assert.deepEqual(snapshot.capability_index["llm.embeddings"].map(value => value.endpoint), contracts.map(value => value[0]));
  for (const [id, format, , mode] of contracts) {
    const endpoint = provider.endpoints.find(value => value.id === id), row = wire[mode];
    const model = snapshot.model_index[`google/${row.model}`];
    const prepared = prepareGoogleEmbedding(model.upstream, row.request, mode);
    assert.equal(endpoint.request_format, format); assert.equal(endpoint.response_format, format);
    assert.equal(endpoint.path.replace("${model}", model.upstream), prepared.path);
    assert.equal(prepared.body, row.request); assert.equal(prepared.headers.has("x-goog-api-key"), false);
    const observation = await readGoogleEmbedding(Response.json(row.response), prepared, new AbortController().signal);
    assert.deepEqual(observation.vectors, mode === "unary" ? [row.response.embedding.values] : row.response.embeddings.map(value => value.values));
    assert.equal(observation.inputTokens, row.response.usageMetadata.promptTokenCount);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null); assert.equal(observation.actualCostMicros, undefined);
  }
});

test("Google embedding declarations preserve existing generation routes and leave unknown costs unpriced", () => {
  const original = compile(existing), snapshot = compile(fixture());
  for (const endpoint of original.providers[0].endpoints.filter(value => !contracts.some(([id]) => id === value.id))) assert.deepEqual(snapshot.providers[0].endpoints.find(value => value.id === endpoint.id), endpoint);
  for (const [id, model] of Object.entries(original.model_index).filter(([, value]) => !value.capabilities.includes("llm.embeddings"))) assert.deepEqual(snapshot.model_index[id], model);
  for (const capability of ["llm.generate", "llm.stream"]) assert.deepEqual(snapshot.capability_index[capability], original.capability_index[capability]);
  const manifest = fixture(), model = manifest.models.entries.at(-1);
  model.pricing = structuredClone(manifest.models.entries[0].pricing);
  assert.throws(() => compile(manifest), /Google embeddings/);
  delete model.pricing; model.pricingRef = "unqualified";
  assert.throws(() => compile(manifest), /Google embeddings/);
  delete model.pricingRef; model.endpointPricing = { embed_content: { pricingRef: "unqualified", pricing: null } };
  assert.throws(() => compile(manifest), /Google embeddings/);
});

test("Google embedding declarations reject aliases, async jobs, model passthrough and credential overrides", () => {
  const changes = [
    m => { m.id = "other"; }, m => { delete m.endpoints.batch_embed_contents; },
    m => { m.endpoints.embed_content.requestFormat = "google.embeddings"; },
    m => { m.endpoints.embed_content.requestFormat = "other"; m.endpoints.embed_content.responseFormat = "other"; },
    m => { m.endpoints.embed_content.responseFormat = "google.batch_embed_contents"; },
    m => { m.endpoints.embed_content.path = "/v1beta/models/${model}:asyncBatchEmbedContent"; },
    m => { m.endpoints.batch_embed_contents.path = m.endpoints.embed_content.path; },
    m => { m.endpoints.embed_content.method = "GET"; }, m => { m.endpoints.embed_content.pathParams = []; },
    m => { m.endpoints.embed_content.pathParamStyles = { model: "relative_path" }; },
    m => { m.baseUrls.default += "/v1beta"; }, m => { m.baseUrls.default = "https://other.example"; },
    m => { m.auth.schemes[0].header = "Authorization"; },
    m => { m.auth.grantTransports = { api_key: { headers: { "x-goog-api-key": "synthetic" } } }; },
    m => { m.adapter.injectHeaders = { "x-goog-api-key": "synthetic" }; }, m => { m.adapter.injectQuery = { key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["x-goog-api-key"]; },
    m => { m.models.entries.at(-1).upstream = "gemini-embedding-2-preview"; },
    m => { m.models.entries.at(-1).upstream = "gemini-embedding-3"; },
    m => { m.models.entries = m.models.entries.filter(model => !model.capabilities.includes("llm.embeddings")); },
    m => { m.capabilities.find(value => value.endpoint === "embed_content").id = "llm.generate"; },
  ];
  for (const [id] of contracts) changes.push(
    m => { m.endpoints[id].headers = { "x-goog-api-key": "synthetic" }; }, m => { m.endpoints[id].requestHeaders = ["x-goog-api-key"]; },
    m => { m.endpoints[id].query = { key: "synthetic" }; }, m => { m.endpoints[id].auth = "none"; },
    m => { m.endpoints[id].streaming = "sse"; }, m => { m.endpoints[id].nativeProxy = false; }, m => { m.endpoints[id].modelPassthrough = {}; },
    m => { m.endpoints[id].lifecycle = { protocol: "google.omni_video", retrieve: "retrieve" }; });
  for (const change of changes) {
    const manifest = fixture(); change(manifest);
    assert.throws(() => compile(manifest), /Google embeddings|invalid manifest/, String(change));
  }
});

test("Google compiled batch contract cannot publish a valid prefix from an invalid later vector or foreign model", async () => {
  const provider = compile(fixture()).providers[0], endpoint = provider.endpoints.find(value => value.id === "batch_embed_contents");
  assert.equal(endpoint.request_format, "google.batch_embed_contents");
  const body = structuredClone(wire.batch.request);
  body.requests[1].model = "models/gemini-embedding-2";
  assert.throws(() => prepareGoogleEmbedding(wire.batch.model, body, "batch"), /model_mismatch/);
  const prepared = prepareGoogleEmbedding(wire.batch.model, wire.batch.request, "batch");
  const invalid = structuredClone(wire.batch.response); invalid.embeddings[1].values.pop();
  await assert.rejects(readGoogleEmbedding(Response.json(invalid), prepared, new AbortController().signal), /invalid_google_embedding_response/);
});
