import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
const { prepareNativeMiniMaxImage } = await import("../native-minimax-images.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
// Locally generated 2x2 RGBA PNG, not provider output. Full ffmpeg decode verified
// red, green, blue and white pixels (16 bytes). No image decoder runs in the Worker.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC", "base64");
const provider = { id: "minimax", base_urls: { default: "https://api.minimax.io" } };
// Candidate leaf selections do not establish native image operation authority.
const endpoint = { id: "images", method: "POST", path: "/v1/image_generation", path_params: [], query: {}, streaming: null,
  request_format: "minimax.images", response_format: "minimax.images" };
const request = { model: "image-01", prompt: "Synthetic paper boat", response_format: "base64", n: 2, aspect_ratio: "16:9" };
function selection(body = structuredClone(request)) {
  return { provider, endpoint, model: { id: "minimax/image-01", upstream: "image-01", capabilities: ["image.generate"] },
    capability: "image.generate", body, pathParams: {}, method: "POST" };
}
const native = (selected = selection()) => prepareNativeMiniMaxImage(selected);
function payload(n = 2) {
  return { base_resp: { status_code: 0, status_msg: "success" }, id: "synthetic-image-request",
    data: { image_base64: Array(n).fill(png.toString("base64")) }, metadata: { success_count: n, failed_count: 0 } };
}
const response = (body = payload(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, selected = selection(), signal = new AbortController().signal) {
  const prepared = native(selected), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("MiniMax image leaf preserves the frozen model, native JSON and generated test bytes", async () => {
  assert.equal(png.length, 75);
  assert.equal(createHash("sha256").update(png).digest("hex"), "7f2538a6e81af23e034f8ca2efc2cb5f1d7d709f502fa30bdccfebe774e4ecab");
  for (let n = 1; n <= 9; n++) {
    const selected = selection({ ...request, n }), before = structuredClone(selected), prepared = native(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, provider.base_urls.default); assert.equal(prepared.path, endpoint.path);
    for (const key of ["query", "tariff", "body", "headers"]) assert.equal(prepared[key], undefined);
    const body = payload(n), result = await read(response(body), selected);
    assert.deepEqual(await result.response.json(), body); assert.deepEqual(Buffer.from(body.data.image_base64[0], "base64"), png);
  }
});

test("MiniMax images cannot inherit speech, portal, CN, model or caller destination authority", () => {
  const prepared = native();
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of [prepared.origin + prepared.path + "?GroupId=synthetic", prepared.origin + "/v1/t2a_v2",
    "https://api.minimaxi.com" + prepared.path, "https://other.example" + prepared.path])
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  for (const change of [{ provider: { ...provider, id: "minimax-portal" } },
    { provider: { ...provider, base_urls: { default: "https://api.minimaxi.com" } } },
    { provider: { ...provider, base_urls: { default: "https://api.minimax.io/anthropic" } } },
    { model: null }, { model: { ...selection().model, upstream: "image-01-live" } },
    { model: { ...selection().model, capabilities: ["audio.speech"] } }, { capability: "audio.speech" },
    { method: "GET" }, { pathParams: { model: "image-01" } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1/t2a_v2" }, { response_format: "image.binary" },
    { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { GroupId: "synthetic" } }, { streaming: "sse" },
    { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }));
  assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format: "minimax.speech" } }), undefined);
});

test("MiniMax image input excludes every reference and preserves explicit frozen prompt options", () => {
  for (const reference of [undefined, null, [], [{ type: "character", image_file: "data:image/png;base64," + png.toString("base64") }],
    [{ type: "character", image_file: "https://media.example/owned-looking.png" }], [{ type: "character", file_id: "synthetic" }]])
    assert.throws(() => native(selection({ ...request, subject_reference: reference })));
  for (const body of [{ ...request, model: "image-01-live" }, { ...request, response_format: "url" },
    { ...request, response_format: undefined }, { ...request, n: undefined }, { ...request, n: 0 }, { ...request, n: 10 },
    { ...request, n: "2" }, { ...request, prompt: " " }, { ...request, prompt: "x".repeat(1501) },
    { ...request, prompt: "😀".repeat(751) }, { ...request, prompt: "\ud800" },
    { ...request, stream: true }, { ...request, api_key: "synthetic" }, { ...request, width: 1024 },
    { ...request, seed: 1 }, { ...request, prompt_optimizer: true }, { ...request, aspect_ratio: "auto" },
    { ...request, extra: "x".repeat(16 * 1024) }]) assert.throws(() => native(selection(body)));
  for (const aspect_ratio of ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"])
    assert.ok(native(selection({ ...request, aspect_ratio, prompt: "x".repeat(1500) })));
});

test("MiniMax images acquire 64 MiB before dispatch alongside ingress and release on exhaustion", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(8 * 1024 * 1024), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow((bodyBudgetBytes - baseline - 62 * 1024 * 1024) / 2), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { occupied.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("MiniMax preserves native count metadata and MIME absence without token, invoice or fetch authority", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected image fetch"); });
  const body = payload(); body.model = "image-01"; body.metadata = { success_count: "2", failed_count: "0", synthetic_observation: 42 };
  const result = await read(response(body, { "x-private-upstream": "synthetic", "set-cookie": "synthetic" }));
  assert.deepEqual(await result.response.json(), body); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.response.headers.get("content-type"), "application/json");
  assert.equal(result.response.headers.get("cache-control"), "no-store"); assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.response.headers.get("x-private-upstream"), null); assert.equal(result.response.headers.get("set-cookie"), null);
  assert.equal(Object.hasOwn(body.data, "mime_type"), false); assert.equal(Object.hasOwn(body.data, "mimeType"), false);
  assert.equal(fetch.mock.callCount(), 0);
});

