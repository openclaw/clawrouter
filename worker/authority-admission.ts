import type { AccessControlUser, AccessPolicyEntry, AccessUserRecord, Env, GrantRuntimeState, ProviderConnection, ProxyCredentialEntry } from "./types";
import { normalizeEmail, safeEqual } from "./utils.ts";

export interface AdmissionProvider { id: string; tokenRef: string }
export interface AdmissionRequest { credentialId: string; secretSha256?: string; providers?: AdmissionProvider[]; allConnections?: boolean }
export interface AdmissionPool { keys: string[]; states: Record<string, GrantRuntimeState>; hasAttachment: boolean; unavailable?: true }
export interface AdmissionResult {
  credential: ProxyCredentialEntry | null;
  policy: AccessPolicyEntry | null;
  owner: AccessControlUser | null;
  connections: ProviderConnection[];
  pools: Record<string, AdmissionPool>;
  policyUnavailable?: true;
  ownerUnavailable?: true;
  connectionsUnavailable?: true;
}

interface AdmissionStore {
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
  let credential = store.getCredential(input.credentialId);
  if (!credential && !store.hasMeta("credentials_global_initialized")) {
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
    if (!policy && !store.hasMeta("policies_global_initialized")) {
      const value = await env.POLICY_KV.get<Record<string, unknown>>(`policies/${policyId}`, "json") ?? await genuineLegacyKey(env, policyId);
      if (value) store.seedPolicy(policyId, value);
      policy = store.getPolicy(policyId);
    }
  } catch {
    return { ...result, policyUnavailable: true };
  }
  result.policy = policy;
  if (!policy || !credential.credential.enabled || !policy.policy.enabled || credential.credential.policyGeneration !== policy.policy.generation) return result;
  const principalId = credential.credential.principalId;
  if (principalId) {
    const email = normalizeEmail(principalId);
    if (email) {
      let owner: AccessControlUser | null;
      try {
        owner = store.getUser(email);
        if (!owner && !store.hasMeta("users_global_initialized")) {
          const record = await env.POLICY_KV.get<AccessUserRecord>(`access/users/${email}`, "json");
          if (record) store.initializeUsers([{ email, record }]);
          owner = store.getUser(email);
        }
      } catch {
        return { ...result, ownerUnavailable: true };
      }
      result.owner = owner;
      if (owner?.record.enabled === false) return result;
    }
  }
  const providers = input.providers ?? [];
  const ids = [...new Set(providers.filter(provider => input.allConnections || !policy.policy.providers.length || policy.policy.providers.includes(provider.id)).map(provider => provider.id))];
  try {
    let connections = store.resolveConnections(ids);
    if (!connections.initialized && (input.allConnections || connections.missingProviderIds.length)) {
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
    try { result.pools[provider.id] = store.resolveGrantPool({ providerId: provider.id, policyId, tenantId: policy.policy.tenantId ?? "default", defaultKeys: [`oauth/${policyId}/${provider.tokenRef}`, `oauth/tenants/${policy.policy.tenantId ?? "default"}/${provider.tokenRef}`] }); }
    catch { result.pools[provider.id] = { keys: [], states: {}, hasAttachment: false, unavailable: true }; }
  }
  return result;
}

export async function genuineLegacyKey(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const value = await env.POLICY_KV.get<Record<string, unknown>>(`keys/${id}`, "json");
  return value && (value.generation == null || value.generation === "legacy") ? value : null;
}
