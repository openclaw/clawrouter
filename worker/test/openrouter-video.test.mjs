import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openRouterVideoModels, prepareOpenRouterVideo, prepareOpenRouterVideoControl, observeOpenRouterVideo,
  readOpenRouterVideo, prepareOpenRouterVideoContent, readOpenRouterVideoContent, rewriteOpenRouterVideo } from "../openrouter-video.ts";
const f = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/video.json", import.meta.url)));
const signal = () => new AbortController().signal;
const prepare = body => prepareOpenRouterVideo(f.create.model, body, { retentionAllowed: true });
const observe = body => observeOpenRouterVideo(body, "retrieve", f.create.model, f.id);
const read = (response, abort = signal()) => readOpenRouterVideo(response, "retrieve", f.create.model, f.id, abort);

test("one frozen model preserves native choices and requires trusted temporary-retention admission", () => {
  assert.deepEqual(openRouterVideoModels, ["google/veo-3.1-fast"]);
  const source = structuredClone(f.create), result = prepare(source);
  assert.equal(result.path, "/api/v1/videos"); assert.deepEqual(result.body, source);
  source.prompt = "changed"; assert.equal(result.body.prompt, f.create.prompt);
  assert.equal(result.headers.has("authorization"), false); assert.equal(result.mode, "text");
  assert.throws(() => prepareOpenRouterVideo(f.create.model, f.create, { retentionAllowed: false }));
  for (const model of ["veo-3.1-fast-generate-preview", "google/veo-3.1", "google/veo-3.1-lite"]) assert.throws(() => prepareOpenRouterVideo(model, { ...f.create, model }, { retentionAllowed: true }));
  for (const body of [{ ...f.create, duration: 5 }, { ...f.create, duration: "4" }, { ...f.create, resolution: "4k" },
    { ...f.create, size: "720x1280" }, { ...f.create, seed: 1.5 }, { ...f.create, prompt: "\ud800" },
    { ...f.create, callback_url: "https://example.com/callback" }, { ...f.create, provider: { zdr: false } }, { ...f.create, retentionAllowed: true }]) assert.throws(() => prepare(body));
  assert.equal(prepare({ ...f.create, size: "1280x720" }).body.size, "1280x720");
});

test("first/last frames are bounded; reference mode needs separate model qualification and never overrides frames", () => {
  const last = { ...f.image.frame_images[0], frame_type: "last_frame" };
  assert.equal(prepare({ ...f.image, frame_images: [...f.image.frame_images, last] }).mode, "image");
  const reference = { type: "image_url", image_url: { url: "data:image/png;base64,AAE=" } };
  assert.throws(() => prepare({ ...f.image, input_references: [reference] }));
  const both = prepareOpenRouterVideo(f.create.model, { ...f.image, input_references: [reference] }, { retentionAllowed: true, referenceInputsQualified: true });
  assert.equal(both.mode, "image"); assert.equal(both.body.input_references.length, 1);
  for (const frames of [[...f.image.frame_images, ...f.image.frame_images], [{ ...last, image_url: { file_id: "foreign" } }],
    [{ ...last, image_url: { url: "http://example.com/image.png" } }], [{ ...last, image_url: { url: "https://user:synthetic@example.com/image.png" } }],
    [{ ...last, image_url: { url: "data:image/png;base64,AB==" } }]]) assert.throws(() => prepare({ ...f.image, frame_images: frames }));
  const large = { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}` } };
  assert.throws(() => prepareOpenRouterVideo(f.create.model, { ...f.create, input_references: [large, large, large] }, { retentionAllowed: true, referenceInputsQualified: true }));
});

test("submit/read/control bind the original job; foreign URLs never grant credentials or cancellation", async () => {
  const created = await readOpenRouterVideo(Response.json(f.accepted, { status: 202 }), "create", f.create.model, undefined, signal());
  assert.equal(created.id, f.id); assert.equal(created.followUp, "retrieve");
  assert.equal(prepareOpenRouterVideoControl("retrieve", created.id).path, `/api/v1/videos/${f.id}`);
  for (const action of ["cancel", "result", "delete", "download"]) assert.throws(() => prepareOpenRouterVideoControl(action, f.id));
  for (const id of ["../other", "foreign?index=0", "https://example.com", "x".repeat(129)]) assert.throws(() => prepareOpenRouterVideoControl("retrieve", id));
  for (const body of [{ ...f.completed, id: "foreign" }, { ...f.completed, model: "google/veo-3.1" },
    { ...f.completed, polling_url: "https://openrouter.ai/api/v1/videos/foreign" },
    { ...f.completed, unsigned_urls: ["https://example.com/output.mp4"] },
    { ...f.completed, unsigned_urls: [`https://openrouter.ai/api/v1/videos/${f.id}/content?index=1`] }]) assert.throws(() => observe(body));
  assert.equal(observe({ status: "in_progress" }).id, f.id);
  assert.throws(() => observeOpenRouterVideo(f.running, "retrieve", f.create.model));
});

