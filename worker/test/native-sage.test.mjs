import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture as managedFixture } from "./managed-runtime-fixture.mjs";
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { prepareNativeSage } = await import("../native-sage.ts");
const { sageRequest, sageResponse } = await import("./provider-decision-fixtures.ts");

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

test("Sage leaves unrelated formats untouched and batch fails closed", () => {
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
  const chosen = selection();
  const f = await managedFixture(t, { providerId: product, pooled: true, fixed: options.fixed === undefined ? 700 : options.fixed,
    configure(provider) { Object.assign(provider, chosen.provider); } });
  for (const key of chosen.provider.config_keys) f.env[key] = "synthetic-unselected-environment";
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = request => {
    f.beforeDispatch = { charged: bodyBudgetCharged(), rows: f.rows() };
    return options.response ? options.response(request) : Response.json(sageResponse);
  };
  f.request = (body = workerInput(product), { manifest = false, query = "", ...extra } = {}) => f.call(
    (manifest ? `/v1/proxy/${product}/decisions` : `/v1/native/${product}${chosen.endpoint.path}`) + query,
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

test("Sage registered Worker keeps native and manifest batch closed before egress", { timeout: 10_000 }, async t => {
  const f = await workerFixture(t, "levanto");
  const body = { model: "levanto-sage-2", requests: [{ content: "synthetic evidence", questions: [sageRequest.question] }] };
  await workerFailure(await f.call("/v1/native/levanto/decide/batch", body), 400);
  await workerFailure(await f.call("/v1/proxy/levanto/decisions_batch", { body }), 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.equal(bodyBudgetCharged(), 0);
});
