import assert from "node:assert/strict";
import test from "node:test";
import { inlineImage, uri } from "./minimax-video-inline-fixture.mjs";
import { byteBody, jsonResponse } from "./minimax-search-byte-fixture.mjs";
import { miniMaxCurrentCnInlineVideoBinding, miniMaxCurrentCnVideoBinding, miniMaxSixModelVideoBinding, miniMaxInlineVideoBinding, miniMaxVideoBinding } from "../../shared/minimax-video-binding.ts";
import { MiniMaxVideoOperation } from "../minimax-video-operation.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
import { readMiniMaxVideoInput, bindMiniMaxVideoInline, assertMiniMaxVideoInlineOwner,
  miniMaxInlineDigest, miniMaxVideoUpload, readMiniMaxInlineResponse } from "../minimax-video-inline.ts";

const MiB = 1024 * 1024, tick = () => new Promise(resolve => setImmediate(resolve));
const context = ["credential", "principal", "policy", "tenant", "minimax", "video", "minimax/MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3"];
const scalar = { model: "MiniMax-Hailuo-2.3", prompt: "Synthetic frame", duration: 6, resolution: "768P" };
function request(text, chunk = 16384) { return new Request("https://router.example/v1/native/minimax/v1/video_generation", {
  method: "POST", headers: { "content-type": "application/json" }, body: byteBody(text, chunk), duplex: "half" }); }
async function prepare(text, route = "native", chunk) {
  const req = request(text, chunk), owner = new MiniMaxVideoOperation("create", req);
  try {
    const parsed = await readMiniMaxVideoInput(req, owner, route), body = route === "manifest" ? parsed.body : parsed;
    await bindMiniMaxVideoInline(owner, body, context);
    return { owner, body, req };
  } catch (error) { await owner.finish(); throw error; }
}

for (const type of ["image/png", "image/jpeg", "image/webp"]) for (const route of ["native", "manifest"])
  test(`full8MiB ${type}/${route}: one decode, exact bytes, frozen scalars and bounded upload backing`, async () => {
    const image = inlineImage(type), body = { ...scalar, first_frame_image: uri(image, type) };
    const value = await prepare(JSON.stringify(route === "manifest" ? { body } : body), route);
    try {
      assert.equal(Object.isFrozen(value.body), true); assert.equal(Object.hasOwn(value.body, "first_frame_image"), false);
      const digest = miniMaxInlineDigest(value.owner, value.body);
      assert.equal(digest[4], image.length);
      assert.throws(() => assertMiniMaxVideoInlineOwner(value.owner, miniMaxVideoBinding("global"), context, ["key", "identity"]));
      assert.throws(() => assertMiniMaxVideoInlineOwner(value.owner, miniMaxVideoBinding("cn"), context, ["key", "identity"]));
      assertMiniMaxVideoInlineOwner(value.owner, miniMaxInlineVideoBinding(), context, ["key", "identity"]);
      assert.throws(() => assertMiniMaxVideoInlineOwner(value.owner, miniMaxInlineVideoBinding(), context, ["other", "identity"]));
      const upload = miniMaxVideoUpload(value.owner, value.body); value.owner.registerUpload(upload);
      assert.throws(() => miniMaxVideoUpload(value.owner, value.body));
      const reader = upload.body.getReader(), chunks = [];
      for (;;) { const part = await reader.read(); if (part.done) break; assert.ok(part.value.buffer.byteLength <= 16384); chunks.push(Buffer.from(part.value)); }
      reader.releaseLock(); await upload.retired;
      const sent = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(sent.first_frame_image, body.first_frame_image);
      assert.deepEqual({ ...sent, first_frame_image: undefined }, { ...body, first_frame_image: undefined });
      assert.equal(bodyBudgetCharged(), 96 * MiB);
      const competing = new BodyLease(); try { assert.equal(competing.grow(MiB), false); } finally { competing.release(); }
    } finally { await value.owner.finish(); }
    assert.equal(bodyBudgetCharged(), 0);
  });

test("raw nonimage bytes and JSON escape overhead are separate from base64 credits", async () => {
  const image = uri(inlineImage("image/png", 1024));
  const base = JSON.stringify({ ...scalar, first_frame_image: image });
  const nonimage = Buffer.byteLength(base) - image.split(",")[1].length;
  const value = await prepare(base + " ".repeat(65536 - nonimage), "native", 16); await value.owner.finish();
  await assert.rejects(prepare(base + " ".repeat(65537 - nonimage)));
  const escaped = image.replaceAll("A", "\\u0041");
  const document = JSON.stringify(scalar).slice(0, -1) + ',"first_frame_image":"' + escaped + '"}';
  const parsed = await prepare(document, "native", 1); await parsed.owner.finish();
  const maximum = uri(inlineImage("image/png", 128 * 1024)).replaceAll("A", "\\u0041");
  await assert.rejects(prepare(JSON.stringify(scalar).slice(0, -1) + ',"first_frame_image":"' + maximum + '"}'));
});

