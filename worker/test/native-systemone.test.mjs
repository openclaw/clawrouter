import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture as managedFixture } from "./managed-runtime-fixture.mjs";
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { prepareNativeSystemOne } = await import("../native-systemone.ts");
const { systemRequest, systemResponse } = await import("./provider-decision-fixtures.ts");

function selection(product = "liquid-ai") {
  const upstream = product === "liquid-ai" ? "d1.1" : "jev-latest", format = product === "liquid-ai" ? "liquid.systemone" : "typesafe.systemone";
  const provider = compileProviderSnapshot([{
    schema: "clawrouter.service-provider.v1", id: product, displayName: "SystemOne fixture", class: "custom_adapter",
    service: { platform: product, kind: "model_provider", upstreamService: product, configKeys: [product === "liquid-ai" ? "LIQUID_API_KEY" : "TYPESAFE_API_KEY"] },
    adapter: { request: "systemone", response: "systemone", error: "json_error" },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: product === "liquid-ai" ? "https://api.liquid.ai/decisions/v1" : "https://api.typesafe.ai/v1" },
    capabilities: [{ id: "llm.decisions", endpoint: "decisions", methods: ["POST"] }],
    endpoints: { decisions: { method: "POST", path: "/systemone", requestFormat: format, responseFormat: format } },
    models: { entries: [{ id: `${product}/${upstream}`, upstream, capabilities: ["llm.decisions"] }] },
  }]).providers[0];
  return { provider, endpoint: provider.endpoints[0], model: provider.models[0], capability: "llm.decisions", method: "POST", pathParams: {}, body: structuredClone(systemRequest) };
}
const invalidRoute = e => e.status === 400 && e.code === "invalid_native_systemone_route";

for (const product of ["liquid-ai", "typesafe"]) {
  test(`${product}: bind exact 436 model, preserve criteria and distinguish native destinations`, () => {
    const selected = selection(product), before = structuredClone(selected), native = prepareNativeSystemOne(selected);
    assert.deepEqual(selected, { ...before, body: { ...before.body, model: selected.model.upstream } });
    assert.equal(native.origin + native.path, selected.provider.base_urls.default + "/systemone");
    assert.equal(native.tariff, undefined); assert.equal(selected.model.pricing, null);
    assert.equal(native.headers, undefined);
  });

  test(`${product}: exact product/model/capability/route guards precede mutation`, () => {
    for (const change of [s => { s.provider.id = "baseten"; }, s => { s.provider.base_urls.default = "https://other.example"; },
      s => { s.provider.capabilities = []; }, s => { s.provider.capabilities[0].methods = ["GET"]; }, s => { s.model = null; },
      s => { s.model.id = `${product}/alias`; }, s => { s.model.upstream = "d1"; }, s => { s.model.capabilities = ["llm.chat"]; },
      s => { s.capability = "llm.chat"; }, s => { s.method = "GET"; }, s => { s.endpoint.method = "GET"; },
      s => { s.endpoint.id = "other"; }, s => { s.endpoint.path = "/v1/systemone"; }, s => { s.endpoint.response_format = "baseten.systemone"; },
      s => { s.endpoint.upstreamPath = "/systemone"; }, s => { s.endpoint.path_params = ["model"]; }, s => { s.pathParams = { model: "other" }; },
      s => { s.endpoint.query = { model: "other" }; }, s => { s.nativeQuery = {}; }, s => { s.endpoint.streaming = "sse"; },
      s => { s.endpoint.websocket = {}; }, s => { s.endpoint.lifecycle = {}; }, s => { s.endpoint.responsesLifecycle = {}; },
      s => { s.endpoint.modelPassthrough = {}; }, s => { s.endpoint.requestPricing = {}; }]) {
      const selected = selection(product); change(selected); const before = structuredClone(selected);
      assert.throws(() => prepareNativeSystemOne(selected), invalidRoute); assert.deepEqual(selected, before);
    }
  });

  test(`${product}: images/assets, empty/unsupported questions and caller extensions remain closed`, () => {
    for (const body of [null, [], {}, { ...systemRequest, images: [] }, { ...systemRequest, assets: {} },
      { ...systemRequest, stream: false }, { ...systemRequest, questions: {} },
      { ...systemRequest, questions: { private: { type: "unsupported", instructions: "synthetic-private" } } }]) {
      const selected = selection(product); selected.body = body;
      assert.throws(() => prepareNativeSystemOne(selected), e => e.status === 400 && e.code === "invalid_native_systemone_request" && !e.message.includes("synthetic-private"));
      assert.equal(selected.body, body);
    }
  });

  test(`${product}: native probability/score/legend and explicit observed tokens survive`, async () => {
    const body = structuredClone(systemResponse); body.usage.output_tokens = product === "typesafe" ? 5 : 0;
    const upstream = response(body); upstream.headers.set("set-cookie", "synthetic-private"); upstream.headers.set("x-private", "synthetic-private");
    const result = await consume(prepareNativeSystemOne(selection(product)), upstream);
    assert.deepEqual(result.body, body); assert.equal(result.body.answers.gate.noul, 0.49); assert.equal(result.body.answers.grade.score, 0.7);
    assert.equal(result.usage.tokens.input, 17); assert.equal(result.usage.tokens.output, body.usage.output_tokens);
    assert.equal(result.usage.tokens.total, 17 + body.usage.output_tokens); assert.equal(result.usage.tokens.cached, null);
    assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.response.headers.get("set-cookie"), null); assert.equal(result.response.headers.get("x-private"), null);
    const zero = { ...body, usage: { input_tokens: 0, output_tokens: 0 } };
    assert.equal((await consume(prepareNativeSystemOne(selection(product)), response(zero))).usage.tokens.total, 0);
  });

  test(`${product}: incomplete/malformed answers or token observations never produce free success`, async () => {
    for (const change of [b => { b.error = "synthetic-private"; }, b => { delete b.usage; }, b => { delete b.usage.input_tokens; }, b => { b.usage.input_tokens = -1; },
      b => { b.usage.input_tokens = 1.5; }, b => { b.usage.output_tokens = Number.MAX_SAFE_INTEGER; }, b => { delete b.answers.route; },
      b => { b.answers.route.choice = "foreign"; }, b => { b.answers.grade.legend[0] = "foreign"; }, b => { b.answers.gate.noul = 2; },
      b => { b.model = ""; }, b => { b.error = "synthetic-private"; delete b.answers; }]) {
      const body = structuredClone(systemResponse); change(body);
      await assert.rejects(consume(prepareNativeSystemOne(selection(product)), response(body)), invalidResponse);
    }
    if (product === "liquid-ai") await assert.rejects(consume(prepareNativeSystemOne(selection(product)), response({ ...systemResponse, usage: { input_tokens: 17, output_tokens: 1 } })), invalidResponse);
  });
}

