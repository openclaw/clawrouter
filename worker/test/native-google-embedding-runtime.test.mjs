import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/embeddings.json", import.meta.url), "utf8"));
const contracts = { unary: ["embed_content", "embedContent"], batch: ["batch_embed_contents", "batchEmbedContents"] };
const encoder = new TextEncoder();

async function fixture(t, options = {}) {
  const original = snapshot.providers, provider = structuredClone(original.find(row => row.id === "google-gemini"));
  provider.endpoints = Object.entries(contracts).map(([mode, [id, suffix]]) => {
    const endpoint = { ...provider.endpoints[0], id, path: `/v1beta/models/${"${model}"}:${suffix}`, request_format: `google.${id}`, response_format: `google.${id}`, timeout_ms: options.timeout ?? 1000 };
    delete endpoint.modelPassthrough;
    return endpoint;
  });
  provider.capabilities = provider.endpoints.map(endpoint => ({ id: "llm.embeddings", endpoint: endpoint.id, methods: ["POST"] }));
  provider.models = ["gemini-embedding-001", "gemini-embedding-2"].map(upstream => ({ id: `google/${upstream}`, upstream, aliases: [], capabilities: ["llm.embeddings"], pricing: null, pricing_ref: null }));
  if (options.origin) provider.base_urls.default = options.origin;
  snapshot.providers = original.map(row => row.id === provider.id ? provider : row);
  t.after(() => { snapshot.providers = original; });
  const policy = { enabled: true, generation: "v1", providers: [provider.id], models: options.models ?? null, tenantId: "fixture", monthlyBudgetMicros: options.limit ?? 10000,
    requestCostMicros: options.unpriced ? null : 17, retainRequestContent: false };
  const records = new Map(), events = [], pending = [], sent = [], settlements = [], names = new Set(), budgets = sqlBudgetNamespace(t);
  const env = { GOOGLE_API_KEY: "synthetic-google-key", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); }, async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => events.push(event) }, BUDGET_LEDGER: {
    idFromName: name => name, get(name) { names.add(name); return { fetch(url, init) {
      if (new URL(url).pathname === "/settle") settlements.push(JSON.parse(init.body));
      return budgets.get(name).fetch(url, init);
    } }; },
  } };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "embedding", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "embedding", credential: { enabled: true,
    secretSha256: await sha256Hex("synthetic-embedding"), policyId: "embedding", policyGeneration: "v1" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: provider.id, enabled: true, ...options.connection }]);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json(), redirect: init.redirect });
    assert.ok([...names].flatMap(name => budgets.get(name).reservations()).some(row => row.reserved_micros === 17), "original fixed reservation precedes dispatch");
    assert.ok(bodyBudgetCharged() >= 64 * 1024 * 1024, "shared response capacity precedes dispatch");
    return options.fetch ? options.fetch(url, init) : Response.json(wire[options.mode ?? "unary"].response);
  });
  const request = (body = wire[options.mode ?? "unary"].request, input = {}) => {
    const mode = options.mode ?? "unary", [id, suffix] = contracts[mode], model = input.model ?? wire[mode].model;
    const url = input.manifest ? `https://router.example/v1/proxy/${provider.id}/${id}` : `https://router.example/v1/native/${provider.id}/v1beta/models/${model}:${suffix}`;
    return worker.fetch(new Request(url + (input.query ?? ""), { method: "POST", signal: input.signal,
      headers: { authorization: input.auth ?? "Bearer clawrouter-live-embedding-synthetic-embedding", "content-type": "application/json", "x-goog-api-key": "synthetic-caller-key" },
      body: JSON.stringify(input.manifest ? { pathParams: { model }, body } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
  };
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, settlements, rows: () => [...names].flatMap(name => budgets.get(name).reservations()) };
}

for (const mode of ["unary", "batch"]) for (const manifest of [false, true]) test(`Google ${mode} ${manifest ? "manifest" : "native"} preserves wire and settles once`, async t => {
  const f = await fixture(t, { mode });
  const body = structuredClone(wire[mode].request);
  if (mode === "unary") body.model = `models/${wire[mode].model}`;
  const response = await f.request(body, { manifest });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), wire[mode].response);
  await Promise.all(f.pending);
  assert.deepEqual(f.sent[0].body, body); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${wire[mode].model}:${contracts[mode][1]}`);
  assert.equal(f.sent[0].headers.get("x-goog-api-key"), "synthetic-google-key"); assert.equal(f.sent[0].headers.get("authorization"), null);
  assert.equal(f.sent[0].redirect, "manual");
  assert.equal(f.events.length, 1); assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].actualCostMicros, 17); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 17));
  assert.equal(f.events[0].actual_cost_micros, 17); assert.equal(f.events[0].cost_basis, "policy_fixed");
  assert.equal(f.events[0].input_tokens, wire[mode].response.usageMetadata?.promptTokenCount ?? null);
  assert.equal(f.events[0].output_tokens, null); assert.equal(bodyBudgetCharged(), 0);
});

test("Google native request errors cannot become paid egress or alter model selection", async t => {
  const f = await fixture(t);
  for (const body of [
    { ...wire.unary.request, model: "models/gemini-embedding-001" }, { ...wire.unary.request, taskType: "RETRIEVAL_QUERY" },
    { ...wire.unary.request, stream: true }, { ...wire.unary.request, apiKey: "synthetic" },
    { content: { parts: [{ fileData: { fileUri: "https://unbound.example/file" } }] } },
  ]) { const response = await f.request(body); assert.equal(response.status, 400); await response.text(); }
  for (const input of [{ query: "?key=synthetic" }, { model: "gemini-embedding-2-preview" }, { model: "gemini-embedding-3" }]) {
    const response = await f.request(wire.unary.request, input); assert.ok(response.status >= 400); await response.text();
  }
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

for (const options of [{ unpriced: true }, { models: ["google/gemini-embedding-001"] }, { origin: "https://unqualified.example" }]) test(`Google admission fails before egress: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options), response = await f.request();
  assert.ok(response.status >= 400); await response.text(); await Promise.all(f.pending);
  assert.equal(f.sent.length, 0); assert.ok(f.events.every(event => event.actual_cost_micros === 0));
});

