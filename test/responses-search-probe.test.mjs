import assert from "node:assert/strict";
import test from "node:test";
import { directResponsesSearchProbe, responsesSearchSummary, responseToolLimit } from "../scripts/responses-search-probe.mjs";

const url = "https://example.com/", marker = "fixture-unseen-marker";
const successful = () => ({ status: "completed", output: [
  { type: "reasoning", encrypted_content: "fixture-private-ciphertext" },
  { type: "web_search_call", status: "completed", action: { type: "open_page", url } },
  { type: "message", content: [{ type: "output_text", text: `Current retrieval marker: ${marker}`, annotations: [{ private: "fixture-private-annotation" }] }] },
], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });

test("Responses probe pins endpoint/model, live tool and cost bounds, and exposes only closed metadata", async () => {
  const result = await directResponsesSearchProbe({ key: "fixture-only-key", url, marker, fetcher: async (address, init) => {
    assert.equal(address, "https://api.openai.com/v1/responses");
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer fixture-only-key");
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-6.1-sol"); assert.equal(body.store, false);
    assert.deepEqual(body.tools, [{ type: "web_search", external_web_access: true }]);
    assert.deepEqual(body.tool_choice, { type: "web_search" });
    assert.equal(body.max_tool_calls, 3); assert.equal(body.max_output_tokens, 2048);
    assert.equal(body.parallel_tool_calls, false); assert.deepEqual(body.reasoning, { effort: "low" });
    assert.ok(body.input.includes(url)); assert.ok(!init.body.includes(marker)); assert.ok(!init.body.includes("fixture-only-key"));
    return Response.json(successful(), { headers: { "x-request-id": "req_fixture" } });
  } });
  assert.equal(result.summary.toolSuccess, true); assert.equal(result.summary.markerReturned, true);
  assert.equal(result.summary.targetOpened, true); assert.equal(result.summary.webSearchCalls, 1);
  assert.deepEqual(result.summary.actions, { search: 0, openPage: 1, findInPage: 0, unknown: 0 });
  assert.deepEqual(result.summary.usageTokens, { input: 10, output: 20, total: 30 });
  assert.doesNotMatch(JSON.stringify(result.summary), /fixture-private|fixture-only-key|fixture-unseen-marker|example\.com/);
});

test("returned text alone cannot qualify failed, incomplete, refused, missing, excessive or unknown tool activity", () => {
  for (const change of [
    value => { value.status = "incomplete"; value.incomplete_details = { reason: "fixture-private-reason" }; },
    value => { value.error = { message: "fixture-private-error" }; },
    value => { value.output[1].status = "failed"; },
    value => { value.output.splice(1, 1); },
    value => { value.output.push({ type: "function_call", arguments: "fixture-private-arguments" }); },
    value => { value.output[2].content.push({ type: "refusal", refusal: "fixture-private-refusal" }); },
    value => { value.output[1].action.type = "__proto__"; },
    value => { value.output[1].action.type = "constructor"; },
    value => { for (let i = 0; i < responseToolLimit; i++) value.output.push(structuredClone(value.output[1])); },
  ]) {
    const value = successful(); change(value);
    const result = responsesSearchSummary(new Response(null), value, marker, url);
    assert.equal(result.markerReturned, true); assert.equal(result.toolSuccess, false);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private|__proto__|constructor|fixture-unseen-marker/);
  }
});

test("HTTP errors and malformed Responses shapes retain failure metadata without raw body or identifiers", () => {
  for (const value of [null, {}, { status: "private-status", output: "private-text", error: { message: "private-error" }, usage: { input_tokens: "private-usage" } }]) {
    const result = responsesSearchSummary(new Response(null, { status: 403, headers: { "x-request-id": "private-id" } }), value, marker, url);
    assert.equal(result.status, 403); assert.equal(result.responseStatus, "unknown");
    assert.equal(result.toolSuccess, false); assert.equal(result.requestId, null);
    assert.equal(result.markerReturned, false); assert.equal(result.usageTokens, null);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test("search/find actions are counted, unknown usage discarded, and assistant text errors survive HTTP 200", () => {
  const value = successful();
  value.output[1].action.type = "search";
  value.output.push({ type: "web_search_call", status: "completed", action: { type: "find_in_page", pattern: "fixture-private-pattern", url } });
  value.output[2].content[0].text = "Internal Error";
  value.usage.total_tokens = -1;
  const result = responsesSearchSummary(new Response(null), value, marker, url);
  assert.deepEqual(result.actions, { search: 1, openPage: 0, findInPage: 1, unknown: 0 });
  assert.equal(result.targetOpened, false); assert.equal(result.internalError, true);
  assert.equal(result.markerReturned, false); assert.equal(result.toolSuccess, true);
  assert.equal(result.usageTokens, null); assert.equal(result.hasUsage, true);
});

test("Responses shares bounded JSON decoding and never retries malformed or oversized output", async () => {
  for (const text of ["fixture-private-invalid-json", "x".repeat(2 * 1024 * 1024 + 1)]) {
    let attempts = 0;
    await assert.rejects(directResponsesSearchProbe({ key: "fixture-only-key", url, marker, fetcher: async () => { attempts++; return new Response(text); } }), error => !error.message.includes("fixture-private"));
    assert.equal(attempts, 1);
  }
});
