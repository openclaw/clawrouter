import type {
  AccessControlUser, AccessPolicyEntry, AccessUserRecord, Env, OAuthState, PolicyBinding,
  GrantRoutingPolicy, GrantRuntimeState, ProviderConnection, ProxyCredentialEntry,
} from "./types";
import { contentRetentionDefault } from "./content-retention.ts";
import { errorResponse, json, normalizeEmail, readJson } from "./utils.ts";

type Principal = { principalType: "user" | "group"; principalId: string };
type Seed = { principal: Principal; bindings: PolicyBinding[] };

export class PolicyBindingIndexObject implements DurableObject {
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.ensureSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("route_not_found", "route not found", 404);
    try {
      if (path === "/resolve") return json({ initialized: this.hasMeta("bindings_global_initialized"), ...this.resolveBindings((await readJson<{ principals: Principal[] }>(request)).principals) });
      if (path === "/initialize") { this.initializeBindings(await readJson<Seed[]>(request)); return new Response("initialized"); }
      if (path === "/initialize-all") { this.initializeAllBindings(await readJson<PolicyBinding[]>(request)); return new Response("initialized"); }
      if (path === "/mutate") { const body = await readJson<{ seed: Seed; binding: PolicyBinding }>(request); this.initializeBindings([body.seed]); this.putBinding(body.binding); return new Response("updated"); }
      if (path === "/list") return json({ initialized: this.hasMeta("bindings_global_initialized"), bindings: this.listBindings() });
      if (path === "/users/resolve") return json({ initialized: this.hasMeta("users_global_initialized"), ...this.resolveUsers((await readJson<{ emails: string[] }>(request)).emails) });
      if (path === "/users/initialize") { this.initializeUsers(await readJson<AccessControlUser[]>(request)); return new Response("initialized"); }
      if (path === "/users/initialize-all") { this.initializeUsers(await readJson<AccessControlUser[]>(request)); this.putMeta("users_global_initialized"); return new Response("initialized"); }
      if (path === "/users/put") { this.putUser(await readJson<AccessControlUser>(request)); return new Response("updated"); }
      if (path === "/users/put-bindings") return json(this.putUserBindings(await readJson<UserBindingsRequest>(request)));
      if (path === "/users/list") return json({ initialized: this.hasMeta("users_global_initialized"), users: this.listUsers() });
      if (path === "/policies/resolve") return json(this.resolvePolicies((await readJson<{ policyIds: string[] }>(request)).policyIds));
      if (path === "/policies/initialize") { this.initializePolicies(await readJson<AccessPolicyEntry[]>(request)); return new Response("initialized"); }
      if (path === "/policies/initialize-all") { this.initializePolicies(await readJson<AccessPolicyEntry[]>(request)); this.putMeta("policies_global_initialized"); return new Response("initialized"); }
      if (path === "/policies/put") { this.putPolicy(await readJson<AccessPolicyEntry>(request)); return new Response("updated"); }
      if (path === "/policies/put-with-credential") { const body = await readJson<{ policy: AccessPolicyEntry; credential: ProxyCredentialEntry }>(request); this.putPolicy(body.policy); this.putCredential(body.credential); return new Response("updated"); }
      if (path === "/policies/list") return json({ initialized: this.hasMeta("policies_global_initialized"), policies: this.listPolicies() });
      if (path === "/credentials/resolve") return json(this.resolveCredentials((await readJson<{ credentialIds: string[] }>(request)).credentialIds));
      if (path === "/credentials/initialize") { this.initializeCredentials(await readJson<ProxyCredentialEntry[]>(request)); return new Response("initialized"); }
      if (path === "/credentials/initialize-all") { this.initializeCredentials(await readJson<ProxyCredentialEntry[]>(request)); this.putMeta("credentials_global_initialized"); return new Response("initialized"); }
      if (path === "/credentials/put") { this.putCredential(await readJson<ProxyCredentialEntry>(request)); return new Response("updated"); }
      if (path === "/credentials/list") return json({ initialized: this.hasMeta("credentials_global_initialized"), credentials: this.listCredentials() });
      if (path === "/connections/resolve") return json(this.resolveConnections((await readJson<{ providerIds: string[] }>(request)).providerIds));
      if (path === "/connections/initialize") { this.initializeConnections(await readJson<ProviderConnection[]>(request)); return new Response("initialized"); }
      if (path === "/connections/initialize-all") { this.initializeConnections(await readJson<ProviderConnection[]>(request)); this.putMeta("connections_global_initialized"); return new Response("initialized"); }
      if (path === "/connections/put") { this.putConnection(await readJson<ProviderConnection>(request)); return new Response("updated"); }
      if (path === "/grant-pools/resolve") return json(this.resolveGrantPool(await readJson<GrantPoolResolveRequest>(request)));
      if (path === "/grant-pools/sync") { this.syncGrantPool(await readJson<GrantPoolSyncRequest>(request)); return new Response("updated"); }
      if (path === "/grant-pools/feedback") { this.putGrantRuntime(await readJson<GrantRuntimeFeedbackRequest>(request)); return new Response("updated"); }
      if (path === "/grant-pools/states") return json({ states: this.grantRuntimeStates((await readJson<GrantRuntimeStatesRequest>(request)).keys) });
      if (path === "/grant-pools/select") return json(this.selectGrant(await readJson<GrantPoolSelectRequest>(request)));
      if (path === "/grant-pools/stats") return json({ stats: this.grantSelectionStats((await readJson<GrantRuntimeStatesRequest>(request)).keys) });
      if (path === "/oauth-states/put") { this.putOAuthState(await readJson<OAuthState>(request)); return new Response("updated"); }
      if (path === "/oauth-states/consume") return json({ state: this.consumeOAuthState(await readJson<{ state: string; actorEmail: string }>(request)) });
      return errorResponse("route_not_found", "route not found", 404);
    } catch (error) {
      return errorResponse("authority_error", error instanceof Error ? error.message : String(error), 400);
    }
  }

  private ensureSchema(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS policy_binding_principals (principal_key TEXT PRIMARY KEY)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS policy_binding_entries (principal_key TEXT NOT NULL, binding_key TEXT NOT NULL, binding_json TEXT NOT NULL, PRIMARY KEY (principal_key, binding_key))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS policy_binding_meta (meta_key TEXT PRIMARY KEY)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS access_users (email TEXT PRIMARY KEY, user_json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS access_policies (policy_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS proxy_credentials (credential_id TEXT PRIMARY KEY, credential_json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS provider_connections (provider_id TEXT PRIMARY KEY, connection_json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_pool_members (scope TEXT NOT NULL, scope_id TEXT NOT NULL, provider_id TEXT NOT NULL, token_ref TEXT NOT NULL, PRIMARY KEY (scope, scope_id, provider_id, token_ref))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_runtime (grant_key TEXT PRIMARY KEY, state_json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_selection (pool_key TEXT NOT NULL, grant_key TEXT NOT NULL, selected_count INTEGER NOT NULL, last_selected_ms INTEGER NOT NULL, PRIMARY KEY (pool_key, grant_key))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_pool_cursors (pool_key TEXT PRIMARY KEY, grant_key TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS oauth_authorization_states (state TEXT PRIMARY KEY, state_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)");
  }

  private initializeBindings(seeds: Seed[]): void {
    for (const seed of seeds) {
      const principal = normalizePrincipal(seed.principal);
      const key = principalKey(principal);
      if (this.hasPrincipal(key)) continue;
      for (const binding of seed.bindings) if (binding.principalType === principal.principalType && binding.principalId === principal.principalId) this.putBinding(binding);
      this.sql.exec("INSERT OR IGNORE INTO policy_binding_principals (principal_key) VALUES (?)", key);
    }
  }

  private initializeAllBindings(bindings: PolicyBinding[]): void {
    const grouped = new Map<string, Seed>();
    for (const binding of bindings) {
      const principal = normalizePrincipal(binding);
      const key = principalKey(principal);
      const seed = grouped.get(key) ?? { principal, bindings: [] };
      seed.bindings.push(binding);
      grouped.set(key, seed);
    }
    this.initializeBindings([...grouped.values()]);
    this.putMeta("bindings_global_initialized");
  }

  private resolveBindings(principals: Principal[]): { bindings: PolicyBinding[]; missingPrincipals: Principal[] } {
    const bindings: PolicyBinding[] = [];
    const missingPrincipals: Principal[] = [];
    for (const raw of principals) {
      const principal = normalizePrincipal(raw);
      const key = principalKey(principal);
      if (!this.hasPrincipal(key)) { missingPrincipals.push(principal); continue; }
      bindings.push(...rows<{ binding_json: string }>(this.sql.exec("SELECT binding_json FROM policy_binding_entries WHERE principal_key = ?", key)).map((row) => JSON.parse(row.binding_json)));
    }
    return { bindings: sortBindings(bindings), missingPrincipals };
  }

  private putBinding(raw: PolicyBinding): void {
    const binding = normalizeBinding(raw);
    const key = principalKey(binding);
    this.sql.exec("INSERT OR REPLACE INTO policy_binding_entries (principal_key, binding_key, binding_json) VALUES (?, ?, ?)", key, bindingKey(binding), JSON.stringify(binding));
    this.sql.exec("INSERT OR IGNORE INTO policy_binding_principals (principal_key) VALUES (?)", key);
  }

  private listBindings(): PolicyBinding[] {
    return sortBindings(rows<{ binding_json: string }>(this.sql.exec("SELECT binding_json FROM policy_binding_entries")).map((row) => JSON.parse(row.binding_json)));
  }

  private hasPrincipal(key: string): boolean {
    return rows(this.sql.exec("SELECT principal_key FROM policy_binding_principals WHERE principal_key = ?", key)).length > 0;
  }

  private putMeta(key: string): void { this.sql.exec("INSERT OR IGNORE INTO policy_binding_meta (meta_key) VALUES (?)", key); }
  private hasMeta(key: string): boolean { return rows(this.sql.exec("SELECT meta_key FROM policy_binding_meta WHERE meta_key = ?", key)).length > 0; }

  private putUser(raw: AccessControlUser): void {
    const user = normalizeUser(raw);
    this.sql.exec("INSERT OR REPLACE INTO access_users (email, user_json) VALUES (?, ?)", user.email, JSON.stringify(user.record));
  }

  private initializeUsers(users: AccessControlUser[]): void {
    for (const user of users) if (!this.getUser(user.email)) this.putUser(user);
  }

  private getUser(email: string): AccessControlUser | null {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = rows<{ user_json: string }>(this.sql.exec("SELECT user_json FROM access_users WHERE email = ?", normalized))[0];
    return row ? { email: normalized, record: JSON.parse(row.user_json) } : null;
  }

  private resolveUsers(emails: string[]): { users: AccessControlUser[]; missingEmails: string[] } {
    const users: AccessControlUser[] = [], missingEmails: string[] = [];
    for (const email of [...new Set(emails.map((item) => normalizeEmail(item)).filter(Boolean) as string[])]) {
      const user = this.getUser(email);
      if (user) users.push(user); else missingEmails.push(email);
    }
    return { users, missingEmails };
  }

  private listUsers(): AccessControlUser[] {
    return rows<{ email: string; user_json: string }>(this.sql.exec("SELECT email, user_json FROM access_users ORDER BY email")).map((row) => ({ email: row.email, record: JSON.parse(row.user_json) }));
  }

  private putUserBindings(request: UserBindingsRequest): { bindings: PolicyBinding[] } {
    const user = normalizeUser(request.user);
    this.initializeBindings([request.seed]);
    this.putUser(user);
    const principal: Principal = { principalType: "user", principalId: user.email };
    const current = this.resolveBindings([principal]).bindings;
    const desired = new Set(request.policyIds);
    for (const binding of current) this.putBinding({ ...binding, enabled: desired.has(binding.policyId) });
    for (const policyId of desired) if (!current.some((binding) => binding.policyId === policyId)) this.putBinding({ policyId, ...principal, enabled: true, priority: 100 });
    return { bindings: this.resolveBindings([principal]).bindings };
  }

  private putPolicy(entry: AccessPolicyEntry): void {
    if (!entry.policyId) throw new Error("policyId is required");
    this.sql.exec("INSERT OR REPLACE INTO access_policies (policy_id, policy_json) VALUES (?, ?)", entry.policyId, JSON.stringify(entry.policy));
  }

  private initializePolicies(entries: AccessPolicyEntry[]): void { for (const entry of entries) if (!this.getPolicy(entry.policyId)) this.putPolicy(entry); }
  private getPolicy(id: string): AccessPolicyEntry | null {
    const row = rows<{ policy_json: string }>(this.sql.exec("SELECT policy_json FROM access_policies WHERE policy_id = ?", id))[0];
    return row ? { policyId: id, policy: JSON.parse(row.policy_json) } : null;
  }
  private resolvePolicies(ids: string[]): { initialized: boolean; policies: AccessPolicyEntry[]; missingPolicyIds: string[] } {
    const policies: AccessPolicyEntry[] = [], missingPolicyIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getPolicy(id); if (entry) policies.push(entry); else missingPolicyIds.push(id); }
    return { initialized: this.hasMeta("policies_global_initialized"), policies, missingPolicyIds };
  }
  private listPolicies(): AccessPolicyEntry[] {
    return rows<{ policy_id: string; policy_json: string }>(this.sql.exec("SELECT policy_id, policy_json FROM access_policies ORDER BY policy_id")).map((row) => ({ policyId: row.policy_id, policy: JSON.parse(row.policy_json) }));
  }

  private putCredential(entry: ProxyCredentialEntry): void {
    this.sql.exec("INSERT OR REPLACE INTO proxy_credentials (credential_id, credential_json) VALUES (?, ?)", entry.credentialId, JSON.stringify(entry.credential));
  }
  private initializeCredentials(entries: ProxyCredentialEntry[]): void { for (const entry of entries) if (!this.getCredential(entry.credentialId)) this.putCredential(entry); }
  private getCredential(id: string): ProxyCredentialEntry | null {
    const row = rows<{ credential_json: string }>(this.sql.exec("SELECT credential_json FROM proxy_credentials WHERE credential_id = ?", id))[0];
    return row ? { credentialId: id, credential: JSON.parse(row.credential_json) } : null;
  }
  private resolveCredentials(ids: string[]): { initialized: boolean; credentials: ProxyCredentialEntry[]; missingCredentialIds: string[] } {
    const credentials: ProxyCredentialEntry[] = [], missingCredentialIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getCredential(id); if (entry) credentials.push(entry); else missingCredentialIds.push(id); }
    return { initialized: this.hasMeta("credentials_global_initialized"), credentials, missingCredentialIds };
  }
  private listCredentials(): ProxyCredentialEntry[] {
    return rows<{ credential_id: string; credential_json: string }>(this.sql.exec("SELECT credential_id, credential_json FROM proxy_credentials ORDER BY credential_id")).map((row) => ({ credentialId: row.credential_id, credential: JSON.parse(row.credential_json) }));
  }

  private putConnection(connection: ProviderConnection): void {
    this.sql.exec("INSERT OR REPLACE INTO provider_connections (provider_id, connection_json) VALUES (?, ?)", connection.providerId, JSON.stringify(connection));
  }
  private initializeConnections(items: ProviderConnection[]): void { for (const item of items) if (!this.getConnection(item.providerId)) this.putConnection(item); }
  private getConnection(id: string): ProviderConnection | null {
    const row = rows<{ connection_json: string }>(this.sql.exec("SELECT connection_json FROM provider_connections WHERE provider_id = ?", id))[0];
    return row ? JSON.parse(row.connection_json) : null;
  }
  private resolveConnections(ids: string[]): { initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] } {
    const connections: ProviderConnection[] = [], missingProviderIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getConnection(id); if (entry) connections.push(entry); else missingProviderIds.push(id); }
    return { initialized: this.hasMeta("connections_global_initialized"), connections, missingProviderIds };
  }

  private resolveGrantPool(input: GrantPoolResolveRequest): { keys: string[]; states: Record<string, GrantRuntimeState> } {
    const providerId = grantSegment(input.providerId, "providerId");
    const policyId = grantPoolScopeId(input.policyId);
    const tenantId = grantPoolScopeId(input.tenantId);
    const keys = [...new Set([
      ...(input.defaultKeys ?? []).map((key) => grantKey(key)),
      ...(policyId ? this.poolTokenRefs("policies", policyId, providerId).map((tokenRef) => `oauth/${policyId}/${tokenRef}`) : []),
      ...(tenantId ? this.poolTokenRefs("tenants", tenantId, providerId).map((tokenRef) => `oauth/tenants/${tenantId}/${tokenRef}`) : []),
    ])];
    return { keys, states: this.grantRuntimeStates(keys) };
  }

  private syncGrantPool(input: GrantPoolSyncRequest): void {
    const scope = input.scope === "policies" || input.scope === "tenants" ? input.scope : null;
    if (!scope) throw new Error("grant pool scope is invalid");
    const scopeId = grantSegment(input.scopeId, "scopeId"), tokenRef = grantSegment(input.tokenRef, "tokenRef");
    const previousProvider = input.previousProvider == null ? null : grantSegment(input.previousProvider, "previousProvider");
    const provider = input.provider == null ? null : grantSegment(input.provider, "provider");
    const adding = input.enabled === true && provider !== null;
    if (adding && !this.hasPoolMember(scope, scopeId, provider, tokenRef) && this.poolTokenRefs(scope, scopeId, provider).length >= 32) throw new Error("grant pool cannot contain more than 32 members per scope and provider");
    if (previousProvider && (previousProvider !== provider || !adding)) this.sql.exec("DELETE FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? AND token_ref = ?", scope, scopeId, previousProvider, tokenRef);
    if (adding) this.sql.exec("INSERT OR IGNORE INTO upstream_grant_pool_members (scope, scope_id, provider_id, token_ref) VALUES (?, ?, ?, ?)", scope, scopeId, provider, tokenRef);
    if (!adding) this.sql.exec("DELETE FROM upstream_grant_runtime WHERE grant_key = ?", scope === "tenants" ? `oauth/tenants/${scopeId}/${tokenRef}` : `oauth/${scopeId}/${tokenRef}`);
  }

  private putGrantRuntime(input: GrantRuntimeFeedbackRequest): void {
    const key = grantKey(input.key), state = normalizeGrantRuntimeState(input.state);
    const current = rows<{ state_json: string }>(this.sql.exec("SELECT state_json FROM upstream_grant_runtime WHERE grant_key = ?", key))[0];
    if (current && Date.parse(normalizeGrantRuntimeState(JSON.parse(current.state_json)).observedAt) > Date.parse(state.observedAt)) return;
    this.sql.exec("INSERT OR REPLACE INTO upstream_grant_runtime (grant_key, state_json) VALUES (?, ?)", key, JSON.stringify(state));
  }

  private grantRuntimeStates(rawKeys: unknown): Record<string, GrantRuntimeState> {
    if (!Array.isArray(rawKeys) || rawKeys.length > 66) throw new Error("grant runtime keys must be a bounded array");
    const states: Record<string, GrantRuntimeState> = {};
    for (const key of [...new Set(rawKeys.map((value) => grantKey(value)))]) {
      const row = rows<{ state_json: string }>(this.sql.exec("SELECT state_json FROM upstream_grant_runtime WHERE grant_key = ?", key))[0];
      if (row) states[key] = normalizeGrantRuntimeState(JSON.parse(row.state_json));
    }
    return states;
  }

  private selectGrant(input: GrantPoolSelectRequest): { selectedKey: string; selectedCount: number; lastSelectedAt: string } {
    const poolKey = grantSelectionPoolKey(input.poolKey);
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 66) throw new Error("grant selection candidates must be a bounded array");
    const candidates = [...new Map(input.candidates.map((candidate) => {
      const key = grantKey(candidate.key);
      const weight = typeof candidate.weight === "number" && Number.isFinite(candidate.weight) && candidate.weight > 0 && candidate.weight <= 1_000_000 ? candidate.weight : 1;
      const remainingRatio = typeof candidate.remainingRatio === "number" && Number.isFinite(candidate.remainingRatio) && candidate.remainingRatio >= 0 && candidate.remainingRatio <= 1 ? candidate.remainingRatio : null;
      return [key, { key, weight, remainingRatio }];
    })).values()].sort((a, b) => a.key.localeCompare(b.key));
    const strategy = ["priority", "round_robin", "least_used", "most_remaining", "weighted_random"].includes(input.strategy) ? input.strategy : "most_remaining";
    const stickyHash = typeof input.stickyHash === "string" && /^[0-9a-f]{64}$/.test(input.stickyHash) ? input.stickyHash : null;
    let selected = candidates[0];
    if (stickyHash) selected = [...candidates].sort((a, b) => stickyScore(stickyHash, a) - stickyScore(stickyHash, b) || a.key.localeCompare(b.key))[0];
    else if (strategy === "round_robin") {
      const current = rows<{ grant_key: string }>(this.sql.exec("SELECT grant_key FROM upstream_grant_pool_cursors WHERE pool_key = ?", poolKey))[0]?.grant_key;
      selected = candidates.find((candidate) => candidate.key > (current ?? "")) ?? candidates[0];
      this.sql.exec("INSERT OR REPLACE INTO upstream_grant_pool_cursors (pool_key, grant_key) VALUES (?, ?)", poolKey, selected.key);
    } else if (strategy === "least_used") {
      const counts = new Map(rows<{ grant_key: string; selected_count: number; last_selected_ms: number }>(this.sql.exec("SELECT grant_key, selected_count, last_selected_ms FROM upstream_grant_selection WHERE pool_key = ?", poolKey)).map((row) => [row.grant_key, row]));
      selected = [...candidates].sort((a, b) => (counts.get(a.key)?.selected_count ?? 0) - (counts.get(b.key)?.selected_count ?? 0) || (counts.get(a.key)?.last_selected_ms ?? 0) - (counts.get(b.key)?.last_selected_ms ?? 0) || a.key.localeCompare(b.key))[0];
    } else if (strategy === "most_remaining") selected = [...candidates].sort((a, b) => (b.remainingRatio ?? -1) - (a.remainingRatio ?? -1) || a.key.localeCompare(b.key))[0];
    else if (strategy === "weighted_random") selected = weightedRandom(candidates);
    const nowMs = Date.now();
    this.sql.exec("INSERT INTO upstream_grant_selection (pool_key, grant_key, selected_count, last_selected_ms) VALUES (?, ?, 1, ?) ON CONFLICT (pool_key, grant_key) DO UPDATE SET selected_count = selected_count + 1, last_selected_ms = excluded.last_selected_ms", poolKey, selected.key, nowMs);
    const row = rows<{ selected_count: number }>(this.sql.exec("SELECT selected_count FROM upstream_grant_selection WHERE pool_key = ? AND grant_key = ?", poolKey, selected.key))[0];
    return { selectedKey: selected.key, selectedCount: row?.selected_count ?? 1, lastSelectedAt: new Date(nowMs).toISOString() };
  }

  private grantSelectionStats(rawKeys: unknown): Record<string, { selectedCount: number; lastSelectedAt: string | null }> {
    if (!Array.isArray(rawKeys) || rawKeys.length > 66) throw new Error("grant selection keys must be a bounded array");
    const stats: Record<string, { selectedCount: number; lastSelectedAt: string | null }> = {};
    for (const key of [...new Set(rawKeys.map((value) => grantKey(value)))]) {
      const row = rows<{ selected_count: number; last_selected_ms: number | null }>(this.sql.exec("SELECT COALESCE(SUM(selected_count), 0) AS selected_count, MAX(last_selected_ms) AS last_selected_ms FROM upstream_grant_selection WHERE grant_key = ?", key))[0];
      stats[key] = { selectedCount: row?.selected_count ?? 0, lastSelectedAt: row?.last_selected_ms ? new Date(row.last_selected_ms).toISOString() : null };
    }
    return stats;
  }

  private poolTokenRefs(scope: "policies" | "tenants", scopeId: string, providerId: string): string[] {
    return rows<{ token_ref: string }>(this.sql.exec("SELECT token_ref FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? ORDER BY token_ref LIMIT 33", scope, scopeId, providerId)).map((row) => row.token_ref);
  }

  private hasPoolMember(scope: "policies" | "tenants", scopeId: string, providerId: string, tokenRef: string): boolean {
    return rows(this.sql.exec("SELECT token_ref FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? AND token_ref = ?", scope, scopeId, providerId, tokenRef)).length > 0;
  }

  private putOAuthState(value: OAuthState): void {
    this.sql.exec("INSERT OR REPLACE INTO oauth_authorization_states (state, state_json, expires_at_ms) VALUES (?, ?, ?)", value.state, JSON.stringify(value), value.expiresAtMs);
  }
  private consumeOAuthState(input: { state: string; actorEmail: string }): OAuthState | null {
    const row = rows<{ state_json: string; expires_at_ms: number }>(this.sql.exec("SELECT state_json, expires_at_ms FROM oauth_authorization_states WHERE state = ?", input.state))[0];
    this.sql.exec("DELETE FROM oauth_authorization_states WHERE state = ?", input.state);
    if (!row || row.expires_at_ms < Date.now()) return null;
    const value = JSON.parse(row.state_json) as OAuthState;
    return value.actorEmail === input.actorEmail ? value : null;
  }
}

