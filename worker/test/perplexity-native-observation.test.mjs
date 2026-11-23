import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSseUsageInspector, extractUsageTokens, responseOutcome } from "../token-usage.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/perplexity/native-contracts.json", import.meta.url), "utf8"));
const encode = events => new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));

test("Perplexity Agent JSON observes inclusive tokens without turning provider-reported costs into a tariff", () => {
  const tokens = extractUsageTokens(wire.agent.response);
  assert.equal(tokens.input, 1000);
  assert.equal(tokens.output, 100);
  assert.equal(tokens.total, 1100);
  assert.equal(tokens.cached, 200);
  assert.equal(responseOutcome(wire.agent.response), "success");
  assert.equal(tokens.actual_cost_micros, undefined);
  assert.equal(wire.billing.agentQualifiedWholeRunBoundMicros, null);
  assert.notEqual(wire.billing.policyFixedMicros, wire.billing.agentReportedCostMicros);
});

test("Perplexity Agent typed SSE reaches the same terminal usage across UTF-8 and frame boundaries", () => {
  const bytes = encode(wire.agent.streamEvents);
  for (const width of [1, 7, bytes.length]) {
    const inspector = createSseUsageInspector();
    for (let i = 0; i < bytes.length; i += width) inspector.push(bytes.subarray(i, i + width));
    assert.deepEqual(inspector.result(), { tokens: extractUsageTokens(wire.agent.response), outcome: "success" });
  }
});

test("Perplexity Agent root-level stream failure after output cannot become successful completion", () => {
  const inspector = createSseUsageInspector();
  inspector.push(encode(wire.agent.failureEvents));
  assert.deepEqual(inspector.result(), { tokens: null, outcome: "provider_error" });
  assert.equal(wire.agent.failureEvents.at(-1).response, undefined, "native failed event carries error at the top level");
});

test("Perplexity Search results and empty success supply no invented token usage", () => {
  for (const body of [wire.search.response, wire.search.emptyResponse, wire.search.rejection.body]) {
    assert.equal(extractUsageTokens(body), null);
  }
  assert.equal(responseOutcome(wire.search.response), null, "Search has no Agent terminal envelope");
  assert.equal(wire.search.response.choices, undefined);
  assert.equal(wire.search.response.output, undefined);
});


// Frozen OpenAPI grammar: https://docs.perplexity.ai/api-reference/search-post.md
// Standalone Search rates: https://docs.perplexity.ai/docs/getting-started/pricing
// Missing search_type: https://docs.perplexity.ai/docs/search/fast-search
const { perplexitySearchOutcome, selectRequestTariff } = await import("../request-tariff.ts");
const { observeUsage } = await import("../proxy-response.ts");
const { HttpOperation } = await import("../http-operation.ts");
const tariff = selectRequestTariff({ method: "POST", path: "/search", request_format: "perplexity.search", response_format: "perplexity.search",
  requestPricing: { unit: "request", version: "perplexity-search-2026-11-03", effectiveAt: "2026-11-03", source: "https://docs.perplexity.ai/docs/getting-started/pricing", successfulResponseMicros: 5000,
    parameterRates: { parameter: "search_type", rates: { web: 5000, fast: 1000 } } } }, {});

test("Search receipt follows the frozen OpenAPI types, including empty strings and nullable metadata", () => {
  for (const value of [{ id: "", results: [] }, { id: "synthetic", server_time: null, results: [{ title: "", url: "", snippet: "", date: null, last_updated: null }] }])
    assert.equal(perplexitySearchOutcome(value, 200), "succeeded");
  for (const value of [{ results: [] }, { id: 1, results: [] }, { id: "", results: [], server_time: 1 }, { id: "", results: [{}] },
    { id: "", results: [{ title: "", url: "", snippet: "", date: 1 }] }, { id: "", results: [], error: null }])
    assert.equal(perplexitySearchOutcome(value, 200), "unknown");
  for (const [status, type] of [[400, "invalid_request"], [400, "invalid_language_code"], [400, "invalid_country_code"], [401, "invalid_api_key"], [429, ""]])
    assert.equal(perplexitySearchOutcome({ error: { message: "", type, code: status } }, status), "failed");
  for (const [status, value] of [[200, { error: { message: "", type: "invalid_request", code: 200 } }], [400, { error: { message: "", type: "other", code: 400 } }],
    [400, { error: { message: "", type: "invalid_request", code: 401 } }], [429, { error: { message: "", type: "rate_limit" } }],
    [503, { error: { message: "", type: "upstream", code: 503 } }], [400, { detail: [] }], [400, { results: [], error: { message: "", type: "invalid_request", code: 400 } }]])
    assert.equal(perplexitySearchOutcome(value, status), "unknown");
});

