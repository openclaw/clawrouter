import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleMusicModels, prepareGoogleMusic, observeGoogleMusic, readGoogleMusic } from "../google-music.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/music.json", import.meta.url), "utf8"));
const request = prepareGoogleMusic(wire.request.model, wire.request.body);
const clone = () => structuredClone(wire.response);

test("Google Lyria preserves the two frozen identities and serialized native SDK request", () => {
  assert.equal(googleMusicModels.length, 2);
  for (const model of googleMusicModels) {
    const value = prepareGoogleMusic(model, wire.request.body);
    assert.equal(value.path, `/v1beta/models/${model}:generateContent`);
    assert.equal(value.body, wire.request.body); assert.equal(value.headers.get("x-goog-api-key"), null);
  }
  for (const model of ["lyria-3.5", "google/lyria-3-pro-preview", "lyria-realtime-exp"]) assert.throws(() => prepareGoogleMusic(model, wire.request.body));
  for (const field of ["format", "instrumental", "lyrics", "previous_interaction_id", "tools"]) assert.throws(() => prepareGoogleMusic(wire.request.model, { ...wire.request.body, [field]: "synthetic" }));
  assert.throws(() => prepareGoogleMusic(wire.request.model, { ...wire.request.body, generationConfig: { responseModalities: ["AUDIO", "TEXT"], responseMimeType: "audio/wav" } }));
});

test("Lyria reference images remain inline and bounded without changing lyrics or prompting", () => {
  const image = { inlineData: { mimeType: "image/png", data: "AAECAw==" } }, text = wire.request.body.contents[0].parts[0];
  const body = { ...wire.request.body, contents: [{ role: "user", parts: [text, ...Array.from({ length: 10 }, () => image)] }] };
  assert.equal(prepareGoogleMusic(wire.request.model, body).body, body);
  body.contents[0].parts.push(image); assert.throws(() => prepareGoogleMusic(wire.request.model, body));
  for (const invalid of [{ fileData: { fileUri: "files/foreign" } }, { inlineData: { mimeType: "audio/mpeg", data: "AAECAw==" } }, { text: "" }]) {
    assert.throws(() => prepareGoogleMusic(wire.request.model, { ...wire.request.body, contents: [{ role: "user", parts: [text, invalid] }] }));
  }
});

test("Lyria complete output keeps lyrics and native usage without inferring cost or duration", () => {
  const value = observeGoogleMusic(wire.response, request, true);
  assert.equal(value.body, wire.response); assert.equal(value.track.mimeType, "audio/mpeg");
  assert.equal(value.track.decodedBytes, 4); assert.deepEqual(value.lyrics, [wire.response.candidates[0].content.parts[0].text]);
  assert.equal(value.durationSeconds, undefined); assert.equal(value.costMicros, undefined);
  const pro = prepareGoogleMusic("lyria-3-pro-preview", wire.request.body), response = clone();
  response.candidates[0].content.parts[1] = { inline_data: { mime_type: "audio/wav", data: "AAECAw" } };
  assert.equal(observeGoogleMusic(response, pro, true).track.mimeType, "audio/wav");
  assert.throws(() => observeGoogleMusic(response, request, true));
});

test("Lyria text-only, blocked and partial output fails without an implicit retry directive", () => {
  assert.throws(() => observeGoogleMusic(wire.response, request, false));
  const textOnly = clone(); textOnly.candidates[0].content.parts.pop(); assert.throws(() => observeGoogleMusic(textOnly, request, true));
  for (const reason of [undefined, "MAX_TOKENS", "SAFETY", "OTHER"]) { const value = clone(); value.candidates[0].finishReason = reason; assert.throws(() => observeGoogleMusic(value, request, true)); }
  for (const value of [{ ...clone(), error: {} }, { ...clone(), promptFeedback: { blockReason: "SAFETY" } }, { candidates: [] }]) assert.throws(() => observeGoogleMusic(value, request, true));
  assert.equal(wire.delivery.textOnlyReplayAllowed, false);
});

test("Lyria malformed late audio or ambiguous aliases cannot publish a valid track prefix", () => {
  for (const data of ["a", "Zh==", "YQ=", "YQ===", "data:audio/mpeg;base64,YQ=="]) {
    const response = clone(); response.candidates[0].content.parts[1].inlineData.data = data;
    assert.throws(() => observeGoogleMusic(response, request, true));
  }
  const duplicate = clone(); duplicate.candidates[0].content.parts.push({ inlineData: { data: "AAECAw==" } }); assert.throws(() => observeGoogleMusic(duplicate, request, true));
  const ambiguous = clone(); ambiguous.candidates[0].content.parts[1].inline_data = { data: "AAECAw==" }; assert.throws(() => observeGoogleMusic(ambiguous, request, true));
  const remote = clone(); remote.candidates[0].content.parts.push({ fileData: { fileUri: "https://media.example/track.mp3" } }); assert.throws(() => observeGoogleMusic(remote, request, true));
});

test("Lyria HTTP reader waits for bounded valid EOF and cancels delivery on abort", async () => {
  assert.equal((await readGoogleMusic(Response.json(wire.response), request, new AbortController().signal)).track.decodedBytes, 4);
  for (const response of [Response.json(wire.response, { status: 202 }), new Response('{"candidates":', { headers: { "content-type": "application/json" } }), new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }), new Response(" ", { headers: { "content-type": "application/json", "content-length": String(24 * 1024 * 1024 + 1) } })]) await assert.rejects(() => readGoogleMusic(response, request, new AbortController().signal));
  let canceled = false, started; const waiting = new Promise(resolve => { started = resolve; }), signal = new AbortController();
  const stream = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { canceled = true; } });
  const read = readGoogleMusic(new Response(stream, { headers: { "content-type": "application/json" } }), request, signal.signal);
  await waiting; signal.abort(); await assert.rejects(read); assert.equal(canceled, true);
});
