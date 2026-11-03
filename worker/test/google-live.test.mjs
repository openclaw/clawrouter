import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleLiveModels, googleLivePath, prepareGoogleLiveSetup, GoogleLiveConnection } from "../google-live.ts";
const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/live.json", import.meta.url), "utf8"));
const now = Date.parse("2026-11-03T00:00:00Z"), wire = JSON.stringify;
function setup(model = googleLiveModels[1]) {
  const body = structuredClone(fixture.setup); body.setup.model = "models/" + model;
  if (model === googleLiveModels[0]) delete body.setup.tools[0].functionDeclarations[0].behavior;
  return prepareGoogleLiveSetup(body, now);
}
function connection(model) { const value = new GoogleLiveConnection(setup(model)); value.server(wire(fixture.ready)); return value; }
const error = /invalid_google_live_/;

test("Live setup freezes native endpoint/models and rejects retired or unqualified identities", () => {
  assert.equal(googleLivePath, fixture.path); assert.equal(googleLiveModels.length, 4);
  for (const model of googleLiveModels) assert.equal(setup(model).body.setup.model, "models/" + model);
  for (const model of ["gemini-live-2.5-flash-preview", "gemini-3.5-transcribe-live", "google/gemini-3.8-live"]) assert.throws(() => setup(model), error);
  for (const model of [googleLiveModels[0], googleLiveModels[3]]) {
    assert.throws(() => prepareGoogleLiveSetup(setup(model).body, Date.parse("2026-11-17T00:00:00Z")), /model_unqualified/);
    assert.equal(prepareGoogleLiveSetup(setup(model).body, Date.parse("2026-11-16T23:59:59Z")).model, model);
  }
  assert.equal(prepareGoogleLiveSetup(setup().body, Date.parse("2026-11-18T00:00:00Z")).model, googleLiveModels[1]);
});

test("model-specific thinking and function behavior cannot silently change generation contracts", () => {
  const standard = setup().body; standard.setup.generationConfig.thinkingConfig = { thinkingLevel: "HIGH" };
  assert.throws(() => prepareGoogleLiveSetup(standard, now), /thinking_unsupported/);
  const extended = setup(googleLiveModels[2]).body; extended.setup.generationConfig.thinkingConfig = { thinkingLevel: "HIGH" };
  assert.equal(prepareGoogleLiveSetup(extended, now).extendedThinking, true);
  delete extended.setup.tools[0].functionDeclarations[0].behavior;
  assert.throws(() => prepareGoogleLiveSetup(extended, now), /tool_behavior/);
  const sequential = setup(googleLiveModels[0]).body; sequential.setup.tools[0].functionDeclarations[0].behavior = "NON_BLOCKING";
  assert.throws(() => prepareGoogleLiveSetup(sequential, now), /tool_behavior/);
  for (const update of [
    b => { b.setup.sessionResumption.handle = "foreign-session"; },
    b => { b.setup.tools = [{ googleSearch: {} }]; },
    b => { b.setup.generationConfig.responseModalities = ["TEXT"]; },
    b => { b.setup.inputAudioTranscription = { model: "another-billable-product" }; },
  ]) { const body = setup().body; update(body); assert.throws(() => prepareGoogleLiveSetup(body, now), error); }
});

test("setup acknowledgement gates forwarding and silence remains byte-identical", () => {
  const value = new GoogleLiveConnection(setup());
  assert.throws(() => value.client(wire(fixture.input)), /not_ready/);
  assert.throws(() => value.server(wire(fixture.output)), /not_ready/);
  assert.equal(value.server(wire(fixture.ready)).ready, true);
  assert.throws(() => value.server(wire(fixture.ready)), /duplicate_setup/);
  assert.deepEqual(value.client(wire(fixture.input)), fixture.input);
  assert.throws(() => value.client(wire({ realtimeInput: { audioStreamEnd: true } })), error);
  value.close(); assert.throws(() => value.client(wire(fixture.input)), /not_ready/);
  assert.throws(() => value.server(wire(fixture.turnComplete)), /closed/);
});

test("native text and activity frames follow the selected model and VAD mode", () => {
  const text = { realtimeInput: { text: "Hello." } }, turn = { clientContent: { turns: [{ role: "user", parts: [{ text: "Hello." }] }], turnComplete: true } };
  const sequential = connection(googleLiveModels[0]); assert.deepEqual(sequential.client(wire(text)), text);
  assert.throws(() => sequential.client(wire(turn)), error);
  sequential.client(wire({ realtimeInput: { audioStreamEnd: true } }));
  const standard = connection(); assert.deepEqual(standard.client(wire(turn)), turn); assert.throws(() => standard.client(wire(text)), error);
  assert.throws(() => standard.client(wire({ realtimeInput: { activityStart: {} } })), error);
  const manual = setup().body; manual.setup.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };
  const value = new GoogleLiveConnection(prepareGoogleLiveSetup(manual, now)); value.server(wire(fixture.ready));
  for (const key of ["activityStart", "activityEnd"]) value.client(wire({ realtimeInput: { [key]: {} } }));
  assert.throws(() => value.client(wire({ realtimeInput: { audioStreamEnd: true } })), error);
});

