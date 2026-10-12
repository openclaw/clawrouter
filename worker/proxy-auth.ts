import { assertPolicyModel } from "./policy-models.ts";
import type { AdmissionSelection } from "./authority-admission.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { GrantSelectionResult } from "./grant-eligibility.ts";
import type { AccessPolicyEntry, AuthorizedIdentity, Env, ProxyCredential } from "./types";
import { authorityCall, type AdmissionProvider, type AdmissionResult } from "./authority.ts";
import { errorResponse, HttpError, parseProxyKey, safeEqual, sha256Hex } from "./utils.ts";

export interface ProxyKeyVerification { readonly kind: "proxy_key"; readonly credentialId: string; readonly principalId: string | null; readonly secretSha256: string }
const verifiedKeys = new WeakMap<AuthorizedIdentity, ProxyKeyVerification>();
// Scoped to this authenticated operation, never shared between requests or
// WebSocket creates. The next admission always goes back to the authority.
const admissions = new WeakMap<AuthorizedIdentity, AdmissionResult>();
const sessionHashes = new WeakMap<AuthorizedIdentity, string>();
export function proxyAdmission(identity: AuthorizedIdentity): AdmissionResult | undefined { return admissions.get(identity); }
export function proxySessionHash(identity: AuthorizedIdentity): string | undefined { return sessionHashes.get(identity); }
export function proxyKeyVerification(identity: AuthorizedIdentity): ProxyKeyVerification | undefined { return verifiedKeys.get(identity); }

export async function authenticateProxyKey(headers: Headers, env: Env, providers: AdmissionProvider[] = [], allConnections = false, sessionId?: string | null, selection?: AdmissionSelection): Promise<AuthorizedIdentity | Response> {
  const parsed = proxyKeyFromHeaders(headers);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  const secretSha256 = await sha256Hex(parsed.secret);
  const sessionHash = sessionId ? await sha256Hex(`session:${sessionId}`) : undefined;
  const admission = await authorityCall<AdmissionResult>(env, "/admission/resolve", { credentialId: parsed.kid, secretSha256, providers, allConnections, selection: selection ? { ...selection, sessionHash } : undefined });
  const credentialEntry = admission.credential;
  if (!credentialEntry) return errorResponse("unknown_proxy_key", "proxy key is not registered", 401);
  if (!safeEqual(secretSha256, credentialEntry.credential.secretSha256.toLowerCase())) return errorResponse("invalid_proxy_key", "proxy key secret is invalid", 401);
  if (admission.policyUnavailable) throw new Error("admission policy resolution failed");
  const policyEntry = admission.policy;
  const failure = proxyCredentialFailure(credentialEntry.credential, policyEntry);
  if (failure) return errorResponse(failure.code, failure.message, failure.status);
  if (admission.ownerUnavailable) throw new Error("admission owner resolution failed");
  const owner = admission.owner;
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
  admissions.set(identity, admission);
  if (selection) admissionRequests.set(identity, selection);
  if (selection && admission.selection) selections.set(identity, { request: selection, result: admission.selection });
  if (sessionHash) sessionHashes.set(identity, sessionHash);
  return identity;
}

const admissionRequests = new WeakMap<AuthorizedIdentity, AdmissionSelection>();
const selections = new WeakMap<AuthorizedIdentity, { request: AdmissionSelection; result: GrantSelectionResult }>();

export async function admittedGrantSelection(auth: AuthorizedIdentity, env: Env, requirement: GrantRequirement, excludedKeys: ReadonlySet<string>): Promise<GrantSelectionResult | undefined> {
  const initial = selections.get(auth);
  selections.delete(auth);
  if (!excludedKeys.size) return initial && initial.request.providerId === requirement.provider.id && initial.request.endpointId === requirement.endpoint.id && initial.request.mode === requirement.mode && initial.request.model === requirement.model ? initial.result : undefined;
  const verified = verifiedKeys.get(auth);
  if (!verified) return undefined;
  const request: AdmissionSelection = { providerId: requirement.provider.id, endpointId: requirement.endpoint.id, mode: requirement.mode, model: requirement.model, capability: requirement.provider.capabilities.find(item => item.endpoint === requirement.endpoint.id)?.id ?? requirement.endpoint.id, catalogModelId: admissionRequests.get(auth)?.catalogModelId ?? requirement.provider.models.find(item => item.upstream === requirement.model || item.id === requirement.model)?.id ?? null, excludedKeys: [...excludedKeys], sessionHash: sessionHashes.get(auth) };
  const admission = await authorityCall<AdmissionResult>(env, "/admission/resolve", { credentialId: verified.credentialId, secretSha256: verified.secretSha256, providers: [{ id: requirement.provider.id, tokenRef: requirement.provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? requirement.provider.id }], selection: request });
  if (!admission.credential || !safeEqual(verified.secretSha256, admission.credential.credential.secretSha256)) throw new HttpError(401, "invalid_proxy_key", "proxy key is no longer valid");
  if (admission.policyUnavailable || admission.ownerUnavailable || admission.connectionsUnavailable) throw new Error("admission unavailable");
  const failure = proxyCredentialFailure(admission.credential.credential, admission.policy, admission.owner?.record.enabled);
  if (failure) throw failure;
  if (admission.policy!.policy.providers.length && !admission.policy!.policy.providers.includes(requirement.provider.id)) throw new HttpError(403, "provider_not_allowed", "policy does not allow provider");
  if (admission.connections.find(item => item.providerId === requirement.provider.id)?.enabled === false) throw new HttpError(503, "provider_disabled", "provider is disabled");
  assertPolicyModel(admission.policy!.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint: requirement.endpoint, capability: request.capability });
  auth.principalId = admission.credential.credential.principalId ?? null;
  auth.policyId = admission.policy!.policyId;
  auth.policy = admission.policy!.policy;
  admissions.set(auth, admission);
  return admission.selection;
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
