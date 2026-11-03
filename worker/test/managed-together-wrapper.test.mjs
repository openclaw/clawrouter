import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { managedCreateAdapter, managedLifecycleAdapter } from "../managed-lifecycle-adapters.ts";
import { togetherManagedAdapter as adapter } from "../managed-together-wrapper.ts";
import { managedMediaEnvelopeBytes } from "../managed-media-json.ts";
const wire = JSON.parse(await readFile(new URL("../../providers/_fixtures/together/video.json", import.meta.url), "utf8"));
const context = { action: "retrieve", expectedId: wire.pending.id, requestedVersion: wire.pending.model, pathParams: {} };
const endpoint = { method: "GET", path: "/v2/videos/${video_id}" };
const request = (origin = "https://api.together.xyz", path = "/v2/videos", method = "POST", headers = {}) => new Request(origin + path, {
  method, headers: { authorization: "Bearer synthetic-together", "content-type": "application/json", ...headers },
});

test("the concrete registry selects only Together's declared create format and preserves existing protocols", () => {
  assert.equal(managedLifecycleAdapter("together.video"), adapter);
  assert.equal(managedCreateAdapter("together.video", "together.video_create"), adapter);
  for (const format of ["together.video_get", "openai.chat_completions", "dashscope.video_create"]) assert.equal(managedCreateAdapter("together.video", format), undefined);
  for (const protocol of ["replicate.predictions", "fal.queue", "kie.jobs", "vydra.jobs"]) assert.equal(managedLifecycleAdapter(protocol)?.protocol, protocol);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false); assert.equal(adapter.files, undefined);
});

test("dispatch accepts only selected Together origins, native routes and server Bearer headers without mutation", () => {
  for (const origin of ["https://api.together.xyz", "https://api.together.ai"]) for (const [path, method] of [["/v2/videos", "POST"], ["/v2/videos/video_fixture", "GET"]]) {
    const value = request(origin, path, method), before = { url: value.url, method: value.method, headers: [...value.headers] };
    assert.equal(adapter.assertDispatch(value), undefined);
    assert.deepEqual({ url: value.url, method: value.method, headers: [...value.headers] }, before); assert.equal(value.bodyUsed, false);
  }
  for (const value of [request("https://api.minimax.io"), request("https://dashscope-intl.aliyuncs.com"), request("http://api.together.xyz"),
    request("https://api.together.xyz:8443"), request(undefined, "/v2/videos?key=synthetic"), request(undefined, "/v2/videos#fragment"),
    request(undefined, "/v2/videos/video_fixture/cancel", "POST"), request(undefined, "/v2/videos/video_fixture/content", "GET"),
    request(undefined, "/v2/videos/video%2ffixture", "GET"), request(undefined, "/v2/videos", "GET"),
    request(undefined, undefined, undefined, { authorization: "Token synthetic" }), request(undefined, undefined, undefined, { authorization: "Bearer two words" }),
    request(undefined, undefined, undefined, { authorization: "" }), request(undefined, undefined, undefined, { "content-type": "text/plain" })]) assert.throws(() => adapter.assertDispatch(value), /invalid_together_managed/);
});

test("prepared native payload is isolated from caller mutation and contains no forwarded credentials", () => {
  const body = structuredClone(wire.requests[1]);
  const prepared = adapter.prepare(body, new Headers({ authorization: "Bearer synthetic-caller" }), {}, new URLSearchParams());
  assert.deepEqual(prepared.body, body); body.media.frame_images[0].input_image = "https://assets.example.com/changed.png";
  assert.deepEqual(prepared.body, wire.requests[1]); assert.deepEqual([...prepared.headers], [["content-type", "application/json"]]);
  assert.equal(prepared.requestedVersion, wire.requests[1].model); assert.deepEqual(prepared.pathParams, {});
});

