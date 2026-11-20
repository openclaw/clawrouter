import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { managedLifecycleAdapter } = await import("../managed-lifecycle-adapters.ts");
const { managedRoute, managedPaths } = await import("../managed-routes.ts");
const source = parse(readFileSync(new URL("../../providers/kie.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([source]), provider = snapshot.providers[0], create = provider.endpoints.find(value => value.id === "create_task");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/jobs.json", import.meta.url), "utf8"));

test("Kie declaration resolves the concrete shared adapter with server Bearer auth and no raw controls", () => {
  const route = managedRoute(provider, create);
  assert.equal(route.adapter, managedLifecycleAdapter("kie.jobs")); assert.deepEqual(Object.keys(route.controls), ["retrieve"]);
  assert.equal(provider.base_urls.default, "https://api.kie.ai"); assert.deepEqual(source.service.configKeys, ["KIE_API_KEY"]);
  assert.deepEqual(source.auth.schemes, [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }]);
  assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]); assert.deepEqual(snapshot.model_index, {});
  assert.equal(route.adapter.supportsCancel, false); assert.equal(route.adapter.supportsResult, false);
});

test("native create retains model/input while query identity is constructed from the original job", () => {
  const adapter = managedLifecycleAdapter("kie.jobs");
  const prepared = adapter.prepare(wire.request.body, new Headers({ authorization: "Bearer synthetic-caller" }), {}, new URLSearchParams());
  assert.deepEqual(prepared.body, wire.request.body); assert.equal(prepared.requestedVersion, wire.request.body.model); assert.equal(prepared.headers.has("authorization"), false);
  const paths = managedPaths(provider, create, wire.submission.data.taskId, prepared.pathParams);
  assert.deepEqual(paths, { retrieve: `/v1/native/kie/api/v1/jobs/recordInfo?taskId=${wire.submission.data.taskId}` });
  assert.equal(adapter.identify("retrieve", {}, new URLSearchParams(`taskId=${wire.submission.data.taskId}`)), wire.submission.data.taskId);
  for (const query of ["taskId=one&taskId=two", "taskId=one&api_key=synthetic", "taskId=../foreign"]) assert.throws(() => adapter.identify("retrieve", {}, new URLSearchParams(query)));
});

test("the published Market route rejects cancellation, callbacks and independently authorized retrieval", () => {
  const adapter = managedLifecycleAdapter("kie.jobs");
  assert.throws(() => adapter.prepare({ ...wire.request.body, callBackUrl: "https://other.example" }, new Headers(), {}, new URLSearchParams()), /kie_polling_only/);
  for (const change of [m => { delete m.endpoints.create_task.lifecycle; }, m => { m.endpoints.create_task.lifecycle.cancel = "record_info"; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "record_info", methods: ["GET"] }); },
    m => { m.endpoints.record_info.query = { taskId: "foreign" }; }, m => { m.endpoints.record_info.pathParams = ["taskId"]; }]) {
    const invalid = structuredClone(source); change(invalid); assert.throws(() => compileProviderSnapshot([invalid]), /lifecycle|invalid manifest/);
  }
});
