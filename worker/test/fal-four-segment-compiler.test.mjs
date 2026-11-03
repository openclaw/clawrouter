import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { managedCreateAdapter } = await import("../managed-lifecycle-adapters.ts");
const { managedPaths } = await import("../managed-routes.ts");
const { responsesControls } = await import("../responses-lifecycle.ts");
const { prepareFalSeedance } = await import("../fal-seedance.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/prompt-video.json", import.meta.url), "utf8"));
const seedance = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/seedance.json", import.meta.url), "utf8"));
const adapter = managedCreateAdapter("fal.queue", "fal.queue_submit");
const parameters = path => [...path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]);
const fill = (path, params) => path.replace(/\$\{([^}]+)\}/g, (_, name) => params[name]);
function fixture() {
  const endpoints = {};
  for (const [id, path] of [["queue", "/${owner}/${app}/${variant}"], ["queue_four", "/${owner}/${app}/${variant}/${subvariant}"]]) {
    endpoints[id] = { path, pathParams: parameters(path), requestFormat: "fal.queue_submit", responseFormat: "fal.queue_submission",
      lifecycle: { protocol: "fal.queue", retrieve: "status", result: "result", cancel: "cancel" } };
  }
  for (const [id, method, suffix, format] of [["status", "GET", "/status", "fal.queue_status"], ["result", "GET", "", "fal.queue_result"], ["cancel", "PUT", "/cancel", "fal.queue_cancel"]]) {
    const path = "/${owner}/${app}/requests/${request_id}" + suffix;
    endpoints[id] = { method, path, pathParams: parameters(path), requestFormat: format, responseFormat: format };
  }
  return { schema: "clawrouter.service-provider.v1", id: "fal", displayName: "fal fixture", class: "rest_json",
    service: { platform: "fal", kind: "tool_provider", configKeys: ["FAL_KEY"] },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Key ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://queue.fal.run" },
    capabilities: ["queue", "queue_four"].map(endpoint => ({ id: "media.predict", endpoint, methods: ["POST"] })), endpoints };
}
const compile = manifest => compileProviderSnapshot([manifest]);

test("fal four-segment declaration composes with the registered exact HeyGen codec and original control root", () => {
  const manifest = fixture(), compiled = compile(manifest), provider = compiled.providers[0];
  const endpoint = provider.endpoints.find(row => row.id === "queue_four"), row = wire.requests[1];
  const prepared = adapter.prepare(row.body, new Headers(), row.pathParams, new URLSearchParams());
  assert.equal(fill(endpoint.path, prepared.pathParams), "/" + row.model);
  assert.equal(prepared.requestedVersion, row.model); assert.deepEqual(prepared.body, row.body);
  assert.equal(prepared.headers.has("authorization"), false); assert.equal(prepared.headers.get("x-fal-no-retry"), "1");
  assert.deepEqual(endpoint.lifecycle, manifest.endpoints.queue_four.lifecycle);
  assert.deepEqual(managedPaths(provider, endpoint, wire.requestId, prepared.pathParams), {
    retrieve: `/v1/native/fal/fal-ai/heygen/requests/${wire.requestId}/status`,
    result: `/v1/native/fal/fal-ai/heygen/requests/${wire.requestId}`,
    cancel: `/v1/native/fal/fal-ai/heygen/requests/${wire.requestId}/cancel`,
  });
  assert.deepEqual(compiled.model_index, {}); assert.equal(endpoint.requestPricing, undefined);
});

test("fal three- and four-segment creates share one protocol/action link without choosing the first create", () => {
  const provider = compile(fixture()).providers[0];
  for (const [id, action] of [["status", "retrieve"], ["result", "result"], ["cancel", "cancel"]]) {
    const endpoint = provider.endpoints.find(row => row.id === id);
    assert.deepEqual(responsesControls(provider, endpoint).map(row => [row.create.id, row.protocol, row.action]),
      [["queue", "fal.queue", action], ["queue_four", "fal.queue", action]]);
    assert.equal(provider.capabilities.some(row => row.endpoint === id), false, "controls are not independent offers");
  }
  for (const [index, id] of [[0, "queue"], [1, "queue_four"]]) {
    const row = wire.requests[index], endpoint = provider.endpoints.find(value => value.id === id);
    const paths = managedPaths(provider, endpoint, wire.requestId, row.pathParams);
    assert.equal(paths.retrieve, `/v1/native/fal/${row.pathParams.owner}/${row.pathParams.app}/requests/${wire.requestId}/status`);
  }
});

