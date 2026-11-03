import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";

// Use the concrete adapter owner's portable route fixtures, not a parallel protocol.
const routes = JSON.parse(readFileSync(new URL("../../providers/_fixtures/media/managed-routes.json", import.meta.url), "utf8"));
assert.equal(routes.schema, "clawrouter.managed-media-route-fixtures.v1");
const contracts = {
  "fal.queue": { path: "/${owner}/${app}/${variant}", response: "fal.queue_submission", controls: {
    retrieve: ["fal.queue_status", "fal.queue_status"], result: ["fal.queue_result", "fal.queue_result"], cancel: ["fal.queue_cancel", "fal.queue_cancel"],
  } },
  "kie.jobs": { path: "/api/v1/jobs/createTask", response: "kie.job", controls: { retrieve: ["kie.job_get", "kie.job"] } },
  "vydra.jobs": { path: "/api/v1/jobs", response: "vydra.job", controls: { retrieve: ["vydra.job_get", "vydra.job"], cancel: ["vydra.job_cancel", "vydra.job_cancel"] } },
};
const parameters = path => [...path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]);
function fixture(route) {
  const contract = contracts[route.protocol], provider = route.protocol.split(".")[0];
  const lifecycle = { protocol: route.protocol }, endpoints = {};
  for (const [action, [requestFormat, responseFormat]] of Object.entries(contract.controls)) {
    const control = route[action];
    assert.ok(control, `${route.protocol} ${action} fixture must exist`);
    lifecycle[action] = action;
    endpoints[action] = { ...control, pathParams: parameters(control.path), requestFormat, responseFormat };
  }
  endpoints.create = { path: contract.path, pathParams: parameters(contract.path), requestFormat: route.requestFormat, responseFormat: contract.response, lifecycle };
  return { schema: "clawrouter.service-provider.v1", id: provider, displayName: "Managed fixture", class: "rest_json",
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://provider.example" }, capabilities: [{ id: "media.predict", endpoint: "create", methods: ["POST"] }], endpoints };
}
const compile = manifest => compileProviderSnapshot([manifest]);
for (const route of routes.protocols.filter(route => contracts[route.protocol])) {
  test(`${route.protocol} compiles the adapter's exact create/control contract without tariffs`, () => {
    const manifest = fixture(route), snapshot = compile(manifest), provider = snapshot.providers[0];
    assert.deepEqual(provider.endpoints.find(e => e.id === "create").lifecycle, manifest.endpoints.create.lifecycle);
    for (const action of Object.keys(contracts[route.protocol].controls)) {
      const control = provider.endpoints.find(e => e.id === action);
      assert.equal(control.path, route[action].path);
      assert.equal(control.method, route[action].method);
      assert.deepEqual(control.query, {});
    }
    assert.deepEqual(snapshot.model_index, {});
    assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]);
    if (route.protocol === "kie.jobs") assert.equal(manifest.endpoints.create.lifecycle.cancel, undefined);
  });
  test(`${route.protocol} rejects unbound, crossed or broadened lifecycle controls`, () => {
    for (const change of [
      m => { m.id = "other"; }, m => { m.endpoints.create.lifecycle.protocol = "arbitrary.jobs"; },
      m => { delete m.endpoints.create.lifecycle; }, m => { m.endpoints.create.path += "/other"; },
      m => { m.endpoints.create.requestFormat = "openai.responses"; }, m => { m.endpoints.create.responseFormat = "openai.responses"; },
      m => { m.endpoints.create.lifecycle.retrieve = "create"; }, m => { m.endpoints.create.lifecycle.retrieve = "constructor"; },
      m => { m.endpoints.create.lifecycle.retrieve = "missing"; }, m => { m.endpoints.retrieve.method = "POST"; },
      m => { m.endpoints.retrieve.path += "/other"; }, m => { m.endpoints.retrieve.requestFormat = route.requestFormat; },
      m => { m.endpoints.retrieve.responseFormat = "other"; }, m => { m.endpoints.retrieve.pathParams.push("extra"); },
      m => { m.endpoints.retrieve.query = { taskId: "unbound" }; }, m => { m.endpoints.retrieve.modelPassthrough = {}; },
      m => { m.endpoints.retrieve.streaming = "sse"; }, m => { m.endpoints.create.nativeProxy = false; },
      m => { m.capabilities.push({ id: "media.predict.read", endpoint: "retrieve", methods: ["GET"] }); },
      m => { m.capabilities[0].methods.push("GET"); }, m => { m.endpoints.unbound = structuredClone(m.endpoints.retrieve); },
    ]) {
      const invalid = fixture(route); change(invalid); assert.throws(() => compile(invalid), /lifecycle|invalid manifest/);
    }
  });
}

test("only fal has a separate result; Kie cannot invent cancellation or path identity", () => {
  for (const protocol of ["kie.jobs", "vydra.jobs"]) {
    const m = fixture(routes.protocols.find(route => route.protocol === protocol));
    m.endpoints.create.lifecycle.result = "retrieve";
    assert.throws(() => compile(m), /lifecycle|invalid manifest/);
  }
  const kie = fixture(routes.protocols.find(route => route.protocol === "kie.jobs"));
  kie.endpoints.create.lifecycle.cancel = "retrieve";
  assert.throws(() => compile(kie), /lifecycle|invalid manifest/);
  delete kie.endpoints.create.lifecycle.cancel;
  kie.endpoints.retrieve.pathParams = ["taskId"];
  assert.throws(() => compile(kie), /lifecycle/);
});

test("fal supports its two-segment submit variant and rejects path widening", () => {
  const m = fixture(routes.protocols.find(route => route.protocol === "fal.queue"));
  m.endpoints.create.path = "/${owner}/${app}";
  m.endpoints.create.pathParams = ["owner", "app"];
  assert.doesNotThrow(() => compile(m));
  for (const id of Object.keys(m.endpoints)) {
    const bad = structuredClone(m);
    bad.endpoints[id].pathParamStyles = { owner: "relative_path" };
    assert.throws(() => compile(bad), /lifecycle/);
  }
});
