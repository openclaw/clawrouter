import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { prepareNativeSystemOne } = await import("../native-systemone.ts");
const { systemRequest, systemResponse } = await import("./provider-decision-fixtures.ts");

function selection(product = "liquid-ai") {
  const upstream = product === "liquid-ai" ? "d1.1" : "jev-latest", format = product === "liquid-ai" ? "liquid.systemone" : "typesafe.systemone";
  const provider = compileProviderSnapshot([{
    schema: "clawrouter.service-provider.v1", id: product, displayName: "SystemOne fixture",
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
