import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleEmbeddingModels, prepareGoogleEmbedding, observeGoogleEmbedding, readGoogleEmbedding } from "../provider-google-embeddings.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/embeddings.json", import.meta.url), "utf8"));
const signal = () => new AbortController().signal;
const unary = () => prepareGoogleEmbedding(wire.unary.model, structuredClone(wire.unary.request), "unary");
const batch = () => prepareGoogleEmbedding(wire.batch.model, structuredClone(wire.batch.request), "batch");

test("Google frozen unary and batch paths preserve model/task/body identity without credentials", () => {
  assert.equal(googleEmbeddingModels.length, 3);
  for (const mode of ["unary", "batch"]) {
    const row = wire[mode], request = prepareGoogleEmbedding(row.model, row.request, mode);
    assert.equal(request.body, row.request);
    assert.equal(request.path, "/v1beta/models/" + row.model + (mode === "unary" ? ":embedContent" : ":batchEmbedContents"));
    assert.equal(request.headers.get("x-goog-api-key"), null);
    assert.equal(request.headers.get("authorization"), null);
    assert.deepEqual(observeGoogleEmbedding(row.response, request, true).vectors,
      mode === "unary" ? [row.response.embedding.values] : row.response.embeddings.map(value => value.values));
  }
  assert.throws(() => prepareGoogleEmbedding("gemini-embedding-3", wire.unary.request, "unary"));
  assert.throws(() => prepareGoogleEmbedding(wire.unary.model, wire.unary.request, "async"));
  const invalid = structuredClone(wire.batch.request);
  delete invalid.requests[1].model;
  assert.throws(() => prepareGoogleEmbedding(wire.batch.model, invalid, "batch"), /model_mismatch/);
  invalid.requests[1].model = "models/gemini-embedding-2";
  assert.throws(() => prepareGoogleEmbedding(wire.batch.model, invalid, "batch"), /model_mismatch/);
});

