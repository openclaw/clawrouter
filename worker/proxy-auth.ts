import type { AccessPolicyEntry, AuthorizedIdentity, Env, ProxyCredential } from "./types";
import { resolveCredentials, resolvePolicies, resolveUsers } from "./authority";
import { errorResponse, HttpError, parseProxyKey, safeEqual, sha256Hex } from "./utils";

export interface ProxyKeyVerification { readonly kind: "proxy_key"; readonly credentialId: string; readonly principalId: string | null; readonly secretSha256: string }
const verifiedKeys = new WeakMap<AuthorizedIdentity, ProxyKeyVerification>();
export function proxyKeyVerification(identity: AuthorizedIdentity): ProxyKeyVerification | undefined { return verifiedKeys.get(identity); }

export async function authenticateProxyKey(headers: Headers, env: Env): Promise<AuthorizedIdentity | Response> {
  const parsed = proxyKeyFromHeaders(headers);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  const credentialEntry = (await resolveCredentials(env, [parsed.kid]))[0];
  if (!credentialEntry) return errorResponse("unknown_proxy_key", "proxy key is not registered", 401);
  const secretSha256 = await sha256Hex(parsed.secret);
  if (!safeEqual(secretSha256, credentialEntry.credential.secretSha256.toLowerCase())) return errorResponse("invalid_proxy_key", "proxy key secret is invalid", 401);
  const policyEntry = (await resolvePolicies(env, [credentialEntry.credential.policyId]))[0];
  const failure = proxyCredentialFailure(credentialEntry.credential, policyEntry);
  if (failure) return errorResponse(failure.code, failure.message, failure.status);
  const owner = credentialEntry.credential.principalId ? (await resolveUsers(env, [credentialEntry.credential.principalId]))[0] : undefined;
  // Unowned and unmaterialized service keys remain valid; explicit owner disable
  // blocks both new requests and subsequent admissions on existing WebSockets.
  const ownerFailure = proxyCredentialFailure(credentialEntry.credential, policyEntry, owner?.record.enabled);
  if (ownerFailure) return errorResponse(ownerFailure.code, ownerFailure.message, ownerFailure.status);
  const identity: AuthorizedIdentity = {
    credentialId: parsed.kid,
    principalId: credentialEntry.credential.principalId ?? null,
    authType: "proxy_key",
    policyId: credentialEntry.credential.policyId,
    policy: policyEntry!.policy,
    contentRetentionDisabled: owner?.record.contentRetentionDisabled ?? false,
  };
  verifiedKeys.set(identity, Object.freeze({ kind: "proxy_key", credentialId: parsed.kid, principalId: identity.principalId, secretSha256 }));
  return identity;
}

// Entry authentication and delayed control admission share these canonical
// lifecycle rules, including unowned/unmaterialized service-key semantics.
export function proxyCredentialFailure(credential: ProxyCredential, entry: AccessPolicyEntry | null | undefined, principalEnabled?: boolean | null): HttpError | null {
  if (!entry) return new HttpError(403, "credential_policy_missing", "proxy credential references an unknown access policy");
  if (!credential.enabled) return new HttpError(403, "proxy_key_revoked", "proxy key is revoked");
  if (!entry.policy.enabled) return new HttpError(403, "policy_revoked", "access policy is revoked");
  if (credential.policyGeneration !== entry.policy.generation) return new HttpError(403, "credential_policy_stale", "proxy credential is not bound to the current access policy generation");
  if (principalEnabled === false) return new HttpError(403, "principal_disabled", "proxy key owner is disabled");
  return null;
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
