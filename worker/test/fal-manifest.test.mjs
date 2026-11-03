import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { managedLifecycleAdapter } = await import("../managed-lifecycle-adapters.ts");
const { managedRoute, managedPaths } = await import("../managed-routes.ts");
const source = parse(readFileSync(new URL("../../providers/fal.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([source]), provider = snapshot.providers[0];
const create = provider.endpoints.find(endpoint => endpoint.id === "queue");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/queue-lifecycle.json", import.meta.url), "utf8"));
const route = { owner: "fal-ai", app: "minimax", variant: "video-01-live" };

test("fal declaration selects the actual managed registry without publishing raw-ID controls or priced model facts", () => {
  const resolved = managedRoute(provider, create);
  assert.equal(resolved.adapter, managedLifecycleAdapter("fal.queue"));
  assert.deepEqual(Object.keys(resolved.controls).sort(), ["cancel", "result", "retrieve"]);
  assert.equal(provider.base_urls.default, "https://queue.fal.run");
  assert.deepEqual(source.service.configKeys, ["FAL_KEY"]);
  assert.deepEqual(source.auth.schemes, [{ type: "api_key", header: "Authorization", format: "Key ${secret}", secretKind: "api_key" }]);
  assert.deepEqual(Object.keys(snapshot.capability_index), ["media.predict"]);
  assert.deepEqual(snapshot.model_index, {});
  assert.equal(source.pricing, undefined); assert.equal(source.requestPricing, undefined);
});

test("frozen default video body stays native and its controls retain owner/app without reusing the variant", () => {
  const adapter = managedLifecycleAdapter("fal.queue"), input = { prompt: "A paper boat on a quiet pond" };
  const prepared = adapter.prepare(input, new Headers({ authorization: "Key synthetic-caller", "idempotency-key": "synthetic" }), route, new URLSearchParams());
  assert.deepEqual(prepared.body, input); assert.equal(prepared.requestedVersion, "fal-ai/minimax/video-01-live");
  assert.deepEqual(prepared.pathParams, route); assert.equal(prepared.headers.has("authorization"), false);
  assert.equal(prepared.headers.get("X-Fal-No-Retry"), "1");
  assert.deepEqual(managedPaths(provider, create, "job_fixture", prepared.pathParams), {
    retrieve: "/v1/native/fal/fal-ai/minimax/requests/job_fixture/status",
    result: "/v1/native/fal/fal-ai/minimax/requests/job_fixture",
    cancel: "/v1/native/fal/fal-ai/minimax/requests/job_fixture/cancel",
  });
  assert.throws(() => adapter.prepare(input, new Headers(), { ...route, variant: "fast/text-to-video" }, new URLSearchParams()), /invalid_fal_endpoint_id/);
  assert.throws(() => adapter.prepare(input, new Headers(), route, new URLSearchParams("webhook=https://other.example")), /unsupported_fal_queue_query/);
});

test("every published control is lifecycle-owned and declaration mutations cannot expose unbound access", () => {
  for (const change of [m => { delete m.endpoints.queue.lifecycle; }, m => { m.capabilities.push({ id: "media.prediction.read", endpoint: "queue_status", methods: ["GET"] }); },
    m => { m.endpoints.queue_cancel.method = "DELETE"; }, m => { m.endpoints.queue_result.path += "/result"; },
    m => { m.endpoints.queue.path += "/${extra}"; m.endpoints.queue.pathParams.push("extra"); },
    m => { m.endpoints.queue.pathParamStyles = { variant: "relative_path" }; }]) {
    const invalid = structuredClone(source); change(invalid); assert.throws(() => compileProviderSnapshot([invalid]), /lifecycle|invalid manifest/);
  }
});

test("declared native lifecycle preserves pending/result/cancel uncertainty with original scoped paths", async () => {
  const adapter = managedLifecycleAdapter("fal.queue"), params = { owner: "fal-ai", app: "flux", variant: "schnell" };
  const context = { action: "retrieve", expectedId: wire.requestId, requestedVersion: wire.endpointId, pathParams: params };
  const completed = await adapter.read(Response.json(wire.observations.completed), context);
  assert.equal(completed.terminal, null); assert.equal(completed.followUp, "result");
  const result = await adapter.read(Response.json(wire.results.success.body), { ...context, action: "result" });
  assert.equal(result.terminal, "succeeded"); assert.equal(result.id, wire.requestId); assert.equal(result.actualCostMicros, undefined);
  const cancel = wire.cancelAcks.find(value => value.httpStatus === 202);
  const ack = await adapter.read(Response.json(cancel.body, { status: cancel.httpStatus }), { ...context, action: "cancel" });
  assert.equal(ack.terminal, null); assert.equal(ack.followUp, "retrieve");
  const observed = await adapter.read(Response.json(wire.observations.hostileUrls), context);
  const rewritten = adapter.rewrite(observed, managedPaths(provider, create, wire.requestId, params));
  assert.equal(rewritten.status_url, `/v1/native/fal/fal-ai/flux/requests/${wire.requestId}/status`);
  assert.equal(rewritten.response_url, `/v1/native/fal/fal-ai/flux/requests/${wire.requestId}`);
  assert.equal(rewritten.cancel_url, `/v1/native/fal/fal-ai/flux/requests/${wire.requestId}/cancel`);
});
