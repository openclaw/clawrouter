import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const port = await availablePort();
const config = `.wrangler.local-e2e-${process.pid}.toml`;
const persistence = `.wrangler/e2e-${process.pid}`;
const adminToken = "local-e2e-admin-token";
const proxySecret = "secret_1234";
const proxyKey = `clawrouter-live-migrate-${proxySecret}`;
const legacySecret = "legacy_secret_1234";
const legacyKey = `clawrouter-live-legacy-${legacySecret}`;
const generation = "migration_e2e";
writeFileSync(config, `${readFileSync("wrangler.toml", "utf8").trim()}\n\n[[kv_namespaces]]\nbinding = "POLICY_KV"\nid = "local-e2e"\n`);
mkdirSync(persistence, { recursive: true });
putLocalKv("policies/migrate", { enabled: true, generation, providers: ["firecrawl", "replicate"], tenantId: "default", tokenRole: "service", monthlyBudgetMicros: 10_000, requestCostMicros: 100, retainRequestContent: true });
putLocalKv("credentials/migrate", { enabled: true, secretSha256: sha256(proxySecret), policyId: "migrate", policyGeneration: generation });
putLocalKv("keys/legacy", { enabled: true, secretSha256: sha256(legacySecret), generation: "legacy", providers: ["firecrawl"], tenantId: "default", retainRequestContent: true });
putLocalKv("oauth/migrate/legacy_invalid", { provider: "aws-bedrock", kind: "api_key", credentials: Object.fromEntries([["access" + "KeyId", "local"], ["secret" + "AccessKey", "   "]]) });

const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistence, "--config", config, "--var", `CLAWROUTER_ADMIN_TOKEN_SHA256:${sha256(adminToken)}`, "--var", "AWS_REGION:us-east-1", "--var", "AWS_SESSION_TOKEN:", "--log-level", "info"], {
  cwd: process.cwd(),
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12_000); });

