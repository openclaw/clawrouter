import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

// OAuth's browser identity/provider fixture supplies configuration only. Fetch
// is mocked here solely to observe body cancellation; workerd covers real egress.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === new URL("../oauth.ts", import.meta.url).href && ["./access", "./authority", "./providers"].includes(specifier)) {
    return { shortCircuit: true, url: new URL("./oauth-token-fetch.mocks.mjs", import.meta.url).href };
  }
  if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });
const { oauthCallback } = await import("../oauth.ts");
const { materializeGrantCredentials, putGrantCredentials, refreshGrantQuota } = await import("../grant-credentials.ts");
const { attachGrantCredentialNamespace } = await import("./grant-credential-mock.mjs");

function credentialEnv() {
  const values = new Map();
  return attachGrantCredentialNamespace({ POLICY_KV: {
    async get(key, type) { const value = values.get(key); return value === undefined ? null : type === "text" ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } });
}
function redirectBody(t) {
  let cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":"invalid_grant"}')); },
    cancel() { cancelled++; },
  }), { status: 307, headers: { location: "https://redirect.example/target" } }));
  return () => assert.equal(cancelled, 1, "discarded redirect body is cancelled, not parsed or left open");
}

for (const operation of ["refresh", "quota", "keep-warm"]) test(`${operation} cancels a non-terminating redirect body without waiting for EOF`, { timeout: 2000 }, async t => {
  const cancelled = redirectBody(t), env = credentialEnv(), key = "oauth/fixture/redirect";
  const grant = await putGrantCredentials(env, key, {
    provider: operation === "keep-warm" ? "anthropic" : "openai", kind: "subscription", enabled: true,
    accessToken: "fixture-access", refreshToken: "fixture-refresh", accountId: "fixture-account",
    expiresAt: new Date(Date.now() + 3600000).toISOString(), maintenance: { keepWarm: operation === "keep-warm" },
  });
  if (operation === "refresh") await assert.rejects(() => materializeGrantCredentials(env, key, grant, "openai", { tokenUrl: "https://token.example/token" }, true), error => error.code === "grant_refresh_failed");
  else if (operation === "quota") await assert.rejects(() => refreshGrantQuota(env, key), error => error.code === "grant_quota_probe_failed");
  else {
    const owner = env.GRANT_CREDENTIALS.objects.get(key), record = owner.values.get("credential");
    record.nextKeepWarmAt = new Date(Date.now() - 1000).toISOString();
    record.nextQuotaProbeAt = new Date(Date.now() + 3600000).toISOString();
    await owner.object.alarm();
    assert.ok(Date.parse(owner.values.get("credential").nextKeepWarmAt) > Date.now());
  }
  cancelled();
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").status, "active");
});

test("OAuth callback cancels a non-terminating redirect body without waiting for EOF", { timeout: 2000 }, async t => {
  const cancelled = redirectBody(t);
  const response = await oauthCallback(new Request("https://console.example/v1/oauth/callback?state=state-1&code=fixture-code"), {});
  assert.equal(response.status, 400); assert.match(await response.text(), /Provider token exchange failed/);
  cancelled();
});
