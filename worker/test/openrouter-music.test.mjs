import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openRouterMusicModels, prepareOpenRouterMusic, OpenRouterMusicStream, readOpenRouterMusic, createOpenRouterMusicInspector } from "../openrouter-music.ts";

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

function audioFrame(data, transcript) {
  return { id: "gen-synthetic-music", model: request.model, choices: [{ index: 0, delta: {
    audio: { data, ...(transcript === undefined ? {} : { transcript }) },
  }, finish_reason: null }] };
}
const feed = (state, value) => state.accept(typeof value === "string" ? value : JSON.stringify(value));
function inspect(frames) {
  const state = createOpenRouterMusicInspector(request);
  for (const frame of frames) feed(state, frame);
  return state;
}

test("scalar inspection preserves native identity and diagnostics without returning audio or transcript", () => {
  const retained = accepted([...fixture.frames, "[DONE]"]).result();
  const state = inspect(fixture.frames);
  assert.equal(state.isDone(), false); assert.throws(() => state.result(), /incomplete_audio/);
  state.accept("[DONE]"); assert.equal(state.isDone(), true);
  const result = state.result();
  assert.deepEqual(result, { audioBytes: retained.audio.length, transcriptBytes: encode(retained.transcript).length,
    format: retained.format, usage: retained.usage, responseId: retained.responseId, upstreamCostMicros: null });
  assert.equal(Object.hasOwn(result, "audio"), false); assert.equal(Object.hasOwn(result, "transcript"), false);
  assert.deepEqual(state.result(), result); // Reading scalar evidence does not recount a tail.
  assert.throws(() => state.accept("[DONE]")); assert.equal(state.isDone(), false); assert.throws(() => state.result());
});

test("inspection agrees with the default reader for canonical padded and unpadded tails at every split", () => {
  for (let size = 1; size <= 8; size++) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => (index * 73 + size) % 256));
    const canonical = bytes.toString("base64");
    for (const encoded of [canonical, canonical.replace(/=+$/, "")]) for (let split = 0; split <= encoded.length; split++) {
      const frames = [audioFrame(encoded.slice(0, split)), audioFrame(encoded.slice(split)), "[DONE]"];
      const result = inspect(frames).result(), retained = accepted(frames).result();
      assert.equal(result.audioBytes, bytes.length); assert.deepEqual(retained.audio, new Uint8Array(bytes));
    }
  }
  for (const encoded of ["A", "AB", "ABC", "AB==", "ABC=", "A===", "AA=", "AA=A", "AA==AAAA", "AAA=AAAA", "=AAA", "AAAA=", "AAAA====", "AA-_"]) {
    for (let split = 0; split <= encoded.length; split++) {
      const frames = [audioFrame(encoded.slice(0, split)), audioFrame(encoded.slice(split)), "[DONE]"];
      assert.throws(() => inspect(frames).result(), /invalid_openrouter_music/);
      assert.throws(() => accepted(frames).result(), /invalid_openrouter_music/);
    }
  }
});

test("exact original 16 MiB inspection allocates no decoded audio and rejects one extra byte", () => {
  const maximum = 16 * 1024 * 1024, block = "AAAA".repeat(16384), blockBytes = block.length / 4 * 3;
  const originalAtob = globalThis.atob; let decodeCalls = 0;
  globalThis.atob = value => { decodeCalls++; return originalAtob(value); };
  try {
    for (const extra of [0, 1]) {
      const state = createOpenRouterMusicInspector(request);
      for (let bytes = 0; bytes + blockBytes <= maximum; bytes += blockBytes) feed(state, audioFrame(block));
      const tail = Buffer.alloc(maximum % blockBytes + extra).toString("base64");
      if (extra) assert.throws(() => { feed(state, audioFrame(tail)); feed(state, "[DONE]"); state.result(); });
      else {
        feed(state, audioFrame(tail)); feed(state, "[DONE]");
        assert.equal(state.result().audioBytes, maximum);
        assert.equal(state.result().transcriptBytes, 0); assert.equal(state.result().usage, null);
      }
    }
    assert.equal(decodeCalls, 0);
  } finally { globalThis.atob = originalAtob; }
});

