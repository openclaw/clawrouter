import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

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

const failoverSecret = "failover123";
const failoverKey = `clawrouter-live-failover-${failoverSecret}`;
putLocalKv("policies/failover", { enabled: true, generation, providers: ["local-openai"], tenantId: "default", tokenRole: "service", requestCostMicros: 1, retainRequestContent: false });
putLocalKv("credentials/failover", { enabled: true, secretSha256: sha256(failoverSecret), policyId: "failover", policyGeneration: generation });

const rotationSecret = "rotation123";
const rotationKey = `clawrouter-live-rotation-${rotationSecret}`;
const routingDefaults = { strategy: "round_robin", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: {} };
putLocalKv("policies/rotation", { enabled: true, generation, providers: ["local-openai"], tenantId: "default", tokenRole: "service", requestCostMicros: 1, retainRequestContent: false, grantRouting: routingDefaults });
putLocalKv("credentials/rotation", { enabled: true, secretSha256: sha256(rotationSecret), policyId: "rotation", policyGeneration: generation });

const noFailoverSecret = "nofail123";
const noFailoverKey = `clawrouter-live-no_failover-${noFailoverSecret}`;
putLocalKv("policies/no_failover", { enabled: true, generation, providers: ["local-openai"], tenantId: "default", tokenRole: "service", requestCostMicros: 1, retainRequestContent: false, grantRouting: { ...routingDefaults, strategy: "priority", failover: false } });
putLocalKv("credentials/no_failover", { enabled: true, secretSha256: sha256(noFailoverSecret), policyId: "no_failover", policyGeneration: generation });

const restrictedSecret = "restricted123";
const restrictedKey = `clawrouter-live-restricted-${restrictedSecret}`;
putLocalKv("policies/restricted", { enabled: true, generation, providers: ["local-openai"], tenantId: "default", tokenRole: "service", requestCostMicros: 1, retainRequestContent: false, grantRouting: { ...routingDefaults, eligibleGrants: { "local-openai": [] } } });
putLocalKv("credentials/restricted", { enabled: true, secretSha256: sha256(restrictedSecret), policyId: "restricted", policyGeneration: generation });

