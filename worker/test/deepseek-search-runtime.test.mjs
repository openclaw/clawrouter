import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const source = parse(readFileSync(new URL("../../providers/deepseek.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepseek/search.json", import.meta.url), "utf8"));
const nativePath = "/v1/native/deepseek/v1/tools/search", manifestPath = "/v1/proxy/deepseek/search";
async function setup(t, options = {}) {
  const manifest = structuredClone(source);
  manifest.capabilities = manifest.capabilities.filter(item => item.id !== "search.web" || item.endpoint !== "search");
  manifest.capabilities.push({ id: "search.web", endpoint: "search", methods: ["POST"] });
  manifest.endpoints.search = { method: "POST", path: "/v1/tools/search", requestFormat: "deepseek.search", responseFormat: "deepseek.search" };
  // Compiled projections are immutable and keyed by provider object identity.
  const original = snapshot.providers; snapshot.providers = original.filter(provider => provider.id !== "deepseek")
    .map(provider => provider.id === "replicate" ? structuredClone(provider) : provider);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: "deepseek", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([manifest]).providers[0]);
  } });
  f.endpoint = f.provider.endpoints.find(endpoint => endpoint.id === "search"); f.endpoint.timeout_ms = options.timeout ?? 1000;
  f.env.DEEPSEEK_API_KEY = "synthetic-deepseek-environment";
  if (options.pooled) {
    f.policy.grantRouting = { eligibleGrants: { deepseek: ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.request = (body = structuredClone(wire.request.body), { manifest = false, query = "", ...extra } = {}) => f.call(
    (manifest ? manifestPath : nativePath) + query, manifest ? { body } : body,
    { ...extra, headers: { "x-api-key": "synthetic-caller-key", ...extra.headers } });
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = () => Response.json(wire.response); t.after(f.drain); return f;
}

for (const manifest of [false, true]) for (const pooled of [false, true]) for (const empty of [false, true]) {
  test(`DeepSeek model-less ${manifest ? "manifest" : "native"} ${pooled ? "grant" : "environment"} ${empty ? "empty" : "results"} dispatch`, async t => {
    const f = await setup(t, { pooled }), body = { ...wire.request.body, count: 10 }, reply = empty ? wire.empty : wire.response;
    f.upstream = async request => {
      assert.equal(request.url, "https://api.deepseek.com/v1/tools/search"); assert.equal(request.method, "POST"); assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-deepseek-environment");
      assert.equal(request.headers.has("x-api-key"), false); assert.deepEqual(await request.json(), body);
      assert.equal(bodyBudgetCharged(), 16 * 1024 * 1024); assert.equal(f.rows().length, 2); assert.ok(f.rows().every(row => row.dispatch_started === 1));
      return Response.json(reply);
    };
    const response = await f.request(body, { manifest }); const result = await response.json(); assert.equal(response.status, 200); assert.deepEqual(result, reply);
    await f.drain(); assert.equal(f.sent.length, 1, "result and icon URLs are never fetched"); assert.equal(bodyBudgetCharged(), 0);
    const events = await f.events(); assert.equal(events.length, 1); const event = events[0];
    assert.equal(event.model, null); assert.equal(event.capability, "search.web"); assert.equal(event.total_tokens, null); assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
    assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.pricing_ref, null);
    assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 700));
  });
}

for (const bound of ["caller", "provider", "daily", "weekly"]) test("DeepSeek unknown request fee denies hard " + bound + " admission and catalog", async t => {
  const f = await setup(t, { fixed: null });
  f.policy.monthlyBudgetMicros = bound === "caller" ? 10000 : null;
  if (bound === "daily") f.policy.dailyBudgetMicros = 10000;
  if (bound === "weekly") f.policy.weeklyBudgetMicros = 10000;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await f.authority("/connections/put", { providerId: "deepseek", enabled: true, monthlyBudgetMicros: bound === "provider" ? 10000 : null });
  const cost = estimateCost(null, wire.request.body, null, "search.web", f.endpoint);
  assert.equal(cost.pricingGap, "model_request_fee"); assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.inputTokens, null); assert.equal(cost.requestTariff, undefined);
  const response = await f.request(); const error = await response.json(); assert.equal(response.status, 400); assert.equal(error.error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0); assert.equal(f.rows().length, 0);
  const catalog = await f.call("/v1/catalog", null); const data = await catalog.json(); assert.equal(catalog.status, 200);
  const offers = data.providers.find(provider => provider.id === "deepseek").offers.filter(offer => offer.endpoint === "search");
  assert.ok(offers.length > 0); assert.ok(offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required" && offer.modelId === null));
});

test("DeepSeek explicit zero policy fee stays policy-fixed, not a native free-search claim", async t => {
  const f = await setup(t, { fixed: 0 });
  const response = await f.request(); await response.json(); assert.equal(response.status, 200); await f.drain();
  const [event] = await f.events(); assert.equal(event.actual_cost_micros, 0); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.total_tokens, null);
  assert.equal(f.sent.length, 1);
});

test("DeepSeek unmetered empty results retain unknown upstream fee without a Chat fallback", async t => {
  const f = await setup(t, { fixed: null }); f.policy.monthlyBudgetMicros = null;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await f.authority("/connections/put", { providerId: "deepseek", enabled: true, monthlyBudgetMicros: null });
  f.upstream = () => Response.json(wire.empty);
  const response = await f.request(); await response.json(); assert.equal(response.status, 200); await f.drain();
  const [event] = await f.events(); assert.equal(event.cost_basis, "unpriced_usage"); assert.equal(event.total_tokens, null); assert.equal(event.pricing_ref, null);
  assert.equal(event.actual_cost_micros, 0, "numeric unknown-storage value does not establish a free upstream request"); assert.equal(f.sent.length, 1);
});

