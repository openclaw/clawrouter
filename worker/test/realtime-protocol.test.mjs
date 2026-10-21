import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { audio, effectiveSession, parseRealtimeUsage, REALTIME, sessionPolicy, wireSession } = await import("../realtime-protocol.ts");

const policy = () => ({ type: "realtime", output_modalities: ["audio"], max_output_tokens: 4096, audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null, transcription: null }, output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" } } });
const usage = () => ({ input_tokens: 100, output_tokens: 12, total_tokens: 112, input_token_details: { text_tokens: 20, audio_tokens: 80, cached_tokens: 15, cached_tokens_details: { text_tokens: 5, audio_tokens: 10 } }, output_token_details: { text_tokens: 2, audio_tokens: 10 } });

test("full-context reservation excludes cache discounts; native singular modality totals settle exactly", () => {
  assert.equal(REALTIME.reservation, 128000 * 32 + 4096 * 64);
  const u = parseRealtimeUsage(usage(), 4096);
  assert.equal(u.cost, 2994); assert.equal(u.cached, 15); assert.equal(u.total, 112);
  for (const mutate of [u => u.input_token_details.text_tokens++, u => u.output_tokens++, u => u.input_token_details.cached_tokens_details.audio_tokens = 81, u => u.input_token_details.cached_tokens++, u => u.output_token_details.audio_tokens = -1, u => u.input_tokens = NaN, u => u.total_tokens++, u => u.input_tokens_details = (delete u.input_token_details, {}), u => u.input_token_details.image_tokens = 1]) {
    const malformed = usage(); mutate(malformed); assert.equal(parseRealtimeUsage(malformed, 4096), null);
  }
  assert.equal(parseRealtimeUsage(usage(), 11), null);
  assert.equal(parseRealtimeUsage(null, 4096), null);
  for (const [text, audio, expected] of [[1, 14, 6], [1, 1, 1], [5, 0, 2], [0, 0, 0]]) {
    const u = { input_tokens: text + audio, output_tokens: 0, total_tokens: text + audio, input_token_details: { text_tokens: text, audio_tokens: audio, cached_tokens: text + audio, cached_tokens_details: { text_tokens: text, audio_tokens: audio } }, output_token_details: { text_tokens: 0, audio_tokens: 0 } };
    assert.equal(parseRealtimeUsage(u, 4096).cost, expected);
  }
});

test("manual policy must be explicit and effective ACK must preserve every inference authority", () => {
  const expected = sessionPolicy(policy()); assert.equal(effectiveSession(expected, expected), true);
  for (const mutate of [s => delete s.audio.input.turn_detection, s => s.audio.input.transcription = { model: "unknown-transcribe" }, s => s.audio.input.turn_detection = { type: "semantic_vad", create_response: true }, s => s.max_output_tokens = "inf", s => s.tools = [{ type: "web_search", name: "unsafe" }], s => s.audio.output.format.rate = 16000]) {
    const s = policy(); mutate(s); assert.throws(() => sessionPolicy(s));
  }
  for (const mutate of [s => s.tool_choice = "auto", s => s.tracing = "auto", s => s.instructions = "changed", s => s.audio.input.turn_detection = { type: "server_vad" }, s => s.max_output_tokens = 4097]) {
    const actual = structuredClone(expected); mutate(actual); assert.equal(effectiveSession(actual, expected), false);
  }
});

test("PCM alignment and canonical base64 are strict; PCMU is mono 8k policy", () => {
  assert.equal(audio("AAA=", { type: "audio/pcm", rate: 24000 }), 2);
  for (const input of ["AA==", "AA", "AAA=\n", "AB==", "", "!!!!"]) assert.throws(() => audio(input, { type: "audio/pcm", rate: 24000 }));
  const s = policy(); s.audio.input.format = s.audio.output.format = { type: "audio/pcmu" };
  assert.equal(sessionPolicy(s).audio.input.format.type, "audio/pcmu"); assert.equal(audio("AA==", { type: "audio/pcmu" }), 1);
});

test("native default policy retains server VAD and named functions but never vendor-funded auto work", () => {
  const s = policy(); delete s.max_output_tokens;
  s.audio.input.turn_detection = { type: "server_vad" };
  s.audio.input.transcription = { model: "gpt-4o-mini-transcribe" };
  s.tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }]; s.tool_choice = "auto";
  const expected = sessionPolicy(s), wire = wireSession(expected);
  assert.equal(expected.audio.input.turn_detection.create_response, true); assert.equal(expected.max_output_tokens, 4096);
  assert.equal(wire.audio.input.turn_detection.create_response, false); assert.equal(wire.audio.input.turn_detection.interrupt_response, false); assert.equal(wire.audio.input.turn_detection.idle_timeout_ms, null);
  assert.equal(effectiveSession(wire, expected), true);
  const omitted = structuredClone(wire); delete omitted.audio.input.turn_detection.idle_timeout_ms; delete omitted.audio.input.transcription.prompt;
  assert.equal(effectiveSession(omitted, expected), true);
  for (const mutate of [a => a.audio.input.turn_detection.create_response = true, a => a.audio.input.turn_detection.interrupt_response = true, a => a.audio.input.turn_detection.idle_timeout_ms = 5000, a => a.audio.input.transcription.model = "gpt-4o-transcribe", a => a.audio.input.transcription.prompt = "unrequested guidance", a => a.audio.input.transcription.language = "en", a => a.tools[0].name = "other", a => a.tool_choice = "none"]) {
    const actual = structuredClone(wire); mutate(actual); assert.equal(effectiveSession(actual, expected), false);
  }
  for (const mutate of [a => a.audio.input.turn_detection.idle_timeout_ms = 1000, a => a.audio.input.turn_detection.threshold = NaN, a => a.audio.input.turn_detection.prefix_padding_ms = -1, a => a.audio.input.turn_detection.create_response = "true", a => a.tools.push(a.tools[0]), a => a.tool_choice = { type: "function", name: "unknown" }, a => a.audio.input.transcription.language = "english"]) {
    const invalid = structuredClone(s); mutate(invalid); assert.throws(() => sessionPolicy(invalid));
  }
});
