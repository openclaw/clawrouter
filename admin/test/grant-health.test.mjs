import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { build } = require("esbuild");
// Render the actual component with React; bundle only to load its TSX in Node.
const result = await build({ entryPoints: [new URL("../src/grant-health.tsx", import.meta.url).pathname], bundle: true, write: false,
  format: "esm", platform: "node", jsx: "automatic", external: ["react", "react/jsx-runtime"], logLevel: "silent" });
const js = result.outputFiles[0].text.replace(/from "(react(?:\/jsx-runtime)?)"/g, (_, name) => "from " + JSON.stringify(import.meta.resolve(name)));
const { GrantRefreshHealth, GrantPoolIncidents, degradedPools } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const grant = { key: "oauth/pool/claude", scope: "policies", scopeId: "pool", tokenRef: "claude", provider: "anthropic", kind: "subscription", enabled: true, usable: true, credentialStatus: "active", hasRefreshToken: true, quotaWindows: [] };
const policy = { policyId: "pool", enabled: true, providers: ["anthropic"], grantRouting: { eligibleGrants: {}, staleAfterSeconds: 300, staleState: "allow" } };
const failure = { oauthError: "persistence_failed", httpStatus: 200, failureClass: "provider_ok_persist_failed", firstFailureAt: "2030-01-01T00:00:00Z", lastFailureAt: "2030-01-01T00:00:00Z", attemptCount: 1, nextRetryAt: "2030-01-01T00:00:30Z", settlement: { stage: "credential_write", code: "storage_unavailable", correlationId: "diagnostic-id" } };
const blocked = { ...grant, usable: false, refreshDiagnosis: { lastSuccessfulRefreshAt: null, failure } };
const render = row => renderToStaticMarkup(createElement(GrantRefreshHealth, { grant: row }));
test("retained successful result shows local recovery, not healthy or mandatory reauthorization", () => {
  const html = render(blocked);
  assert.match(html, /Local settlement pending/);
  assert.match(html, /credential_write.*storage_unavailable.*diagnostic-id/);
  assert.match(html, /Next local retry/);
  assert.doesNotMatch(html, /Refresh healthy|Replace with credentials/);
});
test("truly lost and ambiguous outcomes name dedicated-login repair, not a fictional retry", () => {
  for (const value of [{ ...failure, nextRetryAt: null }, { ...failure, failureClass: "ambiguous", settlement: undefined, nextRetryAt: null }]) {
    const html = render({ ...blocked, refreshDiagnosis: { failure: value } });
    assert.match(html, /automatic replay stopped/);
    assert.match(html, /Replace with credentials/);
    assert.doesNotMatch(html, /Next local retry|Local settlement pending|Refresh healthy/);
  }
});
test("pool counts blocked local recovery separately from permanent reauthorization", () => {
  const healthy = { ...grant, key: "oauth/pool/healthy", tokenRef: "healthy" };
  const incidents = degradedPools([policy], [blocked, healthy]);
  assert.equal(incidents[0].usable, 1);
  assert.equal(incidents[0].reauth.length, 0);
  assert.equal(incidents[0].blocked.length, 1);
  const html = renderToStaticMarkup(createElement(GrantPoolIncidents, { policies: [policy], grants: [blocked, healthy], ready: true, error: "", onOpenGrant() {} }));
  assert.match(html, /1\/2 grants eligible/);
  assert.match(html, /1 refresh-blocked/);
  assert.match(html, /0 require reauthorization/);
});
test("healthy refresh, setup-token and unavailable states remain distinct", () => {
  assert.match(render(grant), /Refresh healthy/);
  assert.equal(render({ ...grant, hasRefreshToken: false }), "");
  assert.doesNotMatch(render({ ...grant, usable: false }), /Refresh healthy/);
  assert.match(render({ ...grant, credentialStatus: "reauth_required", usable: false }), /Reauth required/);
});
