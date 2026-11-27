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
// Internal canonical admission discriminator; it neither attests an actor nor
// authorizes materialization. The caller must hold the genuine phase owner.
export type MusicCoverControlProfile = "clawrouter.minimax-music-cover-control.v1";
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

// Private owner-to-authority proof, never an HTTP-supplied permission.
export interface MusicGrantAttestation extends SearchGrantAttestation {
  domain: "clawrouter.minimax-music-mutation.v1";
  scope: ["policies" | "tenants", string, string];
  mode: "preserve" | "replace" | "revoke" | "tombstone";
}

export interface VideoGrantAttestation extends SearchGrantAttestation {
  domain: "clawrouter.minimax-video-mutation.v1";
  scope: MusicGrantAttestation["scope"];
  mode: MusicGrantAttestation["mode"];
}
