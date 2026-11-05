import { grantedServiceTiers } from "../shared/service-tiers.ts";
import { credentialExpiry } from "./credential-lifecycle.ts";
import { normalizeCredentialName } from "./credential-name.ts";
import type { CredentialMutation } from "./authority-contracts.ts";
import type { ProxyCredential, AccessPolicy, Env } from "./types";
import { HttpError } from "./utils.ts";
import { normalizeCopilotPublicIdentity, readCopilotPublicIdentity } from "./copilot-public-identity.ts";

// Called after authority checks ownership, actor state and required policy holdings.
export function nextCredential(request: CredentialMutation, existing: ProxyCredential | undefined, policy: AccessPolicy | undefined, principalId: string | null, env: Env): ProxyCredential {
  const { operation, scope } = request;
  const profileIntent = Object.hasOwn(request, "copilotPublicIdentity");
  if (profileIntent && (scope !== "admin" || !["create", "put"].includes(operation))
    || (operation === "create" || operation === "put") && Object.hasOwn(request.credential, "copilotPublicIdentity")) {
    throw new HttpError(403, "access_admin_required", "Copilot integration attestation requires administrator credential mutation");
  }
  // Rename, rotate and revoke mutate the latest row, never an earlier snapshot.
  // Only explicit PUT may rebind a key or renew its policy generation.
  if (operation === "rename") return { ...existing!, name: normalizeCredentialName(request.name) };
  const credential: ProxyCredential = operation === "create" || operation === "put"
    ? { ...request.credential, policyGeneration: policy!.generation, ...(scope === "personal" ? { enabled: true, principalId } : {}) }
    : { ...existing!, ...(operation === "rotate" ? { secretSha256: request.secretSha256 } : { enabled: false }) };
  if ((operation === "create" || operation === "put") && !credential.secretSha256) {
    if (scope !== "admin" || !existing) throw new HttpError(400, "invalid_credential", "secretSha256 is required for a new credential");
    credential.secretSha256 = existing.secretSha256;
  }
  if (operation === "rotate") credential.expiresAt = credentialExpiry(undefined, env, scope);
  else if (operation === "create" || operation === "put") {
    credential.expiresAt = scope === "admin" && existing && request.credential.expiresAt === undefined
      ? existing.expiresAt
      : credentialExpiry(request.credential.expiresAt, env, scope);
  }
  if (operation === "create" || operation === "put") {
    if (Object.hasOwn(request.credential, "name")) credential.name = normalizeCredentialName(request.credential.name);
    else if (existing && Object.hasOwn(existing, "name")) credential.name = existing.name;
    if (scope === "admin" && existing && request.credential.serviceTiers === undefined) credential.serviceTiers = existing.serviceTiers;
    if (scope === "personal" && credential.serviceTiers?.some(tier => !grantedServiceTiers(policy!).includes(tier))) throw new HttpError(400, "invalid_credential", "credential service tiers may only narrow policy access");
  }
  delete credential.copilotPublicIdentity;
  if ((operation === "create" || operation === "put") && credential.enabled) {
    if (profileIntent && request.copilotPublicIdentity !== null) {
      credential.copilotPublicIdentity = { revision: crypto.randomUUID(), profile: normalizeCopilotPublicIdentity(request.copilotPublicIdentity) };
    } else if (!profileIntent && existing?.enabled && existing.secretSha256 === credential.secretSha256
      && (existing.principalId ?? null) === (credential.principalId ?? null) && existing.policyId === credential.policyId
      && existing.policyGeneration === credential.policyGeneration) {
      const previous = readCopilotPublicIdentity(existing.copilotPublicIdentity);
      if (previous) credential.copilotPublicIdentity = previous;
    }
  }
  return credential;
}
