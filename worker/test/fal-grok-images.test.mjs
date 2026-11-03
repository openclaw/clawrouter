import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { falGrokImageModels, prepareFalGrokImage, assertFalGrokImageDispatch, observeFalGrokImage, readFalGrokImage } from "../fal-grok-images.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/grok-images.json", import.meta.url)));
const prepare = (i, changes = {}) => prepareFalGrokImage(wire.requests[i].model, { ...wire.requests[i].body, ...changes });
test("three documented frozen fal Grok routes preserve product and native bodies without direct-xAI aliases", () => {
  assert.deepEqual(wire.requests.map(item => item.model), [...falGrokImageModels]);
  for (let i = 0; i < 3; i++) {
    const prepared = prepare(i);
    assert.equal(prepared.path, "/" + wire.requests[i].model); assert.deepEqual(prepared.body, wire.requests[i].body);
    assert.notEqual(prepared.body, wire.requests[i].body); assert.equal(prepared.headers.has("authorization"), false);
    assert.equal(prepared.inputImages, i ? 1 : 0); assert.equal(prepared.inputBytes, i ? 8 : 0);
  }
  assert.equal(Object.hasOwn(prepare(2).body, "quality"), false);
  for (const quality of ["low", "auto", "high"]) assert.throws(() => prepare(2, { quality }));
});
test("unqualified quality generation fails closed without falsely treating a schema 404 as retirement", () => {
  assert.equal(wire.unqualified.retirementProven, false); assert.equal(wire.unqualified.directXaiAliasApplicable, false);
  assert.throws(() => prepareFalGrokImage(wire.unqualified.model, wire.requests[0].body), /unqualified_quality_generate/);
  for (const model of ["grok-imagine-image-quality", "grok-imagine-image-2.0", "xai/grok-imagine-image-2.0"]) assert.throws(() => prepareFalGrokImage(model, wire.requests[0].body));
});
test("frozen geometry uses exact ratios and lowercase native resolution without inheriting direct-xAI options", () => {
  assert.equal(prepare(0, { aspect_ratio: "9:19.5", resolution: "1k" }).body.aspect_ratio, "9:19.5");
  for (const changes of [{ resolution: "2K" }, { resolution: "4k" }, { resolution: ["1k"] }, { resolution: null },
    { aspect_ratio: "auto" }, { aspect_ratio: ["1:1"] }, { aspect_ratio: "21:9" }, { image_size: "square" }]) assert.throws(() => prepare(0, changes));
  assert.equal(Object.hasOwn(prepare(1).body, "aspect_ratio"), false);
  assert.equal(Object.hasOwn(prepare(1).body, "resolution"), false);
});
test("edit reference order and 1–3 limits are enforced without automatic generation-to-edit rewriting", () => {
  const image = wire.requests[1].body.image_urls[0], jpeg = "data:image/jpeg;base64,/9j/";
  assert.deepEqual(prepare(2, { image_urls: [jpeg, image, jpeg] }).body.image_urls, [jpeg, image, jpeg]);
  for (const i of [1, 2]) for (const image_urls of [[], Array(4).fill(image), ["https://assets.example/in.png"], ["data:image/png;base64,AB=="]]) {
    assert.throws(() => prepare(i, { image_urls }));
  }
  assert.throws(() => prepare(0, { image_urls: [image] }));
});
test("native malformed counts, output formats and oversized or broken Unicode prompts are rejected", () => {
  for (const changes of [{ num_images: null }, { num_images: 5 }, { num_images: "2" }, { num_images: 1.5 },
    { output_format: ["png"] }, { output_format: "webp" }, { prompt: " " }, { prompt: "x".repeat(8001) }, { prompt: "bad\ud800" }]) assert.throws(() => prepare(0, changes));
  assert.equal(prepare(0, { prompt: "🛶".repeat(8000) }).body.prompt.length, 16000);
});
test("partial output and quality paths never imply a known upstream tariff or free generation", () => {
  const result = observeFalGrokImage(wire.completed, prepare(1));
  assert.equal(result.partial, true); assert.equal(result.upstreamCostMicros, null); assert.equal(result.images[0].headers, undefined);
  const qualityResult = observeFalGrokImage(wire.completed, prepare(2));
  assert.equal(qualityResult.selectedModel, wire.requests[2].model); assert.equal(qualityResult.upstreamCostMicros, null);
  assert.throws(() => observeFalGrokImage({ ...wire.completed, model: "grok-imagine-image-2.0" }, prepare(2)));
});
test("dispatch pins selected fal identity and Key credential scheme rather than direct xAI or the queue", () => {
  const prepared = prepare(2), request = (origin, path = prepared.path, auth = "Key synthetic-original") =>
    new Request(origin + path, { method: "POST", headers: { authorization: auth, "content-type": "application/json" } });
  assertFalGrokImageDispatch(request("https://fal.run"), prepared);
  for (const value of [request("https://api.x.ai"), request("https://queue.fal.run"), request("https://fal.run", "/" + wire.requests[1].model),
    request("https://fal.run", prepared.path, "Bearer synthetic")]) assert.throws(() => assertFalGrokImageDispatch(value, prepared));
});
test("the shared complete-response reader handles cancellation without accepting queue, partial HTTP or truncated bodies", async () => {
  assert.equal((await readFalGrokImage(Response.json(wire.completed), prepare(0), new AbortController().signal)).images.length, 1);
  for (const response of [Response.json(wire.completed, { status: 202 }), Response.json(wire.completed, { status: 206 }),
    Response.json(wire.completed, { headers: { "content-length": "9999" } })]) await assert.rejects(readFalGrokImage(response, prepare(0), new AbortController().signal));
  await assert.rejects(readFalGrokImage(Response.json(wire.completed), prepare(0), AbortSignal.abort()));
});
