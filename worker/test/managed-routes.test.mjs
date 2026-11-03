import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { managedRoute, managedPaths, managedControlIdentity } from "../managed-routes.ts";
import { managedJobKey, managedPredictionKey } from "../managed-prediction-identity.ts";
const routes = JSON.parse(readFileSync(new URL("../../providers/_fixtures/media/managed-routes.json", import.meta.url))).protocols;
const id = "11111111-2222-4333-8444-555555555555";
function fixture(route) {
  const create = { id: "create", method: "POST", request_format: route.requestFormat, lifecycle: { protocol: route.protocol, retrieve: "retrieve" } };
  const endpoints = [create];
  for (const action of ["retrieve", "result", "cancel"]) if (route[action]) {
    create.lifecycle[action] = action; endpoints.push({ ...route[action], id: action, query: {}, headers: {}, native_proxy: true });
  }
  return { provider: { id: "configured-provider", endpoints }, create };
}
for (const route of routes) test(`${route.protocol}: qualified control paths and exact IDs use the configured provider`, async () => {
  const { provider, create } = fixture(route), paths = managedPaths(provider, create, id, route.pathParams);
  for (const path of Object.values(paths)) assert.ok(path.startsWith("/v1/native/configured-provider/"));
  assert.equal(!!paths.result, !!route.result); assert.equal(!!paths.cancel, !!route.cancel);
  const params = route.protocol === "kie.jobs" ? {} : route.protocol === "fal.queue" ? { owner: "fal-ai", app: "flux", request_id: id }
    : { [route.protocol === "replicate.predictions" ? "prediction_id" : "job_id"]: id };
  const query = route.identityQuery ? new URLSearchParams([[route.identityQuery, id]]) : new URLSearchParams();
  assert.equal(await managedControlIdentity(route.protocol, "retrieve", params, query), id);
  query.append("unexpected", "value"); await assert.rejects(managedControlIdentity(route.protocol, "retrieve", params, query));
  provider.endpoints[1].native_proxy = false; assert.throws(() => managedRoute(provider, create));
  provider.endpoints[1].native_proxy = true;
  create.modelPassthrough = {}; assert.throws(() => managedRoute(provider, create));
});

test("missing result/cancel links and unsupported Kie cancellation fail closed", () => {
  for (const route of routes) {
    const { provider, create } = fixture(route);
    if (route.cancel) delete create.lifecycle.cancel;
    else create.lifecycle.cancel = "retrieve";
    assert.throws(() => managedRoute(provider, create));
  }
  const { provider, create } = fixture(routes.find(route => route.protocol === "fal.queue"));
  delete create.lifecycle.result; assert.throws(() => managedRoute(provider, create));
});

test("job identity separates protocols/providers and preserves already-issued Replicate bindings", async () => {
  const values = await Promise.all(routes.flatMap(route => ["one", "two"].map(provider => managedJobKey(route.protocol, provider, id))));
  assert.equal(new Set(values).size, 8);
  assert.equal(await managedJobKey("replicate.predictions", "replicate", id), await managedPredictionKey(id));
});


test("already-issued Replicate route digest remains compatible across the shared controller upgrade", async () => {
  const { responseRouteDigest } = await import("../responses-control-dispatch.ts");
  const { sha256Hex } = await import("../utils.ts");
  const { provider, create } = fixture(routes[0]);
  provider.auth = { schemes: [{ type: "bearer" }] }; provider.adapter = { passthroughHeaders: [] };
  const upstream = { headers: new Headers({ authorization: "Bearer synthetic-environment-key" }), query: new URLSearchParams(), grant: null, transport: null };
  const url = new URL("https://api.example/v1/predictions");
  const identity = await sha256Hex(JSON.stringify([[...upstream.headers], [...upstream.query]]));
  const oldDigest = await sha256Hex(JSON.stringify(["POST", url.href, identity, [], "replicate.predictions",
    ["GET", "/v1/predictions/owner-pin", [], []], ["POST", "/v1/predictions/owner-pin/cancel", [], []]]));
  assert.equal(await responseRouteDigest(provider, upstream, url, new Headers(), null, create.lifecycle, {}), oldDigest);
});