test("SystemOne does not acquire Baseten, Chat, Sage or OpenAI aliases", () => {
  for (const format of ["baseten.systemone", "openai.decisions", "openai.chat_completions", "levanto.sage"]) {
    const selected = selection(); selected.endpoint.request_format = format; const before = structuredClone(selected);
    assert.equal(prepareNativeSystemOne(selected), undefined); assert.deepEqual(selected, before);
  }
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

for (const product of ["liquid-ai", "typesafe"])
  responseCases(product, () => prepareNativeSystemOne(selection(product)), () => structuredClone(systemResponse));

for (const product of ["liquid-ai", "typesafe"]) test(`${product}: preserve the codec request ceiling after selected-model binding`, () => {
  const selected = selection(product), body = { ...structuredClone(systemRequest), model: selected.model.upstream, state: "" };
  const cap = product === "liquid-ai" ? 4_500_000 : 4 * 1024 * 1024;
  body.state = "x".repeat(cap - 1 - encoder.encode(JSON.stringify(body)).length);
  selected.body = body; assert.ok(prepareNativeSystemOne(selected));
  const tooLarge = selection(product); tooLarge.body = { ...body, state: body.state + "x" };
  assert.throws(() => prepareNativeSystemOne(tooLarge), e => e.code === "invalid_native_systemone_request");
});

function workerInput(product) { return { ...structuredClone(systemRequest), model: product === "liquid-ai" ? "d1.1" : "jev-latest" }; }
// Exercise the registered factories through the real Worker and SQLite ledgers.
// These synthetic declarations do not activate or replace a shipped manifest.
async function workerFixture(t, product, options = {}) {
  const chosen = selection(product);
  const f = await managedFixture(t, { providerId: product, pooled: true, fixed: options.fixed === undefined ? 700 : options.fixed,
    configure(provider) { Object.assign(provider, chosen.provider); } });
  for (const key of chosen.provider.config_keys) f.env[key] = "synthetic-unselected-environment";
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = request => {
    f.beforeDispatch = { charged: bodyBudgetCharged(), rows: f.rows() };
    return options.response ? options.response(request) : Response.json(systemResponse);
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
for (const product of ["liquid-ai", "typesafe"]) {
  for (const manifest of [false, true]) test(`${product}: registered ${manifest ? "manifest" : "native"} Worker dispatch holds capacity through downstream EOF and settles once`, { timeout: 10_000 }, async t => {
    const f = await workerFixture(t, product), selected = selection(product);
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
    assert.deepEqual(wire, { ...systemRequest, model: selected.model.upstream });
    assert.equal(f.beforeDispatch.charged, 64 * 1024 * 1024);
    assert.ok(f.beforeDispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0));
    assert.deepEqual(await response.json(), systemResponse);
    const event = await workerSettled(f);
    assert.equal(event.model, selected.model.id); assert.equal(event.provider, product);
    assert.equal(event.capability, "llm.decisions"); assert.equal(event.status, "success");
    assert.equal(event.input_tokens, 17); assert.equal(event.output_tokens, 0);
    assert.equal(f.sent.length, 1);
  });

  test(`${product}: registered Worker distinguishes explicit zero from missing observations without free execution`, { timeout: 10_000 }, async t => {
    const output = structuredClone(systemResponse); output.usage = { input_tokens: 0, output_tokens: 0 };
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
      const output = structuredClone(systemResponse);
      const f = await workerFixture(t, product, { response: () => {
        if (mode === "rejected") return Response.json({ error: "synthetic-private" }, { status: 422 });
        if (mode === "malformed") return responseWith('{"synthetic-private":');
        if (mode === "oversized") return responseWith("{}", { "content-length": String(limit + 1) });
        if (mode === "interrupted") return responseWith(new ReadableStream({ start(c) { c.enqueue(encoder.encode("{")); c.error(new Error("synthetic-private")); } }));
        if (mode === "empty-chunks") return responseWith(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(0)); } }, { highWaterMark: 0 }));
        delete output.usage;
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
      c.enqueue(encoder.encode(JSON.stringify(systemResponse))); reached.resolve();
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
