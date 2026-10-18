import { grantedServiceTiers } from "../shared/service-tiers.ts";
import { credentialExpiry } from "./credential-lifecycle.ts";
import type { CredentialMutation } from "./authority-contracts.ts";
import type { ProxyCredential, AccessPolicy, Env } from "./types";
import { HttpError } from "./utils.ts";

// Called only after the authority checks current ownership and policy holdings.
export function nextCredential(request: CredentialMutation, existing: ProxyCredential | undefined, policy: AccessPolicy | undefined, principalId: string | null, env: Env): ProxyCredential {
  const { operation, scope } = request;
  // Rotate and revoke mutate the latest row, never a caller's earlier snapshot.
  // Only explicit PUT may rebind a key or renew its policy generation.
  const credential = operation === "create" || operation === "put"
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
    if (scope === "admin" && existing && request.credential.serviceTiers === undefined) credential.serviceTiers = existing.serviceTiers;
    if (scope === "personal" && credential.serviceTiers?.some(tier => !grantedServiceTiers(policy!).includes(tier))) throw new HttpError(400, "invalid_credential", "credential service tiers may only narrow policy access");
  }
  return credential;
}
