import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { xaiVideoModels, validateXaiVideoId, prepareXaiVideo, prepareXaiVideoControl, observeXaiVideo, readXaiVideo } from "../xai-video.ts";
const f = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/video.json", import.meta.url)));
const signal = () => new AbortController().signal;
const observe = body => observeXaiVideo(body, "retrieve", f.generate.model, f.id);
const read = (response, abort = signal()) => readXaiVideo(response, "retrieve", f.generate.model, f.id, abort);

test("finite frozen models and three submit paths preserve identity, options and advisory idempotency", () => {
  assert.deepEqual(xaiVideoModels, ["grok-imagine-video", "grok-imagine-video-1.5"]);
  for (const [mode, key, path] of [["generate", "generate", "generations"], ["generate", "image", "generations"], ["edit", "edit", "edits"], ["extend", "extend", "extensions"]]) {
    const result = prepareXaiVideo(f[key].model, mode, f[key], f.idempotencyKey);
    assert.equal(result.path, `/v1/videos/${path}`); assert.deepEqual(result.body, f[key]);
    assert.equal(result.requestedVersion, f[key].model); assert.equal(result.headers.get("x-idempotency-key"), f.idempotencyKey);
    assert.equal(result.headers.has("authorization"), false);
  }
  for (const model of ["grok-imagine-video-1.5-lite", "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5-2026-05-30"]) {
    assert.throws(() => prepareXaiVideo(model, "generate", { ...f.image, model }));
  }
  assert.throws(() => prepareXaiVideo(f.image.model, "generate", { ...f.generate, model: f.image.model }));
  assert.throws(() => prepareXaiVideo(f.generate.model, "generate", f.generate, "not-uuid"));
});

test("mode, shape and reference boundaries reject silent rounding, unbound file IDs and unsupported expansions", () => {
  for (const body of [
    { ...f.generate, duration: 1.5 }, { ...f.generate, duration: 16 }, { ...f.generate, resolution: "1080p" },
    { ...f.generate, reference_images: Array(8).fill({ url: "https://example.com/input.png" }) },
    { ...f.generate, reference_images: [{ url: "https://example.com/input.png" }], duration: 11 },
    { ...f.generate, image: { file_id: "foreign" } }, { ...f.generate, image: { url: "http://example.com/input.png" } },
    { ...f.generate, image: { url: "https://user:synthetic@example.com/input.png" } },
    { ...f.generate, image: { url: "data:image/png;base64,AB==" } },
    { ...f.generate, image: { url: "https://example.com/input.png" }, reference_images: [{ url: "https://example.com/other.png" }] },
    { ...f.generate, last_frame: { url: "https://example.com/input.png" } },
  ]) assert.throws(() => prepareXaiVideo(body.model, "generate", body));
  assert.equal(prepareXaiVideo(f.generate.model, "generate", { ...f.generate, image: { url: "data:image/png;base64,AAE=" } }).requestedVersion, f.generate.model);
  assert.throws(() => prepareXaiVideo(f.edit.model, "edit", { ...f.edit, duration: 3 }));
  assert.throws(() => prepareXaiVideo(f.extend.model, "extend", { ...f.extend, duration: 1 }));
  assert.throws(() => prepareXaiVideo(f.extend.model, "extend", { ...f.extend, aspect_ratio: "1:1" }));
});

test("control uses only an original scoped ID; no separate result or unsupported cancellation", () => {
  assert.equal(validateXaiVideoId(f.id), f.id);
  const control = prepareXaiVideoControl("retrieve", f.id);
  assert.equal(control.method, "GET"); assert.equal(control.path, `/v1/videos/${f.id}`);
  assert.equal(control.query.size, 0); assert.equal(control.headers.has("authorization"), false);
  for (const id of ["../other", "a?token=synthetic", "https://example.com", "a".repeat(129), 123]) assert.throws(() => prepareXaiVideoControl("retrieve", id));
  for (const action of ["cancel", "result", "delete"]) assert.throws(() => prepareXaiVideoControl(action, f.id));
});

