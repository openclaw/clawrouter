import { byteBody, byteResponse, jsonResponse } from "./minimax-search-byte-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { miniMaxVideoModels, prepareMiniMaxVideo, prepareMiniMaxVideoControl, observeMiniMaxVideo, readMiniMaxVideo,
  validateMiniMaxMediaId, parseMiniMaxMediaJson, miniMaxVideoFiles, prepareMiniMaxVideoFile, readMiniMaxVideoFileState, readMiniMaxVideoFile } from "../minimax-video.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/video.json", import.meta.url)));
const signal = () => new AbortController().signal;
const prepare = body => prepareMiniMaxVideo("global", body);

test("finite legacy modes enforce native duration/resolution combinations without silent rounding", () => {
  assert.equal(miniMaxVideoModels.length, 6);
  assert.equal(prepare(wire.request).path, "/v1/video_generation");
  assert.equal(prepareMiniMaxVideo("cn", wire.image).origin, "https://api.minimaxi.com");
  for (const model of miniMaxVideoModels) {
    const legacy = model.startsWith("I2V-");
    const request = prepare({ ...wire.image, model, duration: 6, resolution: legacy ? "720P" : "1080P" });
    assert.equal(request.requestedVersion, model); assert.equal(request.headers.has("authorization"), false);
  }
  for (const body of [
    { ...wire.request, model: "MiniMax-H3" }, { ...wire.request, model: "MiniMax-Hailuo-2.3-Fast" },
    { ...wire.request, model: "I2V-01" }, { ...wire.request, duration: 10 }, { ...wire.request, duration: 5 },
    { ...wire.image, resolution: "512P" }, { ...wire.request, callback_url: "https://media.example/callback" },
    { ...wire.image, first_frame_image: "provider-file-id" },
  ]) assert.throws(() => prepare(body));
});

test("int64 native IDs survive JSON parsing while string content and unrelated numbers remain inert", () => {
  const body = parseMiniMaxMediaJson('{"task_id":9007199254740993,"file":{"file_id":9223372036854775807},"other":42,"note":"file_id:9007199254740994"}');
  assert.equal(body.task_id, wire.submitted.task_id); assert.equal(body.file.file_id, wire.success.file_id);
  assert.equal(body.other, 42); assert.equal(body.note, "file_id:9007199254740994");
  assert.equal(parseMiniMaxMediaJson('{"file_id":"123","nested":{"file_id":456}}').nested.file_id, "456");
  for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1, "01", "../other", "9223372036854775808"]) assert.throws(() => validateMiniMaxMediaId(id));
  for (const text of ['{"file_id":01}', '{"file_id":9223372036854775808}', '{"file_id":123', '{"note":"unterminated}']) assert.throws(() => parseMiniMaxMediaJson(text));
});

test("submit/read lifecycle binds the original task and terminal failure never implies a refund", () => {
  const submitted = observeMiniMaxVideo(wire.submitted, "create");
  assert.equal(submitted.followUp, "retrieve"); assert.equal(submitted.terminal, null);
  assert.equal(observeMiniMaxVideo(wire.pending, "retrieve", submitted.id).terminal, null);
  assert.equal(observeMiniMaxVideo(wire.success, "retrieve", submitted.id).terminal, "succeeded");
  const failed = observeMiniMaxVideo(wire.failed, "retrieve", submitted.id);
  assert.equal(failed.terminal, "failed"); assert.equal(failed.actualCostMicros, undefined);
  assert.throws(() => observeMiniMaxVideo(wire.success, "retrieve", "123"), /identity/);
  for (const body of [
    { ...wire.pending, status: "Expired" }, { ...wire.pending, file_id: "123" },
    { ...wire.failed, base_resp: { status_code: 1004 } }, { ...wire.success, file_id: undefined },
  ]) assert.throws(() => observeMiniMaxVideo(body, "retrieve", submitted.id));
});

test("native controls are query-bound retrieval only; legacy cancellation and foreign IDs stay closed", () => {
  const control = prepareMiniMaxVideoControl("retrieve", wire.submitted.task_id);
  assert.equal(control.path, "/v1/query/video_generation"); assert.equal(control.query.get("task_id"), wire.submitted.task_id);
  assert.equal(control.query.size, 1); assert.equal(control.headers.has("authorization"), false);
  for (const action of ["cancel", "result", "delete"]) assert.throws(() => prepareMiniMaxVideoControl(action, wire.submitted.task_id));
});

test("file descriptors come only from successful original tasks and metadata cannot redirect credentials", async () => {
  const observation = observeMiniMaxVideo(wire.success, "retrieve", wire.submitted.task_id);
  assert.deepEqual(miniMaxVideoFiles(observation), [{ id: wire.success.file_id, mimeType: "video/mp4" }]);
  assert.deepEqual(miniMaxVideoFiles(observeMiniMaxVideo(wire.pending, "retrieve", wire.submitted.task_id)), []);
  const control = prepareMiniMaxVideoFile("download", "https://api.minimax.io", wire.success.file_id);
  assert.equal(control.path, "/v1/files/retrieve_content"); assert.equal(control.query.get("file_id"), wire.success.file_id);
  assert.equal(control.headers.has("authorization"), false);
  assert.throws(() => prepareMiniMaxVideoFile("download", "https://media.example", wire.success.file_id));
  const state = await readMiniMaxVideoFileState(jsonResponse(wire.file), wire.success.file_id, signal());
  assert.equal(state.status, "active"); assert.equal(state.body.file.download_url, undefined);
  assert.equal(state.byteSize, 16);
  await assert.rejects(readMiniMaxVideoFileState(jsonResponse(wire.file), "123", signal()));
});

test("native JSON reader preserves unquoted int64 and cancellation without paid replay", async () => {
  const native = '{"task_id":9007199254740993,"status":"Success","file_id":9223372036854775807,"base_resp":{"status_code":0}}';
  const result = await readMiniMaxVideo(byteResponse(native, { headers: { "content-type": "application/json" } }), "retrieve", wire.submitted.task_id, signal());
  assert.equal(result.body.file_id, wire.success.file_id);
  await assert.rejects(readMiniMaxVideo(jsonResponse(wire.pending, { status: 404 }), "retrieve", wire.submitted.task_id, signal()));
  let canceled = false; const controller = new AbortController();
  const stream = new ReadableStream({ type: "bytes", start(c) { c.enqueue(new TextEncoder().encode('{"task_id":')); }, cancel() { canceled = true; } });
  const pending = readMiniMaxVideo(new Response(stream, { headers: { "content-type": "application/json" } }), "retrieve", wire.submitted.task_id, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});

test("file bytes require an MP4 box despite the primary binary schema's JSON MIME", async () => {
  const mp4Header = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  for (const mime of ["video/mp4", "application/octet-stream", "application/json"]) {
    const bytes = await readMiniMaxVideoFile(byteResponse(mp4Header, { headers: { "content-type": mime } }), 1024, signal());
    assert.deepEqual(bytes, mp4Header);
  }
  for (const response of [
    jsonResponse({ base_resp: { status_code: 1004 } }),
    byteResponse(mp4Header, { headers: { "content-type": "text/html" } }),
    byteResponse(mp4Header, { headers: { "content-type": "video/mp4", "content-length": "17" } }),
    byteResponse(mp4Header, { status: 206, headers: { "content-type": "video/mp4" } }),
  ]) await assert.rejects(readMiniMaxVideoFile(response, 1024, signal()));
});

