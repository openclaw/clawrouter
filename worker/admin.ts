import { authorizeAdmin } from "./access";
import {
  authorityCall, listBindings, listConnections, listCredentials, listPolicies, listUsers,
} from "./authority";
import {
  listAssignmentRules, normalizeAssignmentEvidence, reconcileUserAssignments,
  type AssignmentEvidence,
} from "./assignments";
import { contentKey } from "./content-retention";
import { currentGrantRuntime, grantPriority, grantRuntimeStates, grantUsable, syncGrantPoolIndex, validCredentialBundle, validGrantSegment } from "./grant-selection";
import { assertFusionModels, loadFusionConfig, storeFusionConfig } from "./fusion-config";
import { fusionReadiness } from "./fusion-readiness";
import { normalizeFusionConfig } from "./fusion";
import { budgetStatus as policyBudgetStatus, usageSnapshots } from "./ledgers";
import { startOAuth } from "./oauth";
import { endpointForPath, listGrantRecords, listHealth, modelRoute, providerReadiness, providerReadinessForPolicies, providerReadinessFromState, refreshStoredGrant, snapshot } from "./providers";
import type { AdminBootstrapResponse } from "../shared/contracts";
import type {
  AccessControlUser, AccessPolicy, AccessPolicyEntry, AssignmentRule, Env, PolicyBinding,
  GrantRuntimeState, ProviderConnection, ProxyCredential, ProxyCredentialEntry, UpstreamGrant,
} from "./types";
import {
  cleanId, errorResponse, HttpError, normalizeEmail, nowIso, privateJson, randomId, readJson,
} from "./utils";

export async function adminApi(request: Request, env: Env, path: string): Promise<Response> {
  const authorization = await authorizeAdmin(request, env);
  if (authorization instanceof Response) return authorization;
  try {
    if (request.method === "GET" && path === "/v1/admin/content") return getContent(request, env);
    if (request.method === "GET" && path === "/v1/admin/bootstrap") return privateJson(await adminBootstrap(env));
    if (request.method === "GET" && path === "/v1/admin/overview") return privateJson(await overview(env));
    if (request.method === "GET" && ["/v1/admin/tenants", "/v1/admin/users"].includes(path)) return privateJson({ tenants: await tenants(env) });
    if (request.method === "GET" && path === "/v1/admin/usage") return adminUsage(env);
    if (request.method === "GET" && path === "/v1/admin/policies") return privateJson({ policies: (await listPolicies(env)).map(policyResponse) });
    if (request.method === "GET" && path === "/v1/admin/credentials") return privateJson({ credentials: await credentialResponses(env) });
    if (request.method === "GET" && path === "/v1/admin/connections") return privateJson({ connections: await connections(env) });
    if (request.method === "GET" && path === "/v1/admin/access-users") return privateJson({ users: (await listUsers(env)).map(userResponse) });
    if (request.method === "GET" && path === "/v1/admin/policy-bindings") return privateJson({ bindings: await listBindings(env) });
    if (request.method === "GET" && path === "/v1/admin/provider-status") return privateJson({ providers: await providerReadiness(env) });
    if (request.method === "GET" && path === "/v1/admin/provider-health") return privateJson({ providers: [...(await listHealth(env)).values()] });
    if (request.method === "GET" && path === "/v1/admin/upstream-grants") return privateJson({ grants: await upstreamGrantResponses(env, await listGrantRecords(env)) });
    if (request.method === "GET" && path === "/v1/admin/assignment-rules") return privateJson({ rules: await assignmentRules(env) });
    if (request.method === "GET" && path === "/v1/admin/fusion") return privateJson(await loadFusionConfig(env));

    if (path === "/v1/admin/policy-bindings" && request.method === "PUT") return putBinding(request, env);
    if (path === "/v1/admin/assignment-rules/reconcile" && request.method === "POST") return reconcileAssignments(request, env);
    if (path === "/v1/admin/fusion/preview" && request.method === "POST") return previewFusion(request, env);
    if (path === "/v1/admin/fusion" && request.method === "PUT") return privateJson(await storeFusionConfig(env, await readJson<unknown>(request)));
    if (path.startsWith("/v1/admin/assignment-rules/") && request.method === "PUT") return putAssignmentRule(request, env, path.slice("/v1/admin/assignment-rules/".length));
    if (path.startsWith("/v1/admin/access-user-grants/") && request.method === "PUT") return putUserGrants(request, env, path.slice("/v1/admin/access-user-grants/".length));
    if (path.startsWith("/v1/admin/access-users/") && request.method === "PUT") return putUser(request, env, path.slice("/v1/admin/access-users/".length));
    if (path.startsWith("/v1/admin/policies/")) return policyMutation(request, env, path.slice("/v1/admin/policies/".length));
    if (path.startsWith("/v1/admin/credentials/")) return credentialMutation(request, env, path.slice("/v1/admin/credentials/".length));
    if (path.startsWith("/v1/admin/connections/") && request.method === "PUT") return putConnection(request, env, path.slice("/v1/admin/connections/".length));
    if (path.startsWith("/v1/admin/upstream-grants/")) return upstreamGrantMutation(request, env, path.slice("/v1/admin/upstream-grants/".length));
    if (path === "/v1/admin/keys" && request.method === "GET") return privateJson({ keys: (await listPolicies(env)).map(legacyKeyResponse) });
    if (path.startsWith("/v1/admin/keys/")) return legacyKeyMutation(request, env, path.slice("/v1/admin/keys/".length));
    return errorResponse("route_not_found", "admin route not found", 404);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
    console.error("admin request failed", error instanceof Error ? error.message : String(error));
    return errorResponse("admin_error", "admin request failed", 500);
  }
}

