import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { putGrantCredentials } from "../grant-credentials.ts";
import { observeGrantQuota, observeGrantQuotaProbe, grantQuotaExhausted, grantQuotaRatio } from "../grant-quota.ts";
import { resolveGrantSelection, recordGrantRuntime, DEFAULT_GRANT_ROUTING } from "../grant-selection.ts";
import { providerById, upstreamAuth, refreshStoredGrantQuota } from "../providers.ts";
import { authorityCall } from "../authority.ts";
import { UsageLedgerObject, ingestUsage } from "../ledgers.ts";
import { sha256Hex } from "../utils.ts";
const { default: handler } = await import("../index.ts");

const provider = providerById("anthropic");
const future = "2099-01-01T00:00:00.000Z";
const key = "oauth/pool/claude";
const requirement = model => ({ provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === "messages"), mode: "http", model });
const routing = extra => ({ ...DEFAULT_GRANT_ROUTING, ...extra });
const usage = (percent = 10) => ({ five_hour: { utilization: percent, resets_at: future }, seven_day: { utilization: 20, resets_at: future }, limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 100, resets_at: future }] });

async function fixture(t) {
  const authority = createGrantAuthority();
  const values = new Map();
  const env = attachGrantCredentialNamespace({
    ANTHROPIC_API_KEY: "synthetic-api-key", CLAWROUTER_LOCAL_AUTH: "enabled",
    CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex("synthetic-admin"),
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: authority.fetch }) },
    POLICY_KV: { async get(requested) { return Array.isArray(requested) ? new Map(requested.map(name => [name, structuredClone(values.get(name) ?? null)])) : structuredClone(values.get(requested) ?? null); }, async put(name, value) { values.set(name, JSON.parse(value)); }, async list({ prefix }) { return { keys: [...values.keys()].filter(name => name.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } },
  }, { useExistingAuthority: true });
  const auth = { policyId: "pool", credentialId: "client", principalId: null, authType: "proxy_key", policy: { enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "tenant-pool", retainRequestContent: false, grantRouting: routing({ environmentFallback: true }) } };
  await authorityCall(env, "/policies/put", { policyId: "pool", policy: auth.policy });
  await putGrantCredentials(env, key, { enabled: true, kind: "subscription", provider: "anthropic", accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: future });
  const pending = [], events = [];
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  return { env, auth, values, pending, events, context: { waitUntil: promise => pending.push(promise) }, async feedback(payload = usage()) { const state = observeGrantQuotaProbe(payload, provider.quota.probes[0]); state.grantRevision = values.get(key).updatedAt; await recordGrantRuntime(env, key, state); return state; } };
}

test("collection limits expand into scoped families; reserve and ratios use only the requested model", async t => {
  const f = await fixture(t), state = await f.feedback();
  assert.equal(state.status, "limited");
  assert.equal(state.cooldownUntil, null);
  assert.deepEqual(state.windows.at(-1).models, ["fable"]);
  assert.equal(state.windows.at(-1).id, "subscription-seven-day-fable");
  assert.equal(grantQuotaRatio(state, Date.now(), 300000, "claude-sonnet-5"), .8);
  assert.equal(grantQuotaRatio(state, Date.now(), 300000, "claude-fable-5-1"), 0);
  for (const [model, expected] of [["claude-fable-5-1", false], ["claude-sonnet-5", true], ["claude-opus-5", true]]) {
    const selection = await resolveGrantSelection("anthropic", "pool", "tenant-pool", "anthropic", f.env, new Set(), routing({}), null, false, undefined, requirement(model));
    assert.equal(!!selection.selected, expected);
  }
  const reserved = await f.feedback(usage(80));
  assert.equal(grantQuotaExhausted(reserved, "claude-sonnet-5", 20), true);
  assert.equal(grantQuotaExhausted(reserved, "claude-sonnet-5", 19), false);
  const unscoped = observeGrantQuotaProbe({ ...usage(), five_hour: { utilization: 100, resets_at: future } }, provider.quota.probes[0]);
  assert.equal(unscoped.status, "cooldown");
  assert.ok(unscoped.cooldownUntil);
});

