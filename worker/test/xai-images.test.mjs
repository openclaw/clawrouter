import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareXaiImage, observeXaiImage, readXaiImage, xaiImageAliasEffectiveAt, xaiImageModels } from "../xai-images.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/images.json", import.meta.url)));
const prepare = (mode, body) => prepareXaiImage(body.model, mode, body);
const signal = () => new AbortController().signal;

test("the retired quality slug preserves selected identity and resolves to low for generation AND edits", () => {
  assert.deepEqual(xaiImageModels, ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"]);
  assert.equal(xaiImageAliasEffectiveAt, wire.aliasEffectiveDate);
  for (const row of wire.dispositions) {
    const body = { ...wire[row.mode], model: row.selected }, request = prepare(row.mode, body);
    assert.equal(request.body.model, row.selected); assert.equal(request.model, row.selected);
    assert.equal(request.servingModel, row.serving); assert.equal(request.quality, row.quality); assert.equal(request.qualityBasis, row.basis);
    assert.equal(request.headers.has("authorization"), false);
    assert.equal(request.path, row.mode === "generate" ? "/v1/images/generations" : "/v1/images/edits");
  }
  assert.notEqual(prepare("edit", wire.edit).quality, prepare("edit", { ...wire.edit, model: "grok-imagine-image-2.0" }).quality);
});

test("direct 2.0 explicit quality is preserved while legacy slugs cannot silently receive auto semantics", () => {
  for (const quality of ["low", "medium"]) {
    const request = prepare("edit", { ...wire.edit, model: "grok-imagine-image-2.0", quality });
    assert.equal(request.quality, quality); assert.equal(request.qualityBasis, "explicit"); assert.equal(request.body.quality, quality);
  }
  assert.equal(prepare("edit", { ...wire.edit, model: "grok-imagine-image-2.0", quality: "auto" }).quality, "medium");
  for (const model of ["grok-imagine-image", "grok-imagine-image-quality"]) {
    assert.throws(() => prepare("edit", { ...wire.edit, model, quality: "auto" }), /quality/);
  }
  assert.throws(() => prepare("generate", { ...wire.generate, model: "grok-imagine-image-pro" }), /model/);
  assert.throws(() => prepare("edit", { ...wire.edit, model: "grok-imagine-image-2.0", quality: ["low"] }), /quality/);
});

test("the actual returned serving model must match the alias and never overwrite selected policy identity", () => {
  const request = prepare("generate", wire.generate), result = observeXaiImage(wire.result, request, true);
  assert.equal(result.selectedModel, wire.generate.model); assert.equal(result.servingModel, wire.result.model);
  assert.deepEqual([...result.images[0]], [0, 255, 128]); assert.equal(result.quality, "low"); assert.equal(result.actualCostMicros, undefined);
  for (const model of [undefined, "grok-imagine-image-quality", "grok-imagine-image"]) {
    assert.throws(() => observeXaiImage({ ...wire.result, model }, request, true), /identity/);
  }
  const unaffected = prepare("generate", { ...wire.generate, model: "grok-imagine-image" });
  assert.throws(() => observeXaiImage(wire.result, unaffected, true), /identity/);
  assert.equal(observeXaiImage({ ...wire.result, model: "grok-imagine-image" }, unaffected, true).servingModel, "grok-imagine-image");
});

test("frozen JSON edit references preserve bytes while raw file IDs, new modes and larger inventories stay closed", () => {
  const { image, ...rest } = wire.edit;
  const request = prepare("edit", { ...rest, images: [image, { type: "image_url", url: "https://media.example/second.png" }] });
  assert.equal(request.inputImages, 2); assert.deepEqual(request.body.images[0], image);
  for (const body of [
    { ...wire.edit, images: [image, image] }, { ...rest, images: [image, image, image, image] },
    { ...rest, image: { file_id: "foreign", type: "image_url" } },
    { ...rest, image: { type: "image_url", url: "https://user:synthetic@media.example/a.png" } },
    { ...wire.generate, deferred: true }, { ...wire.generate, response_format: "url" },
    { ...wire.generate, n: 5 }, { ...wire.generate, resolution: "4k" }, { ...wire.generate, aspect_ratio: "21:9" },
  ]) assert.throws(() => prepare(body.image || body.images ? "edit" : "generate", body));
  assert.throws(() => prepare("generate", wire.edit)); assert.throws(() => prepare("edit", wire.generate));
});

test("partial, filtered and malformed outputs cannot trigger successful delivery or a paid retry", () => {
  const request = prepare("generate", wire.generate);
  assert.throws(() => observeXaiImage(wire.result, request, false), /incomplete/);
  for (const body of [
    { ...wire.result, data: [] }, { ...wire.result, data: [wire.result.data[0], wire.result.data[0]] },
    { ...wire.result, status: "pending" }, { ...wire.result, error: {} },
    { ...wire.result, data: [{ b64_json: "Zh==" }] },
    { ...wire.result, data: [{ ...wire.result.data[0], respect_moderation: false }] },
    { ...wire.result, data: [{ url: "https://media.example/output.jpg" }] },
  ]) assert.throws(() => observeXaiImage(body, request, true));
});

test("native image reads enforce complete JSON/UTF-8 and cancellation without URL downloads", async () => {
  const request = prepare("edit", wire.edit);
  assert.equal((await readXaiImage(Response.json(wire.result), request, signal())).quality, "low");
  for (const response of [
    Response.json(wire.result, { status: 202 }), new Response(null, { status: 302 }),
    new Response(Uint8Array.of(255), { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(wire.result), { headers: { "content-type": "application/json", "content-length": "1" } }),
  ]) await assert.rejects(readXaiImage(response, request, signal()));
  const controller = new AbortController(); let canceled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { canceled = true; } });
  const pending = readXaiImage(new Response(stream, { headers: { "content-type": "application/json" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});

