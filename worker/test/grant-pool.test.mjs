import assert from "node:assert/strict";
import test from "node:test";
import { resolveGrantSelection, selectGrant, selectProviderPolicy, syncGrantPoolIndex, validGrantSegment } from "../grant-selection.ts";
import { providerById, upstreamAuth } from "../providers.ts";

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
  assert.equal((await selectProviderPolicy(entries, "openai", env)).policyId, "policy_b");

  const revoked = { ...pooled, enabled: false };
  env.values.set("oauth/policy_b/openai-backup", revoked);
  await syncGrantPoolIndex(env, "oauth/policy_b/openai-backup", pooled, revoked);
  assert.equal(await selectGrant("openai", "policy_b", "tenant_a", "openai", env), null);
});

test("grant pools skip cooldowns and prefer stronger quota within one priority", async () => {
  const env = mockEnv();
  await putGrant(env, "oauth/policy_a/openai-a", grant("openai", "a", 10));
  await putGrant(env, "oauth/policy_a/openai-b", grant("openai", "b", 10));
  await putGrant(env, "oauth/policy_a/openai-c", grant("openai", "c", 10));
  env.runtime.set("oauth/policy_a/openai-a", runtime("cooldown", 90, new Date(Date.now() + 60_000).toISOString()));
  env.runtime.set("oauth/policy_a/openai-b", runtime("limited", 20));
  env.runtime.set("oauth/policy_a/openai-c", runtime("available", 80));
  assert.equal((await selectGrant("openai", "policy_a", "tenant_a", "openai", env))?.key, "oauth/policy_a/openai-c");
});

test("grant updates invalidate runtime state observed for the old credential", async () => {
  const env = mockEnv();
  const key = "oauth/policy_a/openai";
  const oldRevision = new Date(Date.now() - 10_000).toISOString();
  await putGrant(env, key, { ...grant("openai", "rotated", 10), updatedAt: new Date(Date.now() - 5_000).toISOString() });
  env.runtime.set(key, { ...runtime("cooldown", 0, new Date(Date.now() + 60_000).toISOString()), grantRevision: oldRevision });
  assert.equal((await selectGrant("openai", "policy_a", "tenant_a", "openai", env))?.key, key);
});

test("policy eligibility and stale-state controls fail closed before selection", async () => {
  const env = mockEnv();
  await putGrant(env, "oauth/policy_a/openai-a", grant("openai", "a", 10));
  await putGrant(env, "oauth/policy_a/openai-b", grant("openai", "b", 10));
  env.runtime.set("oauth/policy_a/openai-a", runtime("available", 80));
  const routing = { strategy: "most_remaining", stickiness: "none", failover: true, staleState: "deny", staleAfterSeconds: 300, eligibleGrants: { openai: ["openai-b"] } };
  assert.equal(await selectGrant("openai", "policy_a", "tenant_a", "openai", env, new Set(), routing), null);
  routing.eligibleGrants.openai = ["openai-a"];
  assert.equal((await selectGrant("openai", "policy_a", "tenant_a", "openai", env, new Set(), routing))?.key, "oauth/policy_a/openai-a");
});

test("empty eligibility and stale-state deny policies block environment credential fallback", async () => {
  const env = mockEnv();
  const eligibleRouting = { strategy: "round_robin", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: { openai: [] } };
  const eligible = await resolveGrantSelection("openai", "policy_a", "tenant_a", "openai", env, new Set(), eligibleRouting);
  assert.equal(eligible.selected, null);
  assert.equal(eligible.hasConfiguredGrant, true);

  const staleRouting = { ...eligibleRouting, staleState: "deny", eligibleGrants: {} };
  const stale = await resolveGrantSelection("openai", "policy_a", "tenant_a", "openai", env, new Set(), staleRouting);
  assert.equal(stale.selected, null);
  assert.equal(stale.hasConfiguredGrant, true);
});

test("selection delegates strategy, weight, and privacy-safe stickiness to the authority", async () => {
  const env = mockEnv();
  await putGrant(env, "oauth/policy_a/openai-a", { ...grant("openai", "a", 10), weight: 1 });
  await putGrant(env, "oauth/policy_a/openai-b", { ...grant("openai", "b", 10), weight: 7 });
  const routing = { strategy: "weighted_random", stickiness: "session", failover: false, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: {} };
  await selectGrant("openai", "policy_a", "tenant_a", "openai", env, new Set(), routing, "a".repeat(64));
  assert.equal(env.selections.length, 1);
  assert.equal(env.selections[0].strategy, "weighted_random");
  assert.equal(env.selections[0].stickyHash, "a".repeat(64));
  assert.deepEqual(env.selections[0].candidates.map(({ weight }) => weight), [1, 7]);
  await resolveGrantSelection("openai", "policy_a", "tenant_a", "openai", env, new Set(), routing, null, false);
  assert.equal(env.selections.length, 1);
});

test("grant key segments reject ambiguous or undiscoverable values", () => {
  assert.equal(validGrantSegment("openai-backup"), true);
  assert.equal(validGrantSegment("nested/grant"), false);
  assert.equal(validGrantSegment("x".repeat(257)), false);
  assert.equal(validGrantSegment("line\nbreak"), false);
});

