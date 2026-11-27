import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareXaiRealtimeVoiceQuery, prepareXaiRealtimeVoiceSetup, XaiRealtimeVoiceConnection } from "../xai-realtime-voice.ts";
const f = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/realtime-voice.json", import.meta.url)));
const wire = JSON.stringify;
const make = (setup = f.setup) => { const c = new XaiRealtimeVoiceConnection(new URLSearchParams(f.query)); c.opened(); c.client(wire(setup)); c.server(wire(f.ready)); return c; };
const active = () => { const c = make(); c.server(wire(f.created)); return c; };
const output = (c, body = f.done) => c.server(wire(body));

test("frozen session and query qualify only the named model, five voices and two native audio formats", () => {
  assert.equal(prepareXaiRealtimeVoiceQuery(new URLSearchParams(f.query)).path, "/v1/realtime");
  const setup = prepareXaiRealtimeVoiceSetup(f.setup); assert.equal(setup.bytesPerSecond, 48000); assert.deepEqual(setup.tools, ["weather"]);
  const ulaw = structuredClone(f.setup); ulaw.session.audio.input.format = ulaw.session.audio.output.format = { type: "audio/pcmu" };
  assert.equal(prepareXaiRealtimeVoiceSetup(ulaw).bytesPerSecond, 8000);
  for (const suffix of ["&conversation_id=foreign", "&call_id=foreign", "&model=grok-voice-latest", "&key=synthetic"]) assert.throws(() => prepareXaiRealtimeVoiceQuery(new URLSearchParams(f.query + suffix)));
  for (const change of [s => { s.session.voice = "unqualified"; }, s => { s.session.audio.output.format.rate = 16000; },
    s => { s.session.turn_detection = null; }, s => { s.session.audio.input.transcription.model = "whisper-1"; },
    s => { s.session.resumption.conversation_id = "foreign"; }, s => { s.session.tools.push(s.session.tools[0]); }]) {
    const body = structuredClone(f.setup); change(body); assert.throws(() => prepareXaiRealtimeVoiceSetup(body));
  }
});

test("real upgrade and setup acknowledgement gate input; binary/SIP/history/second setup are not implicit routes", () => {
  const unopened = new XaiRealtimeVoiceConnection(new URLSearchParams(f.query)); assert.throws(() => unopened.client(wire(f.setup)));
  const waiting = new XaiRealtimeVoiceConnection(new URLSearchParams(f.query)); waiting.opened(); waiting.client(wire(f.setup));
  assert.throws(() => waiting.client(wire({ type: "input_audio_buffer.append", audio: "AAA=" })));
  const c = make(); assert.deepEqual(c.client(wire({ type: "input_audio_buffer.append", audio: "AAA=" })), { type: "input_audio_buffer.append", audio: "AAA=" });
  for (const body of [{ type: "input_audio_buffer.commit" }, { type: "conversation.item.delete", item_id: "foreign" }, f.setup,
    { type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "input_text", text: "history" }] } }]) assert.throws(() => make().client(wire(body)));
  assert.throws(() => make().client(wire({ type: "input_audio_buffer.append", audio: "AA==" })));
});

test("audio is provisional and playback acknowledgement is cumulative across chunks before a follow-up", () => {
  const c = active(); const first = output(c, f.audio); assert.equal(first.audio.decodedBytes, 48); assert.equal(first.terminal, null);
  c.acknowledgePlayback(f.audio.item_id, 1); output(c, f.audio);
  output(c); assert.throws(() => c.client(wire({ type: "response.create" })));
  const complete = active(); output(complete, f.audio); complete.acknowledgePlayback(f.audio.item_id, 1); output(complete, f.audio);
  complete.acknowledgePlayback(f.audio.item_id, 2); output(complete); assert.deepEqual(complete.client(wire({ type: "response.create" })), { type: "response.create" });
  assert.equal(complete.close().outcome, "incomplete");
  assert.throws(() => active().acknowledgePlayback("foreign", 1));
  const tiny = active(); output(tiny, { ...f.audio, delta: "AAA=" }); output(tiny);
  tiny.acknowledgePlayback(f.audio.item_id, 1); tiny.client(wire({ type: "response.create" }));
});

test("manual cancel precedes owned bounded truncation, including completed playback; cancellation ACK is not a refund", () => {
  const c = active(); output(c, f.audio); output(c);
  c.client(wire({ type: "response.cancel" }));
  c.client(wire({ type: "conversation.item.truncate", item_id: f.audio.item_id, content_index: 0, audio_end_ms: 1 }));
  const ack = output(c, { type: "error", error: { message: "Cancellation failed: no active response found" } });
  assert.equal(ack.terminal, null); assert.equal(ack.upstreamCostMicros, null); c.client(wire({ type: "response.create" }));
  for (const fields of [{ item_id: "foreign", audio_end_ms: 0 }, { item_id: f.audio.item_id, audio_end_ms: 2 }]) {
    const invalid = active(); output(invalid, f.audio); invalid.client(wire({ type: "response.cancel" }));
    assert.throws(() => invalid.client(wire({ type: "conversation.item.truncate", content_index: 0, ...fields })));
  }
  const noCancel = active(); output(noCancel, f.audio);
  assert.throws(() => noCancel.client(wire({ type: "conversation.item.truncate", item_id: f.audio.item_id, content_index: 0, audio_end_ms: 0 })));
});

