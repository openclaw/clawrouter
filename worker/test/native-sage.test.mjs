import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture as managedFixture } from "./managed-runtime-fixture.mjs";
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { prepareNativeSage } = await import("../native-sage.ts");
const { sageRequest, sageResponse } = await import("./provider-decision-fixtures.ts");
const { sageBatchFacts } = await import("./sage-batch-metadata-fixture.ts");

function selection() {
  const provider = compileProviderSnapshot([{
    schema: "clawrouter.service-provider.v1", id: "levanto", displayName: "Sage fixture", class: "custom_adapter",
    service: { platform: "levanto", kind: "model_provider", upstreamService: "levanto", configKeys: ["SAGE_API_KEY"] },
    adapter: { request: "sage", response: "sage", error: "json_error" },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://sage.levanto.ai" },
    capabilities: [{ id: "llm.decisions", endpoint: "decisions", methods: ["POST"] }, { id: "llm.decisions.batch", endpoint: "decisions_batch", methods: ["POST"] }],
    endpoints: { decisions: { method: "POST", path: "/decide", requestFormat: "levanto.sage", responseFormat: "levanto.sage" },
      decisions_batch: { method: "POST", path: "/decide/batch", requestFormat: "levanto.sage_batch", responseFormat: "levanto.sage_batch" } },
    models: { entries: [{ id: "levanto/levanto-sage-2", upstream: "levanto-sage-2", capabilities: ["llm.decisions", "llm.decisions.batch"] }] },
  }]).providers[0];
  return { provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === "decisions"), model: provider.models[0], capability: "llm.decisions", method: "POST", pathParams: {},
    body: { ...structuredClone(sageRequest), model: "levanto/levanto-sage-2" } };
}
const invalidRoute = e => e.status === 400 && e.code === "invalid_native_sage_route";

test("Sage removes only the admitted model selector and preserves native question/reasoning", () => {
  for (const model of [undefined, "levanto/levanto-sage-2", "levanto-sage-2"]) {
    const selected = selection(); if (model === undefined) delete selected.body.model; else selected.body.model = model;
    const original = structuredClone(selected), native = prepareNativeSage(selected);
    assert.deepEqual(selected, { ...original, body: sageRequest });
    assert.equal(native.origin, "https://sage.levanto.ai"); assert.equal(native.path, "/decide");
    assert.equal(native.tariff, undefined); assert.equal(selected.model.pricing, null);
  }
});

test("Sage leaves unrelated formats untouched and batch without support metadata fails closed", () => {
  for (const format of ["openai.decisions", "liquid.systemone", "typesafe.systemone", "baseten.systemone"]) {
    const selected = selection(); selected.endpoint.request_format = format; const before = structuredClone(selected);
    assert.equal(prepareNativeSage(selected), undefined); assert.deepEqual(selected, before);
  }
  const selected = selection(); Object.assign(selected.endpoint, { id: "decisions_batch", path: "/decide/batch", request_format: "levanto.sage_batch", response_format: "levanto.sage_batch" });
  selected.capability = "llm.decisions.batch"; selected.body = { requests: [{ content: "synthetic", questions: [sageRequest.question] }] };
  assert.throws(() => prepareNativeSage(selected), invalidRoute);
});

test("Sage requires exact provider/model/capability/route before changing the body", () => {
  for (const change of [s => { s.provider.id = "other"; }, s => { s.provider.base_urls.default = "https://other.example"; },
    s => { s.provider.capabilities = []; }, s => { s.provider.capabilities[0].methods = ["GET"]; }, s => { s.model = null; },
    s => { s.model.id = "levanto/alias"; }, s => { s.model.upstream = "other"; }, s => { s.model.capabilities = ["llm.chat"]; },
    s => { s.capability = "llm.chat"; }, s => { s.method = "GET"; }, s => { s.endpoint.method = "GET"; },
    s => { s.endpoint.id = "other"; }, s => { s.endpoint.path = "/decide/batch"; }, s => { s.endpoint.response_format = "openai.decisions"; },
    s => { s.endpoint.upstreamPath = "/decide"; }, s => { s.endpoint.path_params = ["model"]; }, s => { s.pathParams = { model: "other" }; },
    s => { s.endpoint.query = { model: "other" }; }, s => { s.nativeQuery = {}; }, s => { s.endpoint.streaming = "sse"; },
    s => { s.endpoint.websocket = {}; }, s => { s.endpoint.lifecycle = {}; }, s => { s.endpoint.responsesLifecycle = {}; },
    s => { s.endpoint.modelPassthrough = {}; }, s => { s.endpoint.requestPricing = {}; }]) {
    const selected = selection(); change(selected); const before = structuredClone(selected);
    assert.throws(() => prepareNativeSage(selected), invalidRoute); assert.deepEqual(selected, before);
  }
});