test("environment fallback is opt-in, requires credentials, and waits for model eligibility", async t => {
  const f = await fixture(t); await f.feedback();
  const sonnet = await upstreamAuth(provider, f.auth, f.env, new Set(), null, false, undefined, requirement("claude-sonnet-5"));
  assert.equal(sonnet.grantLane, "subscription");
  const fable = await upstreamAuth(provider, f.auth, f.env, new Set(), null, false, undefined, requirement("claude-fable-5-1"));
  assert.equal(fable.grantLane, "environment"); assert.equal(fable.headers.get("x-api-key"), "synthetic-api-key");
  assert.equal(fable.headers.has("authorization"), false); assert.equal(fable.transport, null);
  f.auth.policy.grantRouting.environmentFallback = false;
  await assert.rejects(upstreamAuth(provider, f.auth, f.env, new Set(), null, false, undefined, requirement("claude-fable-5-1")), { code: "upstream_grant_pool_unavailable" });
  f.auth.policy.grantRouting.environmentFallback = true;
  delete f.env.ANTHROPIC_API_KEY;
  await assert.rejects(upstreamAuth(provider, f.auth, f.env, new Set(), null, false, undefined, requirement("claude-fable-5-1")), { code: "upstream_grant_pool_unavailable" });
});

test("429 one-shot failover selects environment transport and accounts the final lane", async t => {
  const f = await fixture(t);
  await authorityCall(f.env, "/credentials/mutate", { scope: "admin", operation: "put", actor: { auth: "admin_token", role: "admin", email: "synthetic@example.test" }, credentialId: "client", credential: { enabled: true, policyId: "pool", secretSha256: await sha256Hex("synthetic-client") } });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const headers = new Headers(init.headers); sent.push(headers);
    return headers.has("authorization") ? Response.json({ error: "synthetic quota rejection" }, { status: 429 })
      : Response.json({ id: "synthetic-message", type: "message", content: [{ type: "text", text: "synthetic" }], usage: { input_tokens: 20, output_tokens: 3 } });
  });
  const response = await handler.fetch(new Request("https://router.example/v1/messages", { method: "POST", headers: { authorization: "Bearer clawrouter-live-client-synthetic-client", "content-type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: "synthetic" }] }) }), f.env, f.context);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-clawrouter-grant-lane"), "environment");
  assert.equal(response.headers.get("x-clawrouter-grant-failover"), "1");
  await response.text(); while (f.pending.length) await Promise.all(f.pending.splice(0));
  assert.equal(sent.length, 2); assert.equal(sent[1].has("authorization"), false);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].grant_key, null); assert.equal(f.events[0].grant_lane, "environment");
  assert.ok(f.events[0].actual_cost_micros > 0);
});

test("profile facts survive header observations; throttled probes keep readings and honor Retry-After", async t => {
  const f = await fixture(t); const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(String(url));
    return String(url).endsWith("/usage") ? Response.json({ ...usage(), extra_usage: { is_enabled: true, used_credits: 125, monthly_limit: 1000, currency: "USD" }, access_token: "must-not-persist" })
      : Response.json({ account: { email: "synthetic@example.test", display_name: "Synthetic Operator", access_token: "must-not-persist" }, organization: { rate_limit_tier: "default_claude_max_20x", subscription_status: "active", has_extra_usage_enabled: true }, refresh_token: "must-not-persist" });
  });
  await refreshStoredGrantQuota(f.env, key);
  let result = await authorityCall(f.env, "/grant-pools/states", { keys: [key] });
  assert.equal(result.states[key].account.email, "synthetic@example.test");
  assert.equal(result.states[key].extraUsage.usedCredits, 125);
  assert.doesNotMatch(JSON.stringify(result), /must-not-persist|access_token|refresh_token/);
  await recordGrantRuntime(f.env, key, { status: "available", observedAt: new Date().toISOString(), source: "provider_response", cooldownUntil: null, lastSignal: "quota", grantRevision: f.values.get(key).updatedAt, windows: [] });
  result = await authorityCall(f.env, "/grant-pools/states", { keys: [key] });
  assert.equal(result.states[key].account.email, "synthetic@example.test");
  assert.equal(grantQuotaExhausted(result.states[key], "claude-fable-5-1"), true);
  t.mock.restoreAll(); t.mock.method(globalThis, "fetch", async url => { calls.push(String(url)); return new Response(null, { status: 429, headers: { "Retry-After": "600" } }); });
  await refreshStoredGrantQuota(f.env, key); const count = calls.length;
  await refreshStoredGrantQuota(f.env, key); assert.equal(calls.length, count);
  const retained = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.equal(retained.account.email, "synthetic@example.test"); assert.equal(retained.status, result.states[key].status);
});

