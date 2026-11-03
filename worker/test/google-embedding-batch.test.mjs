import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareGoogleEmbeddingBatchUpload as upload, readGoogleEmbeddingUpload, prepareGoogleEmbeddingBatchCreate as create,
  googleEmbeddingBatchControl as control, googleEmbeddingBatchDownload as download, readGoogleEmbeddingBatch as observe,
  readGoogleEmbeddingBatchResults as results } from "../google-embedding-batch.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/embedding-batch.json", import.meta.url), "utf8"));
const plan = () => upload(wire.model, wire.requests, "synthetic fixture");
const response = (value, status = 200) => Response.json(value, { status });
const signal = () => new AbortController().signal;
const values = Array(128).fill(0.25);
const lines = () => [{ key: "row-b", response: { embedding: { values }, usageMetadata: { promptTokenCount: 2 } } },
  { key: "row-a", embedding: { values } }];
const jsonl = rows => new Response(rows.map(row => JSON.stringify(row)).join("\n"), { headers: { "content-type": "application/jsonl" } });
const collect = async (body, expected = plan().rows) => { const rows = []; for await (const row of results(body, expected, signal())) rows.push(row); return rows; };

test("Google file batch builds bounded multipart JSONL and non-content durable row descriptors", async () => {
  const request = plan(), boundary = request.headers.get("content-type").split("boundary=")[1], body = await request.body.text();
  assert.equal(request.path, "/upload/v1beta/files"); assert.equal(request.query.toString(), "uploadType=multipart");
  assert.ok(body.startsWith("--" + boundary + "\r\n"));
  assert.ok(body.endsWith("\r\n--" + boundary + "--\r\n"));
  assert.ok(body.includes(JSON.stringify({ key: "row-a", request: wire.requests[0].request }) + "\n"));
  assert.deepEqual(request.rows, [{ key: "row-a", dimensions: 128 }, { key: "row-b", dimensions: 128 }]);
  assert.equal(request.headers.get("x-goog-api-key"), null);
  assert.throws(() => upload(wire.model, [...wire.requests, wire.requests[0]], "fixture"), /duplicate/);
  assert.throws(() => upload(wire.model, Array(50_001).fill(wire.requests[0]), "fixture"));
  assert.throws(() => upload(wire.model, [{ ...wire.requests[0], custom_id: "invalid\nkey" }], "fixture"));
});

test("Google file identity and model must match the original bound upload, never a response URL", async () => {
  const file = await readGoogleEmbeddingUpload(response(wire.upload));
  assert.equal(file.name, wire.inputFile); assert.equal(file.state, "ACTIVE"); assert.ok(file.expirationTime);
  const request = create(wire.model, wire.create, { name: file.name, model: wire.model });
  assert.equal(request.path, "/v1beta/models/" + wire.model + ":asyncBatchEmbedContent");
  assert.equal(request.body, wire.create);
  assert.throws(() => create(wire.model, wire.create, { name: "files/other-tenant", model: wire.model }), /binding/);
  assert.throws(() => create(wire.model, wire.create, { name: file.name, model: "gemini-embedding-2" }));
  for (const bad of ["https://untrusted.example/file", "files/../secret", "files/a?key=synthetic", "files/a/b"]) assert.throws(() => download(bad));
  assert.deepEqual(download(wire.outputFile), { path: "/download/v1beta/" + wire.outputFile + ":download", query: new URLSearchParams({ alt: "media" }) });
  await assert.rejects(() => readGoogleEmbeddingUpload(response({ file: { name: file.name, state: "FAILED" } })));
});

test("Google known terminal batch states need no metrics; expired observations do not poll or refund", async () => {
  for (const fixture of wire.observations) {
    const observed = await observe(response(fixture.body), "retrieve", wire.batchName);
    assert.equal(observed.terminal, fixture.terminal); assert.equal(observed.observationUnavailable, fixture.observationUnavailable);
    if (fixture.terminal || fixture.observationUnavailable) assert.equal(observed.followUp, undefined);
    if (fixture.terminal === null) assert.equal(observed.outputFile, null, "partial output is not an authorized download");
  }
  assert.equal((await observe(response({ name: wire.batchName, done: true }), "retrieve", wire.batchName)).terminal, "succeeded", "missing deliverable is separate from terminal execution");
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
});