test("Sage rejects unqualified images, batch-shaped input, foreign model and hidden fields", () => {
  for (const body of [[], null, {}, { ...sageRequest, model: "other" }, { ...sageRequest, stream: false },
    { ...sageRequest, content: { kind: "image", media: "synthetic-private" } },
    { requests: [{ content: "synthetic", questions: [sageRequest.question] }] }]) {
    const selected = selection(); selected.body = body;
    assert.throws(() => prepareNativeSage(selected), e => e.status === 400 && e.code === "invalid_native_sage_request" && !e.message.includes("synthetic-private"));
    assert.equal(selected.body, body);
  }
});

test("Sage keeps native abstention, reasoning and unknown usage without assigning a tariff", async () => {
  for (const usage of [undefined, { input_tokens: 0, output_tokens: 0 }, { input_tokens: 17, output_tokens: 3 }]) {
    const body = structuredClone(sageResponse); if (usage === undefined) delete body.meta.usage; else body.meta.usage = usage;
    const result = await consume(prepareNativeSage(selection()), response(body));
    assert.deepEqual(result.body, body); assert.equal(result.body.result.answer, null);
    assert.equal(result.usage.outcome, "success"); assert.equal(result.usage.requestCostReceipt, undefined);
    assert.equal(result.usage.tokens?.input ?? null, usage?.input_tokens ?? null);
    assert.equal(result.usage.tokens?.output ?? null, usage?.output_tokens ?? null);
  }
  for (const body of [{ ...sageResponse, error: "synthetic-private" }, { ...sageResponse, id: "other" }, { ...sageResponse, kind: "choice" },
    { ...sageResponse, result: { answer: "yes", probability: 2 } },
    { ...sageResponse, meta: { usage: { input_tokens: 17 } } }, { error: "synthetic-private", meta: sageResponse.meta }])
    await assert.rejects(consume(prepareNativeSage(selection()), response(body)), invalidResponse);
});

const limit = 2 * 1024 * 1024, encoder = new TextEncoder();
const signal = () => new AbortController().signal;
const response = value => Response.json(value);
const invalidResponse = error => error.status === 502 && !error.message.includes("synthetic-private");
async function consume(native, upstream, abort = signal()) {
  const lease = native.acquire();
  try {
    const result = await native.read(upstream, abort);
    return { ...result, body: await result.response.json() };
  } finally { lease.release(); }
}
function containers(value) {
  if (!value || typeof value !== "object") return 0;
  return 1 + Object.values(value).reduce((sum, item) => sum + containers(item), 0);
}
function nested(count) { let value = "leaf"; while (count--) value = { next: value }; return value; }

