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
const ids = ["subq"];
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/subq/decisions.json", import.meta.url), "utf8"));
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
  const env = { SUBQ_API_KEY: "synthetic-subq", POLICY_KV: {
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
  const request = (key = "reserve", requestBody = body, route = "/v1/native/subq/v1/systemone") => worker.fetch(new Request("https://router.example" + route, {
    method: "POST", headers: { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}`, "content-type": "application/json" }, body: JSON.stringify(requestBody),
  }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending, hooks, body };
}

test("SubQ preserves typed native decisions and settles input-only usage", async t => {
  const f = await fixture(t), response = await f.request();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), wire.response);
  assert.equal(f.sent[0].url, "https://api.subq.ai/v1/systemone");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-subq");
  assert.deepEqual(f.sent[0].body, wire.request);
  await Promise.all(f.pending);
  const event = f.events[0];
  assert.equal(event.capability, "llm.decisions");
  assert.equal(event.model, "subq/subq-snap-1.1");
  assert.equal(event.input_tokens, 500);
  assert.equal(event.output_tokens, 0);
  assert.equal(event.actual_cost_micros, 20);
  assert.equal(event.reserved_cost_micros, 15729);
  assert.equal(event.cost_basis, "manifest_pricing");
});

test("SubQ fails closed on provider/model policy and does not alias stale preview IDs", async t => {
  const f = await fixture(t);
  for (const [key, body, code] of [
    ["denied", wire.request, "provider_not_allowed"],
    ["otherModel", wire.request, "model_not_allowed"],
    ["reserve", { ...wire.request, model: "subq-snap-preview" }, "model_capability_unsupported"],
  ]) {
    const response = await f.request(key, body);
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).error.code, code);
    assert.equal(f.sent.length, 0);
  }
});

test("SubQ model cannot be sent through unified conversational routes", async t => {
  const f = await fixture(t);
  const response = await f.request("unmetered", { model: "subq/subq-snap-1.1", messages: [] }, "/v1/chat/completions");
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(f.sent.length, 0);
});
