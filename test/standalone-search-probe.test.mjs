import assert from "node:assert/strict";
import test from "node:test";
import { assertSearchToolSuccess, directSearchProbe, searchProbeSummary, searchResultsSummary } from "../scripts/standalone-search-probe.mjs";
import { liveUpstream } from "../scripts/smoke-codex-search-upstream.mjs";

test("probe replay uses only the direct search endpoint and reports closed metadata across UTF-8 boundaries", async () => {
  const body = { id: "fixture-session", model: "gpt-6.1-sol", commands: { open: [{ ref_id: "https://example.com/" }] }, settings: { external_web_access: true } };
  const value = { encrypted_output: "private ciphertext", output: "秘密 ClawRouterProbeFixture", usage: { fixture: 1 }, future: "private text", results: [{ type: "text_result", ref_id: "private-reference", url: "https://private.example/", title: "private title", snippet: "秘密 ClawRouterProbeFixture", future: { credential: "fixture-only-key" } }] };
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
  assert.deepEqual(result.summary, { status: 200, requestId: "req_fixture", outputChars: value.output.length, internalError: false, referenceError: false, fetchError: false, markerReturned: true, hasUsage: true, hasEncryptedOutput: true, results: { state: "array", count: 1, types: { textResult: 1, unknown: 0, malformed: 0 } } });
  assert.doesNotMatch(JSON.stringify(result.summary), /private|秘密|ClawRouterProbeFixture|fixture-only-key/);
});
test("structured results distinguish missing, null, empty and invalid fields without coercion", () => {
  const zero = { textResult: 0, unknown: 0, malformed: 0 };
  for (const value of [null, false, 3, "private text", [], {}, Object.create({ results: [] })]) {
    assert.deepEqual(searchResultsSummary(value), { state: "absent", count: null, types: zero });
  }
  assert.deepEqual(searchResultsSummary({ results: null }), { state: "null", count: null, types: zero });
  assert.deepEqual(searchResultsSummary({ results: [] }), { state: "array", count: 0, types: zero });
  for (const results of [undefined, false, 1, "private text", { type: "text_result", output: "private text" }]) {
    assert.deepEqual(searchResultsSummary({ results }), { state: "invalid", count: null, types: zero });
  }
});
test("only the observed text_result label is recognized; unknown labels never become log keys or values", () => {
  const results = [
    { type: "text_result", url: "https://private.example/", output: "private page", error: { message: "private error" } },
    { type: "fixture-private-new-type", snippet: "private snippet" },
    { type: "__proto__" }, { type: "constructor" }, { type: "toString" },
  ];
  const summary = searchResultsSummary({ results });
  assert.deepEqual(summary, { state: "array", count: 5, types: { textResult: 1, unknown: 4, malformed: 0 } });
  assert.doesNotMatch(JSON.stringify(summary), /private|https|__proto__|constructor|toString|text_result/);
  assert.equal(Object.getPrototypeOf(summary.types), Object.prototype);
});
test("malformed result entries are counted without inspecting nested content or inventing DTO rules", () => {
  const results = [null, true, 5, "private text", [], {}, { type: null }, { type: 5 }, { type: [] }, { type: "" }, Object.create({ type: "text_result" })];
  assert.deepEqual(searchResultsSummary({ results }), { state: "array", count: 11, types: { textResult: 0, unknown: 0, malformed: 11 } });
  // A recognized type does not establish the validity or semantics of other fields.
  assert.deepEqual(searchResultsSummary({ results: [{ type: "text_result" }] }), { state: "array", count: 1, types: { textResult: 1, unknown: 0, malformed: 0 } });
});
test("results metadata cannot turn an HTTP-200 tool error into success or reject unfamiliar successful output", () => {
  const value = { output: "Internal Error", encrypted_output: "private ciphertext", results: [{ type: "text_result", text: "private marker" }] };
  const summary = searchProbeSummary(new Response(null), value, "private marker");
  assert.equal(summary.internalError, true); assert.equal(summary.markerReturned, false);
  assert.deepEqual(summary.results, { state: "array", count: 1, types: { textResult: 1, unknown: 0, malformed: 0 } });
  assert.throws(() => assertSearchToolSuccess(value), /internal or fetch tool error/);
  assert.doesNotMatch(JSON.stringify(summary), /private|Internal Error/);
  for (const results of [undefined, null, [], [null], [{ type: "fixture-private-future-type" }], "private invalid field"]) {
    assert.doesNotThrow(() => assertSearchToolSuccess({ output: "A successful page", results }));
  }
});
test("HTTP errors retain status and bounded results metadata without exposing provider content", async () => {
  let attempts = 0;
  const result = await directSearchProbe({ key: "fixture-only-key", body: {}, fetcher: async () => {
    attempts++;
    return Response.json({ error: { message: "private error" }, results: "private invalid results" }, { status: 403 });
  } });
  assert.equal(attempts, 1); assert.equal(result.summary.status, 403);
  assert.deepEqual(result.summary.results, { state: "invalid", count: null, types: { textResult: 0, unknown: 0, malformed: 0 } });
  assert.doesNotMatch(JSON.stringify(result.summary), /private|fixture-only-key/);
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
test("normal qualification rejects HTTP-200 navigation errors without rejecting generic page vocabulary", () => {
  for (const output of ["Internal Error", "Failed to fetch https://example.com/", "URL is not safe to open", "Error fetching page", "403 Forbidden", "404 Not Found", "Invalid reference: turn0search0", "Unable to resolve click call"]) {
    assert.throws(() => assertSearchToolSuccess({ output }), /tool error/, output);
  }
  for (const value of [null, {}, { output: "" }]) assert.throws(() => assertSearchToolSuccess(value), /returns text output/);
  assert.doesNotThrow(() => assertSearchToolSuccess({ output: "A normal page discussing error handling, robots, and blocked permissions." }));
});
test("the actual live adapter retains a navigation failure after a successful native retry", async t => {
  t.mock.method(console, "error", () => {});
  let output = "Failed to fetch https://example.com/";
  t.mock.method(globalThis, "fetch", async () => Response.json({ output, encrypted_output: "fixture-ciphertext" }));
  const upstream = liveUpstream({ key: "fixture-only-key", models: ["gpt-6.1-sol"], mode: "cached", transport: "http" });
  const request = () => new Request("https://api.openai.com/v1/alpha/search", { method: "POST", body: JSON.stringify({ id: "fixture-session", model: "gpt-6.1-sol", commands: { open: [{ ref_id: "https://example.com/" }] }, settings: { external_web_access: false } }) });
  try {
    await assert.rejects(upstream.outbound(request()), /fetch tool error/);
    output = "A normal successful page";
    assert.equal((await upstream.outbound(request())).status, 200);
    assert.throws(() => upstream.check(), /fetch tool error/, "a recovered retry cannot qualify a failed operation");
  } finally { upstream.close(); }
});