test("MiniMax withholds partial, filtered, error and inconsistent result envelopes atomically", async () => {
  for (const change of [b => { b.base_resp.status_code = 2013; }, b => { delete b.base_resp; }, b => { b.error = null; },
    b => { b.model = "image-01-live"; }, b => { b.model = null; }, b => { b.data = null; },
    b => { b.metadata.success_count = "02"; }, b => { b.metadata.failed_count = 1; },
    b => { b.metadata.success_count = 1; }, b => { b.data.image_base64.push(png.toString("base64")); },
    b => { b.data.image_base64.pop(); b.metadata = { success_count: 1, failed_count: 1 }; },
    b => { b.data.image_base64 = []; b.metadata = { success_count: 0, failed_count: 2 }; }]) {
    const body = payload(); change(body); await assert.rejects(read(response(body)), /invalid_native_minimax_image_response/);
  }
  for (const image_urls of [null, [], ["https://media.example/result.png"]]) {
    const body = payload(); body.data.image_urls = image_urls;
    await assert.rejects(read(response(body)));
  }
});

test("MiniMax validates every canonical base64 item before exposing earlier valid images", async () => {
  for (const value of ["", "AP-A", "AQID\n", "Zh==", "AQI", 42, null, "https://media.example/result.png", "data:image/png;base64,AQID"]) {
    const body = payload(); body.data.image_base64[1] = value; await assert.rejects(read(response(body)));
  }
});

test("MiniMax bounds combined decoded bytes before allocation and complete JSON before delivery", async () => {
  const limit = 4 * 1024 * 1024, jsonLimit = 8 * 1024 * 1024;
  // Allocation-only base64 values are not claimed as decodable image containers.
  const body = payload(); body.data.image_base64 = [Buffer.alloc(limit / 2).toString("base64"), Buffer.alloc(limit / 2).toString("base64")];
  assert.deepEqual(await (await read(response(body))).response.json(), body);
  body.data.image_base64[1] = Buffer.alloc(limit / 2 + 1).toString("base64"); await assert.rejects(read(response(body)));
  body.data.image_base64 = [Buffer.alloc(limit + 1).toString("base64")]; body.metadata.success_count = 1;
  await assert.rejects(read(response(body), selection({ ...request, n: 1 })));
  const text = JSON.stringify(payload()), exact = text + " ".repeat(jsonLimit - Buffer.byteLength(text)), headers = { "content-type": "application/json" };
  assert.deepEqual(await (await read(new Response(exact, { headers }))).response.json(), payload());
  await assert.rejects(read(new Response(exact + " ", { headers })));
  await assert.rejects(read(response(undefined, { "content-length": String(jsonLimit + 1) })));
});

test("MiniMax image JSON requires complete HTTP200 UTF-8 with exact identity lengths", async () => {
  for (const headers of [{ "content-type": "image/png" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": "application/json; charset=\"utf-8" }, { "content-range": "bytes 0-1/10" }, { "content-encoding": "gzip" },
    { "content-length": "-1" }, { "content-length": "bad" }, { "content-length": "1.5" }, { "content-length": "1" }])
    await assert.rejects(read(response(undefined, headers)));
  for (const status of [201, 206, 302, 422, 500]) await assert.rejects(read(response(undefined, {}, status)));
  for (const headers of [{}, { "content-encoding": "identity" }]) {
    const redirected = response(undefined, headers); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  }
  const text = JSON.stringify(payload()), headers = { "content-type": "application/json; charset=\"UTF-8\"", "content-encoding": "identity" };
  assert.deepEqual(await (await read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text)) } }))).response.json(), payload());
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text) + 1) } })));
});

test("MiniMax images wait for EOF and reject truncated, invalid UTF-8 and interrupted JSON", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload())), headers = { "content-type": "application/json" }; let controller, settled = false;
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers });
  const pending = read(upstream).then(result => { settled = true; return result; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await (await pending).response.json(), payload());
  await assert.rejects(read(new Response(bytes.subarray(0, -1), { headers })));
  await assert.rejects(read(new Response(new Uint8Array([0xff]), { headers })));
  const broken = new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_minimax_image_response" });
});

test("MiniMax image abort and deadline cancel stalled reads without output or leaked capacity", async () => {
  for (const name of ["AbortError", "TimeoutError"]) for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort(new DOMException("synthetic", name));
    const stream = new ReadableStream({ cancel() { canceled = true; } });
    const pending = read(new Response(stream, { headers: { "content-type": "application/json" } }), selection(), abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(new DOMException("synthetic", name)); }
    await assert.rejects(pending); assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});