test("native terminal, filtered and observation-loss states never imply a vendor refund", () => {
  const created = observeXaiVideo(f.created, "create", f.generate.model);
  assert.equal(created.id, f.id); assert.equal(created.followUp, "retrieve");
  assert.equal(observe(f.pending).terminal, null);
  const done = observe(f.done); assert.equal(done.terminal, "succeeded"); assert.equal(done.delivery, "available");
  assert.equal(done.outputUrl, "https://example.com/output.mp4"); assert.equal(done.nativeDurationSeconds, 8);
  const filtered = observe(f.filtered); assert.equal(filtered.terminal, "succeeded"); assert.equal(filtered.delivery, "filtered"); assert.equal(filtered.outputUrl, null);
  assert.equal(observe(f.failed).terminal, "failed");
  const expired = observe(f.expired); assert.equal(expired.terminal, null); assert.equal(expired.observationUnavailable, "expired_or_unknown"); assert.equal(expired.followUp, undefined);
  for (const body of [f.created, f.pending, f.done, f.filtered, f.failed, f.expired]) {
    assert.equal(body === f.created ? created.upstreamCostMicros : observe(body).upstreamCostMicros, null);
  }
  assert.equal(observe({ ...f.done, video: { ...f.done.video, duration: 25 } }).nativeDurationSeconds, 25);
});

test("mismatched IDs/models, unknown status, error envelopes and malformed output never become success", () => {
  for (const body of [
    { ...f.done, request_id: "foreign" }, { ...f.done, model: "grok-imagine-video-1.5" }, { status: "queued" },
    { status: "error" }, { status: "cancelled" }, { ...f.pending, video: f.done.video },
    { ...f.done, error: { message: "synthetic" } }, { ...f.done, video: { ...f.done.video, respect_moderation: undefined } },
    { ...f.done, video: { ...f.done.video, url: "javascript:synthetic" } },
    { ...f.filtered, video: { ...f.filtered.video, url: "https://example.com/unqualified.mp4" } },
  ]) assert.throws(() => observe(body));
  assert.throws(() => observeXaiVideo(f.done, "retrieve", f.generate.model));
  assert.throws(() => observeXaiVideo({}, "create", f.generate.model));
});

test("empty 202 is pending; nonempty HTTP status and identity must agree with the bound job", async () => {
  for (const response of [new Response(null, { status: 202 }), new Response("", { status: 202, headers: { "content-type": "text/plain" } }), Response.json(f.pending, { status: 202 })]) {
    const result = await read(response); assert.equal(result.id, f.id); assert.equal(result.nativeStatus, "pending"); assert.equal(result.terminal, null);
  }
  assert.equal((await read(Response.json(f.done))).terminal, "succeeded");
  assert.equal((await readXaiVideo(Response.json(f.created), "create", f.generate.model, undefined, signal())).id, f.id);
  for (const response of [
    Response.json(f.done, { status: 202 }), new Response(null), new Response(null, { status: 404 }), new Response(null, { status: 302 }),
    Response.json(f.pending, { headers: { "content-range": "bytes 0-19/30" } }),
    Response.json(f.done, { headers: { "content-length": "1" } }), Response.json(f.done, { headers: { "content-length": String(1024 * 1024 + 1) } }),
    new Response("<html>synthetic</html>", { status: 202 }), new Response(Uint8Array.of(255), { headers: { "content-type": "application/json" } }),
  ]) await assert.rejects(read(response));
});

test("canceling a stalled or already aborted observation read stops local I/O without replay or cancel claims", async () => {
  for (const alreadyAborted of [false, true]) {
    let canceled = false; const controller = new AbortController();
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"status":')); }, cancel() { canceled = true; } });
    if (alreadyAborted) controller.abort();
    const pending = read(new Response(body, { headers: { "content-type": "application/json" } }), controller.signal);
    controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
  }
});
