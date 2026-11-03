import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareFalImage, observeFalImage, readFalImage, assertFalImageDispatch } from "../fal-images.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/images.json", import.meta.url)));
const prepare = (i, change = {}) => prepareFalImage(wire.requests[i].model, { ...wire.requests[i].body, ...change });
test("four frozen FLUX/Krea routes retain native field shapes and inline references without product/credential aliases", () => {
  for (let i = 0; i < 4; i++) {
    const request = prepare(i);
    assert.equal(request.path, "/" + wire.requests[i].model); assert.deepEqual(request.body, wire.requests[i].body);
    assert.notEqual(request.body, wire.requests[i].body); assert.equal(request.headers.has("authorization"), false);
    assert.equal(request.inputImages, i === 1 || i === 2 ? 1 : 0); assert.equal(request.inputBytes, i === 1 || i === 2 ? 8 : 0);
  }
  assert.throws(() => prepareFalImage("fal-ai/new-image-model", {}));
});
test("FLUX generation validates size/count and edit never claims unsupported geometry", () => {
  assert.equal(prepare(0, { image_size: "square_hd" }).body.image_size, "square_hd");
  for (const image_size of ["auto", { width: 0, height: 1024 }, { width: 14143, height: 1024 }, { width: 1.5, height: 2 }]) assert.throws(() => prepare(0, { image_size }));
  for (const num_images of [0, 5, "2", 1.5]) assert.throws(() => prepare(0, { num_images }));
  assert.throws(() => prepare(1, { image_size: { width: 1024, height: 1024 } }));
  assert.throws(() => prepare(0, { image_url: wire.requests[1].body.image_url }));
});
test("Krea preserves native aspect ratio/creativity and caps style references instead of pretending batch or format support", () => {
  assert.equal(prepare(2, { image_style_references: Array.from({ length: 10 }, () => ({ image_url: wire.requests[1].body.image_url })) }).inputImages, 10);
  for (const change of [{ num_images: 2 }, { output_format: "png" }, { image_size: "square_hd" }, { creativity: "max" }, { aspect_ratio: "21:9" },
    { image_style_references: Array.from({ length: 11 }, () => ({ image_url: wire.requests[1].body.image_url })) }]) assert.throws(() => prepare(2, change));
});
test("input references require bounded canonical inline data and never authorize uploads or remote fetches", () => {
  for (const image_url of ["https://assets.example/input.png", "data:image/png;base64,A", "data:image/png;base64,AB==", "data:text/html;base64,AAAA"]) assert.throws(() => prepare(1, { image_url }));
  assert.throws(() => prepare(0, { prompt: "\ud800" })); assert.throws(() => prepare(2, { prompt: "x".repeat(5001) }));
  assert.throws(() => prepare(0, { webhookUrl: "https://sink.example/hook" }));
});
test("partial and flagged image batches retain usable descriptors without fabricated free generation or extra outputs", () => {
  const partial = observeFalImage(wire.partial, prepare(0));
  assert.equal(partial.partial, true); assert.equal(partial.images[0].flagged, true); assert.equal(partial.upstreamCostMicros, null);
  const complete = observeFalImage(wire.completed, prepare(1));
  assert.equal(complete.partial, false); assert.equal(complete.images[0].headers, undefined);
  assert.throws(() => observeFalImage({ ...wire.completed, images: [...wire.completed.images, ...wire.completed.images] }, prepare(1)));
  assert.throws(() => observeFalImage({ images: [] }, prepare(0)));
  assert.throws(() => observeFalImage({ ...wire.completed, has_nsfw_concepts: [] }, prepare(0)));
});
test("native result parsing rejects queue/error envelopes, foreign model identity and unsafe output URLs", () => {
  for (const change of [{ request_id: "fixture" }, { status: "IN_PROGRESS" }, { error: {} }, { model: "foreign" }]) assert.throws(() => observeFalImage({ ...wire.completed, ...change }, prepare(0)));
  for (const url of ["http://assets.example/a", "https://127.0.0.1/a", "https://user:secret@assets.example/a", "https://host.internal/a", "data:image/png;base64,AAAA"]) {
    assert.throws(() => observeFalImage({ images: [{ url }] }, prepare(0)));
  }
  assert.throws(() => observeFalImage({ images: [{ ...wire.completed.images[0], content_type: "text/html" }] }, prepare(0)));
});
test("dispatch pins the synchronous origin and selected model path with native Key authentication", () => {
  const prepared = prepare(0);
  const req = (url, auth = "Key synthetic-original") => new Request(url, { method: "POST", headers: { authorization: auth, "content-type": "application/json" } });
  assertFalImageDispatch(req("https://fal.run" + prepared.path), prepared);
  for (const request of [req("https://queue.fal.run" + prepared.path), req("https://other.example" + prepared.path),
    req("https://fal.run/" + wire.requests[1].model), req("https://fal.run" + prepared.path + "?x=1"), req("https://fal.run" + prepared.path, "Bearer synthetic")]) {
    assert.throws(() => assertFalImageDispatch(request, prepared));
  }
});
test("strict complete response/cancellation boundary rejects redirects, partial HTTP and truncation without replay", async () => {
  assert.equal((await readFalImage(Response.json(wire.completed), prepare(1), new AbortController().signal)).images.length, 1);
  for (const response of [Response.json(wire.completed, { status: 202 }), new Response(null, { status: 302 }),
    Response.json(wire.completed, { headers: { "content-range": "bytes 0-1/2" } }), Response.json(wire.completed, { headers: { "content-length": "9999" } })]) {
    await assert.rejects(readFalImage(response, prepare(1), new AbortController().signal));
  }
  await assert.rejects(readFalImage(Response.json(wire.completed), prepare(1), AbortSignal.abort()));
});