async function previewFusion(request: Request, env: Env): Promise<Response> {
  const value = await readJson<unknown>(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "fusion_preview_invalid", "fusion readiness preview must be a JSON object");
  const input = value as { policyId?: unknown; config?: unknown };
  const policyId = typeof input.policyId === "string" ? cleanId(input.policyId) : null;
  if (!policyId) throw new HttpError(400, "fusion_policy_required", "a policy is required to preview fusion readiness");
  const entry = (await listPolicies(env)).find((candidate) => candidate.policyId === policyId);
  if (!entry) throw new HttpError(404, "fusion_policy_not_found", "fusion readiness policy was not found");
  const config = normalizeFusionConfig(input.config);
  assertFusionModels(config);
  const [readiness, budget] = await Promise.all([providerReadinessForPolicies(env, [entry]), policyBudgetStatus(env, entry.policyId, entry.policy)]);
  const routes = [...config.adviserModels, config.aggregatorModel].map((modelId) => {
    const route = modelRoute(modelId)!;
    return {
      modelId,
      providerId: route.provider.id,
      providerDisplayName: route.provider.display_name,
      endpointId: endpointForPath(route.provider, "/v1/chat/completions")!.id,
      model: route.model,
    };
  });
  return privateJson(fusionReadiness(config, entry, readiness, routes, budget));
}

async function getContent(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), tenant = url.searchParams.get("tenant"), ref = url.searchParams.get("ref");
  if (!tenant || !ref || tenant.length > 256 || ref.length > 256) throw new HttpError(400, "invalid_content_lookup", "tenant and ref query parameters are required");
  const object = await env.CONTENT_ARCHIVE.get(contentKey(tenant, ref));
  if (!object) throw new HttpError(404, "content_not_found", "retained request content was not found");
  return privateJson(await object.json());
}

async function overview(env: Env) {
  const policies = await listPolicies(env), credentials = await listCredentials(env);
  return overviewFrom(policies, credentials);
}

function overviewFrom(policies: AccessPolicyEntry[], credentials: ProxyCredentialEntry[]) {
  const active = new Map(policies.map((entry) => [entry.policyId, entry.policy.enabled]));
  return {
    policiesTotal: policies.length, policiesActive: policies.filter((entry) => entry.policy.enabled).length,
    keysTotal: credentials.length, keysActive: credentials.filter((entry) => entry.credential.enabled && active.get(entry.credential.policyId)).length,
    tenantsTotal: new Set(policies.map((entry) => entry.policy.tenantId ?? "default")).size,
    providerCount: snapshot.providers.length, openaiCompatibleProviders: snapshot.providers.filter((provider) => provider.class === "openai_compatible").length,
    manifestRoutes: snapshot.providers.reduce((sum, provider) => sum + provider.endpoints.length, 0),
    monthlyBudgetMicros: sum(policies.map((entry) => entry.policy.monthlyBudgetMicros)), requestCostMicros: sum(policies.map((entry) => entry.policy.requestCostMicros)),
  };
}

async function tenants(env: Env) {
  const policies = await listPolicies(env), credentials = await listCredentials(env);
  return tenantsFrom(policies, credentials);
}

function tenantsFrom(policies: AccessPolicyEntry[], credentials: ProxyCredentialEntry[]) {
  const groups = new Map<string, { tenantId: string; policies: number; activePolicies: number; keys: number; activeKeys: number; providers: Set<string>; allProviders: boolean; monthlyBudgetMicros: number; requestCostMicros: number }>();
  for (const entry of policies) {
    const id = entry.policy.tenantId ?? "default";
    const row = groups.get(id) ?? { tenantId: id, policies: 0, activePolicies: 0, keys: 0, activeKeys: 0, providers: new Set(), allProviders: false, monthlyBudgetMicros: 0, requestCostMicros: 0 };
    row.policies += 1; row.activePolicies += Number(entry.policy.enabled); row.allProviders ||= entry.policy.providers.length === 0;
    entry.policy.providers.forEach((provider) => row.providers.add(provider));
    row.monthlyBudgetMicros += entry.policy.monthlyBudgetMicros ?? 0; row.requestCostMicros += entry.policy.requestCostMicros ?? 0;
    groups.set(id, row);
  }
  const byId = new Map(policies.map((entry) => [entry.policyId, entry.policy]));
  for (const entry of credentials) {
    const policy = byId.get(entry.credential.policyId); if (!policy) continue;
    const row = groups.get(policy.tenantId ?? "default")!; row.keys += 1; row.activeKeys += Number(entry.credential.enabled && policy.enabled && entry.credential.policyGeneration === policy.generation);
  }
  return [...groups.values()].map((row) => ({ ...row, providers: [...row.providers].sort() }));
}

async function adminUsage(env: Env): Promise<Response> {
  const policies = await listPolicies(env);
  const rows = await Promise.all(policies.map(async (entry) => ({ ...legacyKeyResponse(entry), budget: await budgetStatus(env, entry) })));
  return privateJson({ policies: rows, keys: rows, usage: await usageSnapshots(env, policies.map((entry) => ({ policyId: entry.policyId, tenantId: entry.policy.tenantId ?? "default" }))) });
}

