import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const ids = ["voyage"];
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/voyage/embeddings.json", import.meta.url), "utf8"));
const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...ids.map(id => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));

async function fixture(t) {
  // Integration owns the generated snapshot. Exercise these exact compiled manifests
  // even before the serial snapshot regeneration lands.
  const original = snapshot.providers;
  snapshot.providers = [...original.filter(p => !ids.includes(p.id)), ...compiled.providers];
  t.after(() => { snapshot.providers = original; });
  const base = { enabled: true, generation: "v1", providers: ids, models: null, tenantId: "fixture", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const policies = { unmetered: base, fixed: { ...base, monthlyBudgetMicros: 1000000, requestCostMicros: 7 }, reserve: { ...base, monthlyBudgetMicros: 1000000 }, otherModel: { ...base, models: ["openai/gpt-6.1-sol"] }, denied: { ...base, providers: ["openai"] } };
  const records = new Map(), events = [], pending = [], sent = [];
  const env = { VOYAGE_API_KEY: "synthetic-voyage", POLICY_KV: {
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
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json() });
    return hooks.reject ? Response.json({ error: { message: "fixture rejection" } }, { status: 422 }) : Response.json(wire.response);
  });
  const body = wire.request;
  const request = (key = "fixed", requestBody = body, route = "/v1/native/voyage/v1/embeddings") => worker.fetch(new Request("https://router.example" + route, {
    method: "POST", headers: { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}`, "content-type": "application/json" }, body: JSON.stringify(requestBody),
  }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, hooks, body };
}

test("Voyage preserves native embedding options and vectors with fixed policy accounting", async t => {
  const f = await fixture(t), response = await f.request();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), wire.response);
  assert.equal(f.sent[0].url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-voyage");
  assert.deepEqual(f.sent[0].body, wire.request);
  await Promise.all(f.pending);
  assert.equal(f.events[0].capability, "llm.embeddings");
  assert.equal(f.events[0].model, "voyage/voyage-4-lite");
  assert.equal(f.events[0].total_tokens, 12);
  assert.equal(f.events[0].actual_cost_micros, 7);
});

test("Voyage enforces provider/model scope and refuses unknown hard-budget pricing before fetch", async t => {
  const f = await fixture(t);
  for (const [key, code] of [["denied", "provider_not_allowed"], ["otherModel", "model_not_allowed"], ["reserve", "pricing_required"]]) {
    const response = await f.request(key);
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).error.code, code);
    assert.equal(f.sent.length, 0);
  }
});

test("Voyage rejected embedding requests are nonbillable and models cannot serve chat", async t => {
  const f = await fixture(t);
  f.hooks.reject = true;
  const failed = await f.request();
  assert.equal(failed.status, 422);
  await failed.text();
  await Promise.all(f.pending);
  assert.equal(f.events.at(-1).actual_cost_micros, 0);
  const chat = await f.request("unmetered", { model: "voyage/voyage-4-lite", messages: [] }, "/v1/chat/completions");
  assert.equal(chat.status, 400);
  await chat.text();
  assert.equal(f.sent.length, 1);
});
