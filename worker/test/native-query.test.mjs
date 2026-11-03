import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { qualifyNativeQuery, nativeDispatchQuery, nativeQuerySearch } = await import("../native-query.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const origin = "https://api.elevenlabs.io", path = "/v1/text-to-speech/syntheticVoice1234567";
const requestUrl = () => new URL("https://router.example/v1/proxy/elevenlabs/speech");
const invalid = error => error.status === 400 && error.code === "invalid_native_response_query";
function selection() {
  return { provider: { id: "elevenlabs" }, capability: "audio.speech", model: null, method: "POST", body: { text: "synthetic speech" },
    pathParams: { voice_id: "syntheticVoice1234567" }, endpoint: { method: "POST", path: "/v1/text-to-speech/${voice_id}", path_params: ["voice_id"],
      request_format: "elevenlabs.speech", response_format: "audio.binary", query: {} } };
}
function bind(selected, input, url = requestUrl()) {
  selected.nativeQuery = qualifyNativeQuery(selected, input, url);
  selected.nativeResponse = { origin, path, query: selected.nativeQuery };
  return nativeDispatchQuery(selected, input, url);
}
for (const latency of [undefined, "0", "1", "2", "3", "4"]) test(`speech query binds complete MP3 with latency ${latency ?? "default"} identically for native and manifest`, () => {
  const input = { output_format: "mp3_44100_128", ...(latency === undefined ? {} : { optimize_streaming_latency: latency }) };
  const selected = selection(), before = structuredClone(selected), manifest = bind(selected, input);
  assert.equal(Object.isFrozen(selected.nativeQuery), true); assert.equal(selected.nativeQuery.protocol, "elevenlabs.speech");
  assert.equal(selected.nativeQuery.outputFormat, "mp3_44100_128"); assert.equal(selected.nativeQuery.optimizeStreamingLatency, latency);
  assert.deepEqual(selected.body, before.body); assert.deepEqual(selected.pathParams, before.pathParams);
  const url = new URL("https://router.example/v1/native/elevenlabs" + path + "?" + new URLSearchParams(Object.entries(input).reverse()));
  const native = bind(selection(), url.searchParams, url); assert.equal(native.toString(), manifest.toString());
  assert.doesNotThrow(() => assertNativeResponseDestination(selected.nativeResponse, new URL(origin + path + "?" + manifest)));
});
test("speech output omission becomes an explicit qualified default, without accepting another format", () => {
  const selected = selection(), query = bind(selected, {}); assert.equal(query.toString(), "output_format=mp3_44100_128");
  assert.throws(() => bind(selection(), { output_format: "pcm_16000" }), invalid);
  assert.throws(() => bind(selection(), { output_format: "opus_48000_64" }), invalid);
});
for (const [name, input] of [
  ["duplicate format", new URLSearchParams("output_format=mp3_44100_128&output_format=mp3_44100_128")],
  ["duplicate latency", new URLSearchParams("optimize_streaming_latency=1&optimize_streaming_latency=2")],
  ["unknown secret", { api_key: "synthetic-secret" }], ["arbitrary URL", { url: "https://other.example" }],
  ["array", { output_format: ["mp3_44100_128"] }], ["numeric latency", { optimize_streaming_latency: 2 }],
  ["null", { output_format: null }], ["line ending", { output_format: "mp3_44100_128\n" }],
  ["unqualified latency", { optimize_streaming_latency: "5" }], ["empty", { output_format: "" }],
]) test(`speech query rejects ${name} without echoing values`, () => {
  assert.throws(() => bind(selection(), input), error => { assert.doesNotMatch(error.message, /synthetic-secret|other.example/); return invalid(error); });
});
test("native and manifest query carriers cannot disagree or be combined", () => {
  const url = new URL(requestUrl()); url.search = "?output_format=mp3_44100_128";
  assert.throws(() => bind(selection(), {}, url), invalid);
  assert.throws(() => bind(selection(), new URLSearchParams("optimize_streaming_latency=2"), url), invalid);
  url.search = "?" + "x".repeat(257); assert.throws(() => bind(selection(), url.searchParams, url), invalid);
});
test("speech query requires the exact compiled route and native response before dispatch", () => {
  for (const mutate of [
    s => { s.provider.id = "other"; }, s => { s.capability = "llm.chat"; }, s => { s.model = {}; }, s => { s.method = "GET"; },
    s => { s.endpoint.method = "GET"; }, s => { s.endpoint.path += "/stream"; }, s => { s.endpoint.path_params = []; },
    s => { s.endpoint.response_format = "json"; }, s => { s.endpoint.upstreamPath = "/other"; }, s => { s.endpoint.query = { output_format: "mp3_44100_128" }; },
    s => { s.endpoint.streaming = "sse"; }, s => { s.endpoint.websocket = "native"; }, s => { s.endpoint.lifecycle = {}; },
    s => { s.endpoint.responsesLifecycle = {}; }, s => { s.endpoint.modelPassthrough = {}; },
  ]) { const selected = selection(); mutate(selected); assert.throws(() => bind(selected, {}), invalid); }
  const selected = selection(); selected.nativeQuery = qualifyNativeQuery(selected, {}, requestUrl());
  assert.throws(() => nativeDispatchQuery(selected, {}, requestUrl()), invalid);
  selected.nativeResponse = { origin, path }; assert.throws(() => nativeDispatchQuery(selected, {}, requestUrl()), invalid);
});
test("post-validation query and destination changes cannot bypass either guard", () => {
  const selected = selection(); bind(selected, { optimize_streaming_latency: "2" });
  assert.throws(() => nativeDispatchQuery(selected, { optimize_streaming_latency: "3" }, requestUrl()), invalid);
  for (const url of [origin + path, origin + path + "?output_format=mp3_44100_128&optimize_streaming_latency=3",
    origin + path + "?output_format=mp3_44100_128&optimize_streaming_latency=2&key=synthetic", "https://other.example" + path,
    origin + path + "/stream", origin + path + nativeQuerySearch(selected.nativeQuery) + "#fragment",
    "https://user:synthetic@api.elevenlabs.io" + path + nativeQuerySearch(selected.nativeQuery)]) {
    assert.throws(() => assertNativeResponseDestination(selected.nativeResponse, new URL(url)), error => error.code === "invalid_native_response_destination");
  }
});
test("query-less native operations retain strict rejection and unrelated generic queries remain unchanged", () => {
  const selected = selection(); selected.endpoint.request_format = "openai.audio_speech";
  const input = new URLSearchParams("sample=value");
  assert.equal(qualifyNativeQuery(selected, input, requestUrl()), undefined);
  assert.equal(nativeDispatchQuery(selected, input, requestUrl()), input);
  selected.nativeResponse = { origin, path }; assert.throws(() => nativeDispatchQuery(selected, input, requestUrl()), invalid);
  assert.throws(() => assertNativeResponseDestination(selected.nativeResponse, new URL(origin + path + "?sample=value")));
  selected.nativeResponse.query = { protocol: "elevenlabs.speech", outputFormat: "mp3_44100_128" };
  assert.throws(() => nativeDispatchQuery(selected, {}, requestUrl()), invalid);
});
