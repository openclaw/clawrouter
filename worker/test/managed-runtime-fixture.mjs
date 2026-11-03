import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { sha256Hex } = await import("../utils.ts");
const { providerById, snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { UsageLedgerObject } = await import("../ledgers.ts");
export const contract = JSON.parse(readFileSync(new URL("../../providers/_fixtures/replicate/prediction-lifecycle.json", import.meta.url)));
export const path = "/v1/native/replicate/v1/predictions";
export const control = `${path}/${contract.responses.created.id}`;
export const grantKey = "oauth/fixture/replicate";

export async function fixture(t, { fixed = 700, pooled = false, providerId = "replicate", compiledProvider = false, configure = () => {} } = {}) {
  let now = Date.parse("2026-11-03T00:00:00Z"); t.mock.method(Date, "now", () => now);
  const values = new Map(), pending = [], sent = [], budgetCalls = [];
  const env = { REPLICATE_API_TOKEN: "synthetic-environment-key", POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(name => [name, structuredClone(values.get(name) ?? null)])) : structuredClone(values.get(key) ?? null); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } };
  const budgets = sqlBudgetNamespace(t);
  env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ fetch(url, init) { budgetCalls.push({ name, path: new URL(url).pathname }); return budgets.get(name).fetch(url, init); } }) };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = { sql: { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } },
    transactionSync(fn) { db.exec("BEGIN"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } }, getAlarm: async () => 1 };
  let usage = new UsageLedgerObject({ storage }), loseAck = false;
  env.USAGE_LEDGER = { idFromName: name => name, get: () => ({ async fetch(url, init) {
    const response = await usage.fetch(new Request(url, init));
    if (loseAck && new URL(url).pathname === "/ingest") { loseAck = false; return new Response("fixture lost ACK", { status: 503 }); }
    return response;
  } }) };
  const authority = async (route, body) => {
    const response = await env.ACCESS_CONTROL.get("policy-bindings").fetch(`https://authority${route}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response;
  };
  const policy = { enabled: true, generation: "g1", providers: [providerId], tenantId: "tenant", monthlyBudgetMicros: 10_000, requestCostMicros: fixed, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture", policyGeneration: "g1", principalId: null };
  await authority("/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await authority("/credentials/initialize-all", [{ credentialId: "fixture", credential }]);
  await authority("/connections/initialize-all", [{ providerId, enabled: true, monthlyBudgetMicros: 10_000 }]);
  // Synthetic declarations must not collide with a newly shipped provider.
  // Compiled activation tests instead consume that exact provider unchanged.
  if (!compiledProvider && providerId !== "replicate") {
    const index = snapshot.providers.findIndex(provider => provider.id === providerId);
    if (index !== -1) {
      const [shipped] = snapshot.providers.splice(index, 1);
      t.after(() => snapshot.providers.splice(index, 0, shipped));
    }
  }
  const provider = providerById(compiledProvider ? providerId : "replicate");
  assert.ok(provider, `missing compiled provider ${providerId}`);
  const original = structuredClone(provider);
  t.after(() => { Object.keys(provider).forEach(key => delete provider[key]); Object.assign(provider, original); });
  if (!compiledProvider || providerId === "replicate") {
    assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === "predictions").lifecycle,
      { protocol: "replicate.predictions", retrieve: "prediction", cancel: "prediction_cancel" });
    assert.equal(provider.endpoints.find(endpoint => endpoint.id === "prediction_cancel")?.request_format, "replicate.prediction_cancel");
  }
  provider.id = providerId; configure(provider);
  if (pooled) await putGrantCredentials(env, grantKey, { provider: providerId, kind: "api_key", enabled: true, credential: "synthetic-original-key" });
  const f = { env, policy, credential, authority, budgets, budgetCalls, sent, provider,
    upstream: request => Response.json(request.method === "POST" && !request.url.endsWith("/cancel") ? contract.responses.created : contract.responses.partial),
    call(route = path, body = contract.request.body, extra = {}) {
      return worker.fetch(new Request(`https://router.example${route}`, { method: body == null ? "GET" : "POST", ...extra,
        headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...extra.headers },
        ...(body == null ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: promise => pending.push(promise) });
    },
    state(response) {
      const locator = response.headers.get("x-clawrouter-background-recovery"); assert.match(locator, /^[a-f0-9]{64}\.bg_[a-f0-9]{32}$/);
      const [scope, id] = locator.split("."), state = env.ACCESS_CONTROL.objects.get(`http-continuations:${scope}`);
      return { id, state, job: () => JSON.parse(state.db.prepare("SELECT job_json FROM responses_background WHERE job_id = ?").get(id).job_json), alarm: () => state.object.alarm() };
    },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
    advance(ms) { now += ms; },
    restart() { for (const state of env.ACCESS_CONTROL.objects.values()) state.restart(); usage = new UsageLedgerObject({ storage }); },
    loseUsageAck() { loseAck = true; },
    async events() { return (await (await usage.fetch(new Request("https://usage/snapshot?events=admin"))).json()).events; },
  };
  t.mock.method(globalThis, "fetch", async (input, init) => { const request = new Request(input, init); sent.push(request); return f.upstream(request); });
  return f;
}
