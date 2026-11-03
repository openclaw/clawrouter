import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { googleOmniVideoManagedAdapter as adapter, googleOmniVideoModel as model, prepareGoogleOmniVideoCreate, readGoogleOmniVideo, validateGoogleOmniInteractionId, googleOmniUsage } from "../managed-google-omni.ts";
import { googleOmniApiBase, googleOmniEnvelopeBytes, googleOmniFilePollIntervalMs, googleOmniVideos, prepareGoogleOmniFileControl, readGoogleOmniFileState, readGoogleOmniFile } from "../provider-google-omni-files.ts";
const fixture = JSON.parse(await readFile(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url), "utf8"));
const flags = { background: "true", store: "true" }, base = "https://generativelanguage.googleapis.com/v1beta";
const context = (action = "create", patch = {}) => ({ action, requestedVersion: model, pathParams: flags, ...(action === "create" ? {} : { expectedId: "v1_fixture" }), ...patch });
const read = (value, action = "create", patch = {}) => readGoogleOmniVideo(Response.json(value), context(action, patch));
const videoBody = video => ({ ...fixture.completed, steps: [{ type: "model_output", content: [video] }] });
const asset = resource => ({ kind: "file", resource, mimeType: "video/mp4" });
const state = value => readGoogleOmniFileState(Response.json(value), "files/fixture-video");

for (const [index, request] of fixture.requests.entries()) test(`native Omni request ${index + 1} preserves input and selected credential isolation`, () => {
  const before = structuredClone(request);
  const prepared = adapter.prepare(request, new Headers({ authorization: "Bearer synthetic-caller", "x-goog-api-key": "synthetic-caller" }), {}, new URLSearchParams());
  assert.deepEqual(request, before); assert.equal(prepared.requestedVersion, model);
  assert.deepEqual(prepared.body, { ...request, response_format: request.response_format ?? { type: "video" }, background: request.background ?? false, store: request.store ?? false, stream: false });
  assert.deepEqual(Object.fromEntries(prepared.headers), { "content-type": "application/json" });
  assert.deepEqual(prepared.pathParams, { background: String(request.background ?? false), store: String(request.store ?? false) });
});

