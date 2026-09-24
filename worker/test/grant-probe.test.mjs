import assert from "node:assert/strict";
import test from "node:test";
import { refreshStoredGrantQuota } from "../providers.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

test("subscription quota probes authenticate, bound, and persist provider-neutral state", async (context) => {
  const key = "oauth/policy/openai-subscription";
  const feedback = [];
  const grant = {
    version: 1,
    enabled: true,
    provider: "openai",
    kind: "subscription",
    accessToken: "fixture",
    accountId: "account-test",
    updatedAt: "2026-07-07T10:00:00.000Z",
  };
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture");
    assert.equal(headers.get("chatgpt-account-id"), "account-test");
    assert.equal(headers.get("user-agent"), "codex-cli");
    return Response.json({
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: 1783425600 },
        secondary_window: { used_percent: 80, reset_at: 1783944000 },
      },
      credits: { balance: 12.5 },
      ignored_private_field: "not persisted",
    });
  });
  const env = attachGrantCredentialNamespace({
    POLICY_KV: { async get(requested) { return requested === key ? structuredClone(grant) : null; }, async put() {} },
    ACCESS_CONTROL: {
      idFromName(name) { return name; },
      get() {
        return { async fetch(url, init) {
          assert.equal(new URL(url).pathname, "/grant-pools/feedback");
          feedback.push(JSON.parse(init.body));
          return new Response("updated");
        } };
      },
    },
  });

  await refreshStoredGrantQuota(env, key);

  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].key, key);
  assert.equal(feedback[0].state.source, "provider_probe");
  assert.equal(feedback[0].state.grantRevision, grant.updatedAt);
  assert.deepEqual(feedback[0].state.windows.map(({ id, remaining, limit }) => ({ id, remaining, limit })), [
    { id: "subscription-primary", remaining: 75, limit: 100 },
    { id: "subscription-secondary", remaining: 20, limit: 100 },
    { id: "credits", remaining: 12.5, limit: null },
  ]);
  assert.equal(JSON.stringify(feedback[0]).includes("ignored_private_field"), false);
  assert.equal(JSON.stringify(feedback[0]).includes("fixture"), false);
});

test("quota probes fail before fetch when required grant metadata is absent", async (context) => {
  let fetched = false;
  context.mock.method(globalThis, "fetch", async () => { fetched = true; return Response.json({}); });
  const env = attachGrantCredentialNamespace({
    POLICY_KV: { async get() { return { provider: "openai", kind: "subscription", accessToken: "test", updatedAt: "2026-07-07T10:00:00.000Z" }; }, async put() {} },
  });
  await assert.rejects(() => refreshStoredGrantQuota(env, "oauth/policy/openai"), (error) => error?.code === "grant_quota_probe_unavailable");
  assert.equal(fetched, false);
});

test("manual quota refresh rejects expiry crossed after owner materialization", async context => {
  let now = Date.parse("2026-09-24T12:00:00Z");
  context.mock.method(Date, "now", () => now);
  const key = "oauth/policy/openai", values = new Map();
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    async get(key, type) { const value = values.get(key) ?? null; return value !== null && type === "text" ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } });
  const { putGrantCredentials } = await import("../grant-credentials.ts");
  await putGrantCredentials(env, key, { provider: "openai", kind: "subscription", accessToken: "quota-fixture", accountId: "account-fixture", expiresAt: new Date(now + 10).toISOString() });
  const get = env.GRANT_CREDENTIALS.get;
  env.GRANT_CREDENTIALS.get = id => ({ fetch: async (url, init) => {
    const response = await get(id).fetch(url, init);
    if (new URL(url).pathname === "/materialize") now += 11;
    return response;
  } });
  context.mock.method(globalThis, "fetch", async () => assert.fail("expired manual quota egress"));
  await assert.rejects(() => refreshStoredGrantQuota(env, key), error => error.code === "grant_refresh_failed");
});
