import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { wanManagedAdapter as adapter, wanModels, assertWanStandardCredential } from "../managed-wan.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/wan/lifecycle.json", import.meta.url), "utf8"));
const id = wire.create.response.output.task_id;
const context = { action: "retrieve", expectedId: id, requestedVersion: "wan2.6-t2v", pathParams: {} };
const prepare = body => adapter.prepare(body, new Headers({ authorization: "Bearer synthetic-caller" }), {}, new URLSearchParams());
const observe = output => adapter.read(Response.json({ output: { task_id: id, ...output } }), context);

test("Wan prepares only frozen model inputs and owns non-secret async headers", () => {
  assert.equal(wanModels.length, 5);
  const body = structuredClone(wire.create.body), result = prepare(body);
  assert.equal(result.body, body);
  assert.equal(result.requestedVersion, "wan2.6-t2v");
  assert.equal(result.headers.get("x-dashscope-async"), "enable");
  assert.equal(result.headers.get("authorization"), null);
  assert.throws(() => prepare({ ...body, model: "wan3.0-t2v" }), /invalid_wan_create/);
  assert.throws(() => prepare({ ...body, callback: "https://callback.example" }));
  assert.throws(() => prepare({ ...body, parameters: { duration: 16 } }));
  assert.throws(() => prepare({ ...body, parameters: { resolution: "720P" } }));
  assert.throws(() => prepare({ ...body, input: { ...body.input, img_url: "https://image.example/a.png" } }));
});

test("Wan preserves model-specific reference and size/resolution contracts", () => {
  prepare({ model: "wan2.6-i2v", input: { prompt: "synthetic", img_url: "data:image/png;base64,AAAA" }, parameters: { resolution: "720P", duration: 15 } });
  for (const model of ["wan2.6-r2v", "wan2.6-r2v-flash"]) prepare({ model, input: { prompt: "synthetic", reference_urls: ["https://media.example/input.mp4"] }, parameters: { size: "1280*720", duration: 10 } });
  prepare({ model: "wan2.7-r2v", input: { prompt: "synthetic", media: [{ type: "reference_image", url: "https://media.example/input.png" }] }, parameters: { resolution: "1080P", ratio: "16:9", duration: 10 } });
  assert.throws(() => prepare({ model: "wan2.7-r2v", input: { prompt: "synthetic", media: [{ type: "reference_video", url: "data:video/mp4;base64,AAAA" }] } }));
  assert.throws(() => prepare({ model: "wan2.6-i2v", input: { prompt: "synthetic", img_url: "https://user:secret@media.example/image.png" } }));
  assert.throws(() => prepare({ model: "wan2.7-r2v", input: { prompt: "synthetic", media: [{ type: "reference_image", url: "https://media.example/input.png" }] }, parameters: { audio: false } }));
  assert.throws(() => prepare({ model: "wan2.7-r2v", input: { prompt: "synthetic", media: [{ type: "first_frame", url: "https://media.example/input.png" }] } }));
  assert.throws(() => prepare({ model: "wan2.6-i2v", input: { prompt: "synthetic", img_url: "invalid synthetic input" } }), { message: "invalid_wan_media_url" });
});

test("Wan terminal outcomes do not depend on metrics or partial output URLs", async () => {
  for (const row of wire.observations) {
    const value = await observe(row.native);
    assert.equal(value.terminal, row.terminal);
    assert.equal(value.observationUnavailable, row.observationUnavailable);
  }
  assert.equal((await observe({ task_status: "SUCCEEDED" })).terminal, "succeeded");
  const submission = await adapter.read(Response.json(wire.create.response), { ...context, action: "create", expectedId: undefined });
  assert.equal(submission.followUp, "retrieve");
});

test("Wan explicit UNKNOWN freezes observation loss rather than claiming failure or continuing polling", async () => {
  const result = await observe({ task_status: "UNKNOWN" });
  assert.equal(result.terminal, null);
  assert.equal(result.observationUnavailable, "expired_or_unknown");
  assert.equal(result.followUp, undefined);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
  assert.equal(wire.cancel.supported, false);
});

test("Wan controls require the bound ID and exact native method/path with no cancel invention", async () => {
  assert.equal(adapter.identify("retrieve", { task_id: id }, new URLSearchParams()), id);
  assert.deepEqual(adapter.control("retrieve", { method: "GET", path: wire.retrieve.path }, id, {}), { path: "/api/v1/tasks/" + id, query: new URLSearchParams() });
  for (const action of ["cancel", "result"]) assert.throws(() => adapter.control(action, { method: "POST", path: wire.retrieve.path }, id, {}));
  assert.throws(() => adapter.identify("retrieve", { task_id: id }, new URLSearchParams("task_id=other")));
  assert.throws(() => adapter.validateId("../task"));
  await assert.rejects(() => observe({ task_id: "other", task_status: "SUCCEEDED" }), /identity/);
  await assert.rejects(() => observe({ task_status: "UNKNOWN_STATUS" }), /status/);
  await assert.rejects(() => adapter.read(Response.json({ code: "InvalidApiKey" }), context));
});

test("Wan upstream control links are removed while output URLs remain opaque", async () => {
  const observation = await adapter.read(Response.json({ urls: { get: "https://untrusted.example/get" }, output: { task_id: id, task_status: "SUCCEEDED", status_url: "https://untrusted.example/status", video_url: "https://media.example/result.mp4" } }), context);
  const value = adapter.rewrite(observation, { retrieve: "/v1/native/alibaba/api/v1/tasks/" + id });
  assert.equal(value.urls, undefined);
  assert.equal(value.output.status_url, undefined);
  assert.equal(value.output.video_url, "https://media.example/result.mp4");
});

test("Wan rejects incomplete, oversized and HTTP-error observations before settlement", async () => {
  const responses = [
    new Response('{"output":', { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    Response.json({ output: { task_id: id, task_status: "SUCCEEDED" } }, { status: 503 }),
    new Response(" ", { headers: { "content-type": "application/json", "content-length": "1048577" } }),
    new Response(JSON.stringify({ output: { task_id: id, task_status: "SUCCEEDED" } })),
  ];
  for (const response of responses) await assert.rejects(() => adapter.read(response, context));
});

test("Wan credential qualification rejects plan keys/origins without retaining secrets", () => {
  for (const origin of ["https://dashscope-intl.aliyuncs.com", "https://fixture.ap-southeast-1.maas.aliyuncs.com"]) assert.doesNotThrow(() => assertWanStandardCredential("synthetic-standard", origin));
  for (const [key, origin] of [
    ["sk-sp-synthetic", "https://dashscope-intl.aliyuncs.com"],
    ["synthetic", "https://coding-intl.dashscope.aliyuncs.com"],
    ["synthetic", "https://token-plan.ap-southeast-1.maas.aliyuncs.com"],
    ["synthetic", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["synthetic", "https://api.example"], ["synthetic", "http://dashscope-intl.aliyuncs.com"],
    ["synthetic", "malformed synthetic origin"],
  ]) assert.throws(() => assertWanStandardCredential(key, origin), { message: "wan_requires_same_region_standard_api_credential" });
});
