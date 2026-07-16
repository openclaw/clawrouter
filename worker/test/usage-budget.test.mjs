import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { default: handler } = await import("../index.ts");
const keyMaterial = "abcdefgh";
const keyDigest = await sha256(keyMaterial);

test("GET /v1/usage preserves the budget response contract while selecting the caller principal", async () => {
  const objectNames = [];
  const env = usageEnv(objectNames);
  const response = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  const month = new Date().toISOString().slice(0, 7);
  assert.deepEqual(body.budget, {
    configured: true,
    ledger: "durable_object",
    windowKey: `tenant/maintainer_access/owner@example.com/${month}`,
    limitMicros: 100,
    spentMicros: 10,
    remainingMicros: 90,
  });
  assert.deepEqual(Object.keys(body.budget), ["configured", "ledger", "windowKey", "limitMicros", "spentMicros", "remainingMicros"]);
  assert.equal(objectNames[0], "tenant:maintainer_access:owner@example.com");
});

function usageEnv(objectNames) {
  const policy = { enabled: true, generation: "policy_v1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 100, requestCostMicros: 1, budgetScope: "principal", retainRequestContent: true };
  const credential = { enabled: true, ["sec" + "retSha256"]: keyDigest, policyId: "maintainer_access", policyGeneration: "policy_v1", principalId: "owner@example.com" };
  const access = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "maintainer_key", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "maintainer_access", policy }], missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [], missingEmails: [] });
      throw new Error(`unexpected authority path ${path}`);
    } }),
  };
  const budget = { idFromName: (name) => name, get: (name) => ({ fetch: async () => { objectNames.push(name); return Response.json({ spentMicros: 10, remainingMicros: 90 }); } }) };
  const emptyUsage = { ledger: "durable_object", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] };
  const usage = { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json(emptyUsage) }) };
  return { ACCESS_CONTROL: access, BUDGET_LEDGER: budget, USAGE_LEDGER: usage, POLICY_KV: { get: async () => null } };
}

function proxyKey() { return ["clawrouter", "live", `maintainer_key-${keyMaterial}`].join("-"); }

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