test("Google cancellation is a best-effort acknowledgement followed by the original bound GET", async () => {
  assert.deepEqual(control("cancel", wire.batchName), { method: "POST", path: "/v1beta/" + wire.batchName + ":cancel" });
  assert.deepEqual(control("retrieve", wire.batchName), { method: "GET", path: "/v1beta/" + wire.batchName });
  const ack = await observe(response({}), "cancel", wire.batchName);
  assert.equal(ack.terminal, null); assert.equal(ack.followUp, "retrieve");
  assert.throws(() => control("delete", wire.batchName));
  await assert.rejects(() => observe(response({}, 503), "cancel", wire.batchName));
  await assert.rejects(() => observe(response({ error: { code: 12 } }), "cancel", wire.batchName));
});

test("Google status reads reject changed identities, conflicting output files and malformed states", async () => {
  for (const body of [
    { name: "batches/other", done: true },
    { name: wire.batchName, done: "true" },
    { name: wire.batchName, metadata: { state: "JOB_STATE_FUTURE" } },
    { name: wire.batchName, done: true, response: { responsesFile: wire.outputFile }, metadata: { output: { responsesFile: "files/other" } } },
    { name: wire.batchName, done: true, response: { responsesFile: "https://untrusted.example/file" } },
    { name: wire.batchName, error: { message: "no status code" } },
  ]) await assert.rejects(() => observe(response(body), "retrieve", wire.batchName));
});

test("Google JSONL results accept arbitrary row order and complete UTF-8 EOF without inventing usage", async () => {
  const bytes = new TextEncoder().encode(lines().map(row => JSON.stringify({ ...row, synthetic: "é" })).join("\r\n"));
  let offset = 0;
  const body = new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } } }), { headers: { "content-type": "application/jsonl" } });
  const rows = await collect(body);
  assert.deepEqual(rows.map(row => row.key), ["row-b", "row-a"]);
  assert.deepEqual(rows.map(row => row.inputTokens), [2, null]);
  assert.deepEqual(rows[0].values, values);
});

test("Google result staging fails on duplicate, missing, late-error, unknown, conflicting or malformed rows", async () => {
  for (const rows of [
    [lines()[0]], [...lines(), lines()[0]], [lines()[0], { key: "row-a", error: { message: "synthetic failure" } }],
    [lines()[0], { ...lines()[1], key: "unknown" }],
    [lines()[0], { ...lines()[1], request_id: "row-b" }],
    [lines()[0], { ...lines()[1], embedding: { values: values.slice(1) } }],
    [lines()[0], { ...lines()[1], response: { embedding: { values } } }],
  ]) await assert.rejects(() => collect(jsonl(rows)), /invalid_google_embedding_batch_results/);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(lines()[0]) + "\n")); controller.error(new Error("synthetic disconnect")); } });
  await assert.rejects(() => collect(new Response(stream, { headers: { "content-type": "application/jsonl" } })));
  await assert.rejects(() => collect(new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/jsonl" } })));
  await assert.rejects(() => collect(new Response(" ".repeat(512 * 1024 + 1), { headers: { "content-type": "application/jsonl" } })));
});

test("Google result consumer cancellation releases the stream and cannot commit partial staged rows", async () => {
  let canceled = false;
  const controller = new AbortController(), stream = new ReadableStream({ cancel() { canceled = true; } });
  const reader = results(new Response(stream, { headers: { "content-type": "application/jsonl" } }), plan().rows, controller.signal);
  const pending = reader.next(); controller.abort();
  await assert.rejects(pending); assert.equal(canceled, true);
  const late = new AbortController(), buffered = results(jsonl(lines()), plan().rows, late.signal);
  assert.equal((await buffered.next()).value.key, "row-b");
  late.abort();
  await assert.rejects(() => buffered.next(), /invalid_google_embedding_batch_results/);
});