test("Stable Embedding 2 forbids taskType and preserves preformatted and multimodal aggregation", () => {
  const request = unary(), text = request.body.content.parts[0].text;
  assert.equal(text, wire.unary.request.content.parts[0].text);
  assert.throws(() => prepareGoogleEmbedding(request.model, { ...request.body, taskType: "RETRIEVAL_QUERY" }, "unary"), /task/);
  for (const model of ["gemini-embedding-001", "gemini-embedding-2-preview"]) {
    assert.equal(prepareGoogleEmbedding(model, { ...request.body, taskType: "RETRIEVAL_QUERY" }, "unary").body.taskType, "RETRIEVAL_QUERY");
  }
  const body = { ...request.body, content: { parts: [{ text: "synthetic image" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] } };
  const multi = prepareGoogleEmbedding(request.model, body, "unary");
  assert.equal(multi.dimensions.length, 1, "multiple parts are one aggregated vector");
  assert.equal(observeGoogleEmbedding(wire.unary.response, multi, true).vectors.length, 1);
  assert.throws(() => prepareGoogleEmbedding("gemini-embedding-001", body, "unary"), /part/);
  body.content.parts[1] = { fileData: { fileUri: "https://unbound.example/file" } };
  assert.throws(() => prepareGoogleEmbedding(request.model, body, "unary"), /part/);
});

test("Google admission bounds batch, dimensions, MIME/base64 and the frozen field surface", () => {
  const row = wire.batch.request.requests[0];
  assert.equal(prepareGoogleEmbedding(wire.batch.model, { requests: Array(100).fill(row) }, "batch").dimensions.length, 100);
  for (const count of [0, 101]) assert.throws(() => prepareGoogleEmbedding(wire.batch.model, { requests: Array(count).fill(row) }, "batch"));
  for (const outputDimensionality of [null, 0, 127, 3073, 128.5]) assert.throws(() => prepareGoogleEmbedding(wire.unary.model, { ...wire.unary.request, outputDimensionality }, "unary"));
  assert.throws(() => prepareGoogleEmbedding("gemini-embedding-001", { ...wire.unary.request, taskType: ["RETRIEVAL_QUERY"] }, "unary"));
  for (const extra of [{ callback: "https://callback.example" }, { embedContentConfig: {} }]) assert.throws(() => prepareGoogleEmbedding(wire.unary.model, { ...wire.unary.request, ...extra }, "unary"));
  for (const inlineData of [{ mimeType: "image/png", data: "invalid!" }, { mimeType: "text/html", data: "AAAA" }]) {
    assert.throws(() => prepareGoogleEmbedding(wire.unary.model, { content: { parts: [{ inlineData }] } }, "unary"));
  }
  assert.throws(() => prepareGoogleEmbedding(wire.unary.model, { content: { parts: [{ text: "x".repeat(20 * 1024 * 1024) }] } }, "unary"));
});

test("Google embedding observation is atomic across incomplete, mismatched and invalid vector results", () => {
  const request = batch(), response = wire.batch.response;
  assert.throws(() => observeGoogleEmbedding(response, request, false));
  assert.throws(() => observeGoogleEmbedding({ ...response, error: { code: 429 } }, request, true));
  assert.throws(() => observeGoogleEmbedding({ embeddings: response.embeddings.slice(0, 1) }, request, true), /count/);
  for (const values of [[], Array(127).fill(1), Array(128).fill(null), [...Array(127).fill(1), Infinity]]) {
    assert.throws(() => observeGoogleEmbedding({ embeddings: [response.embeddings[0], { values }] }, request, true), /vector/);
  }
  const mixed = structuredClone(wire.batch.request);
  mixed.requests[1].outputDimensionality = 256;
  assert.throws(() => observeGoogleEmbedding(response, prepareGoogleEmbedding(wire.batch.model, mixed, "batch"), true), /vector/);
});

test("Google usage uses explicit native tokens only and keeps invalid modality totals unknown", () => {
  const request = unary(), body = wire.unary.response;
  assert.equal(observeGoogleEmbedding(body, request, true).inputTokens, 8);
  assert.deepEqual(observeGoogleEmbedding(body, request, true).inputTokenDetails, { TEXT: 8 });
  assert.equal(observeGoogleEmbedding({ embedding: body.embedding }, request, true).inputTokens, null);
  for (const promptTokenCount of [-1, 0.5, "8", NaN]) {
    assert.equal(observeGoogleEmbedding({ ...body, usageMetadata: { promptTokenCount } }, request, true).inputTokens, null);
  }
  for (const details of [[{ modality: "TEXT", tokenCount: 7 }], [{ modality: "TEXT", tokenCount: 4 }, { modality: "TEXT", tokenCount: 4 }], [{ modality: "UNKNOWN", tokenCount: 8 }]]) {
    const value = observeGoogleEmbedding({ ...body, usageMetadata: { promptTokenCount: 8, promptTokenDetails: details } }, request, true);
    assert.equal(value.inputTokens, 8); assert.equal(value.inputTokenDetails, null);
  }
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
});

test("Google response reader requires bounded complete UTF-8 EOF and cancels invalid or aborted streams", async () => {
  const request = unary(), bytes = new TextEncoder().encode(JSON.stringify({ ...wire.unary.response, synthetic: "é" }));
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } } });
  assert.equal((await readGoogleEmbedding(new Response(stream, { headers: { "content-type": "application/json" } }), request, signal())).inputTokens, 8);
  const failed = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.error(new Error("synthetic EOF failure")); } });
  const invalid = [
    new Response(failed, { headers: { "content-type": "application/json" } }),
    new Response('{"embedding":', { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    Response.json(wire.unary.response, { status: 429 }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": String(16 * 1024 * 1024 + 1) } }),
    new Response(new Uint8Array(16 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  ];
  for (const response of invalid) await assert.rejects(() => readGoogleEmbedding(response, request, signal()), /invalid_google_embedding_response/);
  const controller = new AbortController();
  let canceled = false;
  const pending = readGoogleEmbedding(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }), request, controller.signal);
  controller.abort();
  await assert.rejects(pending, /invalid_google_embedding_response/);
  assert.equal(canceled, true);
});
