import assert from "node:assert/strict";
import test from "node:test";
import { selectProviderPolicy } from "../grant-selection.ts";

test("provider policy selection skips stored malformed credential bundles", async () => {
  const entries = [
    { policyId: "empty", policy: { enabled: true, providers: ["openai"], tenantId: "default" } },
    { policyId: "valid", policy: { enabled: true, providers: ["openai"], tenantId: "default" } },
  ];
  for (const malformed of [
    { credentials: { apiKey: "" } },
    { credentials: { accessKeyId: "configured", secretAccessKey: "" } },
    { credentials: { accessKeyId: "configured", secretAccessKey: "   " } },
    { credentials: { "invalid/name": "configured" } },
    { credential: "   " },
  ]) {
    const stored = new Map([
      ["oauth/empty/openai", { enabled: true, provider: "openai", ...malformed }],
      ["oauth/valid/openai", { enabled: true, provider: "openai", credential: "configured" }],
    ]);
    const env = { POLICY_KV: { get: async (key) => stored.get(key) ?? null } };
    assert.equal((await selectProviderPolicy(entries, "openai", "default", env)).policyId, "valid");
  }
});
