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
const { selectRequestTariff } = await import("../request-tariff.ts");
const { accountingReceipt } = await import("../proxy-accounting.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/images.json", import.meta.url), "utf8"));
const tariff = {
  unit: "image", protocol: "xai.images", version: "xai-images-2026-11-03", effectiveAt: "2026-11-03",
  source: "https://docs.x.ai/developers/pricing", receipt: "xai.usage.cost_in_usd_ticks",
  alias: { selectedModel: "grok-imagine-image-quality", servingModel: "grok-imagine-image-2.0", quality: "low",
    effectiveAt: "2026-11-02", source: "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2" },
  rates: {
    "grok-imagine-image": { inputMicrosPerImage: 2000, outputMicrosPerImage: { "1k": 20000, "2k": 20000 } },
    "grok-imagine-image-2.0": { inputMicrosPerImage: 10000, outputMicrosPerImage: { low: { "1k": 40000, "2k": 60000 }, medium: { "1k": 60000, "2k": 80000 } } },
  },
};
const result = (body, ticks = 12345) => ({ model: body.model === "grok-imagine-image-quality" ? "grok-imagine-image-2.0" : body.model,
  data: Array.from({ length: body.n }, () => ({ b64_json: "AP+A" })), usage: { cost_in_usd_ticks: ticks } });

async function fixture(t, options = {}) {
  const original = snapshot.providers, provider = structuredClone(original.find(row => row.id === "xai"));
  provider.endpoints = ["generations", "edits"].map(operation => {
    const endpoint = { ...provider.endpoints[0], id: `images_${operation}`, path: `/v1/images/${operation}`, request_format: `xai.images_${operation}`,
      response_format: "xai.images", streaming: null, timeout_ms: options.timeout ?? 1000, requestPricing: structuredClone(tariff) };
    delete endpoint.modelPassthrough; if (options.unpriced) delete endpoint.requestPricing; return endpoint;
  });
  provider.capabilities = provider.endpoints.map(endpoint => ({ id: "image.generate", endpoint: endpoint.id, methods: ["POST"] }));
  provider.models = ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"].map(upstream => ({ id: `xai/${upstream}`, upstream, aliases: [], capabilities: ["image.generate"], pricing: null, pricing_ref: null }));
  if (options.origin) provider.base_urls.default = options.origin;
  snapshot.providers = original.map(row => row.id === provider.id ? provider : row); t.after(() => { snapshot.providers = original; });
  const policy = { enabled: true, generation: "v1", providers: ["xai"], models: options.models ?? null, tenantId: "fixture", monthlyBudgetMicros: options.limit ?? 1000000,
    requestCostMicros: options.fixed ?? null, ...(options.soft ? { budgetMode: "soft" } : {}), retainRequestContent: false };
  const values = new Map(), events = [], pending = [], sent = [], settlements = [], charges = [], names = new Set(), budgets = sqlBudgetNamespace(t);
  let releaseSoft;
  const softStatus = options.soft ? new Promise(resolve => { releaseSoft = resolve; }) : null;
  const env = { XAI_API_KEY: "synthetic-original-image-key", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { values.set(key, JSON.parse(value)); }, async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => events.push(event) }, BUDGET_LEDGER: {
    idFromName: name => name, get(name) { names.add(name); return { fetch(url, init) {
      const path = new URL(url).pathname;
      if (options.soft && path === "/status") return softStatus;
      if (path === "/settle") settlements.push(JSON.parse(init.body));
      if (path === "/charge") charges.push(JSON.parse(init.body));
      return budgets.get(name).fetch(url, init);
    } }; },
  } };
  const authority = createGrantAuthority(undefined, env); env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "image", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "image", credential: { enabled: true,
    secretSha256: await sha256Hex("synthetic-image"), policyId: "image", policyGeneration: "v1" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "xai", enabled: true }]);
  const rows = () => [...names].flatMap(name => budgets.get(name).reservations());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = await new Response(init.body).json();
    sent.push({ url: String(url), headers: new Headers(init.headers), body, redirect: init.redirect });
    if (!options.soft) assert.ok(rows().some(row => row.reserved_micros === (options.fixed ?? options.reserve ?? 40000)), "selected image tariff precedes paid dispatch");
    assert.ok(bodyBudgetCharged() >= 80 * 1024 * 1024, "response capacity precedes dispatch");
    options.dispatched?.(provider);
    if (options.soft) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(result(body)))); },
      pull(controller) { controller.close(); setTimeout(() => releaseSoft(Response.json({ spentMicros: policy.monthlyBudgetMicros })), 0); },
    }), { headers: { "content-type": "application/json" } });
    return options.fetch ? options.fetch(body, init) : Response.json(result(body, options.ticks ?? 12345));
  });
  const headers = { authorization: "Bearer clawrouter-live-image-synthetic-image", "content-type": "application/json" };
  const request = (body = wire.generate, { mode = "generate", manifest = false, query = "", signal } = {}) => {
    const operation = mode === "generate" ? "generations" : "edits";
    return worker.fetch(new Request((manifest ? `https://router.example/v1/proxy/xai/images_${operation}` : `https://router.example/v1/native/xai/v1/images/${operation}`) + query, {
      method: "POST", headers, signal, body: JSON.stringify(manifest ? { body: { ...body, model: `xai/${body.model}` } } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
  };
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, settlements, charges, rows, provider,
    catalog: () => worker.fetch(new Request("https://router.example/v1/catalog", { headers }), env, { waitUntil: promise => pending.push(promise) }) };
}

for (const [mode, extra, reserve] of [
  ["generate", {}, 40000], ["edit", {}, 50000],
  ["generate", { model: "grok-imagine-image-2.0" }, 60000], ["edit", { model: "grok-imagine-image-2.0" }, 70000],
  ["generate", { model: "grok-imagine-image" }, 20000], ["edit", { n: 4, resolution: "2k" }, 280000],
]) for (const manifest of [false, true]) test(`native image ${mode} ${JSON.stringify(extra)} ${manifest ? "manifest" : "native"} reserves and settles the whole bill once`, async t => {
  const f = await fixture(t, { reserve }), body = { ...wire[mode], ...extra }, response = await f.request(body, { mode, manifest });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result(body)); await Promise.all(f.pending);
  assert.deepEqual(f.sent[0].body, body); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-image-key");
  assert.equal(f.sent[0].url, `https://api.x.ai/v1/images/${mode === "generate" ? "generations" : "edits"}`); assert.equal(f.sent[0].redirect, "manual");
  assert.equal(f.events.length, 1); const event = f.events[0];
  assert.equal(event.model, `xai/${body.model}`); assert.equal(event.reserved_cost_micros, reserve);
  assert.equal(event.actual_cost_micros, 2); assert.equal(event.cost_basis, "provider_reported"); assert.equal(event.pricing_ref, tariff.version);
  assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
  assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].actualCostMicros, 2); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 2));
  assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
});

