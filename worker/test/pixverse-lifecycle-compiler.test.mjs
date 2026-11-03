import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { createPixVerseManagedAdapter, pixVerseOrigins } = await import("../managed-pixverse.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/pixverse/lifecycle.json", import.meta.url), "utf8"));
const adapter = createPixVerseManagedAdapter("text");
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  return { schema: "clawrouter.service-provider.v1", id: "pixverse", displayName: "PixVerse fixture", class: "rest_json",
    auth: { schemes: [{ type: "api_key", header: "API-KEY", secretKind: "api_key" }] },
    baseUrls: { default: pixVerseOrigins.international, cn: pixVerseOrigins.cn },
    capabilities: [{ id: "media.predict", endpoint: "video", methods: ["POST"] }],
    endpoints: {
      video: { path: wire.text.path, requestFormat: "pixverse.text_video", responseFormat: "pixverse.video", lifecycle: { protocol: wire.protocol, retrieve: "retrieve" } },
      retrieve: { method: wire.retrieve.method, path: wire.retrieve.path, pathParams: ["video_id"], requestFormat: "pixverse.video_get", responseFormat: "pixverse.video" },
    },
  };
}

test("PixVerse native fixture compiles scoped controls with a fresh trace ID on every actual retrieve", async () => {
  const snapshot = compile(fixture()), provider = snapshot.providers[0], create = provider.endpoints.find(value => value.id === "video"), control = provider.endpoints.find(value => value.id === "retrieve");
  assert.deepEqual(create.lifecycle, { protocol: "pixverse.video", retrieve: "retrieve" });
  assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]); assert.deepEqual(snapshot.model_index, {});
  assert.ok(adapter.requestFormats.includes(create.request_format)); assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  const prepared = adapter.prepare(wire.text.body, new Headers({ "Ai-trace-id": "caller-value" }), {}, new URLSearchParams());
  const observed = await adapter.read(Response.json(wire.text.response), { action: "create", requestedVersion: prepared.requestedVersion, pathParams: prepared.pathParams });
  const first = adapter.control("retrieve", control, observed.id, prepared.pathParams), second = adapter.control("retrieve", control, observed.id, prepared.pathParams);
  assert.equal(first.path, wire.retrieve.path.replace("${video_id}", observed.id)); assert.equal(first.query.size, 0);
  assert.deepEqual(first.transientHeaders, ["ai-trace-id"]);
  assert.match(first.headers.get("ai-trace-id"), /^[0-9a-f-]{36}$/);
  assert.notEqual(first.headers.get("ai-trace-id"), second.headers.get("ai-trace-id"));
  assert.notEqual(prepared.headers.get("ai-trace-id"), "caller-value");
  assert.equal(first.headers.has("api-key"), false);
});

test("PixVerse declarations reject raw controls, fixed trace IDs, credential overrides and unbound upload routes", () => {
  const changes = [
    m => { m.id = "other"; }, m => { delete m.endpoints.video.lifecycle; },
    m => { m.endpoints.video.lifecycle.cancel = "retrieve"; }, m => { m.endpoints.video.lifecycle.result = "retrieve"; },
    m => { m.endpoints.video.lifecycle.upload = "upload"; }, m => { m.endpoints.video.lifecycle.retrieve = "constructor"; },
    m => { m.endpoints.video.path = wire.image.path; m.endpoints.video.requestFormat = "pixverse.image_video"; },
    m => { m.endpoints.upload = { path: wire.upload.path, requestFormat: "pixverse.image_upload", responseFormat: "pixverse.image_upload" }; },
    m => { m.endpoints.orphan = { ...structuredClone(m.endpoints.retrieve), requestFormat: "other" }; },
    m => { m.endpoints.orphan = { ...structuredClone(m.endpoints.retrieve), requestFormat: "pixverse.raw", responseFormat: "other" }; },
    m => { m.endpoints.retrieve.pathParams.push("img_id"); }, m => { m.endpoints.retrieve.pathParamStyles = { video_id: "relative_path" }; },
    m => { m.endpoints.retrieve.method = "POST"; }, m => { m.endpoints.retrieve.path += "/cancel"; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "retrieve", methods: ["GET"] }); },
    m => { m.auth.schemes[0].header = "Authorization"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.baseUrls.cn = "https://other.example"; },
  ];
  for (const id of ["video", "retrieve"]) changes.push(
    m => { m.endpoints[id].headers = { "Ai-trace-id": "fixed" }; }, m => { m.endpoints[id].headers = { "API-KEY": "synthetic" }; },
    m => { m.endpoints[id].requestHeaders = ["Ai-trace-id"]; }, m => { m.endpoints[id].auth = "none"; },
    m => { m.endpoints[id].query = { video_id: "1" }; }, m => { m.endpoints[id].modelPassthrough = {}; },
    m => { m.endpoints[id].streaming = "sse"; }, m => { m.endpoints[id].nativeProxy = false; });
  for (const change of changes) {
    const manifest = fixture(); change(manifest);
    assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change));
  }
});

test("PixVerse deleted status is observation loss and image IDs require separate durable upload ownership", async () => {
  const expectedId = String(wire.text.response.Resp.video_id);
  for (const row of wire.observations) {
    const observation = await adapter.read(Response.json({ ErrCode: 0, Resp: { video_id: Number(expectedId), ...row.native } }), { action: "retrieve", expectedId, requestedVersion: "v6", pathParams: {} });
    assert.equal(observation.terminal, row.terminal); assert.equal(observation.observationUnavailable, row.observationUnavailable);
    assert.equal(observation.actualCostMicros, undefined); assert.equal(observation.followUp, undefined);
  }
  assert.throws(() => createPixVerseManagedAdapter("image").prepare(wire.image.body, new Headers(), {}, new URLSearchParams()), /upload_scope_required/);
  assert.throws(() => createPixVerseManagedAdapter("image", "123").prepare(wire.image.body, new Headers(), {}, new URLSearchParams()), /upload_identity_mismatch/);
  await assert.rejects(adapter.read(Response.json({ ErrCode: 0, Resp: { video_id: 123, status: 6 } }), { action: "retrieve", expectedId, requestedVersion: "v6", pathParams: {} }), /identity_mismatch/);
});
