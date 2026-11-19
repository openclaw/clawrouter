import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { togetherVideoManagedAdapter: adapter, togetherVideoModels } = await import("../managed-together.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/together/video.json", import.meta.url), "utf8"));
const existing = parse(readFileSync(new URL("../../providers/together.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities.push({ id: "media.predict", endpoint: "video", methods: ["POST"] });
  manifest.endpoints.video = { path: "/v2/videos", requestFormat: "together.video_create", responseFormat: "together.video", lifecycle: { protocol: "together.video", retrieve: "retrieve" } };
  manifest.endpoints.retrieve = { method: "GET", path: "/v2/videos/${video_id}", pathParams: ["video_id"], requestFormat: "together.video_get", responseFormat: "together.video" };
  return manifest;
}

test("Together native video links match the actual codec without altering existing Chat discovery or prices", async () => {
  const original = compile(existing), snapshot = compile(fixture()), provider = snapshot.providers[0];
  const create = provider.endpoints.find(value => value.id === "video"), control = provider.endpoints.find(value => value.id === "retrieve");
  assert.deepEqual(snapshot.model_index, original.model_index);
  assert.deepEqual(snapshot.capability_index["llm.chat"], original.capability_index["llm.chat"]);
  assert.deepEqual(provider.endpoints.find(value => value.id === "chat_completions"), original.providers[0].endpoints.find(value => value.id === "chat_completions"));
  assert.deepEqual(create.lifecycle, { protocol: adapter.protocol, retrieve: "retrieve" });
  assert.ok(adapter.requestFormats.includes(create.request_format)); assert.equal(adapter.supportsResult, false); assert.equal(adapter.supportsCancel, false);
  assert.equal(snapshot.capability_index["media.prediction.read"], undefined);
  assert.deepEqual(wire.requests.map(value => value.model), [...togetherVideoModels]);
  for (const body of wire.requests) {
    const prepared = adapter.prepare(body, new Headers({ Authorization: "Bearer caller-fixture" }), {}, new URLSearchParams());
    assert.deepEqual(prepared.body, body); assert.equal(prepared.requestedVersion, body.model); assert.equal(prepared.headers.has("authorization"), false);
    const observed = await adapter.read(Response.json({ id: wire.pending.id }), { action: "create", requestedVersion: body.model, pathParams: prepared.pathParams });
    assert.equal(observed.terminal, null); assert.equal(observed.followUp, "retrieve");
    const target = adapter.control("retrieve", control, observed.id, prepared.pathParams);
    assert.equal(target.path, `/v2/videos/${observed.id}`); assert.equal(target.query.size, 0); assert.equal(target.headers, undefined);
    assert.equal(adapter.identify("retrieve", { video_id: observed.id }, target.query), observed.id);
  }
  const currentOrigin = fixture(); currentOrigin.baseUrls.default = "https://api.together.ai";
  assert.doesNotThrow(() => compile(currentOrigin));
});

test("Together declarations reject raw controls, unsupported actions, cross-product credentials and routing overrides", () => {
  const changes = [
    m => { m.id = "other"; }, m => { delete m.endpoints.video.lifecycle; }, m => { delete m.endpoints.video.lifecycle.retrieve; },
    m => { m.endpoints.video.lifecycle.cancel = "retrieve"; }, m => { m.endpoints.video.lifecycle.result = "retrieve"; },
    m => { m.endpoints.video.lifecycle.retrieve = "constructor"; }, m => { m.endpoints.video.path = "/v1/videos"; },
    m => { m.endpoints.video.requestFormat = "openai.chat_completions"; }, m => { m.endpoints.video.responseFormat = "openai.responses"; },
    m => { m.endpoints.retrieve.method = "POST"; }, m => { m.endpoints.retrieve.path += "/cancel"; },
    m => { m.endpoints.retrieve.pathParams.push("model"); }, m => { m.endpoints.retrieve.pathParamStyles = { video_id: "relative_path" }; },
    m => { m.endpoints.orphan = { ...structuredClone(m.endpoints.retrieve), requestFormat: "other" }; },
    m => { m.endpoints.orphan = { path: "/v2/raw", requestFormat: "together.video_raw", responseFormat: "other" }; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "retrieve", methods: ["GET"] }); },
    m => { m.baseUrls.default = "https://api.together.xyz/v2"; }, m => { m.baseUrls.default = "https://api.minimax.io"; },
    m => { m.baseUrls.cn = "https://dashscope.aliyuncs.com"; }, m => { m.auth.schemes[0].header = "X-API-Key"; },
    m => { m.auth.schemes[0].format = "Token ${secret}"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { Authorization: "Bearer synthetic" } } }; },
    m => { m.adapter.injectHeaders = { Authorization: "Bearer synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["Authorization"]; },
  ];
  for (const id of ["video", "retrieve"]) changes.push(
    m => { m.endpoints[id].headers = { Authorization: "Bearer synthetic" }; }, m => { m.endpoints[id].requestHeaders = ["Authorization"]; },
    m => { m.endpoints[id].query = { video_id: "foreign" }; }, m => { m.endpoints[id].auth = "none"; },
    m => { m.endpoints[id].streaming = "sse"; }, m => { m.endpoints[id].nativeProxy = false; }, m => { m.endpoints[id].modelPassthrough = {}; });
  for (const change of changes) {
    const manifest = fixture(); change(manifest);
    assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change));
  }
});

test("Together native observations bind model and job without treating output cost hints as a tariff", async () => {
  const context = { action: "retrieve", expectedId: wire.pending.id, requestedVersion: wire.pending.model, pathParams: {} };
  for (const [body, terminal] of [[wire.pending, null], [wire.completed, "succeeded"], [wire.failed, "failed"]]) {
    const observation = await adapter.read(Response.json(body), context);
    assert.equal(observation.terminal, terminal); assert.equal(observation.followUp, undefined); assert.equal(observation.actualCostMicros, undefined);
  }
  const observed = await adapter.read(Response.json({ ...wire.completed, urls: { get: "https://other.example/task" } }), context);
  assert.equal(adapter.rewrite(observed, {}).urls, undefined);
  assert.deepEqual(adapter.rewrite(observed, {}).outputs, wire.completed.outputs, "media URL and cost hint stay opaque native data");
  await assert.rejects(adapter.read(Response.json({ ...wire.completed, id: "foreign" }), context), /identity_mismatch/);
  await assert.rejects(adapter.read(Response.json({ ...wire.completed, model: "minimax/hailuo-02" }), context), /model_mismatch/);
  await assert.rejects(adapter.read(Response.json({ id: wire.pending.id }), context), /status/);
  const control = compile(fixture()).providers[0].endpoints.find(value => value.id === "retrieve");
  assert.throws(() => adapter.control("cancel", control, wire.pending.id, {}), /control_endpoint/);
  assert.throws(() => adapter.prepare({ ...wire.requests[0], callback: "https://other.example" }, new Headers(), {}, new URLSearchParams()), /field/);
  assert.throws(() => adapter.prepare({ ...wire.requests[1], seconds: "15" }, new Headers(), {}, new URLSearchParams()), /duration/);
});
