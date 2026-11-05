import type { BackgroundJob } from "./background-store.ts";
import { miniMaxT2VModels } from "../shared/minimax-video-binding.ts";
import { videoControlVersion, videoJsonBytes } from "./minimax-video-operation.ts";
import type { MiniMaxVideoOperation } from "./minimax-video-operation.ts";
import type { MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import type { WanManagedOperation } from "./managed-media-json.ts";
import { requireManagedCreateAdmission } from "./upstream-retention-admission.ts";
import { credentialExpired, credentialExpiryError } from "./credential-lifecycle.ts";
import { accessIdentityVerification, type AccessVerification } from "./access.ts";
import { authorityCall } from "./authority.ts";
import type { AuthorizationSnapshot } from "./authority-contracts.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { currentLocalSession } from "./local-auth.ts";
import { proxyCredentialFailure, proxyKeyVerification, type ProxyKeyVerification } from "./proxy-auth.ts";
import type { AccessPolicy, AuthorizedIdentity, Env } from "./types.ts";
import { HttpError, safeEqual, sha256Hex } from "./utils.ts";

export interface PublicControlBinding {
  credentialId: string | null;
  principalId: string | null;
  policyId: string;
  policyGeneration: string;
  tenantId: string;
  proof: ProxyKeyVerification | AccessVerification;
}
export type ResponseControlAuthorization = { kind: "public"; binding: PublicControlBinding } | { kind: "collection"; video?: VideoCollectionContext };

interface VideoCollectionContext {
  version: typeof videoControlVersion; credentialId: string; principalId: string; policyId: string;
  tenantId: string; policyGeneration: string; model: string; requestedVersion: string;
}

// Constructed only by the durable collector from its admitted job, never HTTP input.
export function videoCollectionAuthorization(job: BackgroundJob): ResponseControlAuthorization {
  if (!job.facts) denied();
  const event = job.facts.event, managed = job.managed;
  if (!managed || managed.protocol !== "minimax.video" || managed.providerId !== "minimax" || job.owner.providerId !== "minimax"
    || event.auth_type !== "proxy_key" || event.provider !== "minimax" || event.capability !== "media.predict"
    || !event.credential_id || !event.principal_id || !event.policy_id || !event.tenant_id || !event.model
    || !(miniMaxT2VModels as readonly string[]).includes(managed.requestedVersion) || !job.owner.grantKey) denied();
  const video: VideoCollectionContext = { version: videoControlVersion, credentialId: event.credential_id,
    principalId: event.principal_id, policyId: event.policy_id, tenantId: event.tenant_id,
    policyGeneration: job.owner.policyGeneration, model: event.model, requestedVersion: managed.requestedVersion };
  videoJsonBytes(video); return { kind: "collection", video };
}

async function authorizeVideoCollection(env: Env, input: VideoCollectionContext, owner: ContinuationOwner,
  signal: AbortSignal, video?: MiniMaxVideoOperation): Promise<AccessPolicy> {
  videoJsonBytes(input);
  if (input.version !== videoControlVersion || Object.keys(input).length !== 8 || owner.providerId !== "minimax" || !owner.grantKey
    || input.policyGeneration !== owner.policyGeneration || !input.credentialId || !input.principalId
    || !(miniMaxT2VModels as readonly string[]).includes(input.requestedVersion)) denied();
  const snapshot = await authorityCall<AuthorizationSnapshot>(env, "/authorization/snapshot",
    { credentialId: input.credentialId, principalId: input.principalId, policyId: input.policyId, video: videoControlVersion },
    "policy-bindings", signal, undefined, undefined, video);
  signal.throwIfAborted();
  const credential = snapshot.credential, entry = snapshot.policy;
  if (!credential || !entry || entry.policyId !== input.policyId || credential.policyId !== input.policyId
    || credential.principalId !== input.principalId || snapshot.principalEnabled !== true
    || entry.policy.generation !== input.policyGeneration || (entry.policy.tenantId ?? "default") !== input.tenantId
    || entry.policy.providers.length && !entry.policy.providers.includes("minimax")
    || entry.policy.models != null && !entry.policy.models.includes(input.model)
    || proxyCredentialFailure(credential, entry, snapshot.principalEnabled)) denied();
  return entry.policy;
}

export function publicControlAuthorization(auth: AuthorizedIdentity): ResponseControlAuthorization {
  // Only verifier-returned objects carry provenance. Public-looking identity
  // fields, copied sessions and missing proofs cannot become collector authority.
  const proof = auth.authType === "proxy_key" ? proxyKeyVerification(auth) : accessIdentityVerification(auth);
  if (!proof || (proof.kind === "proxy_key"
    ? proof.credentialId !== auth.credentialId || proof.principalId !== auth.principalId
    : auth.credentialId !== null || proof.email !== auth.principalId)) denied();
  return { kind: "public", binding: { credentialId: auth.credentialId, principalId: auth.principalId,
    policyId: auth.policyId, policyGeneration: auth.policy.generation, tenantId: auth.policy.tenantId ?? "default", proof } };
}

export async function authorizeResponseControl(env: Env, authorization: ResponseControlAuthorization, owner: ContinuationOwner, signal: AbortSignal, retentionProtocol?: string, wan?: WanManagedOperation, search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, boundedVideo = false): Promise<AccessPolicy | undefined> {
  if (authorization?.kind === "collection") {
    if (authorization.video) return authorizeVideoCollection(env, authorization.video, owner, signal, video);
    if (video) denied();
    return;
  }
  if (authorization?.kind !== "public" || !authorization.binding?.proof) denied();
  return authorizeIssuedControl(env, authorization.binding, owner, signal, retentionProtocol, wan, search, video, boundedVideo);
}

// The public path obtains this binding only from publicControlAuthorization.
// Delegated asset reads obtain it only from a validated, verifier-matched
// durable receipt issued by that path. URL fields never supply caller proof.
export async function authorizeIssuedControl(env: Env, binding: PublicControlBinding, owner: ContinuationOwner,
  signal: AbortSignal, retentionProtocol?: string, wan?: WanManagedOperation, search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, boundedVideo = false): Promise<AccessPolicy> {
  const proof = binding.proof;
  assertIssuedControlLive(binding);
  if (binding.policyGeneration !== owner.policyGeneration) denied();
  if (proof.kind === "proxy_key") {
    if (proof.credentialId !== binding.credentialId || proof.principalId !== binding.principalId) denied();
  } else if (!["local", "cloudflare_access"].includes(proof.kind) || binding.credentialId !== null || proof.email !== binding.principalId) denied();
  // Local logout is a fresh KV observation, separate from the SQL authority
  // snapshot. Neither claims atomic revocation across stores or a live IdP check.
  if (proof.kind === "local" && !await currentLocalSession(proof, env)) denied();
  signal.throwIfAborted();
  const snapshot = await authorityCall<AuthorizationSnapshot>(env, "/authorization/snapshot",
    { credentialId: binding.credentialId, principalId: binding.principalId, policyId: binding.policyId, ...(video || boundedVideo ? { video: videoControlVersion } : {}) }, "policy-bindings", signal, wan, search, video);
  const policy = snapshot.policy;
  if (!policy || policy.policyId !== binding.policyId || !policy.policy.enabled || policy.policy.generation !== binding.policyGeneration
    || (policy.policy.tenantId ?? "default") !== binding.tenantId
    || policy.policy.providers.length && !policy.policy.providers.includes(owner.providerId)) denied();
  if (retentionProtocol) requireManagedCreateAdmission(policy.policy, env, owner, retentionProtocol);
  if (proof.kind === "proxy_key") {
    const credential = snapshot.credential;
    if (!credential || credential.policyId !== binding.policyId || (credential.principalId ?? null) !== binding.principalId
      || !safeEqual(credential.secretSha256.toLowerCase(), proof.secretSha256)) denied();
    const failure = proxyCredentialFailure(credential, policy, snapshot.principalEnabled);
    if (failure) throw failure;
  } else if (snapshot.principalEnabled !== true || snapshot.policyHeld !== true) denied();
  return policy.policy;
}

// Called synchronously after the final await and immediately before fetch.
export function assertControlCallerLive(authorization: ResponseControlAuthorization): void {
  if (authorization?.kind === "collection") return;
  if (authorization?.kind !== "public" || !authorization.binding?.proof) denied();
  assertIssuedControlLive(authorization.binding);
}
export function assertIssuedControlLive(binding: PublicControlBinding): void {
  const proof = binding.proof;
  if (proof.kind === "proxy_key" && credentialExpired(proof)) throw credentialExpiryError(proof.expiresAt!);
  if (proof.kind !== "proxy_key" && (!Number.isSafeInteger(proof.expiresAtMs) || Date.now() >= proof.expiresAtMs)) denied();
}
function denied(): never { throw new HttpError(403, "response_caller_unavailable", "the original response caller is no longer authorized"); }

// Public proof is revalidated by authorizeResponseControl before using this
// scope. Collection authority must never authorize a new input upload/create.
export async function publicControlScope(authorization: ResponseControlAuthorization): Promise<string> {
  if (authorization?.kind !== "public" || !authorization.binding?.proof) denied();
  const { binding } = authorization;
  return `http-continuations:${await sha256Hex(JSON.stringify([binding.proof.kind === "proxy_key" ? "proxy_key" : "access",
    binding.tenantId, binding.policyId, binding.credentialId, binding.principalId]))}`;
}
