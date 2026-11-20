import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { prepareTogetherVideoCreate, readTogetherVideo, togetherVideoManagedAdapter as adapter, togetherVideoModels, togetherVideoOutput, togetherVideoTiming, validateTogetherVideoId } from "../managed-together.ts";
import { managedMediaEnvelopeBytes } from "../managed-media-json.ts";
const fixture = JSON.parse(await readFile(new URL("../../providers/_fixtures/together/video.json", import.meta.url), "utf8"));
const context = (action = "create", overrides = {}) => ({ action, requestedVersion: "Wan-AI/wan2.7-t2v", pathParams: {}, ...(action === "retrieve" ? { expectedId: "video_fixture" } : {}), ...overrides });
const read = (value, action = "create", overrides = {}) => readTogetherVideo(Response.json(value), context(action, overrides));
const endpoint = { method: "GET", path: "/v2/videos/${video_id}" };

for (const request of fixture.requests) test(`frozen native ${request.model} body retains exact wire fields`, () => {
  const before = structuredClone(request), result = adapter.prepare(request, new Headers({ authorization: "Bearer synthetic-caller", "x-api-key": "synthetic-caller" }), {}, new URLSearchParams());
  assert.deepEqual(request, before); assert.deepEqual(result.body, request); assert.equal(result.requestedVersion, request.model);
  assert.deepEqual(Object.fromEntries(result.headers), { "content-type": "application/json" });
  assert.deepEqual(result.pathParams, {});
});

test("finite models and frozen ten-second scope reject newer video modes and mixed request contracts", () => {
  assert.deepEqual(togetherVideoModels, ["Wan-AI/wan2.7-t2v", "Wan-AI/wan2.7-i2v", "minimax/hailuo-02"]);
  for (const patch of [{ model: "Wan-AI/wan2.7-r2v" }, { model: "Wan-AI/wan2.7-videoedit" }, { seconds: "15" }, { seconds: "1" }, { seconds: 5 }, { seconds: "5.5" }, { callback_url: "https://other.example" }, { generate_audio: true }, { width: 1280, height: 720 }, { resolution: "4K" }, { ratio: "21:9" }, { media: { source_video: "https://assets.example.com/input.mp4" } }]) assert.throws(() => prepareTogetherVideoCreate({ ...fixture.requests[0], ...patch }), /invalid_together_video/);
  assert.throws(() => adapter.prepare(fixture.requests[0], new Headers(), { video_id: "caller" }, new URLSearchParams()), /invalid_managed_media_params/);
  assert.throws(() => adapter.prepare(fixture.requests[0], new Headers(), {}, new URLSearchParams("api_key=synthetic")), /unsupported_managed_media_query/);
});

test("native Wan image input admits one first frame and bounded canonical inline encoding", () => {
  const make = input_image => ({ ...fixture.requests[1], media: { frame_images: [{ frame: "first", input_image }] } });
  assert.equal(prepareTogetherVideoCreate(make("data:image/png;base64,cG5n")).media.frame_images[0].frame, "first");
  for (const value of ["data:image/png;base64,YR==", "data:image/png;base64,A===", "data:text/plain;base64,YQ==", "https://user:secret@assets.example.com/image.png", "http://assets.example.com/image.png", "https://assets.example.com/image.png#fragment"]) assert.throws(() => prepareTogetherVideoCreate(make(value)), /invalid_together_video/);
  for (const media of [undefined, { frame_images: [] }, { frame_images: [{ frame: "last", input_image: "https://assets.example.com/image.png" }] }, { frame_images: [make("https://assets.example.com/a.png").media.frame_images[0], make("https://assets.example.com/b.png").media.frame_images[0]] }, { frame_images: make("https://assets.example.com/a.png").media.frame_images, audio_inputs: [] }]) assert.throws(() => prepareTogetherVideoCreate({ ...fixture.requests[1], media }), /invalid_together_video/);
});

test("Hailuo dimensions stay native and never become Wan ratio/resolution or inferred price", () => {
  assert.deepEqual(prepareTogetherVideoCreate(fixture.requests[2]), fixture.requests[2]);
  for (const patch of [{ width: 0 }, { height: 9000 }, { width: "1366" }, { width: 1366.5 }, { height: undefined }, { resolution: "720P" }, { ratio: "16:9" }]) assert.throws(() => prepareTogetherVideoCreate({ ...fixture.requests[2], ...patch }), /invalid_together_video/);
});