for (const manifest of [false, true]) test("DeepSeek scoped catalog separates native Search from priced Chat: " + manifest, async t => {
  const f = await setup(t); f.endpoint.native_proxy = !manifest;
  const response = await f.call("/v1/catalog", null); const data = await response.json(); assert.equal(response.status, 200);
  const provider = data.providers.find(provider => provider.id === "deepseek"), offers = provider.offers.filter(offer => offer.endpoint === "search");
  assert.ok(offers.length > 0); assert.ok(offers.every(offer => offer.modelId === null && offer.eligible));
  assert.ok(offers.every(offer => offer.routeKind === (manifest ? "manifest" : "native") && offer.route === (manifest ? manifestPath : nativePath)));
  const route = provider.routes.find(route => route.endpoint === "search"); assert.equal(route.requestFormat, "deepseek.search"); assert.equal(route.responseFormat, "deepseek.search");
  assert.ok(provider.models.every(model => !model.capabilities.includes("search.web"))); assert.equal(f.sent.length, 0);
});

for (const kind of ["missing-count", "missing-content", "model", "stream", "query", "extra", "foreign-origin", "unauthenticated"]) {
  test("DeepSeek invalid native selection stays zero-egress: " + kind, async t => {
    const f = await setup(t), body = structuredClone(wire.request.body), options = {};
    if (kind === "missing-count") delete body.count;
    if (kind === "missing-content") delete body.need_content;
    if (kind === "model") body.model = f.provider.models[0].upstream;
    if (kind === "stream") body.stream = true;
    if (kind === "query") options.query = "?count=1";
    if (kind === "extra") body.api_key = "synthetic-unselected";
    if (kind === "foreign-origin") f.provider.base_urls.default = "https://foreign.example";
    if (kind === "unauthenticated") options.headers = { authorization: "Bearer invalid" };
    const response = await f.request(body, options); await response.text(); assert.equal(response.status, kind === "unauthenticated" ? 401 : 400);
    await f.drain(); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0); assert.ok(f.rows().every(row => row.reserved_micros === 0));
  });
}

test("DeepSeek original grant revocation never falls back to the environment", async t => {
  const f = await setup(t, { pooled: true });
  const first = await f.request(); await first.json(); assert.equal(first.status, 200); await f.drain();
  await revokeGrantCredentials(f.env, grantKey);
  const denied = await f.request(); await denied.text(); assert.equal(denied.status, 503); assert.equal(f.sent.length, 1);
});

for (const kind of ["redirect", "rejection", "partial", "over-count", "filtered", "length", "invalid-utf8", "compression"]) {
  test("DeepSeek dispatched " + kind + " retains one conservative settlement", async t => {
    const f = await setup(t);
    f.upstream = () => {
      if (kind === "redirect") return new Response(null, { status: 307, headers: { location: "https://foreign.example" } });
      if (kind === "rejection") return Response.json({ error: "synthetic-private-error" }, { status: 422 });
      if (kind === "partial") return new Response('{"results":[', { headers: { "content-type": "application/json" } });
      if (kind === "over-count") return Response.json({ results: Array.from({ length: 6 }, () => wire.response.results[0]) });
      if (kind === "filtered") return Response.json(wire.filtered);
      if (kind === "invalid-utf8") return new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } });
      return Response.json(wire.response, { headers: kind === "length" ? { "content-length": "99999" } : { "content-encoding": "gzip" } });
    };
    const response = await f.request(); const text = await response.text(); assert.equal(response.status, 502); assert.ok(!text.includes("synthetic-private-error"));
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].total_tokens, null); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 700));
  });
}

for (const cause of ["caller", "deadline"]) test("DeepSeek " + cause + " cancels bounded response and retains dispatched cost", async t => {
  const f = await setup(t, { timeout: cause === "deadline" ? 20 : 1000 }), caller = new AbortController(); let canceled = 0;
  f.upstream = () => new Response(new ReadableStream({ pull() { if (cause === "caller") caller.abort(); }, cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const response = await f.request(wire.request.body, { signal: caller.signal }); const body = await response.json(); assert.equal(response.status, 502); assert.equal(body.error.code, "provider_unavailable");
  await f.drain(); assert.equal(canceled, 1); assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(events[0].status, cause === "caller" ? "client_error" : "timeout");
  assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 700));
});

test("DeepSeek capacity denial stays known-unsent", async t => {
  const f = await setup(t), occupied = new BodyLease(); assert.equal(occupied.grow(bodyBudgetBytes / 2), true); t.after(() => occupied.release());
  const response = await f.request(); await response.text(); assert.equal(response.status, 503); await f.drain();
  assert.equal(f.sent.length, 0); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 0));
});

test("DeepSeek dispatch acknowledgment denial stays known-unsent", async t => {
  const f = await setup(t), get = f.env.BUDGET_LEDGER.get.bind(f.env.BUDGET_LEDGER); let denied = 0;
  f.env.BUDGET_LEDGER.get = name => { const stub = get(name); return { async fetch(url, init) {
    if (new URL(url).pathname === "/dispatch") { denied++; return Response.json({ dispatched: false }); }
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname !== "/reserve") return response;
    const receipt = await response.json(); delete receipt.dispatched; return Response.json(receipt, { status: response.status });
  } }; };
  const response = await f.request(); await response.text(); assert.equal(response.status, 503); await f.drain();
  assert.equal(f.sent.length, 0); assert.equal(denied, 2); assert.equal(bodyBudgetCharged(), 0); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 0));
});