test("endpoint and transport eligibility precede priority selection and never reopen environment credentials", async () => {
  const env = mockEnv();
  const provider = providerById("openai");
  const requirement = (id, mode = "http") => ({ provider, endpoint: provider.endpoints.find((endpoint) => endpoint.id === id), mode });
  await putGrant(env, "oauth/policy_a/subscription", { ...grant("openai", "subscription", 10), kind: "subscription" });
  await putGrant(env, "oauth/policy_a/api", grant("openai", "api", 100));
  for (const [endpoint, mode, expected] of [["responses", "http", "subscription"], ["chat_completions", "http", "api"], ["embeddings", "http", "api"], ["responses", "websocket", "api"]]) {
    const result = await resolveGrantSelection("openai", "policy_a", "tenant_a", "openai", env, new Set(), undefined, null, true, undefined, requirement(endpoint, mode));
    assert.equal(result.selected.key, `oauth/policy_a/${expected}`);
    assert.deepEqual(env.selections.at(-1).candidates.map(({ key }) => key), [`oauth/policy_a/${expected}`]);
  }
  env.values.delete("oauth/policy_a/api");
  const unavailable = await resolveGrantSelection("openai", "policy_a", "tenant_a", "openai", env, new Set(), undefined, null, false, undefined, requirement("responses", "websocket"));
  assert.equal(unavailable.selected, null);
  assert.equal(unavailable.hasConfiguredGrant, true);
  const pinned = await resolveGrantSelection("openai", "policy_a", "tenant_a", "openai", env, new Set(), undefined, null, false, "oauth/policy_a/api", requirement("responses", "websocket"));
  assert.equal(pinned.selected, null);
  assert.equal(pinned.hasConfiguredGrant, true);
});

test("Access policy choice respects endpoint support and pinned grant revisions cannot rotate", async () => {
  const env = mockEnv();
  const provider = providerById("openai");
  await putGrant(env, "oauth/policy_a/subscription", { ...grant("openai", "subscription"), kind: "subscription" });
  await putGrant(env, "oauth/policy_b/api", grant("openai", "api"));
  const requirement = { provider, endpoint: provider.endpoints.find((endpoint) => endpoint.id === "chat_completions"), mode: "http" };
  assert.equal((await selectProviderPolicy([policy("policy_a"), policy("policy_b")], "openai", env, requirement)).policyId, "policy_b");
  const auth = { policyId: "policy_b", policy: policy("policy_b").policy };
  env.GRANT_CREDENTIALS = { idFromName: (name) => name, get: () => ({ fetch: async (_url, init) => {
    const { grant } = JSON.parse(init.body);
    return Response.json({ grant, projection: { credentialGeneration: grant.credentialGeneration }, changed: false, migrated: false });
  } }) };
  await assert.rejects(upstreamAuth(provider, auth, env, new Set(), null, false, { key: "oauth/policy_b/api", revision: "old" }, requirement), (error) => error.code === "upstream_grant_changed");
});

function grant(provider, label, priority = 100) {
  return { version: 1, enabled: true, priority, kind: "api_key", provider, label, credential: `configured-${label}` };
}

function policy(policyId) {
  return { policyId, policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant_a", retainRequestContent: true } };
}

function runtime(status, remaining, cooldownUntil = null) {
  return { status, observedAt: new Date().toISOString(), source: "provider_response", cooldownUntil, lastSignal: "quota", grantRevision: null, windows: [{ kind: "requests", remaining, limit: 100, resetAt: new Date(Date.now() + 60_000).toISOString() }] };
}

async function putGrant(env, key, value) {
  const previous = env.values.get(key) ?? null;
  env.values.set(key, value);
  await syncGrantPoolIndex(env, key, previous, value);
}

function mockEnv(initial = {}) {
  const values = new Map(Object.entries(initial));
  const pools = new Map();
  const runtime = new Map();
  const selections = [];
  return {
    values, runtime, selections,
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
            const keys = [...new Set([
              ...(body.defaultKeys ?? []),
              ...[...(pools.get(policy) ?? [])].sort().map((ref) => `oauth/${body.policyId}/${ref}`),
              ...[...(pools.get(tenant) ?? [])].sort().map((ref) => `oauth/tenants/${body.tenantId}/${ref}`),
            ])];
            return Response.json({ keys, states: Object.fromEntries(keys.flatMap((key) => runtime.has(key) ? [[key, runtime.get(key)]] : [])) });
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
          if (path === "/grant-pools/feedback") { runtime.set(body.key, body.state); return new Response("updated"); }
          if (path === "/grant-pools/states") return Response.json({ states: Object.fromEntries(body.keys.flatMap((key) => runtime.has(key) ? [[key, runtime.get(key)]] : [])) });
          if (path === "/grant-pools/select") {
            selections.push(body);
            const selected = [...body.candidates].sort((a, b) => (b.remainingRatio ?? -1) - (a.remainingRatio ?? -1) || a.key.localeCompare(b.key))[0];
            return Response.json({ selectedKey: selected.key, selectedCount: 1, lastSelectedAt: new Date().toISOString() });
          }
          if (path === "/grant-pools/stats") return Response.json({ stats: Object.fromEntries(body.keys.map((key) => [key, { selectedCount: 0, lastSelectedAt: null }])) });
          return new Response("not found", { status: 404 });
        } };
      },
    },
  };
}

function poolKey(scope, scopeId, provider) { return `${scope}/${scopeId}/${provider}`; }
