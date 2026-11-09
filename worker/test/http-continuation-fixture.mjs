import "./typescript-setup.mjs";
import assert from "node:assert/strict";
const { default: handler } = await import("../index.ts");
import { putGrantCredentials } from "../grant-credentials.ts";
import { sha256Hex } from "../utils.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

export const grantKeys = ["oauth/fixture/account-a", "oauth/fixture/account-b"];
export async function fixture(t, pooled = true, { limit = null, fixedCost = 7, diagnostic } = {}) {
  const pending = [], events = [], values = new Map(), sent = [];
  const observations = diagnostic ? new Set() : undefined;
  let requests = 0, started = 0, settled = 0, rejected = 0, diagnosticFailures = 0;
  const emit = (phase, request = requests, root) => {
    if (!diagnostic) return;
    const pendingIds = [];
    for (const row of observations) { if (pendingIds.length === 16) break; pendingIds.push({ id: row.id, settled: row.settled }); }
    try { diagnostic({ phase, request, rootId: root?.id ?? null, rootSettled: root?.settled ?? null, started, settled, rejected, pendingQueue: pending.length,
      pendingCount: observations.size, pendingIds, overflow: Math.max(0, observations.size - pendingIds.length), diagnosticFailures }); }
    catch { diagnosticFailures++; }
  };
  const waitUntil = promise => {
    const length = pending.push(promise);
    if (observations) {
      const row = { id: ++started, settled: false }, request = requests; observations.add(row);
      const observe = failed => {
        row.settled = true; settled++; if (failed) rejected++; observations.delete(row);
        emit("wait-until-settled", request, row);
      };
      void promise.then(() => observe(false), () => observe(true));
      emit("wait-until-enrolled", request, row);
    }
    return length;
  };
  emit("fixture-start");
  const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: fixedCost, retainRequestContent: false, grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } };
  const credential = { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture" };
  const env = attachGrantCredentialNamespace({
    ACCESS_CONTROL: null,
    BUDGET_LEDGER: sqlBudgetNamespace(t),
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(key => [key, structuredClone(values.get(key) ?? null)])) : structuredClone(values.get(key) ?? null); },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
    OPENAI_API_KEY: "synthetic-environment-key",
    USAGE_QUEUE: { async send(event) { events.push(event); } },
  }, { useExistingAuthority: true });
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  async function authority(path, value) {
    const response = await env.ACCESS_CONTROL.get("policy-bindings").fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(value) });
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }
  async function mutateCredential(value) {
    const response = await authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, ...value });
    assert.equal((await response.json()).outcome, "updated");
  }
  await authority("/policies/put", { policyId: "fixture", policy });
  await mutateCredential({ operation: "create", credentialId: "fixture", credential });
  await authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: limit });
  if (pooled) for (const [index, key] of grantKeys.entries()) {
    await putGrantCredentials(env, key, { provider: "openai", kind: "subscription", enabled: true, accessToken: `synthetic-access-${index}`, refreshToken: `synthetic-refresh-${index}`, accountId: `synthetic-account-${index}`, expiresAt: "2099-01-01T00:00:00.000Z" });
  }
  const f = {
    env, values, sent, events, policy, credential, authority, mutateCredential,
    response: (request, index) => Response.json({ object: "response", id: `resp_${index}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    async request(body = {}, headers = {}, path = "/v1/responses", signal) {
      const ordinal = ++requests; emit("request-start", ordinal);
      try {
        const original = handler.fetch(new Request(`https://router.example${path}`, { method: "POST", signal, headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", ...body }) }), env, { waitUntil });
        if (diagnostic) void original.then(() => emit("request-fulfilled", ordinal), () => emit("request-rejected", ordinal));
        return original;
      } catch (error) { emit("request-threw", ordinal); throw error; }
    },
    async consume(response) {
      emit("body-text-start"); let text;
      try { text = await response.text(); } catch (error) { emit("body-text-rejected"); throw error; }
      emit("body-text-end"); await f.drain(); return text;
    },
    async drain() {
      emit("drain-start");
      try { while (pending.length) await Promise.all(pending.splice(0)); }
      catch (error) { emit("drain-rejected"); throw error; }
      emit("drain-end");
    },
    bindings() { return [...env.ACCESS_CONTROL.objects].filter(([name]) => name.startsWith("http-continuations:")); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers), signal: init.signal, redirect: init.redirect };
    sent.push(request); return f.response(request, sent.length);
  });
  emit("fixture-end"); return f;
}
