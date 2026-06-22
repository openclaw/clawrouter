import type {
  AccessControlUser, AccessPolicyEntry, AccessUserRecord, Env, OAuthState, PolicyBinding,
  ProviderConnection, ProxyCredentialEntry,
} from "./types";
import { errorResponse, json, normalizeEmail, readJson } from "./utils";

type Principal = { principalType: "user" | "group"; principalId: string };
type Seed = { principal: Principal; bindings: PolicyBinding[] };

export class PolicyBindingIndexObject implements DurableObject {
  private sql: SqlStorage;

  constructor(private state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.ensureSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("route_not_found", "route not found", 404);
    try {
      if (path === "/resolve") return json(this.resolveBindings((await readJson<{ principals: Principal[] }>(request)).principals));
      if (path === "/initialize") { this.initializeBindings(await readJson<Seed[]>(request)); return new Response("initialized"); }
      if (path === "/initialize-all") { this.initializeAllBindings(await readJson<PolicyBinding[]>(request)); return new Response("initialized"); }
      if (path === "/mutate") { const body = await readJson<{ seed: Seed; binding: PolicyBinding }>(request); this.initializeBindings([body.seed]); this.putBinding(body.binding); return new Response("updated"); }
      if (path === "/list") return json({ initialized: this.hasMeta("bindings_global_initialized"), bindings: this.listBindings() });
      if (path === "/users/resolve") return json(this.resolveUsers((await readJson<{ emails: string[] }>(request)).emails));
      if (path === "/users/initialize") { this.initializeUsers(await readJson<AccessControlUser[]>(request)); return new Response("initialized"); }
      if (path === "/users/initialize-all") { this.initializeUsers(await readJson<AccessControlUser[]>(request)); this.putMeta("users_global_initialized"); return new Response("initialized"); }
      if (path === "/users/put") { this.putUser(await readJson<AccessControlUser>(request)); return new Response("updated"); }
      if (path === "/users/put-bindings") return json(this.putUserBindings(await readJson<UserBindingsRequest>(request)));
      if (path === "/users/list") return json({ initialized: this.hasMeta("users_global_initialized"), users: this.listUsers() });
      if (path === "/policies/resolve") return json(this.resolvePolicies((await readJson<{ policyIds: string[] }>(request)).policyIds));
      if (path === "/policies/initialize") { this.initializePolicies(await readJson<AccessPolicyEntry[]>(request)); return new Response("initialized"); }
      if (path === "/policies/put") { this.putPolicy(await readJson<AccessPolicyEntry>(request)); return new Response("updated"); }
      if (path === "/policies/put-with-credential") { const body = await readJson<{ policy: AccessPolicyEntry; credential: ProxyCredentialEntry }>(request); this.putPolicy(body.policy); this.putCredential(body.credential); return new Response("updated"); }
      if (path === "/policies/list") return json({ policies: this.listPolicies() });
      if (path === "/credentials/resolve") return json(this.resolveCredentials((await readJson<{ credentialIds: string[] }>(request)).credentialIds));
      if (path === "/credentials/initialize") { this.initializeCredentials(await readJson<ProxyCredentialEntry[]>(request)); return new Response("initialized"); }
      if (path === "/credentials/put") { this.putCredential(await readJson<ProxyCredentialEntry>(request)); return new Response("updated"); }
      if (path === "/credentials/list") return json({ credentials: this.listCredentials() });
      if (path === "/connections/resolve") return json(this.resolveConnections((await readJson<{ providerIds: string[] }>(request)).providerIds));
      if (path === "/connections/initialize") { this.initializeConnections(await readJson<ProviderConnection[]>(request)); return new Response("initialized"); }
      if (path === "/connections/put") { this.putConnection(await readJson<ProviderConnection>(request)); return new Response("updated"); }
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
  private resolvePolicies(ids: string[]): { policies: AccessPolicyEntry[]; missingPolicyIds: string[] } {
    const policies: AccessPolicyEntry[] = [], missingPolicyIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getPolicy(id); if (entry) policies.push(entry); else missingPolicyIds.push(id); }
    return { policies, missingPolicyIds };
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
  private resolveCredentials(ids: string[]): { credentials: ProxyCredentialEntry[]; missingCredentialIds: string[] } {
    const credentials: ProxyCredentialEntry[] = [], missingCredentialIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getCredential(id); if (entry) credentials.push(entry); else missingCredentialIds.push(id); }
    return { credentials, missingCredentialIds };
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
  private resolveConnections(ids: string[]): { connections: ProviderConnection[]; missingProviderIds: string[] } {
    const connections: ProviderConnection[] = [], missingProviderIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getConnection(id); if (entry) connections.push(entry); else missingProviderIds.push(id); }
    return { connections, missingProviderIds };
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

export async function authorityCall<T>(env: Env, path: string, body: unknown, objectName = "policy-bindings"): Promise<T> {
  const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(objectName));
  const response = await stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`authority ${path} failed (${response.status}): ${text}`);
  return text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as T : text as T;
}

export async function listPolicies(env: Env): Promise<AccessPolicyEntry[]> {
  const authoritative = (await authorityCall<{ policies: AccessPolicyEntry[] }>(env, "/policies/list", {})).policies;
  const byId = new Map(authoritative.map((entry) => [entry.policyId, entry]));
  for (const [key, value] of await listKvJson<Record<string, unknown>>(env, "policies/")) {
    const policyId = key.slice("policies/".length);
    if (!byId.has(policyId)) byId.set(policyId, { policyId, policy: normalizePolicyRecord(value) });
  }
  const missing = [...byId.values()].filter((entry) => !authoritative.some((current) => current.policyId === entry.policyId));
  if (missing.length) await authorityCall(env, "/policies/initialize", missing);
  return [...byId.values()].sort((a, b) => a.policyId.localeCompare(b.policyId));
}
export async function listCredentials(env: Env): Promise<ProxyCredentialEntry[]> {
  const authoritative = (await authorityCall<{ credentials: ProxyCredentialEntry[] }>(env, "/credentials/list", {})).credentials;
  const byId = new Map(authoritative.map((entry) => [entry.credentialId, entry]));
  for (const [key, value] of await listKvJson<Record<string, unknown>>(env, "credentials/")) {
    const credentialId = key.slice("credentials/".length);
    if (!byId.has(credentialId)) byId.set(credentialId, { credentialId, credential: normalizeCredentialRecord(value) });
  }
  const missing = [...byId.values()].filter((entry) => !authoritative.some((current) => current.credentialId === entry.credentialId));
  if (missing.length) await authorityCall(env, "/credentials/initialize", missing);
  return [...byId.values()].sort((a, b) => a.credentialId.localeCompare(b.credentialId));
}
export async function listUsers(env: Env): Promise<AccessControlUser[]> {
  const result = await authorityCall<{ initialized: boolean; users: AccessControlUser[] }>(env, "/users/list", {});
  if (result.initialized) return result.users;
  const users = (await listKvJson<AccessUserRecord>(env, "access/users/")).map(([key, record]) => ({ email: key.slice("access/users/".length), record }));
  if (users.length) await authorityCall(env, "/users/initialize-all", users);
  return users.length ? users : result.users;
}
export async function listBindings(env: Env): Promise<PolicyBinding[]> {
  const result = await authorityCall<{ initialized: boolean; bindings: PolicyBinding[] }>(env, "/list", {});
  if (result.initialized) return result.bindings;
  const bindings = (await listKvJson<PolicyBinding>(env, "access/bindings/")).map(([, binding]) => binding);
  if (bindings.length) await authorityCall(env, "/initialize-all", bindings);
  return bindings.length ? sortBindings(bindings) : result.bindings;
}
export async function resolvePolicies(env: Env, ids: string[]): Promise<AccessPolicyEntry[]> {
  const result = await authorityCall<{ policies: AccessPolicyEntry[]; missingPolicyIds: string[] }>(env, "/policies/resolve", { policyIds: ids });
  const seeded: AccessPolicyEntry[] = [];
  for (const policyId of result.missingPolicyIds) {
    const value = await env.POLICY_KV.get<Record<string, unknown>>(`policies/${policyId}`, "json") ?? await genuineLegacyKey(env, policyId);
    if (value) seeded.push({ policyId, policy: normalizePolicyRecord(value) });
  }
  if (seeded.length) await authorityCall(env, "/policies/initialize", seeded);
  return [...result.policies, ...seeded];
}
export async function resolveCredentials(env: Env, ids: string[]): Promise<ProxyCredentialEntry[]> {
  const result = await authorityCall<{ credentials: ProxyCredentialEntry[]; missingCredentialIds: string[] }>(env, "/credentials/resolve", { credentialIds: ids });
  const seeded: ProxyCredentialEntry[] = [];
  for (const credentialId of result.missingCredentialIds) {
    const value = await env.POLICY_KV.get<Record<string, unknown>>(`credentials/${credentialId}`, "json") ?? await genuineLegacyKey(env, credentialId);
    if (value) seeded.push({ credentialId, credential: normalizeCredentialRecord(value, credentialId) });
  }
  if (seeded.length) await authorityCall(env, "/credentials/initialize", seeded);
  return [...result.credentials, ...seeded];
}
export async function resolveUsers(env: Env, emails: string[]): Promise<AccessControlUser[]> {
  const result = await authorityCall<{ users: AccessControlUser[]; missingEmails: string[] }>(env, "/users/resolve", { emails });
  const seeded: AccessControlUser[] = [];
  for (const email of result.missingEmails) {
    const record = await env.POLICY_KV.get<AccessUserRecord>(`access/users/${email}`, "json");
    if (record) seeded.push({ email, record });
  }
  if (seeded.length) await authorityCall(env, "/users/initialize", seeded);
  return [...result.users, ...seeded];
}
export async function resolveBindings(env: Env, principals: Principal[]): Promise<PolicyBinding[]> {
  const result = await authorityCall<{ bindings: PolicyBinding[]; missingPrincipals: Principal[] }>(env, "/resolve", { principals });
  if (!result.missingPrincipals.length) return result.bindings;
  const seeds: Seed[] = [];
  for (const principal of result.missingPrincipals) {
    const prefix = `access/bindings/${principal.principalType}/${encodeURIComponent(principal.principalId)}/`;
    seeds.push({ principal, bindings: (await listKvJson<PolicyBinding>(env, prefix)).map(([, binding]) => binding) });
  }
  await authorityCall(env, "/initialize", seeds);
  return sortBindings([...result.bindings, ...seeds.flatMap((seed) => seed.bindings)]);
}
export async function resolveConnection(env: Env, providerId: string): Promise<ProviderConnection | null> {
  const result = await authorityCall<{ connections: ProviderConnection[] }>(env, "/connections/resolve", { providerIds: [providerId] }, `provider-connection:${encodeURIComponent(providerId)}`);
  if (result.connections[0]) return result.connections[0];
  const connection = await env.POLICY_KV.get<ProviderConnection>(`connections/${providerId}`, "json");
  if (connection) await authorityCall(env, "/connections/initialize", [connection], `provider-connection:${encodeURIComponent(providerId)}`);
  return connection;
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

function normalizePolicyRecord(value: Record<string, unknown>): AccessPolicyEntry["policy"] {
  return {
    enabled: value.enabled !== false,
    generation: typeof value.generation === "string" ? value.generation : "legacy",
    providers: Array.isArray(value.providers) ? value.providers.filter((item): item is string => typeof item === "string") : [],
    tenantId: typeof value.tenantId === "string" ? value.tenantId : null,
    tokenRole: typeof value.tokenRole === "string" ? value.tokenRole : null,
    monthlyBudgetMicros: typeof value.monthlyBudgetMicros === "number" ? value.monthlyBudgetMicros : null,
    requestCostMicros: typeof value.requestCostMicros === "number" ? value.requestCostMicros : null,
    retainRequestContent: value.retainRequestContent !== false,
  };
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
  return { email, record: { role: value.record.role ?? "user", tenantId: value.record.tenantId ?? "default", enabled: value.record.enabled ?? true, groups: [...new Set(value.record.groups ?? [])].map((item) => item.trim().toLowerCase()).filter(Boolean).sort(), contentRetentionDisabled: value.record.contentRetentionDisabled ?? false } };
}
function sortBindings(values: PolicyBinding[]): PolicyBinding[] {
  return values.map(normalizeBinding).sort((a, b) => a.priority - b.priority || a.principalType.localeCompare(b.principalType) || a.principalId.localeCompare(b.principalId) || a.policyId.localeCompare(b.policyId));
}
