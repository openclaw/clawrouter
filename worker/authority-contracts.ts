import type { AccessPolicyEntry, AccessSession, ProxyCredential, ProxyCredentialEntry } from "./types";

export type CredentialMutation = {
  credentialId: string;
  scope: "admin" | "personal";
  actor: Pick<AccessSession, "auth" | "email" | "role">;
} & (
  | { operation: "create" | "put"; credential: Omit<ProxyCredential, "policyGeneration" | "copilotPublicIdentity">;
      copilotPublicIdentity?: import("./copilot-public-identity.ts").CopilotPublicIdentityProfile | null }
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

// This provenance is produced by verified admin HTTP code, never grant JSON.
export type SearchGrantMutationActor = Pick<AccessSession, "auth" | "email" | "role">;
export interface SearchGrantAttestation {
  actor: SearchGrantMutationActor;
  key: string;
  original: { exists: boolean; generation: number; lineage: string | null; revision: number };
  resultGeneration: number;
  resultLineage: string;
  admissionRevision: number;
  digest: string;
}