async function budgetStatus(env: Env, entry: AccessPolicyEntry) {
  const limit = entry.policy.monthlyBudgetMicros;
  if (limit == null) return { configured: false, ledger: "unmetered", windowKey: null, limitMicros: null, spentMicros: null, remainingMicros: null };
  const tenant = entry.policy.tenantId ?? "default", policyId = `${tenant}/${entry.policyId}`, windowKey = `${policyId}/${new Date().toISOString().slice(0, 7)}`;
  if (limit === 0) return { configured: true, ledger: "blocked", windowKey, limitMicros: 0, spentMicros: 0, remainingMicros: 0 };
  const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(`${tenant}:${entry.policyId}`));
  const url = new URL("https://clawrouter.internal/status"); url.searchParams.set("policy_id", policyId); url.searchParams.set("window_key", windowKey); url.searchParams.set("limit_micros", String(limit));
  const status = await (await stub.fetch(url)).json<{ spentMicros: number; remainingMicros: number }>();
  return { configured: true, ledger: "durable_object", windowKey, limitMicros: limit, ...status };
}

async function credentialResponses(env: Env) {
  return credentialResponsesFrom(await listPolicies(env), await listCredentials(env));
}

function credentialResponsesFrom(policyEntries: AccessPolicyEntry[], credentialEntries: ProxyCredentialEntry[]) {
  const policies = new Map(policyEntries.map((entry) => [entry.policyId, entry.policy]));
  return credentialEntries.map((entry) => {
    const policy = policies.get(entry.credential.policyId), generationMatches = !!policy && entry.credential.policyGeneration === policy.generation;
    return { credentialId: entry.credentialId, policyId: entry.credential.policyId, enabled: entry.credential.enabled, policyEnabled: policy?.enabled ?? false, generationMatches, active: entry.credential.enabled && !!policy?.enabled && generationMatches, principalId: entry.credential.principalId ?? null };
  });
}

async function connections(env: Env): Promise<ProviderConnection[]> {
  const stored = await listConnections(env, snapshot.providers.map((provider) => provider.id));
  return connectionsFrom(stored);
}

function connectionsFrom(stored: ProviderConnection[]): ProviderConnection[] {
  const byId = new Map(stored.map((connection) => [connection.providerId, connection]));
  return snapshot.providers.map((provider) => byId.get(provider.id) ?? { providerId: provider.id, enabled: true, label: null });
}

async function adminBootstrap(env: Env): Promise<AdminBootstrapResponse> {
  const [policies, credentials, users, bindings, storedConnections, grants, rules, health, fusion] = await Promise.all([
    listPolicies(env),
    listCredentials(env),
    listUsers(env),
    listBindings(env),
    listConnections(env, snapshot.providers.map((provider) => provider.id)),
    listGrantRecords(env),
    assignmentRules(env),
    listHealth(env),
    loadFusionConfig(env),
  ]);
  const connectionRows = connectionsFrom(storedConnections);
  return {
    policies: policies.map(policyResponse),
    credentials: credentialResponsesFrom(policies, credentials),
    connections: connectionRows,
    users: users.map(userResponse),
    bindings,
    providers: providerReadinessFromState(env, grants, connectionRows, health),
    grants: await upstreamGrantResponses(env, grants),
    rules,
    fusion,
    overview: overviewFrom(policies, credentials),
    tenants: tenantsFrom(policies, credentials),
  };
}

async function putBinding(request: Request, env: Env): Promise<Response> {
  const binding = normalizeBinding(await readJson<unknown>(request));
  if (!(await listPolicies(env)).some((entry) => entry.policyId === binding.policyId)) throw new HttpError(404, "unknown_policy", "bound policy does not exist");
  const existing = (await listBindings(env)).filter((item) => item.principalType === binding.principalType && item.principalId === binding.principalId);
  const seed = { principal: { principalType: binding.principalType, principalId: binding.principalId }, bindings: existing };
  await authorityCall(env, "/mutate", { seed, binding });
  return privateJson(binding);
}

async function putUser(request: Request, env: Env, encodedEmail: string): Promise<Response> {
  const email = normalizeEmail(decodeURIComponent(encodedEmail)); if (!email) throw new HttpError(400, "invalid_access_user", "invalid access user email");
  const existing = (await listUsers(env)).find((item) => item.email === email)?.record ?? {};
  const user: AccessControlUser = { email, record: normalizeUserMutation(await readJson<unknown>(request), existing).record };
  await authorityCall(env, "/users/put", user);
  return privateJson(userResponse(user));
}

async function putUserGrants(request: Request, env: Env, encodedEmail: string): Promise<Response> {
  const email = normalizeEmail(decodeURIComponent(encodedEmail)); if (!email) throw new HttpError(400, "invalid_access_user", "invalid access user email");
  const existing = (await listUsers(env)).find((item) => item.email === email)?.record ?? {};
  const { record, policyIds: ids } = normalizeUserMutation(await readJson<unknown>(request), existing, true);
  const known = new Set((await listPolicies(env)).map((entry) => entry.policyId)); if (ids.some((id) => !known.has(id))) throw new HttpError(404, "unknown_policy", "one or more policies do not exist");
  const user: AccessControlUser = { email, record };
  const principal = { principalType: "user" as const, principalId: email }, bindings = (await listBindings(env)).filter((item) => item.principalType === "user" && item.principalId === email);
  const result = await authorityCall<{ bindings: PolicyBinding[] }>(env, "/users/put-bindings", { user, policyIds: ids, seed: { principal, bindings } });
  return privateJson({ user: userResponse(user), bindings: result.bindings });
}

