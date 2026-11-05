import { effectiveBudgetPolicy } from "./budget-overrides.ts";
import type { InputRetirement } from "./input-retirement.ts";
import type { SearchGrantAttestation } from "./authority-contracts.ts";
import { searchJsonBytes, searchUnavailable, searchControlBytes, inspectSearchJson, searchControlVersion, type MiniMaxSearchOperation, searchControlHeader, readSearchJson } from "./minimax-search-operation.ts";
import type { WanManagedOperation } from "./managed-media-json.ts";
import { normalizePolicyRecord } from "./authority-policy.ts";
import { normalizeUser, profileUpdate } from "./authority-users.ts";
import { mutateBudgetCaps } from "./authority-budgets.ts";
import { nextCredential } from "./credential-mutation.ts";
import { storedCredentialName } from "./credential-name.ts";
import { finishAdmissionSelection } from "./authority-grant-selection.ts";
import { mergeGrantRuntimeState, normalizeGrantRuntimeState } from "./grant-runtime.ts";
import type {
  AccessControlUser, AccessPolicy, AccessPolicyEntry, AccessUserRecord, Env, OAuthState, PolicyBinding,
  UpstreamGrant, AssignmentState, GrantRuntimeState, ProviderConnection, ProxyCredential, ProxyCredentialEntry,
} from "./types";
import { evaluateUserAssignments, withLegacyAssignmentState, type AssignmentEvidence, type AssignmentRuleEntry } from "./assignment-evaluator.ts";
import type { AuthorizationSnapshot, AuthorizationSnapshotRequest, CredentialMutation, CredentialMutationResult } from "./authority-contracts.ts";
import { contentRetentionDefault } from "./content-retention.ts";
import { normalizeConnectionMutation, type ProviderConnectionMutation } from "./provider-connections.ts";
import type { ResponsesScopeStore } from "./responses-scope.ts";
import { chooseGrantKey, normalizedChoiceCandidates } from "./grant-selection-strategies.ts";
import { publishRoutingProjection } from "./grant-projection.ts";
import { errorResponse, HttpError, json, normalizeEmail, readJson, safeEqual } from "./utils.ts";

type Principal = { principalType: "user" | "group"; principalId: string };
type Seed = { principal: Principal; bindings: PolicyBinding[] };
export const selfServiceCredentialLimit = 10;
const selfServiceCredentialRetentionLimit = 100;

export type { AdmissionProvider, AdmissionPool, AdmissionResult } from "./authority-admission.ts";
import { genuineLegacyKey, resolveAdmission, type AdmissionRequest } from "./authority-admission.ts";

