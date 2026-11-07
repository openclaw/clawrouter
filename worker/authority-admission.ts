import { videoControlVersion, videoJsonBytes, videoUnavailable } from "./minimax-video-operation.ts";
import { isMiniMaxVideoModel } from "../shared/minimax-video-binding.ts";
import { searchControlVersion, searchJsonBytes, searchUnavailable } from "./minimax-search-operation.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import { musicCoverControlVersion, musicCoverUnavailable } from "./minimax-music-cover-control.ts";
import type { MusicCoverControlProfile } from "./authority-contracts.ts";
import type { AccessControlUser, AccessPolicyEntry, AccessUserRecord, Env, GrantRuntimeState, ProviderConnection, ProxyCredentialEntry, UpstreamGrant } from "./types";
import type { GrantSelectionResult } from "./grant-eligibility.ts";
import { normalizeEmail, safeEqual } from "./utils.ts";

export interface AdmissionProvider { id: string; tokenRef: string }
export interface AdmissionSelection {
  providerId: string; endpointId: string; mode: "http" | "websocket";
  model?: string | null; catalogModelId?: string | null; capability: string;
  sessionHash?: string; excludedKeys?: string[];
  // Undefined selects freely; null pins environment auth; a key pins that owner.
  pinnedKey?: string | null;
}
// "select" also returns the pool snapshot after selecting; "only" returns the
// snapshot without selecting or touching counters (stale-cache refresh).
export interface AdmissionRequest { cover?: MusicCoverControlProfile; video?: typeof videoControlVersion; search?: typeof searchControlVersion; selection?: AdmissionSelection; credentialId: string; secretSha256?: string; providers?: AdmissionProvider[]; allConnections?: boolean; snapshot?: "select" | "only" }
export interface AdmissionPool { keys: string[]; states: Record<string, GrantRuntimeState>; hasAttachment: boolean; unavailable?: true }
export interface AdmissionPoolCandidate { key: string; grant: UpstreamGrant | null }
// Secretless routing state for isolate-local selection: projections, counters,
// cursor and attachment revisions. Never contains credential material.
export interface AdmissionPoolSnapshot {
  poolKey: string;
  candidates: AdmissionPoolCandidate[];
  revisions: Record<string, number>;
  cursorKey: string | null;
  counts: Record<string, { count: number; lastMs: number }>;
  identityHash: string;
  fallbackSessionHash: string;
}
export interface AdmissionResult {
  selection?: GrantSelectionResult;
  credential: ProxyCredentialEntry | null;
  policy: AccessPolicyEntry | null;
  owner: AccessControlUser | null;
  connections: ProviderConnection[];
  pools: Record<string, AdmissionPool>;
  policyUnavailable?: true;
  ownerUnavailable?: true;
  connectionsUnavailable?: true;
  snapshots?: Record<string, AdmissionPoolSnapshot>;
}

interface AdmissionStore {
  finishSelection?(input: AdmissionRequest, result: AdmissionResult): Promise<AdmissionResult>;
  getCredential(id: string): ProxyCredentialEntry | null;
  getPolicy(id: string): AccessPolicyEntry | null;
  getUser(email: string): AccessControlUser | null;
  hasMeta(key: string): boolean;
  putMeta(key: string): void;
  seedCredential(id: string, value: Record<string, unknown>): void;
  seedPolicy(id: string, value: Record<string, unknown>): void;
  initializeUsers(users: AccessControlUser[]): void;
  initializeConnections(connections: ProviderConnection[]): void;
  resolveConnections(ids: string[]): { initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] };
  resolveGrantPool(input: { providerId: string; policyId: string; tenantId: string; defaultKeys: string[] }): AdmissionPool;
}

