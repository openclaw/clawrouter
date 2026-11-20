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
    "channels=0", "sample_rate=1e4", "language=en&language=fr", "keyterm=%0A", "unknown=true", "keywords=synthetic", "keywords=synthetic&keywords=fixture",
  ]) assert.throws(() => prepare(new URLSearchParams(suffix)));
});

test("Deepgram final query bounds include the default Nova-3 identity without discarding repeated keyterms", () => {
  const exact = new URLSearchParams(Array.from({ length: 127 }, () => ["keyterm", "synthetic"]));
  assert.equal([...prepare(exact).query].length, 128); assert.equal(prepare(exact).query.getAll("keyterm").length, 127);
  exact.append("keyterm", "one more"); assert.throws(() => prepare(exact), /query exceeds/);
  const pairs = Array.from({ length: 9 }, () => ["keyterm", "x".repeat(1800)]);
  const base = new URLSearchParams([...pairs, ["model", "nova-3"]]);
  pairs[8][1] += "x".repeat(16_384 - base.toString().length);
  const bounded = prepare(new URLSearchParams(pairs)); assert.equal(bounded.query.toString().length, 16_384);
  pairs[8][1] += "x"; assert.throws(() => prepare(new URLSearchParams(pairs)), /query exceeds/);
  assert.equal(new URLSearchParams(pairs).has("model"), false, "defaulting does not mutate caller query");
});

test("Deepgram raw fixture is complete playable WAV while independent response tracks remain native evidence", () => {
  const wav = Buffer.from(bytes);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.readUInt32LE(4) + 8, wav.length);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt "); assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 8000); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data"); assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.equal(wire.billing.responseIsIndependentSyntheticExample, true); assert.equal(wire.billing.actualProviderCostMicrousd, null);
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
