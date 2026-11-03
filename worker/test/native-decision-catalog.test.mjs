import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot, routeCatalog } = await import("../providers.ts");
const { BASETEN_SYSTEMONE_MODELS } = await import("../provider-baseten-systemone.ts");
const { systemOneDecision } = await import("./native-decision-catalog-fixture.ts");
const { basetenSystemOneRequest } = await import("./baseten-systemone-fixtures.ts");
const source = parse(readFileSync(new URL("../../providers/baseten.provider.yaml", import.meta.url), "utf8"));
const ids = BASETEN_SYSTEMONE_MODELS.map(upstream => `baseten/${upstream}`);

async function setup(t, { pooled = false, fixed = 700, native = true } = {}) {
  const original = snapshot.providers;
  snapshot.providers = original.filter(provider => provider.id !== "baseten");
  t.after(() => { snapshot.providers = original; });
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "llm.decisions", endpoint: "systemone", methods: ["POST"] });
  manifest.endpoints.systemone = { path: "/systemone", requestFormat: "baseten.systemone", responseFormat: "baseten.systemone" };
  manifest.models.entries.push(...BASETEN_SYSTEMONE_MODELS.map(upstream => ({ id: `baseten/${upstream}`, upstream, capabilities: ["llm.decisions"],
    nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: { systemone: {
      sources: ["https://docs.baseten.co/reference/inference-api/system-one"], checkedAt: "2026-11-03",
      input: ["text", "json"], inference: { chat: false, decision: structuredClone(systemOneDecision) },
    } } } })));
  const f = await fixture(t, { providerId: "baseten", pooled, fixed, configure(provider) {
    Object.assign(provider, compileProviderSnapshot([manifest]).providers[0]);
    provider.endpoints.find(endpoint => endpoint.id === "systemone").native_proxy = native;
  } });
  f.env.BASETEN_API_KEY = "synthetic-baseten-environment";
  f.upstream = () => { throw new Error("catalog and unsupported unified routes must not dispatch"); };
  t.after(f.drain); return f;
}

for (const pooled of [false, true]) for (const native of [false, true]) {
  test(`SystemOne ${pooled ? "pooled" : "environment"} ${native ? "native" : "manifest"} catalog preserves exact metadata without OpenAI decision offers`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled, native }), response = await f.call("/v1/catalog", null);
    assert.equal(response.status, 200, await response.clone().text());
    const catalog = await response.json(), provider = catalog.providers.find(provider => provider.id === "baseten");
    for (const id of ids) {
      const model = provider.models.find(model => model.id === id), facts = model.nativeCapabilities.endpoints.systemone;
      assert.deepEqual(facts.inference.decision, systemOneDecision); assert.equal(facts.inference.chat, false);
      assert.equal(model.upstream, id.slice("baseten/".length)); assert.equal(model.pricing, null);
      for (const field of ["contextWindow", "contextTokens", "maxOutputTokens"]) assert.equal(Object.hasOwn(facts, field), false);
      const offers = provider.offers.filter(offer => offer.modelId === id);
      assert.equal(offers.length, 1); assert.equal(offers[0].eligible, true);
      assert.equal(offers[0].routeKind, native ? "native" : "manifest");
      assert.equal(offers[0].route, native ? "/v1/native/baseten/systemone" : "/v1/proxy/baseten/systemone");
    }
    assert.ok(provider.offers.every(offer => offer.route !== "/v1/decisions"));
    const legacy = routeCatalog().openaiCompatible.find(provider => provider.provider === "baseten");
    assert.ok(!legacy.endpoints.includes("/v1/decisions")); assert.ok(legacy.models.every(model => !ids.includes(model.id)));
    assert.ok(legacy.endpoints.includes("/v1/chat/completions"));
    assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 2);
    assert.ok(f.budgetCalls.every(call => call.path === "/status"));
    for (const { name } of f.budgetCalls) assert.deepEqual(f.budgets.get(name).reservations(), []);
    assert.doesNotMatch(JSON.stringify(catalog), /synthetic-baseten-environment|synthetic-original-key/);
  });
}

test("all three native SystemOne identities reject unified Decisions and Chat before reservation or egress", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const model of ids) for (const path of ["/v1/decisions", "/v1/chat/completions"]) {
    const response = await f.call(path, { ...basetenSystemOneRequest, model });
    const body = await response.json(); assert.equal(response.status, 400); assert.equal(body.error.code, "model_capability_unsupported");
  }
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

test("observed question-token metadata never supplies an upstream-dollar tariff", { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null }), response = await f.call("/v1/catalog", null);
  assert.equal(response.status, 200, await response.clone().text());
  const provider = (await response.json()).providers.find(provider => provider.id === "baseten");
  const offers = provider.offers.filter(offer => ids.includes(offer.modelId));
  assert.equal(offers.length, 3);
  assert.ok(offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required"));
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 2);
    assert.ok(f.budgetCalls.every(call => call.path === "/status"));
    for (const { name } of f.budgetCalls) assert.deepEqual(f.budgets.get(name).reservations(), []);
});
