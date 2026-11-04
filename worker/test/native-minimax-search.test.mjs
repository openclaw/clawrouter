import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { prepareNativeMiniMaxSearch } = await import("../native-minimax-search.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { observeUsage } = await import("../proxy-response.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/search.json", import.meta.url), "utf8"));
const MiB = 1024 * 1024, encoder = new TextEncoder();
const globalOrigin = "https://api.minimax.io", cnOrigin = "https://api.minimaxi.com";
// Candidate selections and trusted-origin inputs are synthetic. No production
// declaration, original-plan authority or actual client is installed by this leaf.
const endpoint = { id: "search", method: "POST", path: "/v1/coding_plan/search", path_params: [], query: {}, streaming: null,
  request_format: "minimax.search", response_format: "minimax.search" };
function selection(body = structuredClone(wire.request)) {
  return { provider: { id: "minimax", base_urls: { default: globalOrigin } }, endpoint: { ...endpoint },
    model: null, capability: "search.web", method: "POST", pathParams: {}, body };
}
const native = (selected = selection(), input = { origin: globalOrigin }) => prepareNativeMiniMaxSearch(selected, input);
const response = (body = wire.response, headers = {}, status = 200) => Response.json(body, { headers, status });

// Compose the existing delivery observer and the same lease handoff as proxy.ts.
// This tests lifecycle compatibility, not production selector/authority wiring.
async function delivery(upstream, { selected = selection(), signal, input = { origin: globalOrigin } } = {}) {
  const prepared = native(selected, input), operation = new HttpOperation(signal), lease = prepared.acquire();
  try {
    const result = await operation.wait(prepared.read(upstream, operation.signal), "upstream");
    const observed = observeUsage(result.response, operation, undefined, "minimax.search", undefined, result.usage);
    const completion = observed.result.then(value => { lease.release(); return value; });
    return { ...observed, completion, usage: result.usage, operation };
  } catch (error) { operation.stop("upstream", error); lease.release(); throw error; }
}
async function read(upstream, options) {
  const result = await delivery(upstream, options);
  try { return { body: await result.response.json(), headers: result.response.headers, usage: result.usage, outcome: await result.completion }; }
  finally { if (!result.response.bodyUsed) await result.response.body.cancel(); await result.completion; }
}

test("MiniMax search binds only the trusted exact origin and preserves model-less native JSON", () => {
  for (const origin of [globalOrigin, cnOrigin]) {
    const selected = selection(), before = structuredClone(selected), input = { origin }, prepared = native(selected, input);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, origin); assert.equal(prepared.path, endpoint.path);
    for (const field of ["query", "tariff", "headers", "body"]) assert.equal(prepared[field], undefined);
    input.origin = "https://unqualified.example"; selected.provider.base_urls.default = "https://unqualified.example";
    selected.body.q = "changed after preparation";
    assert.equal(prepared.origin, origin);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(origin + endpoint.path)));
    for (const url of [origin + endpoint.path + "?q=other", origin + "/v1/t2a_v2", "https://unqualified.example" + endpoint.path])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
  assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format: "openai.chat_completions" } }), undefined);
});

test("MiniMax search rejects wrong model, capability, route and undeclared transport options", () => {
  for (const patch of [{ provider: { id: "other" } }, { model: {} }, { model: undefined }, { capability: "web.search" },
    { capability: "llm.chat" }, { method: "GET" }, { pathParams: { region: "cn" } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...patch }), /model-less native route/);
  for (const patch of [{ method: "GET" }, { path: "/v1/search" }, { response_format: "openai.chat_completions" },
    { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { q: "other" } }, { streaming: "sse" },
    { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...patch } }), /model-less native route/);
  for (const input of [undefined, null, {}, { region: "global" }, { origin: "global" }, { origin: "https://api.minimax.cn" },
    { origin: globalOrigin + "/" }, { origin: globalOrigin + "/anthropic" }, { origin: "https://user:synthetic@api.minimax.io" }])
    assert.throws(() => prepareNativeMiniMaxSearch(selection(), input), /model-less native route/);
});

test("MiniMax search preserves exact bounded Unicode q without count, model, region or credential fields", () => {
  for (const q of ["x".repeat(4096), "🦊".repeat(1024), '"'.repeat(4096), "\\".repeat(4096), "  keep spacing  "]) {
    const selected = selection({ q }), before = structuredClone(selected);
    assert.ok(native(selected)); assert.deepEqual(selected, before);
  }
  for (const q of ["", " ", "x".repeat(4097), "🦊".repeat(1025), "\ud800", "a\nb", "a\u007fb"])
    assert.throws(() => native(selection({ q })), /bounded native query/);
  for (const body of [null, [], {}, { query: "synthetic" }, ...["count", "model", "region", "key", "stream", "page"].map(key => ({ ...wire.request, [key]: "synthetic" })),
    { q: "x".repeat(16 * 1024) }]) assert.throws(() => native(selection(body)), /bounded native query/);
});