test("additive usage migration preserves old rows; admin aggregation reads only the correct policy shard", async t => {
  const f = await fixture(t), shards = new Map(), names = [];
  f.env.USAGE_LEDGER = { idFromName: name => name, get(name) {
    names.push(name);
    if (!shards.has(name)) {
      const db = new DatabaseSync(":memory:"); t.after(() => db.close());
      db.exec("CREATE TABLE usage_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, actual_cost_micros INTEGER NOT NULL, event_json TEXT NOT NULL)");
      db.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy", Date.now(), "tenant-pool", "pool", "anthropic", "success", 200, 1, 2, 3, 4, '{}');
      const storage = { sql: { exec(sql, ...args) { const stmt = db.prepare(sql); return stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []); } }, transactionSync(fn) { db.exec("BEGIN"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } }, getAlarm: async () => 1 };
      const object = new UsageLedgerObject({ storage }); shards.set(name, { fetch: (url, init) => object.fetch(new Request(url, init)) });
    }
    return shards.get(name);
  } };
  const event = { id: "accounted", type: "clawrouter.usage.v1", occurred_at_ms: Date.now(), tenant_id: "tenant-pool", policy_id: "pool", provider: "anthropic", model: "claude-sonnet-5", status: "success", status_code: 200, input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, cache_write_input_tokens: 4, total_tokens: 19, actual_cost_micros: 123, grant_key: key, grant_lane: "subscription" };
  await ingestUsage(f.env, event); await ingestUsage(f.env, event);
  await ingestUsage(f.env, { ...event, id: "paid", grant_key: null, grant_lane: "environment" });
  const response = await handler.fetch(new Request("https://router.example/v1/admin/upstream-grants/usage?scope=policies&scopeId=pool&days=7", { headers: { authorization: "Bearer synthetic-admin" } }), f.env, f.context);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual([...new Set(names)], ["policy:tenant-pool:pool"]);
  assert.equal(body.grants.find(row => row.grantKey === key).requests, 1);
  assert.equal(body.grants.find(row => row.grantKey === key).cacheWriteTokens, 4);
  assert.equal(body.lanes.find(row => row.grantLane === "environment").costMicros, 123);
  assert.equal(body.lanes.find(row => row.grantLane === null).requests, 1);
  assert.equal(body.daily.length, 3);
  const denied = await handler.fetch(new Request("https://router.example/v1/admin/upstream-grants/usage?scope=policies&scopeId=pool&days=7"), f.env, f.context);
  assert.equal(denied.status, 401);
});

test("reserve selection stops before extra usage without restricting an API-key grant", async t => {
  const f = await fixture(t); await f.feedback(usage(85));
  f.auth.policy.grantRouting.includedQuotaReservePercent = 15;
  const stopped = await upstreamAuth(provider, f.auth, f.env, new Set(), null, false, undefined, requirement("claude-sonnet-5"));
  assert.equal(stopped.grantLane, "environment");
  f.auth.policy.grantRouting.includedQuotaReservePercent = 14;
  const included = await upstreamAuth(provider, f.auth, f.env, new Set(), null, false, undefined, requirement("claude-sonnet-5"));
  assert.equal(included.grantLane, "subscription");
  await putGrantCredentials(f.env, key, { enabled: true, kind: "api_key", provider: "anthropic", credential: "synthetic-paid-key" });
  await f.feedback(usage(85));
  f.auth.policy.grantRouting.includedQuotaReservePercent = 50;
  const paid = await upstreamAuth(provider, f.auth, f.env, new Set(), null, false, undefined, requirement("claude-sonnet-5"));
  assert.equal(paid.grantLane, "api_key");
  assert.equal(paid.headers.get("x-api-key"), "synthetic-paid-key");
  assert.equal(grantQuotaExhausted({ windows: [{ remaining: 0, limit: 100, resetAt: null, models: ["fable"] }] }, "claude-fable-5-1"), true);
});

