import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { createRunwayManagedAdapter, runwayApiVersion } = await import("../managed-runway.ts");
const { predictionResponse } = await import("../managed-predictions.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/runway/lifecycle.json", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture(mode = "text") {
  return { schema: "clawrouter.service-provider.v1", id: "runway", displayName: "Runway fixture", class: "rest_json",
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://api.dev.runwayml.com" }, capabilities: [{ id: "media.predict", endpoint: "video", methods: ["POST"] }],
    endpoints: {
      video: { path: wire[mode].path, requestFormat: `runway.${mode}_video`, responseFormat: "runway.task", lifecycle: { protocol: wire.protocol, retrieve: "retrieve", cancel: "cancel" } },
      retrieve: { method: wire.retrieve.method, path: wire.retrieve.path, pathParams: ["id"], requestFormat: "runway.task_get", responseFormat: "runway.task" },
      cancel: { method: wire.cancel.method, path: wire.cancel.path, pathParams: ["id"], requestFormat: "runway.task_cancel", responseFormat: "runway.task_cancel" },
    },
  };
}

test("Runway closed mode paths match the actual factory and preserve stable control version headers", () => {
  for (const mode of ["text", "image", "video"]) {
    const snapshot = compile(fixture(mode)), provider = snapshot.providers[0], adapter = createRunwayManagedAdapter(mode);
    const create = provider.endpoints.find(value => value.id === "video");
    assert.ok(adapter.requestFormats.includes(create.request_format)); assert.equal(adapter.supportsResult, false); assert.equal(adapter.supportsCancel, true);
    assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]); assert.deepEqual(snapshot.model_index, {});
    const prepared = adapter.prepare(wire[mode].body, new Headers(), {}, new URLSearchParams());
    assert.deepEqual(prepared.body, wire[mode].body); assert.equal(prepared.headers.get("x-runway-version"), wire.version);
    assert.equal(wire.version, runwayApiVersion);
    for (const [action, id] of [["retrieve", "retrieve"], ["cancel", "cancel"]]) {
      const endpoint = provider.endpoints.find(value => value.id === id);
      const target = adapter.control(action, endpoint, wire.created.id, prepared.pathParams);
      assert.equal(target.path, endpoint.path.replace("${id}", wire.created.id)); assert.equal(target.query.size, 0);
      assert.equal(target.headers.get("x-runway-version"), runwayApiVersion); assert.equal(target.headers.has("authorization"), false);
      assert.equal(target.transientHeaders, undefined, "the version remains stable route identity");
    }
  }
});

test("Runway rejects mismatched mode formats, raw controls, unsupported actions and version/auth overrides", () => {
  const changes = [
    m => { m.id = "other"; }, m => { delete m.endpoints.video.lifecycle; }, m => { delete m.endpoints.video.lifecycle.cancel; },
    m => { m.endpoints.video.lifecycle.result = "retrieve"; }, m => { m.endpoints.video.lifecycle.retrieve = "constructor"; },
    m => { m.endpoints.video.requestFormat = "runway.image_video"; }, m => { m.endpoints.video.path = "/v1/unknown"; },
    m => { m.endpoints.video.responseFormat = "openai.responses"; }, m => { m.endpoints.cancel.method = "POST"; },
    m => { m.endpoints.cancel.responseFormat = "runway.task"; }, m => { m.endpoints.retrieve.path = "/v1/tasks/${id}/output"; },
    m => { m.endpoints.retrieve.pathParamStyles = { id: "relative_path" }; }, m => { m.endpoints.retrieve.pathParams.push("model"); },
    m => { m.endpoints.orphan = structuredClone(m.endpoints.cancel); },
    m => { m.endpoints.orphan = { ...structuredClone(m.endpoints.cancel), requestFormat: "other" }; },
    m => { m.endpoints.orphan = { path: "/v1/uploads", requestFormat: "runway.upload", responseFormat: "other" }; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "retrieve", methods: ["GET"] }); },
    m => { m.baseUrls.default = "https://other.example"; }, m => { m.auth.schemes[0].format = "Basic ${secret}"; },
    m => { m.endpoints.video.headers = { "X-Runway-Version": "future" }; },
  ];
  for (const id of ["video", "retrieve", "cancel"]) changes.push(
    m => { m.endpoints[id].headers = { Authorization: "Bearer synthetic" }; }, m => { m.endpoints[id].requestHeaders = ["X-Runway-Version"]; },
    m => { m.endpoints[id].query = { key: "synthetic" }; }, m => { m.endpoints[id].modelPassthrough = {}; },
    m => { m.endpoints[id].auth = "none"; }, m => { m.endpoints[id].streaming = "sse"; }, m => { m.endpoints[id].nativeProxy = false; });
  for (const change of changes) {
    const manifest = fixture(); change(manifest);
    assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change));
  }
  const pinned = fixture(); pinned.endpoints.video.headers = { "X-Runway-Version": runwayApiVersion, "Content-Type": "application/json" };
  assert.doesNotThrow(() => compile(pinned));
});

test("Runway DELETE acknowledgement stays bodyless observation loss without invented native outcome or refund", async () => {
  const provider = compile(fixture()).providers[0], create = provider.endpoints.find(value => value.id === "video"), adapter = createRunwayManagedAdapter("text");
  const context = { action: "cancel", expectedId: wire.created.id, requestedVersion: "gen4.5", pathParams: {} };
  const observation = await adapter.read(new Response(null, { status: 204 }), context);
  assert.equal(observation.observationUnavailable, "canceled_or_deleted"); assert.equal(observation.terminal, null);
  assert.equal(observation.nativeStatus, null); assert.equal(observation.followUp, undefined); assert.equal(observation.actualCostMicros, undefined);
  const response = predictionResponse(observation, provider, create, {}, 204);
  assert.equal(response.status, 204); assert.equal(await response.text(), "");
  await assert.rejects(adapter.read(new Response(null, { status: 404 }), context), /cancel_ack/);
  for (const row of wire.observations) {
    const observed = await adapter.read(Response.json({ ...wire.created, ...row.native }), { ...context, action: "retrieve" });
    assert.equal(observed.terminal, row.terminal);
  }
  assert.throws(() => adapter.prepare({ ...wire.text.body, model: "veo3.1", duration: 5 }, new Headers(), {}, new URLSearchParams()), /veo_shape/);
});
