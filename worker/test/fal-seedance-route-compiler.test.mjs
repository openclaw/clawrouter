import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { managedCreateAdapter } = await import("../managed-lifecycle-adapters.ts");
const { managedPaths } = await import("../managed-routes.ts");
const { responsesControls } = await import("../responses-lifecycle.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/seedance.json", import.meta.url), "utf8"));
const adapter = managedCreateAdapter("fal.queue", "fal.queue_submit");
const parameters = path => [...path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]);
function provider() {
  const endpoints = {};
  for (const [id, path] of [["queue", "/${owner}/${app}/${variant}"], ["queue_four", "/${owner}/${app}/${variant}/${subvariant}"]]) {
    endpoints[id] = { path, pathParams: parameters(path), requestFormat: "fal.queue_submit", responseFormat: "fal.queue_submission",
      lifecycle: { protocol: "fal.queue", retrieve: "status", result: "result", cancel: "cancel" } };
  }
  for (const [id, method, suffix, format] of [["status", "GET", "/status", "fal.queue_status"], ["result", "GET", "", "fal.queue_result"], ["cancel", "PUT", "/cancel", "fal.queue_cancel"]]) {
    const path = "/${owner}/${app}/requests/${request_id}" + suffix;
    endpoints[id] = { method, path, pathParams: parameters(path), requestFormat: format, responseFormat: format };
  }
  return compileProviderSnapshot([{ schema: "clawrouter.service-provider.v1", id: "fal", displayName: "fal fixture", class: "rest_json",
    service: { platform: "fal", kind: "tool_provider", configKeys: ["FAL_KEY"] },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Key ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://queue.fal.run" },
    capabilities: ["queue", "queue_four"].map(endpoint => ({ id: "media.predict", endpoint, methods: ["POST"] })), endpoints }]).providers[0];
}

test("landed three/four-segment schema composes with all six registered Seedance creates and dotted public controls", async () => {
  const compiled = provider();
  for (const row of wire.requests) {
    const [owner, app, variant, subvariant] = row.model.split("/");
    const params = { owner, app, variant, ...(subvariant ? { subvariant } : {}) };
    const create = compiled.endpoints.find(endpoint => endpoint.id === (subvariant ? "queue_four" : "queue"));
    const prepared = adapter.prepare(row.body, new Headers(), params, new URLSearchParams());
    assert.equal(create.path.replace(/\$\{([^}]+)\}/g, (_, key) => prepared.pathParams[key]), "/" + row.model);
    const paths = managedPaths(compiled, create, wire.requestId, prepared.pathParams);
    const root = "/v1/native/fal" + wire.expectedControlRoot;
    assert.deepEqual(paths, { retrieve: root + "/status", result: root, cancel: root + "/cancel" });
    const observed = await adapter.read(Response.json(wire.submit), { action: "create", requestedVersion: prepared.requestedVersion, pathParams: prepared.pathParams });
    const rewritten = adapter.rewrite(observed, paths);
    assert.equal(rewritten.status_url, paths.retrieve); assert.equal(rewritten.response_url, paths.result); assert.equal(rewritten.cancel_url, paths.cancel);
    assert.equal(adapter.identify("retrieve", { owner, app, request_id: wire.requestId }, new URLSearchParams()), wire.requestId);
    assert.equal(create.requestPricing, undefined);
  }
});
test("shared control declarations preserve both original-create candidates without turning controls into new offers", () => {
  const compiled = provider();
  for (const [id, action] of [["status", "retrieve"], ["result", "result"], ["cancel", "cancel"]]) {
    const control = compiled.endpoints.find(endpoint => endpoint.id === id);
    assert.deepEqual(responsesControls(compiled, control).map(row => [row.create.id, row.protocol, row.action]),
      [["queue", "fal.queue", action], ["queue_four", "fal.queue", action]]);
    assert.equal(compiled.capabilities.some(row => row.endpoint === id), false);
  }
});
