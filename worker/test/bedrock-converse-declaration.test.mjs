import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { eventFrame } from "./bedrock-eventstream-fixture.mjs";
const { createRouteCatalog, modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const source = parse(readFileSync(new URL("../../providers/aws-bedrock.provider.yaml", import.meta.url), "utf8"));
const upstream = "amazon.nova-lite-v1:0", id = `bedrock/${upstream}`, region = "us-east-1";
const origin = `https://bedrock-runtime.${region}.amazonaws.com`;
const formats = [["converse", "aws_bedrock.converse", "aws_bedrock.converse"],
  ["converse_stream", "aws_bedrock.converse_stream", "aws_bedrock.converse_eventstream"]];
const input = () => ({ messages: [{ role: "user", content: [{ text: "synthetic Nova request" }] }], inferenceConfig: { maxTokens: 16 } });
const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const reply = { output: { message: { role: "assistant", content: [{ text: "synthetic Nova answer" }] } }, stopReason: "end_turn", usage };
const frame = (kind, value) => eventFrame(value, { ":message-type": "event", ":event-type": kind, ":content-type": "application/json" });
const stream = () => Buffer.concat([
  frame("messageStart", { role: "assistant" }), frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "synthetic Nova answer" } }),
  frame("contentBlockStop", { contentBlockIndex: 0 }), frame("messageStop", { stopReason: "end_turn" }), frame("metadata", { usage }),
]);
const compiled = () => compileProviderSnapshot([source]).providers[0];
async function setup(t, { fixed = 700, pooled = false } = {}) {
  const f = await fixture(t, { fixed, pooled, providerId: "aws-bedrock", compiledProvider: true,
    configure: provider => Object.assign(provider, compiled()) });
  Object.assign(f.env, { AWS_ACCESS_KEY_ID: "synthetic-env-access", AWS_SECRET_ACCESS_KEY: "synthetic-env-secret",
    AWS_SESSION_TOKEN: "synthetic-env-session", AWS_REGION: region });
  if (pooled) {
    await putGrantCredentials(f.env, grantKey, { provider: "aws-bedrock", kind: "api_key", enabled: true,
      credentials: { accessKeyId: "synthetic-grant-access", secretAccessKey: "synthetic-grant-secret", sessionToken: "synthetic-grant-session" } });
    f.policy.grantRouting = { eligibleGrants: { "aws-bedrock": ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.send = (streaming, manifest) => {
    const endpoint = streaming ? "converse_stream" : "converse", suffix = streaming ? "converse-stream" : "converse";
    const body = { ...input(), modelId: upstream, stream: streaming };
    return f.call(manifest ? `/v1/proxy/aws-bedrock/${endpoint}` : `/v1/native/aws-bedrock/model/${encodeURIComponent(upstream)}/${suffix}`,
      manifest ? { body, pathParams: { model: upstream } } : body, { headers: {
        "x-amz-security-token": "synthetic-caller-session", "x-amz-content-sha256": "caller-hash", "x-api-key": "synthetic-caller-key",
      } });
  };
  f.upstream = request => request.url.endsWith("/converse-stream")
    ? new Response(stream(), { headers: { "content-type": "application/vnd.amazon.eventstream" } }) : Response.json(reply);
  t.after(f.drain); return f;
}

test("bundled Converse grants only the existing bare Nova Lite card while preserving both Invoke routes", () => {
  const before = structuredClone(source);
  for (const [endpoint] of formats) delete before.endpoints[endpoint];
  before.capabilities = before.capabilities.filter(capability => !formats.some(([endpoint]) => endpoint === capability.endpoint));
  for (const model of before.models.entries) model.capabilities = model.capabilities.filter(capability => capability !== "llm.chat");
  const provider = compiled(), original = compileProviderSnapshot([before]).providers[0];
  for (const endpoint of original.endpoints) assert.deepEqual(provider.endpoints.find(value => value.id === endpoint.id), endpoint);
  assert.deepEqual(provider.auth, original.auth); assert.deepEqual(provider.adapter, original.adapter); assert.deepEqual(provider.base_urls, original.base_urls);
  assert.deepEqual(provider.models.filter(model => model.capabilities.includes("llm.chat")).map(model => [model.id, model.upstream]), [[id, upstream]]);
  const model = provider.models.find(model => model.id === id); assert.ok(model); assert.equal(model.pricing, null); assert.equal(model.nativeCapabilities, undefined);
  assert.deepEqual(model.capabilities, ["llm.invoke", "llm.stream", "llm.chat"]);
  for (const [endpointId, requestFormat, responseFormat] of formats) {
    const endpoint = provider.endpoints.find(value => value.id === endpointId);
    assert.equal(endpoint.method, "POST"); assert.equal(endpoint.request_format, requestFormat); assert.equal(endpoint.response_format, responseFormat);
    assert.equal(endpoint.streaming, null, "ConverseStream delivers a complete quarantined EventStream");
    assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.requestPricing, undefined);
    assert.deepEqual(endpoint.path_param_styles, { model: "opaque_segment" }); assert.deepEqual(endpoint.query, {});
    assert.ok(modelSupportsEndpoint(provider, model, endpoint));
    assert.equal(modelSupportsEndpoint(provider, { ...model, capabilities: ["llm.invoke", "llm.stream"] }, endpoint), false);
  }
  assert.deepEqual(createRouteCatalog([provider]).openaiCompatible, []);
});

for (const streaming of [false, true]) for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`Nova Lite compiled ${streaming ? "ConverseStream" : "Converse"}/${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"} selects the bare card before signing`, async t => {
    const f = await setup(t, { pooled }), body = input(), expected = streaming ? stream() : null;
    f.upstream = async request => {
      assert.equal(request.url, `${origin}/model/${encodeURIComponent(upstream)}/${streaming ? "converse-stream" : "converse"}`);
      assert.equal(request.method, "POST"); assert.equal(request.redirect, "manual");
      const payload = await request.text(); assert.deepEqual(JSON.parse(payload), body);
      assert.equal(request.headers.get("x-amz-content-sha256"), createHash("sha256").update(payload).digest("hex"));
      assert.match(request.headers.get("authorization"), new RegExp(`^AWS4-HMAC-SHA256 Credential=synthetic-${pooled ? "grant" : "env"}-access/\\d{8}/${region}/bedrock/aws4_request,`));
      assert.equal(request.headers.get("x-amz-security-token"), `synthetic-${pooled ? "grant" : "env"}-session`);
      assert.equal(request.headers.get("x-api-key"), null);
      assert.equal(request.headers.get("accept"), streaming ? "application/vnd.amazon.eventstream" : "application/json");
      assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
      assert.equal(f.rows().length, 2); assert.ok(f.rows().every(row => row.dispatch_started === 1 && row.settled === 0));
      return streaming ? new Response(expected, { headers: { "content-type": "application/vnd.amazon.eventstream" } }) : Response.json(reply);
    };
    const response = await f.send(streaming, manifest); assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    if (streaming) assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected); else assert.deepEqual(await response.json(), reply);
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
    const events = await f.events(); assert.equal(events.length, 1); const event = events[0];
    assert.equal(event.model, id); assert.equal(event.capability, "llm.chat");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [10, 2, 12]);
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 700);
    assert.ok(f.rows().every(row => row.settled === 1));
  });
}