test("profile throttling does not block usage updates; profile 401 requires reauthorization", async t => {
  const f = await fixture(t); let profileCalls = 0, usageCalls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("/usage")) { usageCalls++; return Response.json(usage(10 + usageCalls)); }
    profileCalls++; return new Response(null, { status: 429, headers: { "Retry-After": new Date(Date.now() + 600000).toUTCString() } });
  });
  await refreshStoredGrantQuota(f.env, key); await refreshStoredGrantQuota(f.env, key);
  assert.equal(profileCalls, 1); assert.equal(usageCalls, 2);
  const state = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.equal(state.windows[0].remaining, 88);
  const owner = f.env.GRANT_CREDENTIALS.objects.get(key);
  const record = owner.values.get("credential"); record.quotaRetryAt = {}; owner.values.set("credential", record);
  t.mock.restoreAll(); t.mock.method(globalThis, "fetch", async url => String(url).endsWith("/usage") ? Response.json(usage()) : new Response(null, { status: 401 }));
  await assert.rejects(refreshStoredGrantQuota(f.env, key));
  assert.equal(owner.values.get("credential").status, "reauth_required");
  assert.equal(owner.alarm(), null);
  assert.equal(f.values.get(key).credentialStatus, "reauth_required");
});

test("collection readings replace duplicate legacy model-window IDs", () => {
  const state = observeGrantQuotaProbe({ seven_day_sonnet: { utilization: 5, resets_at: future }, limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Sonnet" } }, percent: 90, resets_at: future }] }, provider.quota.probes[0]);
  assert.equal(state.windows.length, 1);
  assert.equal(state.windows[0].remaining, 10);
  assert.deepEqual(state.windows[0].models, ["sonnet"]);
});

test("facts-only usage payloads retain exhausted quota and its observation timestamp", async t => {
  const f = await fixture(t), before = await f.feedback({ ...usage(), five_hour: { utilization: 100, resets_at: future } });
  t.mock.method(globalThis, "fetch", async url => String(url).endsWith("/usage") ? Response.json({ extra_usage: { is_enabled: true, used_credits: 22 } }) : Response.json({ account: { email: "facts@example.test" } }));
  await refreshStoredGrantQuota(f.env, key);
  const after = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.deepEqual(after.windows, before.windows);
  assert.equal(after.observedAt, before.observedAt);
  assert.equal(after.status, "cooldown");
  assert.equal(after.extraUsage.usedCredits, 22);
  assert.equal(after.account.email, "facts@example.test");
});

test("fresh inference headers cannot renew retained model-scoped freshness", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = await fixture(t), payload = usage(); payload.limits[0].percent = 20;
  const previous = await f.feedback(payload);
  now += 301000;
  const headers = new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-5h-reset": future, "anthropic-ratelimit-unified-7d-utilization": "0.2", "anthropic-ratelimit-unified-7d-reset": future });
  await recordGrantRuntime(f.env, key, { ...observeGrantQuota({ status: 200, headers }, provider.quota), grantRevision: f.values.get(key).updatedAt });
  const retained = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.equal(retained.windows.find(window => window.models).observedAt, previous.observedAt);
  assert.equal(grantQuotaRatio(retained, now, 300000, "claude-fable-5-1"), null);
  assert.equal(grantQuotaRatio(retained, now, 300000, "claude-sonnet-5"), .8);
  for (const [model, available] of [["claude-fable-5-1", false], ["claude-sonnet-5", true]]) {
    const result = await resolveGrantSelection("anthropic", "pool", "tenant-pool", "anthropic", f.env, new Set(), routing({ staleState: "deny" }), null, false, undefined, requirement(model));
    assert.equal(!!result.selected, available);
  }
});

test("a first successful profile cannot qualify unknown quota after a throttled usage probe", async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async url => String(url).endsWith("/usage") ? new Response(null, { status: 429, headers: { "Retry-After": "600" } }) : Response.json({ account: { email: "first@example.test" } }));
  await refreshStoredGrantQuota(f.env, key);
  const runtime = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.equal(runtime.account.email, "first@example.test");
  assert.deepEqual(runtime.windows, []);
  const selection = await resolveGrantSelection("anthropic", "pool", "tenant-pool", "anthropic", f.env, new Set(), routing({ staleState: "deny" }), null, false, undefined, requirement("claude-sonnet-5"));
  assert.equal(selection.selected, null);
  const inventory = await handler.fetch(new Request("https://router.example/v1/admin/upstream-grants", { headers: { authorization: "Bearer synthetic-admin" } }), f.env, f.context);
  const row = (await inventory.json()).grants.find(row => row.key === key);
  assert.equal(row.quotaStatus, "unknown");
  assert.equal(row.quotaObservedAt, null);
});

