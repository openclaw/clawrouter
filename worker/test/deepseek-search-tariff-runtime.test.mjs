import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const { prepareNativeDeepSeekSearch } = await import("../native-deepseek-search.ts");
const { estimateCost, accountingReceipt } = await import("../proxy-accounting.ts");
const { selectRequestTariff } = await import("../request-tariff.ts");
const source = parse(readFileSync(new URL("../../providers/deepseek.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepseek/search.json", import.meta.url), "utf8"));
const pricing = { unit: "request", protocol: "deepseek.search", version: "deepseek-search-2026-11-01",
  effectiveAt: "2026-11-01T00:00:00+08:00", source: "https://api-docs.deepseek.com/guides/search/",
  successfulNonemptyRequestMicros: 750, emptyRequestMicros: 0 };
async function setup(t, options = {}) {
  const manifest = structuredClone(source);
  manifest.capabilities = manifest.capabilities.filter(item => item.id !== "search.web" || item.endpoint !== "search");
  manifest.capabilities.push({ id: "search.web", endpoint: "search", methods: ["POST"] });
  manifest.endpoints.search = { method: "POST", path: "/v1/tools/search", requestFormat: "deepseek.search", responseFormat: "deepseek.search" };
  const original = snapshot.providers;
  snapshot.providers = original.filter(provider => provider.id !== "deepseek").map(provider => provider.id === "replicate" ? structuredClone(provider) : provider);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { fixed: null, ...options, providerId: "deepseek", configure(provider) {
    Object.assign(provider, compileProviderSnapshot([manifest]).providers[0]);
  } });
  f.endpoint = f.provider.endpoints.find(endpoint => endpoint.id === "search");
  // Qualify common runtime independently. Source-owned compiler/YAML activation
  // remains closed; no schema assertion is weakened to manufacture this fixture.
  f.endpoint.requestPricing = structuredClone(pricing); f.endpoint.timeout_ms = options.timeout ?? 1000;
  f.env.DEEPSEEK_API_KEY = "synthetic-deepseek-environment";
  if (options.pooled) {
    f.policy.grantRouting = { eligibleGrants: { deepseek: ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.request = (body = structuredClone(wire.request.body), { manifest = false, ...extra } = {}) => f.call(
    manifest ? "/v1/proxy/deepseek/search" : "/v1/native/deepseek/v1/tools/search", manifest ? { body } : body,
    { ...extra, headers: { "x-api-key": "synthetic-caller-key", ...extra.headers } });
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = () => Response.json(wire.response); t.after(f.drain); return f;
}
async function event(f, actual, basis) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  const value = events[0]; assert.equal(value.actual_cost_micros, actual); assert.equal(value.cost_basis, basis);
  assert.equal(value.input_tokens, null); assert.equal(value.output_tokens, null); assert.equal(value.total_tokens, null);
  assert.equal(bodyBudgetCharged(), 0); return value;
}

for (const manifest of [false, true]) for (const pooled of [false, true]) for (const empty of [false, true]) {
  test(`DeepSeek tariff ${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"}/${empty ? "empty" : "nonempty"}`, async t => {
    const f = await setup(t, { pooled }), body = { ...wire.request.body, count: 10 }, reply = empty ? wire.empty : wire.response;
    f.upstream = async request => {
      assert.equal(request.url, "https://api.deepseek.com/v1/tools/search"); assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-deepseek-environment");
      assert.deepEqual(await request.json(), body);
      assert.equal(f.rows().length, 2); assert.ok(f.rows().every(row => row.reserved_micros === 750 && row.dispatch_started === 1));
      return Response.json(reply);
    };
    const response = await f.request(body, { manifest }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), reply);
    const receipt = await event(f, empty ? 0 : 750, "manifest_request");
    assert.equal(receipt.reserved_cost_micros, 750); assert.equal(receipt.pricing_ref, pricing.version);
    assert.equal(receipt.pricing_effective_at, pricing.effectiveAt); assert.equal(receipt.grant_key, pooled ? grantKey : null);
    assert.equal(f.sent.length, 1); assert.ok(f.rows().every(row => row.settled === 1));
  });
}

