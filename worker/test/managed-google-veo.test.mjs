import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { googleVeoManagedAdapter as adapter, googleVeoModels, googleVeoTiming, googleVeoOperationMaxBytes, prepareGoogleVeoCreate, readGoogleVeo, validateGoogleVeoOperation } from "../managed-google-veo.ts";
import { canonicalGoogleVeoBytes, googleVeoApiBase, googleVeoAssets, prepareGoogleVeoFileDownload, readGoogleVeoFile } from "../provider-google-veo-files.ts";
const fixture = JSON.parse(await readFile(new URL("../../providers/_fixtures/google-veo/video.json", import.meta.url), "utf8"));
const model = googleVeoModels[0], apiBase = "https://generativelanguage.googleapis.com/v1beta";
const ctx = (action = "create", overrides = {}) => ({ action, requestedVersion: model, pathParams: { model }, ...(action === "retrieve" ? { expectedId: fixture.pending.name } : {}), ...overrides });
const read = (body, action = "create", overrides = {}) => readGoogleVeo(Response.json(body), ctx(action, overrides));
const inline = video => ({ ...fixture.sdkComplete, response: { generatedVideos: [{ video }] } });
const file = resource => ({ kind: "file", resource, mimeType: "video/mp4" });

for (const request of fixture.requests) test(`frozen ${request.model} preserves native wire fields and removes caller credentials`, () => {
  const before = structuredClone(request.body);
  const prepared = adapter.prepare(request.body, new Headers({ authorization: "Bearer synthetic-caller", "x-goog-api-key": "synthetic-caller" }), { model: request.model }, new URLSearchParams());
  assert.deepEqual(prepared.body, before); assert.deepEqual(request.body, before);
  assert.equal(prepared.requestedVersion, request.model); assert.deepEqual(prepared.pathParams, { model: request.model });
  assert.deepEqual(Object.fromEntries(prepared.headers), { "content-type": "application/json" });
});

test("frozen three-model scope and native parameters reject expansion or mixed SDK/REST bodies", () => {
  assert.deepEqual(googleVeoModels, ["veo-3.1-fast-generate-preview", "veo-3.1-generate-preview", "veo-3.1-lite-generate-preview"]);
  for (const id of ["veo-3.0-generate-001", "veo-3.1-generate-001", `google/${model}`, `models/${model}`, "other"]) assert.throws(() => prepareGoogleVeoCreate(fixture.requests[0].body, id), /invalid_google_veo_model/);
  for (const params of [{ durationSeconds: 5 }, { durationSeconds: "4" }, { resolution: "4k" }, { resolution: "720P" }, { aspectRatio: "1:1" }, { numberOfVideos: 2 }, { generateAudio: true }, { seed: 7 }, { lastFrame: {} }]) assert.throws(() => prepareGoogleVeoCreate({ instances: [{ prompt: "synthetic" }], parameters: params }, model), /invalid_google_veo/);
  for (const body of [{ ...fixture.requests[0].body, model }, { prompt: "synthetic", config: {} }, { instances: [] }, { instances: [{ prompt: "a" }, { prompt: "b" }] }, { instances: [{ prompt: " " }] }]) assert.throws(() => prepareGoogleVeoCreate(body, model), /invalid_google_veo/);
});

test("one inline reference uses native image or video names, never URLs or both", () => {
  for (const instance of [{ prompt: "a", image: { imageBytes: "AP+A", mimeType: "image/png" } }, { prompt: "a", video: { videoBytes: "AP+A", mimeType: "video/mp4" } }, { prompt: "a", image: { uri: "https://other.example/input.png" } }, { prompt: "a", video: { uri: "files/caller" } }, { prompt: "a", image: fixture.requests[1].body.instances[0].image, video: fixture.requests[2].body.instances[0].video }, { prompt: "a", video: { encodedVideo: "AP+A", encoding: "text/html" } }]) assert.throws(() => prepareGoogleVeoCreate({ instances: [instance] }, model), /invalid_google_veo/);
  assert.throws(() => adapter.prepare(fixture.requests[0].body, new Headers(), { model }, new URLSearchParams("key=synthetic")), /unsupported_managed_media_query/);
  assert.throws(() => adapter.prepare(fixture.requests[0].body, new Headers(), { model, operation_name: "operations/other" }, new URLSearchParams()), /invalid_managed_media_params/);
});