test("all known states stop correctly without turning expiry, cancellation or missing metrics into free generation", () => {
  for (const status of ["pending", "in_progress", "queued", "processing", "running"]) assert.equal(observe({ id: f.id, status }).terminal, null);
  assert.equal(observe(f.completed).terminal, "succeeded"); assert.equal(observe(f.failed).terminal, "failed");
  assert.equal(observe(f.cancelled).terminal, "canceled");
  const expired = observe(f.expired); assert.equal(expired.observationUnavailable, "expired_or_unknown");
  assert.equal(expired.terminal, null); assert.equal(expired.followUp, undefined); assert.equal(expired.contentAvailable, false);
  for (const body of [f.accepted, f.running, f.completed, f.failed, f.cancelled, f.expired]) assert.equal(observe(body).upstreamCostMicros, null);
  assert.equal(observe(f.completed).nativeCost, 0.32); assert.equal(observe(f.failed).nativeCost, null);
  for (const body of [{ id: f.id, status: "unknown" }, { ...f.completed, error: "synthetic" },
    { ...f.running, unsigned_urls: f.completed.unsigned_urls }, { ...f.completed, usage: { cost: -1 } },
    { ...f.completed, unsigned_urls: [...f.completed.unsigned_urls, ...f.completed.unsigned_urls] }]) assert.throws(() => observe(body));
});

test("only a completed bound job supplies a fixed authenticated download path; native bearer URLs are removed", () => {
  const observation = observe({ ...f.completed, urls: ["https://example.com/signed-synthetic"], expires_at: "synthetic" });
  const content = prepareOpenRouterVideoContent(observation, f.id);
  assert.equal(content.path, f.content.path); assert.equal(content.query.toString(), f.content.query); assert.equal(content.headers.has("authorization"), false);
  assert.throws(() => prepareOpenRouterVideoContent(observation, "foreign"));
  for (const body of [f.running, f.failed, f.cancelled, f.expired]) assert.throws(() => prepareOpenRouterVideoContent(observe(body), f.id));
  const publicBody = rewriteOpenRouterVideo(observation, { retrieve: "/jobs/local", result: "/jobs/local/content" });
  assert.equal(publicBody.polling_url, "/jobs/local"); assert.deepEqual(publicBody.unsigned_urls, ["/jobs/local/content"]);
  assert.equal(publicBody.urls, undefined); assert.equal(publicBody.expires_at, undefined);
  assert.throws(() => rewriteOpenRouterVideo(observation, {}));
  assert.throws(() => rewriteOpenRouterVideo(observation, { retrieve: "/jobs/local" }));
  assert.throws(() => rewriteOpenRouterVideo(observation, { retrieve: "https://example.com", result: "/content" }));
});

test("native JSON uses complete bounded UTF-8 and real HTTP status, never treating 404/202 polls as terminal proof", async () => {
  assert.equal((await read(Response.json(f.completed))).terminal, "succeeded");
  for (const response of [Response.json(f.running, { status: 202 }), Response.json(f.expired, { status: 404 }),
    Response.json(f.completed, { headers: { "content-range": "bytes 0-1/100" } }),
    Response.json(f.completed, { headers: { "content-length": "1" } }),
    new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } }),
    new Response(" ".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })]) await assert.rejects(() => read(response));
  const redirected = Response.json(f.completed); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(() => read(redirected));
});

test("complete video download preserves bytes without inferring duration, price or playable-media validation", async () => {
  const bytes = Buffer.from(f.content.base64, "base64");
  for (const mime of ["video/mp4", "video/webm"]) {
    const result = await readOpenRouterVideoContent(new Response(bytes, { headers: { "content-type": mime, "content-length": String(bytes.length) } }), signal());
    assert.deepEqual(result.video, new Uint8Array(bytes)); assert.equal(result.mimeType, mime); assert.equal(result.upstreamCostMicros, null);
  }
  for (const response of [new Response(bytes, { status: 206, headers: { "content-type": "video/mp4" } }),
    new Response(bytes, { headers: { "content-type": "application/json" } }),
    new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": "1" } }),
    new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(64 * 1024 * 1024 + 1) } }),
    new Response("", { headers: { "content-type": "video/mp4" } })]) await assert.rejects(() => readOpenRouterVideoContent(response, signal()));
});

test("abort releases stalled JSON and content without retry, refund or replacement create", async () => {
  for (const content of [false, true]) {
    let canceled = false;
    const controller = new AbortController(), response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": content ? "video/mp4" : "application/json" } });
    const pending = content ? readOpenRouterVideoContent(response, controller.signal) : read(response, controller.signal);
    controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
  }
});