for (const kind of ["partial", "error-after-prefix", "rejection", "redirect", "length", "filtered", "later-row", "encoding", "fake-empty"]) {
  test("DeepSeek dispatched uncertainty retains the entire native fee: " + kind, async t => {
    const f = await setup(t);
    f.upstream = () => {
      if (kind === "partial") return new Response('{"results":[', { headers: { "content-type": "application/json" } });
      if (kind === "error-after-prefix") return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(wire.empty))); c.error(new Error("synthetic interruption"));
      } }), { headers: { "content-type": "application/json" } });
      if (kind === "rejection") return Response.json({ results: [], error: "synthetic private detail" }, { status: 422 });
      if (kind === "redirect") return new Response(null, { status: 307, headers: { location: "https://other.example" } });
      if (kind === "filtered") return Response.json(wire.filtered);
      if (kind === "later-row") return Response.json({ results: [wire.response.results[0], null] });
      if (kind === "fake-empty") return Response.json({ ...wire.empty, error: null, billableRequests: 0 });
      return Response.json(wire.empty, { headers: kind === "length" ? { "content-length": "99999" } : { "content-encoding": "gzip" } });
    };
    const response = await f.request(); const text = await response.text(); assert.equal(response.status, 502); assert.ok(!text.includes("synthetic private detail"));
    await event(f, 750, "manifest_request_reservation"); assert.equal(f.sent.length, 1);
    assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 750));
  });
}

