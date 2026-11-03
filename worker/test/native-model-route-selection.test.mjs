import assert from "node:assert/strict";
import test from "node:test";
import { googleContinuationFixture as setup, googleOriginalRequest as original } from "./google-continuation-fixture.mjs";
const { nativeModelEndpoint } = await import("../proxy-selection.ts");

function routes(f, reverse = false) {
  const first = f.provider.endpoints.find(endpoint => endpoint.id === "generate_content");
  const second = structuredClone(first);
  second.id = "fixture_selected"; second.modelPassthrough = undefined;
  first.headers["x-fixture-route"] = "generic"; second.headers["x-fixture-route"] = "selected";
  const selected = { id: "llm.fixture_selected", endpoint: second.id, methods: ["POST"] };
  f.provider.capabilities.push(selected);
  f.model.capabilities = [selected.id];
  f.provider.endpoints = [first, second, ...f.provider.endpoints.filter(endpoint => endpoint !== first)];
  if (reverse) [f.provider.endpoints[0], f.provider.endpoints[1]] = [second, first];
  delete f.output.candidates[0].continuationToken; f.output.candidates[0].finishReason = "STOP";
  return { first, second, path: `/v1beta/models/${f.model.upstream}:generateContent`, matching: reverse ? [second, first] : [first, second] };
}

for (const reverse of [false, true]) for (const pooled of [false, true]) test(`native model capability selects its unique endpoint with ${reverse ? "reversed" : "original"} declarations and ${pooled ? "grant" : "environment"} credentials`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled }), r = routes(f, reverse);
  assert.equal(nativeModelEndpoint(f.provider, r.matching, r.path, "POST"), r.second);
  const response = await f.request(original); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), f.wire()); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("x-fixture-route"), "selected");
  assert.equal(f.sent[0].headers.get("x-goog-api-key"), pooled ? "synthetic-original-key" : "synthetic-google-environment");
  assert.equal(f.sent[0].url, "https://generativelanguage.googleapis.com" + r.path);
  assert.equal(f.sent[0].redirect, "manual"); assert.deepEqual(await f.sent[0].clone().json(), original);
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].capability, "llm.fixture_selected"); assert.equal(events[0].actual_cost_micros, 700);
});

test("ambiguous registered native operations deny after authentication without body-based guessing", { timeout: 10_000 }, async t => {
  const f = await setup(t), r = routes(f); f.model.capabilities.push("llm.generate");
  assert.throws(() => nativeModelEndpoint(f.provider, r.matching, r.path, "POST"), error => error.code === "native_route_ambiguous");
  const invalid = await f.request(original, { headers: { authorization: "Bearer synthetic-invalid" } }); assert.equal(invalid.status, 401);
  const response = await f.request({ ...original, desiredEndpoint: "fixture_selected" });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "native_route_ambiguous");
  assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
});

test("router aliases do not select an overlapping upstream-native operation", { timeout: 10_000 }, async t => {
  const f = await setup(t), r = routes(f);
  assert.throws(() => nativeModelEndpoint(f.provider, r.matching, `/v1beta/models/${encodeURIComponent(f.model.id)}:generateContent`, "POST"),
    error => error.code === "native_model_alias_unsupported");
  const response = await f.request(original, { model: encodeURIComponent(f.model.id) });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "native_model_alias_unsupported");
  assert.equal(f.sent.length, 0);
});

test("unknown models retain the existing passthrough endpoint while stopped known models remain denied", { timeout: 10_000 }, async t => {
  const f = await setup(t), r = routes(f);
  assert.equal(nativeModelEndpoint(f.provider, r.matching, "/v1beta/models/unregistered-fixture:generateContent", "POST"), undefined);
  const unknown = await f.request(original, { model: "unregistered-fixture" }); assert.equal(unknown.status, 200, await unknown.clone().text());
  await unknown.text(); assert.equal(f.sent[0].headers.get("x-fixture-route"), "generic");
  f.model.availability = { status: "stopped" };
  const stopped = await f.request(original); assert.equal(stopped.status, 400);
  assert.equal(f.sent.length, 1);
});

test("disabled native endpoints and wrong methods cannot become model-selected routes", async t => {
  const f = await setup(t), r = routes(f);
  r.second.native_proxy = false; assert.equal(nativeModelEndpoint(f.provider, r.matching, r.path, "POST"), undefined);
  r.second.native_proxy = true; r.second.methods = ["GET"];
  assert.equal(nativeModelEndpoint(f.provider, r.matching, r.path, "POST"), undefined);
});

test("managed controls, WebSocket bindings and paths without a catalog model keep their existing resolver", async t => {
  const f = await setup(t), r = routes(f);
  for (const patch of [{ lifecycle: { protocol: "replicate.predictions" } }, { responsesLifecycle: {} }, { websocket: "openai.responses" }, { path_params: ["job_id"] }]) {
    const second = { ...r.second, ...patch };
    assert.equal(nativeModelEndpoint(f.provider, [r.first, second], r.path, "POST"), undefined);
  }
});

test("single-endpoint native alias behavior is unchanged", async t => {
  const f = await setup(t), r = routes(f);
  assert.equal(nativeModelEndpoint(f.provider, [r.first], `/v1beta/models/${encodeURIComponent(f.model.id)}:generateContent`, "POST"), undefined);
});
