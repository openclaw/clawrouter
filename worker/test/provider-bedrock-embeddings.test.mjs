import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareBedrockEmbedding, observeBedrockEmbedding, bedrockEmbeddingModels, isBedrockEmbeddingModel } from "../provider-bedrock-embeddings.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/amazon-bedrock/embeddings.json", import.meta.url), "utf8"));
const example = model => wire.cases.find(item => item.model === model);
const titan = example("amazon.titan-embed-text-v2:0"), cohere = example("cohere.embed-v4:0");

test("Bedrock model recognition retains the codec's finite families, profile grammar and rejection semantics", () => {
  assert.equal(bedrockEmbeddingModels.length, 10);
  for (const model of bedrockEmbeddingModels) assert.equal(isBedrockEmbeddingModel(model), true, model);
  for (const item of wire.cases) {
    assert.equal(isBedrockEmbeddingModel(item.model), true, item.model);
    assert.equal(prepareBedrockEmbedding(item.model, item.body).modelId, item.model);
  }
  for (const prefix of ["us", "eu", "ap", "apac", "au", "jp", "global"]) {
    const model = prefix + ".amazon.titan-embed-text-v2:0:2:8k";
    assert.equal(isBedrockEmbeddingModel(model), true, model);
    assert.equal(prepareBedrockEmbedding(model, titan.body).modelId, model);
  }
  for (const model of ["", "constructor", "amazon.titan-embed-text-v9", "cohere.embed-v4:0:foreign",
    "us.us.amazon.titan-embed-text-v2:0", "amazon.titan-embed-text-v2:0:8K", "amazon.titan-embed-text-v2:0:1e3",
    "bedrock/amazon.titan-embed-text-v1", "../amazon.titan-embed-text-v1", "https://api.example/model",
    "arn:aws:bedrock:us-east-1:000000000000:inference-profile/synthetic", "x".repeat(201), null, undefined, 7, {}, []]) {
    assert.equal(isBedrockEmbeddingModel(model), false, String(model));
    assert.throws(() => prepareBedrockEmbedding(model, titan.body), /unsupported_bedrock_embedding_model/);
  }
});

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

for (const model of ["cohere.embed-english-v3", "cohere.embed-multilingual-v3"]) {
  for (const explicit of [false, true]) for (const keyed of [false, true]) {
    test(`Bedrock ${model} float envelope admission: explicit=${explicit}, keyed=${keyed}`, () => {
      const item = example(model), body = { ...item.body, ...(explicit ? { embedding_types: ["float"] } : {}) };
      const request = prepareBedrockEmbedding(model, body), vectors = item.response.embeddings;
      const response = { embeddings: keyed ? { float: vectors } : vectors, response_type: "synthetic-ignored-label",
        message: "synthetic informational field", inputTextTokenCount: 999, usage: { total_tokens: 999 } };
      assert.equal(request.body, body);
      if (keyed && !explicit) assert.throws(() => observeBedrockEmbedding(response, request, true), /invalid_bedrock_embedding_response/);
      else {
        const observed = observeBedrockEmbedding(response, request, true);
        assert.equal(observed.vectors, vectors); assert.equal(observed.inputTokens, null);
      }
    });
  }

  test(`Bedrock ${model} rejects unrequested and malformed embedding types`, () => {
    const item = example(model);
    for (const embedding_types of [null, "float", {}, [], ["int8"], ["float", "int8"], ["float", "float"], [1]])
      assert.throws(() => prepareBedrockEmbedding(model, { ...item.body, embedding_types }), /unsupported_bedrock_embedding_type/);
    const request = prepareBedrockEmbedding(model, { ...item.body, embedding_types: ["float"] }), vectors = item.response.embeddings;
    for (const embeddings of [{}, { float: null }, { float: {} }, { float: "invalid" }, { int8: vectors },
      { float: vectors, int8: vectors }, { float: vectors, unexpected: null }, Object.create({ float: vectors })])
      assert.throws(() => observeBedrockEmbedding({ embeddings }, request, true), /invalid_bedrock_embedding_response/);
  });

  test(`Bedrock ${model} validates the complete float batch before returning any vectors`, () => {
    const item = example(model), request = prepareBedrockEmbedding(model, { ...item.body,
      texts: [item.body.texts[0], "Synthetic later document"], embedding_types: ["float"] });
    const vectors = [item.response.embeddings[0], item.response.embeddings[0]];
    for (const bad of [vectors.slice(0, 1), [...vectors, vectors[0]], [vectors[0], []], [vectors[0], Array(1023).fill(1)],
      [vectors[0], Array(1024).fill(NaN)], [vectors[0], Array(1024).fill(Infinity)], [vectors[0], Array(1024).fill("1")]]) {
      for (const embeddings of [bad, { float: bad }]) assert.throws(() => observeBedrockEmbedding({ embeddings }, request, true));
    }
    for (const embeddings of [vectors, { float: vectors }]) {
      assert.throws(() => observeBedrockEmbedding({ embeddings }, request, false), /invalid_bedrock_embedding_response/);
      for (const error of [{ error: "SyntheticFailure" }, { __type: "SyntheticFailure" }])
        assert.throws(() => observeBedrockEmbedding({ embeddings, ...error }, request, true), /invalid_bedrock_embedding_response/);
    }
  });

  test(`Bedrock ${model} response admission survives mutation of the retained request body`, () => {
    const item = example(model), body = { ...item.body, embedding_types: ["float"] };
    const explicit = prepareBedrockEmbedding(model, body), response = { embeddings: { float: item.response.embeddings } };
    body.embedding_types[0] = "int8"; delete body.embedding_types;
    assert.equal(explicit.body, body); assert.deepEqual(observeBedrockEmbedding(response, explicit, true).vectors, item.response.embeddings);
    const omittedBody = { ...item.body }, omitted = prepareBedrockEmbedding(model, omittedBody);
    omittedBody.embedding_types = ["float"];
    assert.equal(omitted.body, omittedBody);
    assert.throws(() => observeBedrockEmbedding(response, omitted, true), /invalid_bedrock_embedding_response/);
    assert.deepEqual(observeBedrockEmbedding(item.response, omitted, true).vectors, item.response.embeddings);
  });
}

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

