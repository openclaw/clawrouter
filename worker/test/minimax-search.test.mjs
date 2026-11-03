import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { miniMaxSearchOrigins, prepareMiniMaxSearch, observeMiniMaxSearch, readMiniMaxSearch } from "../minimax-search.ts";
const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/search.json", import.meta.url)));
const signal = () => new AbortController().signal;

test("native plan search preserves q and selected region without inferring a credential", () => {
  for (const [region, origin] of Object.entries(miniMaxSearchOrigins)) {
    const request = prepareMiniMaxSearch(region, fixture.request);
    assert.equal(request.origin, origin); assert.equal(request.path, "/v1/coding_plan/search");
    assert.deepEqual(request.body, fixture.request); assert.equal(request.headers.has("authorization"), false);
  }
  for (const body of [{ query: "synthetic" }, { ...fixture.request, count: 5 }, { ...fixture.request, page: 2 },
    { ...fixture.request, model: "MiniMax-M3" }, { q: "" }, { q: "x".repeat(4097) },
    { q: String.fromCharCode(0xd800) }, { q: "a" + String.fromCharCode(10) + "b" }]) {
    assert.throws(() => prepareMiniMaxSearch("global", body));
  }
  assert.throws(() => prepareMiniMaxSearch("https://foreign.example", fixture.request), /region/);
});

test("native organic and related rows stay distinct from consumer truncation and USD cost", () => {
  const result = observeMiniMaxSearch(fixture.response, 1, true);
  assert.equal(result.results.length, 1); assert.equal(result.nativeResultCount, 2); assert.equal(result.omittedResults, true);
  assert.equal(result.body, fixture.response); assert.equal(result.results[0].published, "2026-10-01");
  assert.equal(result.results[0].description, "Untrusted source text");
  assert.deepEqual(result.relatedSearches, ["synthetic paper folding"]); assert.equal(result.upstreamCostMicros, null);
  const empty = observeMiniMaxSearch(fixture.empty, 5, true);
  assert.deepEqual(empty.results, []); assert.equal(empty.nativeResultCount, 0); assert.equal(empty.upstreamCostMicros, null);
});

test("HTTP-200 vendor errors, partial and malformed rows never become empty successes", () => {
  assert.throws(() => observeMiniMaxSearch(fixture.response, 5, false));
  for (const body of [fixture.error, { organic: [] }, { base_resp: { status_code: "0" }, organic: [] },
    { ...fixture.empty, organic: [null] }, { ...fixture.empty, organic: Array(101).fill({}) },
    { ...fixture.empty, related_searches: [{ query: 1 }] },
    { ...fixture.response, organic: [fixture.response.organic[0], { snippet: 1 }] }]) {
    assert.throws(() => observeMiniMaxSearch(body, 1, true));
  }
  for (const count of [0, 11, NaN, 1.5]) assert.throws(() => observeMiniMaxSearch(fixture.response, count, true));
});

test("unsafe result destinations are omitted without replacing native accounting evidence", () => {
  const body = structuredClone(fixture.response);
  body.organic[0].link = "https://user:synthetic@search.example/private";
  body.organic[1].link = "javascript:synthetic()";
  const result = observeMiniMaxSearch(body, 10, true);
  assert.deepEqual(result.results, []); assert.equal(result.nativeResultCount, 2);
  assert.equal(result.omittedResults, true); assert.equal(result.upstreamCostMicros, null);
});

test("native reader requires bounded complete UTF-8 JSON and cancels a stalled read", async () => {
  const good = await readMiniMaxSearch(Response.json(fixture.response), 5, signal());
  assert.equal(good.results.length, 2);
  for (const response of [
    Response.json(fixture.response, { status: 202 }), new Response(null, { status: 302 }),
    Response.json(fixture.error), new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(Uint8Array.of(255), { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(fixture.response), { headers: { "content-type": "application/json", "content-length": "1" } }),
    Response.json(fixture.response, { headers: { "content-range": "bytes 0-1/10" } }),
  ]) await assert.rejects(readMiniMaxSearch(response, 5, signal()));
  let canceled = false; const controller = new AbortController();
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"organic":')); }, cancel() { canceled = true; } });
  const pending = readMiniMaxSearch(new Response(stream, { headers: { "content-type": "application/json" } }), 5, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});

