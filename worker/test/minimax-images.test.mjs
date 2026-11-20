import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareMiniMaxImage, observeMiniMaxImage, readMiniMaxImage } from "../minimax-images.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/images.json", import.meta.url)));
const signal = () => new AbortController().signal;
const prepare = body => prepareMiniMaxImage("global", body);

test("frozen image-01 generates or edits with the selected native regional product", () => {
  for (const [region, origin] of [["global", "https://api.minimax.io"], ["cn", "https://api.minimaxi.com"]]) {
    for (const body of [wire.request, wire.edit]) {
      const request = prepareMiniMaxImage(region, body);
      assert.equal(request.origin, origin); assert.equal(request.path, "/v1/image_generation"); assert.deepEqual(request.body, body);
      assert.equal(request.headers.has("authorization"), false);
    }
  }
  assert.throws(() => prepareMiniMaxImage("foreign", wire.request));
  for (const body of [{ ...wire.request, model: "image-01-live" }, { ...wire.request, n: 10 },
    { ...wire.request, prompt: "a".repeat(1501) }, { ...wire.request, response_format: "url" },
    { ...wire.request, width: 1024 }, { ...wire.request, aspect_ratio: "auto" },
    { ...wire.edit, subject_reference: [wire.edit.subject_reference[0], wire.edit.subject_reference[0]] }]) assert.throws(() => prepare(body));
});

test("subject references preserve bounded native bytes and never authorize URL fetches or file IDs", () => {
  assert.deepEqual(prepare(wire.edit).body.subject_reference, wire.edit.subject_reference);
  assert.equal(prepare({ ...wire.edit, subject_reference: [{ type: "character", image_file: "https://media.example/portrait.jpg" }] }).count, 1);
  for (const reference of [
    { type: "character", image_file: "data:image/webp;base64,AQID" },
    { type: "character", image_file: "data:image/png;base64,Zh==" },
    { type: "character", image_file: "https://user:synthetic@media.example/a.png" },
    { type: "character", file_id: "foreign" }, { type: "style", image_file: "data:image/png;base64,AQID" },
  ]) assert.throws(() => prepare({ ...wire.edit, subject_reference: [reference] }));
});

test("native success and safety counts distinguish complete, partial and filtered delivery without invented charges", () => {
  const request = prepare(wire.request);
  for (const [delivery, body] of [["complete", wire.complete], ["partial", wire.partial], ["filtered", wire.filtered]]) {
    const result = observeMiniMaxImage(body, request, true);
    assert.equal(result.delivery, delivery); assert.equal(result.successCount + result.failedCount, 2);
    assert.equal(result.images.length, Number(body.metadata.success_count)); assert.equal(result.upstreamCostMicros, null);
    assert.equal(result.body, body);
  }
  assert.deepEqual([...observeMiniMaxImage(wire.complete, request, true).images[0]], [0, 255, 128]);
  assert.equal(observeMiniMaxImage({ ...wire.complete, data: { ...wire.complete.data, image_urls: [] } }, request, true).delivery, "complete");
});

test("partial transports, HTTP-200 vendor errors and inconsistent image counts cannot fake complete output", () => {
  const request = prepare(wire.request);
  assert.throws(() => observeMiniMaxImage(wire.complete, request, false));
  for (const body of [
    { ...wire.complete, base_resp: { status_code: 2013 } }, { ...wire.complete, model: "other" },
    { ...wire.complete, metadata: { success_count: "02", failed_count: 0 } },
    { ...wire.complete, metadata: { success_count: 1, failed_count: 0 } },
    { ...wire.complete, metadata: { success_count: 2, failed_count: 1 } },
    { ...wire.complete, data: { image_base64: ["AQID", "Zh=="] } },
    { ...wire.complete, data: { ...wire.complete.data, image_urls: ["https://media.example/a.png"] } },
  ]) assert.throws(() => observeMiniMaxImage(body, request, true));
});

test("complete JSON byte reader enforces status, truncation and cancellation without POST replay", async () => {
  const request = prepare(wire.request);
  assert.equal((await readMiniMaxImage(Response.json(wire.partial), request, signal())).delivery, "partial");
  for (const response of [
    Response.json(wire.complete, { status: 202 }), new Response(null, { status: 302 }),
    new Response(Uint8Array.of(255), { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(wire.complete), { headers: { "content-type": "application/json", "content-length": "1" } }),
    Response.json(wire.complete, { headers: { "content-range": "bytes 0-1/100" } }),
  ]) await assert.rejects(readMiniMaxImage(response, request, signal()));
  let canceled = false; const controller = new AbortController();
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { canceled = true; } });
  const pending = readMiniMaxImage(new Response(stream, { headers: { "content-type": "application/json" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});

