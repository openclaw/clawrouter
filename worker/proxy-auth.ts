import { admitAdmission, admitIdentity, admittedEffectivePolicy, identityFailure, identityPlan } from "./identity-admission.ts";
import { videoControlVersion, videoUnavailable, type MiniMaxVideoOperation } from "./minimax-video-operation.ts";
import { authorityCall } from "./authority.ts";
import { coverControlHeaders, musicCoverControlVersion, musicCoverUnavailable, isMusicCoverControl, type MiniMaxMusicCoverControl } from "./minimax-music-cover-control.ts";
import { searchControlVersion, searchUnavailable, type MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import { effectiveBudgetPolicy } from "./budget-overrides.ts";
import { markLocalError } from "./native-errors.ts";
import { recordAdmissionDuration } from "./admission-timing.ts";
import { allowedServiceTiers } from "../shared/service-tiers.ts";
import { snapshot } from "./providers.ts";
import { budgetStatus } from "./ledgers.ts";
import { budgetPrincipal } from "./budget-scope.ts";
import { credentialExpired, credentialExpiryError } from "./credential-lifecycle.ts";
import { assertPolicyModel } from "./policy-models.ts";
import type { AdmissionSelection } from "./authority-admission.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { GrantSelectionResult } from "./grant-eligibility.ts";
import type { AccessPolicyEntry, AuthorizedIdentity, Env, ProxyCredential } from "./types";
import type { AdmissionProvider, AdmissionResult } from "./authority.ts";
import { resolveAdmission } from "./admission-cache.ts";
import { ownedErrorResponse, errorResponse, HttpError, parseProxyKey, safeEqual, sha256Hex } from "./utils.ts";
import { checkOwnedHttpRequest, growOwnedHttpRequest, ownedHttpCompletion, type OwnedHttpRequest } from "./http-identity-owner.ts";
import { resolveOwnedHttpAuthentication, matchesOwnedHttpControlVerification } from "./credential-preflight.ts";

export interface ProxyKeyVerification { readonly kind: "proxy_key"; readonly credentialId: string; readonly principalId: string | null; readonly secretSha256: string; readonly expiresAt?: string | null }
const verifiedKeys = new WeakMap<AuthorizedIdentity, ProxyKeyVerification>();
// Scoped to this authenticated operation. Cross-request reuse happens only in
// admission-cache.ts, bounded by the hot-cache max age.
const admissions = new WeakMap<AuthorizedIdentity, AdmissionResult>();
let ownedControlVerifications: WeakMap<OwnedHttpRequest, AuthorizedIdentity[]> | undefined;
let ownedControlVerificationCount = 0;

// Fixed receiver from the genuine generation owner. Only scalars cross this
// seam; no caller-supplied proof/identity graph or callback acquires authority.
// Existing provider controls keep their current-verification and native I/O.
export function acceptOwnedHttpControlVerification(cap: OwnedHttpRequest, identity: AuthorizedIdentity,
  kid: string, principalId: string | null, digest: string, expiresAt: string | null | undefined): void {
  if (!matchesOwnedHttpControlVerification(cap, identity, kid, principalId, digest, expiresAt)) throw identityFailure("protocol");
  const existing = ownedControlVerifications?.get(cap);
  if (existing?.includes(identity)) return;
  growOwnedHttpRequest(cap, 2048 + 2 * (kid.length + (principalId?.length ?? 0) + digest.length + (expiresAt?.length ?? 0)));
  const proof: ProxyKeyVerification = Object.freeze({ kind: "proxy_key", credentialId: kid, principalId, secretSha256: digest, expiresAt });
  if (!ownedControlVerifications) ownedControlVerifications = new WeakMap();
  if (existing) existing.push(identity);
  else { ownedControlVerifications.set(cap, [identity]); ownedControlVerificationCount++; }
  verifiedKeys.set(identity, proof);
}

export function retireOwnedHttpControlVerification(cap: OwnedHttpRequest): void {
  const identities = ownedControlVerifications?.get(cap);
  if (!identities) return;
  for (const identity of identities) verifiedKeys.delete(identity);
  identities.length = 0; ownedControlVerifications!.delete(cap);
  if (!--ownedControlVerificationCount) ownedControlVerifications = undefined;
}

/** Private HTTP entry only; no identity or admission graph leaves its owner. */
export function authenticateOwnedHttp(cap: OwnedHttpRequest, request: Request, env: Env,
  providers: AdmissionProvider[] = [], selection?: AdmissionSelection, sessionId?: string | null,
  freshness: "cached" | "authoritative" = "cached"): Promise<Response | null> {
  checkOwnedHttpRequest(cap, request, env);
  // Four examined RAW headers (4096 units each), replacement/parser strings,
  // ASCII hash bytes and two digest products. Native header allocation is not
  // included. The session input is separately admitted before prefix/encoding.
  growOwnedHttpRequest(cap, 131072 + (sessionId ? 8 * sessionId.length + 256 : 0));
  return ownedHttpCompletion(cap).start(async () => {
    const { parsed } = proxyKeyIngress(request.headers);
    if (!parsed) return ownedErrorResponse(cap, "invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
    if (parsed.secret.length > 4096) throw identityFailure("limit");
    const digest = await sha256Hex(parsed.secret);
    const sessionHash = sessionId ? await sha256Hex(`session:${sessionId}`) : undefined;
    const required = { providers, allConnections: false, snapshot: selection ? "select" as const : undefined,
      selection: selection ? { ...selection, sessionHash } : undefined };
    return resolveOwnedHttpAuthentication(cap, request, env, parsed.kid, digest, required, freshness);
  });
}
const coverIdentities = new WeakMap<MiniMaxMusicCoverControl, AuthorizedIdentity>();
export function musicCoverVerification(owner: MiniMaxMusicCoverControl): AuthorizedIdentity | undefined { return coverIdentities.get(owner); }
export function retireMusicCoverVerification(owner: MiniMaxMusicCoverControl): void {
  const identity = coverIdentities.get(owner);
  coverIdentities.delete(owner);
  if (!identity) return;
  admissions.delete(identity); verifiedKeys.delete(identity);
  admissionRequests.delete(identity); selections.delete(identity); sessionHashes.delete(identity);
}
const sessionHashes = new WeakMap<AuthorizedIdentity, string>();
export function proxyAdmission(identity: AuthorizedIdentity): AdmissionResult | undefined { return admissions.get(identity); }
export function proxySessionHash(identity: AuthorizedIdentity): string | undefined { return sessionHashes.get(identity); }
export function proxyKeyVerification(identity: AuthorizedIdentity): ProxyKeyVerification | undefined { return verifiedKeys.get(identity); }

export async function authenticateProxyKey(headers: Headers, env: Env, providers: AdmissionProvider[] = [], allConnections = false, sessionId?: string | null, selection?: AdmissionSelection, freshness: "cached" | "authoritative" = "cached", search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, cover?: MiniMaxMusicCoverControl): Promise<AuthorizedIdentity | Response> {
  const admissionStart = performance.now();
  if (cover) { if (!isMusicCoverControl(cover) || search || video || allConnections || sessionId) musicCoverUnavailable(); coverControlHeaders(headers); }
  const { parsed } = proxyKeyIngress(headers);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  return authenticateParsedProxyKey(parsed, env, providers, allConnections, sessionId, selection, freshness, search, video, cover, admissionStart);
}

async function authenticateParsedProxyKey(parsed: NonNullable<ReturnType<typeof parseProxyKey>>, env: Env, providers: AdmissionProvider[] = [], allConnections = false, sessionId?: string | null, selection?: AdmissionSelection, freshness: "cached" | "authoritative" = "cached", search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, cover?: MiniMaxMusicCoverControl, admissionStart = performance.now()): Promise<AuthorizedIdentity | Response> {
  // parseProxyKey accepts ASCII only: units equal encoded bytes. Check before encoding/hash.
  if (parsed.secret.length > 4096) throw identityFailure("limit");
  const secretSha256 = await sha256Hex(parsed.secret);
  const sessionHash = sessionId ? await sha256Hex(`session:${sessionId}`) : undefined;
  const admissionRequest = { credentialId: parsed.kid, secretSha256, providers, allConnections, selection: selection ? { ...selection, sessionHash } : undefined };
  const { admission, cache } = cover
    ? { admission: await authorityCall<AdmissionResult>(env, "/admission/resolve", { ...admissionRequest, cover: musicCoverControlVersion }, "policy-bindings", cover.operation.signal, undefined, undefined, undefined, cover), cache: "off" as const }
    : video
    ? { admission: await authorityCall<AdmissionResult>(env, "/admission/resolve", { ...admissionRequest, video: videoControlVersion }, "policy-bindings", video.operation.signal, undefined, undefined, video), cache: "off" as const }
    : search
    ? { admission: await authorityCall<AdmissionResult>(env, "/admission/resolve", { ...admissionRequest, search: searchControlVersion }, "policy-bindings", search.operation.signal, undefined, search), cache: "off" as const }
    : await resolveAdmission(env, admissionRequest, freshness);
  if (video && (admission.connectionsUnavailable || admission.connections.length !== 1 || admission.pools.minimax?.unavailable)) videoUnavailable();
  if (search && (admission.connectionsUnavailable || admission.connections.length !== 1 || admission.pools.minimax?.unavailable)) searchUnavailable();
  if (cover && (admission.connectionsUnavailable || admission.connections.length !== 1 || admission.pools.minimax?.unavailable || !admission.selection?.selected)) musicCoverUnavailable();
  if (!cover && !video && !search) admitAdmission(admission);
  const credentialEntry = admission.credential;
  if (!credentialEntry) return errorResponse("unknown_proxy_key", "proxy key is not registered", 401);
  if (!safeEqual(secretSha256, credentialEntry.credential.secretSha256.toLowerCase())) return errorResponse("invalid_proxy_key", "proxy key secret is invalid", 401);
  if (admission.policyUnavailable) throw new Error("admission policy resolution failed");
  const policyEntry = admission.policy;
  const failure = proxyCredentialFailure(credentialEntry.credential, policyEntry);
  if (failure) return failure.code === "proxy_key_expired"
    ? markLocalError(Response.json({ error: { code: failure.code, message: failure.message }, expiresAt: credentialEntry.credential.expiresAt, expired: true, active: false }, { status: 401 }), failure.code, failure.message)
    : errorResponse(failure.code, failure.message, failure.status);
  if (admission.ownerUnavailable) throw new Error("admission owner resolution failed");
  const owner = admission.owner;
  // Unowned and unmaterialized service keys remain valid; explicit owner disable
  // blocks both new requests and subsequent admissions on existing WebSockets.
  const ownerFailure = proxyCredentialFailure(credentialEntry.credential, policyEntry, owner?.record.enabled);
  if (ownerFailure) return errorResponse(ownerFailure.code, ownerFailure.message, ownerFailure.status);
  const identity: AuthorizedIdentity = {
    serviceTiers: credentialEntry.credential.serviceTiers,
    credentialId: parsed.kid,
    principalId: credentialEntry.credential.principalId ?? null,
    authType: "proxy_key",
    policyId: credentialEntry.credential.policyId,
    policy: cover || video || search ? effectiveBudgetPolicy(credentialEntry.credential.policyId, policyEntry!.policy, owner?.record.budgetOverrides) : admittedEffectivePolicy(credentialEntry.credential.policyId, policyEntry!.policy, owner?.record.budgetOverrides),
    contentRetentionDisabled: owner?.record.contentRetentionDisabled ?? false,
  };
  if (!cover && !video && !search) admitIdentity(identity);
  recordAdmissionDuration(identity, admissionStart, cache);
  verifiedKeys.set(identity, Object.freeze({ kind: "proxy_key", credentialId: parsed.kid, principalId: identity.principalId, secretSha256, expiresAt: credentialEntry.credential.expiresAt }));
  admissions.set(identity, admission);
  if (cover) coverIdentities.set(cover, identity);
  if (selection) admissionRequests.set(identity, selection);
  if (selection && admission.selection) selections.set(identity, { request: selection, result: admission.selection });
  if (sessionHash) sessionHashes.set(identity, sessionHash);
  return identity;
}

const admissionRequests = new WeakMap<AuthorizedIdentity, AdmissionSelection>();
const selections = new WeakMap<AuthorizedIdentity, { request: AdmissionSelection; result: GrantSelectionResult }>();

export async function admittedGrantSelection(auth: AuthorizedIdentity, env: Env, requirement: GrantRequirement, excludedKeys: ReadonlySet<string>, pinnedKey?: string | null, recordSelection = true): Promise<GrantSelectionResult | undefined> {
  const initial = selections.get(auth);
  if (!excludedKeys.size) { selections.delete(auth); return initial && initial.request.providerId === requirement.provider.id && initial.request.endpointId === requirement.endpoint.id && initial.request.mode === requirement.mode && initial.request.model === requirement.model && initial.request.pinnedKey === pinnedKey ? initial.result : undefined; }
  const verified = verifiedKeys.get(auth);
  if (!verified) return undefined;
  const request: AdmissionSelection = { providerId: requirement.provider.id, endpointId: requirement.endpoint.id, mode: requirement.mode, model: requirement.model, capability: requirement.provider.capabilities.find(item => item.endpoint === requirement.endpoint.id)?.id ?? requirement.endpoint.id, catalogModelId: admissionRequests.get(auth)?.catalogModelId ?? requirement.provider.models.find(item => item.upstream === requirement.model || item.id === requirement.model)?.id ?? null, excludedKeys: [...excludedKeys], sessionHash: sessionHashes.get(auth), pinnedKey };
  // A reserved choice is only revalidated, not selected/counted again. Keep the
  // failover path's fresh caller/policy/pool checks even for that nonselecting read.
  const { admission } = await resolveAdmission(env, { credentialId: verified.credentialId, secretSha256: verified.secretSha256, providers: [{ id: requirement.provider.id, tokenRef: requirement.provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? requirement.provider.id }], selection: recordSelection ? request : undefined }, recordSelection ? "cached" : "authoritative");
  if (!admission.credential || !safeEqual(verified.secretSha256, admission.credential.credential.secretSha256)) throw new HttpError(401, "invalid_proxy_key", "proxy key is no longer valid");
  if (admission.policyUnavailable || admission.ownerUnavailable || admission.connectionsUnavailable) throw new Error("admission unavailable");
  const failure = proxyCredentialFailure(admission.credential.credential, admission.policy, admission.owner?.record.enabled);
  if (failure) throw failure;
  if (admission.policy!.policy.providers.length && !admission.policy!.policy.providers.includes(requirement.provider.id)) throw new HttpError(403, "provider_not_allowed", "policy does not allow provider");
  if (admission.connections.find(item => item.providerId === requirement.provider.id)?.enabled === false) throw new HttpError(503, "provider_disabled", "provider is disabled");
  assertPolicyModel(admission.policy!.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint: requirement.endpoint, capability: request.capability });
  admitAdmission(admission);
  const next = {
    serviceTiers: admission.credential.credential.serviceTiers,
    principalId: admission.credential.credential.principalId ?? null,
    policyId: admission.policy!.policyId,
    policy: admittedEffectivePolicy(admission.policy!.policyId, admission.policy!.policy, admission.owner?.record.budgetOverrides),
  };
  identityPlan().object(0, field => {
    for (const key in auth) if (Object.hasOwn(auth, key) && !Object.hasOwn(next, key)) field(key, (auth as unknown as Record<string, unknown>)[key]);
    for (const key in next) if (Object.hasOwn(next, key)) field(key, next[key as keyof typeof next]);
  });
  // No await or possible profile denial after the first published field changes.
  Object.assign(auth, next); admissions.set(auth, admission); selections.delete(auth);
  return admission.selection;
}

// Entry authentication and delayed control admission share these canonical
// lifecycle rules, including unowned/unmaterialized service-key semantics.
export function proxyCredentialFailure(credential: ProxyCredential, entry: AccessPolicyEntry | null | undefined, principalEnabled?: boolean | null): HttpError | null {
  if (credentialExpired(credential)) return credentialExpiryError(credential.expiresAt!);
  if (!entry) return new HttpError(403, "credential_policy_missing", "proxy credential references an unknown access policy");
  if (!credential.enabled) return new HttpError(403, "proxy_key_revoked", "proxy key is revoked");
  if (!entry.policy.enabled) return new HttpError(403, "policy_revoked", "access policy is revoked");
  if (credential.policyGeneration !== entry.policy.generation) return new HttpError(403, "credential_policy_stale", "proxy credential is not bound to the current access policy generation");
  if (principalEnabled === false) return new HttpError(403, "principal_disabled", "proxy key owner is disabled");
  return null;
}

// Pure verdict for the CLOSED generation owner. This returns no identity and
// installs none of the ordinary proxy-auth WeakMap capabilities. The caller
// must own/fund the graph and result; ordinary entrypoints above are unchanged.
export function ownedGenerationCredentialFailure(admission: AdmissionResult, digest: string, refresh?: AdmissionSelection): HttpError | null {
  const entry = admission.credential;
  if (refresh) {
    if (!entry || !safeEqual(digest, entry.credential.secretSha256)) return new HttpError(401, "invalid_proxy_key", "proxy key is no longer valid");
    if (admission.policyUnavailable || admission.ownerUnavailable || admission.connectionsUnavailable) throw new Error("admission unavailable");
    const failure = proxyCredentialFailure(entry.credential, admission.policy, admission.owner?.record.enabled);
    if (failure) return failure;
    if (admission.policy!.policy.providers.length && !admission.policy!.policy.providers.includes(refresh.providerId)) return new HttpError(403, "provider_not_allowed", "policy does not allow provider");
    if (admission.connections.find(item => item.providerId === refresh.providerId)?.enabled === false) return new HttpError(503, "provider_disabled", "provider is disabled");
    const provider = snapshot.providers.find(item => item.id === refresh.providerId), endpoint = provider?.endpoints.find(item => item.id === refresh.endpointId);
    if (!provider || !endpoint) throw identityFailure("protocol");
    assertPolicyModel(admission.policy!.policy, { model: refresh.catalogModelId ? { id: refresh.catalogModelId } : null, endpoint, capability: refresh.capability });
    return null;
  }
  if (!entry) return new HttpError(401, "unknown_proxy_key", "proxy key is not registered");
  if (!safeEqual(digest, entry.credential.secretSha256.toLowerCase())) return new HttpError(401, "invalid_proxy_key", "proxy key secret is invalid");
  if (admission.policyUnavailable) throw new Error("admission policy resolution failed");
  const failure = proxyCredentialFailure(entry.credential, admission.policy);
  if (failure) return failure;
  if (admission.ownerUnavailable) throw new Error("admission owner resolution failed");
  return proxyCredentialFailure(entry.credential, admission.policy, admission.owner?.record.enabled);
}

export async function inspectKey(headers: Headers, env: Env): Promise<Response> {
  const { parsed } = proxyKeyIngress(headers);
  if (!parsed) return errorResponse("invalid_proxy_key", "a valid ClawRouter proxy key is required", 401);
  const result = await authenticateParsedProxyKey(parsed, env);
  if (result instanceof Response) return result;
  return Response.json({
    kid: parsed.kid, mode: parsed.mode, syntaxValid: true, verified: true, verification: "verified",
    enabled: result.policy.enabled, active: true, expiresAt: proxyKeyVerification(result)?.expiresAt ?? null, expired: false, providers: result.policy.providers, tenantId: result.policy.tenantId ?? null,
    tokenRole: result.policy.tokenRole ?? null, monthlyBudgetMicros: result.policy.monthlyBudgetMicros ?? null,
    serviceTiers: result.serviceTiers ?? null,
    effectiveServiceTiers: Object.fromEntries(snapshot.providers.filter(p => !result.policy.providers.length || result.policy.providers.includes(p.id)).flatMap(p => p.models.filter(m => result.policy.models == null || result.policy.models.includes(m.id)).map(m => [m.id, allowedServiceTiers(result.policy, m.id, result.serviceTiers)]))),
    dailyBudgetMicros: result.policy.dailyBudgetMicros ?? null, weeklyBudgetMicros: result.policy.weeklyBudgetMicros ?? null, limitHint: result.policy.limitHint ?? null,
    budget: await budgetStatus(env, result.policyId, result.policy, budgetPrincipal(result)),
    requestCostMicros: result.policy.requestCostMicros ?? null, requestCostsMicros: result.policy.requestCostsMicros ?? null, budgetScope: result.policy.budgetScope ?? "policy",
  });
}

export function hasProxyKeyIntent(headers: Headers): boolean {
  return proxyKeyIngress(headers).intent;
}

function proxyKeyIngress(headers: Headers) {
  let intent = false;
  for (const name of ["authorization", "x-api-key", "x-goog-api-key", "api-key"]) {
    const raw = headers.get(name);
    if (raw !== null && raw.length > 4096) throw identityFailure("limit");
    if (!raw) continue;
    const parsed = parseProxyKey(name === "authorization" ? raw.replace(/^Bearer\s+/i, "") : raw);
    if (parsed) return { parsed, intent: true };
    // Preserve Access precedence for malformed marker-bearing credentials.
    if (raw.includes("clawrouter-") || raw.includes("ocpk_")) intent = true;
  }
  return { parsed: null, intent };
}