export class PolicyBindingIndexObject implements DurableObject {
  private sql: SqlStorage;
  private storage: DurableObjectStorage;
  private responses?: Promise<ResponsesScopeStore>;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = state.storage;
    this.sql = state.storage.sql;
    this.ensureSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("route_not_found", "route not found", 404);
    try {
      if (path === "/http-continuations") return await (await this.responseStore()).continuation(request);
      if (path === "/responses-background") return await (await this.responseStore()).fetch(request);
      if (path === "/grant-search/authorize") return json(this.authorizeSearchGrant(await readJson<SearchGrantAttestation>(request, undefined, 16 * 1024)));
      if (path === "/authorization/snapshot") {
        const bound = request.headers.get(searchControlHeader) === searchControlVersion ? { bytes: 0 } : undefined;
        const result = this.authorizationSnapshot(await readJson<AuthorizationSnapshotRequest>(request), bound);
        if (bound) searchJsonBytes(result); return json(result);
      }
      if (path === "/admission/resolve") {
        const input = await readJson<AdmissionRequest>(request);
        const bound = input.search === searchControlVersion ? { bytes: 0 } : undefined;
        const result = await resolveAdmission(this.env, input, {
        getCredential: id => this.getCredential(id, bound), getPolicy: id => this.getPolicy(id, bound), getUser: id => this.getUser(id, bound), hasMeta: key => this.hasMeta(key),
        seedCredential: (id, value) => this.initializeCredentials([{ credentialId: id, credential: normalizeCredentialRecord(value, id) }]),
        seedPolicy: (id, value) => this.initializePolicies([{ policyId: id, policy: normalizePolicyRecord(value, contentRetentionDefault(this.env)) }]),
        initializeUsers: users => this.initializeUsers(users), initializeConnections: connections => this.initializeConnections(connections),
        resolveConnections: ids => this.resolveConnections(ids, bound), putMeta: key => this.putMeta(key), resolveGrantPool: input => this.resolveGrantPool(input, bound), finishSelection: (input, result) => finishAdmissionSelection(this.env, this.storage, input, result, {
          getCredential: id => this.getCredential(id, bound), getPolicy: id => this.getPolicy(id, bound), getUser: email => this.getUser(email, bound),
          resolveConnections: ids => this.resolveConnections(ids, bound), resolveGrantPool: request => this.resolveGrantPool(request, bound),
          grantAttachment: key => this.grantAttachment(key), consumeProjectionBytes: bytes => { if (bound && (bound.bytes += bytes) > searchControlBytes) searchUnavailable(); },
          selectGrant: request => this.selectGrant(request, bound), selectionState: poolKey => this.selectionState(poolKey),
        }),
        });
        if (bound) searchJsonBytes(result);
        return json(result);
      }
      if (path === "/resolve") return json({ initialized: this.hasMeta("bindings_global_initialized"), ...this.resolveBindings((await readJson<{ principals: Principal[] }>(request)).principals) });
      if (path === "/initialize") { this.initializeBindings(await readJson<Seed[]>(request)); return new Response("initialized"); }
      if (path === "/initialize-all") { this.initializeAllBindings(await readJson<PolicyBinding[]>(request)); return new Response("initialized"); }
      if (path === "/mutate") { const body = await readJson<{ seed: Seed; binding: PolicyBinding }>(request); this.initializeBindings([body.seed]); this.putBinding(body.binding); return new Response("updated"); }
      if (path === "/list") return json({ initialized: this.hasMeta("bindings_global_initialized"), bindings: this.listBindings() });
      if (path === "/users/resolve") return json({ initialized: this.hasMeta("users_global_initialized"), ...this.resolveUsers((await readJson<{ emails: string[] }>(request)).emails) });
      if (path === "/users/initialize") { this.initializeUsers(await readJson<AccessControlUser[]>(request)); return new Response("initialized"); }
      if (path === "/users/initialize-all") { this.initializeUsers(await readJson<AccessControlUser[]>(request)); this.putMeta("users_global_initialized"); return new Response("initialized"); }
      if (path === "/users/put") { this.putUser(await readJson<AccessControlUser>(request)); return new Response("updated"); }
      if (path === "/policies/budget-limits" || path === "/users/budget-override") return await mutateBudgetCaps(path, request, {
        user: email => this.getUser(email), policy: id => this.getPolicy(id), putUser: user => this.putUser(user), putPolicy: entry => this.putPolicy(entry),
      });
      if (path === "/users/update-profile") return json(this.updateUserProfile(await readJson<AccessControlUser>(request)));
      if (path === "/users/create") return json(this.createUser(await readJson<AccessControlUser>(request)));
      if (path === "/users/reconcile-assignments") return json(this.reconcileUserAssignments(await readJson<AssignmentReconcileRequest>(request)));
      if (path === "/users/put-bindings") return json(this.putUserBindings(await readJson<UserBindingsRequest>(request)));
      if (path === "/users/list") return json({ initialized: this.hasMeta("users_global_initialized"), users: this.listUsers() });
      if (path === "/policies/resolve") return json(this.resolvePolicies((await readJson<{ policyIds: string[] }>(request)).policyIds));
      if (path === "/policies/initialize") { this.initializePolicies(await readJson<AccessPolicyEntry[]>(request)); return new Response("initialized"); }
      if (path === "/policies/initialize-all") { this.initializePolicies(await readJson<AccessPolicyEntry[]>(request)); this.putMeta("policies_global_initialized"); return new Response("initialized"); }
      if (path === "/policies/put") { this.putPolicy(await readJson<AccessPolicyEntry>(request)); return new Response("updated"); }
      if (path === "/policies/list") return json({ initialized: this.hasMeta("policies_global_initialized"), policies: this.listPolicies() });
      if (path === "/credentials/resolve") return json(this.resolveCredentials((await readJson<{ credentialIds: string[] }>(request)).credentialIds));
      if (path === "/credentials/initialize") { this.initializeCredentials(await readJson<ProxyCredentialEntry[]>(request)); return new Response("initialized"); }
      if (path === "/credentials/initialize-all") { this.initializeCredentials(await readJson<ProxyCredentialEntry[]>(request)); this.putMeta("credentials_global_initialized"); return new Response("initialized"); }
      if (path === "/credentials/mutate") {
        try { return json(this.mutateCredential(await readJson<CredentialMutation>(request))); }
        catch (error) {
          if (error instanceof HttpError) return json({ outcome: "invalid", status: error.status, code: error.code, message: error.message });
          throw error;
        }
      }
      if (path === "/credentials/list") return json({ initialized: this.hasMeta("credentials_global_initialized"), credentials: this.listCredentials() });
      if (path === "/connections/resolve") {
        const bound = request.headers.get(searchControlHeader) === searchControlVersion ? { bytes: 0 } : undefined;
        const input = await readJson<{ providerIds: string[] }>(request);
        if (bound && (input.providerIds.length !== 1 || input.providerIds[0] !== "minimax")) searchUnavailable();
        const result = this.resolveConnections(input.providerIds, bound); if (bound) searchJsonBytes(result); return json(result);
      }
      if (path === "/connections/initialize") { this.initializeConnections(await readJson<ProviderConnection[]>(request)); return new Response("initialized"); }
      if (path === "/connections/initialize-all") { this.initializeConnections(await readJson<ProviderConnection[]>(request)); this.putMeta("connections_global_initialized"); return new Response("initialized"); }
      if (path === "/connections/put") return json(this.putConnection(await readJson<ProviderConnectionMutation>(request)));
      if (path === "/grant-pools/resolve") return json(this.resolveGrantPool(await readJson<GrantPoolResolveRequest>(request)));
      if (path === "/grant-pools/attachment") return json(this.grantAttachment((await readJson<{ key: string }>(request)).key));
      if (path === "/grant-pools/admit") return json(this.admitGrantAttachment(await readJson<GrantAttachmentMutation>(request)));
      if (path === "/grant-pools/publish") return json(this.publishGrantAttachment(await readJson<GrantAttachmentMutation>(request)));
      if (path === "/grant-pools/cancel-pending") return json(this.cancelPendingAttachment(await readJson<{ key: string; revision: number }>(request)));
      if (path === "/grant-pools/pending") return json(this.pendingGrantAttachments(await readJson<{ cursor?: string; limit?: number }>(request)));
      if (path === "/grant-pools/feedback") { this.putGrantRuntime(await readJson<GrantRuntimeFeedbackRequest>(request)); return new Response("updated"); }
      if (path === "/grant-pools/states") return json({ states: this.grantRuntimeStates((await readJson<GrantRuntimeStatesRequest>(request)).keys) });
      if (path === "/grant-pools/select") return json(this.selectGrant(await readJson<GrantPoolSelectRequest>(request)));
      if (path === "/grant-pools/record") { this.recordSelections(await readJson<GrantSelectionRecordRequest>(request)); return new Response("recorded"); }
      if (path === "/grant-pools/stats") return json({ stats: this.grantSelectionStats((await readJson<GrantRuntimeStatesRequest>(request)).keys) });
      if (path === "/submission-tickets/put") return json(this.putSubmissionTicket(await readJson<PoolSubmissionTicket>(request)));
      if (path === "/submission-tickets/claim") return json(this.claimSubmissionTicket(await readJson<SubmissionTicketClaimRequest>(request)));
      if (path === "/submission-tickets/complete") return json(this.completeSubmissionTicket(await readJson<SubmissionTicketCompletionRequest>(request)));
      if (path === "/submission-tickets/release") { this.releaseSubmissionTicket(await readJson<SubmissionTicketCompletionRequest>(request)); return new Response("released"); }
      if (path === "/oauth-states/put") { this.putOAuthState(await readJson<OAuthState>(request)); return new Response("updated"); }
      if (path === "/oauth-states/consume") return json({ state: this.consumeOAuthState(await readJson<{ state: string; actorEmail: string }>(request)) });
      return errorResponse("route_not_found", "route not found", 404);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
      return errorResponse("authority_error", "authority request failed", 500);
    }
  }

  async alarm(): Promise<void> { return (await this.responseStore()).alarm(); }
  private responseStore(): Promise<ResponsesScopeStore> {
    return this.responses ??= import("./responses-scope.ts").then(({ ResponsesScopeStore }) => new ResponsesScopeStore(this.storage, this.env));
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
    // Existing rows stay selectable until the explicit attachment migration.
    // Pending rows originate only from an owner command, never a legacy read.
    const poolColumns = rows<{ name: string }>(this.sql.exec("PRAGMA table_info(upstream_grant_pool_members)"));
    if (!poolColumns.some((column) => column.name === "status")) this.sql.exec("ALTER TABLE upstream_grant_pool_members ADD COLUMN status TEXT NOT NULL DEFAULT 'legacy'");
    if (!poolColumns.some((column) => column.name === "pending_previous_status")) this.sql.exec("ALTER TABLE upstream_grant_pool_members ADD COLUMN pending_previous_status TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS upstream_grant_pool_pending ON upstream_grant_pool_members (status, scope, scope_id, token_ref)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS upstream_grant_pool_identity ON upstream_grant_pool_members (scope, scope_id, token_ref)");
    // Detach retains this fence, so delayed publication cannot resurrect it.
    // Revision also fences admission/repair while owner generation is unchanged.
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_pool_versions (grant_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, revision INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_projections (grant_key TEXT PRIMARY KEY, projection_json TEXT, legacy INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_runtime (grant_key TEXT PRIMARY KEY, state_json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_selection (pool_key TEXT NOT NULL, grant_key TEXT NOT NULL, selected_count INTEGER NOT NULL, last_selected_ms INTEGER NOT NULL, PRIMARY KEY (pool_key, grant_key))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_pool_cursors (pool_key TEXT PRIMARY KEY, grant_key TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS pool_submission_tickets (ticket_id TEXT PRIMARY KEY, ticket_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS oauth_authorization_states (state TEXT PRIMARY KEY, state_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)");
  }

  private initializeBindings(seeds: Seed[]): void {
    if (this.hasMeta("bindings_global_initialized")) return;
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
    if (this.hasMeta("users_global_initialized")) return;
    for (const user of users) if (!this.getUser(user.email)) this.putUser(user);
  }

  private updateUserProfile(raw: AccessControlUser): AccessControlUser {
    const user = profileUpdate(raw, this.getUser(raw.email)?.record);
    this.putUser(user);
    return user;
  }

  private createUser(defaults: AccessControlUser): AccessControlUser {
    const existing = this.getUser(defaults.email);
    if (existing) return existing;
    this.putUser(defaults);
    return this.getUser(defaults.email)!;
  }

  private searchStored(table: string, column: string, keyColumn: string, key: string, bound: { bytes: number; records?: number }): unknown {
    const size = rows<{ bytes: number }>(this.sql.exec(`SELECT length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE ${keyColumn} = ?`, key))[0];
    if (!size) return null;
    if ((bound.records = (bound.records ?? 0) + 1) > 32) searchUnavailable();
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || (bound.bytes += size.bytes) > searchControlBytes) searchUnavailable();
    const row = rows<{ value: string }>(this.sql.exec(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn} = ?`, key))[0];
    if (!row) searchUnavailable();
    inspectSearchJson(row.value); return JSON.parse(row.value);
  }

  private getUser(email: string, bound?: { bytes: number; records?: number }): AccessControlUser | null {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    if (bound) { const record = this.searchStored("access_users", "user_json", "email", normalized, bound) as AccessUserRecord | null; return record ? { email: normalized, record } : null; }
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

  private reconcileUserAssignments(request: AssignmentReconcileRequest) {
    const user = this.getUser(request.email);
    if (!user) throw new HttpError(404, "unknown_user", "access user not found");
    const candidate = withLegacyAssignmentState(user, request.legacy);
    const result = evaluateUserAssignments(candidate, request.rules, request.evidence, request.force);
    if (result.changed) this.putUser(result.user);
    return result;
  }

  private putUserBindings(request: UserBindingsRequest): { user: AccessControlUser; bindings: PolicyBinding[] } {
    this.initializeBindings([request.seed]);
    const user = this.updateUserProfile(request.user);
    const principal: Principal = { principalType: "user", principalId: user.email };
    const current = this.resolveBindings([principal]).bindings;
    const desired = new Set(request.policyIds);
    for (const binding of current) this.putBinding({ ...binding, enabled: desired.has(binding.policyId) });
    for (const policyId of desired) if (!current.some((binding) => binding.policyId === policyId)) this.putBinding({ policyId, ...principal, enabled: true, priority: 100 });
    return { user, bindings: this.resolveBindings([principal]).bindings };
  }

  private putPolicy(entry: AccessPolicyEntry): void {
    if (!entry.policyId) invalidAuthorityRequest("policyId is required");
    this.sql.exec("INSERT OR REPLACE INTO access_policies (policy_id, policy_json) VALUES (?, ?)", entry.policyId, JSON.stringify(entry.policy));
  }

  private initializePolicies(entries: AccessPolicyEntry[]): void {
    if (this.hasMeta("policies_global_initialized")) return;
    for (const entry of entries) if (!this.getPolicy(entry.policyId)) this.putPolicy(entry);
  }
  private getPolicy(id: string, bound?: { bytes: number; records?: number }): AccessPolicyEntry | null {
    if (bound) { const policy = this.searchStored("access_policies", "policy_json", "policy_id", id, bound) as AccessPolicy | null; return policy ? { policyId: id, policy } : null; }
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

  private authorizeSearchGrant(input: SearchGrantAttestation): SearchGrantAttestation {
    searchJsonBytes(input);
    if (!input || Object.keys(input).sort().join(",") !== "actor,admissionRevision,digest,key,original,resultGeneration,resultLineage"
      || !input.actor || Object.keys(input.actor).sort().join(",") !== "auth,email,role"
      || !["local", "cloudflare_access"].includes(input.actor.auth) || input.actor.role !== "admin"
      || typeof input.actor.email !== "string" || typeof input.key !== "string" || input.key.length > 512
      || typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)
      || typeof input.resultLineage !== "string" || !input.resultLineage || input.resultLineage.length > 128
      || !input.original || Object.keys(input.original).sort().join(",") !== "exists,generation,lineage,revision"
      || typeof input.original.exists !== "boolean" || !Number.isSafeInteger(input.original.generation) || input.original.generation < 0
      || !Number.isSafeInteger(input.original.revision) || input.original.revision < 0
      || !Number.isSafeInteger(input.admissionRevision) || input.admissionRevision < 0
      || !Number.isSafeInteger(input.resultGeneration)
      || input.resultGeneration !== input.original.generation + 1
      || !input.original.exists && (input.original.generation !== 0 || input.original.lineage !== null)
      || input.original.exists && (typeof input.original.lineage !== "string" || !input.original.lineage || input.original.lineage.length > 128)) searchUnavailable();
    return this.storage.transactionSync(() => {
      const principal = normalizeEmail(input.actor.email), user = principal ? this.getUser(principal, { bytes: 0 }) : null;
      if (!user || user.record.enabled !== true || user.record.role !== "admin")
        throw new HttpError(403, "access_admin_required", "Current administrator authority is required");
      const attachment = this.grantAttachment(input.key);
      if (attachment.generation !== input.original.generation || attachment.revision !== input.admissionRevision
        || input.admissionRevision < input.original.revision) searchUnavailable();
      return input;
    });
  }

  private putCredential(entry: ProxyCredentialEntry): void {
    this.sql.exec("INSERT OR REPLACE INTO proxy_credentials (credential_id, credential_json) VALUES (?, ?)", entry.credentialId, JSON.stringify(entry.credential));
  }
  private mutateCredential(request: CredentialMutation): CredentialMutationResult {
    // Actor provenance comes only from the verified HTTP session. Local roles,
    // user state and policy holdings must still be current at the write boundary.
    const { actor, scope, operation, credentialId } = request;
    const principalId = normalizeEmail(actor.email), user = principalId ? this.getUser(principalId) : null;
    if (actor.auth !== "admin_token" && (!user || user.record.enabled === false)) return { outcome: "actor_disabled" };
    if (scope === "admin" && (actor.role !== "admin" || actor.auth === "local" && user?.record.role !== "admin")) return { outcome: "admin_required" };
    if (scope === "personal" && (!principalId || actor.auth === "admin_token")) return { outcome: "actor_disabled" };
    if (Object.hasOwn(request, "copilotPublicIdentity") && scope !== "admin") return { outcome: "admin_required" };
    const existing = this.getCredential(credentialId);
    // A create collision must not prune retained rows or replace any part of the key.
    if (operation === "create" && existing) return { outcome: "exists" };
    if ((operation === "rotate" || operation === "revoke" || operation === "rename") && !existing) return { outcome: "missing" };
    if (scope === "personal" && existing && normalizeEmail(existing.credential.principalId ?? "") !== principalId) return { outcome: "owned_elsewhere" };
    const policyId = operation === "create" || operation === "put" ? request.credential.policyId : existing!.credential.policyId;
    const policy = this.getPolicy(policyId);
    const ownerEnabled = !existing?.credential.principalId || this.getUser(existing.credential.principalId)?.record.enabled !== false;
    if (operation === "rotate" && (!existing!.credential.enabled || !policy?.policy.enabled || existing!.credential.policyGeneration !== policy.policy.generation || !ownerEnabled)) return { outcome: "inactive" };
    if (operation !== "revoke" && operation !== "rename") {
      if (scope === "personal") {
        if (!this.holdsPolicy(user, policy)) return { outcome: "policy_not_held" };
      } else if (!policy) return { outcome: "unknown_policy" };
    }
    const credential = nextCredential(request, existing?.credential, policy?.policy, principalId, this.env);
    const entry = { credentialId, credential };
    if (scope === "personal" && (operation === "create" || operation === "put")) {
      const owned = this.listCredentials().filter((candidate) => candidate.credentialId !== credentialId && normalizeEmail(candidate.credential.principalId ?? "") === principalId);
      const enabled = owned.filter((candidate) => candidate.credential.enabled).length;
      if (enabled >= selfServiceCredentialLimit) return { outcome: "limit_reached" };
      if (!existing && owned.length >= selfServiceCredentialRetentionLimit) {
        const pruneCount = owned.length - selfServiceCredentialRetentionLimit + 1;
        const revoked = owned.filter((candidate) => !candidate.credential.enabled).sort((left, right) => left.credentialId.localeCompare(right.credentialId));
        if (revoked.length < pruneCount) return { outcome: "limit_reached" };
        for (const candidate of revoked.slice(0, pruneCount)) this.deleteCredential(candidate.credentialId);
      }
    }
    this.putCredential(entry);
    return { outcome: "updated", entry, policy, principalEnabled: !credential.principalId || this.getUser(credential.principalId)?.record.enabled !== false };
  }
  private deleteCredential(id: string): void { this.sql.exec("DELETE FROM proxy_credentials WHERE credential_id = ?", id); }
  private initializeCredentials(entries: ProxyCredentialEntry[]): void {
    if (this.hasMeta("credentials_global_initialized")) return;
    for (const entry of entries) if (!this.getCredential(entry.credentialId)) {
      // Legacy KV/import metadata has no administrator attestation provenance.
      const { copilotPublicIdentity: _untrusted, ...credential } = entry.credential;
      this.putCredential({ ...entry, credential });
    }
  }
  private getCredential(id: string, bound?: { bytes: number; records?: number }): ProxyCredentialEntry | null {
    if (bound) { const credential = this.searchStored("proxy_credentials", "credential_json", "credential_id", id, bound) as ProxyCredential | null; return credential ? { credentialId: id, credential } : null; }
    const row = rows<{ credential_json: string }>(this.sql.exec("SELECT credential_json FROM proxy_credentials WHERE credential_id = ?", id))[0];
    return row ? { credentialId: id, credential: JSON.parse(row.credential_json) } : null;
  }
  private authorizationSnapshot(input: AuthorizationSnapshotRequest, bound?: { bytes: number; records?: number }): AuthorizationSnapshot {
    // No KV import or await: this is the authority admission point after a
    // queued control's preparation, using current stored groups and bindings.
    const credential = input.credentialId ? this.getCredential(input.credentialId, bound)?.credential ?? null : null;
    const policy = this.getPolicy(input.policyId, bound), user = input.principalId ? this.getUser(input.principalId, bound) : null;
    if (bound && input.principalId && !user) searchUnavailable();
    const currentPolicy = bound && policy ? { ...policy, policy: effectiveBudgetPolicy(policy.policyId, policy.policy, user?.record.budgetOverrides) } : policy;
    return { credential, policy: currentPolicy, principalEnabled: user ? user.record.enabled !== false : null, policyHeld: bound && input.credentialId ? false : this.holdsPolicy(user, policy) };
  }
  private holdsPolicy(user: AccessControlUser | null, policy: AccessPolicyEntry | null): boolean {
    if (!user || user.record.enabled === false || !policy?.policy.enabled) return false;
    const principals: Principal[] = [{ principalType: "user", principalId: user.email },
      ...(user.record.groups ?? []).map(principalId => ({ principalType: "group" as const, principalId }))];
    return this.resolveBindings(principals).bindings.some(binding => binding.enabled && binding.policyId === policy.policyId);
  }
  private resolveCredentials(ids: string[]): { initialized: boolean; credentials: ProxyCredentialEntry[]; missingCredentialIds: string[] } {
    const credentials: ProxyCredentialEntry[] = [], missingCredentialIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getCredential(id); if (entry) credentials.push(entry); else missingCredentialIds.push(id); }
    return { initialized: this.hasMeta("credentials_global_initialized"), credentials, missingCredentialIds };
  }
  private listCredentials(): ProxyCredentialEntry[] {
    return rows<{ credential_id: string; credential_json: string }>(this.sql.exec("SELECT credential_id, credential_json FROM proxy_credentials ORDER BY credential_id")).map((row) => ({ credentialId: row.credential_id, credential: JSON.parse(row.credential_json) }));
  }

  private putConnection(input: ProviderConnectionMutation): ProviderConnection {
    const mutation = normalizeConnectionMutation(input, input.providerId);
    // Read and merge without yielding so a budget edit cannot restore a stale kill switch.
    const current = this.getConnection(mutation.providerId);
    const connection: ProviderConnection = { enabled: current?.enabled ?? true, label: current?.label ?? null, monthlyBudgetMicros: current?.monthlyBudgetMicros ?? null, ...mutation };
    this.sql.exec("INSERT OR REPLACE INTO provider_connections (provider_id, connection_json) VALUES (?, ?)", connection.providerId, JSON.stringify(connection));
    return connection;
  }
  private initializeConnections(items: ProviderConnection[]): void {
    if (this.hasMeta("connections_global_initialized")) return;
    for (const item of items) if (!this.getConnection(item.providerId)) this.putConnection(item);
  }
  private getConnection(id: string, bound?: { bytes: number; records?: number }): ProviderConnection | null {
    if (bound) return this.searchStored("provider_connections", "connection_json", "provider_id", id, bound) as ProviderConnection | null;
    const row = rows<{ connection_json: string }>(this.sql.exec("SELECT connection_json FROM provider_connections WHERE provider_id = ?", id))[0];
    return row ? JSON.parse(row.connection_json) : null;
  }
  private resolveConnections(ids: string[], bound?: { bytes: number; records?: number }): { initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] } {
    const connections: ProviderConnection[] = [], missingProviderIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getConnection(id, bound); if (entry) connections.push(entry); else missingProviderIds.push(id); }
    return { initialized: this.hasMeta("connections_global_initialized"), connections, missingProviderIds };
  }

  private resolveGrantPool(input: GrantPoolResolveRequest, bound?: { bytes: number; records?: number }): { keys: string[]; states: Record<string, GrantRuntimeState>; hasAttachment: boolean } {
    const providerId = grantSegment(input.providerId, "providerId");
    const policyId = grantPoolScopeId(input.policyId);
    const tenantId = grantPoolScopeId(input.tenantId);
    // Only the stored consumer policy can share another scope's owner. Never
    // accept membership from a request or follow another policy's references.
    const shared = policyId ? this.getPolicy(policyId, bound)?.policy.grantRouting?.sharedGrants?.[providerId] ?? [] : [];
    if (bound) {
      if (shared.length) searchUnavailable();
      let members = 0, bytes = 0;
      for (const [scope, id] of [["policies", policyId], ["tenants", tenantId]]) {
        if (!id) continue;
        const count = rows<{ count: number; bytes: number }>(this.sql.exec("SELECT count(*) AS count, coalesce(sum(length(CAST(token_ref AS BLOB))),0) AS bytes FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ?", scope, id, providerId))[0];
        members += count.count; bytes += count.bytes;
      }
      if (members > 32 || bytes > searchControlBytes) searchUnavailable();
    }
    const sharedKeys = shared.filter(key => {
      if (this.attachmentMember(grantPoolIdentity(key), providerId)?.status !== "active") return false;
      const row = rows<{ projection_json: string | null }>(this.sql.exec("SELECT projection_json FROM upstream_grant_projections WHERE grant_key = ? AND legacy = 0", key))[0];
      const grant: UpstreamGrant | null = row?.projection_json ? JSON.parse(row.projection_json) : null;
      return grant?.kind === "subscription" && grant.provider === providerId;
    });
    const keys = [...new Set([
      ...(bound ? [] : (input.defaultKeys ?? []).map((key) => grantKey(key))),
      ...(policyId ? this.poolTokenRefs("policies", policyId, providerId).map((tokenRef) => `oauth/${policyId}/${tokenRef}`) : []),
      ...(tenantId ? this.poolTokenRefs("tenants", tenantId, providerId).map((tokenRef) => `oauth/tenants/${tenantId}/${tokenRef}`) : []),
      ...sharedKeys,
    ])];
    const hasAttachment = shared.length > 0 || [policyId && ["policies", policyId], tenantId && ["tenants", tenantId]].some((scope) => scope && rows(this.sql.exec("SELECT 1 FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? LIMIT 1", ...scope, providerId)).length > 0);
    if (bound && keys.length > 32) searchUnavailable();
    return { keys, states: this.grantRuntimeStates(keys, bound), hasAttachment };
  }

  private grantAttachment(key: string): GrantAttachmentSnapshot {
    const identity = grantPoolIdentity(key);
    const version = rows<{ generation: number; revision: number }>(this.sql.exec("SELECT generation, revision FROM upstream_grant_pool_versions WHERE grant_key = ?", key))[0];
    const pending = rows(this.sql.exec("SELECT 1 FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND status IN ('pending', 'pending_inactive') LIMIT 1", ...identity)).length > 0;
    const attached = rows(this.sql.exec("SELECT 1 FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND status NOT IN ('pending', 'pending_inactive') LIMIT 1", ...identity)).length > 0;
    return { generation: version?.generation ?? 0, revision: version?.revision ?? 0, pending, attached };
  }

  private admitGrantAttachment(input: GrantAttachmentMutation): GrantAttachmentSnapshot {
    return this.storage.transactionSync(() => {
      const { identity, provider, status, current } = this.attachmentMutation(input);
      if (input.generation !== current.generation) throw new HttpError(409, "grant_attachment_changed", "reconcile the current owner before admission");
      if (provider && status) {
        const member = this.attachmentMember(identity, provider);
        if (!member || status === "active" && !["active", "legacy", "pending"].includes(member.status)) {
          if (status === "active") {
            const count = rows<{ count: number }>(this.sql.exec("SELECT count(*) AS count FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? AND status IN ('legacy', 'active', 'pending')", identity[0], identity[1], provider))[0].count;
            if (count >= 32) invalidAuthorityRequest("grant pool cannot contain more than 32 active or pending members per scope and provider");
          }
          // Inactive proposals still need recoverable provenance before owner
          // commit, but must not consume capacity reserved for active grants.
          const previous = member && !["pending", "pending_inactive"].includes(member.status) ? member.status : member?.pending_previous_status ?? null;
          this.sql.exec("INSERT INTO upstream_grant_pool_members (scope, scope_id, provider_id, token_ref, status, pending_previous_status) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, scope_id, provider_id, token_ref) DO UPDATE SET status = excluded.status, pending_previous_status = excluded.pending_previous_status", identity[0], identity[1], provider, identity[2], status === "active" ? "pending" : "pending_inactive", previous);
        }
      }
      // Reserve a fresh revision even when the existing member needs no slot.
      // An old repair cannot cancel a later command's reservation.
      this.storeAttachmentVersion(input.key, current.generation, current.revision + 1);
      return this.grantAttachment(input.key);
    });
  }

  private publishGrantAttachment(input: GrantAttachmentMutation): GrantAttachmentResult {
    return this.storage.transactionSync(() => {
      const { identity, provider, status, current } = this.attachmentMutation(input);
      // Only the explicit credential commit can acknowledge its admission.
      // A later refresh or raw import must not adopt an abandoned proposal.
      const restored = current.pending && (input.admissionRevision !== current.revision || input.generation === current.generation);
      if (restored) this.restorePendingAttachment(identity);
      const prepared = restored ? this.grantAttachment(input.key) : current;
      const member = provider ? this.attachmentMember(identity, provider) : undefined;
      const outcome = !status ? "detached" : member ? "attached" : "unattached";
      if (input.generation === current.generation && !prepared.pending) {
        const others = rows(this.sql.exec("SELECT 1 FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND provider_id != ? LIMIT 1", ...identity, provider ?? "")).length > 0;
        // Raw migration and refresh can deliberately remain unattached. They
        // must replay without inventing admission or erasing legacy evidence.
        if (status ? !member || member.status === status && !others : !prepared.attached) {
          // Retire the consumed reservation even when owner state is unchanged.
          if (restored) this.storeAttachmentVersion(input.key, input.generation, current.revision + 1);
          publishRoutingProjection(this.sql, input);
          return { ...this.grantAttachment(input.key), outcome };
        }
        throw new HttpError(409, "grant_attachment_changed", "same-generation attachment publication differs from its committed state");
      }
      if (status === "active" && member && !["active", "legacy", "pending"].includes(member.status)) throw new HttpError(409, "grant_attachment_admission_required", "resuming this attachment requires capacity admission");
      if (!status) this.sql.exec("DELETE FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ?", ...identity);
      else if (member) {
        this.sql.exec("UPDATE upstream_grant_pool_members SET status = ?, pending_previous_status = NULL WHERE scope = ? AND scope_id = ? AND token_ref = ? AND provider_id = ?", status, ...identity, provider!);
        this.sql.exec("DELETE FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND provider_id != ?", ...identity, provider!);
      } else this.sql.exec("DELETE FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND status IN ('pending', 'pending_inactive')", ...identity);
      if (status !== "active") this.sql.exec("DELETE FROM upstream_grant_runtime WHERE grant_key = ?", input.key);
      this.storeAttachmentVersion(input.key, input.generation, current.revision + 1);
      publishRoutingProjection(this.sql, input);
      return { ...this.grantAttachment(input.key), outcome };
    });
  }

  private cancelPendingAttachment(input: { key: string; revision: number }): GrantAttachmentResult {
    return this.storage.transactionSync(() => {
      const identity = grantPoolIdentity(input.key), current = this.grantAttachment(input.key);
      if (input.revision !== current.revision) throw new HttpError(409, "grant_attachment_changed", "attachment revision changed; reread the owner before repair");
      // Only an explicit, uncommitted first admission has generation zero.
      // Strong owner absence authorizes its cancellation, never legacy removal.
      if (current.generation !== 0) return { ...current, outcome: "unresolved" };
      if (current.pending) {
        this.restorePendingAttachment(identity);
        this.storeAttachmentVersion(input.key, 0, current.revision + 1);
      }
      const updated = this.grantAttachment(input.key);
      return { ...updated, outcome: updated.attached ? "unresolved" : "pending_cancelled" };
    });
  }

  private restorePendingAttachment(identity: [string, string, string]): void {
    this.sql.exec("UPDATE upstream_grant_pool_members SET status = pending_previous_status, pending_previous_status = NULL WHERE scope = ? AND scope_id = ? AND token_ref = ? AND status IN ('pending', 'pending_inactive') AND pending_previous_status IS NOT NULL", ...identity);
    this.sql.exec("DELETE FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND status IN ('pending', 'pending_inactive')", ...identity);
  }

  private pendingGrantAttachments(input: { cursor?: string; limit?: number }): { keys: string[]; cursor: string | null } {
    const limit = boundedInteger(input.limit ?? 32, "limit", 1, 64);
    const after = input.cursor ? grantPoolIdentity(input.cursor) : ["", "", ""];
    const page = rows<{ scope: string; scope_id: string; token_ref: string }>(this.sql.exec("SELECT scope, scope_id, token_ref FROM upstream_grant_pool_members WHERE status IN ('pending', 'pending_inactive') AND (scope, scope_id, token_ref) > (?, ?, ?) GROUP BY scope, scope_id, token_ref ORDER BY scope, scope_id, token_ref LIMIT ?", ...after, limit + 1));
    const keys = page.slice(0, limit).map((row) => row.scope === "tenants" ? `oauth/tenants/${row.scope_id}/${row.token_ref}` : `oauth/${row.scope_id}/${row.token_ref}`);
    return { keys, cursor: page.length > limit ? keys[keys.length - 1] : null };
  }

  private attachmentMutation(input: GrantAttachmentMutation): { identity: [string, string, string]; provider: string | null; status: GrantAttachmentStatus | null; current: GrantAttachmentSnapshot } {
    const identity = grantPoolIdentity(input.key), current = this.grantAttachment(input.key);
    boundedInteger(input.generation, "generation", 0, Number.MAX_SAFE_INTEGER - 1);
    boundedInteger(input.revision, "revision", 0, Number.MAX_SAFE_INTEGER - 1);
    if (input.admissionRevision !== undefined) boundedInteger(input.admissionRevision, "admissionRevision", 0, Number.MAX_SAFE_INTEGER - 1);
    const provider = input.provider == null ? null : grantSegment(input.provider, "provider");
    const status = input.status;
    if (status !== null && !["active", "paused", "reauth_required"].includes(status)) invalidAuthorityRequest("attachment status is invalid");
    if (input.revision !== current.revision || input.generation < current.generation) throw new HttpError(409, "grant_attachment_changed", "attachment changed; reread the current owner before publication");
    return { identity, provider, status, current };
  }

  private attachmentMember(identity: [string, string, string], provider: string): { status: string; pending_previous_status: string | null } | undefined {
    return rows<{ status: string; pending_previous_status: string | null }>(this.sql.exec("SELECT status, pending_previous_status FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND provider_id = ?", ...identity, provider))[0];
  }

  private storeAttachmentVersion(key: string, generation: number, revision: number): void {
    this.sql.exec("INSERT INTO upstream_grant_pool_versions (grant_key, generation, revision) VALUES (?, ?, ?) ON CONFLICT (grant_key) DO UPDATE SET generation = excluded.generation, revision = excluded.revision", key, generation, revision);
  }

  private putGrantRuntime(input: GrantRuntimeFeedbackRequest): void {
    const key = grantKey(input.key), state = normalizeGrantRuntimeState(input.state);
    const current = rows<{ state_json: string }>(this.sql.exec("SELECT state_json FROM upstream_grant_runtime WHERE grant_key = ?", key))[0];
    const previous = current ? normalizeGrantRuntimeState(JSON.parse(current.state_json)) : null;
    const merged = mergeGrantRuntimeState(previous, state);
    this.sql.exec("INSERT OR REPLACE INTO upstream_grant_runtime (grant_key, state_json) VALUES (?, ?)", key, JSON.stringify(merged));
  }

  private grantRuntimeStates(rawKeys: unknown, bound?: { bytes: number; records?: number }): Record<string, GrantRuntimeState> {
    if (!Array.isArray(rawKeys) || rawKeys.length > 98) invalidAuthorityRequest("grant runtime keys must be a bounded array");
    const states: Record<string, GrantRuntimeState> = {};
    for (const key of [...new Set(rawKeys.map((value) => grantKey(value)))]) {
      if (bound) {
        const state = this.searchStored("upstream_grant_runtime", "state_json", "grant_key", key, bound);
        if (state) states[key] = normalizeGrantRuntimeState(state); continue;
      }
      const row = rows<{ state_json: string }>(this.sql.exec("SELECT state_json FROM upstream_grant_runtime WHERE grant_key = ?", key))[0];
      if (row) states[key] = normalizeGrantRuntimeState(JSON.parse(row.state_json));
    }
    return states;
  }

  private selectGrant(input: GrantPoolSelectRequest, bound?: { bytes: number; records?: number }): { selectedKey: string; selectedCount: number; lastSelectedAt: string } {
    const poolKey = grantSelectionPoolKey(input.poolKey);
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 98) invalidAuthorityRequest("grant selection candidates must be a bounded array");
    if (bound) {
      const size = rows<{ count: number; bytes: number }>(this.sql.exec("SELECT count(*) AS count, coalesce(sum(length(CAST(grant_key AS BLOB))),0) AS bytes FROM upstream_grant_selection WHERE pool_key = ?", poolKey))[0];
      if (size.count > 32 || (bound.bytes += size.bytes) > searchControlBytes) searchUnavailable();
    }
    const candidates = normalizedChoiceCandidates(input.candidates, grantKey);
    const cursorKey = rows<{ grant_key: string }>(this.sql.exec("SELECT grant_key FROM upstream_grant_pool_cursors WHERE pool_key = ?", poolKey))[0]?.grant_key ?? null;
    const counts = input.strategy === "least_used" ? this.selectionCounts(poolKey) : new Map<string, { count: number; lastMs: number }>();
    const choice = chooseGrantKey(input, candidates, { cursorKey, counts });
    if (choice.cursorKey) this.sql.exec("INSERT OR REPLACE INTO upstream_grant_pool_cursors (pool_key, grant_key) VALUES (?, ?)", poolKey, choice.cursorKey);
    const nowMs = Date.now();
    const row = rows<{ selected_count: number }>(this.sql.exec("INSERT INTO upstream_grant_selection (pool_key, grant_key, selected_count, last_selected_ms) VALUES (?, ?, 1, ?) ON CONFLICT (pool_key, grant_key) DO UPDATE SET selected_count = selected_count + 1, last_selected_ms = excluded.last_selected_ms RETURNING selected_count", poolKey, choice.selectedKey, nowMs))[0];
    return { selectedKey: choice.selectedKey, selectedCount: row.selected_count, lastSelectedAt: new Date(nowMs).toISOString() };
  }

  /** Pool counters and cursor for an isolate-local selection snapshot. */
  private selectionState(rawPoolKey: string): { cursorKey: string | null; counts: Record<string, { count: number; lastMs: number }> } {
    const poolKey = grantSelectionPoolKey(rawPoolKey);
    return {
      cursorKey: rows<{ grant_key: string }>(this.sql.exec("SELECT grant_key FROM upstream_grant_pool_cursors WHERE pool_key = ?", poolKey))[0]?.grant_key ?? null,
      counts: Object.fromEntries(this.selectionCounts(poolKey)),
    };
  }

  private selectionCounts(poolKey: string): Map<string, { count: number; lastMs: number }> {
    return new Map(rows<{ grant_key: string; selected_count: number; last_selected_ms: number }>(this.sql.exec("SELECT grant_key, selected_count, last_selected_ms FROM upstream_grant_selection WHERE pool_key = ?", poolKey)).map((row) => [row.grant_key, { count: row.selected_count, lastMs: row.last_selected_ms }]));
  }

  // Coalesced isolate-local selections. Counters are advisory statistics for
  // least-used/round-robin/threshold; small cross-isolate drift is accepted.
  private recordSelections(input: GrantSelectionRecordRequest): void {
    if (!Array.isArray(input.records) || input.records.length > 256) invalidAuthorityRequest("grant selection records must be a bounded array");
    this.storage.transactionSync(() => {
      for (const record of input.records) {
        const poolKey = grantSelectionPoolKey(record.poolKey);
        const key = grantKey(record.key);
        const count = Number.isSafeInteger(record.count) && record.count > 0 && record.count <= 1_000_000 ? record.count : 1;
        const lastMs = Number.isSafeInteger(record.lastMs) && record.lastMs > 0 ? record.lastMs : Date.now();
        this.sql.exec("INSERT INTO upstream_grant_selection (pool_key, grant_key, selected_count, last_selected_ms) VALUES (?, ?, ?, ?) ON CONFLICT (pool_key, grant_key) DO UPDATE SET selected_count = selected_count + excluded.selected_count, last_selected_ms = MAX(last_selected_ms, excluded.last_selected_ms)", poolKey, key, count, lastMs);
        if (record.cursorKey != null) this.sql.exec("INSERT OR REPLACE INTO upstream_grant_pool_cursors (pool_key, grant_key) VALUES (?, ?)", poolKey, grantKey(record.cursorKey));
      }
    });
  }

  private grantSelectionStats(rawKeys: unknown): Record<string, { selectedCount: number; lastSelectedAt: string | null }> {
    if (!Array.isArray(rawKeys) || rawKeys.length > 98) invalidAuthorityRequest("grant selection keys must be a bounded array");
    const stats: Record<string, { selectedCount: number; lastSelectedAt: string | null }> = {};
    for (const key of [...new Set(rawKeys.map((value) => grantKey(value)))]) {
      const row = rows<{ selected_count: number; last_selected_ms: number | null }>(this.sql.exec("SELECT COALESCE(SUM(selected_count), 0) AS selected_count, MAX(last_selected_ms) AS last_selected_ms FROM upstream_grant_selection WHERE grant_key = ?", key))[0];
      stats[key] = { selectedCount: row?.selected_count ?? 0, lastSelectedAt: row?.last_selected_ms ? new Date(row.last_selected_ms).toISOString() : null };
    }
    return stats;
  }

  private putSubmissionTicket(raw: PoolSubmissionTicket): PoolSubmissionTicketView {
    const ticket = normalizeSubmissionTicket(raw);
    this.sql.exec("DELETE FROM pool_submission_tickets WHERE expires_at_ms < ?", Date.now());
    if (this.getSubmissionTicket(ticket.id)) invalidAuthorityRequest("submission ticket already exists");
    this.sql.exec("INSERT INTO pool_submission_tickets (ticket_id, ticket_json, expires_at_ms) VALUES (?, ?, ?)", ticket.id, JSON.stringify(ticket), ticket.expiresAtMs);
    return submissionTicketView(ticket);
  }

  private claimSubmissionTicket(input: SubmissionTicketClaimRequest): SubmissionTicketClaimResult {
    const id = submissionTicketId(input.id), ticket = this.getSubmissionTicket(id);
    if (!ticket || !sha256Digest(input.secretSha256) || !safeEqual(ticket.secretSha256, input.secretSha256)) return { outcome: "denied" };
    if (ticket.expiresAtMs <= Date.now()) return { outcome: "expired" };
    const submissionSha256 = sha256Digest(input.submissionSha256);
    if (!submissionSha256) invalidAuthorityRequest("submission digest is invalid");
    if (ticket.state === "consumed") {
      return ticket.submissionSha256 === submissionSha256
        ? { outcome: "already_consumed", ticket: submissionTicketView(ticket), receipt: ticket.receipt ?? null }
        : { outcome: "denied" };
    }
    if (ticket.state === "claimed") {
      return ticket.submissionSha256 === submissionSha256 && ticket.claimId
        ? { outcome: "claimed", ticket: submissionTicketView(ticket), claimId: ticket.claimId }
        : { outcome: "denied" };
    }
    const claimed: PoolSubmissionTicket = { ...ticket, state: "claimed", submissionSha256, claimId: crypto.randomUUID(), claimedAtMs: Date.now() };
    this.storeSubmissionTicket(claimed);
    return { outcome: "claimed", ticket: submissionTicketView(claimed), claimId: claimed.claimId! };
  }

  private completeSubmissionTicket(input: SubmissionTicketCompletionRequest): SubmissionTicketClaimResult {
    const id = submissionTicketId(input.id), ticket = this.getSubmissionTicket(id);
    if (!ticket || ticket.state !== "claimed" || !ticket.claimId || ticket.claimId !== input.claimId) return { outcome: "denied" };
    const receipt = normalizeSubmissionReceipt(input.receipt);
    const consumed: PoolSubmissionTicket = { ...ticket, state: "consumed", receipt, claimId: null, claimedAtMs: null };
    this.storeSubmissionTicket(consumed);
    return { outcome: "already_consumed", ticket: submissionTicketView(consumed), receipt };
  }

  private releaseSubmissionTicket(input: SubmissionTicketCompletionRequest): void {
    const id = submissionTicketId(input.id), ticket = this.getSubmissionTicket(id);
    if (!ticket || ticket.state !== "claimed" || !ticket.claimId || ticket.claimId !== input.claimId) return;
    this.storeSubmissionTicket({ ...ticket, state: "ready", submissionSha256: null, claimId: null, claimedAtMs: null });
  }

  private getSubmissionTicket(id: string): PoolSubmissionTicket | null {
    const row = rows<{ ticket_json: string }>(this.sql.exec("SELECT ticket_json FROM pool_submission_tickets WHERE ticket_id = ?", id))[0];
    return row ? JSON.parse(row.ticket_json) : null;
  }

  private storeSubmissionTicket(ticket: PoolSubmissionTicket): void {
    this.sql.exec("INSERT OR REPLACE INTO pool_submission_tickets (ticket_id, ticket_json, expires_at_ms) VALUES (?, ?, ?)", ticket.id, JSON.stringify(ticket), ticket.expiresAtMs);
  }

  private poolTokenRefs(scope: "policies" | "tenants", scopeId: string, providerId: string): string[] {
    return rows<{ token_ref: string }>(this.sql.exec("SELECT token_ref FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? AND status IN ('legacy', 'active') ORDER BY token_ref LIMIT 32", scope, scopeId, providerId)).map((row) => row.token_ref);
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

interface AssignmentReconcileRequest { email: string; rules: AssignmentRuleEntry[]; legacy: Partial<AssignmentState> | null; evidence?: AssignmentEvidence; force: boolean }
interface UserBindingsRequest { user: AccessControlUser; policyIds: string[]; seed: Seed }
interface GrantPoolResolveRequest { policyId: string; tenantId: string; providerId: string; defaultKeys?: string[] }
export type GrantAttachmentStatus = "active" | "paused" | "reauth_required";
export interface GrantAttachmentSnapshot { generation: number; revision: number; pending: boolean; attached: boolean }
export interface GrantAttachmentResult extends GrantAttachmentSnapshot { outcome: "attached" | "detached" | "unattached" | "pending_cancelled" | "unresolved" }
interface GrantAttachmentMutation { key: string; generation: number; revision: number; admissionRevision?: number; provider: string | null; status: GrantAttachmentStatus | null; projection?: UpstreamGrant }
interface GrantRuntimeFeedbackRequest { key: string; state: GrantRuntimeState }
interface GrantRuntimeStatesRequest { keys: string[] }
interface GrantSelectionRecordRequest { records: Array<{ poolKey: string; key: string; count: number; lastMs: number; cursorKey?: string | null }> }

interface GrantPoolSelectRequest {
  poolKey: string;
  strategy: string;
  stickyHash?: string | null;
  switchAtUsedPercent?: number;
  hysteresisPercent?: number;
  candidates: Array<{ key: string; weight?: number; remainingRatio?: number | null }>;
}

export interface PoolSubmissionTicket {
  id: string;
  secretSha256: string;
  scope: "policies" | "tenants";
  scopeId: string;
  tokenRef: string;
  provider: string;
  kind: "api_key" | "oauth" | "subscription";
  label?: string | null;
  priority: number;
  weight: number;
  contributor?: string | null;
  keepWarm: boolean;
  createdAtMs: number;
  expiresAtMs: number;
  state: "ready" | "claimed" | "consumed";
  submissionSha256?: string | null;
  claimId?: string | null;
  claimedAtMs?: number | null;
  receipt?: SubmissionReceipt | null;
}

export type PoolSubmissionTicketView = Omit<PoolSubmissionTicket, "secretSha256" | "submissionSha256" | "claimId">;
export interface SubmissionReceipt { grantKey: string; submittedAt: string }
interface SubmissionTicketClaimRequest { id: string; secretSha256: string; submissionSha256: string }
interface SubmissionTicketCompletionRequest { id: string; claimId: string; receipt?: SubmissionReceipt }
export type SubmissionTicketClaimResult =
  | { outcome: "denied" }
  | { outcome: "expired" }
  | { outcome: "claimed"; ticket: PoolSubmissionTicketView; claimId: string }
  | { outcome: "already_consumed"; ticket: PoolSubmissionTicketView; receipt: SubmissionReceipt | null };

function grantSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || value.includes("/") || /[\u0000-\u001f\u007f]/.test(value)) invalidAuthorityRequest(`${field} must be a valid grant key segment`);
  return value;
}

function grantPoolScopeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function grantKey(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("oauth/") || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) invalidAuthorityRequest("grant key is invalid");
  return value;
}

function grantPoolIdentity(value: string): [string, string, string] {
  const parts = grantKey(value).split("/");
  if (parts.length === 4 && parts[1] === "tenants") return ["tenants", grantSegment(parts[2], "scopeId"), grantSegment(parts[3], "tokenRef")];
  if (parts.length === 3 && parts[1] !== "tenants") return ["policies", grantSegment(parts[1], "scopeId"), grantSegment(parts[2], "tokenRef")];
  return invalidAuthorityRequest("grant key is invalid");
}

function grantSelectionPoolKey(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) invalidAuthorityRequest("grant selection pool key is invalid");
  return value;
}

function normalizeSubmissionTicket(raw: PoolSubmissionTicket): PoolSubmissionTicket {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidAuthorityRequest("submission ticket is invalid");
  const id = submissionTicketId(raw.id);
  const secretSha256 = sha256Digest(raw.secretSha256);
  if (!secretSha256) invalidAuthorityRequest("submission ticket secret digest is invalid");
  if (raw.scope !== "policies" && raw.scope !== "tenants") invalidAuthorityRequest("submission ticket scope is invalid");
  const scopeId = grantSegment(raw.scopeId, "scopeId"), tokenRef = grantSegment(raw.tokenRef, "tokenRef"), provider = grantSegment(raw.provider, "provider");
  if (raw.scope === "policies" && scopeId === "tenants") invalidAuthorityRequest("submission ticket policy scope is invalid");
  if (!(["api_key", "oauth", "subscription"] as unknown[]).includes(raw.kind)) invalidAuthorityRequest("submission ticket grant kind is invalid");
  const priority = boundedInteger(raw.priority, "submission ticket priority", 0, 1_000_000);
  const weight = typeof raw.weight === "number" && Number.isFinite(raw.weight) && raw.weight > 0 && raw.weight <= 1_000_000 ? raw.weight : NaN;
  if (Number.isNaN(weight)) invalidAuthorityRequest("submission ticket weight is invalid");
  const now = Date.now();
  if (!Number.isSafeInteger(raw.createdAtMs) || !Number.isSafeInteger(raw.expiresAtMs) || raw.createdAtMs > now + 60_000 || raw.expiresAtMs <= now || raw.expiresAtMs > now + 24 * 60 * 60_000) invalidAuthorityRequest("submission ticket lifetime is invalid");
  const label = raw.label == null ? null : typeof raw.label === "string" && raw.label.length <= 256 ? raw.label : invalidAuthorityValue("submission ticket label is invalid");
  const contributor = raw.contributor == null ? null : typeof raw.contributor === "string" && raw.contributor.length <= 320 ? raw.contributor : invalidAuthorityValue("submission ticket contributor is invalid");
  const keepWarm = raw.keepWarm === true;
  return { id, secretSha256, scope: raw.scope, scopeId, tokenRef, provider, kind: raw.kind, label, priority, weight, contributor, keepWarm, createdAtMs: raw.createdAtMs, expiresAtMs: raw.expiresAtMs, state: "ready", submissionSha256: null, claimId: null, claimedAtMs: null, receipt: null };
}

function submissionTicketView(ticket: PoolSubmissionTicket): PoolSubmissionTicketView {
  const { secretSha256: _secret, submissionSha256: _submission, claimId: _claim, ...safe } = ticket;
  return safe;
}

function submissionTicketId(value: unknown): string {
  if (typeof value !== "string" || !/^pst_[A-Za-z0-9_-]{16,128}$/.test(value)) invalidAuthorityRequest("submission ticket id is invalid");
  return value;
}

function sha256Digest(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function normalizeSubmissionReceipt(value: unknown): SubmissionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidAuthorityRequest("submission receipt is invalid");
  const receipt = value as Partial<SubmissionReceipt>;
  const normalizedGrantKey = grantKey(receipt.grantKey);
  if (typeof receipt.submittedAt !== "string" || !Number.isFinite(Date.parse(receipt.submittedAt))) invalidAuthorityRequest("submission receipt timestamp is invalid");
  return { grantKey: normalizedGrantKey, submittedAt: new Date(receipt.submittedAt).toISOString() };
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalidAuthorityRequest(`${field} is invalid`);
  return value as number;
}

function invalidAuthorityValue(message: string): never {
  invalidAuthorityRequest(message);
}


export async function authorityCall<T>(env: Env, path: string, body: unknown, objectName = "policy-bindings", signal?: AbortSignal, wan?: WanManagedOperation, search?: MiniMaxSearchOperation): Promise<T> {
  const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(objectName));
  if (path === "/grant-search/authorize") {
    searchJsonBytes(body);
    const response = await stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body), signal, redirect: "manual", headers: { "content-type": "application/json" } });
    let input: InputRetirement | undefined;
    try {
      const result = await readSearchJson(response, signal ?? new AbortController().signal, "control", owner => { input = owner; });
      if (!response.ok) throw new HttpError(403, "access_admin_required", "Current administrator authority is required");
      return result as T;
    } finally { await input?.retired.catch(() => undefined); }
  }
  if (search) return search.controlJson<T>(body, (text, active) => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal: active, redirect: "manual", headers: { "content-type": "application/json", [searchControlHeader]: searchControlVersion } }), false, signal);
  if (wan) return wan.controlJson<T>(body, (text, active) => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal: active, redirect: "manual" }), false, signal);
  const response = await stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`authority ${path} failed (${response.status}): ${text}`);
  return text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as T : text as T;
}

export async function listPolicies(env: Env): Promise<AccessPolicyEntry[]> {
  const result = await authorityCall<{ initialized: boolean; policies: AccessPolicyEntry[] }>(env, "/policies/list", {});
  if (result.initialized) return result.policies;
  const policies = await listKvJson<Record<string, unknown>>(env, "policies/");
  const legacy = await listGenuineLegacyKeys(env);
  await authorityCall(env, "/policies/initialize-all", [
    ...policies.map(([key, value]) => ({ policyId: key.slice("policies/".length), policy: normalizePolicyRecord(value, contentRetentionDefault(env)) })),
    ...legacy.map(([policyId, value]) => ({ policyId, policy: normalizePolicyRecord(value, contentRetentionDefault(env)) })),
  ]);
  return (await authorityCall<{ policies: AccessPolicyEntry[] }>(env, "/policies/list", {})).policies;
}
export async function listCredentials(env: Env): Promise<ProxyCredentialEntry[]> {
  const result = await authorityCall<{ initialized: boolean; credentials: ProxyCredentialEntry[] }>(env, "/credentials/list", {});
  if (result.initialized) return result.credentials;
  const credentials = await listKvJson<Record<string, unknown>>(env, "credentials/");
  const legacy = await listGenuineLegacyKeys(env);
  await authorityCall(env, "/credentials/initialize-all", [
    ...credentials.map(([key, value]) => ({ credentialId: key.slice("credentials/".length), credential: normalizeCredentialRecord(value) })),
    ...legacy.map(([credentialId, value]) => ({ credentialId, credential: normalizeCredentialRecord(value, credentialId) })),
  ]);
  return (await authorityCall<{ credentials: ProxyCredentialEntry[] }>(env, "/credentials/list", {})).credentials;
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
  if (result.initialized || !result.missingPolicyIds.length) return result.policies;
  const seeded: AccessPolicyEntry[] = [];
  for (const policyId of result.missingPolicyIds) {
    const value = await env.POLICY_KV.get<Record<string, unknown>>(`policies/${policyId}`, "json") ?? await genuineLegacyKey(env, policyId);
    if (value) seeded.push({ policyId, policy: normalizePolicyRecord(value, contentRetentionDefault(env)) });
  }
  if (seeded.length) await authorityCall(env, "/policies/initialize", seeded);
  return (await authorityCall<typeof result>(env, "/policies/resolve", { policyIds: ids })).policies;
}
export async function resolveCredentials(env: Env, ids: string[]): Promise<ProxyCredentialEntry[]> {
  const result = await authorityCall<{ initialized: boolean; credentials: ProxyCredentialEntry[]; missingCredentialIds: string[] }>(env, "/credentials/resolve", { credentialIds: ids });
  if (result.initialized || !result.missingCredentialIds.length) return result.credentials;
  const seeded: ProxyCredentialEntry[] = [];
  for (const credentialId of result.missingCredentialIds) {
    const value = await env.POLICY_KV.get<Record<string, unknown>>(`credentials/${credentialId}`, "json") ?? await genuineLegacyKey(env, credentialId);
    if (value) seeded.push({ credentialId, credential: normalizeCredentialRecord(value, credentialId) });
  }
  if (seeded.length) await authorityCall(env, "/credentials/initialize", seeded);
  return (await authorityCall<typeof result>(env, "/credentials/resolve", { credentialIds: ids })).credentials;
}
export async function resolveUsers(env: Env, emails: string[]): Promise<AccessControlUser[]> {
  const result = await authorityCall<{ initialized: boolean; users: AccessControlUser[]; missingEmails: string[] }>(env, "/users/resolve", { emails });
  if (result.initialized || !result.missingEmails.length) return result.users;
  const seeded: AccessControlUser[] = [];
  for (const email of result.missingEmails) {
    const record = await env.POLICY_KV.get<AccessUserRecord>(`access/users/${email}`, "json");
    if (record) seeded.push({ email, record });
  }
  if (seeded.length) await authorityCall(env, "/users/initialize", seeded);
  return (await authorityCall<typeof result>(env, "/users/resolve", { emails })).users;
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
  return (await authorityCall<typeof result>(env, "/resolve", { principals })).bindings;
}
export async function resolveConnections(env: Env, providerIds: string[]): Promise<ProviderConnection[]> {
  const ids = [...new Set(providerIds)];
  const result = await authorityCall<{ initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] }>(env, "/connections/resolve", { providerIds: ids });
  if (result.initialized || !result.missingProviderIds.length) return result.connections;
  const seeded = (await Promise.all(result.missingProviderIds.map((id) => env.POLICY_KV.get<ProviderConnection>(`connections/${id}`, "json")))).filter(Boolean) as ProviderConnection[];
  if (seeded.length) await authorityCall(env, "/connections/initialize", seeded);
  return (await authorityCall<typeof result>(env, "/connections/resolve", { providerIds: ids })).connections;
}

export async function listConnections(env: Env, providerIds: string[]): Promise<ProviderConnection[]> {
  const ids = [...new Set(providerIds)];
  const result = await authorityCall<{ initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] }>(env, "/connections/resolve", { providerIds: ids });
  if (result.initialized) return result.connections;
  const seeded = (await Promise.all(result.missingProviderIds.map((id) => env.POLICY_KV.get<ProviderConnection>(`connections/${id}`, "json")))).filter(Boolean) as ProviderConnection[];
  await authorityCall(env, "/connections/initialize-all", seeded);
  return (await authorityCall<typeof result>(env, "/connections/resolve", { providerIds: ids })).connections;
}

export async function resolveConnection(env: Env, providerId: string, wan?: WanManagedOperation, search?: MiniMaxSearchOperation): Promise<ProviderConnection | null> {
  if (search) {
    const result = await authorityCall<{ connections: ProviderConnection[]; missingProviderIds: string[] }>(env, "/connections/resolve", { providerIds: [providerId] }, "policy-bindings", search.operation.signal, undefined, search);
    if (result.missingProviderIds.length || result.connections.length !== 1) searchUnavailable();
    return result.connections[0];
  }
  if (wan) {
    const result = await authorityCall<{ initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] }>(env,
      "/connections/resolve", { providerIds: [providerId] }, "policy-bindings", wan.controlSignal, wan);
    // Admission may initialize only this provider, without marking every
    // connection initialized. A present row is authoritative; never seed a miss.
    if (result.missingProviderIds.length) throw new Error("Wan requires an initialized original connection");
    return result.connections.find(connection => connection.providerId === providerId) ?? null;
  }
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

async function listGenuineLegacyKeys(env: Env): Promise<Array<[string, Record<string, unknown>]>> {
  return (await listKvJson<Record<string, unknown>>(env, "keys/")).flatMap(([key, value]) => {
    const id = key.slice("keys/".length);
    return id && !id.includes("/") && (value.generation == null || value.generation === "legacy") ? [[id, value]] : [];
  });
}

function normalizeCredentialRecord(value: Record<string, unknown>, legacyPolicyId?: string): ProxyCredentialEntry["credential"] {
  return {
    enabled: value.enabled !== false,
    secretSha256: typeof value.secretSha256 === "string" ? value.secretSha256.toLowerCase() : "",
    policyId: typeof value.policyId === "string" ? value.policyId : legacyPolicyId ?? "",
    policyGeneration: typeof value.policyGeneration === "string" ? value.policyGeneration : typeof value.generation === "string" ? value.generation : "legacy",
    principalId: typeof value.principalId === "string" ? value.principalId : null,
    ...(Object.hasOwn(value, "name") ? { name: storedCredentialName(value.name) } : {}),
    ...(Object.hasOwn(value, "serviceTiers") ? { serviceTiers: Array.isArray(value.serviceTiers) ? value.serviceTiers as string[] : null } : {}),
    ...(Object.hasOwn(value, "expiresAt") ? { expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null } : {}),
  };
}

function rows<T>(cursor: Iterable<T>): T[] { return [...cursor]; }
function principalKey(value: Principal): string { return `${value.principalType}:${value.principalId}`; }
function bindingKey(value: PolicyBinding): string { return `${value.principalType}:${value.principalId}:${value.policyId}`; }
function normalizePrincipal(value: Principal): Principal {
  const principalType = value.principalType;
  let principalId = value.principalId.trim().toLowerCase();
  if (principalType === "user") principalId = normalizeEmail(principalId) ?? "";
  if (!principalId || !["user", "group"].includes(principalType)) invalidAuthorityRequest("invalid policy binding principal");
  return { principalType, principalId };
}
function normalizeBinding(value: PolicyBinding): PolicyBinding {
  const principal = normalizePrincipal(value);
  if (!value.policyId?.trim()) invalidAuthorityRequest("policyId is required");
  return { ...principal, policyId: value.policyId.trim(), enabled: value.enabled ?? true, priority: value.priority ?? 100 };
}
function sortBindings(values: PolicyBinding[]): PolicyBinding[] {
  return values.map(normalizeBinding).sort((a, b) => a.priority - b.priority || a.principalType.localeCompare(b.principalType) || a.principalId.localeCompare(b.principalId) || a.policyId.localeCompare(b.policyId));
}

function invalidAuthorityRequest(message: string): never {
  throw new HttpError(400, "authority_error", message);
}