test("only the named replacement and native video fields are admitted; retired IDs never alias", () => {
  for (const other of ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview", "gemini-omni-flash-preview", `google/${model}`, "gemini-flash-latest"]) assert.throws(() => prepareGoogleOmniVideoCreate({ ...fixture.requests[0], model: other }), /invalid_google_omni_model/);
  for (const patch of [{ instances: [{ prompt: "a" }] }, { prompt: "a" }, { durationSeconds: 4 }, { tools: [] }, { system_instruction: "a" }, { previous_interaction_id: "v1_other_job" }, { agent: "other" }, { generation_config: { temperature: 1 } }, { response_format: { type: "text" } }, { stream: true }, { background: true, store: false }]) assert.throws(() => prepareGoogleOmniVideoCreate({ ...fixture.requests[0], ...patch }), /invalid_google_omni/);
  for (const response_format of [{ type: "video", aspect_ratio: "1:1" }, { type: "video", resolution: "8k" }, { type: "video", duration: 8 }, { type: "video", duration: "8s\n" }, { type: "video", delivery: "url" }]) assert.throws(() => prepareGoogleOmniVideoCreate({ ...fixture.requests[0], response_format }), /invalid_google_omni/);
  for (const resolution of ["360p", "720p", "1080p", "4k"]) assert.equal(prepareGoogleOmniVideoCreate({ ...fixture.requests[0], response_format: { type: "video", resolution, duration: "8s" } }).response_format.duration, "8s");
});

test("single inline references exclude cross-job files, mixed media and unsupported task modes", () => {
  for (const input of [[{ type: "video", uri: "files/other-job" }, { type: "text", text: "edit" }], [{ type: "image", data: "ZE==", mime_type: "image/png" }, { type: "text", text: "edit" }], [{ type: "audio", data: "AP+A", mime_type: "audio/wav" }], [{ type: "user_input", content: [{ type: "text", text: "x" }] }], [{ type: "video", data: "AP+A", mime_type: "video/mp4" }], [...fixture.requests[1].input, fixture.requests[2].input[0]], " "]) assert.throws(() => prepareGoogleOmniVideoCreate({ ...fixture.requests[0], input }), /invalid_google_/);
  for (const task of ["text_to_video", "reference_to_video", "extend", "edit"]) assert.throws(() => prepareGoogleOmniVideoCreate({ ...fixture.requests[1], generation_config: { video_config: { task } } }), /invalid_google_omni_task/);
  assert.equal(prepareGoogleOmniVideoCreate({ ...fixture.requests[2], generation_config: { video_config: { task: "edit" } } }).generation_config.video_config.task, "edit");
});

test("create route metadata and query guards keep raw native control identities out of caller options", () => {
  assert.equal(adapter.protocol, "google.omni_video"); assert.deepEqual(adapter.requestFormats, ["google.omni_video_create"]);
  assert.equal(adapter.supportsResult, false); assert.equal(adapter.supportsCancel, true);
  assert.throws(() => adapter.prepare(fixture.requests[0], new Headers(), { interaction_id: "v1_other" }, new URLSearchParams()), /invalid_managed_media_params/);
  assert.throws(() => adapter.prepare(fixture.requests[0], new Headers(), {}, new URLSearchParams("key=synthetic")), /unsupported_managed_media_query/);
  for (const id of ["../x", "v1_a/b", "v1_a%2fb", "v1_a?key=x", "v1_a#x", "https://other.example", "", "x".repeat(1025)]) assert.throws(() => validateGoogleOmniInteractionId(id), /interaction_id/);
});

test("get/cancel use original store/background flags and exact Interactions paths", () => {
  for (const [action, method, path, expected] of [["retrieve", "GET", "/interactions/${interaction_id}", "/interactions/v1_fixture"], ["cancel", "POST", "/interactions/${interaction_id}/cancel", "/interactions/v1_fixture/cancel"]]) {
    assert.equal(adapter.identify(action, { interaction_id: "v1_fixture" }, new URLSearchParams()), "v1_fixture");
    assert.deepEqual(adapter.control(action, { method, path }, "v1_fixture", flags), { path: expected, query: new URLSearchParams() });
    assert.throws(() => adapter.control(action, { method, path: "/v1/videos/${interaction_id}" }, "v1_fixture", flags), /control_endpoint/);
  }
  assert.throws(() => adapter.control("cancel", { method: "POST", path: "/interactions/${interaction_id}/cancel" }, "v1_fixture", { store: "true", background: "false" }), /control/);
  assert.throws(() => adapter.control("retrieve", { method: "GET", path: "/interactions/${interaction_id}" }, "v1_fixture", { store: "false", background: "false" }), /control/);
  assert.throws(() => adapter.control("result", { method: "GET", path: "/interactions/${interaction_id}" }, "v1_fixture", flags), /control/);
});

test("pending and terminal interactions preserve exact identity and distinguish cancellation races", async () => {
  const pending = await read(fixture.pending); assert.equal(pending.terminal, null); assert.equal(pending.followUp, "retrieve");
  assert.equal((await read(fixture.pending, "retrieve")).followUp, undefined);
  assert.equal((await read(fixture.pending, "cancel")).followUp, "retrieve");
  assert.equal((await read(fixture.completed, "cancel")).terminal, "succeeded");
  assert.equal((await read({ ...fixture.pending, status: "cancelled" }, "cancel")).terminal, "canceled");
  assert.equal((await read({ ...fixture.pending, status: "failed" })).terminal, "failed");
  for (const patch of [{ id: "v1_other" }, { model: "veo-3.1-generate-preview" }, { object: "video" }, { status: "queued" }, { status: "completed", steps: [] }, { error: { message: "synthetic" } }]) await assert.rejects(read({ ...fixture.pending, ...patch }, "retrieve"), /invalid_google_omni/);
  await assert.rejects(read(fixture.pending, "create", { pathParams: { background: "false", store: "false" } }), /unretrievable_job/);
});

test("continuation, action-required and incomplete statuses stop instead of creating a paid replay", async () => {
  for (const status of ["requires_action", "requires_continuation", "incomplete"]) {
    const result = await read({ ...fixture.pending, status, continuation_token: "synthetic-opaque" });
    assert.equal(result.terminal, null); assert.equal(result.followUp, undefined); assert.equal(result.observationUnavailable, status);
    assert.equal(result.cost, undefined); assert.equal(result.actualCostMicros, undefined);
  }
});

test("URI creation and inline GET both decode native model_output steps, never SDK getters or user input", async () => {
  assert.equal((await read(fixture.completed)).terminal, "succeeded"); assert.equal((await read(fixture.retrieved, "retrieve")).terminal, "succeeded");
  assert.deepEqual(googleOmniVideos(fixture.completed, 3), [asset(`${base}/files/fixture-video:download?alt=media`)]);
  assert.deepEqual(googleOmniVideos(fixture.retrieved, 3), [{ kind: "inline", base64: "AP+A", decodedBytes: 3, mimeType: "video/mp4" }]);
  for (const body of [{ ...fixture.completed, steps: [], output_video: { data: "AP+A" } }, { ...fixture.completed, steps: [{ type: "user_input", content: fixture.retrieved.steps[0].content }] }]) assert.deepEqual(googleOmniVideos(body, 3), []);
  for (const video of [{ type: "video", data: "AP+A", uri: "files/x" }, { type: "video", data: "ZE==" }, { type: "video", data: "AP+A", mime_type: "image/png" }, { type: "video", uri: "https://other.example/arbitrary" }]) assert.throws(() => googleOmniVideos(videoBody(video), 3), /invalid_google_/);
  assert.throws(() => googleOmniVideos(fixture.retrieved, 2), /byte_limit/);
});

test("file metadata polling and download stay on the selected job credential origin", async () => {
  for (const resource of ["files/fixture-video", `${base}/files/fixture-video`, `${base}/files/fixture-video:download?alt=media`]) {
    assert.deepEqual(prepareGoogleOmniFileControl("metadata", asset(resource), base), { url: `${base}/files/fixture-video`, method: "GET", redirect: "error", credential: "original_job", fileName: "files/fixture-video" });
    const active = await state(fixture.active), download = prepareGoogleOmniFileControl("download", asset(resource), base, active);
    assert.equal(download.url, `${base}/files/fixture-video:download?alt=media`); assert.equal(new URL(download.url).searchParams.has("key"), false);
  }
  assert.equal(prepareGoogleOmniFileControl("metadata", asset("files/fixture-video"), "https://proxy.example/google/v1beta").url, "https://proxy.example/google/v1beta/files/fixture-video");
  assert.equal(googleOmniApiBase("https://generativelanguage.googleapis.com"), base);
  assert.equal(googleOmniFilePollIntervalMs, 5000);
});

test("processing readiness is separate from interaction billing and metadata cannot redirect file delivery", async () => {
  const processing = await state(fixture.processing), failed = await state(fixture.fileFailed);
  assert.deepEqual(processing, { name: "files/fixture-video", state: "PROCESSING", ready: false, failed: false });
  assert.equal(failed.failed, true); assert.equal(failed.terminal, undefined); assert.equal(failed.actualCostMicros, undefined);
  for (const observed of [undefined, processing, failed, { ...await state(fixture.active), name: "files/other" }]) assert.throws(() => prepareGoogleOmniFileControl("download", asset("files/fixture-video"), base, observed), /file_not_ready/);
  const active = await state({ ...fixture.active, uri: "https://other.example/video", downloadUri: "https://other.example/video" });
  assert.equal(prepareGoogleOmniFileControl("download", asset("files/fixture-video"), base, active).url, `${base}/files/fixture-video:download?alt=media`);
  for (const patch of [{ name: "files/other" }, { state: "STATE_UNSPECIFIED" }, { state: "DELETED" }, { error: { code: 3 } }, { mimeType: "application/json" }]) await assert.rejects(state({ ...fixture.active, ...patch }), /invalid_google_omni/);
});

test("file controls reject arbitrary origins, credentials, prefixes, versions and encoded traversal", () => {
  for (const resource of ["https://other.example/v1beta/files/fixture-video", `${base}/files/x?key=synthetic`, `${base}/files/x?alt=media&alt=media`, `${base}/files/x#fragment`, `${base}/files/%2e%2e`, `${base}/files/../files/x`, "https://user:synthetic@generativelanguage.googleapis.com/v1beta/files/x", "files/a/b", "https://generativelanguage.googleapis.com/other/files/x", "http://generativelanguage.googleapis.com/v1beta/files/x"]) assert.throws(() => prepareGoogleOmniFileControl("metadata", asset(resource), base), /invalid_google_omni/);
  assert.throws(() => prepareGoogleOmniFileControl("metadata", asset(`${base}/files/x`), "https://proxy.example/v1beta"), /file_origin/);
  for (const url of ["https://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com/v1", "https://proxy.example/v1beta?key=synthetic"]) assert.throws(() => googleOmniApiBase(url), /invalid_google_/);
});

test("native usage retains modality and thought/cache counters without deriving video price or seconds", () => {
  assert.deepEqual(googleOmniUsage(fixture.completed.usage), { inputTokens: 18, outputTokens: 120, totalTokens: 142, cachedTokens: 2, thoughtTokens: 4, inputByModality: { text: 18 }, outputByModality: { video: 100, audio: 20 } });
  assert.deepEqual(googleOmniUsage({ total_input_tokens: 0, total_output_tokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: null, cachedTokens: null, thoughtTokens: null, inputByModality: null, outputByModality: null });
  for (const usage of [undefined, {}, { total_input_tokens: Number.MAX_SAFE_INTEGER, total_output_tokens: 1 }, { ...fixture.completed.usage, output_tokens_by_modality: [{ modality: "video", tokens: 121 }] }, { total_input_tokens: 1 }, { ...fixture.completed.usage, total_output_tokens: "120" }, { ...fixture.completed.usage, total_tokens: 1 }, { ...fixture.completed.usage, total_cached_tokens: 19 }, { ...fixture.completed.usage, total_thought_tokens: -1 }, { ...fixture.completed.usage, input_tokens_by_modality: [{ modality: "text", tokens: 1 }, { modality: "text", tokens: 2 }] }, { ...fixture.completed.usage, output_tokens_by_modality: [{ modality: "other", tokens: 1 }] }]) assert.equal(googleOmniUsage(usage), null);
});

test("bounded reads reject HTTP/JSON/UTF-8 failures and partial files, including split multibyte input", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...fixture.pending, note: "synthetic 🦊" })); let offset = 0;
  const fragmented = new Response(new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, ++offset)); } }), { headers: { "content-type": "application/json" } });
  assert.equal((await readGoogleOmniVideo(fragmented, context())).body.note, "synthetic 🦊");
  for (const response of [Response.json({}, { status: 404 }), new Response("{}", { headers: { "content-type": "text/html" } }), new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), new Response('{"secret":"synthetic"', { headers: { "content-type": "application/json" } })]) await assert.rejects(readGoogleOmniVideo(response, context()), /invalid_google_omni_response/);
  let canceled = false;
  const huge = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(googleOmniEnvelopeBytes + 1)); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  await assert.rejects(readGoogleOmniVideo(huge, context()), /invalid_google_omni_response/); assert.equal(canceled, true);
  assert.deepEqual(await readGoogleOmniFile(new Response(new Uint8Array([0, 255, 128]), { headers: { "content-type": "video/mp4" } }), 3), new Uint8Array([0, 255, 128]));
  for (const response of [Response.json({ error: "synthetic" }), new Response("partial", { status: 206 }), new Response("longer")]) await assert.rejects(readGoogleOmniFile(response, 3), /invalid_google_veo/);
});

test("public native bodies do not retain untrusted control URLs", async () => {
  const observed = await read({ ...fixture.completed, urls: { get: "https://other.example" }, response_url: "https://other.example" });
  const rewritten = adapter.rewrite(observed, { retrieve: "/v1/jobs/fixture" });
  assert.equal(rewritten.urls, undefined); assert.equal(rewritten.response_url, undefined); assert.deepEqual(rewritten.steps, fixture.completed.steps);
});