async function policyMutation(request: Request, env: Env, rest: string): Promise<Response> {
  const revoke = rest.endsWith("/revoke"), id = cleanId(decodeURIComponent(revoke ? rest.slice(0, -7) : rest));
  if (!id) throw new HttpError(400, "invalid_policy", "invalid policy id");
  let policy: AccessPolicy;
  if (revoke && request.method === "POST") {
    const existing = (await listPolicies(env)).find((entry) => entry.policyId === id)?.policy;
    if (!existing) throw new HttpError(404, "unknown_policy", "policy not found"); policy = { ...existing, enabled: false };
  }
  else if (request.method === "PUT") {
    const body = mutationObject(await readJson<unknown>(request), "invalid_policy", "policy");
    const existing = (await listPolicies(env)).find((entry) => entry.policyId === id)?.policy;
    policy = normalizePolicy(body, existing);
  }
  else throw new HttpError(405, "method_not_allowed", "admin method is not allowed");
  const entry = { policyId: id, policy }; await authorityCall(env, "/policies/put", entry);
  return privateJson(policyResponse(entry));
}

async function credentialMutation(request: Request, env: Env, rest: string): Promise<Response> {
  const revoke = rest.endsWith("/revoke"), id = cleanId(decodeURIComponent(revoke ? rest.slice(0, -7) : rest)); if (!id) throw new HttpError(400, "invalid_credential", "invalid credential id");
  const existing = (await listCredentials(env)).find((entry) => entry.credentialId === id)?.credential;
  let credential: ProxyCredential;
  if (revoke && request.method === "POST") { if (!existing) throw new HttpError(404, "unknown_credential", "credential not found"); credential = { ...existing, enabled: false }; }
  else if (request.method === "PUT") {
    const body = normalizeCredential(await readJson<unknown>(request)); const policy = (await listPolicies(env)).find((entry) => entry.policyId === body.policyId);
    if (!policy) throw new HttpError(404, "unknown_policy", "credential policy does not exist");
    credential = { ...body, policyId: policy.policyId, policyGeneration: policy.policy.generation };
  } else throw new HttpError(405, "method_not_allowed", "admin method is not allowed");
  const entry: ProxyCredentialEntry = { credentialId: id, credential }; await authorityCall(env, "/credentials/put", entry);
  return privateJson((await credentialResponses(env)).find((item) => item.credentialId === id));
}

async function putConnection(request: Request, env: Env, encodedId: string): Promise<Response> {
  const id = decodeURIComponent(encodedId), provider = snapshot.providers.find((item) => item.id === id); if (!provider) throw new HttpError(404, "unknown_provider", "provider does not exist");
  const connection = normalizeConnection(await readJson<unknown>(request), id);
  await authorityCall(env, "/connections/put", connection); return privateJson(connection);
}

async function upstreamGrantMutation(request: Request, env: Env, rest: string): Promise<Response> {
  const parts = rest.split("/").map(decodeURIComponent), action = ["revoke", "refresh", "authorize"].includes(parts.at(-1) ?? "") ? parts.pop() : null;
  if (parts.length !== 3 || !["policies", "tenants"].includes(parts[0])) throw new HttpError(400, "invalid_upstream_grant_route", "invalid upstream grant route");
  const [scope, scopeId, tokenRef] = parts, key = scope === "policies" ? `oauth/${scopeId}/${tokenRef}` : `oauth/tenants/${scopeId}/${tokenRef}`;
  if (!validGrantSegment(scopeId) || !validGrantSegment(tokenRef) || scope === "policies" && scopeId === "tenants") throw new HttpError(400, "invalid_upstream_grant_route", "scope id and token reference must be valid single key segments");
  if (action === "authorize" && request.method === "POST") {
    const body = mutationObject(await readJson<unknown>(request), "invalid_upstream_grant", "OAuth authorization");
    if (typeof body.provider !== "string" || !body.provider.trim()) throw new HttpError(400, "invalid_upstream_grant", "provider is required");
    const priority = body.priority ?? 100;
    if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 1_000_000) throw new HttpError(400, "invalid_upstream_grant", "grant priority must be an integer from 0 to 1000000");
    return startOAuth(request, env, key, body.provider.trim(), priority as number);
  }
  if (action === "refresh" && request.method === "POST") return privateJson(validatedGrantResponse(key, await refreshStoredGrant(env, key)));
  let grant: UpstreamGrant;
  let existing: UpstreamGrant | null;
  if (action === "revoke" && request.method === "POST") {
    existing = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
    if (!existing) throw new HttpError(404, "unknown_upstream_grant", "upstream grant is not registered"); grant = revokeGrant(existing);
  }
  else if (!action && request.method === "PUT") {
    const body = mutationObject(await readJson<unknown>(request), "invalid_upstream_grant", "upstream grant");
    existing = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
    grant = normalizeGrant(body, existing);
  }
  else throw new HttpError(405, "method_not_allowed", "admin method is not allowed");
  await syncGrantPoolIndex(env, key, existing, grant);
  try { await env.POLICY_KV.put(key, JSON.stringify(grant)); }
  catch (error) { await syncGrantPoolIndex(env, key, grant, existing).catch(() => undefined); throw error; }
  return privateJson(validatedGrantResponse(key, grant));
}

