import assert from "node:assert/strict";
import test from "node:test";
import { grantSupports, assertOperationConfiguration } from "../provider-auth.ts";
import { backgroundResponse, requireEmptyResponseControlBody, responsesControl, responsesControlQuery } from "../responses-lifecycle.ts";

const endpoint = (id, path, method = "POST") => ({ id, path, method, path_params: method === "GET" ? ["response_id"] : [], headers: {}, query: {}, request_format: "openai.responses", response_format: "openai.responses" });
const create = { ...endpoint("generate", "/v1/responses"), responsesLifecycle: { retrieve: "inspect", cancel: "stop" } };
const retrieve = endpoint("inspect", "/v1/responses/${response_id}", "GET");
const cancel = { ...endpoint("stop", "/v1/responses/${response_id}/cancel"), path_params: ["response_id"] };
const provider = { id: "arbitrary-provider", endpoints: [create, retrieve, cancel], config_keys: ["FIXTURE_API_KEY"], base_urls: { default: "https://provider.example" }, adapter: { injectHeaders: {}, injectQuery: {} }, auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: { subscription: { allowedEndpoints: ["generate"], headers: {}, appendHeaders: {}, endpointPaths: {} } } } };

test("linked controls belong to their create operation without provider or endpoint name assumptions", () => {
  assert.deepEqual(responsesControl(provider, retrieve), { create, action: "retrieve" });
  assert.deepEqual(responsesControl(provider, cancel), { create, action: "cancel" });
  assert.equal(responsesControl(provider, create), null);
  assert.equal(responsesControl(provider, endpoint("unrelated", "/other")), null);
  assert.equal(backgroundResponse(create, { background: true }), true);
  for (const body of [{}, { background: "true" }, [{ background: true }]]) assert.equal(backgroundResponse(create, body), false);
  assert.equal(backgroundResponse({ ...create, request_format: "other" }, { background: true }), false);
});

test("background admission requires one selected transport to support create and both controls", () => {
  const ordinary = { provider, endpoint: create, mode: "http" }, background = { ...ordinary, background: true };
  assert.equal(grantSupports(ordinary, { kind: "subscription" }), true);
  assert.equal(grantSupports(background, { kind: "subscription" }), false);
  assert.equal(grantSupports(background, { kind: "api_key" }), true);
  assert.equal(grantSupports({ ...background, mode: "websocket" }, null), false);
  assert.equal(grantSupports({ ...background, endpoint: { ...create, responsesLifecycle: undefined } }, null), false);
  for (const allowedEndpoints of [["generate", "inspect"], ["generate", "stop"], ["inspect", "stop"]]) {
    const changed = { ...provider, auth: { ...provider.auth, grantTransports: { subscription: { ...provider.auth.grantTransports.subscription, allowedEndpoints } } } };
    assert.equal(grantSupports({ ...background, provider: changed }, { kind: "subscription" }), false);
  }
  assert.doesNotThrow(() => assertOperationConfiguration(background, null, { FIXTURE_API_KEY: "synthetic-key" }));
  assert.throws(() => assertOperationConfiguration(background, { kind: "subscription", accessToken: "synthetic-key" }, {}), error => error.code === "grant_transport_unavailable");
  const broken = { ...provider, endpoints: [create, { ...retrieve, headers: { "bad header": "invalid" } }, cancel] };
  assert.throws(() => assertOperationConfiguration({ ...background, provider: broken }, null, { FIXTURE_API_KEY: "synthetic-key" }), error => error.code === "provider_request_invalid");
});

test("retrieve query keeps repeated includes and resume fields in native and manifest forms", () => {
  const encoded = "include%5B%5D=reasoning.encrypted_content&include%5B%5D=message.output_text.logprobs&stream=true&starting_after=12&include_obfuscation=false";
  assert.equal(responsesControlQuery("retrieve", new URLSearchParams(encoded)).toString(), encoded);
  assert.equal(responsesControlQuery("retrieve", { include: ["reasoning.encrypted_content", "message.output_text.logprobs"], stream: true, starting_after: 12, include_obfuscation: false }).toString(), encoded);
  assert.equal(responsesControlQuery("cancel", {}).toString(), "");
});

test("bodyless control query rejects ambiguous, unbounded and unsupported fields", () => {
  for (const query of [new URLSearchParams("stream=true&stream=false"), { include: ["x".repeat(129)] }, { include: Array(33).fill("x") }, { stream: 1 }, { stream: [] }, { starting_after: -1 }, { starting_after: 1.5 }, { starting_after: [1] }, { starting_after: Number.MAX_SAFE_INTEGER + 1 }, { token: "not-forwarded" }, { model: "not-a-create" }]) {
    assert.throws(() => responsesControlQuery("retrieve", query), error => error.code === "invalid_response_query");
  }
  assert.throws(() => responsesControlQuery("cancel", { stream: true }), error => error.code === "invalid_response_query");
});

test("control bodies accept observed empty EOF and reject the first byte without draining", async () => {
  await requireEmptyResponseControlBody(new Request("https://router.example", { method: "POST", body: "" }));
  let canceled = 0, reads = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array([1])); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  await assert.rejects(requireEmptyResponseControlBody(new Request("https://router.example", { method: "POST", body, duplex: "half" })), error => error.code === "invalid_response_control");
  assert.equal(reads, 1); assert.equal(canceled, 1); assert.equal(body.locked, false);
});

test("stalled or canceled control bodies release their reader and cannot authorize dispatch", { timeout: 2000 }, async t => {
  for (const cause of ["caller", "deadline"]) {
    if (cause === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
    let canceled = 0;
    const body = new ReadableStream({ cancel() { canceled++; } }), controller = new AbortController();
    const pending = requireEmptyResponseControlBody(new Request("https://router.example", { method: "POST", body, duplex: "half", signal: controller.signal }));
    const rejected = assert.rejects(pending);
    if (cause === "caller") controller.abort(); else t.mock.timers.tick(10_000);
    await rejected; assert.equal(canceled, 1); assert.equal(body.locked, false);
  }
});
