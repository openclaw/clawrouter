import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { prepareNativeDeepSeekSearch } = await import("../native-deepseek-search.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepseek/search.json", import.meta.url), "utf8"));
// Candidate leaf selection, not a production declaration or routing proof.
const provider = { id: "deepseek", base_urls: { default: "https://api.deepseek.com" } };
const endpoint = { id: "search", method: "POST", path: "/v1/tools/search", path_params: [], query: {}, streaming: null,
  request_format: "deepseek.search", response_format: "deepseek.search" };
const selection = (body = structuredClone(wire.request.body)) => ({ provider, endpoint, model: null,
  capability: "search.web", body, pathParams: {}, method: "POST" });
const native = (selected = selection()) => prepareNativeDeepSeekSearch(selected);
const response = (body = wire.response, headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, selected = selection(), signal = new AbortController().signal) {
  const prepared = native(selected), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("DeepSeek leaf binds the model-less native route and leaves the selected JSON unchanged", () => {
  const selected = selection(), before = structuredClone(selected), prepared = native(selected);
  assert.deepEqual(selected, before); assert.equal(prepared.origin, provider.base_urls.default); assert.equal(prepared.path, wire.request.path);
  for (const key of ["query", "tariff", "body", "headers"]) assert.equal(prepared[key], undefined);
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of [prepared.origin + prepared.path + "?count=1", prepared.origin + "/v1/tools/fetch", "https://other.example" + prepared.path])
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  assert.equal(native({ ...selected, endpoint: { ...endpoint, request_format: "openai.chat_completions" } }), undefined);
});

test("DeepSeek leaf rejects model, provider, capability, query and transport mismatches", () => {
  for (const change of [{ model: { upstream: "deepseek-v4-pro" } }, { model: undefined }, { capability: "llm.chat" }, { method: "GET" },
    { provider: { ...provider, id: "other" } }, { provider: { ...provider, base_urls: { default: "https://other.example" } } },
    { pathParams: { model: "deepseek-v4-pro" } }, { nativeQuery: {} }]) assert.throws(() => native({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1/tools/fetch" }, { response_format: "openai.chat_completions" },
    { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { count: "1" } }, { streaming: "sse" },
    { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }));
});

test("DeepSeek requires explicit frozen count and content options with bounded Unicode input", () => {
  for (const count of [1, 10]) {
    const selected = selection({ query: "🦊".repeat(128), count, need_content: false }), before = structuredClone(selected);
    assert.ok(native(selected)); assert.deepEqual(selected, before);
  }
  for (const query of ["", " ", "🦊".repeat(129), "\ud800", "x".repeat(4097)])
    assert.throws(() => native(selection({ ...wire.request.body, query })));
  for (const body of [null, [], { query: "synthetic" }, { query: "synthetic", count: 5 },
    ...[undefined, null, 0, 11, 1.5, "5"].map(count => ({ ...wire.request.body, count })),
    { ...wire.request.body, need_content: true }, { ...wire.request.body, model: "deepseek-v4-pro" },
    { ...wire.request.body, stream: true }, { ...wire.request.body, url: "https://example.com/input" },
    { ...wire.request.body, localization: "synthetic" }, { ...wire.request.body, extra: "x".repeat(4096) }])
    assert.throws(() => native(selection(body)));
});

test("DeepSeek reserves 16 MiB alongside existing ingress capacity before dispatch", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(8 * 1024 * 1024), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 32 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow((bodyBudgetBytes - baseline - 14 * 1024 * 1024) / 2), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { occupied.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("DeepSeek preserves native results without fetching destinations or inventing usage and fees", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected result fetch"); });
  for (const body of [wire.response, wire.empty, { ...wire.response, usage: { total_tokens: 99 }, cost: 0.00075 }]) {
    const result = await read(response(body, { "x-private-upstream": "synthetic", "set-cookie": "synthetic" }));
    assert.deepEqual(await result.response.json(), body); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.response.headers.get("x-private-upstream"), null);
    assert.equal(result.response.headers.get("set-cookie"), null); assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("content-type"), "application/json"); assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("DeepSeek rejects any omitted destination, excess result or malformed later row atomically", async () => {
  for (const body of [wire.filtered, { results: [wire.response.results[0], null] },
    { results: Array(6).fill(wire.response.results[0]) }, { results: Array(5).fill(wire.response.results[0]).concat(null) },
    { results: [{ ...wire.response.results[0], summary: 42 }] }, { results: null }, {},
    { ...wire.empty, error: null }, { ...wire.empty, error: { message: "synthetic" } }]) await assert.rejects(read(response(body)));
  for (const url of ["javascript:synthetic", "file:///synthetic", "https://user:synthetic@example.com/result", "not a URL"])
    await assert.rejects(read(response({ results: [{ ...wire.response.results[0], url }] })));
  assert.deepEqual(await (await read(response({ results: Array(5).fill(wire.response.results[0]) }))).response.json(),
    { results: Array(5).fill(wire.response.results[0]) });
});

test("DeepSeek accepts only complete HTTP200 JSON UTF-8 and exact identity lengths", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": "application/json; charset=\"utf-8" }, { "content-range": "bytes 0-1/10" },
    { "content-encoding": "gzip" }, { "content-length": "-1" }, { "content-length": "bad" }, { "content-length": "1.5" }, { "content-length": "1" }])
    await assert.rejects(read(response(undefined, headers)));
  for (const status of [201, 206, 302, 422, 429, 500]) await assert.rejects(read(response(undefined, {}, status)));
  for (const headers of [{}, { "content-encoding": "identity" }]) {
    const redirected = response(undefined, headers); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  }
  const text = JSON.stringify(wire.response), headers = { "content-type": "application/json; charset=\"UTF-8\"", "content-encoding": "identity" };
  assert.deepEqual(await (await read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text)) } }))).response.json(), wire.response);
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text) + 1) } })));
});

test("DeepSeek enforces the 1 MiB full response bound with and without Content-Length", async () => {
  const text = JSON.stringify(wire.empty), limit = 1024 * 1024, exact = text + " ".repeat(limit - Buffer.byteLength(text));
  const headers = { "content-type": "application/json" };
  assert.deepEqual(await (await read(new Response(exact, { headers }))).response.json(), wire.empty);
  await assert.rejects(read(new Response(exact + " ", { headers })));
  await assert.rejects(read(response(wire.empty, { "content-length": String(limit + 1) })));
});

test("DeepSeek waits for EOF and never delivers a valid JSON prefix before completion", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(wire.response)), headers = { "content-type": "application/json" }; let controller, settled = false;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pending = read(new Response(stream, { headers })).then(result => { settled = true; return result; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await (await pending).response.json(), wire.response);
  await assert.rejects(read(new Response(bytes.subarray(0, -1), { headers })));
  await assert.rejects(read(new Response(new Uint8Array([0xff]), { headers })));
  const interrupted = new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(interrupted, { headers })), { message: "invalid_native_deepseek_search_response" });
});

test("DeepSeek abort and timeout cancel stalled reads and release capacity without successful usage", async () => {
  for (const name of ["AbortError", "TimeoutError"]) for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort(new DOMException("synthetic", name));
    const upstream = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
    const pending = read(upstream, selection(), abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(new DOMException("synthetic", name)); }
    await assert.rejects(pending); assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});
