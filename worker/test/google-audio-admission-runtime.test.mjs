import assert from "node:assert/strict";
import test from "node:test";
import { googleContinuationFixture as setup, googleOriginalRequest as original } from "./google-continuation-fixture.mjs";
const { createProxyAccounting, accountingReceipt } = await import("../proxy-accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { validateSelectedInput } = await import("../proxy-selection.ts");

for (const stream of [false, true]) for (const manifest of [false, true]) for (const pooled of [false, true]) {
  test(`Google AUDIO output cannot use generic ${stream ? "SSE" : "JSON"}/${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"} dispatch`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { stream, manifest, pooled });
    for (const body of [
      { ...original, generationConfig: { responseModalities: ["AUDIO", "TEXT"] } },
      { ...original, generation_config: { response_modalities: [3] } },
      { ...original, generationConfig: { responseModalities: ["TEXT"], response_modalities: ["AUDIO"] } },
    ]) {
      const response = await f.request(body); assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "native_audio_route_required");
    }
    assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
  });
}

for (const model of ["lyria-3-clip-preview", "lyria-3-pro-preview", "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"])
  for (const stream of [false, true]) for (const manifest of [false, true]) {
    test(`selected ${model} cannot borrow generic ${stream ? "SSE" : "JSON"}/${manifest ? "manifest" : "native"} text behavior without modalities`, { timeout: 10_000 }, async t => {
      const f = await setup(t, { stream, manifest, fixed: null });
      // Reproduce an accidental text declaration without activating audio rows.
      f.model.id = `google/${model}`; f.model.upstream = model;
      const response = await f.request(original); assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "native_audio_route_required");
      assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
    });
  }

for (const stream of [false, true]) for (const manifest of [false, true]) test(`inline audio understanding remains distinct on ${stream ? "SSE" : "JSON"}/${manifest ? "manifest" : "native"} text output`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { stream, manifest });
  delete f.output.candidates[0].continuationToken; f.output.candidates[0].finishReason = "STOP";
  const body = { ...structuredClone(original), generation_config: { response_modalities: ["TEXT"] } };
  body.contents[0].parts.push({ inlineData: { mimeType: "audio/wav", data: "UklGRg==" } });
  const response = await f.request(body); assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  assert.equal(await response.text(), f.wire()); await f.drain();
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].clone().json(), body);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "policy_fixed");
});

test("explicit audio formats stay closed until their actual native wrappers are wired", async t => {
  const f = await setup(t), base = f.provider.endpoints.find(value => value.id === "generate_content");
  for (const format of ["google.music_generate", "google.speech_generate_content", "google.speech_interactions"]) {
    const selection = { provider: f.provider, endpoint: { ...base, request_format: format }, model: f.model,
      body: original, method: "POST", capability: "audio.generate", pathParams: { model: f.model.upstream } };
    assert.throws(() => validateSelectedInput(selection), error => error.code === "native_audio_route_required");
    assert.equal(selection.nativeResponse, undefined);
  }
  assert.equal(f.sent.length, 0);
});

test("frozen audio intent cannot turn native token-shaped output into a text invoice or an uncertain refund", async t => {
  const f = await setup(t), endpoint = f.provider.endpoints.find(value => value.id === "generate_content");
  const body = { ...original, generationConfig: { responseModalities: ["AUDIO"] } };
  const accounting = createProxyAccounting({ env: f.env, context: { waitUntil() {} }, request: correlateIngressRequest(new Request("https://router.example")).request,
    auth: { credentialId: "fixture", principalId: null, policyId: "fixture", policy: { ...f.policy, requestCostMicros: null }, authType: "proxy_key" },
    selection: { provider: f.provider, endpoint, model: f.model, body, method: "POST", capability: "llm.generate", pathParams: { model: f.model.upstream } } });
  assert.equal(accounting.facts.googleAudio, true); assert.equal(accounting.facts.googleImage, false);
  body.generationConfig.responseModalities = ["TEXT"];
  for (const reservation of [{ reservedMicros: 900, reservations: [] }, { reservedMicros: 900, reservations: [], charges: [] }, { reservedMicros: 0, reservations: [] }]) {
    const outcome = { occurredAtMs: Date.now(), statusCode: 200, status: "success", billable: true, contentRef: null,
      tokens: { input: 500, output: 1000, total: 1500 }, reservation };
    const event = accountingReceipt(accounting.facts, outcome);
    assert.equal(event.cost_basis, "unpriced_usage"); assert.equal(event.actual_cost_micros, reservation.reservedMicros);
    assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.total_tokens, null); assert.equal(event.pricing_ref, null);
    const unsent = accountingReceipt(accounting.facts, { ...outcome, billable: false });
    assert.equal(unsent.actual_cost_micros, 0); assert.equal(unsent.cost_basis, "none");
  }
});
