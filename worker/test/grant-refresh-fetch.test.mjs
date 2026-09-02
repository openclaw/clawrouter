import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { refreshStoredGrant } from "../providers.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

function grantEnv(key, grant, stored = {}) {
  return attachGrantCredentialNamespace({
    stored,
    POLICY_KV: {
      async get(requested) {
        return requested === key ? structuredClone(stored[requested] ?? grant) : null;
      },
      async put(requested, value) {
        stored[requested] = JSON.parse(value);
      },
    },
  });
}

function expiredGrant(tokenUrl) {
  return {
    version: 1,
    enabled: true,
    provider: "openai",
    kind: "subscription",
    accessToken: "dummy",
    refreshToken: "placeholder",
    expiresAt: "2020-01-01T00:00:00.000Z",
    refresh: { tokenUrl },
  };
}

function isRefreshFailed(error) {
  return error?.code === "grant_refresh_failed" && error?.status === 502;
}

test("grant refresh aborts a hung tokenUrl and maps it to grant_refresh_failed", { timeout: 2_000 }, async (context) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const tokenUrl = `http://127.0.0.1:${port}/oauth/token`;
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeouts = [];
  context.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    return nativeTimeout(40);
  });

  const key = "oauth/policy/openai";
  const env = grantEnv(key, expiredGrant(tokenUrl));
  try {
    await assert.rejects(() => refreshStoredGrant(env, key), isRefreshFailed);
    assert.deepEqual(timeouts, [30_000]);
    assert.equal(env.stored[key], undefined);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("grant refresh timeout uses the existing grant_refresh_failed path", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const key = "oauth/policy/openai";
  const env = grantEnv(key, expiredGrant("https://token.example/oauth/token"));
  await assert.rejects(() => refreshStoredGrant(env, key), isRefreshFailed);
  assert.equal(env.stored[key], undefined);
});

test("grant refresh attaches a 30s AbortSignal and stores a successful token response", async (context) => {
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
    return Response.json({ access_token: "example", refresh_token: "sample", token_type: "Bearer", expires_in: 3600 });
  });

  const key = "oauth/policy/openai";
  const env = grantEnv(key, expiredGrant("https://token.example/oauth/token"));
  const updated = await refreshStoredGrant(env, key);
  assert.equal(tokenInit.method, "POST");
  assert.ok(tokenInit.signal instanceof AbortSignal);
  assert.equal(tokenInit.signal.aborted, false);
  assert.deepEqual(timeouts, [30_000]);
  assert.equal(updated.accessToken, "example");
  assert.equal(updated.refreshToken, "sample");
  assert.equal(env.stored[key].accessToken, undefined);
  assert.equal(env.stored[key].hasAccessToken, true);
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").accessToken, "example");
});
