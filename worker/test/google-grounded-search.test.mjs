import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleGroundedSearchModel, prepareGoogleGroundedSearch, observeGoogleGroundedSearch, readGoogleGroundedSearch } from "../google-grounded-search.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/grounded-search.json", import.meta.url), "utf8"));
const prepare = body => prepareGoogleGroundedSearch(googleGroundedSearchModel, body);
const clone = () => structuredClone(wire.response);
const metadata = response => response.candidates[0].groundingMetadata;

test("Google grounded search preserves the frozen model, native tool and second-precision time filters", () => {
  const value = prepare(wire.request.body);
  assert.equal(value.path, wire.request.path); assert.equal(value.body, wire.request.body);
  assert.equal(value.headers.get("x-goog-api-key"), null);
  assert.throws(() => prepareGoogleGroundedSearch("gemini-3.8-flash", wire.request.body));
  const noRange = { ...wire.request.body, tools: [{ google_search: {} }] }; assert.equal(prepare(noRange).body, noRange);
  for (const range of [{ startTime: "2026-10-01T00:00:00.123Z", endTime: "2026-11-01T00:00:00Z" }, { startTime: "2026-02-30T00:00:00Z", endTime: "2026-11-01T00:00:00Z" }, { startTime: "2026-11-01T00:00:00Z", endTime: "2026-10-01T00:00:00Z" }, { startTime: "2026-10-01T00:00:00Z" }]) {
    assert.throws(() => prepare({ ...wire.request.body, tools: [{ google_search: { timeRangeFilter: range } }] }));
  }
});

test("Google grounded search rejects tool expansion and model-path admission bypasses", () => {
  for (const tool of [{ googleSearch: {} }, { google_search: {}, urlContext: {} }, { google_search: { searchTypes: { imageSearch: {} } } }, { google_search: { country: "US" } }]) assert.throws(() => prepare({ ...wire.request.body, tools: [tool] }));
  for (const change of [{ count: 10 }, { model: "gemini-4-argon" }, { cachedContent: "cachedContents/foreign" }, { generationConfig: { responseModalities: ["IMAGE"] } }]) assert.throws(() => prepare({ ...wire.request.body, ...change }));
  assert.throws(() => prepare({ ...wire.request.body, contents: [{ role: "model", parts: [{ text: "synthetic" }] }] }));
});

test("Google grounded answer preserves native attribution and usage separately from normalized citations", () => {
  const value = observeGoogleGroundedSearch(wire.response, true);
  assert.equal(value.body, wire.response);
  assert.equal(value.content, "A synthetic grounded answer.");
  assert.deepEqual(value.citations, [{ url: "https://example.com/reference", title: "Synthetic reference" }]);
  assert.equal(value.observedQueryCount, 2); assert.equal(value.filteredCitations, 0);
  assert.equal(value.billedQueryCount, undefined); assert.equal(value.costMicros, undefined);
  assert.equal(metadata(value.body).searchEntryPoint.renderedContent, metadata(wire.response).searchEntryPoint.renderedContent);
  const ungrounded = clone(); delete ungrounded.candidates[0].groundingMetadata;
  assert.equal(observeGoogleGroundedSearch(ungrounded, true).observedQueryCount, null);
  assert.deepEqual(observeGoogleGroundedSearch(ungrounded, true).citations, []);
});

test("Filtered citations cannot turn a native searched answer into free or empty-search evidence", () => {
  const response = clone(); metadata(response).groundingChunks = [
    { web: { uri: "https://user:synthetic@example.com/private" } }, { web: { uri: "javascript:synthetic()" } },
    { web: { uri: "file:///synthetic" } }, { retrievedContext: { uri: "files/foreign" } },
  ];
  const value = observeGoogleGroundedSearch(response, true);
  assert.equal(value.citations.length, 0); assert.equal(value.filteredCitations, 4); assert.equal(value.observedQueryCount, 2);
  assert.deepEqual(metadata(value.body).groundingSupports, metadata(wire.response).groundingSupports);
});

test("Google missing, partial or blocked answers fail rather than publishing a text prefix", () => {
  assert.throws(() => observeGoogleGroundedSearch(wire.response, false));
  for (const reason of [undefined, "MAX_TOKENS", "SAFETY", "CONTINUATION"]) { const response = clone(); response.candidates[0].finishReason = reason; assert.throws(() => observeGoogleGroundedSearch(response, true)); }
  for (const response of [{ ...clone(), error: {} }, { ...clone(), promptFeedback: { blockReason: "SAFETY" } }, { candidates: [] }]) assert.throws(() => observeGoogleGroundedSearch(response, true));
  const noAnswer = clone(); noAnswer.candidates[0].content.parts = [{ thought: true, text: "Private reasoning." }]; assert.throws(() => observeGoogleGroundedSearch(noAnswer, true));
  const malformed = clone(); metadata(malformed).webSearchQueries = [42]; assert.throws(() => observeGoogleGroundedSearch(malformed, true));
});

test("Google search HTTP reader enforces bounded complete EOF and caller cancellation", async () => {
  assert.equal((await readGoogleGroundedSearch(Response.json(wire.response), new AbortController().signal)).observedQueryCount, 2);
  for (const response of [Response.json(wire.response, { status: 503 }), new Response('{"candidates":', { headers: { "content-type": "application/json" } }), new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }), new Response(" ", { headers: { "content-type": "application/json", "content-length": "1048577" } })]) await assert.rejects(() => readGoogleGroundedSearch(response, new AbortController().signal));
  let canceled = false, started; const waiting = new Promise(resolve => { started = resolve; }), signal = new AbortController();
  const stream = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { canceled = true; } });
  const read = readGoogleGroundedSearch(new Response(stream, { headers: { "content-type": "application/json" } }), signal.signal);
  await waiting; signal.abort(); await assert.rejects(read); assert.equal(canceled, true);
});
