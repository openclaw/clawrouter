import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MICROSOFT_EDGE_SPEECH as limits, MicrosoftEdgeSpeechCodec, prepareMicrosoftEdgeSpeech } from "../microsoft-edge-speech.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/microsoft/edge-speech.json", import.meta.url), "utf8"));
const encode = new TextEncoder();
function text(path, body = {}, id = wire.requestId) {
  return `X-RequestId:${id}\r\nPath:${path}\r\nContent-Type:application/json; charset=utf-8\r\n\r\n${JSON.stringify(body)}`;
}
function binary(bytes, id = wire.requestId, mime = "audio/mpeg", path = "audio") {
  const head = encode.encode(`X-RequestId:${id}\r\n${mime ? `Content-Type:${mime}\r\n` : ""}Path:${path}\r\n`);
  const frame = new Uint8Array(2 + head.length + bytes.length);
  new DataView(frame.buffer).setUint16(0, head.length); frame.set(head, 2); frame.set(bytes, 2 + head.length); return frame;
}
function active(id = wire.requestId) {
  const codec = new MicrosoftEdgeSpeechCodec(wire.request, id);
  assert.match(codec.nextRequestFrame(), /Path:speech.config\r\n/);
  assert.match(codec.nextRequestFrame(), /Path:ssml\r\n/);
  return codec;
}
function fail(codec, frame) {
  assert.throws(() => codec.receive(frame), /edge_/);
  assert.equal(codec.state, "failed"); assert.throws(() => codec.takeAudio(), /edge_audio_incomplete/);
}

test("Edge builds ordered native messages without transport credentials or changing selected settings", () => {
  const [config, ssml] = prepareMicrosoftEdgeSpeech(wire.request, wire.requestId);
  assert.deepEqual(JSON.parse(config.split("\r\n\r\n")[1]), {
    context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" }, outputFormat: wire.request.outputFormat } } },
  });
  assert.ok(ssml.startsWith(`X-RequestId:${wire.requestId}\r\n`));
  assert.match(ssml, /voice name="en-US-MichelleNeural"/);
  assert.match(ssml, /xml:lang="en-US"/);
  assert.match(ssml, /rate="\+10%" pitch="-5Hz" volume="default"/);
  assert.match(ssml, /Synthetic café &lt; &amp; &gt; fixture/);
  assert.doesNotMatch(config + ssml, /Subscription-Key|Sec-MS-GEC|TrustedClientToken/);
  const selected = prepareMicrosoftEdgeSpeech({ ...wire.request, voice: "zh-CN-XiaoxiaoNeural", lang: "zh-CN", rate: '"/><break/>' }, wire.requestId)[1];
  assert.match(selected, /xml:lang="zh-CN"/); assert.match(selected, /rate="&quot;\/&gt;&lt;break\/&gt;"/);
});

test("Edge rejects malformed inputs, extra transport settings and unqualified format fallback", () => {
  for (const textValue of ["", " ", "\ud800", "\udc00", "\u0000", "\ufffe", "😀".repeat(limits.maxTextBytes)])
    assert.throws(() => prepareMicrosoftEdgeSpeech({ text: textValue }, wire.requestId), /invalid_edge_text/);
  for (const changes of [{ proxy: "https://untrusted.example" }, { voice: 'x"/>' }, { voice: null }, { lang: null }, { lang: "en\r\n" }, { rate: "x\n" }, { rate: "\ud800" }, { pitch: "x".repeat(65) }, { outputFormat: "riff-24khz-16bit-mono-pcm" }])
    assert.throws(() => prepareMicrosoftEdgeSpeech({ ...wire.request, ...changes }, wire.requestId), /edge_/);
  assert.throws(() => prepareMicrosoftEdgeSpeech(wire.request, "x\r\nPath:ssml"), /invalid_edge_request_id/);
  assert.throws(() => prepareMicrosoftEdgeSpeech({ text: "&".repeat(limits.maxTextBytes) }, wire.requestId), /edge_request_limit/);
  assert.match(prepareMicrosoftEdgeSpeech({ text: "😀" }, wire.requestId)[1], /😀/);
});

test("Edge requires request ordering and never treats frame retrieval as remote acknowledgement", () => {
  const early = new MicrosoftEdgeSpeechCodec(wire.request, wire.requestId);
  fail(early, text("turn.start"));
  const configured = new MicrosoftEdgeSpeechCodec(wire.request, wire.requestId); configured.nextRequestFrame();
  fail(configured, binary([1]));
  const sent = active(); assert.equal(sent.state, "awaiting");
  assert.throws(() => sent.nextRequestFrame(), /edge_request_order/); assert.equal(sent.state, "failed");
});

test("Edge binds every fixture frame and releases byte-identical audio only after turn.end", () => {
  const codec = active();
  for (const frame of wire.frames) {
    codec.receive(frame.bytes ? binary(frame.bytes, wire.requestId, frame.contentType ?? null) : text(frame.path, frame.body));
    assert.equal(codec.state, frame.path === "turn.end" ? "complete" : "awaiting");
  }
  codec.interrupt("close"); // Closing the already completed socket cannot undo its terminal fact.
  const result = codec.takeAudio();
  assert.deepEqual([...result.audio], wire.expectedBytes); assert.equal(result.requestId, wire.requestId);
  assert.equal(result.mimeType, "audio/mpeg"); assert.equal(result.upstreamCostMicros, null);
  assert.equal(codec.state, "delivered"); assert.throws(() => codec.takeAudio(), /edge_audio_incomplete/);
});

