import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareDeepgramPrerecorded, observeDeepgramPrerecorded, deepgramAudioLimit } from "../deepgram-prerecorded.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepgram/prerecorded.json", import.meta.url), "utf8"));
const bytes = new Uint8Array(Buffer.from(wire.request.base64, "base64"));
const prepare = (query = new URLSearchParams(wire.request.query), body = bytes, mime = wire.request.contentType) => prepareDeepgramPrerecorded(body, mime, query);

test("Deepgram keeps binary bytes and ordered repeated options outside JSON", () => {
  const query = new URLSearchParams(wire.request.query), result = prepare(query);
  assert.equal(result.body, bytes);
  assert.deepEqual([...result.query], wire.request.query);
  result.query.set("model", "changed");
  assert.equal(query.get("model"), "nova-3");
  assert.equal(prepare(new URLSearchParams()).query.get("model"), "nova-3");
});

test("Deepgram rejects async callbacks, remote URLs, credentials and ambiguous model queries", () => {
  for (const suffix of [
    "callback=https%3A%2F%2Fcallback.example", "callback_method=POST", "url=https%3A%2F%2Faudio.example",
    "token=synthetic", "model=flux-general-en", "model=nova-3&model=nova-3", "smart_format=1",
    "channels=0", "sample_rate=1e4", "language=en&language=fr", "keyterm=%0A", "unknown=true",
  ]) assert.throws(() => prepare(new URLSearchParams(suffix)));
});

test("Deepgram binary envelope is bounded and cannot accept a JSON URL request", () => {
  assert.throws(() => prepare(undefined, new Uint8Array()), /binary request/);
  assert.throws(() => prepare(undefined, new Uint8Array(deepgramAudioLimit + 1)), /binary request/);
  assert.throws(() => prepare(undefined, bytes, "application/json"), /binary audio/);
  assert.throws(() => prepare(undefined, { url: "https://audio.example" }), /binary request/);
  assert.doesNotThrow(() => prepare(undefined, bytes, "application/octet-stream"));
  assert.throws(() => prepare(new URLSearchParams({ keyterm: "x".repeat(2049) })), /value is invalid/);
});

test("Deepgram keeps independent channel tracks and duration without inventing token or dollar usage", () => {
  assert.deepEqual(observeDeepgramPrerecorded(wire.response, true), {
    text: "synthetic repeated track\n\nsynthetic repeated track", durationSeconds: 1.25, channels: 2,
  });
  const value = structuredClone(wire.response);
  value.metadata = { duration: "1.25", channels: 1.5 };
  assert.deepEqual(observeDeepgramPrerecorded(value, true), {
    text: "synthetic repeated track\n\nsynthetic repeated track", durationSeconds: null, channels: null,
  });
});

test("Deepgram partial, error and malformed tracks never become a complete transcript", () => {
  assert.equal(observeDeepgramPrerecorded(wire.response, false), null);
  for (const value of [
    {}, { ...wire.response, err_code: "INSUFFICIENT_PERMISSIONS" }, { ...wire.response, error: "synthetic" },
    { results: { channels: [] } }, { results: { channels: [{ alternatives: [] }] } },
    { results: { channels: [{ alternatives: [{ transcript: 12 }] }] } },
  ]) assert.equal(observeDeepgramPrerecorded(value, true), null);
  const silent = { results: { channels: [{ alternatives: [{ transcript: "" }] }] } };
  assert.deepEqual(observeDeepgramPrerecorded(silent, true), { text: "", durationSeconds: null, channels: null });
});