function responseCases(label, makeNative, envelope) {
  for (const [name, make] of [
    ["HTTP rejection", () => new Response("synthetic-private", { status: 403 })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://other.example" } })],
    ["redirected response", () => { const r = response(envelope()); Object.defineProperty(r, "redirected", { value: true }); return r; }],
    ["missing body", () => new Response(null, { headers: { "content-type": "application/json" } })],
    ["wrong MIME", () => new Response("synthetic-private", { headers: { "content-type": "text/html" } })],
    ["invalid charset", () => new Response("{}", { headers: { "content-type": "application/json;charset=latin1" } })],
    ["compression", () => new Response("{}", { headers: { "content-type": "application/json", "content-encoding": "gzip" } })],
    ["partial range", () => responseWith("{}", { "content-range": "bytes 0-1/100" })],
    ["malformed JSON", () => responseWith('{"synthetic-private":')],
    ["invalid UTF-8", () => responseWith(new Uint8Array([123, 34, 255, 34, 58, 49, 125]))],
    ["declared oversize", () => responseWith("{}", { "content-length": String(limit + 1) })],
    ["truncated length", () => responseWith(JSON.stringify(envelope()), { "content-length": "999999" })],
    ["trailing content", () => responseWith(JSON.stringify(envelope()) + "{}")],
  ]) test(`${label}: ${name} never releases output or invents usage`, async () => {
    const before = bodyBudgetCharged();
    await assert.rejects(consume(makeNative(), make()), invalidResponse);
    assert.equal(bodyBudgetCharged(), before);
  });

  test(`${label}: exact operational byte/depth/container bounds and native scalar values`, async () => {
    const body = { ...envelope(), padding: "" };
    body.padding = "x".repeat(limit - encoder.encode(JSON.stringify(body)).length);
    assert.equal((await consume(makeNative(), response(body))).body.padding.length, body.padding.length);
    body.padding += "x"; await assert.rejects(consume(makeNative(), response(body)), invalidResponse);
    const deep = { ...envelope(), extra: nested(63) };
    assert.deepEqual((await consume(makeNative(), response(deep))).body.extra, deep.extra);
    await assert.rejects(consume(makeNative(), response({ ...envelope(), extra: nested(64) })), invalidResponse);
    const many = { ...envelope(), extra: [] };
    many.extra = Array.from({ length: 4096 - containers(many) }, () => ({}));
    assert.equal(containers(many), 4096);
    assert.deepEqual((await consume(makeNative(), response(many))).body.extra, many.extra);
    many.extra.push({}); await assert.rejects(consume(makeNative(), response(many)), invalidResponse);
    const quoted = { ...envelope(), extra: '"\\[]{}' + "[{}]".repeat(5000) };
    assert.deepEqual((await consume(makeNative(), response(quoted))).body, quoted);
    await assert.rejects(consume(makeNative(), responseWith(JSON.stringify(envelope()).slice(0, -1) + ',"extra":1e999}')), invalidResponse);
  });

  test(`${label}: every split preserves UTF-8 and escape/structure state`, async () => {
    const body = { ...envelope(), extra: 'é 🎲 "\\[{}]' }, bytes = encoder.encode(JSON.stringify(body));
    for (let split = 1; split < bytes.length; split++) {
      const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
      const stream = new ReadableStream({ pull(c) { if (chunks.length) c.enqueue(chunks.shift()); else c.close(); } }, { highWaterMark: 0 });
      assert.deepEqual((await consume(makeNative(), responseWith(stream))).body, body);
    }
  });

  test(`${label}: all chunks including empty chunks count toward the 8192 bound`, async () => {
    for (const empty of [8191, 8192]) {
      let sent = 0, canceled = false;
      const stream = new ReadableStream({ pull(c) {
        if (sent++ < empty) c.enqueue(new Uint8Array(0));
        else if (sent === empty + 1) c.enqueue(encoder.encode(JSON.stringify(envelope())));
        else c.close();
      }, cancel() { canceled = true; } }, { highWaterMark: 0 });
      if (empty === 8191) assert.deepEqual((await consume(makeNative(), responseWith(stream))).body, envelope());
      else { await assert.rejects(consume(makeNative(), responseWith(stream)), invalidResponse); await new Promise(setImmediate); assert.equal(canceled, true); }
    }
  });

  test(`${label}: complete EOF precedes publication and caller retains the lease through delivery`, async () => {
    let controller, published = false;
    const upstream = responseWith(new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(JSON.stringify(envelope()))); } }));
    const native = makeNative(), before = bodyBudgetCharged(), lease = native.acquire();
    assert.equal(bodyBudgetCharged() - before, 64 * 1024 * 1024);
    try {
      const reading = native.read(upstream, signal()).then(value => { published = true; return value; });
      await new Promise(setImmediate); assert.equal(published, false); controller.close();
      const result = await reading;
      assert.equal(bodyBudgetCharged() - before, 64 * 1024 * 1024);
      assert.deepEqual(await result.response.json(), envelope());
      assert.equal(bodyBudgetCharged() - before, 64 * 1024 * 1024);
    } finally { lease.release(); }
    assert.equal(bodyBudgetCharged(), before);
  });

  test(`${label}: abort cancels a stalled body without publication`, async () => {
    let canceled = false;
    const abort = new AbortController(), before = bodyBudgetCharged();
    const upstream = responseWith(new ReadableStream({ start(c) { c.enqueue(encoder.encode(JSON.stringify(envelope()))); }, cancel() { canceled = true; } }));
    const reading = consume(makeNative(), upstream, abort.signal);
    await new Promise(setImmediate); abort.abort();
    await assert.rejects(reading, invalidResponse); await new Promise(setImmediate);
    assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), before);
  });

  test(`${label}: capacity refusal leaks no charge and route cannot choose another destination`, () => {
    const native = makeNative(), before = bodyBudgetCharged(), occupied = new BodyLease();
    assert.equal(occupied.grow(bodyBudgetBytes / 2), true);
    try { assert.throws(() => native.acquire(), e => e.status === 503 && e.code === "server_overloaded"); }
    finally { occupied.release(); }
    assert.equal(bodyBudgetCharged(), before);
    assert.doesNotThrow(() => assertNativeResponseDestination(native, new URL(native.origin + native.path)));
    for (const url of [native.origin + native.path + "?model=other", "https://other.example" + native.path, native.origin + "/other"])
      assert.throws(() => assertNativeResponseDestination(native, new URL(url)));
  });
}
function responseWith(body, headers = {}) { return new Response(body, { headers: { "content-type": "application/json", ...headers } }); }