test("replacement credentials do not inherit the prior revision's cooldown or facts", async t => {
  const f = await fixture(t); await f.feedback({ ...usage(), five_hour: { utilization: 100, resets_at: future } });
  await putGrantCredentials(f.env, key, { provider: "anthropic", kind: "subscription", enabled: true, accessToken: "synthetic-replacement", refreshToken: "synthetic-replacement-refresh", expiresAt: future, updatedAt: "2098-01-01T00:00:00.000Z" }, false, "replace");
  t.mock.method(globalThis, "fetch", async url => String(url).endsWith("/usage") ? new Response(null, { status: 429, headers: { "Retry-After": "600" } }) : Response.json({ account: { email: "replacement@example.test" } }));
  await refreshStoredGrantQuota(f.env, key);
  const state = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.equal(state.grantRevision, "2098-01-01T00:00:00.000Z");
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.status, "available");
  assert.deepEqual(state.windows, []);
  assert.equal(state.account.email, "replacement@example.test");
});

test("fail-closed quota requires a live observation applicable to the requested model", async t => {
  const f = await fixture(t);
  const state = await f.feedback({ limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 20, resets_at: future }] });
  assert.equal(grantQuotaRatio(state, Date.now(), 300000, "claude-sonnet-5"), null);
  const selection = model => resolveGrantSelection("anthropic", "pool", "tenant-pool", "anthropic", f.env, new Set(), routing({ staleState: "deny" }), null, false, undefined, requirement(model));
  assert.equal((await selection("claude-sonnet-5")).selected, null);
  assert.equal((await selection("claude-fable-5-1")).selected?.key, key);
  await f.feedback({ five_hour: { utilization: 0, resets_at: "2020-01-01T00:00:00Z" } });
  assert.equal((await selection("claude-sonnet-5")).selected, null);
});

test("environment pins can reuse fallback, while scoped pins cannot change lanes", async t => {
  const f = await fixture(t); await f.feedback();
  const pinned = await upstreamAuth(provider, f.auth, f.env, new Set(), null, false, { key: null, revision: null }, requirement("claude-sonnet-5"));
  assert.equal(pinned.grantLane, "environment");
  assert.equal(pinned.grantKey, null);
  await assert.rejects(upstreamAuth(provider, f.auth, f.env, new Set(), null, false, { key, revision: f.values.get(key).updatedAt }, requirement("claude-fable-5-1")), { code: "upstream_grant_pool_unavailable" });
  f.auth.policy.grantRouting.environmentFallback = false;
  await assert.rejects(upstreamAuth(provider, f.auth, f.env, new Set(), null, false, { key: null, revision: null }, requirement("claude-sonnet-5")), { code: "upstream_grant_pool_unavailable" });
});

test("a slow profile cannot overwrite newer inference quota or its active cooldown", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("/usage")) return Response.json(usage(20));
    now += 1000;
    const state = observeGrantQuota({ status: 429, headers: new Headers({ "Retry-After": "90", "anthropic-ratelimit-unified-5h-utilization": "1", "anthropic-ratelimit-unified-5h-reset": future }) }, provider.quota);
    await recordGrantRuntime(f.env, key, { ...state, grantRevision: f.values.get(key).updatedAt });
    return Response.json({ account: { email: "concurrent@example.test" } });
  });
  await refreshStoredGrantQuota(f.env, key);
  const state = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.equal(state.status, "cooldown");
  assert.equal(state.lastSignal, "rate_limited");
  assert.equal(state.cooldownUntil, new Date(now + 90000).toISOString());
  assert.equal(state.windows.find(window => window.id === "subscription-five-hour").remaining, 0);
  assert.equal(state.windows.find(window => window.models?.includes("fable")).remaining, 0);
  assert.equal(state.account.email, "concurrent@example.test");
});

test("late feedback from an older credential revision cannot erase current quota", async t => {
  const f = await fixture(t);
  const state = await f.feedback();
  await recordGrantRuntime(f.env, key, { ...state, observedAt: new Date(Date.now() + 1000).toISOString(), grantRevision: "2000-01-01T00:00:00.000Z", windows: [] });
  const retained = (await authorityCall(f.env, "/grant-pools/states", { keys: [key] })).states[key];
  assert.equal(retained.grantRevision, state.grantRevision);
  assert.equal(grantQuotaExhausted(retained, "claude-fable-5-1"), true);
});

