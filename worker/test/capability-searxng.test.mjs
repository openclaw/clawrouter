import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const ids = ["searxng"];
const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...ids.map(id => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));

async function fixture(t) {
  // Integration owns the generated snapshot. Exercise these exact compiled manifests
  // even before the serial snapshot regeneration lands.
  const original = snapshot.providers;
  snapshot.providers = [...original.filter(p => !ids.includes(p.id)), ...compiled.providers];
  t.after(() => { snapshot.providers = original; });
  const base = { enabled: true, generation: "v1", providers: ids, models: null, tenantId: "fixture", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const policies = { unmetered: base, fixed: { ...base, monthlyBudgetMicros: 1000000, requestCostMicros: 7 }, reserve: { ...base, monthlyBudgetMicros: 1000000 }, denied: { ...base, providers: ["openai"] } };
  const records = new Map(), events = [], pending = [], sent = [];
  const env = { SEARXNG_BASE_URL: "https://search.example", SEARXNG_API_KEY: "synthetic-proxy-token", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => { events.push(event); } }, BUDGET_LEDGER: sqlBudgetNamespace(t) };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", Object.entries(policies).map(([policyId, policy]) => ({ policyId, policy })));
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(Object.keys(policies).map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-" + credentialId), policyId: credentialId, policyGeneration: "v1" } }))));
  await authorityCall(env, "/connections/initialize-all", ids.map(providerId => ({ providerId, enabled: true })));
  const hooks = { reject: false };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: init.body ?? null });
    return hooks.reject ? Response.json({ error: { message: "fixture rejection" } }, { status: 403 }) : Response.json({ query: "fixture", results: [{ title: "Fixture", url: "https://example.com", content: "synthetic result" }], unresponsive_engines: [] });
  });
  const request = (key = "unmetered") => worker.fetch(new Request("https://router.example/v1/native/searxng/search?q=fixture&format=json&language=en&categories=general", {
    headers: { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}` },
  }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, hooks, env };
}

test("SearXNG preserves JSON query and results with optional reverse-proxy auth", async t => {
  const f = await fixture(t), response = await f.request();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).results[0].content, "synthetic result");
  assert.equal(f.sent[0].url, "https://search.example/search?q=fixture&format=json&language=en&categories=general");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-proxy-token");
  assert.equal(f.sent[0].body, null);
  delete f.env.SEARXNG_API_KEY;
  const anonymous = await f.request();
  assert.equal(anonymous.status, 200, await anonymous.clone().text());
  await anonymous.text();
  assert.equal(f.sent[1].headers.get("authorization"), null, "router credential must never become upstream auth");
});

test("SearXNG refuses missing endpoint configuration and unpriced reserve admission", async t => {
  const f = await fixture(t);
  const reserve = await f.request("reserve");
  assert.ok(reserve.status >= 400);
  assert.equal((await reserve.json()).error.code, "pricing_required");
  delete f.env.SEARXNG_BASE_URL;
  const missing = await f.request();
  assert.ok(missing.status >= 400);
  await missing.text();
  assert.equal(f.sent.length, 0);
});

test("SearXNG disabled JSON format remains a nonbillable provider rejection", async t => {
  const f = await fixture(t);
  f.hooks.reject = true;
  const response = await f.request("fixed");
  assert.equal(response.status, 403);
  await response.text();
  await Promise.all(f.pending);
  assert.equal(f.events.at(-1).actual_cost_micros, 0);
});
