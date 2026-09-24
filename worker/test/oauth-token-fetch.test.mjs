import assert from "node:assert/strict";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === pathToFileURL(new URL("../oauth.ts", import.meta.url).pathname).href) {
      if (specifier === "./access" || specifier === "./authority" || specifier === "./providers" || specifier === "./grant-selection") {
        return { shortCircuit: true, url: new URL("./oauth-token-fetch.mocks.mjs", import.meta.url).href };
      }
    }
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { oauthCallback } = await import("../oauth.ts");
const { attachGrantCredentialNamespace } = await import("./grant-credential-mock.mjs");

test("OAuth token exchange aborts a hung tokenUrl instead of stalling the callback", async (context) => {
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(ms);
  });
  let tokenInit;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), "https://token.example/oauth/token");
    tokenInit = init;
    return Response.json({ error: "temporarily_unavailable" }, { status: 504 });
  });

  const response = await oauthCallback(new Request("https://console.example/v1/oauth/callback?state=state-1&code=auth-code"), {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Provider token exchange failed/);
  assert.equal(tokenInit.method, "POST");
  assert.ok(tokenInit.signal instanceof AbortSignal);
  assert.equal(tokenInit.signal.aborted, false);
  assert.deepEqual(timeouts, [30_000]);
});

test("OAuth token timeout returns the connection-failed page instead of throwing", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  const response = await oauthCallback(new Request("https://console.example/v1/oauth/callback?state=state-1&code=auth-code"), {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Provider token exchange failed/);
});

test("OAuth token exchange cannot recover corrupt legacy metadata through ordinary owner PUT", async (context) => {
  const key = "oauth/policy/openai", raw = '{"accessToken":"legacy-private",';
  let writes = 0;
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    // A stale discovery projection cannot grant the later owner read permission
    // to discard corruption or use the administrator's replacement operation.
    async get(_key, type) { return type === "text" ? raw : { provider: "openai", kind: "oauth" }; },
    async put() { writes += 1; },
  } });
  context.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "fresh-private" }));
  await assert.rejects(() => oauthCallback(new Request("https://console.example/v1/oauth/callback?state=state-1&code=auth-code"), env), error => error.code === "invalid_upstream_grant");
  assert.equal(writes, 0);
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.has("credential"), false);
});

for (const [label, expiry] of [["omitted", undefined], ["positive", 3600], ["zero", 0], ["malformed", "bad"], ["unrepresentable", Number.MAX_VALUE]]) test(`callback installs canonical ${label} expiry before reporting connection outcome`, async context => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  context.mock.method(Date, "now", () => now);
  const key = "oauth/policy/openai", values = new Map();
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    async get(key, type) { const value = values.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } });
  const { putGrantCredentials } = await import("../grant-credentials.ts");
  await putGrantCredentials(env, key, { provider: "openai", kind: "oauth", accessToken: "old-fixture", refreshToken: "retained-refresh-fixture", expiresAt: "2020-01-01T00:00:00Z" });
  context.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "callback-access-fixture", ...(expiry === undefined ? {} : { expires_in: expiry }) }));
  const response = await oauthCallback(new Request("https://console.example/v1/oauth/callback?state=state-1&code=auth-code"), env);
  const page = await response.text(), own = env.GRANT_CREDENTIALS.objects.get(key), record = own.values.get("credential");
  const denied = !["omitted", "positive"].includes(label);
  assert.equal(response.status, denied ? 400 : 200);
  assert.match(page, denied ? /Connection failed/ : /Connected/);
  assert.equal(record.accessToken, "callback-access-fixture");
  assert.equal(record.refreshToken, "retained-refresh-fixture");
  assert.equal(record.expiresAt, label === "positive" ? new Date(now + 3_600_000).toISOString() : label === "zero" ? new Date(now).toISOString() : null);
  assert.equal(record.tokenResponseError, ["malformed", "unrepresentable"].includes(label) ? "invalid_expiry" : null);
  assert.equal(record.nextRefreshAttemptAt, denied ? new Date(now + 300_000).toISOString() : null);
  assert.equal(values.get(key).tokenResponseError, record.tokenResponseError);
  assert.doesNotMatch(JSON.stringify([page, values.get(key)]), /callback-access-fixture|retained-refresh-fixture/);
});


for (const current of ["rotated", "cleared", "unowned"]) for (const returned of [false, true]) test(`callback ${returned ? "explicit" : "omitted"} refresh retains ${current} owner provenance over raw KV`, async context => {
  const now = Date.parse("2026-09-24T12:00:00Z"), key = "oauth/policy/openai";
  context.mock.method(Date, "now", () => now);
  const legacy = { provider: "openai", kind: "oauth", accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture", tokenType: "Custom", scopes: ["kept"], expiresAt: new Date(now + 3_600_000).toISOString() };
  const values = new Map([[key, legacy]]);
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    async get(key, type) { const value = values.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } });
  const { materializeGrantCredentials, putGrantCredentials } = await import("../grant-credentials.ts");
  let callback = false;
  context.mock.method(globalThis, "fetch", async () => Response.json(callback
    ? { access_token: "callback-access-fixture", ...(returned ? { refresh_token: "callback-refresh-fixture" } : {}) }
    : { access_token: "rotated-access-fixture", refresh_token: "rotated-refresh-fixture", expires_in: "bad" }));
  const put = env.POLICY_KV.put;
  if (current !== "unowned") {
    env.POLICY_KV.put = async () => { throw new Error("fixture KV publication failure"); };
    await assert.rejects(() => current === "cleared"
      ? putGrantCredentials(env, key, { ...legacy, accessToken: "rotated-access-fixture", refreshToken: null })
      : materializeGrantCredentials(env, key, legacy, "openai", { tokenUrl: "https://token.example/refresh" }, true));
    if (current === "cleared") assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").refreshToken, null);
    assert.deepEqual(values.get(key), legacy);
    env.POLICY_KV.put = put;
  }
  callback = true;
  const response = await oauthCallback(new Request("https://console.example/v1/oauth/callback?state=state-1&code=auth-code"), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Connected/);
  const record = env.GRANT_CREDENTIALS.objects.get(key).values.get("credential");
  assert.equal(record.accessToken, "callback-access-fixture");
  assert.equal(record.refreshToken, returned ? "callback-refresh-fixture" : current === "unowned" ? "old-refresh-fixture" : current === "cleared" ? null : "rotated-refresh-fixture");
  assert.equal(record.expiresAt, null);
  assert.equal(record.tokenResponseError, null);
  assert.equal(record.nextRefreshAttemptAt, null);
  if (current !== "unowned") { assert.equal(record.tokenType, "Custom"); assert.deepEqual(record.scopes, ["kept"]); }
});
