import { byteBody, byteResponse, jsonResponse } from "./minimax-search-byte-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
import { miniMaxVideoFileAdapter as files } from "../managed-minimax-video-files.ts";
import { observeMiniMaxVideo } from "../minimax-video.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/video.json", import.meta.url)));
const file = { id: wire.success.file_id, mimeType: "video/mp4" };
const state = { id: file.id, status: "active", body: { file: { file_id: file.id, purpose: "video_generation", bytes: 16 }, base_resp: { status_code: 0 } } };
const endpoint = action => ({ method: "GET", path: `/v1/files/${action === "metadata" ? "retrieve" : "retrieve_content"}`, query: {} });
const observed = body => observeMiniMaxVideo(body, "retrieve", wire.submitted.task_id);
// Existing synthetic ftyp header: structural validation ONLY, not playable video.
const mp4 = () => Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
// Normalize Buffer to a view so the producer's bounded slice copies each chunk.
// Buffer.slice otherwise shares and enqueue detaches the still-owned source.
const boundedBody = bytes => byteBody(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const content = (bytes = mp4(), headers = {}) => new Response(bytes instanceof ReadableStream ? bytes : boundedBody(bytes), { headers: { "content-type": "video/mp4", ...headers } });
const paths = [{ id: file.id, metadata: `/v1/native/minimax/v1/files/retrieve?file_id=${file.id}`,
  download: `/v1/native/minimax/v1/files/retrieve_content?file_id=${file.id}` }];

test("MiniMax file descriptors require successful matching task provenance and an exact regional origin", () => {
  for (const origin of ["https://api.minimax.io", "https://api.minimaxi.com"]) assert.deepEqual(files.describe(observed(wire.success), origin), [file]);
  for (const body of [wire.pending, wire.failed]) assert.deepEqual(files.describe(observed(body), "https://api.minimax.io"), []);
  assert.deepEqual(files.describe({ ...observed(wire.success), observationUnavailable: "expired_or_unknown" }, "https://api.minimax.io"), []);
  assert.throws(() => files.describe({ ...observed(wire.success), id: "1" }, "https://api.minimax.io"));
  for (const origin of ["https://api.minimax.io/", "https://api.minimax.io/anthropic", "https://media.example", "http://api.minimax.io"]) {
    assert.throws(() => files.describe(observed(wire.success), origin));
  }
});

test("MiniMax file identities reject duplicates, task substitution and lossy int64 selectors", () => {
  for (const action of ["metadata", "download"]) {
    assert.equal(files.identify(action, {}, new URLSearchParams({ file_id: file.id })), file.id);
    for (const query of ["file_id=1&file_id=1", "file_id=1&task_id=2", "task_id=1", "file_id=01", "file_id=0",
      "file_id=1.0", "file_id=9223372036854775808", "file_id=1&url=https://media.example/"]) {
      assert.throws(() => files.identify(action, {}, new URLSearchParams(query)));
    }
    assert.throws(() => files.identify(action, { file_id: "1" }, new URLSearchParams({ file_id: file.id })));
  }
  assert.throws(() => files.identify("delete", {}, new URLSearchParams({ file_id: file.id })));
});

test("MiniMax public links and controls stay relative, exact and free of credential headers", () => {
  for (const action of ["metadata", "download"]) {
    const link = files.publicControl(action, endpoint(action), file);
    assert.equal(link.path, endpoint(action).path); assert.equal(link.query.toString(), `file_id=${file.id}`);
    assert.deepEqual(Object.keys(link).sort(), ["path", "query"]);
    for (const origin of ["https://api.minimax.io", "https://api.minimaxi.com"]) {
      assert.deepEqual(files.control(action, endpoint(action), file, origin, state), link);
    }
    for (const changed of [{ ...endpoint(action), method: "POST" }, { ...endpoint(action), path: "/v1/other" },
      { ...endpoint(action), query: { file_id: "1" } }, { ...endpoint(action), query: { region: "cn" } }]) {
      assert.throws(() => files.publicControl(action, changed, file));
    }
  }
  for (const invalid of [undefined, { ...state, id: "1" }, { ...state, status: "processing" }, { ...state, status: "failed" },
    { ...state, body: {} }, { ...state, body: { ...state.body, file: { ...state.body.file, bytes: 16 * 1024 * 1024 + 1 } } }]) {
    assert.throws(() => files.control("download", endpoint("download"), file, "https://api.minimax.io", invalid));
  }
  assert.throws(() => files.control("download", endpoint("download"), file, "https://media.example", state));
  assert.throws(() => files.publicControl("download", endpoint("download"), { ...file, url: "https://media.example" }));
  assert.throws(() => files.publicControl("download", endpoint("download"), { ...file, mimeType: "application/json" }));
});

test("MiniMax metadata matches the original file and projects no native URL or unrelated metadata", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("file metadata must never fetch an output URL"));
  const result = await files.readState(jsonResponse({ ...wire.file, extra_url: "https://media.example/other",
    file: { ...wire.file.file, url: "https://media.example/other", credentials: "SYNTHETIC_NOT_A_KEY" } }), file);
  assert.deepEqual(result, { id: file.id, status: "active", body: { file: { file_id: file.id, purpose: "video_generation", bytes: 16 }, base_resp: { status_code: 0 } } });
  for (const body of [{ ...wire.file, error: null }, { ...wire.file, error: "SYNTHETIC_DIAGNOSTIC" },
    { ...wire.file, base_resp: { status_code: 1004 } }, { ...wire.file, file: { ...wire.file.file, purpose: "input" } },
    { ...wire.file, file: { ...wire.file.file, file_id: "1" } }, { ...wire.file, file: { ...wire.file.file, bytes: -1 } }]) {
    await assert.rejects(files.readState(jsonResponse(body), file), { message: "invalid_managed_minimax_file_response" });
  }
  const lossless = `{"file":{"file_id":${file.id},"purpose":"video_generation"},"base_resp":{"status_code":0}}`;
  assert.equal((await files.readState(byteResponse(lossless, { headers: { "content-type": "application/json" } }), file)).id, file.id);
  assert.equal(fetch.mock.callCount(), 0);
});