async function assignmentRules(env: Env) {
  return listAssignmentRules(env);
}

async function putAssignmentRule(request: Request, env: Env, encodedId: string): Promise<Response> {
  const id = cleanId(decodeURIComponent(encodedId)); if (!id) throw new HttpError(400, "invalid_assignment_rule", "invalid assignment rule id");
  const key = `access/assignment-rules/${id}`;
  const body = mutationObject(await readJson<unknown>(request), "invalid_assignment_rule", "assignment rule"), existing = await env.POLICY_KV.get<AssignmentRule>(key, "json"), now = nowIso();
  const rule = normalizeAssignmentRule(body, existing, now);
  const known = new Set((await listPolicies(env)).map((entry) => entry.policyId));
  if (rule.policyIds.some((policyId) => !known.has(policyId))) throw new HttpError(404, "unknown_policy", "one or more assignment policies do not exist");
  await env.POLICY_KV.put(key, JSON.stringify(rule));
  await syncAssignmentBindings(env, id, existing, rule);
  const rules = await assignmentRules(env);
  for (const user of await listUsers(env)) await reconcileUserAssignments(user, rules, env);
  return privateJson(assignmentResponse(id, rule));
}

function normalizeAssignmentRule(body: Record<string, unknown>, existing: AssignmentRule | null, now: string): AssignmentRule {
  const kinds: AssignmentRule["kind"][] = ["exact_email", "email_domain", "github_org", "github_team"];
  const kind = body.kind === undefined ? "exact_email" : body.kind;
  if (typeof kind !== "string" || !kinds.includes(kind as AssignmentRule["kind"])) throw new HttpError(400, "invalid_assignment_rule", "assignment rule kind is invalid");
  if (typeof body.subject !== "string" || !body.subject.trim()) throw new HttpError(400, "invalid_assignment_rule", "assignment rule subject is required");
  const groups = assignmentRuleStrings(body.groups, "groups"), policyIds = assignmentRuleStrings(body.policyIds, "policyIds");
  const priority = body.priority === undefined ? 100 : body.priority;
  if (!Number.isSafeInteger(priority) || (priority as number) < 0) throw new HttpError(400, "invalid_assignment_rule", "assignment rule priority must be a non-negative safe integer");
  const enabled = assignmentRuleBoolean(body.enabled, "enabled", true), revokeOnLoss = assignmentRuleBoolean(body.revokeOnLoss, "revokeOnLoss", true);
  const provenance = body.provenance === undefined ? "cloudflare_access" : body.provenance;
  if (typeof provenance !== "string" || !provenance.trim()) throw new HttpError(400, "invalid_assignment_rule", "assignment rule provenance is required");
  return { version: 1, enabled, kind: kind as AssignmentRule["kind"], subject: body.subject.trim().toLowerCase(), groups: normalizeGroups(groups), policyIds: [...new Set(policyIds)], priority: priority as number, revokeOnLoss, provenance: provenance.trim(), createdAt: existing?.createdAt ?? now, updatedAt: now };
}

function assignmentRuleStrings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(400, "invalid_assignment_rule", `assignment rule ${field} must be an array of strings`);
  return value as string[];
}

function assignmentRuleBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_assignment_rule", `assignment rule ${field} must be a boolean`);
  return value;
}

async function syncAssignmentBindings(env: Env, id: string, existing: AssignmentRule | null, rule: AssignmentRule): Promise<void> {
  const principal = { principalType: "group" as const, principalId: `assignment.${id}` };
  const current = (await listBindings(env)).filter((binding) => binding.principalType === principal.principalType && binding.principalId === principal.principalId);
  const policyIds = new Set([...(existing?.policyIds ?? []), ...rule.policyIds]);
  for (const policyId of policyIds) {
    const binding: PolicyBinding = { ...principal, policyId, enabled: rule.enabled && rule.policyIds.includes(policyId), priority: rule.priority };
    await authorityCall(env, "/mutate", { seed: { principal, bindings: current }, binding });
  }
}

async function reconcileAssignments(request: Request, env: Env): Promise<Response> {
  const body = mutationObject(await readJson<unknown>(request), "invalid_assignment_reconcile", "assignment reconciliation");
  if (body.all !== undefined && typeof body.all !== "boolean") throw new HttpError(400, "invalid_assignment_reconcile", "all must be a boolean");
  if (body.email !== undefined && typeof body.email !== "string") throw new HttpError(400, "invalid_assignment_reconcile", "email must be a string");
  const all = body.all === true, requestedEmail = body.email as string | undefined;
  if (all && requestedEmail !== undefined) throw new HttpError(400, "invalid_assignment_reconcile", "use either email or all, not both");
  if (all && body.evidence !== undefined) throw new HttpError(400, "invalid_assignment_reconcile", "verified GitHub evidence can reconcile only one email");
  let evidence: AssignmentEvidence | undefined;
  try { evidence = normalizeAssignmentEvidence(body.evidence as AssignmentEvidence | undefined); }
  catch (error) { throw new HttpError(400, "invalid_assignment_evidence", error instanceof Error ? error.message : "invalid assignment evidence"); }
  const users = await listUsers(env), email = normalizeEmail(requestedEmail ?? "");
  if (!all && !email) throw new HttpError(400, "invalid_assignment_reconcile", "email or all is required");
  const targets = all ? users : users.filter((user) => user.email === email);
  const rules = await assignmentRules(env), results = [];
  for (const user of targets) {
    const result = await reconcileUserAssignments(user, rules, env, evidence, true);
    results.push({ email: user.email, matchedRuleIds: result.matchedRuleIds, retainedRuleIds: result.retainedRuleIds, groups: result.user.record.groups ?? [] });
  }
  return privateJson({ results });
}

