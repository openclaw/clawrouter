import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { actualCharacterCost, actualModelCost, estimateModelCost, modelReservationBounds } = await import("../pricing.ts");
const { createProxyAccounting, estimateCost } = await import("../proxy-accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");

const pricing = { unit: "character", effectiveAt: "2026-09-24", source: "https://developers.openai.com/api/docs/models/tts-1", inputMicrosPerMillionCharacters: 15_000_000, maxInputCharacters: 4096 };
const endpoint = { request_format: "openai.audio_speech", response_format: "audio.binary" };

test("speech reserves UTF-8 bytes but estimates completed Unicode code points without tokens", () => {
  for (const [input, bytes, points] of [["hello", 5, 5], ["é", 2, 1], ["😀", 4, 1], ["e\u0301", 3, 2], ["😀".repeat(4096), 16384, 4096]]) {
    assert.deepEqual(estimateModelCost(pricing, { input }, endpoint), { reserveMicros: bytes * 15, inputTokens: null, outputTokens: null });
    assert.equal(actualCharacterCost(pricing, input), points * 15);
  }
  assert.deepEqual(estimateModelCost(pricing, {}, endpoint), { reserveMicros: 245760, inputTokens: null, outputTokens: null });
  assert.deepEqual(modelReservationBounds(pricing), { minimumMicros: 15, zero: false });
  assert.deepEqual(modelReservationBounds({ ...pricing, inputMicrosPerMillionCharacters: 0 }), { minimumMicros: 0, zero: true });
  assert.equal(actualModelCost(pricing, { input: 100, output: 2, billable: false }), null, "token-shaped data cannot settle character pricing");
  assert.equal(actualCharacterCost(null, "text"), null);
  assert.equal(actualCharacterCost(pricing, undefined), null);
  assert.equal(estimateCost({ pricing }, { input: "😀" }, 0, "audio.speech", endpoint).reserveMicros, 0);
});

for (const scenario of [
  { name: "qualified binary completion", complete: true, actual: 15, basis: "request_character_estimate" },
  { name: "unknown completion", actual: 60, basis: "manifest_reservation" },
  { name: "cancellation", complete: true, delivery: "canceled", termination: "client_error", actual: 60, basis: "manifest_reservation" },
  { name: "failed delivery", complete: true, delivery: "failed", termination: "provider_error", actual: 60, basis: "manifest_reservation" },
  { name: "known HTTP rejection", complete: true, status: 400, actual: 0, basis: "none" },
  { name: "fixed zero", complete: true, fixed: 0, actual: 0, basis: "policy_fixed" },
  { name: "fixed positive", complete: true, fixed: 7, actual: 7, basis: "policy_fixed" },
]) test(`speech accounting: ${scenario.name}`, async () => {
  const events = [];
  const owner = createProxyAccounting({
    env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: {},
    auth: { policyId: "fixture", policy: { requestCostMicros: scenario.fixed ?? null } },
    selection: { provider: { id: "openai" }, model: { id: "openai/tts-1", pricing }, endpoint, capability: "audio.speech", body: { input: "😀" } },
    request: correlateIngressRequest(new Request("https://router.example/v1/audio/speech")).request,
  });
  await owner.complete(new Response(null, { status: scenario.status ?? 200 }), {
    tokens: null, outcome: null, delivery: scenario.delivery ?? "complete", ...(scenario.complete ? { binaryComplete: true } : {}),
  }, { reservations: [], reservedMicros: owner.cost.reserveMicros }, null, scenario.termination);
  assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, scenario.actual);
  assert.equal(events[0].cost_basis, scenario.basis);
  for (const field of ["input_tokens", "output_tokens", "total_tokens", "reserved_input_tokens", "reserved_output_tokens"]) assert.equal(events[0][field], null, field);
});