test("MiniMax metadata has a separate complete 64KiB envelope and exact identity-encoding length", async () => {
  const base = JSON.stringify({ ...wire.file, padding: "" });
  const exact = JSON.stringify({ ...wire.file, padding: "x".repeat(64 * 1024 - Buffer.byteLength(base)) });
  const make = (body, length) => byteResponse(body, { headers: { "content-type": "application/json", "content-encoding": "identity", "content-length": String(length) } });
  assert.equal((await files.readState(make(exact, 64 * 1024), file)).id, file.id);
  await assert.rejects(files.readState(make(exact + " ", 64 * 1024 + 1), file));
  await assert.rejects(files.readState(make(exact, 64 * 1024 - 1), file));
  await assert.rejects(files.readState(byteResponse(Uint8Array.from([0xff]), { headers: { "content-type": "application/json" } }), file));
});

test("MiniMax JSON-labelled file content must contain a valid MP4 header, never a JSON error", async () => {
  assert.deepEqual(files.downloadMimeTypes, ["video/mp4", "application/octet-stream", "application/json"]);
  assert.equal(Object.isFrozen(files.downloadMimeTypes), true);
  for (const mime of files.downloadMimeTypes) {
    const bytes = await files.readFile(content(mp4(), { "content-type": mime }), file, 16 * 1024 * 1024);
    assert.deepEqual(bytes, mp4());
  }
  for (const body of [{ error: "SYNTHETIC_DIAGNOSTIC" }, { base_resp: { status_code: 1004 } }, { base_resp: { status_code: 0 } }]) {
    await assert.rejects(files.readFile(jsonResponse(body), file, 1024), { message: "invalid_managed_minimax_file_response" });
  }
  for (const bytes of [new Uint8Array(), mp4().slice(0, 15), Uint8Array.from([0, 0, 0, 8, ...mp4().slice(4)]),
    Uint8Array.from([0, 0, 0, 17, ...mp4().slice(4)]), new TextEncoder().encode("<html>not video</html>")]) {
    await assert.rejects(files.readFile(content(bytes), file, 1024));
  }
});

test("MiniMax files reject ranges, redirects, encodings and identity length mismatches", async () => {
  assert.deepEqual(await files.readFile(content(mp4(), { "content-encoding": "identity", "content-length": "16" }), file, 1024), mp4());
  for (const headers of [{ "content-encoding": "gzip" }, { "content-encoding": "br" }, { "content-length": "17", "content-encoding": "identity" },
    { "content-length": "15" }, { "content-length": "16, 16" }, { "content-range": "bytes 0-15/16" },
    { "content-type": "text/html" }, { "content-type": "application/json; charset=latin1" }]) {
    await assert.rejects(files.readFile(content(mp4(), headers), file, 1024));
  }
  for (const status of [201, 206, 302, 404, 500]) await assert.rejects(files.readFile(byteResponse(mp4(), { status,
    headers: { "content-type": "video/mp4" } }), file, 1024));
  const redirected = content(); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(files.readFile(redirected, file, 1024));
  for (const limit of [0, 15, 1.5, Infinity, 16 * 1024 * 1024 + 1]) await assert.rejects(files.readFile(content(), file, limit));
});

