import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");

export const limit = 2 * 1024 * 1024, encoder = new TextEncoder();
const signal = () => new AbortController().signal;
const response = value => Response.json(value);
export const invalidResponse = error => error.status === 502 && !error.message.includes("synthetic-private");
export async function consume(native, upstream, abort = signal()) {
  const lease = native.acquire();
  try {
    const result = await native.read(upstream, abort);
    return { ...result, body: await result.response.json() };
  } finally { lease.release(); }
}
function containers(value) {
  if (!value || typeof value !== "object") return 0;
  return 1 + Object.values(value).reduce((sum, item) => sum + containers(item), 0);
}
function nested(count) { let value = "leaf"; while (count--) value = { next: value }; return value; }

export function responseCases(label, makeNative, envelope) {
  for (const [name, make] of [
    ["HTTP rejection", () => new Response("synthetic-private", { status: 403 })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://other.example" } })],
    ["redirected response", () => { const r = response(envelope()); Object.defineProperty(r, "redirected", { value: true }); return r; }],
    ["missing body", () => new Response(null, { headers: { "content-type": "application/json" } })],
    ["wrong MIME", () => new Response("synthetic-private", { headers: { "content-type": "text/html" } })],
    ["invalid charset", () => new Response("{}", { headers: { "content-type": "application/json;charset=latin1" } })],
    ["compression", () => new Response("{}", { headers: { "content-type": "application/json", "content-encoding": "gzip" } })],
    ["partial range", () => responseWith("{}", { "content-range": "bytes 0-1/100" })],
    ["malformed JSON", () => responseWith('{"synthetic-private":')],
    ["invalid UTF-8", () => responseWith(new Uint8Array([123, 34, 255, 34, 58, 49, 125]))],
    ["declared oversize", () => responseWith("{}", { "content-length": String(limit + 1) })],
    ["truncated length", () => responseWith(JSON.stringify(envelope()), { "content-length": "999999" })],
    ["trailing content", () => responseWith(JSON.stringify(envelope()) + "{}")],
  ]) test(`${label}: ${name} never releases output or invents usage`, async () => {
    const before = bodyBudgetCharged();
    await assert.rejects(consume(makeNative(), make()), invalidResponse);
    assert.equal(bodyBudgetCharged(), before);
  });

  test(`${label}: exact operational byte/depth/container bounds and native scalar values`, async () => {
    const body = { ...envelope(), padding: "" };
    body.padding = "x".repeat(limit - encoder.encode(JSON.stringify(body)).length);
    assert.equal((await consume(makeNative(), response(body))).body.padding.length, body.padding.length);
    body.padding += "x"; await assert.rejects(consume(makeNative(), response(body)), invalidResponse);
    const deep = { ...envelope(), extra: nested(63) };
    assert.deepEqual((await consume(makeNative(), response(deep))).body.extra, deep.extra);
    await assert.rejects(consume(makeNative(), response({ ...envelope(), extra: nested(64) })), invalidResponse);
    const many = { ...envelope(), extra: [] };
    many.extra = Array.from({ length: 4096 - containers(many) }, () => ({}));
    assert.equal(containers(many), 4096);
    assert.deepEqual((await consume(makeNative(), response(many))).body.extra, many.extra);
    many.extra.push({}); await assert.rejects(consume(makeNative(), response(many)), invalidResponse);
    const quoted = { ...envelope(), extra: '"\\[]{}' + "[{}]".repeat(5000) };
    assert.deepEqual((await consume(makeNative(), response(quoted))).body, quoted);
    await assert.rejects(consume(makeNative(), responseWith(JSON.stringify(envelope()).slice(0, -1) + ',"extra":1e999}')), invalidResponse);
  });

  test(`${label}: every split preserves UTF-8 and escape/structure state`, async () => {
    const body = { ...envelope(), extra: 'é 🎲 "\\[{}]' }, bytes = encoder.encode(JSON.stringify(body));
    for (let split = 1; split < bytes.length; split++) {
      const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
      const stream = new ReadableStream({ pull(c) { if (chunks.length) c.enqueue(chunks.shift()); else c.close(); } }, { highWaterMark: 0 });
      assert.deepEqual((await consume(makeNative(), responseWith(stream))).body, body);
    }
  });

  test(`${label}: all chunks including empty chunks count toward the 8192 bound`, async () => {
    for (const empty of [8191, 8192]) {
      let sent = 0, canceled = false;
      const stream = new ReadableStream({ pull(c) {
        if (sent++ < empty) c.enqueue(new Uint8Array(0));
        else if (sent === empty + 1) c.enqueue(encoder.encode(JSON.stringify(envelope())));
        else c.close();
      }, cancel() { canceled = true; } }, { highWaterMark: 0 });
      if (empty === 8191) assert.deepEqual((await consume(makeNative(), responseWith(stream))).body, envelope());
      else { await assert.rejects(consume(makeNative(), responseWith(stream)), invalidResponse); await new Promise(setImmediate); assert.equal(canceled, true); }
    }
  });

  test(`${label}: complete EOF precedes publication and caller retains the lease through delivery`, async () => {
    let controller, published = false;
    const upstream = responseWith(new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(JSON.stringify(envelope()))); } }));
    const native = makeNative(), before = bodyBudgetCharged(), lease = native.acquire();
    assert.equal(bodyBudgetCharged() - before, 64 * 1024 * 1024);
    try {
      const reading = native.read(upstream, signal()).then(value => { published = true; return value; });
      await new Promise(setImmediate); assert.equal(published, false); controller.close();
      const result = await reading;
      assert.equal(bodyBudgetCharged() - before, 64 * 1024 * 1024);
      assert.deepEqual(await result.response.json(), envelope());
      assert.equal(bodyBudgetCharged() - before, 64 * 1024 * 1024);
    } finally { lease.release(); }
    assert.equal(bodyBudgetCharged(), before);
  });

  test(`${label}: abort cancels a stalled body without publication`, async () => {
    let canceled = false;
    const abort = new AbortController(), before = bodyBudgetCharged();
    const upstream = responseWith(new ReadableStream({ start(c) { c.enqueue(encoder.encode(JSON.stringify(envelope()))); }, cancel() { canceled = true; } }));
    const reading = consume(makeNative(), upstream, abort.signal);
    await new Promise(setImmediate); abort.abort();
    await assert.rejects(reading, invalidResponse); await new Promise(setImmediate);
    assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), before);
  });

  test(`${label}: capacity refusal leaks no charge and route cannot choose another destination`, () => {
    const native = makeNative(), before = bodyBudgetCharged(), occupied = new BodyLease();
    assert.equal(occupied.grow(bodyBudgetBytes / 2), true);
    try { assert.throws(() => native.acquire(), e => e.status === 503 && e.code === "server_overloaded"); }
    finally { occupied.release(); }
    assert.equal(bodyBudgetCharged(), before);
    assert.doesNotThrow(() => assertNativeResponseDestination(native, new URL(native.origin + native.path)));
    for (const url of [native.origin + native.path + "?model=other", "https://other.example" + native.path, native.origin + "/other"])
      assert.throws(() => assertNativeResponseDestination(native, new URL(url)));
  });
}
export function responseWith(body, headers = {}) { return new Response(body, { headers: { "content-type": "application/json", ...headers } }); }
