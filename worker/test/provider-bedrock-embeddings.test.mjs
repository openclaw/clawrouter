import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareBedrockEmbedding, observeBedrockEmbedding, bedrockEmbeddingModels } from "../provider-bedrock-embeddings.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/amazon-bedrock/embeddings.json", import.meta.url), "utf8"));
const example = model => wire.cases.find(item => item.model === model);
const titan = example("amazon.titan-embed-text-v2:0"), cohere = example("cohere.embed-v4:0");

test("Bedrock embedding fixtures cover every frozen model with exact native shape and vector dimensions", () => {
  assert.equal(bedrockEmbeddingModels.length, 10);
  assert.equal(wire.cases.length, 10);
  for (const item of wire.cases) {
    const request = prepareBedrockEmbedding(item.model, item.body);
    assert.equal(request.body, item.body);
    assert.equal(request.path, "/model/" + encodeURIComponent(item.model) + "/invoke");
    assert.equal(request.dimensions, item.dimensions);
    assert.equal(request.headers.get("authorization"), null);
    const observed = observeBedrockEmbedding(item.response, request, true);
    assert.equal(observed.vectors.length, item.body.texts?.length ?? 1);
    assert.equal(observed.inputTokens, item.inputTokens);
    assert.equal(observed.vectors[0].length, item.dimensions);
    assert.equal(observed.vectors[0][0], 1);
  }
});

test("Bedrock family resolution preserves profile/throughput identity and never guesses a wire for unknown models", () => {
  const model = "us.amazon.titan-embed-text-v2:0:2:8k";
  const value = prepareBedrockEmbedding(model, titan.body);
  assert.equal(value.modelId, model);
  assert.equal(value.path, "/model/us.amazon.titan-embed-text-v2%3A0%3A2%3A8k/invoke");
  for (const id of ["amazon.titan-embed-text-v9", "cohere.embed-v4:0:foreign", "../amazon.titan-embed-text-v1", "https://api.example/model", "constructor"]) assert.throws(() => prepareBedrockEmbedding(id, titan.body), /unsupported_bedrock_embedding_model/);
});

test("Bedrock Marengo 2.7 flat input and 3.0 nested input cannot be interchanged", () => {
  const old = example("us.twelvelabs.marengo-embed-2-7-v1:0"), current = example("twelvelabs.marengo-embed-3-0-v1:0");
  assert.throws(() => prepareBedrockEmbedding(old.model, current.body));
  assert.throws(() => prepareBedrockEmbedding(current.model, old.body));
  assert.throws(() => prepareBedrockEmbedding(old.model, { inputType: "video", mediaSource: { base64String: "AAAA" } }));
});

test("Bedrock Cohere v4 validates primary dimension/truncation contract and both native float response shapes", () => {
  for (const output_dimension of [384, 768]) assert.throws(() => prepareBedrockEmbedding(cohere.model, { ...cohere.body, output_dimension }), /dimensions/);
  assert.throws(() => prepareBedrockEmbedding(cohere.model, { ...cohere.body, truncate: "END" }), /truncate/);
  assert.throws(() => prepareBedrockEmbedding(cohere.model, { ...cohere.body, embedding_types: ["int8"] }), /type/);
  const req = prepareBedrockEmbedding(cohere.model, cohere.body);
  assert.deepEqual(observeBedrockEmbedding({ embeddings: cohere.response.embeddings.float }, req, true).vectors, cohere.response.embeddings.float);
});

test("Bedrock embedding input bounds reject excess batch, binary/media and malformed native shapes", () => {
  assert.throws(() => prepareBedrockEmbedding(cohere.model, { ...cohere.body, texts: Array(97).fill("synthetic") }));
  assert.throws(() => prepareBedrockEmbedding(cohere.model, { ...cohere.body, texts: [] }));
  assert.throws(() => prepareBedrockEmbedding(titan.model, { ...titan.body, inputText: "x".repeat(2 * 1024 * 1024) }));
  assert.throws(() => prepareBedrockEmbedding(titan.model, { ...titan.body, embeddingTypes: ["binary"] }));
  const nova = example("amazon.nova-2-multimodal-embeddings-v1:0");
  assert.throws(() => prepareBedrockEmbedding(nova.model, { ...nova.body, singleEmbeddingParams: { ...nova.body.singleEmbeddingParams, image: {} } }));
});

test("Bedrock vector validation is atomic across the complete batch and finite dimensions", () => {
  const item = example("cohere.embed-english-v3"), request = prepareBedrockEmbedding(item.model, item.body);
  for (const response of [
    { embeddings: item.response.embeddings.slice(0, 1) },
    { embeddings: [item.response.embeddings[0], []] },
    { embeddings: [item.response.embeddings[0], Array(1024).fill(NaN)] },
    { embeddings: [item.response.embeddings[0], Array(1024).fill("0")] },
  ]) assert.throws(() => observeBedrockEmbedding(response, request, true));
  assert.throws(() => observeBedrockEmbedding(item.response, request, false));
  assert.throws(() => observeBedrockEmbedding({ ...item.response, __type: "SyntheticFailure" }, request, true));
});

test("Bedrock only reports qualified native Titan token counters; dimensions and other usage fields are not tokens", () => {
  const request = prepareBedrockEmbedding(titan.model, titan.body);
  for (const inputTextTokenCount of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) assert.equal(observeBedrockEmbedding({ ...titan.response, inputTextTokenCount }, request, true).inputTokens, null);
  assert.equal(observeBedrockEmbedding({ ...cohere.response, inputTextTokenCount: 999, usage: { total_tokens: 999 } }, prepareBedrockEmbedding(cohere.model, cohere.body), true).inputTokens, null);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
  assert.equal(wire.billing.vectorDimensionsAreTokens, false);
});
