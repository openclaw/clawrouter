import type { AccessPolicyEntry, AccessSession, ProxyCredential, ProxyCredentialEntry } from "./types";

export type CredentialMutation = {
  credentialId: string;
  scope: "admin" | "personal";
  actor: Pick<AccessSession, "auth" | "email" | "role">;
} & (
  | { operation: "create" | "put"; credential: Omit<ProxyCredential, "policyGeneration"> }
  | { operation: "rotate"; secretSha256: string }
  | { operation: "rename"; name: string | null }
  | { operation: "revoke" }
);
export type CredentialMutationResult =
  | { outcome: "invalid"; status: number; code: string; message: string }
  | { outcome: "updated"; entry: ProxyCredentialEntry; policy: AccessPolicyEntry | null; principalEnabled: boolean }
  | { outcome: "exists" | "missing" | "owned_elsewhere" | "limit_reached" | "policy_not_held" | "unknown_policy" | "inactive" | "actor_disabled" | "admin_required" };

export interface AuthorizationSnapshotRequest { credentialId: string | null; principalId: string | null; policyId: string }
export interface AuthorizationSnapshot {
  credential: ProxyCredential | null;
  policy: AccessPolicyEntry | null;
  principalEnabled: boolean | null;
  policyHeld: boolean;
}
