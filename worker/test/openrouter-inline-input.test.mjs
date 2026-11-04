import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
import { createJsonBodyParser } from "../json-body.ts";
import { HttpOperation } from "../http-operation.ts";
import { freezeInlineMusicInput, inlineMusicJsonBytes, readInlineMusicJson } from "../openrouter-music-input.ts";

const MiB = 1024 * 1024, encode = value => new TextEncoder().encode(value);
afterEach(() => assert.equal(bodyBudgetCharged(), 0));

function input(bytes, { chunk = 4096, contentLength = bytes.length, headers = {}, stall = false } = {}) {
  let offset = 0, reads = 0, canceled = false, largest = 0, atReadCharge = 0;
  const body = new ReadableStream({ type: "bytes", pull(controller) {
    reads++; atReadCharge = bodyBudgetCharged();
    if (offset === bytes.length) { if (stall) return; controller.close(); controller.byobRequest?.respond(0); return; }
    const view = controller.byobRequest.view, count = Math.min(view.byteLength, chunk, bytes.length - offset);
    new Uint8Array(view.buffer, view.byteOffset, count).set(bytes.subarray(offset, offset + count));
    offset += count; largest = Math.max(largest, count); controller.byobRequest.respond(count);
  }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  return {
    request: new Request("https://router.example/v1/native/openrouter/v1/chat/completions", { method: "POST", body, duplex: "half",
      headers: { "content-type": "application/json", ...(contentLength === null ? {} : { "content-length": String(contentLength) }), ...headers } }),
    state: () => ({ reads, canceled, largest, offset, atReadCharge }),
  };
}

test("incremental inline intake starts under the full charge and returns the exact maximum graph", async () => {
  const expected = { data: "A".repeat(inlineMusicJsonBytes - 11) }, bytes = encode(JSON.stringify(expected));
  assert.equal(bytes.length, inlineMusicJsonBytes);
  const fixture = input(bytes, { chunk: 16384 }), operation = new HttpOperation(undefined, 10000);
  const result = await readInlineMusicJson(fixture.request, operation);
  try {
    assert.deepEqual(result.value, expected);
    assert.equal(result.bytes, inlineMusicJsonBytes);
    assert.equal(bodyBudgetCharged(), 64 * MiB);
    assert.equal(fixture.state().atReadCharge, 64 * MiB);
    assert.ok(fixture.state().largest <= 16384);
    assert.equal(fixture.state().canceled, false);
  } finally { result.value = undefined; result.lease.release(); operation.stop("complete"); }
});

test("byte-zero decoding preserves escaped keys, fragmented UTF-8 and JSON parse semantics", async () => {
  const text = '{"text":"café 🦊\\n\\u0000","__proto__":{"key":true},"repeated":1,"repeated":2}';
  const fixture = input(encode(text), { chunk: 1, contentLength: null }), operation = new HttpOperation();
  const result = await readInlineMusicJson(fixture.request, operation);
  try { assert.deepEqual(result.value, JSON.parse(text)); }
  finally { result.value = undefined; result.lease.release(); operation.stop("complete"); }
});

test("ingress contention denies before the first pull without disturbing the existing owner", async () => {
  const held = new BodyLease(); assert.equal(held.grow(17 * MiB), true);
  const fixture = input(encode('{}')), operation = new HttpOperation();
  try {
    await assert.rejects(readInlineMusicJson(fixture.request, operation), error => error.code === "server_overloaded");
    assert.equal(fixture.state().reads, 0); assert.equal(fixture.state().canceled, true);
    assert.equal(bodyBudgetCharged(), 34 * MiB);
  } finally { held.release(); operation.stop("complete"); }
});

test("concurrent ordinary Chat candidates do not reserve or freeze a music graph", async () => {
  const other = new BodyLease(); assert.equal(other.grow(40 * MiB), true);
  const operations = Array.from({ length: 4 }, () => new HttpOperation());
  const results = [];
  try {
    for (const operation of operations) {
      const value = { model: "ordinary/chat", messages: Array.from({ length: 64 }, () => ({ role: "user", content: "hello" })) };
      const candidate = input(encode(JSON.stringify(value)), { contentLength: null });
      const result = await readInlineMusicJson(candidate.request, operation, true); results.push(result);
      assert.deepEqual(result.value, value); assert.equal(Object.isFrozen(result.value), false);
      assert.equal(candidate.state().atReadCharge, 80 * MiB);
      assert.equal(bodyBudgetCharged(), 80 * MiB);
    }
  } finally {
    for (const result of results) { result.value = undefined; result.lease.release(); }
    other.release(); for (const operation of operations) operation.stop("complete");
  }
});

test("ordinary Chat candidates retain the existing 32 MB limit instead of the music limit", async () => {
  const value = { text: "A".repeat(13 * MiB) }, fixture = input(encode(JSON.stringify(value)), { chunk: 16384 });
  const operation = new HttpOperation(undefined, 10000), result = await readInlineMusicJson(fixture.request, operation, true);
  try {
    assert.deepEqual(result.value, value);
    assert.equal(bodyBudgetCharged(), 2 * result.bytes);
    assert.equal(Object.isFrozen(result.value), false);
  } finally { result.value = undefined; result.lease.release(); operation.stop("complete"); }
});

test("shared Chat keeps small JSON structural acceptance and enforces the existing expanded bounds", async () => {
  const value = { ["k".repeat(5000)]: Array(70000).fill(0) };
  const operation = new HttpOperation(undefined, 10000);
  const result = await readInlineMusicJson(input(encode(JSON.stringify(value))).request, operation, true);
  try { assert.deepEqual(result.value, value); assert.equal(Object.isFrozen(result.value), false); }
  finally { result.value = undefined; result.lease.release(); operation.stop("complete"); }
  const expanded = new HttpOperation(undefined, 10000);
  try {
    const bytes = encode(JSON.stringify({ ...value, text: "A".repeat(8 * MiB) }));
    await assert.rejects(readInlineMusicJson(input(bytes, { chunk: 16384 }).request, expanded, true), error => error.status === 413);
  } finally { expanded.stop("complete"); }
});

test("shared Chat preserves the exact decimal media envelope", async () => {
  const operation = new HttpOperation();
  try {
    const fixture = input(encode('{}'), { contentLength: 32000001 });
    await assert.rejects(readInlineMusicJson(fixture.request, operation, true));
    assert.equal(fixture.state().reads, 0);
  } finally { operation.stop("complete"); }
});

for (const [name, bytes, options] of [
  ["incomplete", encode('{"data":'), {}],
  ["invalid UTF-8", Uint8Array.of(123, 34, 255, 34, 58, 49, 125), {}],
  ["BOM", Uint8Array.of(239, 187, 191, 123, 125), {}],
  ["length mismatch", encode('{}'), { contentLength: 3 }],
  ["encoded input", encode('{}'), { headers: { "content-encoding": "gzip" } }],
  ["wrong MIME", encode('{}'), { headers: { "content-type": "text/plain" } }],
  ["declared overflow", encode('{}'), { contentLength: inlineMusicJsonBytes + 1 }],
]) test(`inline intake rejects ${name} and cancels without retaining ingress capacity`, async () => {
  const fixture = input(bytes, options), operation = new HttpOperation();
  try { await assert.rejects(readInlineMusicJson(fixture.request, operation)); }
  finally { operation.stop("complete"); }
  assert.equal(bodyBudgetCharged(), 0);
});

test("operation deadline cancels the actual pending BYOB read before releasing its charge", async () => {
  let cancelCharge;
  const body = new ReadableStream({ type: "bytes", pull() {}, cancel() { cancelCharge = bodyBudgetCharged(); } }, { highWaterMark: 0 });
  const request = new Request("https://router.example", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" });
  const operation = new HttpOperation(undefined, 20);
  await assert.rejects(readInlineMusicJson(request, operation));
  assert.equal(operation.status, "timeout");
  assert.equal(cancelCharge, 64 * MiB);
  assert.equal(bodyBudgetCharged(), 0);
});

test("parser take transfers once and retires tokenizer/graph owners; discard is idempotent", () => {
  const parser = createJsonBodyParser(); parser.push('{"data":"kept"}');
  const value = parser.take(); assert.deepEqual(value, { data: "kept" });
  parser.discard(); parser.discard();
  for (const call of [() => parser.push('{}'), () => parser.end(), () => parser.take()]) assert.throws(call, /retired/);
  const broken = createJsonBodyParser(); broken.push('{"data":');
  assert.throws(() => broken.take());
  assert.throws(() => broken.push('1}'), /retired/);
  const legacy = createJsonBodyParser(); legacy.push('{"data":1}');
  assert.deepEqual(legacy.end(), { data: 1 }); legacy.discard();
});

test("freezing preserves the same bounded graph without claiming byte or asset authority", () => {
  const child = { url: "data:image/png;base64,encoding-only" }, content = [{ type: "image_url", image_url: child }];
  const body = { messages: [{ role: "user", content }] };
  freezeInlineMusicInput(body);
  assert.equal(body.messages[0].content, content); assert.equal(content[0].image_url, child);
  for (const node of [body, body.messages, body.messages[0], content, content[0], child]) assert.ok(Object.isFrozen(node));
  assert.throws(() => { child.url = "changed"; }, TypeError);
  assert.throws(() => freezeInlineMusicInput({ list: Array(33).fill("x") }));
  assert.throws(() => freezeInlineMusicInput({ value: "x".repeat(inlineMusicJsonBytes) }));
  let accessed = false;
  assert.throws(() => freezeInlineMusicInput({ get value() { accessed = true; return "value"; } }));
  assert.equal(accessed, false);
});
