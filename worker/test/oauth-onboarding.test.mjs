import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === new URL("../oauth.ts", import.meta.url).href && ["./access", "./authority"].includes(specifier)) {
      return { shortCircuit: true, url: new URL("./oauth-onboarding.mocks.mjs", import.meta.url).href };
    }
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { startOAuth, oauthCallback } = await import("../oauth.ts");
const { providerById } = await import("../providers.ts");

test("bundled OpenAI rejects browser onboarding before creating state or contacting the provider", async (context) => {
  context.mock.method(globalThis, "fetch", () => assert.fail("unsupported onboarding must not contact the provider"));
  for (const origin of ["https://router.example.com", "https://clawrouter.openclaw.ai", "http://localhost:8787"]) {
    const env = { calls: [] };
    const response = await startOAuth(new Request(`${origin}/v1/admin/upstream-grants/policies/test/openai/authorize`), env, "oauth/test/openai", "openai", 100, 1);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "oauth_not_supported");
    assert.deepEqual(env.calls, []);
  }
});

test("an outstanding OpenAI callback cannot exchange a code after browser onboarding is withdrawn", async (context) => {
  context.mock.method(globalThis, "fetch", () => assert.fail("withdrawn onboarding must not exchange a code"));
  const env = { calls: [], state: { provider: "openai" } };
  const response = await oauthCallback(new Request("https://router.example.com/v1/oauth/callback?state=old-state&code=synthetic-code"), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "oauth_not_supported");
  assert.deepEqual(env.calls.map(({ path }) => path), ["/oauth-states/consume"]);
});

test("custom manifest-declared OAuth flows retain origin-bound PKCE onboarding", async (context) => {
  const provider = providerById("anthropic");
  const previous = provider.auth.authorization;
  context.after(() => { provider.auth.authorization = previous; });
  provider.auth.authorization = {
    authorizeUrl: "https://provider.example/authorize", clientId: "synthetic-client",
    scopes: ["inference"], extraAuthorizeParams: {},
  };
  const env = { calls: [] };
  const response = await startOAuth(new Request("https://router.example.com/v1/admin/upstream-grants/policies/test/anthropic/authorize"), env, "oauth/test/anthropic", "anthropic", 25, 2);
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).authorizationUrl);
  assert.equal(url.searchParams.get("redirect_uri"), "https://router.example.com/v1/oauth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(env.calls[0].path, "/oauth-states/put");
  assert.equal(url.searchParams.get("state"), env.calls[0].body.state);
  assert.equal(env.calls[0].body.grantKey, "oauth/test/anthropic");
});

test("OpenAI API-key routing and the existing stored-grant transport contract remain available", () => {
  const openai = providerById("openai");
  assert.equal(openai.auth.authorization, null);
  assert.equal(openai.base_urls.default, "https://api.openai.com");
  assert.equal(openai.auth.schemes[0].secretKind, "api_key");
  assert.equal(openai.auth.grantTransports.subscription.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(openai.auth.refresh.tokenUrl, "https://auth.openai.com/oauth/token");
});
