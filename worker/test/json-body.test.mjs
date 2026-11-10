import assert from "node:assert/strict";
import test from "node:test";
import { JsonBodyStructureLimit, mediaJsonBody, parseBoundedJson, utf8Length, measurePrivateJsonBody } from "../json-body.ts";

test("private flat census returns separate malformed upper and conditional exact debits", () => {
  for (const [text, graph] of [
    ['null', 8], ['true', 8], ['-0', 8], ['1e309', 8], ['9007199254740993', 8],
    ['"😀"', 12], ['"\\ud800"', 10], ['{"x":0,"x":"q"}', 62],
    ['{"__proto__":{"x":1},"a":[true,null]}', 134],
    ['"' + 'x'.repeat(8193) + '"', 8 + 2 * 8193],
  ]) {
    assert.equal(measurePrivateJsonBody(text).exact, graph, text.slice(0, 80));
    assert.equal(measurePrivateJsonBody(text).limited, false);
    assert.ok(measurePrivateJsonBody(text).upper >= graph);
    assert.equal(measurePrivateJsonBody(' \t\r\n' + text + '\n').exact, graph);
  }
  assert.equal(Object.is(JSON.parse('-0'), -0), true);
  assert.equal(JSON.parse('1e309'), Infinity);
  assert.equal(Object.hasOwn(JSON.parse('{"__proto__":0}'), '__proto__'), true);
});

test("private flat limits preserve valid admission while native parsing owns grammar", () => {
  for (const text of [
    '['.repeat(128) + '0' + ']'.repeat(128),
    '[' + '0,'.repeat(65534) + '0]',
    '{' + '"x":0,'.repeat(65534) + '"x":0}',
    '{"' + 'k'.repeat(4096) + '":0}', '0.' + '0'.repeat(4094),
  ]) assert.equal(measurePrivateJsonBody(text).limited, false);
  for (const text of [
    '['.repeat(129) + '0' + ']'.repeat(129), '{"x":'.repeat(2048),
    '[' + '0,'.repeat(65535) + '0]', '{' + '"x":0,'.repeat(65535) + '"x":0}',
    '{"' + 'k'.repeat(4097) + '":0}', '0.' + '0'.repeat(4095),
  ]) assert.equal(measurePrivateJsonBody(text).limited, true);
  for (const text of ['', '{', '"\\u', '1e', 'true false', '[0,]', '\u00a0true', '[\u20280]', '\ufeff{}'])
    { assert.doesNotThrow(() => measurePrivateJsonBody(text)); assert.throws(() => JSON.parse(text), SyntaxError, text); }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([239, 187, 191, 123, 125]));
  assert.equal(measurePrivateJsonBody(decoded).exact, 8, 'decoder BOM behavior remains before exact-text validation');
});

for (const spelling of ['k', '\u{1f600}', '\\u006b', '\\ud83d\\ude00']) test('private decoded key boundary: ' + spelling, () => {
  const width = spelling === '😀' || spelling === '\\ud83d\\ude00' ? 2 : 1;
  const key = spelling.repeat(4096 / width);
  assert.equal(measurePrivateJsonBody('{"' + key + '":0}').limited, false);
  assert.equal(measurePrivateJsonBody('{"' + key + 'x":0}').limited, true);
  assert.equal(measurePrivateJsonBody('"' + key + 'x"').limited, false, 'value strings have no key cap');
});

test('private census does not provisionally count quoted keys as values at the node ceiling', () => {
  const valid = '{' + '"x":0,'.repeat(65534) + '"x":0}';
  assert.equal(measurePrivateJsonBody(valid).limited, false);
  assert.equal(measurePrivateJsonBody(valid.slice(0, -1) + ',"x":0}').limited, true);
  assert.equal(JSON.parse(valid).x, 0, 'discarded duplicate values still consumed the admitted count');
});

test('private malformed allocation never subtracts apparent keys or discards unfinished tokens', () => {
  for (const [wire, upper] of [['["x":0]', 50], ['{"x":', 34], ['"\\u', 20], ['[', 16], ['! ["x":0]', 66]]) {
    const measured = measurePrivateJsonBody(wire);
    assert.equal(measured.upper, upper, wire);
    assert.throws(() => JSON.parse(wire), SyntaxError);
  }
  const escaped = measurePrivateJsonBody('"\\u0061"');
  assert.equal(escaped.upper, 28); assert.equal(escaped.exact, 10);
});

test('private broad usage census does not enforce the codec verdict', () => {
  for (const wire of ['['.repeat(1025) + '0' + ']'.repeat(1025), '{"' + 'k'.repeat(4097) + '":0}']) {
    const measured = measurePrivateJsonBody(wire);
    assert.equal(measured.limited, true); assert.ok(measured.upper > 0);
    assert.doesNotThrow(() => JSON.parse(wire));
  }
});

test('near-limit escaped valid JSON fits the already-paid codec phase before exact restoration', () => {
  for (const limit of [131072, 2097152]) {
    const wire = '{"extra":"' + '\\u0061'.repeat(Math.floor((limit - 20) / 6)) + '"}';
    const measured = measurePrivateJsonBody(wire);
    assert.equal(measured.limited, false); assert.ok(wire.length <= limit);
    assert.ok(measured.upper <= (limit === 131072 ? 1572864 : 9961472));
    assert.ok(measured.exact < measured.upper); assert.equal(JSON.parse(wire).extra.length, Math.floor((limit - 20) / 6));
  }
});

test('shared allocation census preserves legacy usage separators on malformed input', () => {
  const legacy = text => {
    let c = 0, s = 0, a = 0, u = 0, quoted = false, escaped = false, atom = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (quoted) {
        if (escaped) { u++; escaped = false; }
        else if (code === 92) { u++; escaped = true; }
        else if (code === 34) quoted = false;
        else u++;
        continue;
      }
      const space = code >= 9 && code <= 13 || code === 32 || code === 160 || code === 5760
        || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
      if (code === 34) { s++; quoted = true; atom = false; }
      else if (code === 123 || code === 91) { c++; atom = false; }
      else if (code === 125 || code === 93 || code === 44 || code === 58 || space) atom = false;
      else if (!atom) { a++; atom = true; }
    }
    return 16 * (c + s + a) + 2 * u;
  };
  for (const code of [9, 10, 11, 12, 13, 32, 160, 5760, ...Array.from({ length: 11 }, (_, i) => 8192 + i), 8232, 8233, 8239, 8287, 12288, 65279]) {
    for (const wire of ['[1' + String.fromCharCode(code) + '2]', '"x"' + String.fromCharCode(code) + ':0', '{"\\u0061":1,"x":"unfinished\\u', '"\\\\\\\"\\u0061"'])
      assert.equal(measurePrivateJsonBody(wire).upper, legacy(wire), 'legacy allocation ' + code);
  }
  assert.equal(measurePrivateJsonBody('[1\u00a02]').upper, 48);
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