responseCases("Sage", () => prepareNativeSage(selection()), () => structuredClone(sageResponse));

test("Sage preserves the existing codec request byte ceiling", () => {
  const selected = selection(), body = { ...structuredClone(sageRequest), content: "" };
  body.content = "x".repeat(4 * 1024 * 1024 - 1 - encoder.encode(JSON.stringify(body)).length);
  selected.body = body; assert.ok(prepareNativeSage(selected));
  const tooLarge = selection(); tooLarge.body = { ...body, content: body.content + "x" };
  assert.throws(() => prepareNativeSage(tooLarge), e => e.code === "invalid_native_sage_request");
});

function workerInput() { return { ...structuredClone(sageRequest), model: "levanto-sage-2" }; }
// Exercise the registered factories through the real Worker and SQLite ledgers.
// These synthetic declarations do not activate or replace a shipped manifest.
async function workerFixture(t, product, options = {}) {
  const chosen = options.batch ? batchSelection() : selection();
  const f = await managedFixture(t, { providerId: product, pooled: true, fixed: options.fixed === undefined ? 700 : options.fixed,
    configure(provider) { Object.assign(provider, chosen.provider); } });
  for (const key of chosen.provider.config_keys) f.env[key] = "synthetic-unselected-environment";
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = request => {
    f.beforeDispatch = { charged: bodyBudgetCharged(), rows: f.rows() };
    return options.response ? options.response(request) : Response.json(options.batch ? batchResponse() : sageResponse);
  };
  f.request = (body = options.batch ? { ...batchInput(), model: chosen.model.upstream } : workerInput(product), { manifest = false, query = "", ...extra } = {}) => f.call(
    (manifest ? `/v1/proxy/${product}/${chosen.endpoint.id}` : `/v1/native/${product}${chosen.endpoint.path}`) + query,
    manifest ? { body } : body, { ...extra, headers: { "x-api-key": "synthetic-caller-key", ...extra.headers } });
  t.after(f.drain);
  return f;
}
async function workerSettled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, cost);
  assert.equal(events[0].cost_basis, cost === 0 ? "none" : "policy_fixed");
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === cost));
  assert.equal(bodyBudgetCharged(), 0); return events[0];
}
async function workerFailure(response, status = 502) {
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body));
  assert.doesNotMatch(JSON.stringify(body), /synthetic-original-key|synthetic-unselected-environment|synthetic-caller-key|synthetic-private/);
  return body.error;
}
for (const product of ["levanto"]) {
  for (const manifest of [false, true]) test(`${product}: registered ${manifest ? "manifest" : "native"} Worker dispatch holds capacity through downstream EOF and settles once`, { timeout: 10_000 }, async t => {
    const f = await workerFixture(t, product), selected = selection();
    const body = { ...structuredClone(workerInput(product)), model: manifest ? selected.model.id : selected.model.upstream };
    const response = await f.request(body, { manifest });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
    assert.deepEqual(await f.events(), []);
    assert.equal(f.sent.length, 1);
    const request = f.sent[0];
    assert.equal(request.url, selected.provider.base_urls.default + selected.endpoint.path);
    assert.equal(request.method, "POST"); assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-api-key"), null);
    const wire = await request.clone().json();
    assert.deepEqual(wire, sageRequest);
    assert.equal(f.beforeDispatch.charged, 64 * 1024 * 1024);
    assert.ok(f.beforeDispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0));
    assert.deepEqual(await response.json(), sageResponse);
    const event = await workerSettled(f);
    assert.equal(event.model, selected.model.id); assert.equal(event.provider, product);
    assert.equal(event.capability, "llm.decisions"); assert.equal(event.status, "success");
    assert.equal(event.input_tokens, 17); assert.equal(event.output_tokens, 3);
    assert.equal(f.sent.length, 1);
  });

  test(`${product}: registered Worker distinguishes explicit zero from missing observations without free execution`, { timeout: 10_000 }, async t => {
    const output = structuredClone(sageResponse); output.meta.usage = { input_tokens: 0, output_tokens: 0 };
    const f = await workerFixture(t, product, { response: () => Response.json(output) });
    const response = await f.request(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), output);
    const event = await workerSettled(f); assert.equal(event.input_tokens, 0); assert.equal(event.output_tokens, 0); assert.equal(f.sent.length, 1);
  });

  test(`${product}: closed inputs and query overrides are zero-egress`, { timeout: 10_000 }, async t => {
    const f = await workerFixture(t, product);
    for (const patch of [{ stream: true }, { model: "unqualified-model" }, { images: [] }, { assets: {} }]) {
      await workerFailure(await f.request({ ...workerInput(product), ...patch }), 400);
    }
    await workerFailure(await f.request(workerInput(product), { query: "?key=synthetic" }), 400);
    assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.equal(bodyBudgetCharged(), 0);
  });

  test(`${product}: unknown upstream price denies a dollar-priced request before egress`, { timeout: 10_000 }, async t => {
    const f = await workerFixture(t, product, { fixed: null });
    const error = await workerFailure(await f.request(), 400);
    assert.equal(error.code, "pricing_required"); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
  });

  for (const mode of ["rejected", "malformed", "missing-usage", "oversized", "empty-chunks", "interrupted"]) {
    test(`${product}: registered Worker ${mode} retains one conservative settlement and never retries POST`, { timeout: 10_000 }, async t => {
      const output = structuredClone(sageResponse);
      const f = await workerFixture(t, product, { response: () => {
        if (mode === "rejected") return Response.json({ error: "synthetic-private" }, { status: 422 });
        if (mode === "malformed") return responseWith('{"synthetic-private":');
        if (mode === "oversized") return responseWith("{}", { "content-length": String(limit + 1) });
        if (mode === "interrupted") return responseWith(new ReadableStream({ start(c) { c.enqueue(encoder.encode("{")); c.error(new Error("synthetic-private")); } }));
        if (mode === "empty-chunks") return responseWith(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(0)); } }, { highWaterMark: 0 }));
        delete output.meta.usage;
        return Response.json(output);
      } });
      const response = await f.request();
      if (mode === "missing-usage" && product === "levanto") {
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), output);
      } else await workerFailure(response);
      const event = await workerSettled(f);
      assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(f.sent.length, 1);
    });
  }

  test(`${product}: downstream cancellation releases the response lease only at cancellation`, { timeout: 10_000 }, async t => {
    const f = await workerFixture(t, product), response = await f.request();
    assert.equal(response.status, 200); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
    assert.deepEqual(await f.events(), []);
    await response.body.cancel("synthetic caller cancellation");
    await workerSettled(f); assert.equal(f.sent.length, 1);
  });

  test(`${product}: caller abort before upstream EOF withholds answers and cancels upstream`, { timeout: 10_000 }, async t => {
    const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false, delivered = false;
    const f = await workerFixture(t, product, { response: () => responseWith(new ReadableStream({ start(c) {
      c.enqueue(encoder.encode(JSON.stringify(sageResponse))); reached.resolve();
    }, cancel() { canceled = true; } })) });
    const pending = f.request(workerInput(product), { signal: abort.signal }).then(response => { delivered = true; return response; });
    await reached.promise; await new Promise(setImmediate);
    assert.equal(delivered, false); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
    abort.abort(); await workerFailure(await pending); await workerSettled(f);
    assert.equal(canceled, true); assert.equal(f.sent.length, 1);
  });

  test(`${product}: capacity rejection occurs before dispatch and settles known-unsent legs`, { timeout: 10_000 }, async t => {
    const occupied = new BodyLease(); assert.equal(occupied.grow(17 * 1024 * 1024), true);
    const f = await workerFixture(t, product);
    try { assert.equal((await workerFailure(await f.request(), 503)).code, "server_overloaded"); }
    finally { occupied.release(); }
    await workerSettled(f, 0); assert.equal(f.sent.length, 0);
  });
}

