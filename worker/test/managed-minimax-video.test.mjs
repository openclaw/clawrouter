import { byteBody, byteResponse, jsonResponse } from "./minimax-search-byte-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { miniMaxVideoManagedAdapter as adapter } from "../managed-minimax-video.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/video.json", import.meta.url)));
const prepare = (body = wire.request, params = {}, query = new URLSearchParams()) => adapter.prepare(body, new Headers(), params, query);
const context = (action = "retrieve", extra = {}) => ({ action, requestedVersion: wire.request.model, pathParams: {},
  ...(action === "retrieve" ? { expectedId: wire.submitted.task_id } : {}), signal: new AbortController().signal, ...extra });
const response = (body, headers = {}) => byteResponse(typeof body === "string" ? body : JSON.stringify(body),
  { headers: { "content-type": "application/json", ...headers } });
const read = (body, input = context()) => adapter.read(response(body), input);
const retrieve = id => ({ retrieve: `/v1/native/minimax/v1/query/video_generation?task_id=${id}` });

test("MiniMax managed preparation is explicit T2V only and carries no credential or regional authority", () => {
  assert.equal(adapter.protocol, "minimax.video"); assert.equal(adapter.identityProbe, "1");
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  for (const model of ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-02"]) {
    for (const [duration, resolution] of [[6, "768P"], [10, "768P"], [6, "1080P"]]) {
      const body = { ...wire.request, model, duration, resolution }, result = prepare(body);
      assert.equal(result.body, body); assert.equal(result.requestedVersion, model);
      assert.deepEqual(result.pathParams, {}); assert.equal(result.headers.has("authorization"), false);
      assert.equal(result.origin, undefined);
    }
  }
  for (const model of ["MiniMax-Hailuo-2.3-Fast", "I2V-01-Director", "I2V-01-live", "I2V-01", "MiniMax-H3"]) {
    assert.throws(() => prepare({ ...wire.request, model }));
  }
  for (const first_frame_image of [undefined, null, wire.image.first_frame_image, "https://media.example/input.png"]) {
    assert.throws(() => prepare({ ...wire.request, first_frame_image }));
  }
});

test("MiniMax T2V preserves explicit frozen settings, UTF16 limits and strict request fields", () => {
  for (const prompt of ["x".repeat(2000), "🎵".repeat(1000), "\n".repeat(1999) + "x"]) {
    const body = { ...wire.request, prompt };
    assert.equal(prepare(body).body.prompt, prompt);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 16 * 1024);
  }
  for (const body of [null, [], { ...wire.request, prompt: " " }, { ...wire.request, prompt: "x".repeat(2001) },
    { ...wire.request, prompt: "\ud800" }, { ...wire.request, prompt: "\udc00" },
    { ...wire.request, callback_url: "https://media.example/callback" }, { ...wire.request, stream: true },
    { ...wire.request, duration: undefined }, { ...wire.request, resolution: undefined },
    { ...wire.request, duration: "6" }, { ...wire.request, duration: 10 }, { ...wire.request, duration: 5 },
    { ...wire.request, resolution: "512P" }]) assert.throws(() => prepare(body));
  assert.throws(() => prepare(wire.request, { task_id: "1" }));
  assert.throws(() => prepare(wire.request, {}, new URLSearchParams("model=other")));
});

test("MiniMax original task controls accept exactly one canonical int64 query identity", () => {
  const endpoint = { method: "GET", path: "/v1/query/video_generation" };
  for (const id of ["1", "9007199254740993", "9223372036854775807"]) {
    const target = adapter.control("retrieve", endpoint, id, {});
    assert.equal(target.path, endpoint.path); assert.equal(target.query.toString(), `task_id=${id}`);
    assert.equal(adapter.identify("retrieve", {}, target.query), id);
    assert.equal(target.headers, undefined);
  }
  for (const query of ["", "task_id=01", "task_id=0", "task_id=-1", "task_id=1&task_id=1", "task_id=1&file_id=2",
    "file_id=1", "task_id=9223372036854775808", "task_id=1e3", "task_id=1&url=https://media.example/"]) {
    assert.throws(() => adapter.identify("retrieve", {}, new URLSearchParams(query)));
  }
  for (const action of ["cancel", "result", "delete"]) assert.throws(() => adapter.control(action, endpoint, "1", {}));
  assert.throws(() => adapter.control("retrieve", { ...endpoint, method: "POST" }, "1", {}));
  assert.throws(() => adapter.control("retrieve", { ...endpoint, path: "/v2/tasks/1" }, "1", {}));
  assert.throws(() => adapter.control("retrieve", endpoint, "1", { region: "cn" }));
  assert.throws(() => adapter.validateId(Number.MAX_SAFE_INTEGER + 1));
});