test("VAD successor fences late terminals and reports the prior response as unsettled rather than inventing cancellation", () => {
  const c = active(); output(c, f.audio); output(c, { type: "input_audio_buffer.speech_started" });
  c.client(wire({ type: "conversation.item.truncate", item_id: f.audio.item_id, content_index: 0, audio_end_ms: 0 }));
  const successor = output(c, { type: "response.created", response: { id: "response_fixture_02" } });
  assert.equal(successor.previousUnsettledId, f.created.response.id); assert.equal(successor.terminal, null);
  assert.equal(output(c, f.done).ignored, true); assert.equal(output(c, f.audio).ignored, true);
  const done = output(c, { type: "response.done", response: { id: "response_fixture_02", status: "completed" } });
  assert.equal(done.terminal, "completed"); assert.equal(output(c, f.done).ignored, true);
});

test("tool deltas cannot execute before completed terminal; outputs bind exactly once to declared calls", () => {
  const c = active();
  assert.deepEqual(output(c, { type: "response.function_call_arguments.delta", item_id: f.tool.id, call_id: f.tool.call_id, name: f.tool.name, delta: '{"city":' }).calls, []);
  assert.deepEqual(output(c, { type: "response.function_call_arguments.done", item_id: f.tool.id, arguments: f.tool.arguments }).calls, []);
  const done = output(c, { ...f.done, response: { ...f.done.response, output: [f.tool] } });
  assert.deepEqual(done.calls, [{ itemId: f.tool.id, callId: f.tool.call_id, name: "weather", args: { city: "Paris" } }]);
  assert.equal(output(c, f.done).ignored, true);
  const result = { type: "conversation.item.create", item: { type: "function_call_output", call_id: f.tool.call_id, output: '{"forecast":"rain"}' } };
  c.client(wire(result)); c.client(wire({ type: "response.create" })); assert.throws(() => c.client(wire(result)));
  assert.throws(() => make().client(wire(result)));
  const pending = active(); output(pending, { ...f.done, response: { ...f.done.response, output: [f.tool] } });
  assert.throws(() => pending.client(wire({ type: "response.create" })));
});

test("text-message observations exclude server-requested tool results and never stand in for session-time charges", () => {
  const c = make(); c.client(wire({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } }));
  output(c, f.created); output(c, { ...f.done, response: { ...f.done.response, output: [f.tool] } });
  c.client(wire({ type: "conversation.item.create", item: { type: "function_call_output", call_id: f.tool.call_id, output: "{}" } }));
  const closed = c.close(); assert.equal(closed.validatedTextMessages, 1); assert.equal(closed.upstreamCostMicros, null);
});

test("failed, cancelled and incomplete responses discard tool execution while preserving unknown usage cost", () => {
  for (const status of ["failed", "cancelled", "incomplete"]) {
    const c = active(); output(c, f.audio); output(c, { type: "response.output_item.done", item: f.tool });
    const result = output(c, { ...f.done, response: { ...f.done.response, status, output: [f.tool] } });
    assert.equal(result.terminal, status); assert.deepEqual(result.calls, []); assert.equal(result.upstreamCostMicros, null);
    assert.equal(result.usage.input_tokens, 20); assert.equal(c.close().outcome, status);
  }
  for (const item of [{ ...f.tool, name: "undeclared" }, { ...f.tool, arguments: "[]" }, { ...f.tool, arguments: "{" }]) {
    const c = active(); assert.throws(() => output(c, { ...f.done, response: { ...f.done.response, output: [item] } }));
  }
});

test("input completion remains a revisable snapshot; connection loss cannot fabricate final transcript or free audio", () => {
  const c = active();
  const first = output(c, f.inputSnapshot), revised = output(c, { ...f.inputSnapshot, transcript: "Is it raining in Paris?" });
  assert.equal(first.transcript.mode, "snapshot"); assert.equal(first.transcript.complete, false);
  assert.equal(revised.transcript.text, "Is it raining in Paris?");
  c.client(wire({ type: "input_audio_buffer.append", audio: "AAA=" })); output(c, f.audio);
  const closed = c.close(); assert.equal(closed.outcome, "incomplete"); assert.equal(closed.validatedInputBytes, 2);
  assert.equal(closed.observedOutputBytes, 48); assert.equal(closed.upstreamCostMicros, null); assert.throws(() => output(c, f.done));
});

test("malformed native frames and unidentified terminals fail closed without leaking frame contents", () => {
  for (const body of [{ type: "response.done", response: { status: "completed" } }, { type: "response.done", response: { id: f.created.response.id, status: "unknown" } },
    { ...f.audio, delta: "AB==" }, { ...f.audio, delta: "AAA=", data: "AAAA" }, { type: "response.output_text.delta", delta: "\ud800" }]) {
    const c = active(); assert.throws(() => output(c, body), /^Error: invalid_xai_realtime_voice_server_frame$/);
  }
  assert.throws(() => active().server("{")); assert.throws(() => active().server(" ".repeat(1024 * 1024 + 1)));
});