try {
  const base = `http://127.0.0.1:${port}`;
  await waitUntilReady(`${base}/v1/health`);
  const health = await json(`${base}/v1/health`);
  assert.deepEqual(health, { ok: true, service: "clawrouter-edge", runtime: "typescript" });
  const providers = await json(`${base}/v1/providers`);
  assert.equal(providers.providers.length, 20);
  assert.equal(new Set(providers.providers.map((provider) => provider.id)).size, 20);
  const routes = await json(`${base}/v1/routes`);
  assert.ok(routes.openaiCompatible.some((route) => route.provider === "openai"));
  assert.ok(routes.manifestProxy.some((route) => route.provider === "anthropic" && route.endpoint === "count_tokens"));
  const preflight = await fetch(`${base}/v1/chat/completions`, { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-stainless-retry-count,x-stainless-timeout,x-stainless-runtime" } });
  assert.equal(preflight.status, 204);
  for (const header of ["x-stainless-retry-count", "x-stainless-timeout", "x-stainless-runtime"]) assert.ok(preflight.headers.get("access-control-allow-headers")?.includes(header));
  const root = await fetch(base, { redirect: "manual" });
  assert.equal(root.status, 302); assert.equal(root.headers.get("location"), "/dashboard");
  const dashboard = await fetch(`${base}/dashboard/home`);
  assert.equal(dashboard.status, 401);
  assert.equal((await dashboard.json()).error.code, "access_session_required");
  const inspection = await fetch(`${base}/v1/key/inspect`, { headers: { authorization: `Bearer ${proxyKey}` } });
  const inspectionBody = await inspection.json();
  assert.equal(inspection.status, 200, JSON.stringify(inspectionBody));
  assert.equal(inspectionBody.verification, "verified", "KV-only credential migrates into authority on first use");
  const lowercaseAdminAuth = await fetch(`${base}/v1/admin/overview`, { headers: { authorization: `bearer ${adminToken}` } });
  assert.equal(lowercaseAdminAuth.status, 200, "HTTP bearer auth scheme matching is case-insensitive");
  const bootstrap = await fetch(`${base}/v1/admin/bootstrap`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(bootstrap.status, 200);
  const bootstrapBody = await bootstrap.json();
  assert.ok(bootstrapBody.policies.some((policy) => policy.policyId === "migrate"));
  assert.ok(bootstrapBody.credentials.some((credential) => credential.credentialId === "migrate"));
  assert.ok(bootstrapBody.policies.some((policy) => policy.policyId === "legacy"));
  assert.ok(bootstrapBody.credentials.some((credential) => credential.credentialId === "legacy"));
  assert.equal(bootstrapBody.providers.length, 20);
  assert.equal(new Set(bootstrapBody.providers.map((provider) => provider.id)).size, 20);
  const legacyInvalidGrant = bootstrapBody.grants.find((entry) => entry.tokenRef === "legacy_invalid");
  assert.equal(legacyInvalidGrant.hasCredential, false, "stored empty credential bundles are not reported as configured");
  assert.deepEqual(legacyInvalidGrant.credentialFields, []);
  assert.equal(legacyInvalidGrant.usable, false);
  const legacyInspection = await fetch(`${base}/v1/key/inspect`, { headers: { authorization: `Bearer ${legacyKey}` } });
  assert.equal(legacyInspection.status, 200, "bootstrap imports genuine combined legacy keys before setting migration markers");
  const clientCatalog = await fetch(`${base}/v1/catalog`, { headers: { authorization: `Bearer ${proxyKey}` } });
  assert.equal(clientCatalog.status, 200);
  assert.deepEqual((await clientCatalog.json()).providers.map((provider) => provider.id), ["firecrawl", "replicate"]);
  const mismatch = await fetch(`${base}/v1/proxy/firecrawl/scrape`, { method: "POST", headers: { authorization: `Bearer ${proxyKey}`, "content-type": "application/json" }, body: JSON.stringify({ body: { model: "openai/gpt-5.5", url: "https://example.com" } }) });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, "model_provider_mismatch");
  const wrongNativeMethod = await fetch(`${base}/v1/native/firecrawl/v2/scrape`, { method: "DELETE", headers: { authorization: `Bearer ${proxyKey}` } });
  assert.equal(wrongNativeMethod.status, 405);
  assert.equal((await wrongNativeMethod.json()).error.code, "method_not_allowed");
  const directManifestGet = await fetch(`${base}/v1/proxy/replicate/prediction?prediction_id=pred_123`, { headers: { authorization: `Bearer ${proxyKey}` } });
  assert.equal(directManifestGet.status, 503);
  assert.equal((await directManifestGet.json()).error.code, "provider_not_configured", "GET manifest routes parse path params without a JSON envelope");
  const grant = await fetch(`${base}/v1/admin/upstream-grants/policies/migrate/replicate`, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "replicate", kind: "api_key", credential: "local-e2e-token" }) });
  assert.equal(grant.status, 200);
  const bundledGrantUrl = `${base}/v1/admin/upstream-grants/policies/migrate/aws_bundle`;
  const credentials = Object.fromEntries([["access" + "KeyId", "local"], ["secret" + "AccessKey", "local"]]);
  const bundledGrant = await fetch(bundledGrantUrl, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "aws-bedrock", kind: "api_key", label: "original", credentials }) });
  assert.equal(bundledGrant.status, 200);
  const bundledGrantBody = await bundledGrant.json();
  const updatedBundledGrant = await fetch(bundledGrantUrl, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "aws-bedrock", kind: "api_key", label: "updated" }) });
  assert.equal(updatedBundledGrant.status, 200, "upstream grant metadata updates preserve stored credential bundles");
  assert.deepEqual((await updatedBundledGrant.json()).credentialFields, bundledGrantBody.credentialFields);
  const providerStatus = await fetch(`${base}/v1/admin/provider-status`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(providerStatus.status, 200);
  const bedrockStatus = (await providerStatus.json()).providers.find((provider) => provider.id === "aws-bedrock");
  assert.equal(bedrockStatus.executable, true, JSON.stringify(bedrockStatus));
  assert.deepEqual(bedrockStatus.optionalConfig, ["AWS_SESSION_TOKEN"]);
  const invalidCredentials = Object.fromEntries([["access" + "KeyId", "local"], ["secret" + "AccessKey", "   "]]);
  const invalidBundledGrant = await fetch(`${base}/v1/admin/upstream-grants/policies/migrate/invalid_bundle`, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "aws-bedrock", kind: "api_key", credentials: invalidCredentials }) });
  assert.equal(invalidBundledGrant.status, 400, "partially empty upstream credential fields are rejected");
  assert.equal((await invalidBundledGrant.json()).error.code, "invalid_upstream_grant");
  const unknownProviderGrant = await fetch(`${base}/v1/admin/upstream-grants/policies/migrate/unknown_provider`, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "missing-provider", kind: "api_key", credential: "local" }) });
  assert.equal(unknownProviderGrant.status, 400, "upstream grants require a catalog provider");
  assert.equal((await unknownProviderGrant.json()).error.code, "unknown_provider");
  const missingPathParam = await fetch(`${base}/v1/proxy/replicate/prediction`, { headers: { authorization: `Bearer ${proxyKey}` } });
  assert.equal(missingPathParam.status, 400);
  assert.equal((await missingPathParam.json()).error.code, "missing_path_param");
  const usageAfterInvalidRequest = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${proxyKey}` } });
  assert.equal(usageAfterInvalidRequest.status, 200);
  assert.equal((await usageAfterInvalidRequest.json()).budget.spentMicros, 0, "invalid manifest requests must not reserve budget");
  const combined = await fetch(`${base}/v1/admin/keys/migrate`, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ secretSha256: sha256("different_secret_1234"), providers: ["openai"], enabled: true }) });
  assert.equal(combined.status, 409);
  assert.equal((await combined.json()).error.code, "combined_policy_secret_rotation");
  const policyOnly = await fetch(`${base}/v1/admin/keys/migrate`, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ providers: ["firecrawl", "replicate"], monthlyBudgetMicros: 10_000 }) });
  assert.equal(policyOnly.status, 200, JSON.stringify(await policyOnly.clone().json()));
  const userHeaders = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
  assert.equal((await fetch(`${base}/v1/admin/access-users/member%40example.com`, { method: "PUT", headers: userHeaders, body: JSON.stringify({ groups: ["manual", "assignment.stale"] }) })).status, 200);
  const ruleUrl = `${base}/v1/admin/assignment-rules/example_members`;
  const rule = { enabled: true, kind: "email_domain", subject: "example.com", groups: ["members"], policyIds: ["migrate"], priority: 10, revokeOnLoss: true };
  assert.equal((await fetch(ruleUrl, { method: "PUT", headers: userHeaders, body: JSON.stringify(rule) })).status, 200);
  const firstReconcile = await fetch(`${base}/v1/admin/assignment-rules/reconcile`, { method: "POST", headers: userHeaders, body: JSON.stringify({ email: "member@example.com" }) });
  assert.deepEqual((await firstReconcile.json()).results[0].groups, ["assignment.example_members", "manual", "members"]);
  assert.equal((await fetch(ruleUrl, { method: "PUT", headers: userHeaders, body: JSON.stringify({ ...rule, enabled: false }) })).status, 200);
  const secondReconcile = await fetch(`${base}/v1/admin/assignment-rules/reconcile`, { method: "POST", headers: userHeaders, body: JSON.stringify({ email: "member@example.com" }) });
  assert.deepEqual((await secondReconcile.json()).results[0].groups, ["manual"]);
  for (const [ruleId, body] of [
    ["invalid_kind", { ...rule, kind: "unsupported" }],
    ["invalid_groups", { ...rule, groups: "members" }],
    ["invalid_priority", { ...rule, priority: -1 }],
    ["invalid_enabled", { ...rule, enabled: "yes" }],
  ]) {
    const invalidRule = await fetch(`${base}/v1/admin/assignment-rules/${ruleId}`, { method: "PUT", headers: userHeaders, body: JSON.stringify(body) });
    assert.equal(invalidRule.status, 400, `malformed assignment rule ${ruleId} is rejected`);
    assert.equal((await invalidRule.json()).error.code, "invalid_assignment_rule");
  }
  for (const invalidBudget of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidPolicy = await fetch(`${base}/v1/admin/policies/invalid-budget`, { method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ providers: ["openai"], monthlyBudgetMicros: invalidBudget }) });
    assert.equal(invalidPolicy.status, 400);
    assert.equal((await invalidPolicy.json()).error.code, "invalid_policy");
  }
  for (const [policyId, body] of [
    ["invalid_wildcard", { providers: [], allProviders: "true" }],
    ["invalid_null_wildcard", { providers: null, allProviders: true }],
    ["invalid_mixed_scope", { providers: ["openai"], allProviders: true }],
    ["invalid_enabled_policy", { providers: ["openai"], enabled: "false" }],
    ["invalid_null_enabled", { providers: ["openai"], enabled: null }],
    ["invalid_tenant", { providers: ["openai"], tenantId: {} }],
    ["invalid_providers", { providers: {} }],
  ]) {
    const invalidPolicy = await fetch(`${base}/v1/admin/policies/${policyId}`, { method: "PUT", headers: userHeaders, body: JSON.stringify(body) });
    assert.equal(invalidPolicy.status, 400, `malformed policy ${policyId} is rejected`);
    assert.equal((await invalidPolicy.json()).error.code, "invalid_policy");
  }
  const normalizedBinding = await fetch(`${base}/v1/admin/policy-bindings`, { method: "PUT", headers: userHeaders, body: JSON.stringify({ policyId: " migrate ", principalType: "group", principalId: " Members ", priority: 10, ignored: true }) });
  assert.equal(normalizedBinding.status, 200);
  assert.deepEqual(await normalizedBinding.json(), { policyId: "migrate", principalType: "group", principalId: "members", enabled: true, priority: 10 });
  for (const [bindingId, body] of [
    ["invalid_null_body", null],
    ["invalid_array_body", []],
    ["invalid_principal_type", { policyId: "migrate", principalType: "service", principalId: "bot" }],
    ["invalid_principal_id", { policyId: "migrate", principalType: "group", principalId: {} }],
    ["invalid_user_email", { policyId: "migrate", principalType: "user", principalId: "not-an-email" }],
    ["invalid_empty_group", { policyId: "migrate", principalType: "group", principalId: "   " }],
    ["invalid_policy_id", { policyId: {}, principalType: "group", principalId: "members" }],
    ["invalid_enabled", { policyId: "migrate", principalType: "group", principalId: "members", enabled: "false" }],
    ["invalid_null_enabled", { policyId: "migrate", principalType: "group", principalId: "members", enabled: null }],
    ["invalid_priority", { policyId: "migrate", principalType: "group", principalId: "members", priority: -1 }],
    ["invalid_fractional_priority", { policyId: "migrate", principalType: "group", principalId: "members", priority: 1.5 }],
    ["invalid_string_priority", { policyId: "migrate", principalType: "group", principalId: "members", priority: "10" }],
  ]) {
    const invalidBinding = await fetch(`${base}/v1/admin/policy-bindings`, { method: "PUT", headers: userHeaders, body: JSON.stringify(body) });
    assert.equal(invalidBinding.status, 400, `malformed policy binding ${bindingId} is rejected`);
    assert.equal((await invalidBinding.json()).error.code, "invalid_policy_binding");
  }
  const bindingsAfterInvalid = await fetch(`${base}/v1/admin/policy-bindings`, { headers: userHeaders });
  assert.equal(bindingsAfterInvalid.status, 200);
  const retainedBinding = (await bindingsAfterInvalid.json()).bindings.find((binding) => binding.principalType === "group" && binding.principalId === "members" && binding.policyId === "migrate");
  assert.deepEqual(retainedBinding, { policyId: "migrate", principalType: "group", principalId: "members", enabled: true, priority: 10 }, "rejected binding payloads do not overwrite the stored canonical binding");
  console.log(`local Worker smoke passed on ${base}`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nwrangler output:\n${output}`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  rmSync(config, { force: true });
  rmSync(persistence, { recursive: true, force: true });
}

async function json(url) { const response = await fetch(url); assert.equal(response.status, 200, `${url} returned ${response.status}`); return response.json(); }
async function waitUntilReady(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`wrangler exited with ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("wrangler local server did not become ready");
}
function availablePort() { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); }); }); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function putLocalKv(key, value) { execFileSync("pnpm", ["exec", "wrangler", "kv", "key", "put", key, JSON.stringify(value), "--binding", "POLICY_KV", "--local", "--persist-to", persistence, "--config", config], { cwd: process.cwd(), env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "ignore" }); }
