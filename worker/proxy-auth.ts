import type { AuthorizedIdentity, Env } from "./types";
import { resolveCredentials, resolvePolicies, resolveUsers } from "./authority";
import { errorResponse, parseProxyKey, safeEqual, sha256Hex } from "./utils";

export async function authenticateProxyKey(headers: Headers, env: Env): Promise<AuthorizedIdentity | Response> {
  const parsed = proxyKeyFromHeaders(headers);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  const credentialEntry = (await resolveCredentials(env, [parsed.kid]))[0];
  if (!credentialEntry) return errorResponse("unknown_proxy_key", "proxy key is not registered", 401);
  if (!safeEqual(await sha256Hex(parsed.secret), credentialEntry.credential.secretSha256.toLowerCase())) return errorResponse("invalid_proxy_key", "proxy key secret is invalid", 401);
  const policyEntry = (await resolvePolicies(env, [credentialEntry.credential.policyId]))[0];
  if (!policyEntry) return errorResponse("credential_policy_missing", "proxy credential references an unknown access policy", 403);
  if (!credentialEntry.credential.enabled) return errorResponse("proxy_key_revoked", "proxy key is revoked", 403);
  if (!policyEntry.policy.enabled) return errorResponse("policy_revoked", "access policy is revoked", 403);
  if (credentialEntry.credential.policyGeneration !== policyEntry.policy.generation) return errorResponse("credential_policy_stale", "proxy credential is not bound to the current access policy generation", 403);
  let exempt = false;
  if (credentialEntry.credential.principalId) exempt = (await resolveUsers(env, [credentialEntry.credential.principalId]))[0]?.record.contentRetentionDisabled ?? false;
  return {
    credentialId: parsed.kid,
    principalId: credentialEntry.credential.principalId ?? null,
    authType: "proxy_key",
    policyId: credentialEntry.credential.policyId,
    policy: policyEntry.policy,
    contentRetentionDisabled: exempt,
  };
}

export async function inspectKey(headers: Headers, env: Env): Promise<Response> {
  const parsed = proxyKeyFromHeaders(headers);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  const result = await authenticateProxyKey(headers, env);
  if (result instanceof Response) return result;
  return Response.json({
    kid: parsed.kid, mode: parsed.mode, syntaxValid: true, verified: true, verification: "verified",
    enabled: result.policy.enabled, providers: result.policy.providers, tenantId: result.policy.tenantId ?? null,
    tokenRole: result.policy.tokenRole ?? null, monthlyBudgetMicros: result.policy.monthlyBudgetMicros ?? null,
    requestCostMicros: result.policy.requestCostMicros ?? null, budgetScope: result.policy.budgetScope ?? "policy",
  });
}

function proxyKeyFromHeaders(headers: Headers) {
  const candidates = [headers.get("authorization")?.replace(/^Bearer\s+/i, ""), headers.get("x-api-key"), headers.get("x-goog-api-key"), headers.get("api-key")];
  return candidates.filter((value): value is string => !!value).map(parseProxyKey).find(Boolean);
}