test("inspection validates split transcript surrogates and the original per-fragment UTF-8 byte bound", () => {
  const split = [audioFrame("AA==", "\ud83e"), audioFrame("", "\udd8a"), "[DONE]"];
  assert.equal(accepted(split).result().transcript, "🦊");
  assert.equal(inspect(split).result().transcriptBytes, 6); // Original encoder counts each fragment independently.
  for (const fragments of [["\ud800"], ["\udc00"], ["\ud800", "x"], ["\ud800", "\ud800"]]) {
    const frames = fragments.map((text, index) => audioFrame(index ? "" : "AA==", text)).concat("[DONE]");
    assert.throws(() => inspect(frames).result()); assert.throws(() => accepted(frames).result());
  }
  const state = createOpenRouterMusicInspector(request);
  for (let index = 0; index < 16; index++) feed(state, audioFrame(index ? "" : "AA==", "a".repeat(65536)));
  feed(state, "[DONE]"); assert.equal(state.result().transcriptBytes, 1024 * 1024);
  const oversized = createOpenRouterMusicInspector(request);
  for (let index = 0; index < 16; index++) feed(oversized, audioFrame(index ? "" : "AA==", "a".repeat(65536)));
  assert.throws(() => feed(oversized, audioFrame("", "a")));
});

test("inspection retains original identity, native error and terminal invariants with unknown cost", () => {
  for (const patch of [{ error: { message: "synthetic failure" } }, { model: "other-model" }, { id: "bad/id" },
    { usage: { cost: -1 } }, { choices: [{ index: 1, delta: {} }] },
    { choices: [{ delta: { audio: { data: "AA==" } }, finish_reason: "length" }] },
    { choices: [{ delta: { function_call: {} } }] }, { choices: [{ delta: { refusal: "filtered" } }] }])
    assert.throws(() => inspect([{ ...audioFrame("AA=="), ...patch }, "[DONE]"]).result());
  assert.throws(() => inspect([audioFrame("AA=="), { ...audioFrame(""), id: "other-job" }, "[DONE]"]));
  assert.throws(() => inspect([audioFrame("AA=="), { choices: [{ delta: {}, finish_reason: "stop" }] }, audioFrame(""), "[DONE]"]));
  assert.throws(() => inspect(["[DONE]"]).result());
  const unknown = inspect([audioFrame("AA=="), { choices: [], usage: { cost: 123, completion_tokens: 999 } }, "[DONE]"]).result();
  assert.equal(unknown.upstreamCostMicros, null); assert.equal(unknown.usage.cost, 123);
  assert.equal(inspect([{ ...audioFrame("AA=="), error: null }, "[DONE]"]).result().audioBytes, 1);
  // Null-error compatibility remains in the codec; the production leaf separately denies it.
});

test("inspection bounds object amplification before parsing without changing default extension behavior", () => {
  let deep = {}; for (let index = 0; index < 33; index++) deep = { next: deep };
  const properties = Object.fromEntries(Array.from({ length: 129 }, (_, index) => ["field" + index, 0]));
  for (const extra of [deep, properties, Array(4096).fill(null), { ["k".repeat(257)]: 1 }]) {
    const frames = [{ ...audioFrame("AA=="), diagnostic: extra }, "[DONE]"];
    assert.throws(() => inspect(frames).result());
    assert.equal(accepted(frames).result().audio.length, 1);
  }
  assert.throws(() => inspect([JSON.stringify(audioFrame("AA==")).replace('"finish_reason":null', '"finish_reason":null,"extra":' + "1".repeat(129)), "[DONE]"]));
  assert.throws(() => inspect([JSON.stringify({ ...audioFrame("AA=="), text: "音".repeat(700000) }), "[DONE]"]));
  const events = createOpenRouterMusicInspector(request); feed(events, audioFrame("AA=="));
  for (let index = 1; index < 8192; index++) feed(events, { choices: [], usage: {} });
  assert.throws(() => feed(events, "[DONE]"));
  const complete = createOpenRouterMusicInspector(request); feed(complete, audioFrame("AA=="));
  for (let index = 1; index < 8191; index++) feed(complete, { choices: [], usage: {} });
  feed(complete, "[DONE]"); assert.equal(complete.result().audioBytes, 1);
  const empty = { ...audioFrame("AA=="), diagnostic: "" };
  const exact = JSON.stringify({ ...empty, diagnostic: "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty))) });
  assert.equal(Buffer.byteLength(exact), 2 * 1024 * 1024);
  assert.equal(inspect([exact, "[DONE]"]).result().audioBytes, 1);
  assert.throws(() => inspect([exact + " ", "[DONE]"]));
});