test("Sage registered Worker keeps native and manifest batch without support metadata closed before egress", { timeout: 10_000 }, async t => {
  const f = await workerFixture(t, "levanto");
  const body = { model: "levanto-sage-2", requests: [{ content: "synthetic evidence", questions: [sageRequest.question] }] };
  await workerFailure(await f.call("/v1/native/levanto/decide/batch", body), 400);
  await workerFailure(await f.call("/v1/proxy/levanto/decisions_batch", { body }), 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.equal(bodyBudgetCharged(), 0);
});


function batchInput() {
  return { requests: [
    { content: "synthetic text", questions: [structuredClone(sageRequest.question),
      { id: "route", kind: "choice", instructions: "synthetic route", options: [{ option: "left" }, { option: "right" }] },
      { id: "grade", kind: "scale", instructions: "synthetic grade", levels: [{ level: 1 }, { level: 2 }] },
      { id: "tags", kind: "tags", tags: [{ id: "a" }] }] },
    { content: { kind: "list", value: [{ id: "a", content: "first" }, { id: "b", content: "second" }] },
      questions: [{ id: "sort", kind: "sort", instructions: "synthetic order" }] },
  ], reasoning: "on" };
}
function batchResponse() {
  return { results: [{ answers: [
    { ok: true, result: structuredClone(sageResponse) },
    { ok: true, result: { id: "route", kind: "choice", meta: {}, result: { chosen: null, probability: null,
      probabilities: [{ option: "left", probability: 0.6 }, { option: "right", probability: 0.4 }] } } },
    { ok: true, result: { id: "grade", kind: "scale", meta: {}, result: { expectation: 1.4, confidence: 0.6,
      probabilities: [{ level: 1, probability: 0.6 }, { level: 2, probability: 0.4 }] } } },
    { ok: true, result: { id: "tags", kind: "tags", meta: {}, result: { tags: [{ id: "a", probability: 0.4, applies: null }] } } },
  ] }, { answers: [{ ok: true, result: { id: "sort", kind: "sort", meta: {}, result: { sorted: ["b", "a"], confidence: 0.8 } } }] }],
  meta: { usage: { input_tokens: 29, output_tokens: 7 }, reasoning: { ran: true, finished: true } } };
}
function batchSelection() {
  const selected = selection();
  selected.model.nativeCapabilities = { version: "clawrouter.native-capabilities.v1", endpoints: { decisions_batch: structuredClone(sageBatchFacts) } };
  selected.endpoint = selected.provider.endpoints.find(endpoint => endpoint.id === "decisions_batch");
  selected.capability = "llm.decisions.batch"; selected.body = { ...batchInput(), model: selected.model.id };
  return selected;
}

test("Sage batch preserves text/list groups, question types and reasoning while removing only the router model", () => {
  for (const model of [undefined, "levanto/levanto-sage-2", "levanto-sage-2"]) {
    const selected = batchSelection(); if (model === undefined) delete selected.body.model; else selected.body.model = model;
    const before = structuredClone(selected), native = prepareNativeSage(selected);
    assert.deepEqual(selected, { ...before, body: batchInput() });
    assert.equal(native.origin, "https://sage.levanto.ai"); assert.equal(native.path, "/decide/batch");
    assert.equal(native.tariff, undefined); assert.equal(selected.model.pricing, null);
  }
});

test("Sage batch requires explicit text/list support and its exact selected model, format, capability and route", () => {
  for (const change of [s => { delete s.model.nativeCapabilities; },
    s => { s.model.nativeCapabilities.endpoints = {}; },
    s => { s.model.nativeCapabilities.endpoints.decisions_batch.input = ["text"]; },
    s => { s.model.nativeCapabilities.endpoints.decisions_batch.input.push("image"); },
    s => { s.model.nativeCapabilities.endpoints.decisions_batch.inference.decision.protocol = "openai-decisions"; },
    s => { s.model.nativeCapabilities.endpoints.decisions_batch.inference.chat = true; },
    s => { s.model.nativeCapabilities.endpoints.decisions_batch.inference.decision.limits = { image: {} }; },
    s => { s.model.nativeCapabilities.endpoints.decisions_batch.inference.decision.questions.choice.maxImageOptions = 20; },
    s => { s.provider.id = "other"; }, s => { s.provider.base_urls.default = "https://other.example"; },
    s => { s.model.id = "levanto/alias"; }, s => { s.model.upstream = "other"; },
    s => { s.model.capabilities = ["llm.decisions"]; }, s => { s.capability = "llm.decisions"; },
    s => { s.provider.capabilities = []; }, s => { s.method = "GET"; }, s => { s.endpoint.method = "GET"; },
    s => { s.endpoint.id = "decisions"; }, s => { s.endpoint.path = "/decide"; },
    s => { s.endpoint.response_format = "levanto.sage"; }, s => { s.endpoint.upstreamPath = "/decide/batch"; },
    s => { s.endpoint.path_params = ["model"]; }, s => { s.pathParams = { model: "other" }; },
    s => { s.endpoint.query = { model: "other" }; }, s => { s.nativeQuery = {}; },
    s => { s.endpoint.streaming = "sse"; }, s => { s.endpoint.websocket = {}; }]) {
    const selected = batchSelection(); change(selected); const before = structuredClone(selected);
    assert.throws(() => prepareNativeSage(selected), invalidRoute); assert.deepEqual(selected, before);
  }
});

test("Sage batch request validation is atomic across groups and preserves the existing request byte ceiling", () => {
  for (const change of [b => { b.requests = []; }, b => { b.requests[1].questions = []; },
    b => { b.requests[0].questions.push(b.requests[0].questions[0]); },
    b => { b.requests[1].content.value[1].id = "a"; }, b => { b.requests[1].content = "not a list for sort"; },
    b => { b.requests[1].content = { kind: "image", media: "data:image/png;base64,iVBORw0KGgo=" }; },
    b => { b.stream = false; }, b => { b.reasoning = "unsupported"; }, b => { b.model = "other"; }]) {
    const selected = batchSelection(); change(selected.body); const before = structuredClone(selected);
    assert.throws(() => prepareNativeSage(selected), e => e.code === "invalid_native_sage_request"); assert.deepEqual(selected, before);
  }
  const body = batchInput(); body.requests[0].content = "";
  body.requests[0].content = "x".repeat(4 * 1024 * 1024 - 1 - encoder.encode(JSON.stringify(body)).length);
  const selected = batchSelection(); selected.body = body; assert.ok(prepareNativeSage(selected));
  const tooLarge = batchSelection(); tooLarge.body = structuredClone(body); tooLarge.body.requests[0].content += "x";
  assert.throws(() => prepareNativeSage(tooLarge), e => e.code === "invalid_native_sage_request");
});

responseCases("Sage batch", () => prepareNativeSage(batchSelection()), batchResponse);

for (const manifest of [false, true]) test(`Sage batch registered ${manifest ? "manifest" : "native"} route preserves all typed answers and downstream lease ownership`, { timeout: 10_000 }, async t => {
  const f = await workerFixture(t, "levanto", { batch: true }), body = { ...batchInput(), model: manifest ? "levanto/levanto-sage-2" : "levanto-sage-2" };
  const result = await f.request(body, { manifest }); assert.equal(result.status, 200, result.status === 200 ? undefined : await result.text());
  assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); assert.deepEqual(await f.events(), []);
  assert.equal(f.sent.length, 1); const request = f.sent[0];
  assert.equal(request.url, "https://sage.levanto.ai/decide/batch"); assert.equal(request.method, "POST"); assert.equal(request.redirect, "manual");
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(request.headers.get("x-api-key"), null);
  assert.deepEqual(await request.clone().json(), batchInput()); assert.equal(f.beforeDispatch.charged, 64 * 1024 * 1024);
  assert.ok(f.beforeDispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0));
  assert.deepEqual(await result.json(), batchResponse()); const event = await workerSettled(f);
  assert.equal(event.capability, "llm.decisions.batch"); assert.equal(event.model, "levanto/levanto-sage-2"); assert.equal(event.status, "success");
  assert.equal(event.input_tokens, 29); assert.equal(event.output_tokens, 7); assert.equal(f.sent.length, 1);
});

