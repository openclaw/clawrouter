import assert from "node:assert/strict";
import test from "node:test";
import { googleContinuationFixture as setup, googleOriginalRequest as original } from "./google-continuation-fixture.mjs";
const { estimateCost, createProxyAccounting, accountingReceipt } = await import("../proxy-accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { validateSelectedInput } = await import("../proxy-selection.ts");

for (const stream of [false, true]) for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`Google image output cannot use generic ${stream ? "SSE" : "JSON"}/${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"} text dispatch`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { stream, manifest, pooled });
    for (const body of [
      { ...original, generationConfig: { responseModalities: ["TEXT", "IMAGE"] } },
      { ...original, generation_config: { response_modalities: [2] } },
      { ...original, generationConfig: { responseModalities: ["TEXT"], response_modalities: ["IMAGE"] } },
    ]) {
      const response = await f.request(body), result = await response.json();
      assert.equal(response.status, 400); assert.equal(result.error.code, "native_image_route_required");
    }
    assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
  });
}

for (const model of ["gemini-3.1-flash-image", "gemini-3-pro-image"]) for (const stream of [false, true]) for (const manifest of [false, true]) {
  test(`selected ${model} cannot borrow generic ${stream ? "SSE" : "JSON"}/${manifest ? "manifest" : "native"} text rates when modalities are omitted`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { stream, manifest, fixed: null });
    // Deliberately retain a text card's rates/capability to reproduce the
    // classification defect, without adding or activating any provider rows.
    f.model.id = `google-gemini/${model}`; f.model.upstream = model;
    const response = await f.request(original), result = await response.json();
    assert.equal(response.status, 400); assert.equal(result.error.code, "native_image_route_required");
    assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
  });
}

for (const stream of [false, true]) for (const manifest of [false, true]) test(`Google text and inline image understanding remain distinct on ${stream ? "SSE" : "JSON"}/${manifest ? "manifest" : "native"}`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { stream, manifest });
  delete f.output.candidates[0].continuationToken; f.output.candidates[0].finishReason = "STOP";
  const body = { ...structuredClone(original), generation_config: { response_modalities: ["TEXT"] } };
  body.contents[0].parts.push({ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
  const response = await f.request(body); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), f.wire()); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].clone().json(), body);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "policy_fixed");
});

test("explicit Google image declarations remain closed until the actual qualified response wrapper is wired", async t => {
  const f = await setup(t), endpoint = { ...f.provider.endpoints.find(item => item.id === "generate_content"), request_format: "google.image_generate", response_format: "google.image" };
  const selection = { provider: f.provider, endpoint, model: f.model, body: original, method: "POST", capability: "image.generate", pathParams: { model: f.model.upstream } };
  assert.throws(() => validateSelectedInput(selection), error => error.code === "native_image_route_required");
  assert.equal(selection.nativeResponse, undefined); assert.equal(f.sent.length, 0);
});

test("shared admission keeps image intent unpriced while explicit fixed-policy charging stays separate", async t => {
  const f = await setup(t), endpoint = f.provider.endpoints.find(item => item.id === "generate_content");
  for (const [model, body, format] of [
    [{ ...f.model, upstream: "gemini-3-pro-image" }, original, "google.generate_content"],
    [f.model, { ...original, generationConfig: { responseModalities: ["IMAGE"] } }, "google.generate_content"],
    [f.model, original, "google.image_generate"],
  ]) {
    const route = { ...endpoint, request_format: format };
    assert.deepEqual(estimateCost(model, body, null, "image.generate", route),
      { reserveMicros: 0, basis: "unpriced_request", pricingGap: "opaque_input_bound", inputTokens: null, outputTokens: null });
    for (const fixed of [0, 700]) assert.deepEqual(estimateCost(model, body, fixed, "image.generate", route),
      { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
  }
});

test("frozen image classification prevents token-shaped output from creating a tariff in hard, soft or unmetered settlement", async t => {
  const f = await setup(t), endpoint = f.provider.endpoints.find(item => item.id === "generate_content");
  const body = { ...original, generationConfig: { responseModalities: ["IMAGE"] } };
  const accounting = createProxyAccounting({ env: f.env, context: { waitUntil() {} }, request: correlateIngressRequest(new Request("https://router.example")).request,
    auth: { credentialId: "fixture", principalId: null, policyId: "fixture", policy: { ...f.policy, requestCostMicros: null }, authType: "proxy_key" },
    selection: { provider: f.provider, endpoint, model: f.model, body, method: "POST", capability: "llm.messages", pathParams: { model: f.model.upstream } } });
  assert.equal(accounting.facts.googleImage, true);
  body.generationConfig.responseModalities = ["TEXT"]; // Later mutation cannot erase the frozen evidence.
  for (const reservation of [{ reservedMicros: 900, reservations: [] }, { reservedMicros: 900, reservations: [], charges: [] }, { reservedMicros: 0, reservations: [] }]) {
    const outcome = { occurredAtMs: Date.now(), statusCode: 200, status: "success", billable: true, contentRef: null,
      tokens: { input: 500, output: 1000, total: 1500 }, reservation };
    const event = accountingReceipt(accounting.facts, outcome);
    assert.equal(event.cost_basis, "unpriced_usage"); assert.equal(event.actual_cost_micros, reservation.reservedMicros);
    assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null);
    assert.equal(event.pricing_ref, null);
    const unsent = accountingReceipt(accounting.facts, { ...outcome, billable: false });
    assert.equal(unsent.actual_cost_micros, 0); assert.equal(unsent.cost_basis, "none");
  }
});