test("MiniMax search preserves complete native results and unknown usage without fetching destinations", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected URL fetch"); });
  for (const body of [wire.response, wire.empty, { ...wire.response, usage: { total_tokens: 99 }, cost: 0 },
    { ...wire.response, related_searches: [{ query: "not a URL" }, { query: "javascript:plain search words" }] }]) {
    const result = await read(response(body, { "x-private-upstream": "synthetic", "set-cookie": "synthetic" }));
    assert.deepEqual(result.body, body); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.usage.nativeRequestUsage, undefined);
    assert.equal(result.outcome.delivery, "complete"); assert.equal(result.outcome.tokens, null);
    assert.equal(result.headers.get("x-private-upstream"), null); assert.equal(result.headers.get("set-cookie"), null);
    assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(fetch.mock.callCount(), 0); assert.equal(bodyBudgetCharged(), 0);
});

test("MiniMax search retains valid tails beyond ten and all fifty related queries", async () => {
  const body = { ...wire.response, organic: Array.from({ length: 100 }, (_, i) => ({ ...wire.response.organic[0], link: `https://search.example/result/${i}` })),
    related_searches: Array.from({ length: 50 }, (_, i) => ({ query: `synthetic query ${i}` })) };
  const result = await read(response(body)); assert.deepEqual(result.body, body); assert.equal(result.body.organic.length, 100);
  for (const patch of [{ organic: [...body.organic, body.organic[0]] }, { related_searches: [...body.related_searches, { query: "extra" }] }])
    await assert.rejects(read(response({ ...body, ...patch })), /invalid_native_minimax_search_response/);
  assert.equal(bodyBudgetCharged(), 0);
});

test("MiniMax search rejects every unsafe raw URL including tails omitted by the codec projection", async () => {
  for (const link of [undefined, null, "", "relative/path", "not a URL", "javascript:synthetic()", "file:///synthetic",
    "https://user:synthetic@search.example/result", "http://user@search.example/result"]) {
    for (const index of [0, 10, 99]) {
      const body = { ...wire.response, organic: Array.from({ length: 100 }, () => ({ ...wire.response.organic[0] })) };
      body.organic[index].link = link;
      await assert.rejects(read(response(body)), /invalid_native_minimax_search_response/);
    }
  }
  const body = { ...wire.response, organic: [{ ...wire.response.organic[0], link: "http://search.example/result" }] };
  assert.deepEqual((await read(response(body))).body, body); assert.equal(bodyBudgetCharged(), 0);
});

test("MiniMax search denies native errors and malformed later rows without exposing upstream messages", async () => {
  for (const body of [wire.error, {}, { ...wire.empty, error: null }, { ...wire.empty, base_resp: { status_code: "0" } },
    { ...wire.empty, organic: [null] }, { ...wire.response, organic: Array(10).fill(wire.response.organic[0]).concat({ snippet: 42 }) },
    { ...wire.empty, related_searches: [{ query: 42 }] }, { ...wire.response, organic: [{ ...wire.response.organic[0], title: "\ud800" }] },
    { base_resp: { status_code: 2013, status_msg: "synthetic-private-diagnostic" }, organic: [] }]) {
    await assert.rejects(read(response(body)), error => error.message === "invalid_native_minimax_search_response");
  }
  assert.equal(bodyBudgetCharged(), 0);
});

test("MiniMax search requires complete HTTP200 JSON and validates identity Content-Length", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": 'application/json; charset="utf-8' }, { "content-encoding": "gzip" }, { "content-encoding": "br" },
    { "content-range": "bytes 0-1/10" }, { "content-length": "-1" }, { "content-length": "bad" }, { "content-length": "1.5" }, { "content-length": "1" }])
    await assert.rejects(read(response(wire.response, headers)));
  for (const status of [201, 206, 302, 422, 429, 500]) await assert.rejects(read(response(wire.response, {}, status)));
  for (const encoding of [undefined, "identity"]) {
    const upstream = response(wire.response, encoding ? { "content-encoding": encoding } : {});
    Object.defineProperty(upstream, "redirected", { value: true }); await assert.rejects(read(upstream));
  }
  const text = JSON.stringify(wire.response), length = encoder.encode(text).length;
  const headers = { "content-type": 'application/json; charset="UTF-8"', "content-encoding": "identity", "content-length": String(length) };
  assert.deepEqual((await read(new Response(text, { headers }))).body, wire.response);
  for (const declared of [length - 1, length + 1]) await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": String(declared) } })));
  assert.equal(bodyBudgetCharged(), 0);
});

test("MiniMax search enforces one MiB of full response bytes with and without a length header", async () => {
  const text = JSON.stringify(wire.empty), exact = text + " ".repeat(MiB - encoder.encode(text).length);
  for (const headers of [{ "content-type": "application/json" }, { "content-type": "application/json", "content-length": String(MiB) }])
    assert.deepEqual((await read(new Response(exact, { headers }))).body, wire.empty);
  await assert.rejects(read(new Response(exact + " ", { headers: { "content-type": "application/json" } })));
  await assert.rejects(read(response(wire.empty, { "content-length": String(MiB + 1) })));
  assert.equal(bodyBudgetCharged(), 0);
});

