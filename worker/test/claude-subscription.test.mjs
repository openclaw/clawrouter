import assert from "node:assert/strict";
import test from "node:test";
import { putGrantCredentials } from "../grant-credentials.ts";
import { observeGrantQuotaProbe } from "../grant-quota.ts";
import { applyProviderCredential, applyTransportHeaders, quotaProbeForGrant, transformTransportBody, transportForGrant } from "../provider-auth.ts";
import { snapshot } from "../providers.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

const anthropic = snapshot.providers.find((provider) => provider.id === "anthropic");

test("Claude subscription transport uses OAuth identity without changing API-key grants", () => {
  assert.ok(anthropic);
  const subscription = { provider: "anthropic", kind: "subscription", accessToken: "claude-oauth-fixture" };
  const transport = transportForGrant(anthropic, subscription);
  assert.equal(transport.maintenance.keepWarm.defaultEnabled, true);
  assert.ok(quotaProbeForGrant(anthropic, { provider: "anthropic", kind: "subscription", accessToken: "refreshable", refreshToken: "refresh" }));
  assert.equal(quotaProbeForGrant(anthropic, subscription), null, "inference-only setup tokens do not select the refresh-token usage probe");
  const oauthHeaders = new Headers({ "anthropic-beta": "interleaved-thinking-2025-05-14" });
  applyProviderCredential(anthropic, subscription, {}, oauthHeaders, new URLSearchParams());
  applyTransportHeaders(oauthHeaders, transport, subscription);
  assert.equal(oauthHeaders.get("authorization"), "Bearer claude-oauth-fixture");
  assert.equal(oauthHeaders.has("x-api-key"), false);
  assert.equal(oauthHeaders.get("anthropic-beta"), "interleaved-thinking-2025-05-14,claude-code-20250219,oauth-2025-04-20");
  assert.equal(oauthHeaders.get("x-app"), "cli");

  const body = transformTransportBody(transport, { model: "claude-sonnet-5", messages: [{ role: "user", content: "fixture" }], system: "operator system" });
  assert.deepEqual(body.system.map((block) => block.text), [
    "x-anthropic-billing-header: cc_version=2.1.75; cc_entrypoint=sdk-cli;",
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "operator system",
  ]);
  assert.equal(JSON.stringify(transformTransportBody(transport, body)), JSON.stringify(body), "trusted system blocks are idempotent");

  const apiHeaders = new Headers();
  applyProviderCredential(anthropic, { provider: "anthropic", kind: "api_key", credential: "anthropic-api-key-fixture" }, {}, apiHeaders, new URLSearchParams());
  assert.equal(apiHeaders.get("x-api-key"), "anthropic-api-key-fixture");
  assert.equal(apiHeaders.has("authorization"), false);
});

test("Claude usage payload maps five-hour, weekly, and model windows without retaining the payload", () => {
  const probe = anthropic.quota.probes.find((candidate) => candidate.grantKinds.includes("subscription"));
  const state = observeGrantQuotaProbe({
    five_hour: { utilization: 91, resets_at: "2026-09-02T18:00:00Z" },
    seven_day: { utilization: 35, resets_at: "2026-09-07T18:00:00Z" },
    seven_day_sonnet: { utilization: 74, resets_at: "2026-09-07T18:00:00Z" },
    private_detail: "must-not-survive",
  }, probe, Date.parse("2026-09-02T17:00:00Z"));
  assert.deepEqual(state.windows.map(({ id, remaining, limit }) => ({ id, remaining, limit })), [
    { id: "subscription-five-hour", remaining: 9, limit: 100 },
    { id: "subscription-seven-day", remaining: 65, limit: 100 },
    { id: "subscription-seven-day-sonnet", remaining: 26, limit: 100 },
  ]);
  assert.equal(JSON.stringify(state).includes("must-not-survive"), false);
});

test("Claude credential alarms poll quota and keep warm only when explicitly enabled", async (context) => {
  const key = "oauth/policy/claude-primary";
  const values = new Map();
  const feedback = [];
  const env = attachGrantCredentialNamespace({
    POLICY_KV: {
      async get(requested) { return structuredClone(values.get(requested) ?? null); },
      async put(requested, value) { values.set(requested, JSON.parse(value)); },
    },
    ACCESS_CONTROL: {
      idFromName(name) { return name; },
      get() {
        return { async fetch(url, init) {
          const path = new URL(url).pathname, body = JSON.parse(init.body);
          if (path === "/grant-pools/states") return Response.json({ states: {} });
          if (path === "/grant-pools/feedback") { feedback.push(body); return new Response("updated"); }
          return new Response("not found", { status: 404 });
        } };
      },
    },
  });
  await putGrantCredentials(env, key, {
    provider: "anthropic",
    kind: "subscription",
    accessToken: "claude-alarm-fixture",
    refreshToken: "claude-refresh-fixture",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    maintenance: { keepWarm: false },
    updatedAt: "2026-09-02T17:00:00.000Z",
  });
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  assert.ok(owner.alarm() > Date.now());
  const record = owner.values.get("credential");
  record.nextQuotaProbeAt = "2020-01-01T00:00:00.000Z";
  record.nextKeepWarmAt = "2020-01-01T00:00:00.000Z";
  owner.values.set("credential", record);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://api.anthropic.com/api/oauth/usage");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer claude-alarm-fixture");
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
    return Response.json({ five_hour: { utilization: 40, resets_at: "2026-09-02T18:00:00Z" }, seven_day: { utilization: 20, resets_at: "2026-09-07T18:00:00Z" } });
  });
  await owner.object.alarm();
  assert.equal(calls, 1, "disabled keep-warm never sends an inference request");
  assert.equal(feedback.length, 1);
  assert.deepEqual(feedback[0].state.windows.map(({ remaining }) => remaining), [60, 80]);

  const enabledKey = "oauth/policy/claude-warm";
  await putGrantCredentials(env, enabledKey, {
    provider: "anthropic",
    kind: "subscription",
    accessToken: "claude-warm-fixture",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    maintenance: { keepWarm: true },
    updatedAt: "2026-09-02T17:00:00.000Z",
  });
  const warmOwner = env.GRANT_CREDENTIALS.objects.get(enabledKey);
  const warmRecord = warmOwner.values.get("credential");
  assert.equal(warmRecord.nextQuotaProbeAt, null, "access-only setup tokens do not schedule the refresh-token usage probe");
  warmRecord.nextQuotaProbeAt = new Date(Date.now() + 60 * 60_000).toISOString();
  warmRecord.nextKeepWarmAt = "2020-01-01T00:00:00.000Z";
  warmOwner.values.set("credential", warmRecord);
  context.mock.restoreAll();
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), "https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer claude-warm-fixture");
    assert.match(headers.get("anthropic-beta"), /oauth-2025-04-20/);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages, [{ role: "user", content: "." }]);
    assert.equal(body.system[0].text, "x-anthropic-billing-header: cc_version=2.1.75; cc_entrypoint=sdk-cli;");
    return Response.json({ content: [] });
  });
  await warmOwner.object.alarm();
  assert.equal(warmOwner.values.get("credential").nextQuotaProbeAt, null, "legacy scheduled probes are cleared for setup tokens");
});
