import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { assertPixVerseResponseStructure, pixVerseByteStream, pixVerseInputLease, pixVerseInputLimits, pixVerseMultipart, readPixVerseBytes, readPixVerseResponseBytes } = await import("../pixverse-input-body.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const encoder = new TextEncoder(), bytes = value => encoder.encode(JSON.stringify(value));

test("PixVerse structure counts decoded strings, total nodes, properties and per-container bounds before JSON.parse", () => {
  for (const value of [{ ErrCode: 0, Resp: { video_id: 456 } }, { text: "x".repeat(65536) },
    Array(1024).fill(null), Object.fromEntries(Array.from({ length: 128 }, (_, i) => [String(i), 0])),
    Array(4).fill("x".repeat(65536))]) assert.doesNotThrow(() => assertPixVerseResponseStructure(bytes(value)));
  const deep = n => { let value = 1; while (n--) value = { child: value }; return value; };
  assert.doesNotThrow(() => assertPixVerseResponseStructure(bytes(deep(32))));
  for (const value of [deep(33), Array(1025).fill(null), { text: "x".repeat(65537) },
    { ["x".repeat(65537)]: 0 }, [...Array(4).fill("x".repeat(65536)), "x"],
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), 0])),
    Array.from({ length: 32 }, () => Array(128).fill(null))]) assert.throws(() => assertPixVerseResponseStructure(bytes(value)));
  assert.throws(() => assertPixVerseResponseStructure(encoder.encode('"' + "\\u0061".repeat(65537) + '"')));
  assert.throws(() => assertPixVerseResponseStructure(new Uint8Array([255])));
  assert.throws(() => assertPixVerseResponseStructure(encoder.encode('{"Resp":')));
  const full = new Uint8Array(pixVerseInputLimits.response).fill(32); full.set(bytes({ ErrCode: 0, Resp: { img_id: 123 } }));
  assert.doesNotThrow(() => assertPixVerseResponseStructure(full));
  assert.throws(() => assertPixVerseResponseStructure(new Uint8Array(full.length + 1)));
});

test("PixVerse segmented default reads preserve borrowed backing stores and never exceed 16 KiB", async () => {
  const image = new Uint8Array(50000).fill(71), before = image.slice();
  const source = pixVerseByteStream([Uint8Array.of(1), image, Uint8Array.of(2)]), reader = source.body.getReader();
  let used = 0, chunks = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; assert.ok(part.value.length <= 16384); used += part.value.length; chunks++; }
  await source.done; reader.releaseLock(); assert.equal(used, 50002); assert.equal(chunks, 4); assert.deepEqual(image, before);
});

test("PixVerse fixed reader reuses a BYOB window and returns a view without final copying", async () => {
  const image = new Uint8Array(50000).fill(71), operation = new HttpOperation();
  try {
    const source = pixVerseByteStream([image]), result = await readPixVerseBytes(source.body, 60000, operation);
    assert.equal(result.length, 50000); assert.equal(result.buffer.byteLength, 60000); assert.deepEqual(result, image); await source.done;
  } finally { operation.stop("complete"); }
});

test("PixVerse excess bodies, non-BYOB streams and cancellation cannot use a whole-body fallback", async () => {
  const operation = new HttpOperation();
  try {
    const source = pixVerseByteStream([new Uint8Array(16385)]);
    await assert.rejects(readPixVerseBytes(source.body, 16384, operation)); await source.done;
    let canceled = 0;
    const notBytes = new ReadableStream({ cancel() { canceled++; } });
    await assert.rejects(readPixVerseBytes(notBytes, 16384, operation)); assert.equal(canceled, 1);
    const canceledSource = pixVerseByteStream([new Uint8Array(16385)]);
    await canceledSource.body.cancel(); await canceledSource.done;
  } finally { operation.stop("complete"); }
});

test("PixVerse multipart framing is generated, bounded and byte-preserving without FormData", async () => {
  const image = Uint8Array.of(1, 2, 3), multipart = pixVerseMultipart({ bytes: image, type: "image/png" });
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=clawrouter-[0-9a-f-]{36}$/);
  assert.ok(multipart.stream.length - image.length <= 1024);
  const request = new Request("https://example.com", { method: "POST", headers: { "content-type": multipart.contentType }, body: multipart.stream.body, duplex: "half" });
  const form = await request.formData(); assert.deepEqual([...form.keys()], ["image"]);
  const file = form.get("image"); assert.equal(file.name, "input-image"); assert.equal(file.type, "image/png");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), image); await multipart.stream.done;
  assert.throws(() => pixVerseMultipart({ bytes: image, type: "image/png\r\nInjected: yes" }));
});

test("PixVerse response envelope validates exact bytes, identity and structure before codec parsing", async () => {
  const operation = new HttpOperation(), body = bytes({ ErrCode: 0, Resp: { video_id: 456 } });
  const response = headers => new Response(body, { headers: { "content-type": "application/json", ...headers } });
  try {
    assert.deepEqual(await readPixVerseResponseBytes(response({ "content-length": String(body.length) }), operation), body);
    for (const headers of [{ "content-length": "1" }, { "content-length": "bad" }, { "content-encoding": "gzip" },
      { "content-range": "bytes 0-1/2" }, { "content-type": "text/plain" }]) await assert.rejects(readPixVerseResponseBytes(response(headers), operation));
    await assert.rejects(readPixVerseResponseBytes(new Response(body, { status: 201, headers: { "content-type": "application/json" } }), operation));
    await assert.rejects(readPixVerseResponseBytes(Response.json({ text: "x".repeat(65537) }), operation));
  } finally { operation.stop("complete"); }
});

test("PixVerse public40 + owner56 reserves the entire pool before paid upload", () => {
  const baseline = bodyBudgetCharged(), ingress = pixVerseInputLease("public"), owner = pixVerseInputLease("owner");
  try {
    assert.equal(bodyBudgetCharged() - baseline, 96 * 1024 * 1024);
    assert.throws(() => pixVerseInputLease("owner"));
    const extra = new BodyLease(); assert.equal(extra.grow(1024 * 1024), false);
  } finally { owner.release(); ingress.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});