for (const mode of ["mixed", "all-errors", "zero", "zero-output", "unknown", "image-counter"]) test(`Sage batch ${mode} preserves per-answer results and only top-level qualified usage`, { timeout: 10_000 }, async t => {
  const output = batchResponse();
  if (mode === "mixed") output.results[0].answers[1] = { ok: false, error: "synthetic modeled refusal" };
  if (mode === "all-errors") output.results.forEach(group => { group.answers = group.answers.map(() => ({ ok: false, error: "synthetic modeled refusal" })); });
  if (mode === "zero") output.meta.usage = { input_tokens: 0, output_tokens: 0 };
  if (mode === "zero-output") output.meta.usage = { input_tokens: 29, output_tokens: 0 };
  if (mode === "unknown") delete output.meta.usage;
  if (mode === "image-counter") output.meta.usage.image_tokens = 1;
  const f = await workerFixture(t, "levanto", { batch: true, response: () => Response.json(output) });
  const result = await f.request(); assert.equal(result.status, 200); assert.deepEqual(await result.json(), output);
  const event = await workerSettled(f); const unknown = mode === "unknown" || mode === "image-counter";
  assert.equal(event.input_tokens, unknown ? null : output.meta.usage.input_tokens);
  assert.equal(event.output_tokens, unknown ? null : output.meta.usage.output_tokens); assert.equal(f.sent.length, 1);
});