export async function resolveAdmission(env: Env, input: AdmissionRequest, store: AdmissionStore): Promise<AdmissionResult> {
  // Use the same import fences as the single-purpose resolvers. Every KV
  // await is followed by guarded initialization and a canonical reread.
  const video = input.video === videoControlVersion;
  const cover = input.cover === musicCoverControlVersion;
  const search = input.search === searchControlVersion || video || cover;
  if (cover) {
    searchJsonBytes(input);
    if (Object.keys(input).some(key => !["cover", "credentialId", "secretSha256", "providers", "allConnections", "selection"].includes(key))
      || input.allConnections || input.providers?.length !== 1 || input.providers[0].id !== "minimax" || input.providers[0].tokenRef !== "minimax"
      || !input.selection || Object.keys(input.selection).some(key => !["providerId", "endpointId", "mode", "model", "catalogModelId", "capability", "sessionHash"].includes(key))
      || input.selection.providerId !== "minimax" || input.selection.endpointId !== "music-cover"
      || input.selection.mode !== "http" || input.selection.model !== "music-cover" || input.selection.catalogModelId !== "minimax/music-cover"
      || input.selection.capability !== "music.generate") musicCoverUnavailable();
  }
  if (video) {
    videoJsonBytes(input);
    if (input.search || input.allConnections || input.snapshot || input.providers?.length !== 1 || input.providers[0].id !== "minimax"
      || input.selection && (input.selection.providerId !== "minimax" || input.selection.capability !== "media.predict"
        || !isMiniMaxVideoModel(input.selection.model))) videoUnavailable();
  }
  if (search && !video && !cover) { searchJsonBytes(input); if (input.allConnections || input.snapshot || input.providers?.length !== 1 || input.selection?.providerId !== "minimax" || input.selection.model != null || input.selection.capability !== "search.web") searchUnavailable(); }
  let credential = store.getCredential(input.credentialId);
  if (!search && !credential && !store.hasMeta("credentials_global_initialized")) {
    const value = await env.POLICY_KV.get<Record<string, unknown>>(`credentials/${input.credentialId}`, "json") ?? await genuineLegacyKey(env, input.credentialId);
    if (value) store.seedCredential(input.credentialId, value);
    credential = store.getCredential(input.credentialId);
  }
  const result: AdmissionResult = { credential, policy: null, owner: null, connections: [], pools: {} };
  if (!credential) return result;
  // A wrong secret stops before policy, connection and pool reads, so a known key
  // id cannot make the global authority do pool work. The Worker re-verifies.
  if (typeof input.secretSha256 === "string" && !safeEqual(input.secretSha256.toLowerCase(), credential.credential.secretSha256.toLowerCase())) return result;
  const policyId = credential.credential.policyId;
  let policy: AccessPolicyEntry | null;
  try {
    policy = store.getPolicy(policyId);
    if (!search && !policy && !store.hasMeta("policies_global_initialized")) {
      const value = await env.POLICY_KV.get<Record<string, unknown>>(`policies/${policyId}`, "json") ?? await genuineLegacyKey(env, policyId);
      if (value) store.seedPolicy(policyId, value);
      policy = store.getPolicy(policyId);
    }
  } catch {
    return { ...result, policyUnavailable: true };
  }
  result.policy = policy;
  if (!policy || !credential.credential.enabled || credentialExpired(credential.credential) || !policy.policy.enabled || credential.credential.policyGeneration !== policy.policy.generation) return result;
  const principalId = credential.credential.principalId;
  if (principalId) {
    const email = normalizeEmail(principalId);
    if (email) {
      let owner: AccessControlUser | null;
      try {
        owner = store.getUser(email);
        if (!search && !owner && !store.hasMeta("users_global_initialized")) {
          const record = await env.POLICY_KV.get<AccessUserRecord>(`access/users/${email}`, "json");
          if (record) store.initializeUsers([{ email, record }]);
          owner = store.getUser(email);
        }
      } catch {
        return { ...result, ownerUnavailable: true };
      }
      result.owner = owner;
      if (cover && !owner) musicCoverUnavailable();
      if (owner?.record.enabled === false) return result;
    }
  }
  const providers = input.providers ?? [];
  const ids = [...new Set(providers.filter(provider => input.allConnections || !policy.policy.providers.length || policy.policy.providers.includes(provider.id)).map(provider => provider.id))];
  try {
    let connections = store.resolveConnections(ids);
    if (search && connections.missingProviderIds.length) searchUnavailable();
    if (!search && !connections.initialized && (input.allConnections || connections.missingProviderIds.length)) {
      const seeded = (await Promise.all(connections.missingProviderIds.map(id => env.POLICY_KV.get<ProviderConnection>(`connections/${id}`, "json")))).filter(Boolean) as ProviderConnection[];
      store.initializeConnections(seeded);
      if (input.allConnections) store.putMeta("connections_global_initialized");
      connections = store.resolveConnections(ids);
    }
    result.connections = connections.connections;
  } catch {
    // The Worker must check the secret and policy/model before surfacing a
    // provider-read failure, just as it did with separate RPCs.
    result.connectionsUnavailable = true;
  }
  for (const provider of providers) {
    if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id)) continue;
    try { result.pools[provider.id] = store.resolveGrantPool({ providerId: provider.id, policyId, tenantId: policy.policy.tenantId ?? "default", defaultKeys: cover ? [] : [`oauth/${policyId}/${provider.tokenRef}`, `oauth/tenants/${policy.policy.tenantId ?? "default"}/${provider.tokenRef}`] }); }
    catch { result.pools[provider.id] = { keys: [], states: {}, hasAttachment: false, unavailable: true }; }
  }
  return input.selection && store.finishSelection ? store.finishSelection(input, result) : result;
}

export async function genuineLegacyKey(env: Env, id: string, boundedRead?: (key: string) => Promise<Record<string, unknown> | null>): Promise<Record<string, unknown> | null> {
  const value = boundedRead ? await boundedRead(`keys/${id}`) : await env.POLICY_KV.get<Record<string, unknown>>(`keys/${id}`, "json");
  return value && (value.generation == null || value.generation === "legacy") ? value : null;
}
