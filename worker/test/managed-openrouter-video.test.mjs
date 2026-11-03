import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
import { managedFileAdapter } from "../managed-file-adapters.ts";
import { createOpenRouterVideoManagedAdapter } from "../managed-openrouter-video.ts";
const native = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/video.json", import.meta.url)));
const f = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/managed-video.json", import.meta.url)));
const adapter = managedCreateAdapter("openrouter.video", "openrouter.video_create"), files = adapter.files;
const prepare = (body, selected = adapter, headers = new Headers()) => selected.prepare(body, headers, {}, new URLSearchParams());
const context = action => ({ action, requestedVersion: native.create.model, pathParams: {}, ...(action === "create" ? {} : { expectedId: f.id }) });
const observe = body => adapter.read(Response.json(body), context("retrieve"));
const bytes = Uint8Array.from(Buffer.from(native.content.base64, "base64"));
const response = (body = bytes, headers = {}) => new Response(body, { headers: { "content-type": "video/mp4", ...headers } });

test("actual registry exposes the download-only adapter while unresolved trusted retention admission denies creates", () => {
  assert.equal(adapter.protocol, "openrouter.video"); assert.equal(files, managedFileAdapter("openrouter.video"));
  assert.equal(files.mode, "download_only"); assert.equal(files.readState, undefined);
  assert.equal(managedCreateAdapter("openrouter.video", "openai.videos"), undefined);
  assert.throws(() => prepare(native.create), /retention_admission_required/);
  for (const body of [{ ...native.create, retentionAllowed: true }, { ...native.create, provider: { zdr: false } }]) assert.throws(() => prepare(body), /retention_admission_required/);
});
test("trusted factory preparation preserves native text input but cannot authorize assets or caller secrets", () => {
  const policy = { retentionAllowed: true }, selected = createOpenRouterVideoManagedAdapter(policy);
  policy.retentionAllowed = false;
  const prepared = prepare(native.create, selected, new Headers({ authorization: "Bearer synthetic-caller", "x-api-key": "synthetic-foreign" }));
  assert.deepEqual(prepared.body, native.create); assert.notEqual(prepared.body, native.create);
  assert.equal(prepared.requestedVersion, native.create.model); assert.deepEqual(prepared.pathParams, {});
  assert.equal(prepared.headers.get("authorization"), null); assert.equal(prepared.headers.get("x-api-key"), null);
  for (const body of [native.image, { ...native.create, frame_images: [] }, { ...native.create, input_references: [] }]) assert.throws(() => prepare(body, selected), /asset_binding_required/);
  for (const body of [{ ...native.create, model: "veo-3.1-fast-generate-preview" }, { ...native.create, retentionAllowed: true }]) assert.throws(() => prepare(body, selected));
});
test("submit and original retrieve preserve terminal, expiry and cost semantics without cancellation or result controls", async () => {
  const submitted = await adapter.read(Response.json(native.accepted, { status: 202 }), context("create"));
  assert.equal(submitted.followUp, "retrieve"); assert.equal(submitted.id, f.id);
  assert.equal((await observe(native.running)).terminal, null);
  for (const [body, terminal] of [[native.completed, "succeeded"], [native.failed, "failed"], [native.cancelled, "canceled"]]) assert.equal((await observe(body)).terminal, terminal);
  const expired = await observe(native.expired); assert.equal(expired.terminal, null); assert.equal(expired.observationUnavailable, "expired_or_unknown");
  assert.equal(expired.upstreamCostMicros, null); assert.equal((await observe(native.completed)).upstreamCostMicros, null);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  const control = adapter.control("retrieve", f.retrieveEndpoint, f.id, {});
  assert.equal(control.path, "/v1/videos/" + f.id); assert.equal(control.query.size, 0);
  for (const action of ["cancel", "result"]) assert.throws(() => adapter.control(action, f.retrieveEndpoint, f.id, {}));
  await assert.rejects(adapter.read(Response.json(native.completed), { ...context("retrieve"), expectedId: "foreign_job" }));
});
test("only a succeeded original observation derives one fixed-MIME descriptor; native URLs never grant authority", async () => {
  const completed = await observe(native.completed);
  assert.deepEqual(files.describe(completed, f.base), [f.descriptor]);
  for (const body of [native.running, native.failed, native.cancelled, native.expired]) assert.deepEqual(files.describe(await observe(body), f.base), []);
  assert.deepEqual(files.describe({ ...completed, observationUnavailable: "expired_or_unknown" }, f.base), []);
  for (const base of ["https://other.example/api", "https://openrouter.ai/api/v1", "https://openrouter.ai/api?key=synthetic"]) assert.throws(() => files.describe(completed, base));
  assert.throws(() => files.describe({ ...completed, id: "foreign_job" }, f.base));
  await assert.rejects(observe({ ...native.completed, unsigned_urls: ["https://assets.example/foreign.mp4"] }));
});
test("content control derives the original job and fixed index without metadata or invented active state", () => {
  const prepared = files.control("download", f.contentEndpoint, f.descriptor, f.base);
  assert.equal(prepared.path, `/v1/videos/${f.id}/content`); assert.equal(prepared.query.toString(), "index=0");
  assert.equal(prepared.headers.get("accept"), "video/mp4"); assert.equal(prepared.headers.has("authorization"), false);
  assert.equal(files.identify("download", { video_id: f.id }, new URLSearchParams("index=0")), f.id);
  for (const query of ["", "index=1", "index=0&index=0", "index=0&api_key=synthetic"]) assert.throws(() => files.identify("download", { video_id: f.id }, new URLSearchParams(query)));
  for (const endpoint of [f.retrieveEndpoint, { ...f.contentEndpoint, method: "POST" }, { ...f.contentEndpoint, query: { index: "1" } }]) assert.throws(() => files.control("download", endpoint, f.descriptor, f.base));
  assert.throws(() => files.control("metadata", f.retrieveEndpoint, f.descriptor, f.base));
  assert.throws(() => files.control("download", f.contentEndpoint, f.descriptor, f.base, { id: f.id, status: "active", body: {} }));
  assert.throws(() => files.control("download", f.contentEndpoint, { ...f.descriptor, mimeType: "video/webm" }, f.base));
});
test("every original dispatch boundary pins public origin, native Bearer and exact create/control paths", () => {
  const selected = createOpenRouterVideoManagedAdapter({ retentionAllowed: true });
  const request = (path, method = "GET", authorization = "Bearer synthetic-original") => new Request("https://openrouter.ai/api" + path, { method, headers: { authorization, "content-type": "application/json" } });
  selected.assertDispatch(request("/v1/videos", "POST"));
  adapter.assertDispatch(request(`/v1/videos/${f.id}`)); adapter.assertDispatch(request(`/v1/videos/${f.id}/content?index=0`));
  assert.throws(() => adapter.assertDispatch(request("/v1/videos", "POST")), /create_dispatch/);
  for (const r of [request(`/v1/videos/${f.id}/content`), request(`/v1/videos/${f.id}/content?index=1`), request(`/v1/videos/${f.id}/cancel`, "POST"), request(`/v1/videos/${f.id}`, "GET", "Key synthetic"), new Request(`https://assets.example/${f.id}`, { headers: { authorization: "Bearer synthetic" } })]) assert.throws(() => selected.assertDispatch(r));
});
test("public rewriting drops bearer URLs and supplies only the original durable descriptor link", async () => {
  const observed = await observe({ ...native.completed, urls: [f.nativeSignedUrl], expires_at: "synthetic" });
  const body = adapter.rewrite(observed, { retrieve: f.paths.retrieve });
  assert.equal(body.unsigned_urls, undefined); assert.equal(body.urls, undefined); assert.equal(body.expires_at, undefined);
  const output = files.rewrite(body, [{ id: f.id, download: f.paths.download }]);
  assert.deepEqual(output.unsigned_urls, [f.paths.download]); assert.equal(output.polling_url, f.paths.retrieve);
  assert.doesNotMatch(JSON.stringify(output), /assets\.example|signed-synthetic/);
  for (const paths of [[], [{ id: "foreign_job", download: f.paths.download }], [{ id: f.id, metadata: f.paths.retrieve, download: f.paths.download }], [{ id: f.id, download: "https://assets.example/foreign" }]]) assert.throws(() => files.rewrite(body, paths));
  assert.throws(() => adapter.rewrite(observed, { retrieve: f.paths.retrieve, result: f.paths.download }));
  assert.throws(() => adapter.rewrite(observed, {}));
});
test("content remains byte-exact MP4 within the existing 16MiB envelope and cannot widen its bound", async () => {
  const chunks = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await files.readFile(response(chunks, { "content-length": String(bytes.length) }), f.descriptor, 16 * 1024 * 1024), bytes);
  for (const limit of [0, -1, 1.5, 16 * 1024 * 1024 + 1, 64 * 1024 * 1024]) await assert.rejects(files.readFile(response(), f.descriptor, limit));
  await assert.rejects(files.readFile(response(), f.descriptor, bytes.length - 1));
  const large = new Uint8Array(16 * 1024 * 1024); large[0] = 1;
  assert.equal((await files.readFile(response(large), f.descriptor, large.byteLength)).byteLength, large.byteLength);
});
test("wrong container, encoded body, partial HTTP, malformed lengths and interrupted streams never become a completed file", async () => {
  const bound = 1024;
  for (const headers of [{ "content-type": "video/webm" }, { "content-type": "application/octet-stream" }, { "content-range": "bytes 0-1/100" }, { "content-encoding": "gzip" }, { "content-length": "1" }, { "content-length": "+20" }, { "content-length": "1025" }, { "content-encoding": "identity", "content-length": "1" }]) await assert.rejects(files.readFile(response(bytes, headers), f.descriptor, bound));
  for (const status of [202, 206, 404, 500]) await assert.rejects(files.readFile(new Response(bytes, { status, headers: { "content-type": "video/mp4" } }), f.descriptor, bound));
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(files.readFile(redirected, f.descriptor, bound));
  let pulls = 0;
  const broken = new ReadableStream({ pull(controller) { if (!pulls++) controller.enqueue(bytes.subarray(0, 4)); else controller.error(new Error("synthetic interrupted file")); } });
  await assert.rejects(files.readFile(response(broken), f.descriptor, bound));
  await assert.rejects(files.readFile(response(new Uint8Array()), f.descriptor, bound));
});
test("wrappers perform no I/O and file failure cannot replay generation or alter its terminal cost", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected wrapper I/O"); });
  const observed = await observe(native.completed), before = structuredClone(observed);
  files.describe(observed, f.base); files.control("download", f.contentEndpoint, f.descriptor, f.base);
  await assert.rejects(files.readFile(response(bytes, { "content-type": "video/webm" }), f.descriptor, 1024));
  assert.deepEqual(observed, before); assert.equal(observed.terminal, "succeeded"); assert.equal(observed.upstreamCostMicros, null);
});