for (const mode of ["group-count", "answer-count", "answer-id", "answer-kind", "bad-probability", "error-with-result", "empty-error", "partial-usage", "missing-meta", "malformed", "http-error", "oversize", "empty-chunks"]) {
  test(`Sage batch ${mode} withholds every sibling and settles conservatively without replay`, { timeout: 10_000 }, async t => {
    const output = batchResponse();
    if (mode === "group-count") output.results.pop();
    if (mode === "answer-count") output.results[0].answers.pop();
    if (mode === "answer-id") output.results[1].answers[0].result.id = "other";
    if (mode === "answer-kind") output.results[1].answers[0].result.kind = "yesno";
    if (mode === "bad-probability") output.results[0].answers[0].result.result.probability = 2;
    if (mode === "error-with-result") output.results[0].answers[0].ok = false;
    if (mode === "empty-error") output.results[0].answers[0] = { ok: false, error: "" };
    if (mode === "partial-usage") delete output.meta.usage.input_tokens;
    if (mode === "missing-meta") delete output.meta;
    const f = await workerFixture(t, "levanto", { batch: true, response: () => {
      if (mode === "malformed") return responseWith(JSON.stringify(output).slice(0, -1));
      if (mode === "http-error") return Response.json({ error: "synthetic-private" }, { status: 422 });
      if (mode === "oversize") return responseWith("{}", { "content-length": String(limit + 1) });
      if (mode === "empty-chunks") return responseWith(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(0)); } }, { highWaterMark: 0 }));
      return Response.json(output);
    } });
    await workerFailure(await f.request()); const event = await workerSettled(f);
    assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(f.sent.length, 1);
  });
}