for (const streaming of [false, true]) for (const manifest of [false, true]) test(`Nova Lite unknown tariff denies ${streaming ? "stream" : "unary"}/${manifest ? "manifest" : "native"} before egress`, async t => {
  const f = await setup(t, { fixed: null }), response = await f.send(streaming, manifest);
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0); assert.equal(bodyBudgetCharged(), 0);
});

for (const streaming of [false, true]) test("Invoke capability alone cannot admit Nova Lite " + (streaming ? "ConverseStream" : "Converse"), async t => {
  const f = await setup(t); f.provider.models.find(model => model.id === id).capabilities = ["llm.invoke", "llm.stream"];
  const response = await f.send(streaming, false); assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "model_capability_unsupported"); assert.equal(f.sent.length, 0);
});

test("actual Nova Lite catalog exposes only the two qualified native Chat operations without a provider alias", async t => {
  const f = await setup(t), response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
  const provider = (await response.json()).providers.find(value => value.id === "aws-bedrock");
  for (const [endpoint, requestFormat, responseFormat] of formats) {
    const offer = provider.offers.find(value => value.endpoint === endpoint && value.modelId === id);
    assert.ok(offer?.eligible); assert.equal(offer.routeKind, "native");
    const route = provider.routes.find(value => value.endpoint === endpoint);
    assert.equal(route.requestFormat, requestFormat); assert.equal(route.responseFormat, responseFormat);
  }
  assert.equal(f.sent.length, 0);
});