async function legacyKeyMutation(request: Request, env: Env, rest: string): Promise<Response> {
  const revoke = rest.endsWith("/revoke"), id = revoke ? rest.slice(0, -7) : rest;
  if (revoke) return credentialMutation(request, env, `${id}/revoke`);
  if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "admin method is not allowed");
  const body = mutationObject(await readJson<unknown>(request), "invalid_policy", "legacy key");
  if (body.secretSha256 !== undefined && (typeof body.secretSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(body.secretSha256))) throw new HttpError(400, "invalid_credential", "secretSha256 must be a SHA-256 hex digest");
  const requestedSecret = typeof body.secretSha256 === "string" ? body.secretSha256.toLowerCase() : undefined;
  const existingPolicy = (await listPolicies(env)).find((entry) => entry.policyId === id)?.policy;
  const existingCredential = (await listCredentials(env)).find((entry) => entry.credentialId === id)?.credential;
  const desiredPolicy = normalizePolicy(body, existingPolicy);
  const policyChanged = !!existingPolicy && JSON.stringify(desiredPolicy) !== JSON.stringify(existingPolicy);
  const secretChanged = !!existingCredential && !!requestedSecret && requestedSecret !== existingCredential.secretSha256.toLowerCase();
  if (policyChanged && secretChanged) throw new HttpError(409, "combined_policy_secret_rotation", "legacy key updates cannot change policy scope and secret together");
  const secretSha256 = requestedSecret ?? existingCredential?.secretSha256;
  if (!secretSha256) throw new HttpError(400, "invalid_credential", "secretSha256 is required when creating a legacy key");
  const policyResult = await policyMutation(new Request(request.url, { method: "PUT", headers: request.headers, body: JSON.stringify(body) }), env, id);
  if (!policyResult.ok) return policyResult;
  return credentialMutation(new Request(request.url, { method: "PUT", headers: request.headers, body: JSON.stringify({ secretSha256, policyId: id, enabled: body.enabled }) }), env, id);
}

function normalizePolicy(value: unknown, existing?: AccessPolicy): AccessPolicy {
  const body = mutationObject(value, "invalid_policy", "policy");
  if (body.providers !== undefined && (!Array.isArray(body.providers) || body.providers.some((id) => typeof id !== "string"))) throw new HttpError(400, "invalid_policy", "providers must be an array of strings");
  if (body.allProviders !== undefined && typeof body.allProviders !== "boolean") throw new HttpError(400, "invalid_policy", "allProviders must be a boolean");
  const allProviders = body.allProviders === true;
  if (!body.providers && !allProviders) throw new HttpError(400, "invalid_policy", "providers or allProviders is required");
  const providers = [...new Set((body.providers ?? []) as string[])].sort();
  if (allProviders && providers.length) throw new HttpError(400, "invalid_policy", "allProviders requires an empty provider scope");
  if (!providers.length && !allProviders) throw new HttpError(400, "invalid_policy", "empty provider scope requires allProviders");
  if (providers.some((id) => !snapshot.providers.some((provider) => provider.id === id))) throw new HttpError(400, "invalid_policy", "policy contains an unknown provider");
  const monthlyBudgetMicros = normalizeBudgetValue(body.monthlyBudgetMicros, "monthlyBudgetMicros");
  const requestCostMicros = normalizeBudgetValue(body.requestCostMicros, "requestCostMicros");
  return { enabled: policyBoolean(body.enabled, "enabled", true), generation: existing?.generation ?? randomId("policy"), providers, tenantId: policyString(body.tenantId, "tenantId", "default"), tokenRole: policyString(body.tokenRole, "tokenRole", "service"), monthlyBudgetMicros, requestCostMicros, retainRequestContent: policyBoolean(body.retainRequestContent, "retainRequestContent", true) };
}

function policyBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_policy", `${field} must be a boolean`);
  return value;
}

function policyString(value: unknown, field: string, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "invalid_policy", `${field} must be a non-empty string`);
  return value.trim();
}

function normalizeBudgetValue(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "invalid_policy", `${field} must be a non-negative safe integer`);
  return value;
}

async function upstreamGrantResponses(env: Env, grants: Array<{ key: string; grant: UpstreamGrant }>) {
  const states = await grantRuntimeStates(env, grants.map(({ key }) => key));
  return grants.map(({ key, grant }) => validatedGrantResponse(key, grant, states[key]));
}