test("Sage batch registered request rejection and revoked caller are zero-egress", { timeout: 10_000 }, async t => {
  const f = await workerFixture(t, "levanto", { batch: true });
  for (const manifest of [false, true]) {
    for (const patch of [{ requests: [] }, { stream: true }, { model: "other" }, { images: [] },
      { requests: [...batchInput().requests, { content: { kind: "image", media: "https://other.example/image" }, questions: [sageRequest.question] }] }])
      await workerFailure(await f.request({ ...batchInput(), model: "levanto-sage-2", ...patch }, { manifest }), 400);
    await workerFailure(await f.request(undefined, { manifest, query: "?model=other" }), 400);
  }
  await f.authority("/credentials/put", { credentialId: "fixture", credential: { ...f.credential, enabled: false } });
  assert.equal((await f.request()).status, 401);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("Sage batch unknown price remains denied under a dollar policy", { timeout: 10_000 }, async t => {
  const f = await workerFixture(t, "levanto", { batch: true, fixed: null });
  assert.equal((await workerFailure(await f.request(), 400)).code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("Sage batch capacity refusal never sends POST and settles only known-unsent reservations", { timeout: 10_000 }, async t => {
  const occupied = new BodyLease(); assert.equal(occupied.grow(17 * 1024 * 1024), true);
  const f = await workerFixture(t, "levanto", { batch: true });
  try { assert.equal((await workerFailure(await f.request(), 503)).code, "server_overloaded"); }
  finally { occupied.release(); }
  await workerSettled(f, 0); assert.equal(f.sent.length, 0);
});

test("Sage batch abort before upstream EOF withholds siblings and cancels the reader", { timeout: 10_000 }, async t => {
  const reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false, delivered = false;
  const f = await workerFixture(t, "levanto", { batch: true, response: () => responseWith(new ReadableStream({ start(c) {
    c.enqueue(encoder.encode(JSON.stringify(batchResponse()))); reached.resolve();
  }, cancel() { canceled = true; } })) });
  const pending = f.request(undefined, { signal: abort.signal }).then(result => { delivered = true; return result; });
  await reached.promise; await new Promise(setImmediate); assert.equal(delivered, false); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  abort.abort(); await workerFailure(await pending); await workerSettled(f);
  assert.equal(canceled, true); assert.equal(f.sent.length, 1);
});

test("Sage batch downstream cancellation retains the lease until cancel and settles once", { timeout: 10_000 }, async t => {
  const f = await workerFixture(t, "levanto", { batch: true }), result = await f.request();
  assert.equal(result.status, 200); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); assert.deepEqual(await f.events(), []);
  await result.body.cancel(); await workerSettled(f); assert.equal(f.sent.length, 1);
});
