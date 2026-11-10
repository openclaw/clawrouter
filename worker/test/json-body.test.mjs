import assert from "node:assert/strict";
import test from "node:test";
import { JsonBodyStructureLimit, mediaJsonBody, parseBoundedJson, utf8Length, validatePrivateJsonBody } from "../json-body.ts";

test("private one-shot validation returns a scalar bound without constructing values", () => {
  for (const [text, graph] of [
    ['null', 8], ['true', 8], ['-0', 8], ['1e309', 8], ['9007199254740993', 8],
    ['"😀"', 12], ['"\\ud800"', 10], ['{"x":0,"x":"q"}', 62],
    ['{"__proto__":{"x":1},"a":[true,null]}', 134],
    ['"' + 'x'.repeat(8193) + '"', 8 + 2 * 8193],
  ]) {
    assert.equal(validatePrivateJsonBody(text), graph, text.slice(0, 80));
    assert.equal(validatePrivateJsonBody(' \t\r\n' + text + '\n'), graph);
  }
  assert.equal(Object.is(JSON.parse('-0'), -0), true);
  assert.equal(JSON.parse('1e309'), Infinity);
  assert.equal(Object.hasOwn(JSON.parse('{"__proto__":0}'), '__proto__'), true);
});

test("private validator preserves structural admission and exact grammar boundaries", () => {
  for (const text of [
    '['.repeat(128) + '0' + ']'.repeat(128),
    '[' + '0,'.repeat(65534) + '0]',
    '{' + '"x":0,'.repeat(65534) + '"x":0}',
    '{"' + 'k'.repeat(4096) + '":0}', '0.' + '0'.repeat(4094),
  ]) assert.ok(validatePrivateJsonBody(text) > 0);
  for (const text of [
    '['.repeat(129) + '0' + ']'.repeat(129), '{"x":'.repeat(2048),
    '[' + '0,'.repeat(65535) + '0]', '{' + '"x":0,'.repeat(65535) + '"x":0}',
    '{"' + 'k'.repeat(4097) + '":0}', '0.' + '0'.repeat(4095),
  ]) assert.throws(() => validatePrivateJsonBody(text), JsonBodyStructureLimit);
  for (const text of ['', '{', '"\\u', '1e', 'true false', '[0,]', '\u00a0true', '[\u20280]', '\ufeff{}'])
    assert.throws(() => validatePrivateJsonBody(text), text);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([239, 187, 191, 123, 125]));
  assert.equal(validatePrivateJsonBody(decoded), 8, 'decoder BOM behavior remains before exact-text validation');
});

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

test("media splicing declines bodies under 1 MiB of large strings and counts nested values exactly", async () => {
  assert.equal(mediaJsonBody({ input: "x".repeat(65_535), list: Array.from({ length: 1000 }, (_, n) => ({ n })) }), null);
  assert.equal(mediaJsonBody({ a: "x".repeat(600_000), b: "y".repeat(400_000), small: "z".repeat(65_535).repeat(1) }), null);
  let deep = { data: "B".repeat(1_100_000) };
  for (let n = 0; n < 1_000; n++) deep = [deep];
  const media = mediaJsonBody(deep);
  assert.ok(media);
  assert.equal(media.bytes, 1_000 * 2 + encoder.encode(JSON.stringify({ data: "B".repeat(1_100_000) })).byteLength);
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
