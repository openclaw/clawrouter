import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { wanManagedAdapter: adapter, assertWanStandardCredential } = await import("../managed-wan.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/wan/lifecycle.json", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  return { schema: "clawrouter.service-provider.v1", id: "alibaba", displayName: "Alibaba Wan fixture", class: "rest_json",
    service: { platform: "alibaba", kind: "tool_provider", configKeys: ["MODELSTUDIO_API_KEY"] },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://dashscope-intl.aliyuncs.com" },
    capabilities: [{ id: "media.predict", endpoint: "video", methods: ["POST"] }],
    endpoints: {
      video: { path: wire.create.path, headers: { "X-DashScope-Async": "enable" }, requestFormat: "dashscope.video_create", responseFormat: "dashscope.video", lifecycle: { protocol: wire.protocol, retrieve: "task" } },
      task: { ...wire.retrieve, pathParams: ["task_id"], requestFormat: "dashscope.video_get", responseFormat: "dashscope.video" },
    },
  };
}

test("Wan schema compiles the native fixture's exact scoped create/read links without public raw controls or prices", async () => {
  const snapshot = compile(fixture()), provider = snapshot.providers[0];
  const create = provider.endpoints.find(endpoint => endpoint.id === "video"), retrieve = provider.endpoints.find(endpoint => endpoint.id === "task");
  assert.deepEqual(create.lifecycle, { protocol: "dashscope.video", retrieve: "task" });
  assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]);
  assert.deepEqual(snapshot.model_index, {});
  assert.ok(adapter.requestFormats.includes(create.request_format));
  assert.equal(adapter.supportsCancel, false);
  assert.equal(adapter.supportsResult, false);
  const prepared = adapter.prepare(wire.create.body, new Headers(), {}, new URLSearchParams());
  assert.deepEqual(prepared.body, wire.create.body);
  assert.equal(prepared.headers.get("x-dashscope-async"), "enable");
  const observation = await adapter.read(Response.json(wire.create.response), { action: "create", requestedVersion: prepared.requestedVersion, pathParams: prepared.pathParams });
  const control = adapter.control("retrieve", retrieve, observation.id, prepared.pathParams);
  assert.equal(control.path, wire.retrieve.path.replace("${task_id}", observation.id));
  assert.equal(control.query.size, 0);
  assert.equal(adapter.identify("retrieve", { task_id: observation.id }, new URLSearchParams()), observation.id);
});

test("Wan lifecycle rejects widening, invented cancellation, raw task exposure and endpoint credential overrides", () => {
  for (const change of [
    m => { m.id = "qwen"; }, m => { m.endpoints.video.lifecycle.protocol = "dashscope.arbitrary"; },
    m => { m.endpoints.video.lifecycle.cancel = "task"; }, m => { m.endpoints.video.lifecycle.result = "task"; },
    m => { delete m.endpoints.video.lifecycle; }, m => { m.endpoints.video.lifecycle.retrieve = "video"; },
    m => { m.endpoints.video.lifecycle.retrieve = "constructor"; }, m => { m.endpoints.video.lifecycle.retrieve = "missing"; },
    m => { m.endpoints.video.path += "/other"; }, m => { m.endpoints.video.requestFormat = "openai.responses"; },
    m => { m.endpoints.video.responseFormat = "openai.responses"; }, m => { m.endpoints.task.method = "POST"; },
    m => { m.endpoints.task.path = "/api/v1/tasks/${task_id}/cancel"; }, m => { m.endpoints.task.requestFormat = "dashscope.video_create"; },
    m => { m.endpoints.task.responseFormat = "other"; }, m => { m.endpoints.task.pathParams.push("extra"); },
    m => { m.endpoints.task.pathParamStyles = { task_id: "relative_path" }; },
    m => { m.endpoints.task.query = { task_id: "unbound" }; }, m => { m.endpoints.video.modelPassthrough = {}; },
    m => { m.endpoints.task.modelPassthrough = {}; }, m => { m.endpoints.video.streaming = "sse"; },
    m => { m.endpoints.task.nativeProxy = false; }, m => { m.capabilities[0].methods.push("GET"); },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "task", methods: ["GET"] }); },
    m => { m.endpoints.unbound = structuredClone(m.endpoints.task); },
    m => { m.endpoints.unbound = { ...structuredClone(m.endpoints.task), requestFormat: "other" }; },
    m => { m.endpoints.unbound = { ...structuredClone(m.endpoints.task), requestFormat: "dashscope.video_raw", responseFormat: "other" }; },
    m => { m.endpoints.video.headers.Authorization = "Bearer fixture-unbound"; },
    m => { m.endpoints.video.headers["X-DashScope-Async"] = "disable"; },
    m => { m.endpoints.video.requestHeaders = ["Authorization"]; }, m => { m.endpoints.video.auth = "none"; },
    m => { m.endpoints.task.headers = { "X-DashScope-Workspace": "unbound" }; },
    m => { m.endpoints.task.requestHeaders = ["Authorization"]; }, m => { m.endpoints.task.auth = "none"; },
  ]) {
    const manifest = fixture(); change(manifest);
    assert.throws(() => compile(manifest), /lifecycle|invalid manifest/);
  }
});

test("Wan UNKNOWN remains observation loss and regional Standard credentials remain an execution prerequisite", async () => {
  const id = wire.create.response.output.task_id;
  for (const row of wire.observations) {
    const observation = await adapter.read(Response.json({ output: { task_id: id, ...row.native } }), { action: "retrieve", expectedId: id, requestedVersion: "wan2.6-t2v", pathParams: {} });
    assert.equal(observation.terminal, row.terminal);
    assert.equal(observation.observationUnavailable, row.observationUnavailable);
    assert.equal(observation.followUp, undefined);
  }
  await assert.rejects(() => adapter.read(Response.json({ output: { task_id: "another-task", task_status: "UNKNOWN" } }), { action: "retrieve", expectedId: id, requestedVersion: "wan2.6-t2v", pathParams: {} }), /identity_mismatch/);
  assert.doesNotThrow(() => assertWanStandardCredential("fixture-standard-key", fixture().baseUrls.default));
  for (const [key, origin] of [["sk-sp-fixture", fixture().baseUrls.default], ["fixture-standard-key", "https://coding-intl.dashscope.aliyuncs.com"], ["fixture-standard-key", "https://example.com"]]) {
    assert.throws(() => assertWanStandardCredential(key, origin), /standard_api_credential/);
  }
});
