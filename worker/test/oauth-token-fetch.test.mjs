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