test("MiniMax search waits for actual EOF and accepts fragmented UTF-8 without partial delivery", async () => {
  const body = { ...wire.response, related_searches: [{ query: "🦊 synthetic" }] }, bytes = encoder.encode(JSON.stringify(body));
  let controller, finished = false;
  const upstream = new ReadableStream({ start(value) { controller = value; } });
  const pending = read(new Response(upstream, { headers: { "content-type": "application/json" } })).then(value => { finished = true; return value; });
  for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
  await new Promise(setImmediate); assert.equal(finished, false); assert.equal(bodyBudgetCharged(), 16 * MiB);
  controller.close(); assert.deepEqual((await pending).body, body); assert.equal(bodyBudgetCharged(), 0);
  for (const bad of [bytes.subarray(0, -1), Uint8Array.of(255), Uint8Array.of(0xf0, 0x9f)])
    await assert.rejects(read(new Response(bad, { headers: { "content-type": "application/json" } })));
});

test("MiniMax search cancels a pending upstream read on the original caller signal with no output", async () => {
  const controller = new AbortController(), reached = Promise.withResolvers(); let canceled = false, delivered = false;
  const upstream = new ReadableStream({ pull(c) { c.enqueue(encoder.encode('{"organic":')); reached.resolve(); return new Promise(() => {}); }, cancel() { canceled = true; } });
  const pending = delivery(new Response(upstream, { headers: { "content-type": "application/json" } }), { signal: controller.signal });
  pending.then(() => { delivered = true; }, () => {});
  await reached.promise; assert.equal(bodyBudgetCharged(), 16 * MiB);
  const rejected = assert.rejects(pending); controller.abort(new DOMException("synthetic caller cancellation", "AbortError"));
  await rejected; await new Promise(setImmediate);
  assert.equal(delivered, false); assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), 0);
});

test("MiniMax search releases capacity after upstream failure or pre-aborted reads without inventing cancellation", async () => {
  let canceled = false;
  const bad = new ReadableStream({ pull(c) { c.error(new Error("synthetic-private-upstream")); }, cancel() { canceled = true; } });
  await assert.rejects(delivery(new Response(bad, { headers: { "content-type": "application/json" } })), /invalid_native_minimax_search_response/);
  assert.equal(canceled, false); assert.equal(bodyBudgetCharged(), 0);
  const caller = new AbortController(); caller.abort();
  await assert.rejects(delivery(response(), { signal: caller.signal }));
  await new Promise(setImmediate); assert.equal(bodyBudgetCharged(), 0);
});

for (const mode of ["eof", "cancel", "caller-abort"]) test(`MiniMax search retains its 16 MiB charge through downstream ${mode}`, async () => {
  const baseline = bodyBudgetCharged(), caller = new AbortController();
  const result = await delivery(response(), { signal: caller.signal }); let completed = false;
  result.completion.then(() => { completed = true; });
  try {
    await new Promise(setImmediate); assert.equal(completed, false); assert.equal(bodyBudgetCharged(), baseline + 16 * MiB);
    const reader = result.response.body.getReader();
    try {
      assert.equal((await reader.read()).done, false); assert.equal(completed, false);
      assert.equal(bodyBudgetCharged(), baseline + 16 * MiB);
      if (mode === "eof") while (!(await reader.read()).done) {}
      else if (mode === "cancel") await reader.cancel("synthetic downstream cancellation");
      else { caller.abort(new DOMException("synthetic downstream caller abort", "AbortError")); await assert.rejects(reader.read()); }
    } finally { reader.releaseLock(); }
    const outcome = await result.completion;
    assert.equal(outcome.delivery, mode === "eof" ? "complete" : "canceled"); assert.equal(outcome.tokens, null);
    // Complete upstream validation does not replace the operation's caller
    // cancellation or turn partial downstream delivery into successful delivery.
    assert.equal(outcome.outcome, "success");
    assert.equal(result.operation.status, mode === "eof" ? undefined : "client_error");
    assert.equal(bodyBudgetCharged(), baseline);
  } finally { if (!completed) await result.response.body.cancel(); await result.completion; }
});

test("MiniMax search acquires capacity before dispatch and never treats null pricing as a leaf rejection", () => {
  const baseline = bodyBudgetCharged(), ingress = new BodyLease(); assert.equal(ingress.grow(2 * MiB), true);
  const prepared = native(), lease = prepared.acquire();
  assert.equal(prepared.tariff, undefined); assert.equal(bodyBudgetCharged(), baseline + 20 * MiB);
  lease.release(); ingress.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow((bodyBudgetBytes - baseline - 14 * MiB) / 2), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { occupied.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});