test("Edge decodes the serialized binary/terminal wire fixture without a matching test encoder", () => {
  const codec = active();
  codec.receive(new Uint8Array(Buffer.from(wire.wireExample.audioBase64, "base64")));
  codec.receive(wire.wireExample.terminalText);
  assert.deepEqual([...codec.takeAudio().audio], wire.expectedBytes.slice(0, 6));
});

test("Edge abort before request preparation completes prevents any later request frame", () => {
  for (const configured of [false, true]) {
    const codec = new MicrosoftEdgeSpeechCodec(wire.request, wire.requestId);
    if (configured) codec.nextRequestFrame();
    codec.interrupt("abort"); assert.throws(() => codec.nextRequestFrame(), /edge_request_order/);
    assert.throws(() => codec.takeAudio(), /edge_audio_incomplete/);
  }
});

for (const reason of ["timeout", "abort", "close", "error"]) test(`Edge ${reason} discards partial audio and rejects a late terminal frame`, () => {
  const codec = active(); codec.receive(binary([1, 2, 3])); codec.interrupt(reason);
  assert.equal(codec.state, "failed");
  fail(codec, text("turn.end"));
});

test("Edge rejects cross-request text, audio and terminal frames even when two exchanges are active", () => {
  for (const frame of [text("turn.start", {}, wire.otherRequestId), binary([1], wire.otherRequestId), text("turn.end", {}, wire.otherRequestId)]) {
    const a = active(), b = active(wire.otherRequestId); a.receive(binary([1])); fail(a, frame);
    b.receive(binary([9], wire.otherRequestId)); b.receive(text("turn.end", {}, wire.otherRequestId));
    assert.deepEqual([...b.takeAudio().audio], [9]);
  }
  fail(active(), "Path:turn.end\r\n\r\n");
});

test("Edge rejects late frames before delivery, early output reads, duplicate turns and empty completion", () => {
  const done = active(); done.receive(binary([1])); done.receive(text("turn.end")); fail(done, binary([2]));
  const partial = active(); partial.receive(binary([1])); assert.throws(() => partial.takeAudio(), /edge_audio_incomplete/);
  fail(active(), text("turn.end"));
  const twice = active(); twice.receive(text("turn.start")); fail(twice, text("turn.start"));
  const lateStart = active(); lateStart.receive(binary([1])); fail(lateStart, text("turn.start"));
  const response = active(); response.receive(text("response")); fail(response, text("response"));
});

test("Edge validates length-prefixed binary headers, exact paths, IDs and MP3 MIME", () => {
  const brokenLength = binary([1]); new DataView(brokenLength.buffer).setUint16(0, 65535);
  const malformedUtf8 = binary([1]); malformedUtf8[2] = 255;
  for (const frame of [new Uint8Array(), new Uint8Array([0]), brokenLength, malformedUtf8, encode.encode("no binary headers"),
    binary([1], wire.requestId, "audio/ogg"), binary([1], wire.requestId, null), binary([1], wire.requestId, "audio/mpeg", "turn.end"),
    text("unknown"), text("turn.end").replace("Path:turn.end", "Path:audio.metadata\r\nPath:turn.end"),
    text("turn.end").replace("X-RequestId:", "X-RequestId:other\r\nx-requestid:"),
    text("audio.metadata").replace("{}", "not JSON"), text("response", { error: "synthetic private upstream error" })]) fail(active(), frame);
});

test("Edge bounds individual frames and cumulative audio, including byte-exact maximum output", () => {
  fail(active(), "x".repeat(limits.maxTextFrameBytes + 1));
  fail(active(), new Uint8Array(limits.maxBinaryFrameBytes + 1));
  const codec = active(), chunk = new Uint8Array(512 * 1024).fill(7);
  for (let i = 0; i < 32; i++) codec.receive(binary(chunk));
  codec.receive(text("turn.end")); const result = codec.takeAudio();
  assert.equal(result.audio.byteLength, limits.maxAudioBytes); assert.equal(result.audio.at(-1), 7);
  const overflow = active(); for (let i = 0; i < 32; i++) overflow.receive(binary(chunk)); fail(overflow, binary([8]));
});

test("Edge bounds metadata/frame floods independently of audio size", () => {
  const flood = active(), empty = binary([], wire.requestId, null);
  for (let i = 0; i < limits.maxFrames; i++) flood.receive(empty);
  fail(flood, empty);
  const total = active(), large = text("audio.metadata", { synthetic: "x".repeat(60 * 1024) });
  const count = Math.floor(limits.maxWireBytes / encode.encode(large).length);
  for (let i = 0; i < count; i++) total.receive(large);
  fail(total, large);
});

test("Edge metadata cannot impersonate a terminal frame or establish free upstream work", () => {
  const codec = active(); codec.receive(text("audio.metadata", { synthetic: "Path:turn.end", upstreamCostMicros: 0 }));
  assert.equal(codec.state, "awaiting"); codec.receive(binary([1])); codec.receive(text("turn.end"));
  assert.equal(codec.takeAudio().upstreamCostMicros, null);
});