test("native operation paths retain slash-separated names but reject traversal and other models", () => {
  for (const id of [fixture.pending.name, "operations/root-fixture"]) {
    assert.equal(adapter.identify("retrieve", { operation_name: id }, new URLSearchParams()), id);
    assert.deepEqual(adapter.control("retrieve", { method: "GET", path: "/${operation_name}" }, id, { model }), { path: `/${id}`, query: new URLSearchParams() });
  }
  for (const id of ["operations/a/b", "operations/..", "operations/a%2fb", "operations/a?key=synthetic", "operations/a#x", "https://other.example/operations/a", "projects/p/operations/a", "models/other/operations/a", "operations/", `operations/${"x".repeat(129)}`]) assert.throws(() => validateGoogleVeoOperation(id), /invalid_google_veo_operation/);
  assert.throws(() => adapter.control("retrieve", { method: "GET", path: "/${operation_name}" }, `models/${googleVeoModels[1]}/operations/a`, { model }), /operation/);
  for (const action of ["cancel", "result"]) assert.throws(() => adapter.control(action, { method: "GET", path: "/${operation_name}" }, fixture.pending.name, { model }), /control_endpoint/);
  assert.throws(() => adapter.control("retrieve", { method: "POST", path: "/${operation_name}" }, fixture.pending.name, { model }), /control_endpoint/);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
});

test("create ACK, pending poll and terminal result remain separate from cost and delivery", async () => {
  for (const body of [fixture.pending, { name: fixture.pending.name }]) {
    const result = await read(body); assert.equal(result.terminal, null); assert.equal(result.followUp, "retrieve");
  }
  assert.equal((await read(fixture.pending, "retrieve")).followUp, undefined);
  const done = await read(fixture.restComplete, "retrieve"); assert.equal(done.terminal, "succeeded");
  assert.equal(done.tokens, undefined); assert.equal(done.actualCostMicros, undefined);
  assert.deepEqual(googleVeoAssets(done.body, 1024), [file(`${apiBase}/files/fixture-video:download?alt=media`)]);
  assert.equal((await read(fixture.sdkComplete, "retrieve", { expectedId: fixture.sdkComplete.name })).terminal, "succeeded");
  assert.equal((await read(fixture.failed, "retrieve")).terminal, "failed");
});

test("identity drift, API errors and malformed completion never yield terminal evidence", async () => {
  for (const body of [{ ...fixture.pending, name: "operations/other" }, { ...fixture.pending, name: `models/${googleVeoModels[1]}/operations/fixture-op` }, { ...fixture.pending, done: "true" }, { ...fixture.pending, error: { code: 3 } }, { ...fixture.pending, response: {} }, { ...fixture.restComplete, response: {} }, { ...fixture.restComplete, response: { generateVideoResponse: { generatedSamples: [], raiMediaFilteredCount: 1 } } }, { ...fixture.failed, error: {} }, { ...fixture.failed, error: { code: 0 } }, { ...fixture.failed, error: { code: "3" } }, { ...fixture.failed, response: {} }]) await assert.rejects(read(body, "retrieve"), /invalid_google_veo/);
  await assert.rejects(read({ done: true, response: fixture.restComplete.response }), /operation/);
  await assert.rejects(readGoogleVeo(Response.json({ error: { code: 404 } }, { status: 404 }), ctx("retrieve")), /invalid_google_veo_response/);
});

test("SDK and REST inline media honor ProtoJSON alphabets, pad bits and caller byte cap", () => {
  for (const [encoded, normalized, length] of [["YQ==", "YQ==", 1], [" -_8\n", "+/8=", 2], ["AP+A", "AP+A", 3]]) {
    assert.deepEqual(canonicalGoogleVeoBytes(encoded, length), { base64: normalized, decodedBytes: length });
    for (const video of [{ videoBytes: encoded, mimeType: "video/mp4" }, { encodedVideo: encoded, encoding: "video/mp4" }]) assert.deepEqual(googleVeoAssets(inline(video), length), [{ kind: "inline", base64: normalized, decodedBytes: length, mimeType: "video/mp4" }]);
    assert.throws(() => canonicalGoogleVeoBytes(encoded, length - 1), /invalid_google_veo/);
  }
  for (const bad of ["ZE==", "aGVsbG8+_", "A", "YQ=", "YQ===", "", "YQ==trailer", "YQ\u0000=="]) assert.throws(() => canonicalGoogleVeoBytes(bad, 100), /invalid_google_veo/);
  assert.throws(() => googleVeoAssets(inline({ encodedVideo: "YQ==", videoBytes: "YQ==" }), 100), /ambiguous_bytes/);
  assert.throws(() => googleVeoAssets(inline({ videoBytes: "YQ==", mimeType: "text/html" }), 100), /mime_type/);
});