test("control paths use the persisted ID and reject result, cancellation and response URLs", () => {
  assert.equal(adapter.protocol, "together.video"); assert.equal(adapter.supportsResult, false); assert.equal(adapter.supportsCancel, false);
  assert.equal(adapter.identify("retrieve", { video_id: "video_fixture" }, new URLSearchParams()), "video_fixture");
  assert.deepEqual(adapter.control("retrieve", endpoint, "video_fixture", {}), { path: "/v2/videos/video_fixture", query: new URLSearchParams() });
  for (const id of ["../other", "a/b", "a?key=fixture", "https://other.example", "a%2fb", "", "x".repeat(129)]) assert.throws(() => validateTogetherVideoId(id), /invalid_together_video_id/);
  for (const action of ["cancel", "result"]) assert.throws(() => adapter.control(action, endpoint, "video_fixture", {}), /control_endpoint/);
  for (const bad of [{ method: "POST", path: endpoint.path }, { method: "GET", path: "https://other.example/${video_id}" }, { method: "GET", path: "/videos/${video_id}" }]) assert.throws(() => adapter.control("retrieve", bad, "video_fixture", {}), /control_endpoint/);
});

test("create acknowledgments and pending polls remain nonterminal until authoritative completion", async () => {
  for (const value of [fixture.pending, { id: "video_fixture" }]) {
    const observation = await read(value); assert.equal(observation.terminal, null); assert.equal(observation.followUp, "retrieve");
  }
  const pending = await read(fixture.pending, "retrieve"); assert.equal(pending.terminal, null); assert.equal(pending.followUp, undefined);
  const done = await read(fixture.completed, "retrieve"); assert.equal(done.terminal, "succeeded"); assert.equal(done.id, "video_fixture");
  assert.equal(togetherVideoOutput(done.body), "https://assets.example.com/together.mp4");
  assert.equal(done.tokens, undefined); assert.equal(done.cost, undefined); assert.equal(done.actualCostMicros, undefined);
});

test("native terminal failure remains distinct from HTTP-200 API errors and observation loss", async () => {
  const failed = await read(fixture.failed, "retrieve"); assert.equal(failed.terminal, "failed");
  for (const value of [{ ...fixture.pending, error: { message: "synthetic rejected call" } }, { ...fixture.pending, status: "expired" }, { ...fixture.pending, status: "UNKNOWN" }, { id: "video_fixture" }]) await assert.rejects(read(value, "retrieve"), /invalid_together_video/);
  await assert.rejects(read({ status: "failed", error: { message: "synthetic no identity" } }), /invalid_together_video_id/);
});

test("retrieve identity/model mismatch and completed-without-asset cannot settle success", async () => {
  for (const patch of [{ id: "another-video" }, { model: "minimax/hailuo-02" }, { outputs: undefined }, { outputs: {} }, { outputs: [] }, { outputs: { video_url: "http://assets.example.com/video.mp4" } }, { outputs: { video_url: 1 } }]) await assert.rejects(read({ ...fixture.completed, ...patch }, "retrieve"), /invalid_together_video/);
});

test("frozen object/array output selection prefers video_url then url without following controls", async () => {
  for (const outputs of [{ video_url: " https://assets.example.com/first.mp4 ", url: "https://assets.example.com/second.mp4" }, [{ video_url: " ", url: " " }, { url: "https://assets.example.com/first.mp4" }, { video_url: "https://assets.example.com/second.mp4" }]]) {
    const result = await read({ ...fixture.completed, outputs, status_url: "https://other.example/status", urls: { get: "https://other.example/get" }, response_url: "https://other.example/result" });
    assert.equal(togetherVideoOutput(result.body), "https://assets.example.com/first.mp4");
    const rewritten = adapter.rewrite(result, { retrieve: "/v1/jobs/fixture" });
    assert.equal(rewritten.status_url, undefined); assert.equal(rewritten.urls, undefined); assert.equal(rewritten.response_url, undefined); assert.deepEqual(rewritten.outputs, outputs);
  }
});

test("bounded JSON reads accept fragmented UTF-8 and reject corrupt, redirected or non-JSON responses", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ ...fixture.pending, note: "synthetic 🦊" })); let index = 0;
  const response = new Response(new ReadableStream({ pull(controller) { if (index === encoded.length) controller.close(); else controller.enqueue(encoded.subarray(index, ++index)); } }), { headers: { "content-type": "application/json" } });
  assert.equal((await readTogetherVideo(response, context())).body.note, "synthetic 🦊");
  for (const response of [new Response("{}", { status: 302, headers: { location: "https://other.example", "content-type": "application/json" } }), new Response("{}", { headers: { "content-type": "text/html" } }), new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), Response.json({ error: "synthetic" }, { status: 401 })]) await assert.rejects(readTogetherVideo(response, context()), /invalid_managed_media/);
});

test("oversize response cancels its producer and never yields terminal evidence", async () => {
  let canceled = false, pulls = 0;
  const response = new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(managedMediaEnvelopeBytes + 1)); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  await assert.rejects(readTogetherVideo(response, context()), /invalid_managed_media_envelope/); assert.equal(canceled, true); assert.equal(pulls, 1);
  assert.deepEqual(togetherVideoTiming, { requestTimeoutMs: 120_000, operationTimeoutMs: 1_200_000, pollIntervalMs: 5000, maxPollAttempts: 240 });
});
