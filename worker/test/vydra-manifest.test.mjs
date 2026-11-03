import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { managedLifecycleAdapter } = await import("../managed-lifecycle-adapters.ts");
const { managedRoute, managedPaths } = await import("../managed-routes.ts");
const source = parse(readFileSync(new URL("../../providers/vydra.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([source]), provider = snapshot.providers[0], create = provider.endpoints.find(value => value.id === "jobs");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/vydra/jobs.json", import.meta.url), "utf8"));

test("Vydra's declaration resolves native Jobs controls without a raw-ID capability or model price claim", () => {
  const route = managedRoute(provider, create);
  assert.equal(route.adapter, managedLifecycleAdapter("vydra.jobs")); assert.deepEqual(Object.keys(route.controls), ["retrieve", "cancel"]);
  assert.equal(provider.base_urls.default, "https://www.vydra.ai"); assert.deepEqual(source.service.configKeys, ["VYDRA_API_KEY"]);
  assert.deepEqual(source.auth.schemes, [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }]);
  assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]); assert.deepEqual(snapshot.model_index, {});
  assert.equal(route.adapter.supportsCancel, true); assert.equal(route.adapter.supportsResult, false);
});

test("native workflow input and original-job controls stay separate from Models API and Studio runs", () => {
  const adapter = managedLifecycleAdapter("vydra.jobs"), prepared = adapter.prepare(wire.request.body, new Headers({ authorization: "Bearer synthetic-caller" }), {}, new URLSearchParams());
  assert.deepEqual(prepared.body, wire.request.body); assert.equal(prepared.requestedVersion, wire.request.body.workflow); assert.equal(prepared.headers.has("authorization"), false);
  assert.deepEqual(managedPaths(provider, create, wire.submission.id, prepared.pathParams), {
    retrieve: `/v1/native/vydra/api/v1/jobs/${wire.submission.id}`, cancel: `/v1/native/vydra/api/v1/jobs/${wire.submission.id}`,
  });
  assert.equal(managedRoute(provider, create).controls.cancel.method, "DELETE");
  assert.throws(() => adapter.prepare({ prompt: "Synthetic model payload" }, new Headers(), {}, new URLSearchParams()), /unsupported_vydra_workflow/);
  assert.throws(() => adapter.prepare({ ...wire.request.body, webhookUrl: "https://other.example" }, new Headers(), {}, new URLSearchParams()), /vydra_polling_only/);
});

test("the schema rejects unbound controls, invented result endpoints and a Models API submit alias", () => {
  for (const change of [m => { delete m.endpoints.jobs.lifecycle; }, m => { m.endpoints.jobs.lifecycle.result = "job"; },
    m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "job", methods: ["GET"] }); },
    m => { m.endpoints.cancel_job.method = "POST"; }, m => { m.endpoints.jobs.path = "/api/v1/models/${model}"; m.endpoints.jobs.pathParams = ["model"]; }]) {
    const invalid = structuredClone(source); change(invalid); assert.throws(() => compileProviderSnapshot([invalid]), /lifecycle|invalid manifest/);
  }
});
