import assert from "node:assert/strict";
import test from "node:test";
import { beginMiniMaxMusicCoverInput, claimMiniMaxMusicCoverInput, musicCoverInputLimits } from "../minimax-music-cover-input.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";

const MiB = 1024 * 1024, tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
function body(text, chunk = 256) {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new ReadableStream({ type: "bytes", pull(controller) {
    if (offset === bytes.length) { controller.close(); controller.byobRequest?.respond(0); return; }
    const end = Math.min(bytes.length, offset + chunk); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }, { highWaterMark: 0 });
}
const document = (audio = "AAA=", extra = "") => '{"audio_base64":"' + audio + '","prompt":"Synthetic style","model":"music-cover"' + extra + '}';
function begin(stream, options = {}) {
  return beginMiniMaxMusicCoverInput({ body: stream, signal: new AbortController().signal,
    deadlineAt: Date.now() + 30000, contentType: "application/json", route: "native", ...options });
}
async function denied(text, options) {
  const stream = body(text, 1), op = begin(stream, options);
  try { await assert.rejects(op.result); } finally { await op.discard(); }
  assert.equal(stream.locked, false); assert.equal(bodyBudgetCharged(), 0); assert.equal(op.snapshot().digestStarted, false);
}

test("inactive foundation hashes exact bytes, preserves model-last scalars and gives one opaque handoff", async () => {
  const stream = body(document(), 1), op = begin(stream);
  try {
    const sealed = await op.result, value = claimMiniMaxMusicCoverInput(sealed);
    assert.deepEqual(Object.keys(sealed), ["kind"]); assert.equal(Object.isFrozen(value), true);
    assert.equal(value.model, "music-cover"); assert.equal(value.bytes, 2);
    assert.equal(value.sha256, Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(2))).toString("hex"));
    assert.throws(() => claimMiniMaxMusicCoverInput(sealed), { code: "used" });
    assert.throws(() => claimMiniMaxMusicCoverInput({ kind: "minimax-cover-input.v1" }), { code: "used" });
    assert.equal(stream.locked, false); assert.equal(bodyBudgetCharged(), 96 * MiB);
    const contender = new BodyLease(); try { assert.equal(contender.grow(MiB), false); } finally { contender.release(); }
  } finally { await op.discard(); }
  assert.equal(bodyBudgetCharged(), 0); await op.discard(); assert.equal(bodyBudgetCharged(), 0);
});

test("canonical base64 padding, complete JSON, closed scalar grammar and both envelope modes", async () => {
  for (const text of [document("AB=="), document("AAB="), document("AAAA="), document("data:audio/wav;base64,AAA="),
    document("AAA=", ',"audio_base64":"AAA="'), document("AAA=", ',"audio_url":"https://example.invalid/a.wav"'),
    document("AAA=", ',"unknown":null'), document() + "x", document().replace('"music-cover"', '"music-2.6"'),
    document().replace('"prompt"', '"pr\\u006fmpt"'), document().replace('"Synthetic style"', 'true'),
    document().replace('"Synthetic style"', '"\\ud800abcdefghijk"'), document().replace('"Synthetic style"', '"short"'),
    document("AAA=", ',"lyrics":"short"'), '{"body":' + document() + ',"x":{}}']) await denied(text);
  const op = begin(body('{"body":' + document() + '}'), { route: "manifest" });
  try { assert.equal(claimMiniMaxMusicCoverInput(await op.result).bytes, 2); } finally { await op.discard(); }
});

test("escape overhead and scalar copies are bounded before hashing", async () => {
  const escaped = document("\\u0041\\u0041\\u0041=");
  const op = begin(body(escaped)); try { assert.equal(claimMiniMaxMusicCoverInput(await op.result).bytes, 2); } finally { await op.discard(); }
  await denied(document() + " ".repeat(65536));
  await denied(document("AAA=", ',"lyrics":"' + "\\u0001".repeat(1000) + '"'));
  await denied('{"audio_base64":' + "[".repeat(256));
});

test("unsupported default producer denies before read and joins its FIRST cancellation", async () => {
  let reads = 0, cancels = 0; const held = deferred();
  const stream = new ReadableStream({ pull() { reads++; }, cancel() { cancels++; return held.promise; } }, { highWaterMark: 0 });
  const op = begin(stream); await assert.rejects(op.result); await tick();
  assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(bodyBudgetCharged(), 96 * MiB);
  held.resolve(); await op.retired; assert.equal(bodyBudgetCharged(), 0);
});