test("PCM and transcripts are bounded separately without fabricated response completion or cost", () => {
  const value = connection(), observed = value.server(wire(fixture.output));
  assert.equal(observed.audio[0].decodedBytes, 4); assert.equal(observed.audio[0].base64, "AAECAw==");
  assert.deepEqual(observed.transcripts.map(x => [x.role, x.complete]), [["user", true], ["assistant", true]]);
  assert.equal(observed.responseDone, false); assert.equal(observed.usage, null); assert.equal(observed.costMicros, undefined);
  const legacy = connection(googleLiveModels[3]).server(wire(fixture.output)); assert.equal(legacy.transcripts[0].complete, false);
  const thought = structuredClone(fixture.output); thought.serverContent.modelTurn.parts[0].thought = true;
  assert.deepEqual(value.server(wire(thought)).audio, []);
  const usage = value.server(wire(fixture.turnComplete)); assert.deepEqual(usage.usage, fixture.turnComplete.usageMetadata);
  const repeated = value.server(wire({ usageMetadata: fixture.turnComplete.usageMetadata }));
  assert.deepEqual(repeated.usage, usage.usage); assert.equal(repeated.responseDone, false);
  assert.equal(repeated.accumulatedCostMicros, undefined);
});

test("Extended Thinking turnComplete is not done until IDLE or an observed interruption", () => {
  const value = connection(googleLiveModels[2]);
  assert.equal(value.server(wire({ serverContent: { generationComplete: true } })).responseDone, false);
  assert.equal(value.server(wire({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } })).responseDone, false);
  assert.equal(value.server(wire(fixture.interrupted)).interrupted, true);
  assert.equal(value.server(wire({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } })).responseDone, true);
  assert.equal(value.server(wire({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } })).responseDone, false);
  assert.equal(value.server(wire(fixture.turnComplete)).responseDone, true);
  assert.equal(fixture.billing.interruptionProvesRefund, false);
});

test("tool replies require this connection's original call, with bounded dedupe and cancellation", () => {
  const value = connection(); assert.throws(() => value.client(wire(fixture.result)), /tool_owner/);
  assert.equal(value.server(wire(fixture.call)).calls.length, 1);
  assert.equal(value.server(wire(fixture.call)).calls.length, 0);
  value.client(wire(fixture.interim)); value.client(wire(fixture.result));
  assert.throws(() => value.client(wire(fixture.result)), /tool_owner/);
  assert.equal(value.server(wire(fixture.call)).calls.length, 0);
  const canceled = connection(); canceled.server(wire(fixture.call));
  assert.deepEqual(canceled.server(wire(fixture.cancellation)).canceledCalls, ["fixture-call-1"]);
  assert.throws(() => canceled.client(wire(fixture.result)), /tool_owner/);
  const other = connection(); assert.throws(() => other.client(wire(fixture.result)), /tool_owner/);
  for (const model of [googleLiveModels[0], googleLiveModels[2]]) {
    const single = connection(model); single.server(wire(fixture.call));
    assert.throws(() => single.client(wire(fixture.interim)), /tool_continuation/);
    const final = structuredClone(fixture.result); delete final.toolResponse.functionResponses[0].scheduling;
    single.client(wire(final));
  }
});

test("malformed late tool/audio data cannot partially publish output or consume valid call ownership", () => {
  const value = connection();
  const batch = structuredClone(fixture.call); batch.toolCall.functionCalls.push({ name: "openclaw_agent_consult", args: {} });
  assert.throws(() => value.server(wire(batch)), /tool_id/); assert.equal(value.server(wire(fixture.call)).calls.length, 1);
  const responses = structuredClone(fixture.result); responses.toolResponse.functionResponses.push({ id: "foreign", name: "openclaw_agent_consult", response: {} });
  assert.throws(() => value.client(wire(responses)), /tool_owner/); value.client(wire(fixture.result));
  for (const data of ["Zh==", "AAEC", "A", "AA==", "AAECAw=", "AAECAw==="]) {
    const response = structuredClone(fixture.output); response.serverContent.modelTurn.parts.push({ inlineData: { mimeType: "audio/pcm;rate=24000", data } });
    assert.throws(() => value.server(wire(response)), /pcm/);
  }
  const wrongRate = structuredClone(fixture.input); wrongRate.realtimeInput.audio.mimeType = "audio/pcm;rate=24000";
  assert.throws(() => value.client(wire(wrongRate)), /pcm/);
});

test("resumption and goAway are transient lifecycle evidence, never free completion or replay permission", () => {
  const value = connection();
  for (const body of [fixture.resumable, fixture.resumptionLost, fixture.goAway]) {
    const observed = value.server(wire(body)); assert.deepEqual(observed.body, body);
    assert.equal(observed.responseDone, false); assert.equal(observed.usage, null);
  }
  assert.throws(() => value.server(wire({ sessionResumptionUpdate: { resumable: false, newHandle: "stale" } })), error);
  assert.equal(fixture.billing.replayUncertainInput, false);
});

test("tool identity exhaustion never evicts dedupe history and frame limits stop forwarding", () => {
  const value = connection();
  for (let i = 0; i < 1024; i++) value.server(wire({ toolCall: { functionCalls: [{ id: `call-${i}`, name: "openclaw_agent_consult", args: {} }] } }));
  assert.throws(() => value.server(wire(fixture.call)), /tool_limit/);
  assert.equal(value.server(wire({ toolCall: { functionCalls: [{ id: "call-0", name: "openclaw_agent_consult", args: {} }] } })).calls.length, 0);
  const bounded = connection();
  assert.throws(() => bounded.client(" ".repeat(1024 * 1024 + 1)), /frame/);
  for (let i = 0; i < 4095; i++) bounded.server(wire({ usageMetadata: {} }));
  assert.throws(() => bounded.server(wire({ usageMetadata: {} })), /frame_limit/);
  assert.throws(() => bounded.client(wire(fixture.input)), /not_ready/);
});