test("MiniMax structural dispatch guard fixes origin and native paths without asserting entitlement", () => {
  for (const origin of ["https://api.minimax.io", "https://api.minimaxi.com", "https://api.minimax.cn"]) {
    adapter.assertDispatch(new Request(origin + "/v1/video_generation", { method: "POST" }));
    for (const path of ["/v1/query/video_generation?task_id=1", "/v1/files/retrieve?file_id=1", "/v1/files/retrieve_content?file_id=1"]) {
      adapter.assertDispatch(new Request(origin + path));
    }
  }
  for (const [url, method] of [["https://media.example/v1/video_generation", "POST"],
    ["https://api.minimax.io/anthropic/v1/video_generation", "POST"], ["https://api.minimax.io/v1/video_generation?region=cn", "POST"],
    ["https://api.minimax.io/v1/query/video_generation?task_id=1&task_id=2", "GET"],
    ["https://api.minimax.io/v1/files/retrieve?task_id=1", "GET"], ["https://api.minimax.io/v1/files/retrieve_content?file_id=1#other", "GET"],
    ["https://api.minimax.io/v1/query/video_generation?task_id=1", "DELETE"]]) {
    assert.throws(() => adapter.assertDispatch(new Request(url, { method })));
  }
});

test("MiniMax lifecycle reader rejects absent operation signal and invalid context before reading", async () => {
  for (const extra of [{ signal: undefined }, { signal: {} }, { requestedVersion: "MiniMax-Hailuo-2.3-Fast" },
    { action: "cancel" }, { expectedId: undefined }, { pathParams: { task_id: "1" } }]) {
    let canceled = false, pulls = 0;
    const source = new ReadableStream({ pull() { pulls++; }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    await assert.rejects(adapter.read(new Response(source, { headers: { "content-type": "application/json" } }), context("retrieve", extra)),
      { message: "invalid_managed_minimax_video_response" });
    assert.equal(canceled, true); assert.equal(pulls, 0);
  }
  await assert.rejects(read(wire.submitted, context("create", { expectedId: "1" })));
});

test("MiniMax lifecycle preserves lossless IDs, pending states and native terminal outcomes", async () => {
  const submitted = await read('{"task_id":9007199254740993,"base_resp":{"status_code":0}}', context("create"));
  assert.equal(submitted.id, wire.submitted.task_id); assert.equal(submitted.terminal, null); assert.equal(submitted.followUp, "retrieve");
  for (const status of ["Preparing", "Queueing", "Processing"]) assert.equal((await read({ ...wire.pending, status })).terminal, null);
  const succeeded = await read('{"task_id":9007199254740993,"status":"Success","file_id":9223372036854775807,"base_resp":{"status_code":0}}');
  assert.equal(succeeded.terminal, "succeeded"); assert.equal(succeeded.body.file_id, wire.success.file_id);
  for (const status_code of [0, 1026, 1027]) {
    const failed = await read({ ...wire.failed, base_resp: { status_code } });
    assert.equal(failed.terminal, "failed"); assert.equal(failed.actualCostMicros, undefined); assert.equal(failed.usage, undefined);
  }
  assert.equal(succeeded.actualCostMicros, undefined); assert.equal(succeeded.tokens, undefined);
});

test("MiniMax visibility errors and malformed terminal claims never become free or successful jobs", async () => {
  for (const body of [{ ...wire.pending, status: "UNKNOWN" }, { ...wire.pending, status: "Expired" },
    { ...wire.pending, status: "Canceled" }, { ...wire.success, task_id: "1" }, { ...wire.success, file_id: undefined },
    { ...wire.pending, file_id: "1" }, { ...wire.failed, base_resp: { status_code: 1004 } },
    { ...wire.success, error: "SYNTHETIC_DIAGNOSTIC" }, { ...wire.success, error: null },
    { ...wire.success, base_resp: { status_code: "0" } }]) {
    await assert.rejects(read(body), { message: "invalid_managed_minimax_video_response" });
  }
  for (const status of [201, 206, 302, 404, 429, 500]) {
    await assert.rejects(adapter.read(byteResponse(JSON.stringify(wire.pending), { status, headers: { "content-type": "application/json" } }), context()));
  }
});

test("MiniMax JSON requires complete UTF8 EOF, exact identity length and strict transport headers", async () => {
  const body = JSON.stringify(wire.pending), length = String(Buffer.byteLength(body));
  assert.equal((await adapter.read(response(body, { "content-encoding": "identity", "content-length": length }), context())).id, wire.pending.task_id);
  for (const headers of [{ "content-length": String(Number(length) + 1), "content-encoding": "identity" },
    { "content-length": "01" }, { "content-length": "-1" }, { "content-range": "bytes 0-5/10" },
    { "content-type": "text/html" }, { "content-type": "application/json; charset=latin1" }, { "content-encoding": "gzip" }]) {
    await assert.rejects(adapter.read(response(body, headers), context()));
  }
  const redirected = response(body); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(adapter.read(redirected, context()));
  for (const bytes of [Uint8Array.from([0xff]), new TextEncoder().encode(body.slice(0, -1))]) {
    await assert.rejects(adapter.read(byteResponse(bytes, { headers: { "content-type": "application/json" } }), context()));
  }
  let source, settled = false;
  const pending = adapter.read(new Response(new ReadableStream({ type: "bytes", start(c) { source = c; c.enqueue(new TextEncoder().encode(body)); } }),
    { headers: { "content-type": "application/json" } }), context()).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  source.close(); source.byobRequest?.respond(0); assert.equal((await pending).id, wire.pending.task_id);
});

test("MiniMax lifecycle enforces the full one-MiB envelope and bounds empty reads", async () => {
  const base = JSON.stringify({ ...wire.pending, padding: "" }), limit = 1024 * 1024;
  const exact = base + " ".repeat(limit - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(exact), limit); assert.equal((await read(exact)).id, wire.pending.task_id);
  await assert.rejects(read(exact + " "));
  let canceled = false, pulls = 0;
  const source = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array()); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  await assert.rejects(adapter.read(new Response(source, { headers: { "content-type": "application/json" } }), context()));
  assert.ok(pulls <= 8192); assert.equal(canceled, true);
});

test("MiniMax actual lifecycle signal cancels a pending source read without exposing partial output", async () => {
  const abort = new AbortController(); let canceled = false, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const source = new ReadableStream({ type: "bytes", pull() { readStarted(); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  const pending = adapter.read(new Response(source, { headers: { "content-type": "application/json" } }), context("retrieve", { signal: abort.signal }));
  await started; abort.abort(new Error("synthetic caller stop"));
  await assert.rejects(pending, { message: "invalid_managed_minimax_video_response" }); assert.equal(canceled, true);
});

test("MiniMax rewriting strips upstream URLs and requires the exact original public task link", async () => {
  const observed = await read({ ...wire.success, video_url: "https://media.example/video", download_url: "https://media.example/file",
    urls: { cancel: "https://media.example/cancel" }, status_url: "https://media.example/status" });
  const result = adapter.rewrite(observed, retrieve(observed.id));
  assert.equal(result.task_id, observed.id); assert.equal(result.file_id, wire.success.file_id);
  for (const field of ["urls", "status_url", "video_url", "download_url"]) assert.equal(result[field], undefined);
  for (const paths of [{}, { retrieve: "https://media.example/" }, retrieve("1"), { ...retrieve(observed.id), cancel: "/cancel" }]) {
    assert.throws(() => adapter.rewrite(observed, paths));
  }
  assert.throws(() => adapter.rewrite({ ...observed, id: "1" }, retrieve("1")));
});