for (const kind of ["caller", "deadline"]) test("DeepSeek interrupted native EOF retains reserve: " + kind, async t => {
  const f = await setup(t, { timeout: kind === "deadline" ? 20 : 1000 }), caller = new AbortController(); let canceled = 0, emitted = false;
  f.upstream = () => new Response(new ReadableStream({ pull(c) {
    if (!emitted) { emitted = true; c.enqueue(new TextEncoder().encode(JSON.stringify(wire.empty))); if (kind === "caller") caller.abort(); }
  }, cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const response = await f.request(wire.request.body, { signal: caller.signal }); await response.text(); assert.equal(response.status, 502);
  const receipt = await event(f, 750, "manifest_request_reservation");
  assert.equal(receipt.status, kind === "caller" ? "client_error" : "timeout"); assert.equal(canceled, 1); assert.equal(f.sent.length, 1);
});

for (const fixed of [0, 17]) test("DeepSeek explicit fixed policy remains separate from native tariff: " + fixed, async t => {
  const f = await setup(t, { fixed }); f.upstream = () => Response.json(wire.empty);
  const response = await f.request(); await response.json(); assert.equal(response.status, 200);
  const receipt = await event(f, fixed, "policy_fixed"); assert.equal(receipt.pricing_ref, null); assert.equal(f.sent.length, 1);
});

for (const bound of ["caller", "provider", "daily", "weekly"]) test("DeepSeek 749-micro budget denies before dispatch: " + bound, async t => {
  const f = await setup(t); f.policy.monthlyBudgetMicros = bound === "caller" ? 749 : 10000;
  if (bound === "daily") f.policy.dailyBudgetMicros = 749;
  if (bound === "weekly") f.policy.weeklyBudgetMicros = 749;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await f.authority("/connections/put", { providerId: "deepseek", enabled: true, monthlyBudgetMicros: bound === "provider" ? 749 : 10000 });
  const catalog = await (await f.call("/v1/catalog", null)).json();
  const offers = catalog.providers.find(provider => provider.id === "deepseek").offers.filter(offer => offer.endpoint === "search");
  assert.ok(offers.length); assert.ok(offers.every(offer => !offer.eligible));
  const response = await f.request(); await response.text(); assert.equal(response.status, 402); await f.drain();
  assert.equal(f.sent.length, 0); assert.ok((await f.events()).every(value => value.actual_cost_micros === 0));
});

test("DeepSeek tariff and billing version freeze before dispatch; upstream billing fields confer no authority", async t => {
  const f = await setup(t);
  f.upstream = () => {
    f.endpoint.requestPricing.version = "mutated"; f.endpoint.requestPricing.successfulNonemptyRequestMicros = 0;
    return Response.json({ ...wire.response, billableRequests: 0, pricingVersion: "mutated", cost: 0, usage: { total_tokens: 999 } });
  };
  const response = await f.request(); await response.json(); assert.equal(response.status, 200);
  const receipt = await event(f, 750, "manifest_request"); assert.equal(receipt.pricing_ref, pricing.version); assert.equal(f.sent.length, 1);
});

for (const kind of ["source", "rate", "version", "origin", "caller-counter"]) test("DeepSeek unqualified tariff/request remains zero-egress: " + kind, async t => {
  const f = await setup(t), body = structuredClone(wire.request.body);
  if (kind === "source") f.endpoint.requestPricing.source = "https://example.com/rate";
  if (kind === "rate") f.endpoint.requestPricing.successfulNonemptyRequestMicros = 0;
  if (kind === "version") f.endpoint.requestPricing.version = "";
  if (kind === "origin") f.provider.base_urls.default = "https://other.example";
  if (kind === "caller-counter") body.billableRequests = 0;
  const response = await f.request(body); await response.text(); assert.ok(response.status >= 400); await f.drain();
  assert.equal(f.sent.length, 0); assert.ok((await f.events()).every(value => value.actual_cost_micros === 0));
});

test("DeepSeek capacity refusal settles only known-unsent work at zero", async t => {
  const f = await setup(t), lease = new BodyLease(); assert.equal(lease.grow(bodyBudgetBytes / 2), true);
  t.after(() => lease.release()); const response = await f.request(); await response.text(); assert.equal(response.status, 503);
  lease.release(); await event(f, 0, "none"); assert.equal(f.sent.length, 0);
});

test("DeepSeek original grant revocation cannot borrow a priced environment request", async t => {
  const f = await setup(t, { pooled: true }); await revokeGrantCredentials(f.env, grantKey);
  const response = await f.request(); await response.text(); assert.equal(response.status, 503); await f.drain(); assert.equal(f.sent.length, 0);
});

test("DeepSeek native producer binds only complete codec observation to admitted version", async t => {
  const f = await setup(t), selected = { provider: f.provider, endpoint: f.endpoint, model: null, capability: "search.web", method: "POST", pathParams: {}, body: wire.request.body };
  const native = prepareNativeDeepSeekSearch(selected), frozen = native.tariff;
  assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(frozen.pricing));
  f.endpoint.requestPricing.version = "changed";
  for (const [body, count, cost] of [[wire.empty, 0, 0], [wire.response, 1, 750]]) {
    const result = await native.read(Response.json(body), new AbortController().signal); await result.response.arrayBuffer();
    assert.deepEqual(result.usage.nativeRequestUsage, { operation: "deepseek.search", pricingVersion: pricing.version, billableRequests: count });
    assert.deepEqual(result.usage.requestCostReceipt, { costMicros: cost, basis: "manifest_request", pricingVersion: pricing.version });
  }
  const cost = estimateCost(null, wire.request.body, null, "search.web", f.endpoint, undefined, frozen);
  const facts = { event: {}, model: null, fixed: null, cost, requestFormat: "deepseek.search", startedAtMs: 0 };
  for (const requestTariffOutcome of ["failed", "unknown", "succeeded"]) {
    const result = accountingReceipt(facts, { occurredAtMs: 1, statusCode: 422, status: "provider_error", billable: false,
      tokens: null, reservation: { reservedMicros: 750 }, contentRef: null, requestTariffOutcome });
    assert.equal(result.actual_cost_micros, 750); assert.equal(result.cost_basis, "manifest_request_reservation");
  }
  assert.throws(() => selectRequestTariff({ ...f.endpoint, request_format: "perplexity.search" }, wire.request.body));
});