for (const mutation of [
  image => image.replace("image/png", "image/jpeg"), image => image.replace(";base64,", ";base64, "),
  image => image.slice(0, -1), () => "https://media.example/image.png", () => "data:image/png;base64,AAAA",
]) test("invalid MIME/base64/container/URL fails without a retained owner", async () => {
  await assert.rejects(prepare(JSON.stringify({ ...scalar, first_frame_image: mutation(uri(inlineImage("image/png", 1024))) })));
  assert.equal(bodyBudgetCharged(), 0);
});
test("decoded duplicate keys, wrong image slots and scalar/container mismatch deny", async () => {
  const image = JSON.stringify(uri(inlineImage("image/png", 1024)));
  for (const body of ['{"first_frame_image":' + image + ',"first_frame_\\u0069mage":' + image + '}',
    '{"nested":{"first_frame_image":' + image + '}}', '{"first_frame_image":{}}', '{"first_frame_image":null}',
    '{"model":"x","\\u006dodel":"y"}']) await assert.rejects(prepare(body));
  assert.equal(bodyBudgetCharged(), 0);
});

test("actual hash promise retains the image and charge after public cancellation", async t => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers(), hash = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "digest", async (...args) => { entered.resolve(); const result = await hash(...args); await held.promise; return result; });
  const req = request(JSON.stringify({ ...scalar, first_frame_image: uri(inlineImage("image/png", 1024)) }));
  const owner = new MiniMaxVideoOperation("create", req);
  const body = await readMiniMaxVideoInput(req, owner, "native");
  const pending = owner.operation.wait(owner.track(bindMiniMaxVideoInline(owner, body, context))); void pending.catch(() => undefined);
  await entered.promise; owner.operation.cancel(); await assert.rejects(pending);
  const finished = owner.finish(); await tick(); assert.equal(bodyBudgetCharged(), 96 * MiB);
  held.resolve(); await finished; assert.equal(bodyBudgetCharged(), 0);
});

test("primitive inline21 calls are nonrefundable: sixteen ordinary and five mandatory", async () => {
  const owner = new MiniMaxVideoOperation("create"); owner.selectInlineProfile(() => {}); let calls = 0;
  try {
    for (let i = 0; i < 21; i++) await owner.controlJson({}, async () => { calls++; return jsonResponse({ ok: true }); }, i >= 16);
    await assert.rejects(owner.controlJson({}, async () => { calls++; return jsonResponse({}); }));
    await assert.rejects(owner.controlJson({}, async () => { calls++; return jsonResponse({}); }, true));
    assert.equal(calls, 21); assert.equal(bodyBudgetCharged(), 96 * MiB);
  } finally { await owner.finish(); }
});

for (const error of [true, false]) test(`primitive provider slot joins independent upload retirement on ${error ? "rejection" : "early headers"}`, async () => {
  const owner = new MiniMaxVideoOperation("create"), held = Promise.withResolvers(); let discards = 0;
  owner.selectInlineProfile(() => {});
  owner.registerUpload({ body: new ReadableStream(), retired: held.promise, discard() { discards++; return held.promise; } });
  await owner.reserveProvider(); owner.detachAtPost();
  const fetched = owner.providerFetch(async () => { if (error) throw Error("early failure"); return new Response(null); });
  if (error) await assert.rejects(fetched); else await owner.discard(await fetched);
  const controls = await Promise.all(Array.from({ length: 3 }, () => owner.fetch(async () => jsonResponse({ ok: true }))));
  let fourth = 0;
  const queued = owner.fetch(async () => { fourth++; return jsonResponse({ ok: true }); });
  await tick(); assert.equal(fourth, 0); assert.equal(bodyBudgetCharged(), 96 * MiB); assert.equal(discards, 1);
  assert.deepEqual(await owner.controlJson({}, async () => jsonResponse({ mandatory: true }), true), { mandatory: true });
  held.resolve(); controls.push(await queued); assert.equal(fourth, 1);
  await Promise.all(controls.map(response => owner.discard(response)));
  await owner.finish(); assert.equal(bodyBudgetCharged(), 0);
});