test("original-job retrieve controls never accept response URLs, caller query or unsupported actions", () => {
  assert.equal(adapter.identify("retrieve", { video_id: context.expectedId }, new URLSearchParams()), context.expectedId);
  assert.deepEqual(adapter.control("retrieve", endpoint, context.expectedId, {}), { path: `/v2/videos/${context.expectedId}`, query: new URLSearchParams() });
  for (const action of ["cancel", "result"]) assert.throws(() => adapter.control(action, endpoint, context.expectedId, {}), /control_endpoint/);
  assert.throws(() => adapter.identify("retrieve", { video_id: context.expectedId }, new URLSearchParams("status_url=https://other.example")), /query/);
  assert.throws(() => adapter.control("retrieve", { ...endpoint, path: "https://other.example/${video_id}" }, context.expectedId, {}), /control_endpoint/);
});

test("ID-only create remains pending, frozen terminal states preserve identity and no output hint becomes upstream cost", async () => {
  const created = await adapter.read(Response.json({ id: context.expectedId }), { ...context, action: "create", expectedId: undefined });
  assert.equal(created.terminal, null); assert.equal(created.followUp, "retrieve");
  for (const [body, terminal] of [[wire.pending, null], [wire.completed, "succeeded"], [wire.failed, "failed"]]) {
    const observed = await adapter.read(Response.json(body), context);
    assert.equal(observed.terminal, terminal); assert.equal(observed.id, context.expectedId);
    assert.equal(observed.actualCostMicros, undefined); assert.equal(observed.upstreamCostMicros, undefined); assert.equal(observed.cost, undefined);
  }
  for (const body of [{ ...wire.completed, id: "foreign" }, { ...wire.completed, model: "minimax/hailuo-02" }, { ...wire.pending, status: "expired" }, { ...wire.pending, error: { message: "synthetic" } }, { ...wire.completed, outputs: null }]) await assert.rejects(adapter.read(Response.json(body), context), /invalid_together_video/);
});

test("native status, range, MIME and byte-length failures cannot manufacture terminal evidence", async () => {
  const json = JSON.stringify(wire.completed), length = new TextEncoder().encode(json).length;
  for (const response of [Response.json(wire.completed, { status: 202 }), Response.json(wire.completed, { status: 206 }),
    Response.json(wire.completed, { headers: { "content-range": "bytes 0-100/200" } }),
    new Response(json, { headers: { "content-type": "text/plain" } }),
    Response.json(wire.completed, { headers: { "content-length": "invalid" } }),
    new Response(json, { headers: { "content-type": "application/json", "content-length": String(length + 1) } }),
    new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
    Response.json(wire.completed, { status: 302 })]) await assert.rejects(adapter.read(response, context), /invalid_together_managed/);
  const redirected = Response.json(wire.completed); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(adapter.read(redirected, context), /invalid_together_managed/);
  assert.equal((await adapter.read(new Response(json, { headers: { "content-type": "application/json", "content-length": String(length) } }), context)).terminal, "succeeded");
});

test("oversize native delivery cancels the producer and returns no settlement observation", async () => {
  let canceled = false, pulls = 0;
  const response = new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(managedMediaEnvelopeBytes + 1)); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  await assert.rejects(adapter.read(response, context), /invalid_together_managed/);
  assert.equal(canceled, true); assert.equal(pulls, 1);
});

test("rewriting requires scoped retrieve, rejects invented actions and keeps output assets opaque", async () => {
  const observed = await adapter.read(Response.json({ ...wire.completed, urls: { get: "https://other.example/job" }, cancel_url: "https://other.example/cancel" }), context);
  for (const paths of [{}, { retrieve: "https://other.example/job" }, { retrieve: "//other.example/job" }, { retrieve: "/v1/native/together/v2/videos/video_fixture", cancel: "/cancel" }, { retrieve: "/v1/native/together/v2/videos/video_fixture", result: "/result" }]) assert.throws(() => adapter.rewrite(observed, paths), /invalid_/);
  const rewritten = adapter.rewrite(observed, { retrieve: "/v1/native/together/v2/videos/video_fixture" });
  assert.equal(rewritten.urls, undefined); assert.equal(rewritten.cancel_url, undefined);
  assert.deepEqual(rewritten.outputs, wire.completed.outputs); assert.ok(observed.body.urls);
});
