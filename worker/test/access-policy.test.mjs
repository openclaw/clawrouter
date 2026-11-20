import assert from "node:assert/strict";
import test from "node:test";
import { selectProviderPolicy } from "../grant-selection.ts";
import { accessBytesResponse } from "./access-byte-fixture.mjs";

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
    const env = {
      POLICY_KV: { get: async (key, type) => {
        const read = item => {
          const value = stored.get(item) ?? null;
          return type === "stream" && value !== null ? accessBytesResponse(JSON.stringify(value), "").body : value;
        };
        return Array.isArray(key) ? new Map(key.map(item => [item, read(item)])) : read(key);
      } },
      ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (_url, init) => new Headers(init?.headers).has("x-clawrouter-identity-admission")
        ? accessBytesResponse(JSON.stringify({ keys: [] }), "") : Response.json({ keys: [] }) }) },
    };
    assert.equal((await selectProviderPolicy(entries, "openai", env)).policyId, "valid");
  }
});
