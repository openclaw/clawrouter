import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareFalPromptVideo, observeFalPromptVideoOutput } from "../fal-prompt-video.ts";
import { managedCreateAdapter } from "../managed-lifecycle-adapters.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/prompt-video.json", import.meta.url)));
const adapter = managedCreateAdapter("fal.queue", "fal.queue_submit");
const prepare = (i, body = wire.requests[i].body, params = wire.requests[i].pathParams) => adapter.prepare(body,
  new Headers({ authorization: "Key synthetic-caller", "idempotency-key": "synthetic-replay" }), params, new URLSearchParams());
const context = (i, action) => ({ action, requestedVersion: wire.requests[i].model, pathParams: wire.requests[i].pathParams,
  ...(action === "create" ? {} : { expectedId: wire.requestId }) });
test("the registered fal adapter validates both frozen prompt-only video bodies before managed dispatch", () => {
  for (let i = 0; i < 2; i++) {
    const prepared = prepare(i);
    assert.deepEqual(prepared.body, wire.requests[i].body); assert.notEqual(prepared.body, wire.requests[i].body);
    assert.equal(prepared.requestedVersion, wire.requests[i].model); assert.deepEqual(prepared.pathParams, wire.requests[i].pathParams);
    assert.equal(prepared.headers.get("X-Fal-No-Retry"), "1"); assert.equal(prepared.headers.get("X-Fal-Request-Start-Timeout"), "600");
    assert.equal(prepared.headers.has("authorization"), false); assert.equal(prepared.headers.has("idempotency-key"), false);
    for (const key of ["image_url", "duration", "resolution", "aspect_ratio", "generate_audio", "config", "webhookUrl"]) {
      assert.throws(() => prepare(i, { ...wire.requests[i].body, [key]: "unsupported" }), /request/);
    }
  }
});
test("prompt bounds and exact model paths reject unqualified product or geometry substitutions", () => {
  assert.throws(() => prepare(0, { prompt: "x".repeat(2001) }), /prompt/);
  assert.throws(() => prepare(1, { prompt: "x".repeat(32001) }), /prompt/);
  assert.throws(() => prepare(1, { prompt: "bad\ud800" }), /unicode/);
  assert.throws(() => prepareFalPromptVideo("fal-ai/minimax/other", { prompt: "Boat" }));
  for (const params of [{ owner: "fal-ai", app: "heygen", subvariant: "video-agent" },
    { owner: "fal-ai", app: "heygen", variant: "v3", subvariant: "video-agent" },
    { ...wire.requests[1].pathParams, subvariant: "video-agent/other" }]) assert.throws(() => prepare(1, wire.requests[1].body, params));
});
test("controls retain the original create parameters while using only native owner/app roots", () => {
  for (let i = 0; i < 2; i++) for (const [action, suffix, method] of [["retrieve", "/status", "GET"], ["result", "", "GET"], ["cancel", "/cancel", "PUT"]]) {
    const endpoint = { method, path: "/${owner}/${app}/requests/${request_id}" + suffix };
    const control = adapter.control(action, endpoint, wire.requestId, wire.requests[i].pathParams);
    assert.equal(control.path, "/fal-ai/" + wire.requests[i].pathParams.app + "/requests/" + wire.requestId + suffix);
    assert.equal(control.query.size, 0); assert.equal(control.headers?.has("authorization") ?? false, false);
    assert.throws(() => adapter.control(action, endpoint, "../foreign", wire.requests[i].pathParams));
  }
});
test("partial video never completes the job; native COMPLETED still requires the original scoped result", async () => {
  const created = await adapter.read(Response.json(wire.submit, { status: 202 }), context(1, "create"));
  assert.equal(created.terminal, null); assert.equal(created.followUp, "retrieve");
  assert.equal((await adapter.read(Response.json(wire.running), context(1, "retrieve"))).terminal, null);
  const completed = await adapter.read(Response.json(wire.completed), context(1, "retrieve"));
  assert.equal(completed.terminal, null); assert.equal(completed.followUp, "result");
  const result = await adapter.read(Response.json(wire.result), context(1, "result"));
  assert.equal(result.terminal, "succeeded"); assert.equal(result.followUp, undefined);
  assert.equal(observeFalPromptVideoOutput(result.body, wire.requests[1].model).upstreamCostMicros, null);
  await assert.rejects(adapter.read(Response.json(wire.completed), { ...context(1, "retrieve"), expectedId: "other_job" }));
});
test("unusable output cannot reopen known terminal execution, request another POST or prove free generation", async () => {
  const observed = await adapter.read(Response.json({ video: {} }), context(0, "result"));
  assert.equal(observed.terminal, "succeeded"); assert.equal(observed.followUp, undefined);
  assert.throws(() => observeFalPromptVideoOutput(observed.body, wire.requests[0].model));
  assert.equal(wire.qualification.upstreamCostMicros, null);
  const failed = await adapter.read(Response.json(wire.failure, { status: 422 }), context(0, "result"));
  assert.equal(failed.terminal, "failed"); assert.equal(failed.followUp, undefined);
});
test("cancel acknowledgements preserve the native completion race and uncertain missing observations", async () => {
  const requested = await adapter.read(Response.json(wire.cancelRequested, { status: 202 }), context(1, "cancel"));
  assert.equal(requested.terminal, null); assert.equal(requested.followUp, "retrieve");
  assert.equal((await adapter.read(Response.json(wire.result), context(1, "result"))).terminal, "succeeded");
  const removed = await adapter.read(Response.json(wire.cancelRemoved), context(1, "cancel"));
  assert.equal(removed.terminal, "canceled"); assert.equal(removed.followUp, undefined);
  await assert.rejects(adapter.read(Response.json({ detail: "not found" }, { status: 404 }), context(1, "retrieve")));
});
test("video descriptors reject unsafe URL/MIME/size values and never include credential or download authority", () => {
  const output = observeFalPromptVideoOutput(wire.result, wire.requests[0].model);
  assert.equal(output.video.url, wire.result.video.url); assert.equal(output.video.headers, undefined); assert.equal(output.upstreamCostMicros, null);
  for (const changes of [{ url: "https://127.0.0.1/asset" }, { url: "https://user:synthetic@assets.example/a" },
    { url: "https://host.internal/a" }, { content_type: ["video/mp4"] }, { file_size: 256 * 1024 * 1024 + 1 }]) {
    assert.throws(() => observeFalPromptVideoOutput({ video: { ...wire.result.video, ...changes } }, wire.requests[0].model));
  }
});
test("recovery observations do not follow supplied URLs or perform I/O in the wrapper", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected wrapper I/O"); });
  const created = await adapter.read(Response.json(wire.submit), context(0, "create"));
  const rewritten = adapter.rewrite(created, { retrieve: "/v1/scoped/jobs/synthetic/status", result: "/v1/scoped/jobs/synthetic/result", cancel: "/v1/scoped/jobs/synthetic/cancel" });
  assert.equal(rewritten.status_url, "/v1/scoped/jobs/synthetic/status");
  assert.equal(rewritten.response_url, "/v1/scoped/jobs/synthetic/result");
  assert.equal((await adapter.read(Response.json(wire.completed), context(0, "retrieve"))).followUp, "result");
});