test("inline response projection preserves rejecting evidence and int64 before complete EOF", async () => {
  for (const value of [{ task_id: "123", error: "failure", base_resp: { status_code: 0 } },
    { task_id: "123", video_url: "https://media.example/early", base_resp: { status_code: 0 } },
    { task_id: {}, base_resp: { status_code: 0 } }, { task_id: "123", base_resp: [] }]) {
    const owner = new MiniMaxVideoOperation("create");
    try { await assert.rejects(readMiniMaxInlineResponse(jsonResponse(value), owner.controlSignal, owner.registerInput)); }
    finally { await owner.finish(); }
  }
  const owner = new MiniMaxVideoOperation("create");
  try {
    const response = new Response(byteBody('{"task_id":9223372036854775807,"base_resp":{"status_code":0},"discarded":[null,{}]}', 1), { headers: { "content-type": "application/json" } });
    const value = await readMiniMaxInlineResponse(response, owner.controlSignal, owner.registerInput);
    assert.equal(value.task_id, "9223372036854775807"); assert.equal(Object.hasOwn(value, "discarded"), false); assert.equal(response.body.locked, false);
  } finally { await owner.finish(); }
});


test("inline pre-read refusal records synchronous FIRST-cancel failure and still retires the lock", async () => {
  const owner = new MiniMaxVideoOperation("create"); let reads = 0, cancels = 0, unlocked = 0;
  const source = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const get = source.getReader.bind(source);
  source.getReader = options => { const reader = get(options); return {
    read: (...args) => reader.read(...args), cancel() { cancels++; throw Error("synchronous cleanup failure"); },
    releaseLock() { reader.releaseLock(); unlocked++; },
  }; };
  try {
    await assert.rejects(readMiniMaxInlineResponse(new Response(source, { headers: { "content-type": "text/plain" } }), owner.controlSignal, owner.registerInput));
    await assert.rejects(owner.finish(), { code: "minimax_video_cleanup_failed" });
    assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(unlocked, 1); assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
  } finally { await source.cancel(); }
});


test("inline public projection remains64KiB after original-file link rewriting", async () => {
  const owner = new MiniMaxVideoOperation("create"); owner.selectInlineProfile(() => {});
  try {
    assert.throws(() => owner.publish({ x: "x".repeat(65528), video_url: "/v1/native/minimax/v1/files/retrieve_content?file_id=123" }, 200, { "content-type": "application/json" }));
  } finally { await owner.finish(); }
  assert.equal(bodyBudgetCharged(), 0);
});


test("V5 rejects absent CREATE state before the legacy no-state return", async () => {
  const owner = new MiniMaxVideoOperation("create", request("{}"));
  try {
    assert.throws(() => assertMiniMaxVideoInlineOwner(owner, miniMaxCurrentCnInlineVideoBinding(), context, ["owner"]));
    for (const binding of [miniMaxVideoBinding("global"), miniMaxVideoBinding("cn"), miniMaxInlineVideoBinding(), miniMaxSixModelVideoBinding(), miniMaxCurrentCnVideoBinding()])
      assert.doesNotThrow(() => assertMiniMaxVideoInlineOwner(owner, binding, context, ["owner"]));
  } finally { await owner.finish(); }
  assert.equal(bodyBudgetCharged(), 0);
});

test("V5 private CREATE state requires the exact CN version-region-origin-profile pair", async () => {
  const value = await prepare(JSON.stringify({ ...scalar, first_frame_image: uri(inlineImage("image/png", 1024)) }));
  const binding = miniMaxCurrentCnInlineVideoBinding();
  try {
    for (const patch of [{ region: "global" }, { origin: "https://api.minimax.io" }, { origin: "https://api.minimaxi.com" },
      { inputProfile: "url" }, { inputProfile: undefined }, { models: ["foreign"] }, { version: "clawrouter.minimax-video.v4" }])
      assert.throws(() => assertMiniMaxVideoInlineOwner(value.owner, { ...binding, ...patch }, context, ["owner"]));
    assertMiniMaxVideoInlineOwner(value.owner, binding, context, ["owner"]);
    assert.throws(() => assertMiniMaxVideoInlineOwner(value.owner, binding, [...context, "foreign"], ["owner"]));
    assert.throws(() => assertMiniMaxVideoInlineOwner(value.owner, binding, context, ["replacement"]));
  } finally { await value.owner.finish(); }
  assert.equal(bodyBudgetCharged(), 0);
});
