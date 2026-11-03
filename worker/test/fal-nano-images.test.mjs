import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { falNanoImageModels, prepareFalNanoImage, assertFalNanoImageDispatch, observeFalNanoImage, readFalNanoImage } from "../fal-nano-images.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/nano-images.json", import.meta.url)));
const prepare = (i, changes = {}) => prepareFalNanoImage(wire.requests[i].model, { ...wire.requests[i].body, ...changes });
test("six frozen paths preserve selected fal product and exact native bodies without credential injection", () => {
  assert.deepEqual(wire.requests.map(item => item.model), [...falNanoImageModels]);
  for (let i = 0; i < 6; i++) {
    const prepared = prepare(i);
    assert.equal(prepared.path, "/" + wire.requests[i].model); assert.deepEqual(prepared.body, wire.requests[i].body);
    assert.notEqual(prepared.body, wire.requests[i].body); assert.equal(prepared.headers.has("authorization"), false);
    assert.equal(prepared.inputImages, i % 2); assert.equal(prepared.inputBytes, i % 2 ? 8 : 0);
  }
  for (const model of ["fal-ai/nano-banana-pro", "fal-ai/nano-banana-2.1", "gemini-2.5-flash-image", "google/nano-banana-2-lite/other"]) {
    assert.throws(() => prepareFalNanoImage(model, wire.requests[0].body));
  }
});
test("legacy and new ratio sets stay distinct; missing geometry preserves provider defaults", () => {
  assert.throws(() => prepare(0, { aspect_ratio: "8:1" }), /aspect_ratio/);
  for (const i of [2, 3, 4, 5]) assert.equal(prepare(i, { aspect_ratio: "8:1" }).body.aspect_ratio, "8:1");
  for (const aspect_ratio of ["auto", null, ["1:1"], "2.35:1"]) assert.throws(() => prepare(0, { aspect_ratio }));
  const { aspect_ratio, ...body } = wire.requests[4].body;
  assert.equal(Object.hasOwn(prepareFalNanoImage(wire.requests[4].model, body).body, "aspect_ratio"), false);
  assert.equal(Object.hasOwn(prepare(1).body, "aspect_ratio"), false);
});
test("only Nano Banana 2 accepts the frozen 1K/2K/4K resolution contract", () => {
  for (const i of [0, 1, 4, 5]) assert.throws(() => prepare(i, { resolution: "1K" }), /fields/);
  for (const resolution of ["1K", "2K", "4K"]) assert.equal(prepare(2, { resolution }).body.resolution, resolution);
  for (const resolution of ["0.5K", "2k", ["1K"], null]) assert.throws(() => prepare(2, { resolution }), /resolution/);
  assert.throws(() => prepare(2, { image_size: { width: 1024, height: 1024 } }), /fields/);
});
test("edits enforce 3 versus 14 ordered inline references and never switch the selected generation route", () => {
  const image = wire.requests[1].body.image_urls[0], jpeg = "data:image/jpeg;base64,/9j/";
  assert.deepEqual(prepare(1, { image_urls: [jpeg, image] }).body.image_urls, [jpeg, image]);
  for (const [i, limit] of [[1, 3], [3, 14], [5, 14]]) {
    assert.equal(prepare(i, { image_urls: Array(limit).fill(image) }).inputImages, limit);
    for (const image_urls of [[], Array(limit + 1).fill(image), ["https://assets.example/input.png"], ["data:image/png;base64,AB=="]]) assert.throws(() => prepare(i, { image_urls }));
  }
  assert.throws(() => prepare(0, { image_urls: [image] }));
  for (const changes of [{ video_url: "https://assets.example/input.mp4" }, { audio_url: "https://assets.example/input.wav" }, { pdf_url: "https://assets.example/input.pdf" }]) assert.throws(() => prepare(3, changes));
});
test("decoded reference-byte limits apply to one image and to the whole edit", () => {
  const data = bytes => "data:image/png;base64," + Buffer.alloc(bytes).toString("base64");
  assert.throws(() => prepare(3, { image_urls: [data(8 * 1024 * 1024 + 1)] }), /image_base64/);
  assert.throws(() => prepare(3, { image_urls: Array(3).fill(data(6 * 1024 * 1024)) }), /input_limit/);
});
test("native scalar counts, formats and Unicode prompts reject malformed or out-of-scope values", () => {
  for (const changes of [{ num_images: 5 }, { num_images: "2" }, { num_images: null }, { num_images: 1.5 }, { output_format: "webp" },
    { output_format: ["png"] }, { prompt: "ab" }, { prompt: "x".repeat(50001) }, { prompt: "bad\ud800" }, { webhookUrl: "https://sink.example/hook" }]) assert.throws(() => prepare(0, changes));
  assert.equal(prepare(0, { prompt: "🛶🛶🛶" }).body.prompt, "🛶🛶🛶");
});
test("partial and flagged results retain unknown cost and secret-free output descriptors", () => {
  const result = observeFalNanoImage(wire.flaggedPartial, prepare(2));
  assert.equal(result.partial, true); assert.equal(result.images[0].flagged, true); assert.equal(result.upstreamCostMicros, null);
  assert.equal(result.images[0].headers, undefined); assert.equal(result.selectedModel, wire.requests[2].model);
  assert.throws(() => observeFalNanoImage({ ...wire.completed, model: "gemini-2.5-flash-image" }, prepare(0)));
  assert.throws(() => observeFalNanoImage({ request_id: "synthetic-job", ...wire.completed }, prepare(0)));
});
test("dispatch requires the selected synchronous fal route and Key scheme, not Google or queue credentials", () => {
  const prepared = prepare(4), request = (origin, path = prepared.path, auth = "Key synthetic-original") =>
    new Request(origin + path, { method: "POST", headers: { authorization: auth, "content-type": "application/json" } });
  assertFalNanoImageDispatch(request("https://fal.run"), prepared);
  for (const value of [request("https://generativelanguage.googleapis.com"), request("https://queue.fal.run"),
    request("https://fal.run", "/" + wire.requests[5].model), request("https://fal.run", prepared.path, "Bearer synthetic")]) {
    assert.throws(() => assertFalNanoImageDispatch(value, prepared));
  }
});
test("native result reading rejects partial HTTP, truncation and local cancellation without remote replay", async () => {
  assert.equal((await readFalNanoImage(Response.json(wire.completed), prepare(0), new AbortController().signal)).images.length, 1);
  await assert.rejects(readFalNanoImage(Response.json(wire.completed, { status: 206 }), prepare(0), new AbortController().signal));
  await assert.rejects(readFalNanoImage(Response.json(wire.completed, { headers: { "content-length": "9999" } }), prepare(0), new AbortController().signal));
  await assert.rejects(readFalNanoImage(Response.json(wire.completed), prepare(0), AbortSignal.abort()));
});