test("fal fourth-segment product and path values remain guarded by the actual adapter", () => {
  const row = wire.requests[1];
  for (const params of [
    { ...row.pathParams, subvariant: "other" }, { ...row.pathParams, variant: "v3" },
    { owner: "fal-ai", app: "heygen", subvariant: "video-agent" },
    { ...row.pathParams, extra: "fifth" }, { ...row.pathParams, app: ".." }, { ...row.pathParams, app: "." },
    { ...row.pathParams, app: "heygen%2fother" }, { ...row.pathParams, subvariant: "video-agent/other" },
  ]) assert.throws(() => adapter.prepare(row.body, new Headers(), params, new URLSearchParams()));
});

test("Seedance's six published bodies and dotted identities fit only the declared three/four-segment templates", () => {
  const provider = compile(fixture()).providers[0];
  assert.equal(seedance.requests.length, 6);
  for (const row of seedance.requests) {
    const [owner, app, variant, subvariant, extra] = row.model.split("/");
    assert.equal(extra, undefined); assert.equal(owner, "bytedance"); assert.equal(app, "seedance-2.0");
    const params = { owner, app, variant, ...(subvariant ? { subvariant } : {}) };
    const endpoint = provider.endpoints.find(value => value.id === (subvariant ? "queue_four" : "queue"));
    const prepared = prepareFalSeedance(row.model, row.body);
    assert.equal(fill(endpoint.path, params), prepared.path); assert.equal(prepared.model, row.model);
    assert.equal(prepared.upstreamCostMicros, null);
    const result = provider.endpoints.find(value => value.id === "result");
    assert.equal(fill(result.path, { ...params, request_id: seedance.requestId }), seedance.expectedControlRoot);
    if (row.body.image_url) assert.throws(() => prepareFalSeedance(row.model, { ...row.body, image_url: "https://assets.example/unowned.png" }));
  }
  // This is codec/template composition. Dotted native dispatch/public paths and
  // registry admission remain separately qualified by their runtime owners.
});

test("fal compiler rejects deeper routes, traversal styles, orphan controls and crossed shared actions", () => {
  for (const change of [
    m => { m.endpoints.queue_four.path += "/${extra}"; m.endpoints.queue_four.pathParams.push("extra"); },
    m => { m.endpoints.queue_four.path = "/${owner}/${app}/${variant}/${subvariant}/literal"; },
    m => { m.endpoints.queue_four.pathParamStyles = { app: "relative_path" }; },
    m => { m.endpoints.queue_four.pathParams.pop(); },
    m => { m.endpoints.queue_four.lifecycle.result = "status"; },
    m => { m.endpoints.queue_four.lifecycle.protocol = "vydra.jobs"; },
    m => { m.endpoints.status.path = "/${owner}/${app}/${variant}/requests/${request_id}/status"; m.endpoints.status.pathParams.push("variant"); },
    m => { m.endpoints.status.query = { logs: "1" }; },
    m => { m.endpoints.orphan = structuredClone(m.endpoints.result); },
    m => { m.capabilities.push({ id: "media.predict.read", endpoint: "status", methods: ["GET"] }); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change)); }
});

test("fal four-segment declarations cannot override the original queue origin or Key credential", () => {
  for (const change of [
    m => { m.baseUrls.default = "https://fal.run"; }, m => { m.auth.schemes[0].format = "Bearer ${secret}"; },
    m => { m.auth.schemes[0].secretKind = "oauth"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { authorization: "Key synthetic" } } }; },
    m => { m.adapter = { injectQuery: { key: "synthetic" } }; },
    m => { m.endpoints.queue_four.requestHeaders = ["authorization"]; },
    m => { m.endpoints.queue_four.headers = { authorization: "Key synthetic" }; },
    m => { m.endpoints.status.auth = "none"; }, m => { m.endpoints.cancel.headers = { authorization: "Key synthetic" }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /lifecycle|invalid manifest/, String(change)); }
});