async function clientKey(f) {
  await authorityCall(f.env, "/credentials/mutate", { scope: "admin", operation: "put", actor: { auth: "admin_token", role: "admin", email: "synthetic@example.test" }, credentialId: "client", credential: { enabled: true, policyId: "pool", secretSha256: await sha256Hex("synthetic-client") } });
  return { authorization: "Bearer clawrouter-live-client-synthetic-client", "content-type": "application/json" };
}

test("policy model admission denies native, manifest, OpenAI and Responses before budget or upstream", async t => {
  const f = await fixture(t), headers = await clientKey(f);
  Object.assign(f.auth.policy, { providers: ["anthropic", "openai"], models: ["anthropic/claude-opus-5-5"], monthlyBudgetMicros: 100 });
  await authorityCall(f.env, "/policies/put", { policyId: "pool", policy: f.auth.policy });
  f.env.BUDGET_LEDGER = { idFromName() { assert.fail("denied models cannot reserve budget"); } };
  t.mock.method(globalThis, "fetch", () => assert.fail("denied models cannot contact upstream"));
  for (const [path, body] of [
    ["/v1/messages", { model: "claude-sonnet-5", max_tokens: 1, messages: [] }],
    ["/v1/messages/count_tokens", { model: "anthropic/claude-sonnet-5", messages: [] }],
    ["/v1/native/anthropic/v1/messages", { model: "claude-sonnet-5", max_tokens: 1, messages: [] }],
    ["/v1/proxy/anthropic/messages", { body: { model: "claude-sonnet-5", max_tokens: 1, messages: [] } }],
    ["/v1/chat/completions", { model: "openai/gpt-5.6", messages: [] }],
    ["/v1/responses", { model: "openai/gpt-5.6", input: "synthetic" }],
    ["/v1/native/openai/v1/responses", { model: "gpt-5.6", input: "synthetic" }],
  ]) {
    const response = await handler.fetch(new Request(`https://router.example${path}`, { method: "POST", headers, body: JSON.stringify(body) }), f.env, f.context);
    assert.equal(response.status, 403, `${path}: ${await response.clone().text()}`);
    assert.equal((await response.json()).error.code, "model_not_allowed", path);
  }
  f.values.set("config/fusion", { enabled: true, aggregatorModel: "openai/gpt-5.6", adviserModels: ["openai/gpt-5.5"] });
  const fusion = await handler.fetch(new Request("https://router.example/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "clawrouter/fusion", messages: [{ role: "user", content: "synthetic" }] }) }), f.env, f.context);
  assert.equal(fusion.status, 403); assert.equal((await fusion.json()).error.code, "model_not_allowed");
  const { prepareSelected } = await import("../proxy.ts");
  const { concreteOpenAiSelection } = await import("../proxy-selection.ts");
  const selection = concreteOpenAiSelection("/v1/responses", { model: "openai/gpt-5.6", input: "synthetic" }, f.env);
  await assert.rejects(prepareSelected(new Request("https://router.example/v1/responses"), f.env, selection, {}, f.auth, new Set(), true, undefined, undefined, "websocket"), { status: 403, code: "model_not_allowed" });
  while (f.pending.length) await Promise.all(f.pending.splice(0));
});

test("null allowlist preserves native inference and Opus 5.5 uses its compiled price", async t => {
  const f = await fixture(t), headers = await clientKey(f);
  f.auth.policy.models = null;
  await authorityCall(f.env, "/policies/put", { policyId: "pool", policy: f.auth.policy });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, "claude-opus-5-5");
    return Response.json({ id: "synthetic", type: "message", content: [], usage: { input_tokens: 10, output_tokens: 1 } });
  });
  const response = await handler.fetch(new Request("https://router.example/v1/messages", { method: "POST", headers, body: JSON.stringify({ model: "anthropic/claude-opus-5-5", max_tokens: 1, messages: [] }) }), f.env, f.context);
  assert.equal(response.status, 200, await response.clone().text()); await response.text();
  while (f.pending.length) await Promise.all(f.pending.splice(0));
  const model = provider.models.find(model => model.id === "anthropic/claude-opus-5-5");
  assert.equal(model.pricing_ref, "anthropic-claude-opus-5-5-standard-2026-10-11");
  assert.deepEqual(model.pricing, { effectiveAt: "2026-10-11", source: "https://platform.claude.com/docs/en/about-claude/pricing", inputMicrosPerMillion: 4000000, cachedInputMicrosPerMillion: 200000, cacheWrite5mInputMicrosPerMillion: 5000000, cacheWrite1hInputMicrosPerMillion: 8000000, outputMicrosPerMillion: 20000000, maxInputTokens: 1000000, defaultMaxOutputTokens: 128000, cacheWriteInputMicrosPerMillion: null, maxRequestInputTokens: null, inputTokenOverhead: 1024, longContext: null });
});

