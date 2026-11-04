import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { jsonBodyTransport } from "../json-body.ts";

const MiB = 1024 * 1024;
function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
async function consume(transport) {
  const hash = createHash("sha256"); let bytes = 0, maximum = 0;
  for await (const chunk of transport.stream()) {
    assert.ok(chunk instanceof Uint8Array);
    assert.ok(chunk.byteLength > 0 && chunk.byteLength <= 64 * 1024);
    maximum = Math.max(maximum, chunk.byteLength); bytes += chunk.byteLength;
    hash.update(chunk);
  }
  assert.equal(bytes, transport.bytes);
  assert.equal(transport.retirement, "eof");
  return { hash: hash.digest("hex"), bytes, maximum };
}

test("frozen JSON identity and nested media strings stay unchanged through exact EOF", async () => {
  const reference = freeze({ data: "A".repeat(2 * MiB) });
  const body = freeze({ model: "fixture-model", input: [reference], enabled: true, absent: null });
  const expected = JSON.stringify(body);
  const transport = jsonBodyTransport(body, 3 * MiB);
  assert.equal(transport.retirement, null);
  const result = await consume(transport);
  assert.equal(result.hash, createHash("sha256").update(expected).digest("hex"));
  assert.equal(body.input[0], reference);
  assert.equal(JSON.stringify(body), expected);
  assert.ok(Object.isFrozen(body) && Object.isFrozen(body.input) && Object.isFrozen(reference));
  transport.discard(); transport.discard();
  assert.equal(transport.retirement, "eof");
  assert.throws(() => transport.stream(), /single-use/);
});

for (const [name, text] of [
  ["plain", "A".repeat(2 * MiB)],
  ["escaped", '\u0000\n\t"\\'.repeat(120_000)],
  ["unicode and surrogate boundaries", ("x".repeat(4095) + "🦊é\ud800\udc00\ud800Z\udc00").repeat(350)],
]) test(`bounded ${name} transport equals native JSON bytes`, async () => {
  const body = freeze({ ["key\"\n🦊"]: text, list: [1.25, -0, false, null, {}] });
  const expected = Buffer.from(JSON.stringify(body));
  const result = await consume(jsonBodyTransport(body, 8 * MiB));
  assert.equal(result.bytes, expected.byteLength);
  assert.equal(result.hash, createHash("sha256").update(expected).digest("hex"));
});

test("full 8 MiB input never asks JSON.stringify for a document or large string copy", async () => {
  const overhead = Buffer.byteLength(JSON.stringify({ data: "" }));
  const body = freeze({ data: "A".repeat(8 * MiB - overhead) });
  const expected = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const stringify = JSON.stringify;
  let largestString = 0;
  JSON.stringify = (value, ...args) => {
    assert.ok(value === null || typeof value !== "object", "no document serialization");
    if (typeof value === "string") { largestString = Math.max(largestString, value.length); assert.ok(value.length <= 4096); }
    return stringify(value, ...args);
  };
  try {
    const transport = jsonBodyTransport(body, 8 * MiB);
    const result = await consume(transport);
    assert.equal(result.bytes, 8 * MiB);
    assert.equal(result.hash, expected);
    assert.equal(largestString, 4096);
  } finally { JSON.stringify = stringify; }
});

test("HWM zero does not retire a started body before a read or partial cancellation", async () => {
  const body = freeze({ data: "A".repeat(MiB) });
  const transport = jsonBodyTransport(body, 2 * MiB), stream = transport.stream();
  await Promise.resolve();
  assert.equal(transport.retirement, null);
  assert.throws(() => transport.stream(), /single-use/);
  const reader = stream.getReader(), first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(transport.retirement, null);
  await reader.cancel(); await reader.cancel(); reader.releaseLock();
  assert.equal(transport.retirement, "cancel");
  transport.discard();
  assert.equal(transport.retirement, "cancel");
  assert.equal(body.data.length, MiB, "caller ownership is unchanged");
});

test("producer EOF can retire serializer references while final wire bytes remain readable", async () => {
  const body = freeze({ data: "small" }), transport = jsonBodyTransport(body, 100);
  const reader = transport.stream().getReader();
  const last = await reader.read();
  assert.equal(last.done, false);
  assert.equal(transport.retirement, "eof");
  assert.equal(new TextDecoder().decode(last.value), JSON.stringify(body));
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  assert.equal(body.data, "small", "retirement makes no claim about external input owners");
});

test("pre-dispatch discard retires without creating a stream and cannot be replayed", () => {
  const body = freeze({ data: "A".repeat(MiB) }), transport = jsonBodyTransport(body, 2 * MiB);
  transport.discard(); transport.discard();
  assert.equal(transport.retirement, "discard");
  assert.throws(() => transport.stream(), /single-use/);
  assert.equal(body.data.length, MiB);
});

test("cancel before the first pull retires an unstarted generator", async () => {
  const transport = jsonBodyTransport(freeze({ data: "A".repeat(MiB) }), 2 * MiB);
  await transport.stream().cancel();
  assert.equal(transport.retirement, "cancel");
  transport.discard();
  assert.throws(() => transport.stream(), /single-use/);
});

test("discard also errors an unused or partially consumed stream and remains idempotent", async () => {
  for (const partial of [false, true]) {
    const transport = jsonBodyTransport(freeze({ data: "A".repeat(MiB) }), 2 * MiB);
    const reader = transport.stream().getReader();
    if (partial) { await reader.read(); assert.equal(transport.retirement, null); }
    transport.discard(); transport.discard();
    await assert.rejects(reader.read(), /discarded/);
    reader.releaseLock();
    assert.equal(transport.retirement, "discard");
    assert.throws(() => transport.stream(), /single-use/);
  }
});

test("serialization failure retires iterator and body references without a false EOF", async () => {
  // Fault injection violates the immutable-input precondition only after sizing.
  const body = { data: "A".repeat(MiB), tail: { value: 1 } };
  const transport = jsonBodyTransport(body, 2 * MiB), reader = transport.stream().getReader();
  await reader.read();
  body.tail.value = 1n;
  await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /JSON value/);
  assert.equal(transport.retirement, "error");
  transport.discard(); reader.releaseLock();
  assert.equal(transport.retirement, "error");
  assert.throws(() => transport.stream(), /single-use/);
});

test("changed byte counts fail closed and never report complete serialization", async () => {
  for (const replacement of ["", "much longer than admitted"]) {
    const body = { text: "admitted" }, transport = jsonBodyTransport(body, 100);
    body.text = replacement; // Deliberate contract violation/fault injection.
    const reader = transport.stream().getReader();
    await assert.rejects(reader.read(), /size changed/);
    assert.equal(transport.retirement, "error");
    reader.releaseLock();
  }
});

test("bounds are exact positive safe bytes and reject oversize before exposing a handle", () => {
  for (const bound of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => jsonBodyTransport({}, bound), RangeError);
  assert.throws(() => jsonBodyTransport({ data: "abc" }, 13), /exceeds bound/);
  const transport = jsonBodyTransport(freeze({ data: "abc" }), 14);
  assert.equal(transport.bytes, 14);
  transport.discard();
});