function validatedGrantResponse(key: string, grant: UpstreamGrant, runtime?: GrantRuntimeState) {
  runtime = currentGrantRuntime(grant, runtime) ?? undefined;
  const credentialFields = grant.credentials && validCredentialBundle(grant.credentials) ? Object.keys(grant.credentials).sort() : [];
  const accessFlag = typeof grant.accessToken === "string" && grant.accessToken.trim().length > 0, refreshFlag = typeof grant.refreshToken === "string" && grant.refreshToken.trim().length > 0;
  const coolingDown = !!runtime?.cooldownUntil && Date.parse(runtime.cooldownUntil) > Date.now();
  const quotaStatus: "unknown" | "available" | "limited" | "cooldown" = coolingDown ? "cooldown" : runtime?.status === "cooldown" ? "unknown" : runtime?.status ?? "unknown";
  return { ...grantResponse(key, grant), priority: grantPriority(grant), hasCredential: (typeof grant.credential === "string" && grant.credential.trim().length > 0) || credentialFields.length > 0, credentialFields, ["hasAccess" + "Token"]: accessFlag, ["hasRefresh" + "Token"]: refreshFlag, usable: grant.enabled !== false && grantUsable(grant), quotaStatus, quotaObservedAt: runtime?.observedAt ?? null, cooldownUntil: coolingDown ? runtime?.cooldownUntil ?? null : null, quotaSource: runtime?.source ?? null, lastProviderSignal: runtime?.lastSignal ?? null, quotaWindows: runtime?.windows ?? [] };
}

function normalizeBinding(value: unknown): PolicyBinding {
  const binding = mutationObject(value, "invalid_policy_binding", "policy binding") as Partial<PolicyBinding>;
  const principalType = binding.principalType;
  if (principalType !== "user" && principalType !== "group") throw new HttpError(400, "invalid_policy_binding", "principalType must be user or group");
  if (typeof binding.principalId !== "string") throw new HttpError(400, "invalid_policy_binding", "principalId must be a string");
  const principalId = principalType === "user" ? normalizeEmail(binding.principalId) : binding.principalId.trim().toLowerCase();
  if (!principalId) throw new HttpError(400, "invalid_policy_binding", "principalId is invalid");
  if (typeof binding.policyId !== "string") throw new HttpError(400, "invalid_policy_binding", "policyId must be a string");
  const policyId = cleanId(binding.policyId);
  if (!policyId) throw new HttpError(400, "invalid_policy_binding", "policyId is invalid");
  const enabled = binding.enabled === undefined ? true : binding.enabled;
  if (typeof enabled !== "boolean") throw new HttpError(400, "invalid_policy_binding", "enabled must be a boolean");
  const priority = binding.priority === undefined ? 100 : binding.priority;
  if (!Number.isSafeInteger(priority) || (priority as number) < 0) throw new HttpError(400, "invalid_policy_binding", "priority must be a non-negative safe integer");
  return { policyId, principalType, principalId, enabled, priority: priority as number };
}

function normalizeConnection(value: unknown, providerId: string): ProviderConnection {
  const body = mutationObject(value, "invalid_provider_connection", "provider connection");
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== "boolean") throw new HttpError(400, "invalid_provider_connection", "enabled must be a boolean");
  if (body.label !== undefined && body.label !== null && typeof body.label !== "string") throw new HttpError(400, "invalid_provider_connection", "label must be a string or null");
  const label = typeof body.label === "string" ? body.label.trim() || null : null;
  return { providerId, enabled, label };
}

function normalizeCredential(value: unknown): Omit<ProxyCredential, "policyGeneration"> {
  const body = mutationObject(value, "invalid_credential", "credential");
  if (typeof body.policyId !== "string") throw new HttpError(400, "invalid_credential", "policyId must be a string");
  const policyId = cleanId(body.policyId);
  if (!policyId) throw new HttpError(400, "invalid_credential", "policyId is invalid");
  if (typeof body.secretSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(body.secretSha256)) throw new HttpError(400, "invalid_credential", "secretSha256 must be a SHA-256 hex digest");
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== "boolean") throw new HttpError(400, "invalid_credential", "enabled must be a boolean");
  let principalId: string | null = null;
  if (body.principalId !== undefined && body.principalId !== null) {
    if (typeof body.principalId !== "string") throw new HttpError(400, "invalid_credential", "principalId must be an email or null");
    const candidate = body.principalId.trim();
    if (candidate) {
      principalId = normalizeEmail(candidate);
      if (!principalId) throw new HttpError(400, "invalid_credential", "principalId must be a valid email");
    }
  }
  return { enabled, secretSha256: body.secretSha256.toLowerCase(), policyId, principalId };
}

function normalizeUserMutation(value: unknown, existing: AccessControlUser["record"], includePolicyIds = false): { record: AccessControlUser["record"]; policyIds: string[] } {
  const body = mutationObject(value, "invalid_access_user", "access user");
  const tenantId = userTenant(body.tenantId, existing.tenantId);
  const enabled = userBoolean(body.enabled, "enabled", existing.enabled ?? true, true);
  const groups = body.groups === undefined ? normalizeGroups(existing.groups ?? []) : userGroups(body.groups);
  const contentRetentionDisabled = userBoolean(body.contentRetentionDisabled, "contentRetentionDisabled", existing.contentRetentionDisabled ?? false);
  const record: AccessControlUser["record"] = { role: "user", tenantId, enabled, groups, contentRetentionDisabled };
  if (existing.assignmentState) record.assignmentState = existing.assignmentState;
  let policyIds: string[] = [];
  if (includePolicyIds) {
    const requestedPolicyIds = body.policyIds === undefined ? [] : body.policyIds;
    if (!Array.isArray(requestedPolicyIds) || requestedPolicyIds.some((id) => typeof id !== "string" || !cleanId(id))) throw new HttpError(400, "invalid_access_user", "policyIds must be an array of policy ids");
    policyIds = [...new Set(requestedPolicyIds.map((id) => cleanId(id as string)!))];
  }
  return { record, policyIds };
}

