import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeBasetenSystemOne } = await import("../native-baseten-systemone.ts");
const { BASETEN_SYSTEMONE_MODELS: models } = await import("../provider-baseten-systemone.ts");
const { basetenSystemOneRequest: input, basetenSystemOneResponse: output } = await import("./baseten-systemone-fixtures.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const signal = () => new AbortController().signal;

function selection(model = models[0]) {
  const provider = compileProviderSnapshot([{
    schema: "clawrouter.service-provider.v1", id: "baseten", displayName: "Baseten fixture",
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://inference.baseten.co/v1" },
    capabilities: [{ id: "llm.decisions", endpoint: "systemone", methods: ["POST"] }],
    endpoints: { systemone: { path: "/systemone", requestFormat: "baseten.systemone", responseFormat: "baseten.systemone" } },
    models: { entries: models.map(upstream => ({ id: `baseten/${upstream}`, upstream, capabilities: ["llm.decisions"], nativeCapabilities: {
      version: "clawrouter.native-capabilities.v1", endpoints: { systemone: {
        sources: ["https://docs.baseten.co/reference/inference-api/system-one"], checkedAt: "2026-11-03", input: ["text", "json"],
        inference: { chat: false, decision: { protocol: "baseten-systemone", reasoning: { modes: ["auto"] }, confidence: "provider-specific", outputTokensPerQuestion: 1,
          questions: { boolean: { probabilities: "boolean", abstention: false },
            choice: { probabilities: "provider-defined", abstention: false, minOptions: 2, maxOptions: 255 },
            score: { probabilities: "provider-defined", abstention: false, minOptions: 2, maxOptions: 10 } },
          limits: { maxTotalOptions: 512, maxStateAndQuestionTokens: 16384 } },
        },
      } },
    } })) },
  }]).providers[0];
  const endpoint = provider.endpoints[0];
  const prepared = prepareManifestRequest(provider, endpoint, { ...structuredClone(input), model: `baseten/${model}` }, {}, {});
  return { provider, endpoint, ...prepared, capability: "llm.decisions", method: "POST" };
}
const invalidRoute = e => e.status === 400 && e.code === "invalid_native_baseten_systemone_route";
const invalidResponse = e => e.status === 502 && e.code === "invalid_baseten_systemone_response";

for (const model of models) test(`native Baseten wrapper binds ${model} without altering other selection state`, () => {
  const selected = selection(model), before = { ...selected }, original = structuredClone(selected.body);
  selected.body.model = "synthetic-untrusted-body-model";
  const native = prepareNativeBasetenSystemOne(selected);
  assert.equal(native.origin, "https://inference.baseten.co"); assert.equal(native.path, "/v1/systemone");
  assert.equal(native.tariff, undefined); assert.equal(selected.body.model, model);
  assert.notEqual(selected.body, before.body); assert.deepEqual(selected.body.questions, original.questions);
  assert.equal(selected.body.state, original.state);
  for (const key of Object.keys(selected).filter(k => k !== "body")) assert.equal(selected[key], before[key]);
  assert.equal(selected.model.pricing, null); assert.equal(selected.model.pricing_ref, null);
});

test("native Baseten wrapper leaves unrelated formats untouched", () => {
  for (const format of ["openai.decisions", "openai.chat_completions", "liquid.systemone", "typesafe.systemone"]) {
    const selected = selection(); selected.endpoint.request_format = format; const { preparation, ...data } = selected, before = structuredClone(data), keys = Reflect.ownKeys(selected);
    assert.equal(prepareNativeBasetenSystemOne(selected), undefined);
    const { preparation: afterPreparation, ...after } = selected; assert.equal(afterPreparation, preparation); assert.deepEqual(Reflect.ownKeys(selected), keys); assert.deepEqual(after, before);
  }
});

test("native Baseten wrapper rejects mismatched route, provider and selected model before mutation", () => {
  for (const change of [
    s => { s.provider.id = "liquid-ai"; }, s => { s.model = null; }, s => { s.model.upstream = "zai-org/GLM-5.3"; },
    s => { s.model.id = "baseten/alias"; }, s => { s.model.capabilities = ["llm.chat"]; },
    s => { s.capability = "llm.chat"; }, s => { s.method = "GET"; }, s => { s.endpoint.method = "GET"; },
    s => { s.endpoint.response_format = "liquid.systemone"; }, s => { s.endpoint.path = "/v1/systemone"; },
    s => { s.endpoint.upstreamPath = "/systemone"; }, s => { s.endpoint.streaming = "sse"; },
    s => { s.endpoint.websocket = "openai.responses"; }, s => { s.endpoint.modelPassthrough = {}; },
    s => { s.endpoint.lifecycle = {}; }, s => { s.endpoint.responsesLifecycle = {}; },
    s => { s.endpoint.path_params = ["model"]; }, s => { s.pathParams = { model: "synthetic" }; }, s => { s.endpoint.query = { model: "synthetic" }; },
  ]) {
    const selected = selection(); change(selected); const { preparation, ...data } = selected, before = structuredClone(data), keys = Reflect.ownKeys(selected);
    assert.throws(() => prepareNativeBasetenSystemOne(selected), invalidRoute);
    const { preparation: afterPreparation, ...after } = selected; assert.equal(afterPreparation, preparation); assert.deepEqual(Reflect.ownKeys(selected), keys); assert.deepEqual(after, before);
  }
});

test("native Baseten wrapper reports malformed native input without exposing state", () => {
  for (const body of [null, [], { ...input, state: { private: "synthetic-private" } }, { ...input, stream: true },
    { ...input, questions: {} }, { ...input, questions: { q: { type: "boolean" } } }]) {
    const selected = selection(); selected.body = body;
    assert.throws(() => prepareNativeBasetenSystemOne(selected), e => e.status === 400 && e.code === "invalid_native_baseten_systemone_request" && !e.message.includes("synthetic-private"));
    assert.equal(selected.body, body);
  }
});

for (const model of models) test(`native Baseten wrapper preserves complete answers and independent usage for ${model}`, async () => {
  const selected = selection(model), native = prepareNativeBasetenSystemOne(selected), body = { ...structuredClone(output), model: "synthetic-backend", native_units: 999 };
  const source = Response.json(body, { headers: { "content-length": String(new TextEncoder().encode(JSON.stringify(body)).length), etag: "synthetic-old-digest", "x-request-id": "fixture" } });
  const before = bodyBudgetCharged(), lease = native.acquire();
  assert.ok(lease.leased); assert.equal(bodyBudgetCharged() - before, 8 * 1024 * 1024);
  try {
    const result = await native.read(source, signal()), received = await result.response.json();
    assert.deepEqual(received, { ...output, model: "synthetic-backend" });
    assert.equal(selected.model.upstream, model); assert.equal(selected.body.model, model);
    assert.equal(result.response.headers.get("content-length"), null); assert.equal(result.response.headers.get("etag"), null);
    assert.equal(result.response.headers.get("x-request-id"), "fixture");
    assert.deepEqual(result.usage, { tokens: { input: 42, output: 3, total: 45, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }, outcome: "success" });
  } finally { lease.release(); }
  assert.equal(bodyBudgetCharged(), before);
});

test("native Baseten wrapper never borrows Liquid zero-output accounting or fabricates missing observations", async () => {
  for (const usage of [undefined, { input_tokens: 42, output_tokens: 0 }, { input_tokens: 42 }, { input_tokens: 42, output_tokens: 2 }, { input_tokens: 42, output_tokens: 4 }]) {
    const native = prepareNativeBasetenSystemOne(selection());
    await assert.rejects(native.read(Response.json({ ...output, usage }), signal()), invalidResponse);
  }
});

for (const [name, make] of [
  ["HTTP error", () => new Response("synthetic-private", { status: 403 })],
  ["wrong MIME", () => new Response(JSON.stringify(output), { headers: { "content-type": "text/html" } })],
  ["truncated length", () => new Response(JSON.stringify(output), { headers: { "content-type": "application/json", "content-length": "99999" } })],
  ["malformed JSON", () => new Response('{"answers":', { headers: { "content-type": "application/json" } })],
  ["declared oversize", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } })],
]) test(`native Baseten wrapper refuses ${name} instead of publishing an answer`, async () => {
  await assert.rejects(prepareNativeBasetenSystemOne(selection()).read(make(), signal()), invalidResponse);
});

test("native Baseten wrapper waits for complete EOF and propagates cancellation", async () => {
  const controller = new AbortController(); let canceled = false, published = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(output))); }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  const reading = prepareNativeBasetenSystemOne(selection()).read(response, controller.signal).then(r => { published = true; return r; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  controller.abort(); await assert.rejects(reading, invalidResponse); assert.equal(canceled, true);
});

test("native Baseten wrapper capacity acquisition fails without leaking a lease", () => {
  const before = bodyBudgetCharged(), occupied = new BodyLease(); assert.equal(occupied.grow(bodyBudgetBytes / 2), true);
  try { assert.throws(() => prepareNativeBasetenSystemOne(selection()).acquire(), e => e.status === 503 && e.code === "server_overloaded"); }
  finally { occupied.release(); }
  assert.equal(bodyBudgetCharged(), before);
});

test("native Baseten wrapper loads without the test-only TypeScript resolver", () => {
  const out = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/native-baseten-systemone.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(out, "loaded");
});
