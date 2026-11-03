import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { qualifyNativeQuery, nativeDispatchQuery } = await import("../native-query.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { prepareSelected } = await import("../proxy.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const voice = "syntheticVoice1234567", body = { text: "Synthetic speech", model_id: "eleven_multilingual_v2" };
const origin = "https://api.elevenlabs.io", path = `/v1/text-to-speech/${voice}`;
async function setup(t, pooled = false) {
  const original = snapshot.providers; snapshot.providers = original.filter(provider => provider.id !== "elevenlabs");
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { pooled, providerId: "elevenlabs", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([{
      schema: "clawrouter.service-provider.v1", id: "elevenlabs", displayName: "ElevenLabs fixture",
      auth: { schemes: [{ type: "api_key", header: "xi-api-key", secretKind: "api_key" }] }, baseUrls: { default: origin },
      capabilities: [{ id: "audio.speech", endpoint: "speech", methods: ["POST"] }],
      endpoints: { speech: { path: "/v1/text-to-speech/${voice_id}", pathParams: ["voice_id"], requestFormat: "elevenlabs.speech", responseFormat: "audio.binary" } },
    }]).providers[0]);
  } });
  f.env.ELEVENLABS_API_KEY = "synthetic-speech-environment";
  f.selected = () => ({ provider: f.provider, endpoint: f.provider.endpoints[0], model: null, capability: "audio.speech", method: "POST",
    body: structuredClone(body), pathParams: { voice_id: voice } });
  f.request = query => correlateIngressRequest(new Request("https://router.example/v1/native/elevenlabs" + path + (query ? "?" + query : ""), {
    method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "xi-api-key": "synthetic-caller-key", "content-type": "application/json" }, body: JSON.stringify(body),
  })).request;
  f.auth = request => authenticateProxyKey(request.headers, f.env, [{ id: "elevenlabs", tokenRef: "elevenlabs" }]);
  t.after(f.drain); return f;
}
for (const pooled of [false, true]) test(`query preflight preserves original ${pooled ? "pooled" : "environment"} credential, voice path and JSON`, { timeout: 10_000 }, async t => {
  const f = await setup(t, pooled), request = f.request("optimize_streaming_latency=2&output_format=mp3_44100_128"), selected = f.selected();
  const query = new URL(request.url).searchParams;
  selected.nativeQuery = qualifyNativeQuery(selected, query, new URL(request.url));
  // Only exercise the common factory boundary, not a replacement speech wrapper.
  selected.nativeResponse = { origin, path, query: selected.nativeQuery };
  const auth = await f.auth(request); assert.ok(!(auth instanceof Response));
  const prepared = await prepareSelected(request, f.env, selected, query, auth);
  assert.equal(prepared.url.href, origin + path + "?output_format=mp3_44100_128&optimize_streaming_latency=2");
  assert.doesNotThrow(() => assertNativeResponseDestination(selected.nativeResponse, prepared.url));
  assert.equal(prepared.headers.get("xi-api-key"), pooled ? "synthetic-original-key" : "synthetic-speech-environment");
  assert.equal(prepared.headers.get("authorization"), null); assert.deepEqual(JSON.parse(prepared.requestBody), body);
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});
for (const pooled of [false, true]) for (const manifest of [false, true]) test(`unwired speech ${manifest ? "manifest" : "native"}/${pooled ? "pooled" : "environment"} stays zero-egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t, pooled), query = { output_format: "mp3_44100_128", optimize_streaming_latency: "2" };
  const response = await f.call(manifest ? "/v1/proxy/elevenlabs/speech" : "/v1/native/elevenlabs" + path + "?" + new URLSearchParams(query),
    manifest ? { body, pathParams: { voice_id: voice }, query } : body);
  const result = await response.json(); assert.equal(response.status, 400, JSON.stringify(result));
  assert.equal(result.error.code, "invalid_native_response_query"); assert.equal(f.sent.length, 0);
  assert.ok(f.budgetCalls.every(call => call.path === "/status"));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-original-key|synthetic-speech-environment/);
});
test("query preflight rejects a changed binding before original credential selection", { timeout: 10_000 }, async t => {
  const f = await setup(t, true), request = f.request("optimize_streaming_latency=2"), selected = f.selected();
  selected.nativeQuery = qualifyNativeQuery(selected, new URL(request.url).searchParams, new URL(request.url));
  selected.nativeResponse = { origin, path, query: selected.nativeQuery };
  const auth = await f.auth(request);
  await assert.rejects(prepareSelected(request, f.env, selected, new URLSearchParams("optimize_streaming_latency=3"), auth), error => error.code === "invalid_native_response_query");
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});
test("server or grant query additions cannot become qualified native options", { timeout: 10_000 }, async t => {
  const f = await setup(t), request = f.request(), selected = f.selected();
  selected.nativeQuery = qualifyNativeQuery(selected, {}, new URL(request.url)); selected.nativeResponse = { origin, path, query: selected.nativeQuery };
  const canonical = nativeDispatchQuery(selected, {}, new URL(request.url));
  const destination = new URL(origin + path + "?" + canonical); destination.searchParams.set("key", "synthetic-injected");
  assert.throws(() => assertNativeResponseDestination(selected.nativeResponse, destination), error => error.code === "invalid_native_response_destination");
  assert.equal(f.sent.length, 0);
});
