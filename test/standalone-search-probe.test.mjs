import assert from "node:assert/strict";
import test from "node:test";
import { directSearchProbe, searchProbeSummary } from "../scripts/standalone-search-probe.mjs";

test("probe replay uses only the direct search endpoint and reports closed metadata across UTF-8 boundaries", async () => {
  const body = { id: "fixture-session", model: "gpt-6.1-sol", commands: { open: [{ ref_id: "https://example.com/" }] }, settings: { external_web_access: true } };
  const value = { encrypted_output: "private ciphertext", output: "秘密 ClawRouterProbeFixture", usage: { fixture: 1 }, future: "private text" };
  const result = await directSearchProbe({ key: "fixture-only-key", body, headers: { authorization: "Bearer incorrect-fixture", "session-id": "fixture-native-session", "content-length": "1", host: "invalid.example" }, marker: "ClawRouterProbeFixture", fetcher: async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/alpha/search");
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body), body);
    assert.equal(init.headers.get("authorization"), "Bearer fixture-only-key");
    assert.equal(init.headers.get("session-id"), "fixture-native-session");
    assert.equal(init.headers.has("content-length"), false); assert.equal(init.headers.has("host"), false);
    const bytes = new TextEncoder().encode(JSON.stringify(value)); let index = 0;
    return new Response(new ReadableStream({ pull(controller) { if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close(); } }), { headers: { "x-request-id": "req_fixture" } });
  } });
  assert.deepEqual(result.value, value);
  assert.deepEqual(result.summary, { status: 200, requestId: "req_fixture", outputChars: value.output.length, internalError: false, referenceError: false, fetchError: false, markerReturned: true, hasUsage: true, hasEncryptedOutput: true });
  assert.doesNotMatch(JSON.stringify(result.summary), /private|秘密|ClawRouterProbeFixture|fixture-only-key/);
});
test("HTTP-200 tool errors cannot qualify fresh content, and arbitrary response fields stay out of logs", () => {
  const response = new Response(null, { headers: { "x-request-id": "private response text" } });
  const result = searchProbeSummary(response, { output: "Internal Error", secret: "fixture secret", error: { message: "private error" } }, "hidden marker");
  assert.equal(result.internalError, true); assert.equal(result.markerReturned, false); assert.equal(result.requestId, null);
  assert.doesNotMatch(JSON.stringify(result), /private|fixture secret|Internal Error|hidden marker/);
});
test("probe bounds response bytes and rejects non-JSON without echoing provider content", async () => {
  const request = { key: "fixture-only-key", body: {} };
  await assert.rejects(directSearchProbe({ ...request, fetcher: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)) }), /response limit exceeded/);
  await assert.rejects(directSearchProbe({ ...request, fetcher: async () => new Response("private provider text") }), error => error.message === "direct search response is not JSON");
});