const fusionSecret = "fusion123";
const fusionKey = `clawrouter-live-fusionlocal-${fusionSecret}`;
putLocalKv("policies/fusion_local", { enabled: true, generation, providers: ["local-openai", "openai"], tenantId: "default", tokenRole: "service", monthlyBudgetMicros: 1, retainRequestContent: false });
putLocalKv("policies/fusion_ready", { enabled: true, generation, providers: ["local-openai", "openai"], tenantId: "default", tokenRole: "service", monthlyBudgetMicros: 100, requestCostMicros: 1, retainRequestContent: false });
putLocalKv("credentials/fusionlocal", { enabled: true, secretSha256: sha256(fusionSecret), policyId: "fusion_local", policyGeneration: generation });
const upstreamPort = await availablePort();
const upstreamCalls = [];
const failoverCalls = [];
const rotationCalls = [];
const noFailoverCalls = [];
let stalledUpstreamClosed = false;
const upstreamServer = createHttpServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  upstreamCalls.push(body);
  const authorization = request.headers.authorization ?? "";
  if (body.model === "default" && authorization === "Bearer rate-limited") {
    failoverCalls.push(authorization);
    response.writeHead(429, { "content-type": "application/json", "retry-after": "120", "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "120" });
    response.end(JSON.stringify({ error: { message: "fixture rate limit" } }));
    return;
  }
  if (body.model === "default" && authorization === "Bearer no-fail-primary") {
    noFailoverCalls.push(authorization);
    response.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
    response.end(JSON.stringify({ error: { message: "fixture rate limit" } }));
    return;
  }
  if (body.model === "default" && authorization === "Bearer healthy") failoverCalls.push(authorization);
  if (body.model === "default" && ["Bearer rotate-a", "Bearer rotate-b", "Bearer rotate-c"].includes(authorization)) rotationCalls.push(authorization);
  if (body.model === "default" && authorization === "Bearer no-fail-backup") noFailoverCalls.push(authorization);
  if (body.model === "stall") {
    response.on("close", () => { stalledUpstreamClosed = true; });
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"choices":[{"message":{"content":"partial');
    return;
  }
  const content = body.model === "adviser"
    ? "local proposal"
    : JSON.stringify(body.messages).includes("local proposal") ? "fused answer" : "proposal missing";
  response.writeHead(200, { "content-type": "application/json", ...(authorization === "Bearer healthy" ? { "x-clawrouter-grant-failover": "1", "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "80", "x-ratelimit-reset-requests": "120" } : {}) });
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }));
});
await new Promise((resolve, reject) => upstreamServer.listen(upstreamPort, "127.0.0.1", resolve).once("error", reject));

const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistence, "--config", config, "--var", `CLAWROUTER_ADMIN_TOKEN_SHA256:${sha256(adminToken)}`, "--var", `LOCAL_OPENAI_BASE_URL:http://127.0.0.1:${upstreamPort}`, "--var", "OPENAI_API_KEY:fixture", "--var", "AWS_REGION:us-east-1", "--var", "AWS_SESSION_TOKEN:", "--log-level", "info"], {
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
  assert.deepEqual(health, {
    ok: true,
    service: "clawrouter-edge",
    runtime: "typescript",
    environment: "production",
    observability: {
      mode: "metadata_only",
      requestContentRetentionDefault: true,
    },
  });
  const providers = await json(`${base}/v1/providers`);
  assert.equal(providers.providers.length, 21);
  assert.equal(new Set(providers.providers.map((provider) => provider.id)).size, 21);
  assert.ok(providers.providers.some((provider) => provider.id === "local-openai"));
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
  assert.equal(bootstrapBody.providers.length, 21);
  assert.equal(new Set(bootstrapBody.providers.map((provider) => provider.id)).size, 21);
  assert.equal(bootstrapBody.fusion.modelId, "clawrouter/fusion");
  assert.equal(bootstrapBody.fusion.enabled, false);
  const adminHeaders = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
  for (const body of [null, []]) {
    const invalidFusion = await fetch(`${base}/v1/admin/fusion`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(body) });
    assert.equal(invalidFusion.status, 400);
    assert.equal((await invalidFusion.json()).error.code, "fusion_config_invalid");
  }
  for (const model of ["cohere/command-a-plus-05-2026", "cloudflare-ai-gateway/auto"]) {
    const incompatibleFusion = await fetch(`${base}/v1/admin/fusion`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ ...bootstrapBody.fusion, adviserModels: [model] }) });
    assert.equal(incompatibleFusion.status, 400);
    assert.equal((await incompatibleFusion.json()).error.code, "fusion_model_incompatible");
  }
  const deniedFusionConfig = { ...bootstrapBody.fusion, enabled: true, adviserModels: ["local/adviser"], aggregatorModel: "openai/gpt-4.1-mini" };
  const invalidFusionPreview = await fetch(`${base}/v1/admin/fusion/preview`, { method: "POST", headers: adminHeaders, body: "null" });
  assert.equal(invalidFusionPreview.status, 400);
  assert.equal((await invalidFusionPreview.json()).error.code, "fusion_preview_invalid");
  const missingFusionPolicy = await fetch(`${base}/v1/admin/fusion/preview`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ config: deniedFusionConfig }) });
  assert.equal(missingFusionPolicy.status, 400);
  assert.equal((await missingFusionPolicy.json()).error.code, "fusion_policy_required");
  const unknownFusionPolicy = await fetch(`${base}/v1/admin/fusion/preview`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ policyId: "not_found", config: deniedFusionConfig }) });
  assert.equal(unknownFusionPolicy.status, 404);
  assert.equal((await unknownFusionPolicy.json()).error.code, "fusion_policy_not_found");
  const blockedFusionPreview = await fetch(`${base}/v1/admin/fusion/preview`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ policyId: "migrate", config: deniedFusionConfig }) });
  assert.equal(blockedFusionPreview.status, 200);
  const blockedFusionReadiness = await blockedFusionPreview.json();
  assert.equal(blockedFusionReadiness.executable, false);
  assert.equal(blockedFusionReadiness.callCount, 2);
  assert.equal(blockedFusionReadiness.estimatedReservationMicros, 0, "blocked synthesizer prevents every reservation and adviser fan-out");
  assert.ok(blockedFusionReadiness.calls.every((call) => call.policyAllowed === false));
  const underfundedFusionPreview = await fetch(`${base}/v1/admin/fusion/preview`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ policyId: "fusion_local", config: deniedFusionConfig }) });
  assert.equal(underfundedFusionPreview.status, 200);
  assert.equal((await underfundedFusionPreview.json()).executable, false, "readiness catches a synthesizer reservation above remaining budget");
  const readyFusionPreview = await fetch(`${base}/v1/admin/fusion/preview`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ policyId: "fusion_ready", config: deniedFusionConfig }) });
  assert.equal(readyFusionPreview.status, 200);
  const readyFusionReadiness = await readyFusionPreview.json();
  assert.equal(readyFusionReadiness.executable, true);
  assert.equal(readyFusionReadiness.readyAdviserCount, 1);
  assert.equal(readyFusionReadiness.calls.at(-1).stage, "synthesizer");
  assert.ok(readyFusionReadiness.estimatedReservationMicros > 0);
  assert.equal((await fetch(`${base}/v1/admin/fusion`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(deniedFusionConfig) })).status, 200);
  const deniedModels = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${proxyKey}` } });
  assert.equal(deniedModels.status, 200);
  assert.equal((await deniedModels.json()).data.some((model) => model.id === "clawrouter/fusion"), false, "fusion stays hidden until its synthesizer route is executable for the caller");
  const budgetBlockedFusion = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${fusionKey}`, "content-type": "application/json", "x-request-id": "fusion-e2e-budget-blocked" }, body: JSON.stringify({ model: "clawrouter/fusion", messages: [{ role: "user", content: "solve" }] }) });
  assert.equal(budgetBlockedFusion.status, 402);
  assert.equal((await budgetBlockedFusion.json()).error.code, "budget_exhausted");
  assert.equal(upstreamCalls.length, 0, "synthesizer budget reservation blocks adviser spend before the final answer can be funded");
  const localFusionConfig = { ...deniedFusionConfig, aggregatorModel: "local/final" };
  assert.equal((await fetch(`${base}/v1/admin/fusion`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(localFusionConfig) })).status, 200);
  const upstreamCallsBeforeMalformedFusion = upstreamCalls.length;
  const malformedFusion = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${fusionKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "clawrouter/fusion", messages: [null] }) });
  assert.equal(malformedFusion.status, 400);
  assert.equal((await malformedFusion.json()).error.code, "fusion_messages_invalid");
  assert.equal(upstreamCalls.length, upstreamCallsBeforeMalformedFusion, "malformed fusion messages never reach an upstream model");
  const fusionModels = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${fusionKey}` } });
  assert.equal(fusionModels.status, 200);
  assert.equal((await fusionModels.json()).data.some((model) => model.id === "clawrouter/fusion"), true);
  const fusionResponse = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${fusionKey}`, "content-type": "application/json", "x-request-id": "fusion-e2e-retry" }, body: JSON.stringify({ model: "clawrouter/fusion", messages: [{ role: "user", content: "solve" }] }) });
  assert.equal(fusionResponse.status, 200, JSON.stringify(await fusionResponse.clone().json()));
  assert.equal((await fusionResponse.json()).choices[0].message.content, "fused answer");
  assert.equal(fusionResponse.headers.get("x-clawrouter-fusion-adviser-count"), "1");
  assert.equal(fusionResponse.headers.get("x-clawrouter-fusion-failed-count"), "0");
  assert.deepEqual(upstreamCalls.map((call) => call.model), ["adviser", "final"]);
  const selectionFailureCallStart = upstreamCalls.length;
  const selectionFailureConfig = { ...localFusionConfig, adviserModels: ["azure-openai/deployment"] };
  assert.equal((await fetch(`${base}/v1/admin/fusion`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(selectionFailureConfig) })).status, 200);
  const selectionFailureResponse = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${fusionKey}`, "content-type": "application/json", "x-request-id": "fusion-e2e-selection-failure" }, body: JSON.stringify({ model: "clawrouter/fusion", messages: [{ role: "user", content: "solve without configured adviser" }] }) });
  assert.equal(selectionFailureResponse.status, 200, JSON.stringify(await selectionFailureResponse.clone().json()));
  assert.equal(selectionFailureResponse.headers.get("x-clawrouter-fusion-adviser-count"), "0");
  assert.equal(selectionFailureResponse.headers.get("x-clawrouter-fusion-failed-count"), "1");
  assert.deepEqual(upstreamCalls.slice(selectionFailureCallStart).map((call) => call.model), ["final"], "selection failures are audited without attempting the invalid upstream route");
  const stalledCallStart = upstreamCalls.length;
  const stalledFusionConfig = { ...localFusionConfig, adviserModels: ["local/stall"], adviserTimeoutMs: 1_000 };
  assert.equal((await fetch(`${base}/v1/admin/fusion`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(stalledFusionConfig) })).status, 200);
  const stalledFusionResponse = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${fusionKey}`, "content-type": "application/json", "x-request-id": "fusion-e2e-retry" }, body: JSON.stringify({ model: "clawrouter/fusion", messages: [{ role: "user", content: "solve after timeout" }] }) });
  assert.equal(stalledFusionResponse.status, 200, JSON.stringify(await stalledFusionResponse.clone().json()));
  assert.equal(stalledFusionResponse.headers.get("x-clawrouter-fusion-adviser-count"), "0");
  assert.equal(stalledFusionResponse.headers.get("x-clawrouter-fusion-failed-count"), "1");
  await waitUntil(() => stalledUpstreamClosed, "timed-out adviser upstream connection did not close");
  assert.deepEqual(upstreamCalls.slice(stalledCallStart).map((call) => call.model), ["stall", "final"]);
  let fusionUsageBody;
  await waitUntil(async () => {
    const fusionUsage = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${fusionKey}` } });
    assert.equal(fusionUsage.status, 200);
    fusionUsageBody = await fusionUsage.json();
    const synthesizers = fusionUsageBody.usage.events.filter((event) => event.request_id === "fusion-e2e-retry" && event.compound_request_stage === "fusion_synthesizer");
    const visibleCompoundIds = new Set(synthesizers.map((event) => event.compound_request_id));
    const blocked = fusionUsageBody.usage.events.find((event) => event.request_id === "fusion-e2e-budget-blocked");
    const selectionSynthesizer = fusionUsageBody.usage.events.find((event) => event.request_id === "fusion-e2e-selection-failure" && event.compound_request_stage === "fusion_synthesizer");
    const selectionEvents = selectionSynthesizer ? fusionUsageBody.usage.events.filter((event) => event.compound_request_id === selectionSynthesizer.compound_request_id) : [];
    return visibleCompoundIds.size >= 2 && fusionUsageBody.usage.events.filter((event) => visibleCompoundIds.has(event.compound_request_id)).length >= 4 && blocked?.compound_request_stage === "fusion_synthesizer" && selectionEvents.length >= 2;
  }, "fusion usage lineage was not delivered");
  const compoundIds = [...new Set(fusionUsageBody.usage.events.filter((event) => event.request_id === "fusion-e2e-retry").map((event) => event.compound_request_id))];
  assert.equal(compoundIds.length, 2, "reused caller request ids must not merge separate Fusion invocations");
  const lineage = fusionUsageBody.usage.events
    .filter((event) => compoundIds.includes(event.compound_request_id))
    .map((event) => ({ request_id: event.request_id, compound_request_id: event.compound_request_id, stage: event.compound_request_stage, index: event.compound_request_index, model: event.model }));
  assert.equal(lineage.length, 4, JSON.stringify(lineage));
  assert.equal(fusionUsageBody.budget.spentMicros, 0, "dynamic local models retain zero-price accounting under a budgeted policy");
  const blockedLineage = fusionUsageBody.usage.events.find((event) => event.request_id === "fusion-e2e-budget-blocked");
  assert.equal(blockedLineage.status_code, 402);
  assert.equal(blockedLineage.compound_request_stage, "fusion_synthesizer");
  assert.equal(blockedLineage.compound_request_size, 1, "pre-fan-out rejection is a complete one-call Fusion group");
  assert.ok(blockedLineage.compound_request_started_at_ms <= blockedLineage.occurred_at_ms);
  const selectionSynthesizer = fusionUsageBody.usage.events.find((event) => event.request_id === "fusion-e2e-selection-failure" && event.compound_request_stage === "fusion_synthesizer");
  const selectionLineage = fusionUsageBody.usage.events.filter((event) => event.compound_request_id === selectionSynthesizer.compound_request_id);
  assert.equal(selectionLineage.length, 2);
  const selectionAdviser = selectionLineage.find((event) => event.compound_request_stage === "fusion_adviser");
  assert.equal(selectionAdviser.provider, "azure-openai");
  assert.equal(selectionAdviser.status_code, 503);
  for (const compoundId of compoundIds) {
    const events = fusionUsageBody.usage.events.filter((event) => event.compound_request_id === compoundId);
    assert.deepEqual(events.map((event) => event.compound_request_stage).sort(), ["fusion_adviser", "fusion_synthesizer"]);
    assert.equal(events.find((event) => event.compound_request_stage === "fusion_synthesizer").request_id, "fusion-e2e-retry");
    assert.notEqual(events.find((event) => event.compound_request_stage === "fusion_adviser").request_id, "fusion-e2e-retry");
    assert.equal(events.find((event) => event.compound_request_stage === "fusion_adviser").compound_request_index, 1);
    assert.ok(events.every((event) => event.compound_request_size === 2));
    assert.equal(new Set(events.map((event) => event.compound_request_started_at_ms)).size, 1);
  }
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
    ["invalid_routing_strategy", { providers: ["openai"], grantRouting: { ...routingDefaults, strategy: "random" } }],
    ["invalid_routing_stickiness", { providers: ["openai"], grantRouting: { ...routingDefaults, stickiness: "cookie" } }],
    ["invalid_routing_staleness", { providers: ["openai"], grantRouting: { ...routingDefaults, staleAfterSeconds: 1 } }],
    ["invalid_routing_failover", { providers: ["openai"], grantRouting: { ...routingDefaults, failover: "false" } }],
    ["invalid_routing_eligibility", { providers: ["openai"], grantRouting: { ...routingDefaults, eligibleGrants: { openai: ["bad/ref"] } } }],
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
  const invalidUserUrl = `${base}/v1/admin/access-users/invalid-shape%40example.com`;
  const invalidGrantUrl = `${base}/v1/admin/access-user-grants/invalid-shape%40example.com`;
  for (const [userMutationId, url, body] of [
    ["invalid_null_body", invalidUserUrl, null],
    ["invalid_array_body", invalidUserUrl, []],
    ["invalid_enabled", invalidUserUrl, { enabled: "false" }],
    ["invalid_tenant", invalidUserUrl, { tenantId: {} }],
    ["invalid_groups", invalidUserUrl, { groups: "members" }],
    ["invalid_null_groups", invalidUserUrl, { groups: null }],
    ["invalid_group_entry", invalidUserUrl, { groups: [{}] }],
    ["invalid_retention", invalidUserUrl, { contentRetentionDisabled: "false" }],
    ["invalid_null_retention", invalidUserUrl, { contentRetentionDisabled: null }],
    ["invalid_grant_null_body", invalidGrantUrl, null],
    ["invalid_policy_ids", invalidGrantUrl, { policyIds: "migrate" }],
    ["invalid_policy_ids_object", invalidGrantUrl, { policyIds: {} }],
    ["invalid_policy_id_entry", invalidGrantUrl, { policyIds: [{}] }],
    ["invalid_null_policy_ids", invalidGrantUrl, { policyIds: null }],
  ]) {
    const invalidUserMutation = await fetch(url, { method: "PUT", headers: userHeaders, body: JSON.stringify(body) });
    assert.equal(invalidUserMutation.status, 400, `malformed access-user mutation ${userMutationId} is rejected`);
    assert.equal((await invalidUserMutation.json()).error.code, "invalid_access_user");
  }
  const canonicalUserUrl = `${base}/v1/admin/access-users/shape%40example.com`;
  const canonicalUser = await fetch(canonicalUserUrl, { method: "PUT", headers: userHeaders, body: JSON.stringify({ tenantId: " Team ", enabled: false, groups: [" Members ", "members"], contentRetentionDisabled: true, role: "admin", assignmentState: { injected: true }, ignored: true }) });
  assert.equal(canonicalUser.status, 200);
  assert.deepEqual(await canonicalUser.json(), { email: "shape@example.com", role: "user", tenantId: "Team", enabled: false, groups: ["members"], contentRetentionDisabled: true });
  const canonicalGrantUrl = `${base}/v1/admin/access-user-grants/shape%40example.com`;
  const canonicalGrant = await fetch(canonicalGrantUrl, { method: "PUT", headers: userHeaders, body: JSON.stringify({ enabled: true, policyIds: ["migrate", "migrate"] }) });
  assert.equal(canonicalGrant.status, 200);
  const canonicalGrantBody = await canonicalGrant.json();
  assert.deepEqual(canonicalGrantBody.user, { email: "shape@example.com", role: "user", tenantId: "Team", enabled: true, groups: ["members"], contentRetentionDisabled: true }, "grant updates preserve omitted identity fields");
  assert.deepEqual(canonicalGrantBody.bindings.filter((binding) => binding.enabled).map((binding) => binding.policyId), ["migrate"]);
  const connectionUrl = `${base}/v1/admin/connections/openai`;
  for (const [connectionMutationId, body] of [
    ["invalid_null_body", null],
    ["invalid_array_body", []],
    ["invalid_enabled", { enabled: "false" }],
    ["invalid_null_enabled", { enabled: null }],
    ["invalid_label", { label: {} }],
    ["invalid_array_label", { label: [] }],
  ]) {
    const invalidConnection = await fetch(connectionUrl, { method: "PUT", headers: userHeaders, body: JSON.stringify(body) });
    assert.equal(invalidConnection.status, 400, `malformed provider connection ${connectionMutationId} is rejected`);
    assert.equal((await invalidConnection.json()).error.code, "invalid_provider_connection");
  }
  const canonicalConnection = await fetch(connectionUrl, { method: "PUT", headers: userHeaders, body: JSON.stringify({ providerId: "missing", enabled: false, label: " Ops ", ignored: true }) });
  assert.equal(canonicalConnection.status, 200);
  assert.deepEqual(await canonicalConnection.json(), { providerId: "openai", enabled: false, label: "Ops" });
  const connectionsAfterMutation = await fetch(`${base}/v1/admin/connections`, { headers: userHeaders });
  assert.equal(connectionsAfterMutation.status, 200);
  assert.deepEqual((await connectionsAfterMutation.json()).connections.find((connection) => connection.providerId === "openai"), { providerId: "openai", enabled: false, label: "Ops" });
  const invalidCredentialUrl = `${base}/v1/admin/credentials/invalid_shape`;
  const credentialDigest = sha256("credential-shape");
  for (const [credentialMutationId, body] of [
    ["invalid_null_body", null],
    ["invalid_array_body", []],
    ["invalid_policy_id", { policyId: {}, secretSha256: credentialDigest }],
    ["invalid_enabled", { policyId: "migrate", secretSha256: credentialDigest, enabled: "false" }],
    ["invalid_null_enabled", { policyId: "migrate", secretSha256: credentialDigest, enabled: null }],
    ["invalid_digest", { policyId: "migrate", secretSha256: "not-a-digest" }],
    ["invalid_principal", { policyId: "migrate", secretSha256: credentialDigest, principalId: {} }],
    ["invalid_principal_email", { policyId: "migrate", secretSha256: credentialDigest, principalId: "not-an-email" }],
  ]) {
    const invalidCredential = await fetch(invalidCredentialUrl, { method: "PUT", headers: userHeaders, body: JSON.stringify(body) });
    assert.equal(invalidCredential.status, 400, `malformed proxy credential ${credentialMutationId} is rejected`);
    assert.equal((await invalidCredential.json()).error.code, "invalid_credential");
  }
  const canonicalCredential = await fetch(`${base}/v1/admin/credentials/shape_credential`, { method: "PUT", headers: userHeaders, body: JSON.stringify({ policyId: " migrate ", secretSha256: credentialDigest.toUpperCase(), enabled: false, principalId: " Owner@Example.com ", policyGeneration: "injected", ignored: true }) });
  assert.equal(canonicalCredential.status, 200);
  assert.deepEqual(await canonicalCredential.json(), { credentialId: "shape_credential", policyId: "migrate", enabled: false, policyEnabled: true, generationMatches: true, active: false, principalId: "owner@example.com" });
  const credentialsAfterMutation = await fetch(`${base}/v1/admin/credentials`, { headers: userHeaders });
  assert.equal(credentialsAfterMutation.status, 200);
  assert.deepEqual((await credentialsAfterMutation.json()).credentials.find((credential) => credential.credentialId === "shape_credential"), { credentialId: "shape_credential", policyId: "migrate", enabled: false, policyEnabled: true, generationMatches: true, active: false, principalId: "owner@example.com" });
  const policiesBeforeInvalidRoots = await fetch(`${base}/v1/admin/policies`, { headers: userHeaders });
  assert.equal(policiesBeforeInvalidRoots.status, 200);
  const migratePolicyBeforeInvalidRoots = (await policiesBeforeInvalidRoots.json()).policies.find((policy) => policy.policyId === "migrate");
  for (const [mutationId, url, method, body, errorCode] of [
    ["policy_null", `${base}/v1/admin/policies/invalid_root`, "PUT", null, "invalid_policy"],
    ["assignment_null", `${base}/v1/admin/assignment-rules/invalid_root`, "PUT", null, "invalid_assignment_rule"],
    ["reconcile_null", `${base}/v1/admin/assignment-rules/reconcile`, "POST", null, "invalid_assignment_reconcile"],
    ["reconcile_string_flag", `${base}/v1/admin/assignment-rules/reconcile`, "POST", { all: "false" }, "invalid_assignment_reconcile"],
    ["reconcile_object_email", `${base}/v1/admin/assignment-rules/reconcile`, "POST", { email: {} }, "invalid_assignment_reconcile"],
    ["legacy_null", `${base}/v1/admin/keys/migrate`, "PUT", null, "invalid_policy"],
    ["legacy_object_digest", `${base}/v1/admin/keys/migrate`, "PUT", { providers: ["firecrawl", "replicate"], secretSha256: {} }, "invalid_credential"],
    ["grant_null", `${base}/v1/admin/upstream-grants/policies/migrate/invalid_root`, "PUT", null, "invalid_upstream_grant"],
    ["oauth_authorize_null", `${base}/v1/admin/upstream-grants/policies/migrate/invalid_root/authorize`, "POST", null, "invalid_upstream_grant"],
    ["oauth_authorize_weight", `${base}/v1/admin/upstream-grants/policies/migrate/invalid_root/authorize`, "POST", { provider: "openai", weight: 0 }, "invalid_upstream_grant"],
  ]) {
    const invalidMutation = await fetch(url, { method, headers: userHeaders, body: JSON.stringify(body) });
    assert.equal(invalidMutation.status, 400, `malformed admin mutation ${mutationId} is rejected`);
    assert.equal((await invalidMutation.json()).error.code, errorCode);
  }
  const policiesAfterInvalidRoots = await fetch(`${base}/v1/admin/policies`, { headers: userHeaders });
  assert.equal(policiesAfterInvalidRoots.status, 200);
  assert.deepEqual((await policiesAfterInvalidRoots.json()).policies.find((policy) => policy.policyId === "migrate"), migratePolicyBeforeInvalidRoots, "malformed legacy mutations do not partially update policy state");
  const grantsAfterInvalidRoots = await fetch(`${base}/v1/admin/upstream-grants`, { headers: userHeaders });
  assert.equal(grantsAfterInvalidRoots.status, 200);
  assert.equal((await grantsAfterInvalidRoots.json()).grants.some((grant) => grant.tokenRef === "invalid_root"), false, "malformed grant mutations do not create grant state");
  const proxyHeaders = { authorization: `Bearer ${proxyKey}`, "content-type": "application/json" };
  for (const [proxyMutationId, url, body] of [
    ["openai_null", `${base}/v1/chat/completions`, null],
    ["manifest_null", `${base}/v1/proxy/replicate/prediction`, null],
    ["manifest_method", `${base}/v1/proxy/replicate/prediction`, { method: 1 }],
    ["native_null", `${base}/v1/native/firecrawl/v2/scrape`, null],
  ]) {
    const invalidProxyBody = await fetch(url, { method: "POST", headers: proxyHeaders, body: JSON.stringify(body) });
    assert.equal(invalidProxyBody.status, 400, `malformed proxy request ${proxyMutationId} is rejected`);
    assert.equal((await invalidProxyBody.json()).error.code, "invalid_request_body");
  }
  const usageAfterInvalidBodies = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${proxyKey}` } });
  assert.equal(usageAfterInvalidBodies.status, 200);
  assert.equal((await usageAfterInvalidBodies.json()).budget.spentMicros, 0, "invalid JSON body shapes must not reserve budget");
  const callsBeforeRestrictedPool = upstreamCalls.length;
  const restrictedPool = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${restrictedKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "restricted pool" }] }) });
  assert.equal(restrictedPool.status, 503);
  assert.equal((await restrictedPool.json()).error.code, "upstream_grant_pool_unavailable");
  assert.equal(upstreamCalls.length, callsBeforeRestrictedPool, "an explicit empty eligibility list never falls back to the provider environment credential");
  for (const [tokenRef, credential, weight = 1] of [["rotate-a", "rotate-a", 1], ["rotate-b", "rotate-b", 5]]) {
    const stored = await fetch(`${base}/v1/admin/upstream-grants/policies/rotation/${tokenRef}`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ provider: "local-openai", kind: "api_key", priority: 10, weight, credential }) });
    assert.equal(stored.status, 200, JSON.stringify(await stored.clone().json()));
  }
  const rotationRequest = (sessionId) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${rotationKey}`, "content-type": "application/json", ...(sessionId ? { "session-id": sessionId } : {}) }, body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "rotate grant" }] }) });
  for (let index = 0; index < 4; index += 1) assert.equal((await rotationRequest()).status, 200);
  assert.deepEqual(rotationCalls, ["Bearer rotate-a", "Bearer rotate-b", "Bearer rotate-a", "Bearer rotate-b"], "round-robin selection is serialized by the authority");
  await waitUntil(async () => {
    const grants = await fetch(`${base}/v1/admin/upstream-grants`, { headers: adminHeaders });
    const rows = (await grants.json()).grants.filter((item) => item.scopeId === "rotation");
    return rows.length === 2 && rows.every((item) => item.selectedCount === 2 && item.lastSelectedAt);
  }, "grant selection counters were not visible to administrators");
  const selectedGrantUpdate = await fetch(`${base}/v1/admin/upstream-grants/policies/rotation/rotate-a`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ provider: "local-openai", kind: "api_key", priority: 10, weight: 1, credential: "rotate-a", label: "updated" }) });
  assert.equal(selectedGrantUpdate.status, 200);
  assert.equal((await selectedGrantUpdate.json()).selectedCount, 2, "grant mutation responses preserve authority selection counters");
  const actionNamedGrant = await fetch(`${base}/v1/admin/upstream-grants/policies/migrate/quota-refresh`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ provider: "local-openai", kind: "api_key", credential: "action-named" }) });
  assert.equal(actionNamedGrant.status, 200, "action names remain valid three-segment grant references");
  const updateRotationPolicy = async (grantRouting) => {
    const response = await fetch(`${base}/v1/admin/policies/rotation`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ enabled: true, providers: ["local-openai"], tenantId: "default", tokenRole: "service", requestCostMicros: 1, retainRequestContent: false, grantRouting }) });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  };
  await updateRotationPolicy({ ...routingDefaults, strategy: "least_used" });
  assert.equal((await rotationRequest()).status, 200);
  assert.equal((await rotationRequest()).status, 200);
  assert.deepEqual(rotationCalls.slice(-2), ["Bearer rotate-a", "Bearer rotate-b"], "least-used selection balances authority counters");
  await updateRotationPolicy({ ...routingDefaults, strategy: "weighted_random", stickiness: "session" });
  const stickyStart = rotationCalls.length;
  for (let index = 0; index < 3; index += 1) assert.equal((await rotationRequest("session-alpha")).status, 200);
  assert.equal(new Set(rotationCalls.slice(stickyStart)).size, 1, "session stickiness is deterministic across requests");
  await updateRotationPolicy({ ...routingDefaults, strategy: "priority", eligibleGrants: { "local-openai": ["rotate-b"] } });
  assert.equal((await rotationRequest()).status, 200);
  assert.equal(rotationCalls.at(-1), "Bearer rotate-b", "policy eligibility restricts the grant pool");
  const freshOnly = await fetch(`${base}/v1/admin/upstream-grants/policies/rotation/rotate-c`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ provider: "local-openai", kind: "api_key", priority: 10, credential: "rotate-c" }) });
  assert.equal(freshOnly.status, 200);
  await updateRotationPolicy({ ...routingDefaults, strategy: "priority", staleState: "deny", eligibleGrants: { "local-openai": ["rotate-c"] } });
  const staleClosed = await rotationRequest();
  assert.equal(staleClosed.status, 503);
  assert.equal((await staleClosed.json()).error.code, "upstream_grant_pool_unavailable", "fail-closed stale state rejects an unobserved grant");
  await updateRotationPolicy({ ...routingDefaults, strategy: "priority", eligibleGrants: { "local-openai": ["rotate-b"] } });
  const attributed = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${rotationKey}`,
      "content-type": "application/json",
      "x-request-id": "fakeco-observability-contract",
      "x-clawrouter-session-id": "session-fakeco",
      "x-clawrouter-agent-id": "openclaw/gateway",
      "x-clawrouter-parent-agent-id": "crabhelm/tenant",
      "x-clawrouter-project-id": "fakeco",
      "x-clawrouter-client": "crabhelm",
    },
    body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "private prompt sentinel" }] }),
  });
  assert.equal(attributed.status, 200);
  assert.equal(attributed.headers.get("x-clawrouter-content-retention"), "off");
  let attributedEvent;
  await waitUntil(async () => {
    const response = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${rotationKey}` } });
    attributedEvent = (await response.json()).usage.events.find((event) => event.request_id === "fakeco-observability-contract");
    return Boolean(attributedEvent);
  }, "attributed usage event was not visible");
  assert.deepEqual(
    {
      session: attributedEvent.session_id,
      agent: attributedEvent.agent_id,
      parent: attributedEvent.parent_agent_id,
      project: attributedEvent.project_id,
      client: attributedEvent.client,
      retained: attributedEvent.content_retained,
      contentRef: attributedEvent.content_ref,
    },
    {
      session: "session-fakeco",
      agent: "openclaw/gateway",
      parent: "crabhelm/tenant",
      project: "fakeco",
      client: "crabhelm",
      retained: false,
      contentRef: null,
    },
  );
  assert.doesNotMatch(JSON.stringify(attributedEvent), /private prompt sentinel|messages|completion/i);
  for (const [tokenRef, credential] of [["no-fail-a", "no-fail-primary"], ["no-fail-b", "no-fail-backup"]]) {
    const stored = await fetch(`${base}/v1/admin/upstream-grants/policies/no_failover/${tokenRef}`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ provider: "local-openai", kind: "api_key", priority: 10, credential }) });
    assert.equal(stored.status, 200);
  }
  const noFailoverResponse = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${noFailoverKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "do not retry" }] }) });
  assert.equal(noFailoverResponse.status, 429);
  assert.deepEqual(noFailoverCalls, ["Bearer no-fail-primary"], "policy-disabled failover performs one upstream attempt");
  for (const [tokenRef, credential] of [["local-a-primary", "rate-limited"], ["local-b-backup", "healthy"]]) {
    const stored = await fetch(`${base}/v1/admin/upstream-grants/policies/failover/${tokenRef}`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ provider: "local-openai", kind: "api_key", priority: 10, credential }) });
    assert.equal(stored.status, 200, JSON.stringify(await stored.clone().json()));
  }
  const failoverRequest = () => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${failoverKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "route around quota" }] }) });
  const failedOver = await failoverRequest();
  assert.equal(failedOver.status, 200, JSON.stringify(await failedOver.clone().json()));
  assert.equal(failedOver.headers.get("x-clawrouter-grant-failover"), "1");
  assert.deepEqual(failoverCalls, ["Bearer rate-limited", "Bearer healthy"]);
  await waitUntil(async () => {
    const grants = await fetch(`${base}/v1/admin/upstream-grants`, { headers: adminHeaders });
    const primary = (await grants.json()).grants.find((item) => item.tokenRef === "local-a-primary");
    return primary?.quotaStatus === "cooldown" && primary.lastProviderSignal === "rate_limited" && primary.quotaWindows[0]?.remaining === 0;
  }, "rate-limited grant state was not visible to administrators");
  const routedAround = await failoverRequest();
  assert.equal(routedAround.status, 200);
  assert.equal(routedAround.headers.get("x-clawrouter-grant-failover"), null);
  assert.deepEqual(failoverCalls, ["Bearer rate-limited", "Bearer healthy", "Bearer healthy"], "cooldown state skips the exhausted grant on the next request");
  const callsBeforeUnavailablePool = upstreamCalls.length;
  const revokedBackup = await fetch(`${base}/v1/admin/upstream-grants/policies/failover/local-b-backup/revoke`, { method: "POST", headers: adminHeaders });
  assert.equal(revokedBackup.status, 200);
  const unavailablePool = await failoverRequest();
  assert.equal(unavailablePool.status, 503);
  assert.equal((await unavailablePool.json()).error.code, "upstream_grant_pool_unavailable");
  assert.equal(upstreamCalls.length, callsBeforeUnavailablePool, "cooled scoped grants never fall through to an unscoped provider credential");
  console.log(`local Worker smoke passed on ${base}`);
  if (process.env.CLAWROUTER_E2E_HOLD_FILE) {
    writeFileSync(process.env.CLAWROUTER_E2E_HOLD_FILE, `${JSON.stringify({ base, adminToken, rotationKey, noFailoverKey })}\n`, { mode: 0o600 });
    console.log("local Worker held for external behavior validation");
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nwrangler output:\n${output}`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  upstreamServer.closeAllConnections();
  await new Promise((resolve) => upstreamServer.close(resolve));
  rmSync(config, { force: true });
  rmSync(persistence, { recursive: true, force: true });
}

async function json(url) { const response = await fetch(url); assert.equal(response.status, 200, `${url} returned ${response.status}`); return response.json(); }
async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
async function waitUntilReady(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`wrangler exited with ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("wrangler local server did not become ready");
}
function availablePort() { return new Promise((resolve, reject) => { const server = createTcpServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); }); }); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function putLocalKv(key, value) { execFileSync("pnpm", ["exec", "wrangler", "kv", "key", "put", key, JSON.stringify(value), "--binding", "POLICY_KV", "--local", "--persist-to", persistence, "--config", config], { cwd: process.cwd(), env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "ignore" }); }