test("Titan Multimodal accepts absent/null messages without changing vectors, tokens or completeness", () => {
  const item = example("amazon.titan-embed-image-v1");
  for (const model of [item.model, "us." + item.model + ":0:2:8k", "global." + item.model]) {
    const request = prepareBedrockEmbedding(model, item.body);
    for (const message of [{}, { message: null }]) for (const inputTextTokenCount of [0, 17]) {
      const response = { ...item.response, inputTextTokenCount, ...message };
      const observed = observeBedrockEmbedding(response, request, true);
      assert.deepEqual(observed.vectors, [item.response.embedding]); assert.equal(observed.inputTokens, inputTextTokenCount);
      assert.throws(() => observeBedrockEmbedding(response, request, false), { message: "invalid_bedrock_embedding_response" });
    }
  }
});

test("Titan Multimodal rejects every nonnull message even with valid vectors and token evidence", () => {
  const item = example("amazon.titan-embed-image-v1");
  for (const model of [item.model, "us." + item.model + ":0:2:8k", "global." + item.model]) {
    const request = prepareBedrockEmbedding(model, item.body);
    for (const message of ["synthetic upstream diagnostic", "", 0, false, {}, [], ["synthetic"]]) {
      const response = { ...item.response, inputTextTokenCount: 17, message };
      assert.throws(() => observeBedrockEmbedding(response, request, true), error => {
        assert.equal(error.message, "invalid_bedrock_embedding_response");
        assert.equal(error.cause, undefined); return true;
      });
    }
  }
});

test("Titan Multimodal message semantics do not change other embedding families", () => {
  for (const item of wire.cases.filter(item => item.model !== "amazon.titan-embed-image-v1")) {
    const request = prepareBedrockEmbedding(item.model, item.body);
    const baseline = observeBedrockEmbedding(item.response, request, true);
    assert.deepEqual(observeBedrockEmbedding({ ...item.response, message: "synthetic informational field" }, request, true), baseline);
  }
});

test("Bedrock only reports qualified native Titan token counters; dimensions and other usage fields are not tokens", () => {
  const request = prepareBedrockEmbedding(titan.model, titan.body);
  for (const inputTextTokenCount of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) assert.equal(observeBedrockEmbedding({ ...titan.response, inputTextTokenCount }, request, true).inputTokens, null);
  assert.equal(observeBedrockEmbedding({ ...cohere.response, inputTextTokenCount: 999, usage: { total_tokens: 999 } }, prepareBedrockEmbedding(cohere.model, cohere.body), true).inputTokens, null);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
  assert.equal(wire.billing.vectorDimensionsAreTokens, false);
});