test("native image edit multiplicity and auto quality use the validated source projection", async t => {
  const f = await fixture(t, { reserve: 440000 }), body = { ...wire.edit, model: "grok-imagine-image-2.0", n: 4, resolution: "2k", images: [wire.edit.image, wire.edit.image, wire.edit.image] };
  delete body.image; const response = await f.request(body, { mode: "edit" }); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].reserved_cost_micros, 440000); assert.equal(f.events[0].actual_cost_micros, 2);
});

for (const ticks of [0, 10000000000]) test(`native image whole receipt ${ticks} is neither added to nor clamped by the reserve`, async t => {
  const f = await fixture(t, { ticks }), response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, ticks / 10000); assert.equal(f.events[0].cost_basis, "provider_reported");
});

for (const usage of [{}, { cost_in_usd_ticks: "0" }, { cost_in_usd_ticks: -1 }, { cost_in_usd_ticks: 0.5 }]) test(`native image missing/unsafe receipt ${JSON.stringify(usage)} retains its original reserve`, async t => {
  const f = await fixture(t, { fetch: body => Response.json({ ...result(body), usage }) }), response = await f.request();
  assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, 40000); assert.equal(f.events[0].cost_basis, "manifest_request_reservation");
});

for (const receipt of [true, false]) test(`native image malformed media cannot publish and ${receipt ? "preserves its complete bill" : "retains the reserve"}`, async t => {
  const f = await fixture(t, { fetch: body => Response.json({ ...result(body), data: [{ url: "https://unqualified.example/image" }], usage: receipt ? { cost_in_usd_ticks: 12345 } : {} }) });
  const response = await f.request(); assert.equal(response.status, 502); assert.equal((await response.text()).includes("unqualified.example"), false); await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, receipt ? 2 : 40000); assert.equal(f.events[0].status, "provider_error"); assert.equal(f.sent.length, 1);
});

for (const kind of ["foreign-model", "error", "pending", "partial", "utf8", "redirect", "http-error", "deadline"]) test(`native image ${kind} remains conservative without replay`, async t => {
  let canceled = false;
  const f = await fixture(t, { timeout: 50, fetch: body => {
    const value = result(body), headers = { "content-type": "application/json" };
    if (kind === "foreign-model") return Response.json({ ...value, model: body.model });
    if (kind === "error") return Response.json({ ...value, error: { message: "synthetic refusal" } });
    if (kind === "pending") return Response.json({ ...value, status: "pending" });
    if (kind === "partial") return new Response(JSON.stringify(value).slice(0, -1), { headers });
    if (kind === "utf8") return new Response(new Uint8Array([255]), { headers });
    if (kind === "redirect") return new Response(null, { status: 307, headers: { location: "https://unqualified.example" } });
    if (kind === "http-error") return Response.json(value, { status: 403 });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(value))); }, cancel() { canceled = true; } }), { headers });
  } });
  const response = await f.request(); assert.equal(response.status, 502); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, 40000); assert.equal(f.events[0].cost_basis, "manifest_request_reservation");
  assert.equal(f.settlements.length, 1); assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
  if (kind === "deadline") assert.equal(canceled, true);
});

