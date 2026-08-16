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