test("file descriptors accept frozen handles and direct download URIs without exposing auth", () => {
  for (const resource of ["files/fixture-video", `${apiBase}/files/fixture-video:download`, `${apiBase}/files/fixture-video:download?alt=media`]) {
    const download = prepareGoogleVeoFileDownload(file(resource), apiBase);
    assert.deepEqual(download, { url: `${apiBase}/files/fixture-video:download?alt=media`, method: "GET", redirect: "error", credential: "original_job" });
    assert.equal(new URL(download.url).searchParams.has("key"), false);
  }
  assert.equal(googleVeoAssets(inline({ name: "files/fixture-video" }), 1024)[0].resource, "files/fixture-video");
  assert.equal(prepareGoogleVeoFileDownload(file("files/fixture-video"), "https://proxy.example/tenant/v1alpha").url, "https://proxy.example/tenant/v1alpha/files/fixture-video:download?alt=media");
  assert.equal(googleVeoApiBase("https://proxy.example/tenant"), "https://proxy.example/tenant/v1beta");
  assert.equal(googleVeoApiBase("https://generativelanguage.googleapis.com"), apiBase);
});

test("file egress is exact selected-origin and API-prefix bound with no response credential override", () => {
  for (const resource of ["https://other.example/v1beta/files/video:download", "https://generativelanguage.googleapis.com.other.example/v1beta/files/video:download", `${apiBase}/files/video:download?key=synthetic`, `${apiBase}/files/video:download?alt=media&alt=media`, `${apiBase}/files/video:download#fragment`, "https://user:synthetic@generativelanguage.googleapis.com/v1beta/files/video:download", `${apiBase}/files/%2e%2e:download`, "files/../other", "files/a/b", "http://generativelanguage.googleapis.com/v1beta/files/video:download", "https://generativelanguage.googleapis.com/other/files/video:download", `${apiBase}/files/../files/video:download`]) assert.throws(() => prepareGoogleVeoFileDownload(file(resource), apiBase), /invalid_google_veo/);
  assert.throws(() => prepareGoogleVeoFileDownload(file(`${apiBase}/files/video:download`), "https://proxy.example/v1beta"), /file_origin/);
  assert.throws(() => prepareGoogleVeoFileDownload(file("https://proxy.example/v1beta/files/video:download"), apiBase), /file_origin/);
  for (const base of ["http://proxy.example", "https://proxy.example?key=synthetic", "https://user:synthetic@proxy.example", "https://proxy.example/v1beta/../other", "https://proxy.example/%2e%2e"]) assert.throws(() => googleVeoApiBase(base), /invalid_google_veo_api_base/);
});

test("file bytes reject redirects, truncated/oversize streams, empty bodies and disguised JSON", async () => {
  assert.deepEqual(await readGoogleVeoFile(new Response(new Uint8Array([0, 255, 128]), { headers: { "content-type": "video/mp4", "content-length": "3" } }), 3), new Uint8Array([0, 255, 128]));
  for (const response of [new Response("{}", { headers: { "content-type": "application/json" } }), new Response("html", { headers: { "content-type": "text/html" } }), new Response("image", { headers: { "content-type": "image/png" } }), new Response("video", { status: 302 }), new Response("video", { status: 206 }), new Response(""), new Response("video", { headers: { "content-length": "6" } }), new Response("video", { headers: { "content-length": "bad" } })]) await assert.rejects(readGoogleVeoFile(response, 8), /invalid_google_veo/);
  const redirected = new Response("video"); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(readGoogleVeoFile(redirected, 8), /invalid_google_veo/);
  let canceled = false, pulls = 0;
  const response = new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(9)); }, cancel() { canceled = true; } }, { highWaterMark: 0 }));
  await assert.rejects(readGoogleVeoFile(response, 8), /invalid_google_veo/); assert.equal(canceled, true); assert.equal(pulls, 1);
});

test("operation JSON enforces the frozen 16MiB envelope and fatal UTF-8 with safe errors", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...fixture.pending, metadata: { note: "synthetic 🦊" } })); let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, ++offset)); } }), { headers: { "content-type": "application/json" } });
  assert.equal((await readGoogleVeo(response, ctx())).body.metadata.note, "synthetic 🦊");
  for (const response of [new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), new Response('{"secret":"synthetic"', { headers: { "content-type": "application/json" } }), new Response("{}", { headers: { "content-type": "text/html" } })]) await assert.rejects(readGoogleVeo(response, ctx()), error => { assert.equal(error.message, "invalid_google_veo_response"); return true; });
  let canceled = false;
  const huge = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(googleVeoOperationMaxBytes + 1)); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  await assert.rejects(readGoogleVeo(huge, ctx()), /invalid_google_veo_response/); assert.equal(canceled, true);
  assert.deepEqual(googleVeoTiming, { requestTimeoutMs: 180_000, pollIntervalMs: 10_000, maxPollAttempts: 120 });
});

test("native outputs remain transient and untrusted controls are removed", async () => {
  const observed = await read({ ...fixture.restComplete, urls: { get: "https://other.example" }, status_url: "https://other.example/status" });
  const rewritten = adapter.rewrite(observed, { retrieve: "/v1/jobs/fixture" });
  assert.equal(rewritten.urls, undefined); assert.equal(rewritten.status_url, undefined); assert.deepEqual(rewritten.response, fixture.restComplete.response);
});