function userTenant(value: unknown, existing: string | null | undefined): string {
  if (value === undefined) return existing ?? "default";
  if (value === null) return "default";
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "invalid_access_user", "tenantId must be a non-empty string or null");
  return value.trim();
}

function userBoolean(value: unknown, field: string, fallback: boolean, allowNull = false): boolean {
  if (value === undefined) return fallback;
  if (value === null && allowNull) return true;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_access_user", `${field} must be a boolean${allowNull ? " or null" : ""}`);
  return value;
}

function userGroups(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((group) => typeof group !== "string")) throw new HttpError(400, "invalid_access_user", "groups must be an array of strings");
  return normalizeGroups(value as string[]);
}
function normalizeGrant(value: unknown, existing: UpstreamGrant | null): UpstreamGrant {
  const body = mutationObject(value, "invalid_upstream_grant", "upstream grant");
  const priority = body.priority ?? existing?.priority ?? 100;
  if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 1_000_000) throw new HttpError(400, "invalid_upstream_grant", "grant priority must be an integer from 0 to 1000000");
  const now = nowIso(), grant = { ...existing, ...body, version: 1, enabled: body.enabled ?? true, priority, kind: body.kind ?? "oauth", tokenType: body.tokenType ?? "Bearer", scopes: body.scopes ?? [], credentials: body.credentials ?? existing?.credentials ?? {}, createdAt: existing?.createdAt ?? now, updatedAt: now, revokedAt: null } as UpstreamGrant;
  if (!grant.provider) throw new HttpError(400, "invalid_upstream_grant", "provider is required");
  if (!snapshot.providers.some((provider) => provider.id === grant.provider)) throw new HttpError(400, "unknown_provider", "upstream grant provider is not registered");
  if (!validCredentialBundle(grant.credentials) || [grant.credential, grant.accessToken, grant.refreshToken].some((secret) => secret != null && (typeof secret !== "string" || !secret.trim().length))) throw new HttpError(400, "invalid_upstream_grant", "grant credentials must use non-empty string values");
  if (!grantUsable(grant)) throw new HttpError(400, "invalid_upstream_grant", "grant credential is required");
  return grant;
}
function revokeGrant(value: UpstreamGrant): UpstreamGrant { const { credential: _, credentials: __, accessToken: ___, refreshToken: ____, ...safe } = value; return { ...safe, enabled: false, credentials: {}, updatedAt: nowIso(), revokedAt: nowIso() }; }

function policyResponse(entry: AccessPolicyEntry) { return { policyId: entry.policyId, enabled: entry.policy.enabled, providers: entry.policy.providers, tenantId: entry.policy.tenantId ?? null, tokenRole: entry.policy.tokenRole ?? null, monthlyBudgetMicros: entry.policy.monthlyBudgetMicros ?? null, requestCostMicros: entry.policy.requestCostMicros ?? null, retainRequestContent: entry.policy.retainRequestContent !== false }; }
function legacyKeyResponse(entry: AccessPolicyEntry) { return { kid: entry.policyId, ...policyResponse(entry) }; }
function userResponse(user: AccessControlUser) { return { email: user.email, role: "user" as const, tenantId: user.record.tenantId ?? "default", enabled: user.record.enabled ?? true, groups: user.record.groups ?? [], contentRetentionDisabled: user.record.contentRetentionDisabled ?? false }; }
function grantResponse(key: string, grant: UpstreamGrant) { const parts = key.split("/"), tenant = parts[1] === "tenants"; return { key, scope: tenant ? "tenants" as const : "policies" as const, scopeId: tenant ? parts[2] : parts[1], tokenRef: tenant ? parts[3] : parts[2], version: grant.version ?? 1, enabled: grant.enabled ?? true, kind: grant.kind ?? "oauth", provider: grant.provider ?? null, label: grant.label ?? null, tokenType: grant.tokenType ?? "Bearer", expiresAt: grant.expiresAt ?? null, scopes: grant.scopes ?? [], accountId: grant.accountId ?? null, subscription: grant.subscription ?? null, createdAt: grant.createdAt ?? null, updatedAt: grant.updatedAt ?? null, revokedAt: grant.revokedAt ?? null, hasCredential: !!grant.credential || Object.keys(grant.credentials ?? {}).length > 0, credentialFields: Object.keys(grant.credentials ?? {}).sort(), hasAccessToken: !!grant.accessToken, hasRefreshToken: !!grant.refreshToken, refreshConfigured: !!grant.refresh, refreshTokenUrl: grant.refresh?.tokenUrl ?? null, clientIdConfig: grant.refresh?.clientIdConfig ?? null, clientSecretConfig: grant.refresh?.clientSecretConfig ?? null, usable: grant.enabled !== false && !!(grant.credential || grant.accessToken || Object.keys(grant.credentials ?? {}).length) }; }
function assignmentResponse(ruleId: string, rule: AssignmentRule) { return { ruleId, ...rule, generatedGroup: `assignment.${ruleId}` }; }
function normalizeGroups(values: string[]) { return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort(); }
function sum(values: Array<number | null | undefined>) { return values.reduce<number>((total, value) => total + (value ?? 0), 0); }
function mutationObject(value: unknown, code: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, code, `${label} must be an object`);
  return value as Record<string, unknown>;
}
