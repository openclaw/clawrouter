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
export type ResponseControlAuthorization = { kind: "public"; binding: PublicControlBinding } | { kind: "collection" };

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

export async function authorizeResponseControl(env: Env, authorization: ResponseControlAuthorization, owner: ContinuationOwner, signal: AbortSignal, retentionProtocol?: string): Promise<AccessPolicy | undefined> {
  if (authorization?.kind === "collection") return;
  if (authorization?.kind !== "public" || !authorization.binding?.proof) denied();
  return authorizeIssuedControl(env, authorization.binding, owner, signal, retentionProtocol);
}

// The public path obtains this binding only from publicControlAuthorization.
// Delegated asset reads obtain it only from a validated, verifier-matched
// durable receipt issued by that path. URL fields never supply caller proof.
export async function authorizeIssuedControl(env: Env, binding: PublicControlBinding, owner: ContinuationOwner,
  signal: AbortSignal, retentionProtocol?: string): Promise<AccessPolicy> {
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
    { credentialId: binding.credentialId, principalId: binding.principalId, policyId: binding.policyId }, "policy-bindings", signal);
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