for (const reject of [false, true]) test(`held read and FIRST cancellation ${reject ? "rejection" : "fulfillment"} retain independent roots`, async () => {
  const read = deferred(), cancel = deferred(), entered = deferred(), controller = new AbortController();
  const stream = body(document()), getReader = stream.getReader.bind(stream); let cancels = 0, unlocks = 0;
  stream.getReader = options => {
    const reader = getReader(options);
    return { async read(view) { try { const part = await reader.read(view); entered.resolve(); return part; } finally { await read.promise; } },
      async cancel(reason) { cancels++; await reader.cancel(reason); await cancel.promise; if (reject) throw { huge: "ignored", cause: {} }; },
      releaseLock() { unlocks++; reader.releaseLock(); } };
  };
  const op = begin(stream, { signal: controller.signal });
  try {
    await entered.promise; controller.abort(); await assert.rejects(op.result, { code: "cancelled" });
    assert.equal(cancels, 1); assert.equal(stream.locked, true); assert.equal(bodyBudgetCharged(), 96 * MiB);
    const retirement = op.discard(); void retirement.catch(() => {});
    cancel.resolve(); await tick(); assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(stream.locked, true);
    read.resolve(); if (reject) await assert.rejects(retirement, { code: "cleanup" }); else await retirement;
    assert.equal(cancels, 1); assert.equal(unlocks, 1); assert.equal(stream.locked, false); assert.equal(bodyBudgetCharged(), 0);
  } finally { read.resolve(); cancel.resolve(); await op.discard().catch(() => {}); }
});

for (const reject of [false, true]) test(`actual digest ${reject ? "failure" : "settlement"} remains owned after prompt abort`, async t => {
  const held = deferred(), entered = deferred(), controller = new AbortController(), digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "digest", async (...args) => {
    assert.equal(args[1].byteLength, 2); assert.equal(args[1].buffer.byteLength, 50_000_000);
    const value = await digest(...args); entered.resolve(); await held.promise;
    if (reject) throw { private: "not retained" }; return value;
  });
  const stream = body(document()), op = begin(stream, { signal: controller.signal });
  try {
    await entered.promise; assert.equal(stream.locked, false); controller.abort(); await assert.rejects(op.result, { code: "cancelled" });
    assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(op.snapshot().phase, "hash");
    held.resolve(); await op.retired; assert.equal(bodyBudgetCharged(), 0);
  } finally { held.resolve(); await op.discard(); }
});

test("8192 total physical reads includes empty reads and EOF; 8193 never starts", async () => {
  for (const count of [8190, 8191]) {
    const stream = body(document(), 16384), getReader = stream.getReader.bind(stream); let calls = 0;
    stream.getReader = options => { const reader = getReader(options); return {
      read(view) { calls++; return calls <= count ? Promise.resolve({ done: false, value: view.subarray(0, 0) }) : reader.read(view); },
      cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
    }; };
    const op = begin(stream);
    try { if (count === 8190) await op.result; else await assert.rejects(op.result); }
    finally { await op.discard(); }
    assert.equal(calls, 8192); assert.equal(stream.locked, false); assert.equal(bodyBudgetCharged(), 0);
  }
});

test("oversized returned backing, malformed UTF8 and public deadline keep cleanup separate", async () => {
  const stream = body(document()), getReader = stream.getReader.bind(stream);
  stream.getReader = options => { const reader = getReader(options); return {
    read: async () => ({ done: false, value: new Uint8Array(new ArrayBuffer(16385), 0, 2) }),
    cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock(),
  }; };
  const bad = begin(stream); await assert.rejects(bad.result); await bad.retired;
  const malformed = new ReadableStream({ type: "bytes", start(c) { c.enqueue(new Uint8Array([0xff])); c.close(); } });
  const utf = begin(malformed); await assert.rejects(utf.result); await utf.retired;
  const op = begin(body(document()), { deadlineAt: Date.now() + 30 }); await op.result; await op.retired;
  assert.equal(bodyBudgetCharged(), 0); assert.equal(op.snapshot().phase, "retired");
  assert.equal(musicCoverInputLimits.hashPhase + musicCoverInputLimits.slack, 96 * MiB);
  assert.equal(musicCoverInputLimits.remainder.reduce((a, b) => a + b), 655360);
});