interface UserBindingsRequest { user: AccessControlUser; policyIds: string[]; seed: Seed }
interface GrantPoolResolveRequest { policyId: string; tenantId: string; providerId: string; defaultKeys?: string[] }
interface GrantPoolSyncRequest { scope: "policies" | "tenants"; scopeId: string; tokenRef: string; previousProvider: string | null; provider: string | null; enabled: boolean }
interface GrantRuntimeFeedbackRequest { key: string; state: GrantRuntimeState }
interface GrantRuntimeStatesRequest { keys: string[] }
interface GrantPoolSelectRequest {
  poolKey: string;
  strategy: string;
  stickyHash?: string | null;
  candidates: Array<{ key: string; weight?: number; remainingRatio?: number | null }>;
}

function grantSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || value.includes("/") || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} must be a valid grant key segment`);
  return value;
}

function grantPoolScopeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function grantKey(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("oauth/") || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("grant key is invalid");
  return value;
}

function grantSelectionPoolKey(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("grant selection pool key is invalid");
  return value;
}

function stickyScore(hash: string, candidate: { key: string; weight: number }): number {
  let value = 2166136261;
  for (const character of `${hash}:${candidate.key}`) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  const unit = (value + 1) / 0x1_0000_0000;
  return -Math.log(unit) / candidate.weight;
}

function weightedRandom<T extends { weight: number }>(candidates: T[]): T {
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000 * total;
  let cursor = 0;
  for (const candidate of candidates) { cursor += candidate.weight; if (random < cursor) return candidate; }
  return candidates.at(-1)!;
}

function normalizeGrantRuntimeState(value: unknown): GrantRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("grant runtime state is invalid");
  const state = value as Partial<GrantRuntimeState>;
  if (!state.observedAt || !Number.isFinite(Date.parse(state.observedAt)) || !["provider_response", "provider_probe"].includes(state.source ?? "")) throw new Error("grant runtime observation is invalid");
  if (!state.status || !["available", "limited", "cooldown"].includes(state.status)) throw new Error("grant runtime status is invalid");
  if (!state.lastSignal || !["quota", "rate_limited", "authentication"].includes(state.lastSignal)) throw new Error("grant runtime signal is invalid");
  const grantRevision = state.grantRevision == null ? null : typeof state.grantRevision === "string" && state.grantRevision.length <= 64 && Number.isFinite(Date.parse(state.grantRevision)) ? state.grantRevision : null;
  const cooldownUntil = state.cooldownUntil == null ? null : Number.isFinite(Date.parse(state.cooldownUntil)) ? state.cooldownUntil : null;
  if (!Array.isArray(state.windows) || state.windows.length > 12) throw new Error("grant runtime windows are invalid");
  const windows = state.windows.map((window) => {
    if (!window || !["requests", "tokens", "input_tokens", "output_tokens", "credits", "subscription", "generic"].includes(window.kind)) throw new Error("grant runtime window is invalid");
    const id = typeof window.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(window.id) ? window.id : window.kind;
    const unit = window.unit == null ? null : typeof window.unit === "string" && window.unit.length <= 32 ? window.unit : null;
    const quotaWindow = window.window == null ? null : typeof window.window === "string" && window.window.length <= 64 ? window.window : null;
    const metric = (input: unknown) => input == null ? null : typeof input === "number" && Number.isFinite(input) && input >= 0 && input <= Number.MAX_SAFE_INTEGER ? input : NaN;
    const remaining = metric(window.remaining), limit = metric(window.limit);
    if (Number.isNaN(remaining) || Number.isNaN(limit)) throw new Error("grant runtime window metric is invalid");
    const resetAt = window.resetAt == null ? null : Number.isFinite(Date.parse(window.resetAt)) ? window.resetAt : null;
    return { id, kind: window.kind, unit, window: quotaWindow, remaining, limit, resetAt };
  });
  return { status: state.status, observedAt: state.observedAt, source: state.source!, cooldownUntil, lastSignal: state.lastSignal, grantRevision, windows };
}

export async function authorityCall<T>(env: Env, path: string, body: unknown, objectName = "policy-bindings"): Promise<T> {
  const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(objectName));
  const response = await stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`authority ${path} failed (${response.status}): ${text}`);
  return text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as T : text as T;
}

export async function listPolicies(env: Env): Promise<AccessPolicyEntry[]> {
  const result = await authorityCall<{ initialized: boolean; policies: AccessPolicyEntry[] }>(env, "/policies/list", {});
  const authoritative = result.policies;
  if (result.initialized) return authoritative;
  const byId = new Map(authoritative.map((entry) => [entry.policyId, entry]));
  for (const [key, value] of await listKvJson<Record<string, unknown>>(env, "policies/")) {
    const policyId = key.slice("policies/".length);
    if (!byId.has(policyId)) byId.set(policyId, { policyId, policy: normalizePolicyRecord(value, contentRetentionDefault(env)) });
  }
  for (const [policyId, value] of await listGenuineLegacyKeys(env)) {
    if (!byId.has(policyId)) byId.set(policyId, { policyId, policy: normalizePolicyRecord(value, contentRetentionDefault(env)) });
  }
  await authorityCall(env, "/policies/initialize-all", [...byId.values()]);
  return [...byId.values()].sort((a, b) => a.policyId.localeCompare(b.policyId));
}
export async function listCredentials(env: Env): Promise<ProxyCredentialEntry[]> {
  const result = await authorityCall<{ initialized: boolean; credentials: ProxyCredentialEntry[] }>(env, "/credentials/list", {});
  const authoritative = result.credentials;
  if (result.initialized) return authoritative;
  const byId = new Map(authoritative.map((entry) => [entry.credentialId, entry]));
  for (const [key, value] of await listKvJson<Record<string, unknown>>(env, "credentials/")) {
    const credentialId = key.slice("credentials/".length);
    if (!byId.has(credentialId)) byId.set(credentialId, { credentialId, credential: normalizeCredentialRecord(value) });
  }
  for (const [credentialId, value] of await listGenuineLegacyKeys(env)) {
    if (!byId.has(credentialId)) byId.set(credentialId, { credentialId, credential: normalizeCredentialRecord(value, credentialId) });
  }
  await authorityCall(env, "/credentials/initialize-all", [...byId.values()]);
  return [...byId.values()].sort((a, b) => a.credentialId.localeCompare(b.credentialId));
}
export async function listUsers(env: Env): Promise<AccessControlUser[]> {
  const result = await authorityCall<{ initialized: boolean; users: AccessControlUser[] }>(env, "/users/list", {});
  if (result.initialized) return result.users;
  const users = (await listKvJson<AccessUserRecord>(env, "access/users/")).map(([key, record]) => ({ email: key.slice("access/users/".length), record }));
  await authorityCall(env, "/users/initialize-all", users);
  return (await authorityCall<{ users: AccessControlUser[] }>(env, "/users/list", {})).users;
}
export async function listBindings(env: Env): Promise<PolicyBinding[]> {
  const result = await authorityCall<{ initialized: boolean; bindings: PolicyBinding[] }>(env, "/list", {});
  if (result.initialized) return result.bindings;
  const bindings = (await listKvJson<PolicyBinding>(env, "access/bindings/")).map(([, binding]) => binding);
  await authorityCall(env, "/initialize-all", bindings);
  return (await authorityCall<{ bindings: PolicyBinding[] }>(env, "/list", {})).bindings;
}
export async function resolvePolicies(env: Env, ids: string[]): Promise<AccessPolicyEntry[]> {
  const result = await authorityCall<{ initialized: boolean; policies: AccessPolicyEntry[]; missingPolicyIds: string[] }>(env, "/policies/resolve", { policyIds: ids });
  if (result.initialized) return result.policies;
  const seeded: AccessPolicyEntry[] = [];
  for (const policyId of result.missingPolicyIds) {
    const value = await env.POLICY_KV.get<Record<string, unknown>>(`policies/${policyId}`, "json") ?? await genuineLegacyKey(env, policyId);
    if (value) seeded.push({ policyId, policy: normalizePolicyRecord(value, contentRetentionDefault(env)) });
  }
  if (seeded.length) await authorityCall(env, "/policies/initialize", seeded);
  return [...result.policies, ...seeded];
}
export async function resolveCredentials(env: Env, ids: string[]): Promise<ProxyCredentialEntry[]> {
  const result = await authorityCall<{ initialized: boolean; credentials: ProxyCredentialEntry[]; missingCredentialIds: string[] }>(env, "/credentials/resolve", { credentialIds: ids });
  if (result.initialized) return result.credentials;
  const seeded: ProxyCredentialEntry[] = [];
  for (const credentialId of result.missingCredentialIds) {
    const value = await env.POLICY_KV.get<Record<string, unknown>>(`credentials/${credentialId}`, "json") ?? await genuineLegacyKey(env, credentialId);
    if (value) seeded.push({ credentialId, credential: normalizeCredentialRecord(value, credentialId) });
  }
  if (seeded.length) await authorityCall(env, "/credentials/initialize", seeded);
  return [...result.credentials, ...seeded];
}
export async function resolveUsers(env: Env, emails: string[]): Promise<AccessControlUser[]> {
  const result = await authorityCall<{ initialized: boolean; users: AccessControlUser[]; missingEmails: string[] }>(env, "/users/resolve", { emails });
  if (result.initialized) return result.users;
  const seeded: AccessControlUser[] = [];
  for (const email of result.missingEmails) {
    const record = await env.POLICY_KV.get<AccessUserRecord>(`access/users/${email}`, "json");
    if (record) seeded.push({ email, record });
  }
  if (seeded.length) await authorityCall(env, "/users/initialize", seeded);
  return [...result.users, ...seeded];
}
export async function resolveBindings(env: Env, principals: Principal[]): Promise<PolicyBinding[]> {
  const result = await authorityCall<{ initialized: boolean; bindings: PolicyBinding[]; missingPrincipals: Principal[] }>(env, "/resolve", { principals });
  if (result.initialized || !result.missingPrincipals.length) return result.bindings;
  const seeds: Seed[] = [];
  for (const principal of result.missingPrincipals) {
    const prefix = `access/bindings/${principal.principalType}/${encodeURIComponent(principal.principalId)}/`;
    seeds.push({ principal, bindings: (await listKvJson<PolicyBinding>(env, prefix)).map(([, binding]) => binding) });
  }
  await authorityCall(env, "/initialize", seeds);
  return sortBindings([...result.bindings, ...seeds.flatMap((seed) => seed.bindings)]);
}
export async function resolveConnections(env: Env, providerIds: string[]): Promise<ProviderConnection[]> {
  const ids = [...new Set(providerIds)];
  const result = await authorityCall<{ initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] }>(env, "/connections/resolve", { providerIds: ids });
  if (result.initialized) return result.connections;
  const seeded = (await Promise.all(result.missingProviderIds.map((id) => env.POLICY_KV.get<ProviderConnection>(`connections/${id}`, "json")))).filter(Boolean) as ProviderConnection[];
  if (seeded.length) await authorityCall(env, "/connections/initialize", seeded);
  return [...result.connections, ...seeded];
}

export async function listConnections(env: Env, providerIds: string[]): Promise<ProviderConnection[]> {
  const ids = [...new Set(providerIds)];
  const result = await authorityCall<{ initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] }>(env, "/connections/resolve", { providerIds: ids });
  if (result.initialized) return result.connections;
  const seeded = (await Promise.all(result.missingProviderIds.map((id) => env.POLICY_KV.get<ProviderConnection>(`connections/${id}`, "json")))).filter(Boolean) as ProviderConnection[];
  const connections = [...result.connections, ...seeded];
  await authorityCall(env, "/connections/initialize-all", connections);
  return connections;
}

export async function resolveConnection(env: Env, providerId: string): Promise<ProviderConnection | null> {
  return (await resolveConnections(env, [providerId]))[0] ?? null;
}

async function listKvJson<T>(env: Env, prefix: string): Promise<Array<[string, T]>> {
  const values: Array<[string, T]> = [];
  let cursor: string | undefined;
  do {
    const page = await env.POLICY_KV.list({ prefix, cursor });
    for (const key of page.keys) { const value = await env.POLICY_KV.get<T>(key.name, "json"); if (value) values.push([key.name, value]); }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return values;
}

async function genuineLegacyKey(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const value = await env.POLICY_KV.get<Record<string, unknown>>(`keys/${id}`, "json");
  return value && (value.generation == null || value.generation === "legacy") ? value : null;
}

async function listGenuineLegacyKeys(env: Env): Promise<Array<[string, Record<string, unknown>]>> {
  return (await listKvJson<Record<string, unknown>>(env, "keys/")).flatMap(([key, value]) => {
    const id = key.slice("keys/".length);
    return id && !id.includes("/") && (value.generation == null || value.generation === "legacy") ? [[id, value]] : [];
  });
}

function normalizePolicyRecord(
  value: Record<string, unknown>,
  retainRequestContentDefault: boolean,
): AccessPolicyEntry["policy"] {
  return {
    enabled: value.enabled !== false,
    generation: typeof value.generation === "string" ? value.generation : "legacy",
    providers: Array.isArray(value.providers) ? value.providers.filter((item): item is string => typeof item === "string") : [],
    tenantId: typeof value.tenantId === "string" ? value.tenantId : null,
    tokenRole: typeof value.tokenRole === "string" ? value.tokenRole : null,
    monthlyBudgetMicros: typeof value.monthlyBudgetMicros === "number" ? value.monthlyBudgetMicros : null,
    requestCostMicros: typeof value.requestCostMicros === "number" ? value.requestCostMicros : null,
    retainRequestContent:
      typeof value.retainRequestContent === "boolean"
        ? value.retainRequestContent
        : retainRequestContentDefault,
    grantRouting: normalizeStoredGrantRouting(value.grantRouting),
  };
}

function normalizeStoredGrantRouting(value: unknown): GrantRoutingPolicy {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const strategy = typeof record.strategy === "string" && ["priority", "round_robin", "least_used", "most_remaining", "weighted_random"].includes(record.strategy)
    ? record.strategy as GrantRoutingPolicy["strategy"]
    : "most_remaining";
  const stickiness = typeof record.stickiness === "string" && ["none", "identity", "session"].includes(record.stickiness)
    ? record.stickiness as GrantRoutingPolicy["stickiness"]
    : "none";
  const staleAfterSeconds = Number.isSafeInteger(record.staleAfterSeconds) && (record.staleAfterSeconds as number) >= 30 && (record.staleAfterSeconds as number) <= 86_400
    ? record.staleAfterSeconds as number
    : 300;
  const eligibleGrants: Record<string, string[]> = {};
  if (record.eligibleGrants && typeof record.eligibleGrants === "object" && !Array.isArray(record.eligibleGrants)) {
    for (const [providerId, refs] of Object.entries(record.eligibleGrants as Record<string, unknown>)) {
      if (!validStoredGrantSegment(providerId) || !Array.isArray(refs)) continue;
      eligibleGrants[providerId] = [...new Set(refs.filter((ref): ref is string => typeof ref === "string" && validStoredGrantSegment(ref)))].slice(0, 32).sort();
    }
  }
  return {
    strategy,
    stickiness,
    failover: record.failover !== false,
    staleState: record.staleState === "deny" ? "deny" : "allow",
    staleAfterSeconds,
    eligibleGrants,
  };
}

function validStoredGrantSegment(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeCredentialRecord(value: Record<string, unknown>, legacyPolicyId?: string): ProxyCredentialEntry["credential"] {
  return {
    enabled: value.enabled !== false,
    secretSha256: typeof value.secretSha256 === "string" ? value.secretSha256.toLowerCase() : "",
    policyId: typeof value.policyId === "string" ? value.policyId : legacyPolicyId ?? "",
    policyGeneration: typeof value.policyGeneration === "string" ? value.policyGeneration : typeof value.generation === "string" ? value.generation : "legacy",
    principalId: typeof value.principalId === "string" ? value.principalId : null,
  };
}

function rows<T>(cursor: Iterable<T>): T[] { return [...cursor]; }
function principalKey(value: Principal): string { return `${value.principalType}:${value.principalId}`; }
function bindingKey(value: PolicyBinding): string { return `${value.principalType}:${value.principalId}:${value.policyId}`; }
function normalizePrincipal(value: Principal): Principal {
  const principalType = value.principalType;
  let principalId = value.principalId.trim().toLowerCase();
  if (principalType === "user") principalId = normalizeEmail(principalId) ?? "";
  if (!principalId || !["user", "group"].includes(principalType)) throw new Error("invalid policy binding principal");
  return { principalType, principalId };
}
function normalizeBinding(value: PolicyBinding): PolicyBinding {
  const principal = normalizePrincipal(value);
  if (!value.policyId?.trim()) throw new Error("policyId is required");
  return { ...principal, policyId: value.policyId.trim(), enabled: value.enabled ?? true, priority: value.priority ?? 100 };
}
function normalizeUser(value: AccessControlUser): AccessControlUser {
  const email = normalizeEmail(value.email);
  if (!email) throw new Error("invalid access user email");
  return { email, record: { role: value.record.role ?? "user", tenantId: value.record.tenantId ?? "default", enabled: value.record.enabled ?? true, groups: [...new Set(value.record.groups ?? [])].map((item) => item.trim().toLowerCase()).filter(Boolean).sort(), contentRetentionDisabled: value.record.contentRetentionDisabled ?? false, assignmentState: value.record.assignmentState } };
}
function sortBindings(values: PolicyBinding[]): PolicyBinding[] {
  return values.map(normalizeBinding).sort((a, b) => a.priority - b.priority || a.principalType.localeCompare(b.principalType) || a.principalId.localeCompare(b.principalId) || a.policyId.localeCompare(b.policyId));
}