test("MiniMax full file envelope is 16MiB and bounded views preserve original bytes", async () => {
  const limit = 16 * 1024 * 1024, bytes = new Uint8Array(limit); bytes.set(mp4()); new DataView(bytes.buffer).setUint32(16, limit - 16); bytes.set(new TextEncoder().encode("mdat"), 20);
  assert.deepEqual(await files.readFile(content(bytes), file, limit), bytes);
  await assert.rejects(files.readFile(content(new Uint8Array(limit + 1)), file, limit));
  for (const backing of [new Uint8Array(4096), Buffer.alloc(4096)]) {
    backing.set(mp4(), 128);
    assert.deepEqual(await files.readFile(content(backing.subarray(128, 144)), file, 1024), mp4());
    const source = boundedBody(backing.subarray(128, 144));
    const result = await files.readFile(content(source), file, 1024);
    assert.equal(result.byteOffset, 0); assert.equal(result.buffer.byteLength, 1024);
    assert.deepEqual(result, mp4()); assert.equal(source.locked, false);
  }
});

test("MiniMax files withhold partial output until EOF and propagate common transport cancellation", async () => {
  let controller, done = false;
  const source = new ReadableStream({ type: "bytes", start(c) { controller = c; c.enqueue(mp4()); } });
  const pending = files.readFile(content(source), file, 1024).then(bytes => { done = true; return bytes; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  controller.close(); controller.byobRequest?.respond(0); assert.deepEqual(await pending, mp4());

  let failedSource, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const canceled = files.readFile(content(new ReadableStream({ type: "bytes", start(c) { failedSource = c; }, pull() { readStarted(); } }, { highWaterMark: 0 })), file, 1024);
  await started;
  // Models the error delivered by common boundedFileResponse after it cancels
  // its original reader. This is not a physical client-disconnect claim.
  failedSource.error(new Error("synthetic operation cancellation"));
  await assert.rejects(canceled, { message: "invalid_managed_minimax_file_response" });
});

test("MiniMax file parsing errors cancel the actual bounded source without replay", async () => {
  let canceled = false, pulls = 0;
  const source = new ReadableStream({ type: "bytes", pull(c) { pulls++; c.enqueue(new Uint8Array(17)); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  await assert.rejects(files.readFile(content(source), file, 16));
  assert.equal(pulls, 1); assert.equal(canceled, true);
});

test("MiniMax output links require the bound file and cannot promote response URLs", () => {
  const result = files.rewrite({ ...wire.success, video_url: "https://media.example/video", download_url: "https://media.example/file",
    urls: { content: "https://media.example/other" } }, paths);
  assert.equal(result.video_url, paths[0].download); assert.equal(result.download_url, undefined); assert.equal(result.urls, undefined);
  assert.equal(files.rewrite({ ...wire.pending, video_url: "https://media.example/early" }, []).video_url, undefined);
  for (const invalid of [[], [...paths, ...paths], [{ ...paths[0], id: "1" }], [{ ...paths[0], metadata: undefined }],
    [{ ...paths[0], download: "https://media.example/foreign" }], [{ ...paths[0], download: paths[0].download + "&file_id=1" }]]) {
    assert.throws(() => files.rewrite(wire.success, invalid));
  }
  assert.throws(() => files.rewrite(wire.failed, paths));
});

test("MiniMax file leaf leaves the existing caller-owned 32MiB capacity charge held through delivery", async () => {
  assert.equal(bodyBudgetCharged(), 0);
  const leases = [new BodyLease(), new BodyLease(), new BodyLease()], denied = new BodyLease();
  try {
    for (const lease of leases) assert.equal(lease.grow(16 * 1024 * 1024), true);
    assert.equal(bodyBudgetCharged(), 96 * 1024 * 1024); assert.equal(denied.grow(16 * 1024 * 1024), false);
    const bytes = await files.readFile(content(), file, 16 * 1024 * 1024);
    assert.deepEqual(bytes, mp4()); assert.equal(bodyBudgetCharged(), 96 * 1024 * 1024);
    await assert.rejects(files.readFile(jsonResponse({ error: "synthetic" }), file, 1024));
    assert.equal(bodyBudgetCharged(), 96 * 1024 * 1024);
    // The existing common delivery owner, not the pure adapter, releases this
    // lease on EOF/cancel. Actual routed lifecycle proof remains source1/6 work.
    leases[0].release(); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  } finally { for (const lease of leases) lease.release(); denied.release(); }
  assert.equal(bodyBudgetCharged(), 0);
});
