import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { default: worker } = await import("../private-entry.ts");
const { sha256Hex } = await import("../utils.ts");

test("dedicated private Worker does not expose shared routes or read secrets for them", async () => {
  const env = { PRIVATE_CODEX_POLICY: { get() { assert.fail("shared routes must not resolve private bindings"); } } };
  for (const path of ["/", "/v1/health", "/v1/models", "/v1/catalog", "/v1/admin/bootstrap", "/v1/usage", "/v1/responses"]) {
    const response = await worker.fetch(new Request(`https://private.invalid${path}`), env);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "route_not_found");
  }
});

test("dedicated private Worker authenticates before exposing alias discovery", async () => {
  const credential = "private-workload-SYNTHETIC_ENTRY_CREDENTIAL_123456789";
  const policy = { version: 1, enabled: true, alias: { id: "internal", name: "Codex" }, auth: { mode: "workload", credentialSha256: await sha256Hex(credential) } };
  let upstreamReads = 0;
  const env = {
    PRIVATE_CODEX_POLICY: { get: async () => JSON.stringify(policy) },
    PRIVATE_CODEX_UPSTREAM: { get: async () => { upstreamReads++; return JSON.stringify({ version: 1, target: "SYNTHETIC_PRIVATE_TARGET", accountId: "SYNTHETIC_ACCOUNT", accessToken: "SYNTHETIC_SUBSCRIPTION_TOKEN", expiresAt: Date.now() + 3600_000 }); } },
  };
  const url = "https://private.invalid/private/v1/models";
  assert.equal((await worker.fetch(new Request(url), env)).status, 404); assert.equal(upstreamReads, 0);
  const response = await worker.fetch(new Request(url, { headers: { authorization: `Bearer ${credential}` } }), env);
  assert.equal(response.status, 200);
  const body = await response.text(); assert.doesNotMatch(body, /SYNTHETIC/);
  assert.equal(JSON.parse(body).data[0].id, "internal"); assert.equal(upstreamReads, 1);
});
