import assert from "node:assert/strict";
import test from "node:test";
import { selectGrant, selectProviderPolicy, syncGrantPoolIndex, validGrantSegment } from "../grant-selection.ts";

test("grant pools select the lowest-priority usable grant deterministically", async () => {
  const env = mockEnv();
  const primary = grant("openai", "primary", 50);
  const preferred = grant("openai", "preferred", 10);
  await putGrant(env, "oauth/policy_a/openai", primary);
  await putGrant(env, "oauth/policy_a/openai-preferred", preferred);

  const selected = await selectGrant("openai", "policy_a", "tenant_a", "openai", env);
  assert.equal(selected?.key, "oauth/policy_a/openai-preferred");

  const fallback = await selectGrant("openai", "policy_a", "tenant_a", "openai", env, new Set([selected.key]));
  assert.equal(fallback?.key, "oauth/policy_a/openai");
});

test("legacy default grants remain selectable without a pool index", async () => {
  const env = mockEnv({ "oauth/policy_a/openai": grant("openai", "legacy") });
  const selected = await selectGrant("openai", "policy_a", "tenant_a", "openai", env);
  assert.equal(selected?.grant.label, "legacy");
});

test("revoked grants leave the pool and policy selection sees indexed grants", async () => {
  const env = mockEnv();
  const pooled = grant("openai", "pooled", 20);
  await putGrant(env, "oauth/policy_b/openai-backup", pooled);
  const entries = [policy("policy_a"), policy("policy_b")];
  assert.equal((await selectProviderPolicy(entries, "openai", "tenant_a", env)).policyId, "policy_b");

  const revoked = { ...pooled, enabled: false };
  env.values.set("oauth/policy_b/openai-backup", revoked);
  await syncGrantPoolIndex(env, "oauth/policy_b/openai-backup", pooled, revoked);
  assert.equal(await selectGrant("openai", "policy_b", "tenant_a", "openai", env), null);
});

test("grant key segments reject ambiguous or undiscoverable values", () => {
  assert.equal(validGrantSegment("openai-backup"), true);
  assert.equal(validGrantSegment("nested/grant"), false);
  assert.equal(validGrantSegment("x".repeat(257)), false);
  assert.equal(validGrantSegment("line\nbreak"), false);
});

function grant(provider, label, priority = 100) {
  return { version: 1, enabled: true, priority, kind: "api_key", provider, label, credential: `configured-${label}` };
}

function policy(policyId) {
  return { policyId, policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant_a", retainRequestContent: true } };
}

async function putGrant(env, key, value) {
  const previous = env.values.get(key) ?? null;
  env.values.set(key, value);
  await syncGrantPoolIndex(env, key, previous, value);
}

function mockEnv(initial = {}) {
  const values = new Map(Object.entries(initial));
  const pools = new Map();
  return {
    values,
    POLICY_KV: {
      async get(key) {
        if (Array.isArray(key)) return new Map(key.map((item) => [item, structuredClone(values.get(item) ?? null)]));
        return structuredClone(values.get(key) ?? null);
      },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
    ACCESS_CONTROL: {
      idFromName(name) { return name; },
      get() {
        return { async fetch(url, init) {
          const path = new URL(url).pathname, body = JSON.parse(init.body);
          if (path === "/grant-pools/resolve") {
            const policy = poolKey("policies", body.policyId, body.providerId), tenant = poolKey("tenants", body.tenantId, body.providerId);
            const keys = [
              ...[...(pools.get(policy) ?? [])].sort().map((ref) => `oauth/${body.policyId}/${ref}`),
              ...[...(pools.get(tenant) ?? [])].sort().map((ref) => `oauth/tenants/${body.tenantId}/${ref}`),
            ];
            return Response.json({ keys });
          }
          if (path === "/grant-pools/sync") {
            if (body.previousProvider && (body.previousProvider !== body.provider || !body.enabled)) pools.get(poolKey(body.scope, body.scopeId, body.previousProvider))?.delete(body.tokenRef);
            if (body.enabled && body.provider) {
              const key = poolKey(body.scope, body.scopeId, body.provider), refs = pools.get(key) ?? new Set();
              if (!refs.has(body.tokenRef) && refs.size >= 32) return Response.json({ error: "pool full" }, { status: 400 });
              refs.add(body.tokenRef); pools.set(key, refs);
            }
            return new Response("updated");
          }
          return new Response("not found", { status: 404 });
        } };
      },
    },
  };
}

function poolKey(scope, scopeId, provider) { return `${scope}/${scopeId}/${provider}`; }