test("pool is opt-in, scope-bound, explicitly projected, and shares scoped reserve eligibility", async t => {
  const f = await fixture(t), headers = await clientKey(f), queried = [];
  f.env.USAGE_LEDGER = { idFromName(name) { queried.push(name); return name; }, get() { return { async fetch(url) {
    assert.equal(new URL(url).searchParams.get("policy_id"), "pool");
    return Response.json({ days: 7, lanes: [{ provider: "anthropic", grantLane: "subscription", requests: 2 }], grants: [{ provider: "anthropic", grantKey: key, grantLane: "subscription", requests: 2 }] });
  } }; } };
  const request = (query = "") => new Request(`https://router.example/v1/pool${query}`, { headers });
  let response = await handler.fetch(request(), f.env, f.context);
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "pool_status_hidden"); assert.equal(queried.length, 0);
  Object.assign(f.auth.policy, { poolStatus: "visible", models: ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"] });
  f.auth.policy.grantRouting.includedQuotaReservePercent = 10;
  await authorityCall(f.env, "/policies/put", { policyId: "pool", policy: f.auth.policy });
  const state = await f.feedback();
  state.account = { email: "pool@example.test", rateLimitTier: "default_claude_max_20x", subscriptionStatus: "active" };
  state.extraUsage = { enabled: true, usedCredits: 12, monthlyLimit: 100, currency: "USD" };
  await recordGrantRuntime(f.env, key, state);
  await putGrantCredentials(f.env, "oauth/foreign/other", { enabled: true, kind: "subscription", provider: "anthropic", accessToken: "synthetic-foreign-secret" });
  response = await handler.fetch(request("?policyId=foreign"), f.env, f.context);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.version, "clawrouter.pool.v1"); assert.equal(body.policyId, "pool");
  assert.deepEqual(body.models, ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"]);
  assert.equal(body.grants.length, 1); assert.equal(body.grants[0].key, "claude");
  assert.equal(body.grants[0].plan, "Max 20x"); assert.equal(body.grants[0].account.email, "pool@example.test");
  assert.equal(body.grants[0].eligibility["anthropic/claude-opus-5-5"], "eligible");
  assert.equal(body.grants[0].eligibility["anthropic/claude-fable-5-1"], "exhausted");
  assert.equal(body.usage.grants[0].grantKey, "claude");
  assert.deepEqual([...new Set(queried)], ["policy:tenant-pool:pool"]);
  assert.doesNotMatch(JSON.stringify(body), /access.?token|refresh.?token|credentialFields|secret|synthetic|oauth\/|foreign|tokenType|clientId|accountId/i);
  await f.feedback(usage(90));
  const exhausted = await (await handler.fetch(request(), f.env, f.context)).json();
  assert.equal(exhausted.grants[0].eligibility["anthropic/claude-opus-5-5"], "exhausted");
});

test("Access sessions can read only held policy pools", async t => {
  const f = await fixture(t), token = "a".repeat(64), email = "pool-user@example.test";
  f.values.set(`local/sessions/${await sha256Hex(token)}`, { email, role: "user", expiresAtMs: Date.now() + 60000 });
  await authorityCall(f.env, "/users/put", { email, record: { enabled: true, role: "user", tenantId: "tenant-pool", groups: [] } });
  await authorityCall(f.env, "/mutate", { seed: { principal: { principalType: "user", principalId: email }, bindings: [] }, binding: { principalType: "user", principalId: email, policyId: "pool", enabled: true, priority: 1 } });
  f.auth.policy.poolStatus = "visible";
  await authorityCall(f.env, "/policies/put", { policyId: "pool", policy: f.auth.policy });
  f.env.USAGE_LEDGER = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ lanes: [], grants: [] }) }) };
  for (const [query, expected] of [["", 200], ["?policyId=pool", 200], ["?policyId=foreign", 403]]) {
    const response = await handler.fetch(new Request(`https://router.example/v1/pool${query}`, { headers: { cookie: `clawrouter_session=${token}` } }), f.env, f.context);
    assert.equal(response.status, expected, await response.clone().text());
    if (expected === 200) assert.equal((await response.json()).policyId, "pool");
  }
});
