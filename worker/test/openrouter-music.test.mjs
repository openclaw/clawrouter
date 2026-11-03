import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openRouterMusicModels, prepareOpenRouterMusic, OpenRouterMusicStream, readOpenRouterMusic } from "../openrouter-music.ts";

const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/music.json", import.meta.url)));
const prepare = body => prepareOpenRouterMusic(body.model, body);
const request = prepare(fixture.request);
const encode = text => new TextEncoder().encode(text);
const wire = frames => frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\r\n\r\n`).join("");
const accepted = frames => { const stream = new OpenRouterMusicStream(request); for (const frame of frames) stream.accept(typeof frame === "string" ? frame : JSON.stringify(frame)); return stream; };

test("two frozen models preserve prompt-level music intent and native streaming audio shape", () => {
  for (const model of openRouterMusicModels) {
    const input = { ...structuredClone(fixture.request), model }, prepared = prepare(input);
    assert.equal(prepared.path, "/api/v1/chat/completions"); assert.deepEqual(prepared.body, input);
    input.messages[0].content = "changed"; assert.equal(prepared.body.messages[0].content, fixture.request.messages[0].content);
    assert.equal(prepared.headers.get("authorization"), null);
  }
  for (const patch of [{ model: "google/new-music" }, { stream: false }, { modalities: ["audio"] }, { audio: { format: "pcm" } },
    { audio: { format: "wav", voice: "alloy" } }, { duration: 30 }, { n: 2 }, { provider: { api_key: "synthetic" } }]) {
    assert.throws(() => prepare({ ...fixture.request, ...patch }), /invalid_openrouter_music/);
  }
});

test("one ordered image may be inline or an opaque HTTPS upstream reference, never a router fetch", () => {
  const body = structuredClone(fixture.request);
  body.messages[0].content = [{ type: "text", text: "A calm melody." }, { type: "image_url", image_url: { url: "https://example.com/reference.png" } }];
  assert.deepEqual(prepare(body).body, body);
  for (const url of ["http://example.com/ref", "https://user:pass@example.com/ref", "data:image/png;base64,AB==", "file:///secret"]) {
    body.messages[0].content[1].image_url.url = url; assert.throws(() => prepare(body));
  }
});

test("base64 deltas are one continuous stream, complete only at native DONE with separate usage", () => {
  const stream = accepted(fixture.frames);
  assert.throws(() => stream.result(), /incomplete_audio/);
  stream.accept("[DONE]"); const result = stream.result();
  assert.deepEqual(result.audio, Uint8Array.from(Buffer.from(fixture.audioBase64, "base64")));
  assert.equal(result.transcript, "Synthetic transcript."); assert.equal(result.usage.cost, 0.08);
  assert.equal(result.responseId, "gen-synthetic-music"); assert.equal(result.upstreamCostMicros, null);
  assert.throws(() => stream.accept("[DONE]"), /invalid_openrouter_music/);
  assert.throws(() => stream.result(), /incomplete_audio/);
});

test("fragmented CRLF and split UTF-8 parse through the shared strict SSE reader", async () => {
  const frames = structuredClone(fixture.frames); frames[0].choices[0].delta.audio.transcript = "🦊 ";
  const bytes = encode(": heartbeat\r\n\r\n" + wire([...frames, "[DONE]"]));
  let offset = 0;
  const body = new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, ++offset)); } });
  const result = await readOpenRouterMusic(new Response(body, { headers: { "content-type": "text/event-stream" } }), request, new AbortController().signal);
  assert.equal(result.transcript, "🦊 transcript."); assert.equal(result.audio.length, 12);
});

test("DONE ends transport without waiting for a silent socket, while missing DONE is uncertain", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encode(wire([...fixture.frames, "[DONE]"]))); }, cancel() { cancelled = true; } });
  const result = await readOpenRouterMusic(new Response(body, { headers: { "content-type": "text/event-stream" } }), request, new AbortController().signal);
  assert.equal(result.audio.length, 12); assert.equal(cancelled, true);
  await assert.rejects(readOpenRouterMusic(new Response(wire(fixture.frames), { headers: { "content-type": "text/event-stream" } }), request, new AbortController().signal));
});

test("native errors, mismatched identity, filters, malformed audio and post-terminal data cannot settle success", () => {
  for (const patch of [{ error: { message: "synthetic failure" } }, { model: "another-model" },
    { choices: [{ index: 1, delta: {} }] }, { choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] },
    { choices: [{ index: 0, delta: { tool_calls: [] } }] }]) {
    assert.throws(() => accepted([{ ...fixture.frames[0], ...patch }]), /invalid_openrouter_music/);
  }
  const malformed = structuredClone(fixture.frames); malformed[0].choices[0].delta.audio.data = "AB==";
  assert.throws(() => accepted([...malformed, "[DONE]"]).result());
  assert.throws(() => accepted([...fixture.frames, "[DONE]", fixture.frames[0]]));
  assert.throws(() => accepted([fixture.frames[0], { ...fixture.frames[1], id: "another_generation" }]));
  assert.throws(() => accepted([...fixture.frames, fixture.frames[0]]));
});

test("size, HTTP, invalid UTF-8 and abort bounds preserve an unknown outcome", async () => {
  for (const reply of [new Response("{}", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([100, 97, 116, 97, 58, 32, 255, 10, 10]), { headers: { "content-type": "text/event-stream" } }),
    new Response(wire([...fixture.frames, "[DONE]"]), { headers: { "content-type": "text/event-stream", "content-length": "99999" } })]) {
    await assert.rejects(readOpenRouterMusic(reply, request, new AbortController().signal));
  }
  assert.throws(() => accepted(["x".repeat(2 * 1024 * 1024 + 1)]));
  let cancelled = false; const controller = new AbortController();
  const pending = readOpenRouterMusic(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});
