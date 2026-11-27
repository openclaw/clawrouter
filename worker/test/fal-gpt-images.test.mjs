import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareFalGptImage, assertFalGptImageDispatch, observeFalGptImage, readFalGptImage } from "../fal-gpt-images.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/gpt-images.json", import.meta.url)));
const prepare = (i, changes = {}) => prepareFalGptImage(wire.requests[i].model, { ...wire.requests[i].body, ...changes });
test("four frozen GPT Image 2.5 paths retain selected product, explicit quality and ordered edit references", () => {
  for (let i = 0; i < 4; i++) {
    const prepared = prepare(i);
    assert.equal(prepared.path, "/" + wire.requests[i].model); assert.deepEqual(prepared.body, wire.requests[i].body);
    assert.notEqual(prepared.body, wire.requests[i].body); assert.equal(prepared.headers.has("authorization"), false);
    assert.equal(prepared.inputImages, i % 2); assert.equal(prepared.inputBytes, i % 2 ? 8 : 0);
    assert.equal(observeFalGptImage(wire.completed, prepared).upstreamCostMicros, null);
  }
  const references = ["data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,/9j/"];
  assert.deepEqual(prepare(1, { image_urls: references }).body.image_urls, references);
});
test("geometry respects the 16px grid, edge, pixel-area and ratio boundaries", () => {
  for (const image_size of [{ width: 1025, height: 1024 }, { width: 4096, height: 1024 },
    { width: 512, height: 512 }, { width: 3840, height: 3840 }, { width: 3072, height: 768 }, { width: -16, height: -16 }]) {
    assert.throws(() => prepare(0, { image_size }), /geometry/);
  }
  assert.deepEqual(prepare(0, { image_size: { width: 1536, height: 512 } }).body.image_size, { width: 1536, height: 512 });
  assert.equal(prepare(0, { image_size: "auto" }).body.image_size, "auto");
});
test("native options do not silently convert quality, transparency, count or unsupported resolution", () => {
  for (const changes of [{ quality: "ultra" }, { output_format: "gif" }, { background: "transparent", output_format: "jpeg" },
    { quality: ["low"] }, { output_format: ["png"] }, { background: ["opaque"] },
    { num_images: 5 }, { num_images: null }, { resolution: "4K" }, { image_size: "1024x1024" }, { prompt: "x".repeat(32001) }]) assert.throws(() => prepare(0, changes));
  assert.equal(prepare(1).body.quality, "auto");
  const { quality, ...body } = wire.requests[0].body;
  assert.equal(Object.hasOwn(prepareFalGptImage(wire.requests[0].model, body).body, "quality"), false);
});
test("edits require 1–16 bounded inline images; generation never auto-switches to edit", () => {
  const image = wire.requests[1].body.image_urls[0];
  assert.equal(prepare(1, { image_urls: Array(16).fill(image) }).inputImages, 16);
  for (const image_urls of [[], Array(17).fill(image), ["https://assets.example/input.png"], ["data:image/png;base64,AB=="]]) assert.throws(() => prepare(1, { image_urls }));
  assert.throws(() => prepare(0, { image_urls: [image] }));
  assert.throws(() => prepareFalGptImage("openai/gpt-image-2.5/other/edit", wire.requests[1].body));
});
test("partial native image output remains distinct from measured cost or a refund", () => {
  const partial = observeFalGptImage(wire.completed, prepare(2));
  assert.equal(partial.partial, true); assert.equal(partial.images.length, 1); assert.equal(partial.upstreamCostMicros, null);
  assert.equal(partial.images[0].headers, undefined);
  assert.throws(() => observeFalGptImage({ ...wire.completed, model: "gpt-image-2.5" }, prepare(2)));
});
test("fal hosted dispatch never changes to direct OpenAI, a queue origin or another selected product", () => {
  const prepared = prepare(0), request = (origin, path = prepared.path, auth = "Key synthetic-original") =>
    new Request(origin + path, { method: "POST", headers: { authorization: auth, "content-type": "application/json" } });
  assertFalGptImageDispatch(request("https://fal.run"), prepared);
  for (const value of [request("https://api.openai.com"), request("https://queue.fal.run"),
    request("https://fal.run", "/" + wire.requests[2].model), request("https://fal.run", prepared.path, "Bearer synthetic")]) {
    assert.throws(() => assertFalGptImageDispatch(value, prepared));
  }
});
test("the shared strict result reader retains cancellation and truncated/partial-response protections", async () => {
  assert.equal((await readFalGptImage(Response.json(wire.completed), prepare(0), new AbortController().signal)).images.length, 1);
  await assert.rejects(readFalGptImage(Response.json(wire.completed, { headers: { "content-length": "9999" } }), prepare(0), new AbortController().signal));
  await assert.rejects(readFalGptImage(Response.json(wire.completed, { status: 206 }), prepare(0), new AbortController().signal));
  await assert.rejects(readFalGptImage(Response.json(wire.completed), prepare(0), AbortSignal.abort()));
});