test("native image selection rejects tools, tiers, unqualified media and malformed counts before egress", async t => {
  const f = await fixture(t);
  for (const extra of [{ tools: [{ type: "web_search" }] }, { service_tier: "priority" }, { n: 5 }, { image: wire.edit.image }, { quality: "medium" }, { stream: true }, { api_key: "synthetic" }]) {
    const response = await f.request({ ...wire.generate, ...extra }); assert.equal(response.status, 400); await response.text();
  }
  const query = await f.request(wire.generate, { query: "?deferred=true" }); assert.equal(query.status, 400); await query.text(); assert.equal(f.sent.length, 0);
});

for (const options of [{ unpriced: true }, { limit: 39999 }, { origin: "https://us-east-1.api.x.ai" }, { models: ["xai/grok-imagine-image"] }]) test(`native image denied admission ${JSON.stringify(options)} has no paid egress`, async t => {
  const f = await fixture(t, options), response = await f.request(); assert.ok(response.status >= 400); await response.text(); await Promise.all(f.pending);
  assert.equal(f.sent.length, 0); assert.ok(f.events.every(event => event.actual_cost_micros === 0));
});

test("native image tariff snapshot survives source-table mutation and event serialization", async t => {
  const f = await fixture(t, { dispatched(provider) { for (const endpoint of provider.endpoints) { endpoint.requestPricing.version = "changed"; endpoint.requestPricing.rates["grok-imagine-image-2.0"].outputMicrosPerImage.low["1k"] = 999999; } } });
  const response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].pricing_ref, tariff.version); assert.equal(f.events[0].reserved_cost_micros, 40000); assert.equal(f.events[0].actual_cost_micros, 2);
  const endpoint = { ...f.provider.endpoints[0], requestPricing: structuredClone(tariff) }, selected = selectRequestTariff(endpoint, wire.generate);
  const facts = JSON.parse(JSON.stringify({ event: f.events[0], model: null, fixed: null, cost: { reserveMicros: 40000, basis: "manifest_request", requestTariff: selected }, requestFormat: endpoint.request_format, startedAtMs: 0 }));
  const outcome = { occurredAtMs: 1, statusCode: 502, status: "provider_error", billable: false, tokens: null, reservation: { reservedMicros: 40000 }, contentRef: null };
  assert.equal(accountingReceipt(facts, outcome).actual_cost_micros, 40000);
  assert.equal(accountingReceipt(facts, { ...outcome, requestTariffOutcome: "unsent" }).actual_cost_micros, 0);
  assert.equal(accountingReceipt(facts, { ...outcome, requestCostReceipt: { costMicros: 0, basis: "provider_reported", pricingVersion: "foreign" } }).actual_cost_micros, 40000);
});

test("native image cancellation after complete original receipt releases capacity and charges once", async t => {
  const f = await fixture(t), response = await f.request(); assert.equal(response.status, 200); assert.ok(bodyBudgetCharged() > 0);
  await response.body.cancel(); await Promise.all(f.pending); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(f.events[0].actual_cost_micros, 2); assert.equal(f.settlements.length, 1);
});

test("native image late soft denial settles the complete original receipt on its original charge intent", async t => {
  const f = await fixture(t, { soft: true }), response = await f.request(); assert.equal(response.status, 402); await response.text(); await Promise.all(f.pending);
  assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 2);
  assert.equal(f.events[0].cost_basis, "provider_reported"); assert.equal(f.charges.length, 1); assert.equal(f.charges[0].amountMicros, 2);
});

for (const fixed of [0, 17]) test(`native image explicit policy-fixed ${fixed} stays distinct even on invalid media`, async t => {
  const f = await fixture(t, { fixed, fetch: body => Response.json({ ...result(body), data: [] }) }), response = await f.request();
  assert.equal(response.status, 502); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, fixed); assert.equal(f.events[0].cost_basis, "policy_fixed");
});

test("native image catalog retains actual image tariff and request-dependent affordability", async t => {
  const f = await fixture(t), response = await f.catalog(); assert.equal(response.status, 200);
  const catalog = await response.json(), provider = catalog.providers.find(row => row.id === "xai");
  assert.ok(provider.offers.length >= 6);
  for (const offer of provider.offers) { assert.deepEqual(offer.requestPricing, tariff); assert.equal(offer.affordability, "request-dependent"); }
  assert.equal(f.sent.length, 0);
});

test("native image token-shaped extension fields cannot create token charges", async t => {
  const f = await fixture(t, { fetch: body => Response.json({ ...result(body), usage: { cost_in_usd_ticks: 12345, input_tokens: 900, output_tokens: 900 } }) });
  const response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(f.events[0].actual_cost_micros, 2); assert.equal(f.events[0].input_tokens, null); assert.equal(f.events[0].output_tokens, null);
});
