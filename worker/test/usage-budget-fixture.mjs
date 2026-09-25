const keyMaterial = "abcdefgh";
const keyDigest = await sha256(keyMaterial);

export function usageEnv(objectNames, { provider = "openai", limit = 100, providerLimit = limit, fixedCost = 1, retainContent = true, existingUnmetered = false } = {}) {
  const policy = { enabled: true, generation: "policy_v1", providers: [provider], tenantId: "tenant", monthlyBudgetMicros: limit, requestCostMicros: fixedCost, budgetScope: "principal", retainRequestContent: retainContent };
  // Existing stored policies can omit the optional limits; new policies use null.
  if (existingUnmetered) { delete policy.monthlyBudgetMicros; delete policy.requestCostMicros; }
  const credential = { enabled: true, ["sec" + "retSha256"]: keyDigest, policyId: "maintainer_access", policyGeneration: "policy_v1", principalId: "owner@example.com" };
  const access = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "maintainer_key", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "maintainer_access", policy }], missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [], missingEmails: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [{ providerId: provider, enabled: true, monthlyBudgetMicros: providerLimit }], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {}, ready: true });
      throw new Error(`unexpected authority path ${path}`);
    } }),
  };
  const budget = { idFromName: (name) => name, get: (name) => ({ fetch: async () => { objectNames.push(name); return Response.json({ spentMicros: 10, remainingMicros: 90 }); } }) };
  const emptyUsage = { ledger: "durable_object", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] };
  const usage = { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json(emptyUsage) }) };
  return { ACCESS_CONTROL: access, BUDGET_LEDGER: budget, USAGE_LEDGER: usage, POLICY_KV: { get: async (keys) => Array.isArray(keys) ? new Map() : null } };
}

export function proxyKey() { return ["clawrouter", "live", `maintainer_key-${keyMaterial}`].join("-"); }

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const sse = (...events) => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
