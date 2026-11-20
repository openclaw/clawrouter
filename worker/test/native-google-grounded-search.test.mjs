import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeGoogleGroundedSearch } = await import("../native-google-grounded-search.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/grounded-search.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"))]).providers[0];
// Candidate leaf selection; declaration and actual routing remain owner integrations.
const endpoint = { ...provider.endpoints.find(value => value.id === "generate_content"), modelPassthrough: undefined,
  request_format: "google.grounded_search", response_format: "google.grounded_search" };
const selection = (body = structuredClone(wire.request.body)) => ({ provider, endpoint,
  model: { id: "google/gemini-3.6-flash", upstream: "gemini-3.6-flash", capabilities: ["search.web"] },
  capability: "search.web", body, pathParams: { model: "gemini-3.6-flash" }, method: "POST" });
const payload = () => structuredClone(wire.response), response = (body = payload(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, signal = new AbortController().signal) {
  const prepared = prepareNativeGoogleGroundedSearch(selection()), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("grounded search binds the frozen selected model, tool body and exact destination", () => {
  const selected = selection(), before = structuredClone(selected), prepared = prepareNativeGoogleGroundedSearch(selected);
  assert.deepEqual(selected, before); assert.equal(prepared.path, wire.request.path); assert.equal(prepared.origin, "https://generativelanguage.googleapis.com");
  assert.equal(prepared.tariff, undefined); assert.equal(prepared.query, undefined);
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of [prepared.origin + prepared.path + "?key=synthetic", prepared.origin + prepared.path + "?alt=sse", "https://other.example" + prepared.path])
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  assert.equal(prepareNativeGoogleGroundedSearch({ ...selected, endpoint: { ...endpoint, request_format: "google.generate_content" } }), undefined);
});

test("grounded search rejects aliases, stream/query and selected capability or path mismatches", () => {
  for (const change of [{ model: null }, { model: { upstream: "gemini-3.8-flash" } }, { capability: "llm.generate" }, { method: "GET" },
    { provider: { ...provider, id: "google" } }, { pathParams: { model: "other" } }, { nativeQuery: {} }])
    assert.throws(() => prepareNativeGoogleGroundedSearch({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1beta/interactions" }, { path_params: [] }, { query: { alt: "sse" } },
    { response_format: "google.generate_content" }, { upstreamPath: endpoint.path }, { streaming: true }, { modelPassthrough: {} },
    { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { requestPricing: {} }])
    assert.throws(() => prepareNativeGoogleGroundedSearch({ ...selection(), endpoint: { ...endpoint, ...change } }));
});

test("grounded search preserves native dates and rejects tool expansion, remote inputs and request overflow", () => {
  assert.ok(prepareNativeGoogleGroundedSearch(selection()));
  for (const body of [{ ...wire.request.body, tools: [{ google_search: {} }, { url_context: {} }] },
    { ...wire.request.body, cachedContent: "unowned" }, { ...wire.request.body, generationConfig: { responseModalities: ["IMAGE"] } },
    { ...wire.request.body, contents: [{ parts: [{ fileData: { fileUri: "https://assets.example/input" } }] }] },
    { ...wire.request.body, contents: [{ parts: [{ text: "x".repeat(128 * 1024) }] }] },
    { ...wire.request.body, tools: [{ google_search: { timeRangeFilter: { startTime: "2026-11-01T00:00:00Z", endTime: "2026-10-01T00:00:00Z" } } }] }])
    assert.throws(() => prepareNativeGoogleGroundedSearch(selection(body)));
});

test("grounded search reserves 16 MiB response capacity before dispatch", () => {
  const baseline = bodyBudgetCharged(), prepared = prepareNativeGoogleGroundedSearch(selection()), lease = prepared.acquire();
  assert.equal(bodyBudgetCharged(), baseline + 16 * 1024 * 1024); lease.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow(41 * 1024 * 1024), true);
  try { assert.throws(() => prepared.acquire(), /capacity is busy/); } finally { occupied.release(); }
});

test("grounded search preserves native attribution, suggestions and usage without query-count billing", async () => {
  const result = await read(response(payload(), { "x-private-upstream": "synthetic" }));
  assert.deepEqual(await result.response.json(), wire.response); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.response.headers.get("x-private-upstream"), null);
  assert.equal(result.response.headers.get("content-type"), "application/json"); assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  const without = payload(); delete without.candidates[0].groundingMetadata;
  assert.deepEqual(await (await read(response(without))).response.json(), without);
});

test("grounded search erases thought payloads without changing final attribution indices or native chunks", async () => {
  const body = payload(), candidate = body.candidates[0];
  candidate.content.parts.unshift({ thought: true, text: "synthetic-private-thought", thoughtSignature: "synthetic-signature" });
  candidate.groundingMetadata.groundingSupports[0].segment.partIndex = 1;
  const delivered = await (await read(response(body))).response.json();
  assert.deepEqual(delivered.candidates[0].content.parts[0], { thought: true, text: "" });
  assert.deepEqual(delivered.candidates[0].groundingMetadata, candidate.groundingMetadata);
  assert.equal(JSON.stringify(delivered).includes("synthetic-private-thought"), false);
  const joined = delivered.candidates[0].content.parts.map(part => part.text).filter(Boolean).join("\n"); assert.equal(joined, "A synthetic grounded answer.");
  candidate.groundingMetadata.groundingSupports[0].segment.partIndex = 0; await assert.rejects(read(response(body)));
});

test("grounded search validates native byte offsets and references instead of silently rewriting attribution", async () => {
  const body = payload(), candidate = body.candidates[0]; candidate.content.parts[0].text = "évidence";
  candidate.groundingMetadata.groundingSupports[0].segment = { startIndex: 0, endIndex: 2, text: "é" };
  assert.deepEqual(await (await read(response(body))).response.json(), body);
  for (const patch of [{ startIndex: 1 }, { endIndex: 1 }, { endIndex: 999 }, { text: "wrong" }, { partIndex: 1 }, { partIndex: -1 }]) {
    const bad = structuredClone(body); Object.assign(bad.candidates[0].groundingMetadata.groundingSupports[0].segment, patch); await assert.rejects(read(response(bad)));
  }
  for (const patch of [{ groundingChunkIndices: [1] }, { groundingChunkIndices: [-1] }, { renderedParts: [1] }]) {
    const bad = payload(); Object.assign(bad.candidates[0].groundingMetadata.groundingSupports[0], patch); await assert.rejects(read(response(bad)));
  }
});

test("grounded search rejects unsafe citation URLs atomically without fetching or renumbering chunks", async () => {
  for (const uri of ["javascript:synthetic", "file:///synthetic", "https://user:password@example.com/path", "not a URL"]) {
    const body = payload(); body.candidates[0].groundingMetadata.groundingChunks.push({ web: { uri } }); await assert.rejects(read(response(body)));
  }
  const body = payload(); body.candidates[0].groundingMetadata.groundingChunks.push({ retrievedContext: { uri: "https://example.com/file" } });
  await assert.rejects(read(response(body)));
});

test("grounded search requires one complete nonblocked final answer and never publishes a valid prefix", async () => {
  for (const reason of [undefined, "MAX_TOKENS", "SAFETY"]) { const body = payload(); body.candidates[0].finishReason = reason; await assert.rejects(read(response(body))); }
  for (const body of [{ ...payload(), error: {} }, { ...payload(), promptFeedback: { blockReason: "SAFETY" } }, { candidates: [] }]) await assert.rejects(read(response(body)));
  for (const part of [{ thought: true, text: "only thought" }, { text: "" }, { text: "prefix", file_data: {} }, { text: "prefix", function_call: {} }]) {
    const body = payload(); body.candidates[0].content.parts = [part]; await assert.rejects(read(response(body)));
  }
});

test("grounded search enforces exact JSON size and complete HTTP200 UTF-8 length without range or redirect", async () => {
  const text = JSON.stringify(payload()), headers = { "content-type": "application/json" }, limit = 1024 * 1024;
  const exact = text + " ".repeat(limit - Buffer.byteLength(text)); assert.ok(await read(new Response(exact, { headers })));
  await assert.rejects(read(new Response(exact + " ", { headers })));
  for (const length of ["-1", "1.5", "bad", String(limit + 1), String(Buffer.byteLength(text) - 1), String(Buffer.byteLength(text) + 1)])
    await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": length } })));
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-encoding": "identity", "content-length": "1" } })));
  for (const status of [202, 206, 302, 422, 500]) await assert.rejects(read(response(payload(), {}, status)));
  for (const extra of [{ "content-type": "text/plain" }, { "content-range": "bytes 0-1/100" }, { "content-encoding": "gzip" }]) await assert.rejects(read(response(payload(), extra)));
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  await assert.rejects(read(new Response(new Uint8Array([0xff]), { headers })));
});

test("grounded search abort, timeout and interrupted EOF cancel reading without partial delivery or replay", async () => {
  const prefix = new TextEncoder().encode(JSON.stringify(payload()).slice(0, -1)), headers = { "content-type": "application/json" }; let first = true;
  const broken = new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(prefix); } else c.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_google_grounded_search_response" });
  for (const name of ["AbortError", "TimeoutError"]) {
    const controller = new AbortController(); let canceled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(prefix); }, cancel() { canceled = true; } });
    const pending = read(new Response(stream, { headers }), controller.signal); controller.abort(new DOMException("synthetic", name));
    await assert.rejects(pending); assert.equal(canceled, true);
  }
});
