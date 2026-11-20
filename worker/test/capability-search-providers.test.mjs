import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const ids = ["brave", "exa", "parallel"];
const compiled = compileProviderSnapshot(ids.map(id => `providers/${id}.provider.yaml`).toSorted().map(file => parse(readFileSync(file, "utf8"))));

async function fixture(t) {
  // Integration owns the generated snapshot. Exercise these exact compiled manifests
  // even before the serial snapshot regeneration lands.
  const original = snapshot.providers;
  snapshot.providers = [...original.filter(p => !ids.includes(p.id)), ...compiled.providers];
  t.after(() => { snapshot.providers = original; });
  const base = { enabled: true, generation: "v1", providers: ids, models: null, tenantId: "fixture", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const policies = { unmetered: base, fixed: { ...base, monthlyBudgetMicros: 1000000, requestCostMicros: 7 }, reserve: { ...base, monthlyBudgetMicros: 1000000 }, denied: { ...base, providers: ["openai"] } };
  const records = new Map(), events = [], pending = [], sent = [];
  const env = { BRAVE_API_KEY: "synthetic-brave", EXA_API_KEY: "synthetic-exa", PARALLEL_API_KEY: "synthetic-parallel", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => { events.push(event); } }, BUDGET_LEDGER: sqlBudgetNamespace(t) };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", Object.entries(policies).map(([policyId, policy]) => ({ policyId, policy })));
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(Object.keys(policies).map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-" + credentialId), policyId: credentialId, policyGeneration: "v1" } }))));
  await authorityCall(env, "/connections/initialize-all", ids.map(providerId => ({ providerId, enabled: true })));
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? await new Response(init.body).json() : null });
    return Response.json({ results: [{ title: "fixture", url: "https://example.com" }] });
  });
  const request = (id, key = "unmetered", extraHeaders = {}) => {
    const provider = compiled.providers.find(p => p.id === id), endpoint = provider.endpoints[0];
    const body = id === "exa" ? { query: "fixture", type: "auto", contents: { highlights: true } } : { objective: "fixture", search_queries: ["fixture"], mode: "basic" };
    return worker.fetch(new Request(`https://router.example/v1/native/${id}${endpoint.path}${id === "brave" ? "?q=fixture&country=US&extra_snippets=true" : ""}`, { method: endpoint.method, headers: { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}`, "content-type": "application/json", ...extraHeaders }, ...(endpoint.method === "POST" ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: promise => pending.push(promise) });
  };
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending };
}

test("native search preserves query/body and isolates provider credentials", async t => {
  const f = await fixture(t);
  for (const id of ids) {
    const response = await f.request(id);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { results: [{ title: "fixture", url: "https://example.com" }] });
    const sent = f.sent.at(-1), provider = compiled.providers.find(p => p.id === id);
    assert.equal(sent.headers.get(provider.auth.schemes[0].header), `synthetic-${id}`);
    assert.equal(sent.headers.get("authorization"), null);
    assert.ok(sent.url.startsWith(provider.base_urls.default + provider.endpoints[0].path));
    assert.equal(provider.models.length, 0, "search is an operation, not a fabricated language model");
  }
  assert.equal(new URL(f.sent[0].url).searchParams.get("q"), "fixture");
  assert.equal(new URL(f.sent[0].url).searchParams.get("extra_snippets"), "true");
  assert.equal(f.sent[0].body, null);
  assert.deepEqual(f.sent[1].body, { query: "fixture", type: "auto", contents: { highlights: true } });
  assert.deepEqual(f.sent[2].body, { objective: "fixture", search_queries: ["fixture"], mode: "basic" });
  await Promise.all(f.pending);
  for (const id of ids) {
    const event = f.events.find(event => event.provider === id);
    assert.equal(event.capability, "web.search");
    assert.equal(event.cost_basis, "flat_fallback");
    assert.equal(event.actual_cost_micros, 1, "legacy router fallback is not an upstream search tariff");
    assert.equal(event.model, null);
  }
});

test("search rejects forbidden providers and unpriced reserve requests before upstream IO", async t => {
  const f = await fixture(t);
  for (const id of ids) {
    for (const key of ["denied", "reserve"]) {
      const response = await f.request(id, key);
      assert.ok(response.status >= 400);
      assert.equal((await response.json()).error.code, key === "reserve" ? "pricing_required" : "provider_not_allowed");
      assert.equal(f.sent.length, 0);
    }
  }
});

test("explicit fixed request pricing settles the policy amount without inventing upstream fees", async t => {
  const f = await fixture(t);
  for (const id of ids) {
    const response = await f.request(id, "fixed");
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
  }
  await Promise.all(f.pending);
  for (const id of ids) assert.equal(f.events.find(event => event.provider === id).actual_cost_micros, 7);
});
