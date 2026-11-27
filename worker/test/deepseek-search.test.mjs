import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareDeepSeekSearch, observeDeepSeekSearch, readDeepSeekSearch, deepSeekSearchTariff } from "../deepseek-search.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepseek/search.json", import.meta.url), "utf8"));
const request = prepareDeepSeekSearch(wire.request.body);

test("DeepSeek preserves the frozen native search wire and counts Unicode characters", () => {
  assert.equal(request.path, wire.request.path);
  assert.deepEqual(request.body, wire.request.body);
  assert.equal(request.headers.get("authorization"), null);
  assert.equal(prepareDeepSeekSearch({ query: "synthetic" }).body.count, 5);
  assert.equal(prepareDeepSeekSearch({ query: "🦊".repeat(128) }).body.query.length, 256);
  for (const query of [" ", "🦊".repeat(129), "\ud800"]) assert.throws(() => prepareDeepSeekSearch({ query }));
  for (const options of [{ count: 11 }, { count: 0 }, { count: 1.5 }, { count: "5" }, { need_content: true }, { localization: "127.0.0.1" }, { language: "en" }, { model: "deepseek-v4-pro" }]) {
    assert.throws(() => prepareDeepSeekSearch({ query: "synthetic", ...options }));
  }
});

test("DeepSeek result mapping preserves model summaries and safe opaque URLs", () => {
  const result = observeDeepSeekSearch(wire.response, request, true);
  assert.equal(result.body, wire.response);
  assert.deepEqual(result.results, [{ title: "Synthetic result", url: "https://example.com/result",
    snippet: "Synthetic model-oriented summary.", published: "2026-11-01T00:00:00Z", siteName: "Example" }]);
  assert.equal(result.billableRequests, 1);
  const fallback = structuredClone(wire.response); fallback.results[0].summary = ""; fallback.results[0].date = "unqualified";
  assert.equal(observeDeepSeekSearch(fallback, request, true).results[0].snippet, "Short synthetic snippet.");
  assert.equal(observeDeepSeekSearch(fallback, request, true).results[0].published, undefined);
  for (const url of ["https://user:synthetic@example.com/result", "data:text/html,synthetic", "file:///synthetic"]) {
    assert.equal(observeDeepSeekSearch({ results: [{ url }] }, request, true).results.length, 0);
  }
});

test("DeepSeek billing observes native nonempty results even when all destinations are filtered", () => {
  const empty = observeDeepSeekSearch(wire.empty, request, true), filtered = observeDeepSeekSearch(wire.filtered, request, true);
  assert.equal(empty.billableRequests, 0);
  assert.equal(filtered.results.length, 0); assert.equal(filtered.nativeResultCount, 1);
  assert.equal(filtered.omittedResults, true); assert.equal(filtered.billableRequests, 1);
  assert.equal(deepSeekSearchTariff.successfulNonemptyRequestMicros, 750);
  assert.equal(wire.billing.partialDeliveryCostMicrousd, null);
  assert.equal(deepSeekSearchTariff.source, wire.billing.source);
  assert.equal(deepSeekSearchTariff.effectiveAt, wire.billing.effectiveAt);
});

test("DeepSeek incomplete, malformed and error results cannot become zero-cost search evidence", () => {
  assert.throws(() => observeDeepSeekSearch(wire.empty, request, false));
  for (const body of [{}, { results: null }, { results: [null] }, { results: [], error: { code: "synthetic" } }, { results: Array(51).fill({ url: "https://example.com" }) }, { results: [{ url: "https://example.com", summary: 42 }] }]) {
    assert.throws(() => observeDeepSeekSearch(body, request, true));
  }
  const result = observeDeepSeekSearch({ results: Array(6).fill(wire.response.results[0]) }, request, true);
  assert.equal(result.results.length, 5); assert.equal(result.nativeResultCount, 6); assert.equal(result.billableRequests, 1);
});

test("DeepSeek response reads require HTTP 200 and complete bounded JSON EOF", async () => {
  assert.equal((await readDeepSeekSearch(Response.json(wire.response), request)).billableRequests, 1);
  const responses = [
    Response.json(wire.empty, { status: 503 }),
    new Response(JSON.stringify(wire.empty)),
    new Response('{"results":[', { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "1048577" } }),
  ];
  for (const response of responses) await assert.rejects(() => readDeepSeekSearch(response, request));
});