test("Search cannot mint success before EOF or hide an independent original release rejection", async () => {
  for (const mode of ["cancel", "deadline", "read-error", "release-error", "release-undefined", "release-null"]) {
    let calls = 0, cancelCalls = 0; const failure = ["read-error", "release-undefined"].includes(mode) ? undefined : mode === "release-null" ? null : new Error("synthetic independent cleanup");
    const operation = new HttpOperation();
    const body = new ReadableStream({ pull(controller) { if (calls++ === 0) controller.enqueue(new TextEncoder().encode('{"id":"synthetic","results":[]}')); else if (mode === "read-error") controller.error(failure); },
      cancel() { cancelCalls++; } }, { highWaterMark: 0 });
    if (mode.startsWith("release-")) { const getReader = body.getReader; body.getReader = function (...args) { const reader = Reflect.apply(getReader, this, args), release = reader.releaseLock; reader.releaseLock = function (...args) { Reflect.apply(release, this, args); throw failure; }; return reader; }; }
    const observed = observeUsage(new Response(body, { headers: { "content-type": "application/json" } }), operation, undefined, "perplexity.search", tariff);
    const reader = observed.response.body.getReader(); await reader.read(); const pending = reader.read();
    if (mode === "deadline") operation.stop("deadline", new Error("synthetic deadline")); else if (mode !== "read-error") operation.cancel(new Error("synthetic caller"));
    await Promise.allSettled([pending, reader.closed]); reader.releaseLock();
    const result = await observed.result; assert.equal(result.requestTariffOutcome, "unknown"); assert.equal(result.tokens, null);
    const retired = await Promise.allSettled([observed.retired]);
    if (mode.startsWith("release-")) { assert.equal(retired[0].status, "rejected"); assert.equal(retired[0].reason, failure); }
    assert.equal(cancelCalls, mode === "read-error" ? 0 : 1);
  }
});

test("Search receipt rejects invalid UTF8, trailing data, absent bodies and unrelated formats", async () => {
  for (const [body, format, mime] of [[new Uint8Array([123, 255, 125]), "perplexity.search", "application/json"],
    ['{"id":"synthetic","results":[]} trailing', "perplexity.search", "application/json"],
    ['{"id":"synthetic","results":[]}', "other.search", "application/json"],
    ['{"id":"synthetic","results":[]}', "perplexity.search", "text/plain"], ['{"id":"synthetic","results":[]}', "perplexity.search", "application/notjson"], [null, "perplexity.search", "application/json"]]) {
    const observed = observeUsage(new Response(body, { headers: { "content-type": mime } }), new HttpOperation(), undefined, format, tariff);
    await observed.response.arrayBuffer().catch(() => {}); const result = await observed.result;
    assert.notEqual(result.requestTariffOutcome, "succeeded"); assert.equal(result.tokens, null);
    await Promise.allSettled([observed.retired]);
  }
});


test("Search ignores spurious token usage under both request tariffs and policy-fixed observation", async () => {
  for (const selected of [tariff, undefined]) {
    const value = { id: "synthetic", results: [], usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 } };
    const observed = observeUsage(Response.json(value), new HttpOperation(), undefined, "perplexity.search", selected);
    assert.deepEqual(await observed.response.json(), value); const result = await observed.result; await observed.retired;
    assert.equal(result.tokens, null); assert.equal(result.requestTariffOutcome, selected ? "succeeded" : undefined);
  }
});
