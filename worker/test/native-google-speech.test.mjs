import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeGoogleSpeech } = await import("../native-google-speech.ts");
const { googleSpeechModels, googleSpeechPreviewCutoff, prepareGoogleSpeech, observeGoogleSpeech } = await import("../google-speech.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/speech.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"))]).providers[0];
const generic = provider.endpoints.find(value => value.id === "generate_content");
const jsonLimit = 8 * 1024 * 1024, audioLimit = 4 * 1024 * 1024;
const now = Date.parse("2026-11-03T00:00:00Z");
test.beforeEach(t => t.mock.method(Date, "now", () => now));
// Proposed leaf selections exercise the real compiled provider, not activation.
function selection(upstream = "gemini-3.8-flash-tts", body) {
  const interactions = upstream.startsWith("gemini-3.8-"), format = interactions ? "google.speech_interactions" : "google.speech_generate_content";
  body ??= structuredClone(interactions ? wire.interactions.request : wire.generateContent.request);
  if (interactions) body.model = upstream;
  return { provider, endpoint: { ...generic, modelPassthrough: undefined, request_format: format, response_format: format,
    path: interactions ? "/v1beta/interactions" : generic.path, path_params: interactions ? [] : ["model"] },
    model: { id: "google/" + upstream, upstream, capabilities: ["audio.speech"] }, capability: "audio.speech", body,
    pathParams: interactions ? {} : { model: upstream }, method: "POST" };
}
const native = model => prepareNativeGoogleSpeech(selection(model));
const payload = () => structuredClone(wire.interactions.response);
const response = (body = payload(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, model, signal = new AbortController().signal) {
  const prepared = native(model), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}
function wave(total = 48) {
  const bytes = Buffer.alloc(total); bytes.write("RIFF"); bytes.writeUInt32LE(total - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(total - 44, 40); return bytes;
}
const audio = (mime_type = "audio/l16", bytes = Buffer.from([0, 0, 255, 127])) => ({ type: "audio", mime_type, data: bytes.toString("base64") });

test("speech wrapper binds the five frozen native models, transport and unchanged voice JSON", () => {
  for (const model of googleSpeechModels) {
    const selected = selection(model), before = structuredClone(selected), prepared = prepareNativeGoogleSpeech(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, "https://generativelanguage.googleapis.com");
    assert.equal(prepared.path, model.startsWith("gemini-3.8-") ? "/v1beta/interactions" : `/v1beta/models/${model}:generateContent`);
    assert.equal(prepared.tariff, undefined); assert.equal(prepared.query, undefined);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
    for (const url of [prepared.origin + prepared.path + "?key=synthetic", prepared.origin + prepared.path + "?alt=sse", "https://other.example" + prepared.path])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
  const dialogue = selection(wire.dialogue.model, structuredClone(wire.dialogue.request)), before = structuredClone(dialogue.body);
  assert.ok(prepareNativeGoogleSpeech(dialogue)); assert.deepEqual(dialogue.body, before);
  assert.equal(prepareNativeGoogleSpeech({ ...selection(), endpoint: { ...generic, request_format: "google.generate_content" } }), undefined);
});

test("speech wrapper rejects mismatched routes, selectors, model aliases and query or tariff overrides", () => {
  const selected = selection(), endpoint = selected.endpoint;
  for (const model of ["gemini-new-tts", "gemini-3.1-flash-tts", "google/gemini-3.8-flash-tts"]) assert.throws(() => native(model));
  for (const change of [{ provider: { ...provider, id: "google" } }, { model: null }, { capability: "llm.generate" }, { method: "GET" },
    { pathParams: { model: selected.model.upstream } }, { nativeQuery: {} }]) assert.throws(() => prepareNativeGoogleSpeech({ ...selected, ...change }));
  for (const change of [{ path: generic.path }, { path_params: ["model"] }, { response_format: "google.generate_content" },
    { method: "GET" }, { upstreamPath: endpoint.path }, { query: { alt: "sse" } }, { streaming: true }, { lifecycle: {} },
    { responsesLifecycle: {} }, { websocket: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => prepareNativeGoogleSpeech({ ...selected, endpoint: { ...endpoint, ...change } }));
  const preview = selection(googleSpeechModels[0]); preview.pathParams.model = googleSpeechModels[1];
  assert.throws(() => prepareNativeGoogleSpeech(preview));
});

test("speech preview qualification expires on the trusted clock before dispatch without silently migrating", t => {
  t.mock.method(Date, "now", () => Date.parse(googleSpeechPreviewCutoff));
  for (const model of googleSpeechModels.slice(0, 3)) assert.throws(() => native(model), /qualification is invalid/);
  for (const model of googleSpeechModels.slice(3)) assert.ok(native(model));
});

test("speech input admission rejects retained state, streaming, remote assets and malformed or oversized dialogue", () => {
  for (const change of [{ store: true }, { stream: true }, { background: true }, { previous_interaction_id: "unbound" }, { tools: [] },
    { response_format: { type: "audio", mime_type: "audio/mpeg", sample_rate: 24000 } }])
    assert.throws(() => prepareNativeGoogleSpeech(selection(undefined, { ...wire.interactions.request, ...change })));
  const wrongModel = selection(); wrongModel.body.model = "gemini-3.8-flash-lite-tts"; assert.throws(() => prepareNativeGoogleSpeech(wrongModel));
  const remote = structuredClone(wire.generateContent.request); remote.contents[0].parts = [{ fileData: { fileUri: "https://assets.example/audio" } }];
  assert.throws(() => prepareNativeGoogleSpeech(selection(googleSpeechModels[0], remote)));
  const huge = structuredClone(wire.dialogue.request); huge.input[0].content = Array.from({ length: 5 }, () => ({ ...huge.input[0].content[0], text: "x".repeat(65536) }));
  assert.throws(() => prepareNativeGoogleSpeech(selection(wire.dialogue.model, huge)));
});

test("speech output capacity is acquired before dispatch and charges 64 MiB", () => {
  const baseline = bodyBudgetCharged(), lease = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  lease.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow(20 * 1024 * 1024), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { occupied.release(); }
});

test("speech preserves complete PCM or WAV bytes and native usage while withholding a token or invoice estimate", async () => {
  for (const model of googleSpeechModels) {
    const body = structuredClone(model.startsWith("gemini-3.8-") ? wire.interactions.response : wire.generateContent.response);
    if (model.startsWith("gemini-3.8-")) body.model = model;
    body.usageMetadata = { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 };
    const result = await read(response(body, { "x-private-upstream": "synthetic" }), model);
    assert.deepEqual(await result.response.json(), body); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.equal(result.response.headers.get("x-private-upstream"), null); assert.equal(result.usage.requestCostReceipt, undefined);
  }
  const body = payload(); body.output_audio = audio("audio/wav", wave());
  assert.deepEqual(await (await read(response(body))).response.json(), body);
});

test("speech REST steps retain every final audio part and remove thought parts atomically", async () => {
  const body = { model: "gemini-3.8-flash-tts", status: "completed", usage: { total_tokens: 9 }, steps: [{ type: "model_output", content: [
    { type: "thought", text: "synthetic-private-thought" }, audio(), { type: "text", text: "Final transcript" }, audio("audio/pcm;rate=24000;channels=1"),
  ] }] };
  const delivered = await (await read(response(body))).response.json(); assert.equal(delivered.steps[0].content.length, 3);
  assert.equal(JSON.stringify(delivered).includes("synthetic-private-thought"), false); assert.deepEqual(delivered.usage, body.usage);
  const preview = structuredClone(wire.generateContent.response); preview.candidates[0].content.parts.unshift({ thought: true, inlineData: { data: "synthetic-private-thought" } });
  assert.deepEqual(await (await read(response(preview), googleSpeechModels[0])).response.json(), wire.generateContent.response);
  body.steps[0].content.push(audio("audio/l16", Buffer.from([1]))); await assert.rejects(read(response(body)), "a valid prefix cannot conceal a malformed later part");
});

test("speech requires explicit qualified MIME and canonical bytes without compatibility relabelling", async () => {
  const missing = payload(); delete missing.output_audio.mime_type;
  assert.equal(observeGoogleSpeech(missing, prepareGoogleSpeech(wire.interactions.model, wire.interactions.request, now), true).audio[0].mimeType, "audio/l16");
  await assert.rejects(read(response(missing)));
  for (const mime of [null, ["audio/l16"], "audio/mpeg", "audio/l16;rate=8000", "audio/l16;rate=24000;rate=24000", "audio/l16;channels=2"]) {
    const body = payload(); body.output_audio.mime_type = mime; await assert.rejects(read(response(body)));
  }
  for (const data of ["AAD_fw", "AAD/fw", "AB==", "", "bad!"]) { const body = payload(); body.output_audio.data = data; await assert.rejects(read(response(body))); }
  for (const [mime, bytes] of [["audio/l16", wave()], ["audio/wav", Buffer.from([0, 0])]]) {
    const body = payload(); body.output_audio = audio(mime, bytes); await assert.rejects(read(response(body)));
  }
  for (const offset of [4, 20, 22, 24, 28, 32, 34, 40]) {
    const bytes = wave(); bytes[offset] ^= 1; const body = payload(); body.output_audio = audio("audio/wav", bytes); await assert.rejects(read(response(body)));
  }
});

test("speech rejects unknown identity or terminal state, ambiguous audio, remote files and blocked candidates", async () => {
  for (const change of [{ status: undefined }, { status: "in_progress" }, { model: undefined }, { model: "other" }, { error: {} },
    { outputAudio: audio() }, { steps: [] }, { output_audio: { ...audio(), uri: "https://assets.example/audio" } }])
    await assert.rejects(read(response({ ...payload(), ...change })));
  for (const type of ["user_input", "tool_result"]) await assert.rejects(read(response({ model: "gemini-3.8-flash-tts", status: "completed", steps: [{ type, content: [audio()] }] })));
  for (const reason of [undefined, "MAX_TOKENS", "SAFETY"]) {
    const body = structuredClone(wire.generateContent.response); body.candidates[0].finishReason = reason; await assert.rejects(read(response(body), googleSpeechModels[0]));
  }
  const blocked = { ...wire.generateContent.response, promptFeedback: { blockReason: "SAFETY" } }; await assert.rejects(read(response(blocked), googleSpeechModels[0]));
});

test("speech admits exact decoded and UTF-8 JSON bounds and rejects overflow", async () => {
  const body = payload(); body.output_audio = audio("audio/l16", Buffer.alloc(audioLimit));
  assert.equal(Buffer.from((await (await read(response(body))).response.json()).output_audio.data, "base64").length, audioLimit);
  body.output_audio = audio("audio/l16", Buffer.alloc(audioLimit + 2)); await assert.rejects(read(response(body)));
  const text = JSON.stringify(payload()), exact = text + " ".repeat(jsonLimit - Buffer.byteLength(text)), headers = { "content-type": "application/json" };
  assert.ok(await read(new Response(exact, { headers }))); await assert.rejects(read(new Response(exact + " ", { headers })));
});

test("speech requires complete HTTP200 JSON with exact lengths, no redirects, ranges or encoded bodies", async () => {
  const text = JSON.stringify(payload()), headers = { "content-type": "application/json" };
  for (const length of ["-1", "1.5", "bad", String(jsonLimit + 1), String(Buffer.byteLength(text) - 1), String(Buffer.byteLength(text) + 1)])
    await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": length } })));
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-encoding": "identity", "content-length": "1" } })));
  for (const status of [202, 206, 302, 422, 500]) await assert.rejects(read(response(payload(), {}, status)));
  for (const extra of [{ "content-type": "text/plain" }, { "content-range": "bytes 0-1/100" }, { "content-encoding": "gzip" }]) await assert.rejects(read(response(payload(), extra)));
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  for (const bytes of [new Uint8Array([0xff]), '{"status":']) await assert.rejects(read(new Response(bytes, { headers })));
});

test("speech abort, timeout and interrupted audio yield no partial success or free-work evidence", async () => {
  const prefix = new TextEncoder().encode(JSON.stringify(payload()).slice(0, -1)), headers = { "content-type": "application/json" };
  let first = true;
  const broken = new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(prefix); } else c.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_google_speech_response" });
  for (const name of ["AbortError", "TimeoutError"]) {
    const controller = new AbortController(); let canceled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(prefix); }, cancel() { canceled = true; } });
    const pending = read(new Response(stream, { headers }), undefined, controller.signal); controller.abort(new DOMException("synthetic", name));
    await assert.rejects(pending); assert.equal(canceled, true);
  }
});
