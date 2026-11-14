import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openRouterSpeechModels, prepareOpenRouterSpeech, readOpenRouterSpeech } from "../openrouter-speech.ts";

const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/speech.json", import.meta.url)));
const prepare = body => prepareOpenRouterSpeech(body.model, body);
const signal = () => new AbortController().signal;

test("four frozen models preserve native speech identity, explicit format and policy without downstream credentials", () => {
  assert.deepEqual(fixture.requests.map(body => body.model), [...openRouterSpeechModels]);
  for (const body of fixture.requests) {
    const copy = structuredClone(body), request = prepare(copy);
    assert.equal(request.path, "/api/v1/audio/speech"); assert.deepEqual(request.body, body);
    assert.equal(request.headers.get("authorization"), null);
    copy.input = "mutated"; assert.equal(request.body.input, body.input);
  }
  assert.throws(() => prepare({ ...fixture.requests[0], model: "newer/model" }), /invalid_openrouter_speech/);
  assert.throws(() => prepareOpenRouterSpeech(fixture.requests[0].model, fixture.requests[1]), /invalid_openrouter_speech/);
});

test("Gemini cannot silently inherit MP3; optional controls remain honest native choices", () => {
  assert.throws(() => prepare({ ...fixture.requests[2], response_format: "mp3" }), /gemini_requires_pcm/);
  for (const patch of [{ response_format: undefined }, { response_format: "wav" }, { input: ["turn"] },
    { input_references: [{ url: "https://example.com/reference" }] }, { input: "\ud800" }, { voice: "" },
    { base_url: "https://example.com" }, { api_key: "synthetic" }, { speed: 0 },
    { provider: { only: ["another-provider"] } }, { provider: { options: { unknown: {} } } }]) {
    assert.throws(() => prepare({ ...fixture.requests[0], ...patch }), /invalid_openrouter_speech/);
  }
  assert.equal(prepare({ ...fixture.requests[0], speed: 1.1 }).body.speed, 1.1);
});

test("complete binary responses preserve exact bytes, opaque generation IDs and unknown pricing", async () => {
  for (const body of fixture.requests) {
    const wire = fixture.responses[body.response_format], data = Uint8Array.from(wire.bytes);
    const result = await readOpenRouterSpeech(new Response(data, { status: wire.status, headers: wire.headers }), prepare(body), signal());
    assert.deepEqual(result.audio, data); assert.equal(result.format, body.response_format);
    assert.equal(result.generationId, wire.headers["x-generation-id"]);
    assert.equal(result.sampleRate, null); assert.equal(result.billableCharacters, null); assert.equal(result.upstreamCostMicros, null);
  }
});

test("binary bounds reject JSON errors, wrong codecs, partial/empty bodies and unsafe generation IDs", async () => {
  const request = prepare(fixture.requests[0]);
  for (const response of [new Response("{}", { status: 400, headers: { "content-type": "application/json" } }),
    new Response("abc", { headers: { "content-type": "audio/pcm" } }),
    new Response("abc", { status: 206, headers: { "content-type": "audio/mpeg" } }),
    new Response("", { headers: { "content-type": "audio/mpeg" } }),
    new Response("abc", { headers: { "content-type": "audio/mpeg", "content-length": "100" } }),
    new Response("abc", { headers: { "content-type": "audio/mpeg", "x-generation-id": "https://example.com/another-job" } }),
    new Response(new Uint8Array(16 * 1024 * 1024 + 1), { headers: { "content-type": "audio/mpeg" } })]) {
    await assert.rejects(readOpenRouterSpeech(response, request, signal()), /invalid_openrouter_speech/);
  }
});

test("cancellation interrupts stalled audio without a retry, refund or completed synthesis", async () => {
  let cancelled = false; const controller = new AbortController();
  const pending = readOpenRouterSpeech(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "audio/mpeg" } }), prepare(fixture.requests[0]), controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});

// The delayed read completion and cancellation acknowledgement are independent.
for (const first of ["read", "cancel"]) test(`retirement joins both read and first cancel, ${first} settles first`, { timeout: 5000 }, async t => {
  const reading = Promise.withResolvers(), readAck = Promise.withResolvers(), cancelAck = Promise.withResolvers();
  const cancelEntered = Promise.withResolvers(), abort = new AbortController();
  let cancels = 0, complete = false;
  const source = new ReadableStream({ pull() { reading.resolve(); },
    cancel() { cancels++; cancelEntered.resolve(); return cancelAck.promise; },
  }, { highWaterMark: 0 });
  const getReader = source.getReader.bind(source);
  source.getReader = (...args) => {
    const reader = getReader(...args), read = reader.read.bind(reader);
    reader.read = async () => { const result = await read(); await readAck.promise; return result; };
    return reader;
  };
  t.after(() => { readAck.resolve(); cancelAck.resolve(); });
  const result = readOpenRouterSpeech(new Response(source, { headers: { "content-type": "audio/mpeg" } }), prepare(fixture.requests[0]), abort.signal).finally(() => { complete = true; });
  const rejection = assert.rejects(result);
  await reading.promise; abort.abort(); await cancelEntered.promise;
  (first === "read" ? readAck : cancelAck).resolve(); await new Promise(setImmediate);
  assert.equal(complete, false); assert.equal(source.locked, true); assert.equal(cancels, 1);
  (first === "read" ? cancelAck : readAck).resolve(); await rejection;
  assert.equal(source.locked, false); assert.equal(cancels, 1);
});
