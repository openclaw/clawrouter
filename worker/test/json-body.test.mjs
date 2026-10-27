import assert from "node:assert/strict";
import test from "node:test";
import { JsonBodyStructureLimit, mediaJsonBody, parseBoundedJson, utf8Length } from "../json-body.ts";

const encoder = new TextEncoder();
async function bytes(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

test("media splicing emits exactly JSON.stringify's bytes and restores the value", async () => {
  const image = "iVBORw0KGgo" + "A".repeat(600_000);
  const unicode = "café 🦊 \"quoted\" \\ \n\u0000  ".repeat(4000) + "\uD83E"; // lone surrogate is escaped
  const body = {
    model: "gpt-5.6", stream: true, n: 1.5, none: null, skipped: undefined,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "compare" },
      { type: "input_image", image_url: `data:image/png;base64,${image}` },
      { type: "input_image", image_url: `data:image/png;base64,${image}` },
    ] }],
    nested: [[unicode], { ["__proto__"]: image.slice(0, 70_000) }],
    // Caller text cannot forge the per-call marker.
    forged: "\u0000clawrouter-media-00000000-0000-0000-0000-000000000000-0",
  };
  const snapshot = JSON.stringify(body), media = mediaJsonBody(body);
  assert.ok(media);
  assert.equal(JSON.stringify(body), snapshot, "originals restored");
  const wire = await bytes(media.stream());
  assert.deepEqual(wire, Buffer.from(encoder.encode(snapshot)));
  assert.equal(media.bytes, wire.byteLength);
  // A stream is replayable per call: failover re-prepares a fresh one.
  assert.deepEqual(await bytes(media.stream()), wire);
});

test("media splicing declines bodies under 1 MiB of large strings and survives deep nesting", async () => {
  assert.equal(mediaJsonBody({ input: "x".repeat(65_535), list: Array.from({ length: 1000 }, (_, n) => ({ n })) }), null);
  assert.equal(mediaJsonBody({ a: "x".repeat(600_000), b: "y".repeat(400_000), small: "z".repeat(65_535).repeat(1) }), null);
  let deep = { data: "B".repeat(1_100_000) };
  for (let n = 0; n < 5_000; n++) deep = [deep];
  const media = mediaJsonBody(deep);
  assert.ok(media);
  assert.equal(media.bytes, 5_000 * 2 + encoder.encode(JSON.stringify({ data: "B".repeat(1_100_000) })).byteLength);
});

test("streamed media chunks stay bounded", async () => {
  const media = mediaJsonBody({ data: "C".repeat(5 * 1024 * 1024) });
  let largest = 0;
  for await (const chunk of media.stream()) largest = Math.max(largest, chunk.byteLength);
  assert.ok(largest <= 64 * 1024, `largest chunk ${largest}`);
});

test("utf8Length matches TextEncoder across chunk-split surrogate pairs", () => {
  for (const text of ["", "ascii", "é".repeat(5000), "a" + "🦊".repeat(9000), "x".repeat(4095) + "🦊" + "y", "\uD83E".repeat(5000)]) {
    assert.equal(utf8Length(text), encoder.encode(text).byteLength, JSON.stringify(text.slice(0, 20)));
  }
});

test("bounded parsing of a whole message matches JSON.parse and enforces structure", () => {
  const value = { text: "café 🦊 \"q\" \\ \n\u0000".repeat(3000) + "🦊", list: [1, -2.5e-3, true, null, { k: "v".repeat(5000) }], ["__proto__"]: { x: 1 } };
  const text = JSON.stringify(value);
  assert.deepEqual(parseBoundedJson(text), JSON.parse(text));
  assert.throws(() => parseBoundedJson(JSON.stringify(Array(70_000).fill(0))), JsonBodyStructureLimit);
});
