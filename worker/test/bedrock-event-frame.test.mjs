import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { createBedrockEventStreamInspector, decodeBedrockEventFrame } from "../bedrock-eventstream.ts";
import { usageInspectionLimit } from "../token-usage.ts";
import { eventFrame } from "./bedrock-eventstream-fixture.mjs";

function frame(headers, payload = Buffer.from([0xff, 0, 0x7f])) {
  const bytes = Buffer.alloc(16 + headers.length + payload.length);
  bytes.writeUInt32BE(bytes.length); bytes.writeUInt32BE(headers.length, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  headers.copy(bytes, 12); payload.copy(bytes, 12 + headers.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  return bytes;
}
function header(name, type, value = Buffer.alloc(0)) {
  const key = Buffer.from(name);
  return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([type]), value]);
}
function sized(value) {
  const bytes = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

test("complete frame decoding validates metadata and preserves opaque payload at a nonzero byte offset", () => {
  const wire = frame(header(":event-type", 7, sized("contentBlockDelta")));
  const source = Buffer.concat([Buffer.alloc(9), wire, Buffer.alloc(5)]).subarray(9, 9 + wire.length), before = Buffer.from(source);
  const decoded = decodeBedrockEventFrame(source);
  assert.deepEqual([...decoded.headers], [[":event-type", "contentBlockDelta"]]);
  assert.deepEqual(decoded.payload, Buffer.from([0xff, 0, 0x7f]));
  assert.equal(decoded.payload.buffer, source.buffer);
  assert.deepEqual(source, before);
});

test("complete frame decoding rejects every truncated prefix and appended data", () => {
  const wire = eventFrame({ fixture: true });
  for (let length = 0; length < wire.length; length++) assert.throws(() => decodeBedrockEventFrame(wire.subarray(0, length)));
  assert.throws(() => decodeBedrockEventFrame(Buffer.concat([wire, Buffer.from([0])])));
  assert.throws(() => decodeBedrockEventFrame(Buffer.concat([wire, wire])));
});

test("prelude and message CRC failures cannot return payload", () => {
  const wire = eventFrame({ fixture: true });
  for (const index of [0, 4, 8, 12, wire.length - 5, wire.length - 1]) {
    const corrupt = Buffer.from(wire); corrupt[index] ^= 1;
    assert.throws(() => decodeBedrockEventFrame(corrupt));
  }
});

test("CRC-valid declarations still require minimum length, bounded headers and exact supplied length", () => {
  for (const [length, headers] of [[0, 0], [15, 0], [16, 1], [0xffffffff, 0], [17, 0]]) {
    const wire = frame(Buffer.alloc(0), Buffer.alloc(0));
    wire.writeUInt32BE(length); wire.writeUInt32BE(headers, 4);
    wire.writeUInt32BE(crc32(wire.subarray(0, 8)), 8);
    wire.writeUInt32BE(crc32(wire.subarray(0, -4)), wire.length - 4);
    assert.throws(() => decodeBedrockEventFrame(wire));
  }
});

test("supported header types remain accepted while only colon string metadata is exposed", () => {
  const sizes = [0, 0, 1, 2, 4, 8, null, null, 8, 16];
  const headers = sizes.map((size, type) => header(`fixture-${type}`, type, size === null ? sized("value") : Buffer.alloc(size)));
  headers.push(header(":message-type", 7, sized("event")));
  assert.deepEqual([...decodeBedrockEventFrame(frame(Buffer.concat(headers))).headers], [[":message-type", "event"]]);
});

test("duplicate metadata and ignored header names both invalidate a frame", () => {
  for (const name of [":message-type", "fixture"]) {
    const field = header(name, 7, sized("event"));
    assert.throws(() => decodeBedrockEventFrame(frame(Buffer.concat([field, field]))), /duplicate event header/);
  }
});

test("header names and colon string metadata require fatal UTF-8 decoding", () => {
  for (const headers of [header(Buffer.from([0xff]), 7, sized("value")), header(":event-type", 7, sized(Buffer.from([0xc0, 0x80])))]) {
    assert.throws(() => decodeBedrockEventFrame(frame(headers)));
  }
});

test("malformed header types, sizes, names and non-string metadata fail after valid CRCs", () => {
  for (const headers of [Buffer.from([0]), Buffer.from([8, 97]), header("fixture", 10), header(":message-type", 0),
    header("fixture", 7, Buffer.from([0])), header("fixture", 7, Buffer.from([0, 2, 97])), header("fixture", 9, Buffer.alloc(15))]) {
    assert.throws(() => decodeBedrockEventFrame(frame(headers)));
  }
});

test("frame decoding does not reinterpret modeled errors or require an Invoke JSON envelope", () => {
  for (const kind of ["exception", "error", "event"]) {
    const decoded = decodeBedrockEventFrame(frame(header(":message-type", 7, sized(kind))));
    assert.equal(decoded.headers.get(":message-type"), kind);
    assert.deepEqual(decoded.payload, Buffer.from([0xff, 0, 0x7f]));
  }
});

test("complete frame reader adds no transport cap while Invoke retains its inspection-only cap", () => {
  const wire = frame(Buffer.alloc(0), Buffer.alloc(usageInspectionLimit));
  assert.equal(decodeBedrockEventFrame(wire).payload.length, usageInspectionLimit);
  const observer = createBedrockEventStreamInspector(); observer.push(wire);
  assert.deepEqual(observer.result(), { tokens: null, outcome: null });
});