test("Google invalid later batch vector publishes no successful prefix and retains the fixed charge", async t => {
  const invalid = structuredClone(wire.batch.response); invalid.embeddings[1].values.pop();
  const f = await fixture(t, { mode: "batch", fetch: () => Response.json(invalid) });
  const response = await f.request(); assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('"embeddings"'), false); await Promise.all(f.pending);
  assert.equal(f.events[0].input_tokens, null); assert.equal(f.events[0].actual_cost_micros, 17);
  assert.equal(f.events[0].status, "provider_error"); assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
});

for (const kind of ["malformed", "utf8", "mime", "redirect", "rejected", "oversize", "deadline", "eof"]) test(`Google ${kind} response cannot establish free work or replay`, async t => {
  let canceled = false;
  const f = await fixture(t, { timeout: 50, fetch: () => {
    const headers = { "content-type": "application/json" };
    if (kind === "malformed") return new Response('{"embedding":', { headers });
    if (kind === "utf8") return new Response(new Uint8Array([255]), { headers });
    if (kind === "mime") return new Response("{}", { headers: { "content-type": "text/html" } });
    if (kind === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
    if (kind === "rejected") return Response.json({ error: { code: 429 } }, { status: 429 });
    if (kind === "oversize") return new Response("{}", { headers: { ...headers, "content-length": String(16 * 1024 * 1024 + 1) } });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(JSON.stringify(wire.unary.response))); if (kind === "eof") controller.error(new Error("synthetic transport loss")); }, cancel() { canceled = true; } }), { headers });
  } });
  const response = await f.request(); assert.equal(response.status, 502); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events.length, 1); assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].actualCostMicros, 17); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 17)); assert.equal(f.events[0].actual_cost_micros, 17);
  assert.equal(f.events[0].input_tokens, null); assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
  if (kind === "deadline") { assert.equal(canceled, true); assert.equal(f.events[0].status, "timeout"); }
});

test("Google response capacity remains held through delivery cancellation", async t => {
  const f = await fixture(t), response = await f.request();
  assert.equal(response.status, 200); assert.ok(bodyBudgetCharged() > 0);
  await response.body.cancel("synthetic consumer cancellation"); await Promise.all(f.pending);
  assert.equal(bodyBudgetCharged(), 0); assert.equal(f.events[0].actual_cost_micros, 17); assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].actualCostMicros, 17); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 17));
});

test("Google response capacity contention denies before paid dispatch", async t => {
  const held = new BodyLease(); assert.equal(held.grow(32 * 1024 * 1024), true); t.after(() => held.release());
  const f = await fixture(t), response = await f.request();
  assert.equal(response.status, 503); await response.text(); await Promise.all(f.pending);
  assert.equal(f.sent.length, 0); assert.equal(f.events[0].actual_cost_micros, 0);
});

test("Google valid JSON prefix waits for complete EOF before publication", async t => {
  let stream, started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { fetch: () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(encoder.encode(JSON.stringify(wire.unary.response))); started();
  } }), { headers: { "content-type": "application/json" } }) });
  let published = false;
  const pending = f.request().then(response => { published = true; return response; });
  await dispatched; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(published, false); assert.equal(f.events.length, 0);
  stream.close(); const response = await pending; assert.deepEqual(await response.json(), wire.unary.response);
  await Promise.all(f.pending); assert.equal(f.events.length, 1); assert.equal(bodyBudgetCharged(), 0);
});

test("Google caller abort interrupts the original upstream reader and preserves one charge", async t => {
  let started, canceled = false;
  const dispatched = new Promise(resolve => { started = resolve; }), controller = new AbortController();
  const f = await fixture(t, { fetch: () => new Response(new ReadableStream({ start() { started(); }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }) });
  const pending = f.request(undefined, { signal: controller.signal }); await dispatched; controller.abort();
  const response = await pending; assert.equal(response.status, 502); await response.text(); await Promise.all(f.pending);
  assert.equal(canceled, true); assert.equal(f.events[0].status, "client_error");
  assert.equal(f.events[0].actual_cost_micros, 17); assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].actualCostMicros, 17); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 17)); assert.equal(bodyBudgetCharged(), 0);
});

test("Google validated large responses use only the codec's native token count", async t => {
  const body = { ...wire.unary.response, synthetic: "x".repeat(2 * 1024 * 1024), usageMetadata: {}, usage: { input_tokens: 999, output_tokens: 999 } };
  const f = await fixture(t, { fetch: () => Response.json(body) }), response = await f.request();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), body); await Promise.all(f.pending);
  assert.equal(f.events[0].input_tokens, null); assert.equal(f.events[0].output_tokens, null);
  assert.equal(f.events[0].actual_cost_micros, 17); assert.equal(bodyBudgetCharged(), 0);
});

test("Google batch foreign model and unauthenticated calls never dispatch", async t => {
  const f = await fixture(t, { mode: "batch" }), body = structuredClone(wire.batch.request);
  body.requests[1].model = "models/gemini-embedding-2";
  const invalid = await f.request(body); assert.equal(invalid.status, 400); await invalid.text();
  const unauthorized = await f.request(undefined, { auth: "Bearer synthetic-invalid" });
  assert.ok([401, 403].includes(unauthorized.status)); await unauthorized.text(); assert.equal(f.sent.length, 0);
});
