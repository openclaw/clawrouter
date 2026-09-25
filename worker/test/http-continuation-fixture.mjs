import "./typescript-setup.mjs";
import assert from "node:assert/strict";
const { default: handler } = await import("../index.ts");
import { putGrantCredentials } from "../grant-credentials.ts";
import { sha256Hex } from "../utils.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

export const grantKeys = ["oauth/fixture/account-a", "oauth/fixture/account-b"];
export async function fixture(t, pooled = true, { limit = null, fixedCost = 7 } = {}) {
  const pending = [], events = [], values = new Map(), sent = [];
  const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: fixedCost, retainRequestContent: false, grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } };
  const credential = { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture" };
  const env = attachGrantCredentialNamespace({
    ACCESS_CONTROL: continuationAuthority(t),
    BUDGET_LEDGER: sqlBudgetNamespace(t),
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(key => [key, structuredClone(values.get(key) ?? null)])) : structuredClone(values.get(key) ?? null); },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
    OPENAI_API_KEY: "synthetic-environment-key",
    USAGE_QUEUE: { async send(event) { events.push(event); } },
  }, { useExistingAuthority: true });
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
      return handler.fetch(new Request(`https://router.example${path}`, { method: "POST", signal, headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", ...body }) }), env, { waitUntil: promise => pending.push(promise) });
    },
    async consume(response) { const text = await response.text(); await f.drain(); return text; },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
    bindings() { return [...env.ACCESS_CONTROL.objects].filter(([name]) => name.startsWith("http-continuations:")); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers), signal: init.signal };
    sent.push(request); return f.response(request, sent.length);
  });
  return f;
}
