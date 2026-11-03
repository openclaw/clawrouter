import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { groqMistralAudio, prepareGroqMistralAudio, observeGroqMistralAudio, readGroqMistralAudio } from "../groq-mistral-audio.ts";
const fixtures = Object.fromEntries(["groq", "mistral"].map(provider => [provider, JSON.parse(readFileSync(new URL(`../../providers/_fixtures/${provider}/transcription.json`, import.meta.url), "utf8"))]));
const upload = provider => { const f = fixtures[provider]; return { fields: { ...f.fields }, file: new File([Buffer.from(f.file.base64, "base64")], f.file.name, { type: f.file.type }) }; };

test("frozen Groq/Mistral uploads preserve exact models, paths, bytes and fields-before-file order", async () => {
  for (const provider of Object.keys(fixtures)) {
    const request = prepareGroqMistralAudio(provider, upload(provider));
    assert.equal(request.path, fixtures[provider].path); assert.equal(request.model, groqMistralAudio[provider].model);
    assert.deepEqual([...request.body.keys()], [...Object.keys(fixtures[provider].fields), "file"]);
    const file = request.body.get("file"); assert.equal(file.name, fixtures[provider].file.name); assert.equal(file.type, fixtures[provider].file.type);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
    for (const key of ["authorization", "content-type", "content-length"]) assert.equal(request.headers.has(key), false);
    const serialized = new Request("https://audio.example/transcriptions", { method: "POST", body: request.body, headers: request.headers });
    assert.match(serialized.headers.get("content-type"), /^multipart\/form-data; boundary=/);
    const parsed = await serialized.formData(); assert.equal(parsed.get("model"), request.model);
  }
});

test("new audio products, raw file handles and unsupported upgrades cannot enter these routes", () => {
  for (const provider of Object.keys(fixtures)) {
    for (const field of ["file_id", "file_url", "url", "diarize", "timestamp_granularities", "stream", "response_format", "context_bias"]) {
      const value = upload(provider); value.fields[field] = "true"; assert.throws(() => prepareGroqMistralAudio(provider, value), /option/);
    }
    const wrong = upload(provider); wrong.fields.model = provider === "groq" ? "whisper-large-v3" : "voxtral-mini-transcribe-3-0";
    assert.throws(() => prepareGroqMistralAudio(provider, wrong));
    for (const file of [new File([], "empty.wav", { type: "audio/wav" }), new File(["x"], "../audio.wav", { type: "audio/wav" }), new File(["x"], "audio.wav", { type: "image/png" })]) {
      assert.throws(() => prepareGroqMistralAudio(provider, { ...upload(provider), file }));
    }
  }
  assert.throws(() => prepareGroqMistralAudio("__proto__", upload("groq")), /provider/);
});

test("Mistral prompt incompatibility is explicit and Groq prompt text is never rewritten", () => {
  const value = upload("mistral"); value.fields.prompt = "Keep this context.";
  assert.throws(() => prepareGroqMistralAudio("mistral", value), /mistral_prompt_unqualified/);
  const groq = upload("groq"); assert.equal(prepareGroqMistralAudio("groq", groq).body.get("prompt"), groq.fields.prompt);
});

test("completed transcripts preserve native model/usage without guessing billed seconds or price", () => {
  for (const provider of Object.keys(fixtures)) {
    const body = fixtures[provider].response, observation = observeGroqMistralAudio(provider, body, true);
    assert.equal(observation.body, body); assert.equal(observation.text, body.text); assert.equal(observation.costMicros, undefined);
    assert.equal(observation.requestedModel, fixtures[provider].fields.model);
    assert.throws(() => observeGroqMistralAudio(provider, body, false));
    for (const invalid of [{ text: "" }, { text: "prefix", error: {} }, { text: "partial", finish_reason: "length" }]) assert.throws(() => observeGroqMistralAudio(provider, invalid, true));
  }
  assert.equal(observeGroqMistralAudio("groq", fixtures.groq.response, true).observedAudioSeconds, null);
  const mistral = observeGroqMistralAudio("mistral", fixtures.mistral.response, true);
  assert.equal(mistral.observedModel, "voxtral-mini-2602"); assert.equal(mistral.observedAudioSeconds, 2);
  assert.equal(observeGroqMistralAudio("mistral", { text: "ok", usage: { prompt_audio_seconds: -1 } }, true).observedAudioSeconds, null);
});

test("HTTP results require valid complete bounded JSON and matching Content-Length", async () => {
  for (const provider of Object.keys(fixtures)) {
    assert.equal((await readGroqMistralAudio(Response.json(fixtures[provider].response), provider, new AbortController().signal)).text, fixtures[provider].response.text);
  }
  const bad = [Response.json({ text: "ok" }, { status: 202 }), new Response('{"text":"partial"', { headers: { "content-type": "application/json" } }), new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }), Response.json({ text: "ok" }, { headers: { "content-length": "999" } }), Response.json({ text: "ok" }, { headers: { "content-length": "1048577" } })];
  for (const response of bad) await assert.rejects(() => readGroqMistralAudio(response, "groq", new AbortController().signal));
});

test("aborting response delivery cancels a stalled stream without claiming remote cancellation", async () => {
  let canceled = false, started; const waiting = new Promise(resolve => { started = resolve; }), signal = new AbortController();
  const stream = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { canceled = true; } });
  const response = readGroqMistralAudio(new Response(stream, { headers: { "content-type": "application/json" } }), "groq", signal.signal);
  await waiting; signal.abort(); await assert.rejects(response); assert.equal(canceled, true);
  assert.equal(fixtures.groq.transport.automaticPostReplay, false);
});
