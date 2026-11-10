import { admitGeneratedRuntime, planPrivateIdentityString, planPrivateRuntime, equalAdmissionJson, admitIdentityHeaders, foldIdentitySqlHistory, addIdentitySources, checkIdentitySourceAddition, canonicalFreshIdentityRouting, admitAdmission, admitIdentity, admitIdentityBytes, admitIdentityCount, identityFailure, identityHeader, identityVersion, identityJson, identityPlan, identitySourceBudget, identityUtf8, identitySqlRows, parseIdentity, readIdentityRequest, readIdentityResponse, type IdentitySourceBudget } from "./identity-admission.ts";
import { PolicyCollection, admitPolicyBindings, admitPolicyBytes, admitPolicyCall, admitPolicyIds, admitPolicyJson, admitPolicyPrincipals, isPolicyCollectionFailure, isPolicyCollectionPath, parsePolicyRecord, policyCandidatePlan, policyCollectionFailure, policyCollectionHeader, policyCollectionVersion, policyId, policyJsonText, policySequencePlan, policySourceBudget, readPolicyRequest, readPolicyResponse, type PolicySourceBudget } from "./policy-collection.ts";
import { videoControlVersion, videoControlHeader, videoControlBytes, videoJsonBytes, inspectVideoJson, type MiniMaxVideoOperation } from "./minimax-video-operation.ts";
import { effectiveBudgetPolicy } from "./budget-overrides.ts";
import { authorityAck, readAuthorityAck } from "./authority-ack-response.ts";
import { musicCoverControlHeader, musicCoverControlVersion, musicCoverUnavailable, isMusicCoverControl, readCoverControlRequest, type MiniMaxMusicCoverControl } from "./minimax-music-cover-control.ts";
import type { InputRetirement } from "./input-retirement.ts";
import type { SearchGrantAttestation, MusicGrantAttestation, VideoGrantAttestation } from "./authority-contracts.ts";
import { searchJsonBytes, searchUnavailable, searchControlBytes, inspectSearchJson, searchControlVersion, type MiniMaxSearchOperation, searchControlHeader, readSearchJson } from "./minimax-search-operation.ts";
import type { WanManagedOperation } from "./managed-media-json.ts";
import { normalizePrivatePolicyRecord, normalizePolicyRecord } from "./authority-policy.ts";
import { normalizePrivateUser, normalizeUser, profileUpdate } from "./authority-users.ts";
import { mutateBudgetCaps } from "./authority-budgets.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import { nextCredential } from "./credential-mutation.ts";
import { storedCredentialName } from "./credential-name.ts";
import { finishAdmissionSelection, privateAdmissionHashes, privateHashScratch } from "./authority-grant-selection.ts";
import { mergeGrantRuntimeState, normalizeGrantRuntimeState, normalizePrivateGrantRuntimeState } from "./grant-runtime.ts";
import type {
  AccessControlUser, AccessPolicy, AccessPolicyEntry, AccessUserRecord, Env, OAuthState, PolicyBinding,
  UpstreamGrant, AssignmentState, GrantRuntimeState, ProviderConnection, ProxyCredential, ProxyCredentialEntry,
} from "./types";
import { captureAssignmentRules, captureAdmittedAssignmentRules, prepareAssignmentRules, evaluatePreparedUserAssignments, withLegacyAssignmentState, withAdmittedLegacyAssignmentState, type AssignmentEvidence, type AssignmentRuleEntry } from "./assignment-evaluator.ts";
import type { AuthorizationSnapshot, AuthorizationSnapshotRequest, CredentialMutation, CredentialMutationResult } from "./authority-contracts.ts";
import { contentRetentionDefault } from "./content-retention.ts";
import { normalizeConnectionMutation, type ProviderConnectionMutation } from "./provider-connections.ts";
import type { ResponsesScopeStore } from "./responses-scope.ts";
import { privateGrantKey } from "./grant-routing.ts";
import { chooseOwnedGrantKey, consumeOwnedChoiceCandidates, chooseGrantKey, normalizedChoiceCandidates } from "./grant-selection-strategies.ts";
import { publishRoutingProjection } from "./grant-projection.ts";
import { errorResponse, HttpError, json, normalizeEmail, readJson, safeEqual } from "./utils.ts";
import { admitUserJson, admitUserRecordBytes, parseUserRecord, readUserKvRecord, readUserMaterializationRequest, userJsonText, userMaterializationFailure, userMaterializationHeader, userMaterializationVersion, userRecordBudget, type UserRecordBudget } from "./authority-user-materialization.ts";
import { readAuthorityUserResponse } from "./authority-user-response.ts";
import { admitAssignmentBytes, assignmentJsonText, assignmentSourceBudget, assignmentSourceFailure, assignmentSourceHeader, assignmentSourceVersion, isAssignmentSourceFailure, parseAssignmentSource, readAssignmentRequest, readAssignmentResponse } from "./assignment-source.ts";

type Principal = { principalType: "user" | "group"; principalId: string };
type Seed = { principal: Principal; bindings: PolicyBinding[] };
export type AdmissionJournalEntry =
  | { kind: "seed"; family: number; key: string; value: unknown; text: string; marker: string }
  | { kind: "projection"; key: string; text: string | null; legacy: number; revision: number; eligible: boolean }
  | { kind: "marker"; key: string }
  | { kind: "dependency"; key: string; revision: number; text: string | null; legacy: number }
  | { kind: "selection"; poolKey: string; selectedKey: string; cursorKey: string | null; nowMs: number; attempted: boolean };
const admissionSeedTables = [["proxy_credentials", "credential_id", "credential_json"], ["access_policies", "policy_id", "policy_json"],
  ["access_users", "email", "user_json"], ["provider_connections", "provider_id", "connection_json"]] as const;
type AuthorityReadBound = { bridge?: { ticket: PreflightTicket; entries: AdmissionJournalEntry[]; attempted: boolean; result?: AdmissionResult; prior?: AdmissionResult }; identity?: IdentitySourceBudget; staged?: Map<string, { value: unknown; marker: string }>; commit?: (() => void)[]; bytes: number; records?: number; video?: boolean;
  videoCounts?: { values: number; members: number; entries: number; units: number } };
function inspectVideoRecord(text: string, bound: AuthorityReadBound): void {
  const next = inspectVideoJson(text), total = bound.videoCounts ??= { values: 0, members: 0, entries: 0, units: 0 };
  for (const key of ["values", "members", "entries", "units"] as const) {
    total[key] += next[key];
    if (total[key] > (key === "units" ? 32768 : 512)) searchUnavailable();
  }
}

export const selfServiceCredentialLimit = 10;
const selfServiceCredentialRetentionLimit = 100;

export type { AdmissionProvider, AdmissionPool, AdmissionResult } from "./authority-admission.ts";
import { privateDefaultKeyParts, genuineLegacyKey, prepareCredentialPreflight, resolveAdmission, type AdmissionRequest, type AdmissionStore, type AdmissionResult, type AdmissionPool } from "./authority-admission.ts";

import { admitBridgeFactories, admissionGraphPayload, reserveAdmissionScratch, retireAdmissionScratch,
  type AdmissionScratchVector, PreflightInstanceArena, PreflightTicket } from "./credential-preflight-arena.ts";
import { checkPreflightIdentity, admissionContinuationHeader, admissionContinuationVersion, admissionContinuationPath, closeAdmissionEnvelope, credentialPreflightPath, type CredentialPreflightRequest,
  type CredentialPreflightReply } from "./credential-preflight-protocol.ts";
import { admissionBridgeReplyResponse, consumeAdmissionBridge, consumePreflightRequest, consumePreflightCredential, preflightReplyResponse } from "./credential-preflight-source.ts";

export class PolicyBindingIndexObject implements DurableObject {
  private sql: SqlStorage;
  private storage: DurableObjectStorage;
  private responses?: Promise<ResponsesScopeStore>;
  private preflightArena?: PreflightInstanceArena;
  private env: Env;
  // Reconciliation entry order only; unrelated owner routes remain concurrent.
  private assignmentTail: Promise<void> = Promise.resolve();
  private assignmentAdmissions = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = state.storage;
    this.sql = state.storage.sql;
    this.ensureSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" && !request.headers.has(userMaterializationHeader) && !request.headers.has(assignmentSourceHeader) && !request.headers.has(policyCollectionHeader)) return errorResponse("route_not_found", "route not found", 404);
    try {
      if (request.headers.has(policyCollectionHeader)) {
        // A private protocol selector, not authority or a public caller header.
        const input = await readPolicyRequest(request, path);
        try {
          if (path === "/resolve") return new Response(policyJsonText({ initialized: this.hasMeta("bindings_global_initialized"),
            ...this.resolveCollectedBindings((input as { principals: Principal[] }).principals) }), { headers: { "content-type": "application/json" } });
          if (path === "/policies/resolve") return new Response(policyJsonText(this.resolveCollectedPolicies((input as { policyIds: string[] }).policyIds)), { headers: { "content-type": "application/json" } });
          if (path === "/initialize") this.initializeCollectedBindings(input as Seed[]);
          else this.initializeCollectedPolicies(input as AccessPolicyEntry[] | { entries: AccessPolicyEntry[]; retainRequestContentDefault: boolean });
          return new Response("initialized");
        } catch (error) {
          if (isPolicyCollectionFailure(error)) throw error;
          // Query business errors keep the caller's sanitized generic-500 mapping;
          // initialization errors still cross the existing initialized ACK owner.
          throw policyCollectionFailure("protocol");
        }
      }
      if (request.headers.has(assignmentSourceHeader)) {
        // Reserve before acquiring the body. Fifth/invalid requests still own
        // their ORIGINAL body but cannot read or enter the semantic FIFO.
        const admitted = this.assignmentAdmissions < 4;
        if (admitted) this.assignmentAdmissions++;
        try {
          const input = await readAssignmentRequest(request, path, admitted) as AssignmentReconcileRequest;
          const text = await this.reconcileUserAssignments(input, true) as string;
          return new Response(text, { headers: { "content-type": "application/json; charset=utf-8" } });
        } catch (error) {
          const failure = isAssignmentSourceFailure(error) || error instanceof HttpError ? error : assignmentSourceFailure("protocol");
          return errorResponse(failure.code, failure.message, failure.status);
        } finally { if (admitted) this.assignmentAdmissions--; }
      }
      if (request.headers.has(userMaterializationHeader)) {
        const input = await readUserMaterializationRequest(request, path);
        try {
          if (path === "/users/resolve") {
            const result = { initialized: this.hasMeta("users_global_initialized"), ...this.resolveMaterializedUsers((input as { emails: string[] }).emails) };
            return new Response(userJsonText(result, "complete"), { headers: { "content-type": "application/json; charset=utf-8" } });
          }
          this.initializeMaterializedUsers(input as AccessControlUser[]);
          return new Response("initialized");
        } catch (error) {
          if (error instanceof HttpError && error.code === "user_materialization_unavailable") throw error;
          throw userMaterializationFailure("protocol");
        }
      }
      if (path === credentialPreflightPath && !request.headers.has(identityHeader)
        && !request.headers.has(musicCoverControlHeader) && !request.headers.has(searchControlHeader)
        && !request.headers.has(videoControlHeader)) {
        // No public/default admission caller. Only this private path owns the
        // compound ticket; existing specialized selectors retain precedence.
        const ticket = PreflightTicket.reserve(this.preflightArena ??= new PreflightInstanceArena());
        ticket.enter("operation");
        const operation = this.credentialPreflight(request, ticket);
        request = undefined as never;
        return await operation;
      }
      if (path === admissionContinuationPath && request.headers.has(admissionContinuationHeader)
        && !request.headers.has(identityHeader) && !request.headers.has(musicCoverControlHeader)
        && !request.headers.has(searchControlHeader) && !request.headers.has(videoControlHeader)) {
        admitBridgeFactories();
        const ticket = PreflightTicket.reserve(this.preflightArena ??= new PreflightInstanceArena());
        ticket.enter("operation");
        const operation = this.completePrivateAdmission(request, ticket);
        request = undefined as never;
        return await operation;
      }
      const identityPaths = ["/admission/resolve", "/grant-pools/resolve", "/grant-pools/select"];
      const identityInput = request.headers.has(identityHeader) ? await readIdentityRequest(request, identityPaths.includes(path)) : undefined;
      const identityBound: AuthorityReadBound | undefined = identityInput !== undefined ? { bytes: 0, identity: identitySourceBudget(), staged: new Map(), commit: [] } : undefined;
      const cover = request.headers.get(musicCoverControlHeader) === musicCoverControlVersion;
      if (cover && !["/admission/resolve", "/authorization/snapshot", "/connections/resolve"].includes(path)) musicCoverUnavailable();
      const coverInput = cover ? await readCoverControlRequest(request) : undefined;
      if (path === "/http-continuations") return await (await this.responseStore()).continuation(request);
      if (path === "/responses-background") return await (await this.responseStore()).fetch(request);
      if (path === "/grant-search/authorize") return json(this.authorizeSearchGrant(await readJson<SearchGrantAttestation>(request, undefined, 16 * 1024)));
      if (path === "/grant-music/authorize") return json(this.authorizeMusicGrant(await readJson<MusicGrantAttestation>(request, undefined, 16 * 1024)));
      if (path === "/grant-video/authorize") return json(this.authorizeVideoGrant(await readJson<VideoGrantAttestation>(request, undefined, 16 * 1024)));
      if (path === "/authorization/snapshot") {
        const input = (cover ? coverInput : await readJson<AuthorizationSnapshotRequest & { video?: string }>(request, undefined, 64 * 1024)) as AuthorizationSnapshotRequest & { video?: string };
        const bound: AuthorityReadBound | undefined = cover ? { bytes: 0 } : request.headers.get(videoControlHeader) === videoControlVersion || input.video === videoControlVersion ? { bytes: 0, video: true }
          : request.headers.get(searchControlHeader) === searchControlVersion ? { bytes: 0 } : undefined;
        const result = this.authorizationSnapshot(input, bound);
        if (bound) (bound.video ? videoJsonBytes : searchJsonBytes)(result); return json(result);
      }
      if (path === "/admission/resolve") {
        const input = (cover ? coverInput : identityBound ? identityInput : await readJson<AdmissionRequest>(request)) as AdmissionRequest;
        if (cover !== (input.cover === musicCoverControlVersion)) musicCoverUnavailable();
        const bound: AuthorityReadBound | undefined = cover ? { bytes: 0 } : input.video === videoControlVersion ? { bytes: 0, video: true } : input.search === searchControlVersion ? { bytes: 0 } : identityBound;
        const result = await resolveAdmission(this.env, input, this.admissionStore(bound));
        if (bound?.identity) {
          admitAdmission(result); const text = identityJson(result);
          for (const commit of bound.commit!) commit();
          return new Response(text, { headers: { "content-type": "application/json" } });
        }
        if (bound) (bound.video ? videoJsonBytes : searchJsonBytes)(result);
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
      if (path === "/users/reconcile-assignments") return json(await this.reconcileUserAssignments(await readJson<AssignmentReconcileRequest>(request)));
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
        const bound: AuthorityReadBound | undefined = cover ? { bytes: 0 } : request.headers.get(videoControlHeader) === videoControlVersion ? { bytes: 0, video: true }
          : request.headers.get(searchControlHeader) === searchControlVersion ? { bytes: 0 } : undefined;
        const input = (cover ? coverInput : await readJson<{ providerIds: string[] }>(request)) as { providerIds: string[] };
        if (bound && (input.providerIds.length !== 1 || input.providerIds[0] !== "minimax")) searchUnavailable();
        const result = this.resolveConnections(input.providerIds, bound); if (bound) (bound.video ? videoJsonBytes : searchJsonBytes)(result); return json(result);
      }
      if (path === "/connections/initialize") { this.initializeConnections(await readJson<ProviderConnection[]>(request)); return new Response("initialized"); }
      if (path === "/connections/initialize-all") { this.initializeConnections(await readJson<ProviderConnection[]>(request)); this.putMeta("connections_global_initialized"); return new Response("initialized"); }
      if (path === "/connections/put") return json(this.putConnection(await readJson<ProviderConnectionMutation>(request)));
      if (path === "/grant-pools/resolve") { const result = this.resolveGrantPool((identityBound ? identityInput : await readJson<GrantPoolResolveRequest>(request)) as GrantPoolResolveRequest, identityBound); return identityBound ? new Response(identityJson(result), { headers: { "content-type": "application/json" } }) : json(result); }
      if (path === "/grant-pools/attachment") return json(this.grantAttachment((await readJson<{ key: string }>(request)).key));
      if (path === "/grant-pools/admit") return json(this.admitGrantAttachment(await readJson<GrantAttachmentMutation>(request)));
      if (path === "/grant-pools/publish") return json(this.publishGrantAttachment(await readJson<GrantAttachmentMutation>(request)));
      if (path === "/grant-pools/cancel-pending") return json(this.cancelPendingAttachment(await readJson<{ key: string; revision: number }>(request)));
      if (path === "/grant-pools/pending") return json(this.pendingGrantAttachments(await readJson<{ cursor?: string; limit?: number }>(request)));
      if (path === "/grant-pools/feedback") { this.putGrantRuntime(await readJson<GrantRuntimeFeedbackRequest>(request)); return new Response("updated"); }
      if (path === "/grant-pools/states") return json({ states: this.grantRuntimeStates((await readJson<GrantRuntimeStatesRequest>(request)).keys) });
      if (path === "/grant-pools/select") { const result = this.selectGrant((identityBound ? identityInput : await readJson<GrantPoolSelectRequest>(request)) as GrantPoolSelectRequest, identityBound); return identityBound ? new Response(identityJson(result), { headers: { "content-type": "application/json" } }) : json(result); }
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

  private collectedPolicy(id: string, budget: PolicySourceBudget): AccessPolicyEntry | null {
    policyId(id);
    const meta = rows<{ bytes: number }>(this.sql.exec("SELECT length(CAST(policy_json AS BLOB)) AS bytes FROM access_policies WHERE policy_id = ?", id))[0];
    if (!meta) return null;
    admitPolicyBytes(budget, meta.bytes); // Metadata before full value materialization.
    const row = rows<{ policy_json: string }>(this.sql.exec("SELECT policy_json FROM access_policies WHERE policy_id = ?", id))[0];
    if (!row) throw policyCollectionFailure("protocol");
    return { policyId: id, policy: parsePolicyRecord(row.policy_json, budget) as AccessPolicy };
  }

  private resolveCollectedPolicies(ids: string[]): { initialized: boolean; policies: AccessPolicyEntry[]; missingPolicyIds: string[] } {
    admitPolicyIds(ids);
    const budget = policySourceBudget(), policies: AccessPolicyEntry[] = [], missingPolicyIds: string[] = [];
    const policyPlan = policySequencePlan(), missingPlan = policySequencePlan();
    for (const id of new Set(ids)) {
      const entry = this.collectedPolicy(id, budget);
      if (entry) { policyPlan(entry); policies.push(entry); } else { missingPlan(id); missingPolicyIds.push(id); }
    }
    const result = { initialized: this.hasMeta("policies_global_initialized"), policies, missingPolicyIds };
    admitPolicyJson(result); return result;
  }

  private initializeCollectedPolicies(input: AccessPolicyEntry[] | { entries: AccessPolicyEntry[]; retainRequestContentDefault: boolean }): void {
    if (this.hasMeta("policies_global_initialized")) return;
    const raw = !Array.isArray(input), entries = Array.isArray(input) ? input : input.entries;
    const budget = policySourceBudget(), staged = new Set<string>(), plan = policyCandidatePlan();
    const candidates: AccessPolicyEntry[] = [];
    const prepared: Array<{ policyId: string; text: string }> = [];
    for (const entry of entries) {
      policyId(entry.policyId);
      // Canonical current records win before normalization of an ignored seed.
      // A malformed existing JSON row still fails the complete preflight.
      const current = this.collectedPolicy(entry.policyId, budget);
      if (current || staged.has(entry.policyId)) continue;
      if (!entry.policyId) invalidAuthorityRequest("policyId is required");
      admitPolicyJson(entry.policy);
      plan(entry.policyId, entry.policy, raw ? (input as { retainRequestContentDefault: boolean }).retainRequestContentDefault : undefined);
      candidates.push(entry); staged.add(entry.policyId);
    }
    // The COMPLETE prospective batch is admitted before even the first
    // providers.filter/models Set/routing copy in the unchanged normalizer.
    const actualPlan = policySequencePlan();
    for (const entry of candidates) {
      const policy = raw ? normalizePolicyRecord(entry.policy as unknown as Record<string, unknown>, (input as { retainRequestContentDefault: boolean }).retainRequestContentDefault) : entry.policy;
      if (raw) {
        // Only fresh normalizer dictionaries: __proto__ consumed its quota but
        // created no own JSON field. Preserve those bytes without touching seeds.
        const routing = policy.grantRouting;
        if (Array.isArray(Object.getPrototypeOf(routing.eligibleGrants))) Object.setPrototypeOf(routing.eligibleGrants, Object.prototype);
        if (Object.hasOwn(routing, "sharedGrants") && Array.isArray(Object.getPrototypeOf(routing.sharedGrants!))) Object.setPrototypeOf(routing.sharedGrants!, Object.prototype);
      }
      actualPlan({ policyId: entry.policyId, policy });
      prepared.push({ policyId: entry.policyId, text: policyJsonText(policy) });
    }
    // All candidate validation, complete-batch accounting and serialization finish
    // before the first write. SQL failure retains the existing partial-commit risk.
    for (const entry of prepared) this.sql.exec("INSERT OR REPLACE INTO access_policies (policy_id, policy_json) VALUES (?, ?)", entry.policyId, entry.text);
  }

  private resolveCollectedBindings(principals: Principal[]): { bindings: PolicyBinding[]; missingPrincipals: Principal[] } {
    admitPolicyPrincipals(principals);
    const budget = policySourceBudget(), bindings: PolicyBinding[] = [], missingPrincipals: Principal[] = [];
    const plan = policySequencePlan(), missingPlan = policySequencePlan();
    let count = 0;
    for (const raw of principals) {
      const principal = normalizePrincipal(raw); policyId(principal.principalId);
      const key = principalKey(principal);
      if (!this.hasPrincipal(key)) { missingPlan(principal); missingPrincipals.push(principal); continue; }
      const meta = rows<{ count: number; bytes: number }>(this.sql.exec("SELECT count(*) AS count, coalesce(sum(length(CAST(binding_json AS BLOB))), 0) AS bytes FROM policy_binding_entries WHERE principal_key = ?", key))[0];
      if (!meta || !Number.isSafeInteger(meta.count) || meta.count < 0 || meta.count > 4096 - count) throw policyCollectionFailure("limit");
      count += meta.count; admitPolicyBytes(budget, meta.bytes);
      for (const row of this.sql.exec<{ binding_json: string }>("SELECT binding_json FROM policy_binding_entries WHERE principal_key = ?", key)) {
        const value = parsePolicyRecord(row.binding_json, budget, true) as PolicyBinding;
        // Full stored unknown graph is counted before the old binding projection.
        policyId(value?.principalId); policyId(value?.policyId);
        const binding = normalizeBinding(value); plan(binding); bindings.push(binding);
      }
    }
    // Normalized once, with exactly the original stable comparator/tie behavior.
    bindings.sort((a, b) => a.priority - b.priority || a.principalType.localeCompare(b.principalType) || a.principalId.localeCompare(b.principalId) || a.policyId.localeCompare(b.policyId));
    const result = { bindings, missingPrincipals }; admitPolicyJson(result); return result;
  }

  private initializeCollectedBindings(seeds: Seed[]): void {
    if (this.hasMeta("bindings_global_initialized")) return;
    const staged = new Set<string>(), plan = policySequencePlan();
    const prepared: Array<{ key: string; writes: Array<{ key: string; text: string }> }> = [];
    for (const seed of seeds) {
      const principal = normalizePrincipal(seed.principal); policyId(principal.principalId);
      const key = principalKey(principal);
      if (this.hasPrincipal(key) || staged.has(key)) continue;
      const normalized: PolicyBinding[] = [], rowPlan = policySequencePlan();
      for (const raw of seed.bindings) {
        // Preserve RAW principal-match filtering before normalization. Duplicate
        // binding keys are written in their original order, including last wins.
        if (raw.principalType !== principal.principalType || raw.principalId !== principal.principalId) continue;
        const binding = normalizeBinding(raw); rowPlan(binding); normalized.push(binding);
      }
      plan({ principal, bindings: normalized });
      const writes = normalized.map(binding => ({ key: bindingKey(binding), text: policyJsonText(binding) }));
      prepared.push({ key, writes }); staged.add(key);
    }
    for (const seed of prepared) {
      for (const binding of seed.writes) {
        this.sql.exec("INSERT OR REPLACE INTO policy_binding_entries (principal_key, binding_key, binding_json) VALUES (?, ?, ?)", seed.key, binding.key, binding.text);
        this.sql.exec("INSERT OR IGNORE INTO policy_binding_principals (principal_key) VALUES (?)", seed.key);
      }
      this.sql.exec("INSERT OR IGNORE INTO policy_binding_principals (principal_key) VALUES (?)", seed.key);
    }
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

  private admissionStore(bound?: AuthorityReadBound): AdmissionStore {
    const getUser = (id: string) => this.getUser(id, bound);
    return {
        identity: bound?.identity,
        privatePrincipal: bound?.bridge ? value => this.privatePrincipal(bound, value) : undefined,
        privateResult: bound?.bridge ? result => { bound.bridge!.result = result; } : undefined,
        privatePool: bound?.bridge ? (provider, policyId, tenantId) => this.resolveGrantPool({ providerId: provider.id, policyId, tenantId }, bound, { tokenRef: provider.tokenRef }) : undefined,
        readPrivate: bound?.bridge ? <T>(key: string) => this.privateReadRecord<T>(bound, key) : undefined,
        getCredential: id => this.getCredential(id, bound), getPolicy: id => this.getPolicy(id, bound), getUser, hasMeta: key => this.hasMeta(key),
        seedCredential: (id, value) => {
          if (!bound?.identity) return this.initializeCredentials([{ credentialId: id, credential: normalizeCredentialRecord(value, id) }]);
          if (this.getCredential(id, bound) || this.hasMeta("credentials_global_initialized")) return;
          let credential: ProxyCredentialEntry["credential"];
          if (bound.bridge) credential = this.privateCloneRecord(bound, value, () => {
            const { copilotPublicIdentity: _untrusted, ...record } = normalizeCredentialRecord(value, id); return record;
          });
          else { const { copilotPublicIdentity: _untrusted, ...record } = normalizeCredentialRecord(value, id); credential = record; }
          if (bound?.identity) this.stageIdentityRecord(bound, "proxy_credentials", "credential_id", "credential_json", id, credential, "credentials_global_initialized");
          else this.initializeCredentials([{ credentialId: id, credential }]);
        },
        seedPolicy: (id, value) => {
          if (!bound?.identity) return this.initializePolicies([{ policyId: id, policy: normalizePolicyRecord(value, contentRetentionDefault(this.env)) }]);
          if (this.getPolicy(id, bound) || this.hasMeta("policies_global_initialized")) return;
          const policy = bound.bridge ? this.privateControlPhase(bound, () => this.privateGeneratedRecord(bound, value, admit => normalizePrivatePolicyRecord(value, contentRetentionDefault(this.env), admit)))
            : normalizePolicyRecord(value, contentRetentionDefault(this.env));
          canonicalFreshIdentityRouting(policy.grantRouting);
          if (bound?.identity) this.stageIdentityRecord(bound, "access_policies", "policy_id", "policy_json", id, policy, "policies_global_initialized");
          else this.initializePolicies([{ policyId: id, policy }]);
        },
        initializeUsers: users => {
          if (!bound?.identity) return this.initializeUsers(users);
          if (this.hasMeta("users_global_initialized")) return;
          for (const raw of users) if (!this.getUser(raw.email, bound)) {
            const user = bound.bridge ? this.privateControlPhase(bound, () => this.privateGeneratedRecord(bound, raw, admit => normalizePrivateUser(raw, admit))) : normalizeUser(raw);
            this.stageIdentityRecord(bound, "access_users", "email", "user_json", user.email, user.record, "users_global_initialized");
          }
        },
        initializeConnections: connections => {
          if (!bound?.identity) return this.initializeConnections(connections);
          if (this.hasMeta("connections_global_initialized")) return;
          for (const raw of connections) if (!this.getConnection(raw.providerId, bound)) {
            const connection = bound.bridge ? this.privateCloneRecord(bound, raw, () => ({ enabled: true, label: null, monthlyBudgetMicros: null, ...normalizeConnectionMutation(raw, raw.providerId) }))
              : { enabled: true, label: null, monthlyBudgetMicros: null, ...normalizeConnectionMutation(raw, raw.providerId) };
            this.stageIdentityRecord(bound, "provider_connections", "provider_id", "connection_json", connection.providerId, connection, "connections_global_initialized");
          }
        },
        resolveConnections: ids => this.resolveConnections(ids, bound), putMeta: key => { if (bound?.bridge) { this.appendAdmissionJournal(bound); this.appendAdmissionJournal(bound, { kind: "marker", key }); } else if (bound?.identity) bound.commit!.push(() => this.putMeta(key)); else this.putMeta(key); }, resolveGrantPool: input => this.resolveGrantPool(input, bound), finishSelection: (input, result) => finishAdmissionSelection(this.env, this.storage, input, result, {
          identity: bound?.identity,
          privateBridge: bound?.bridge ? { choice: run => this.privateControlPhase(bound, run), scratch: (vector, run, retained) => this.privateScratchPhase(bound, vector, run, retained), materialize: (bytes, run) => this.privateSqlValue(bound, bytes, run), current: result => { bound.bridge!.prior = bound.bridge!.result; bound.bridge!.result = result; }, hashes: identity => this.privateHashPhase(bound, identity), connections: providers => this.resolvePrivateProviderConnections(providers, bound), pool: (input, tokenRef) => this.resolveGrantPool(input, bound, { tokenRef }), read: key => this.privateReadRecord<UpstreamGrant>(bound, key), stage: entry => this.appendAdmissionJournal(bound, entry), projection: key => bound.bridge!.entries.find((entry): entry is Extract<AdmissionJournalEntry, { kind: "projection" }> => entry.kind === "projection" && entry.key === key) } : undefined, afterAdmission: action => bound!.commit!.push(action),
          getCredential: id => this.getCredential(id, bound), getPolicy: id => this.getPolicy(id, bound), getUser,
          resolveConnections: ids => this.resolveConnections(ids, bound), resolveGrantPool: request => this.resolveGrantPool(request, bound),
          grantAttachment: key => this.grantAttachment(key, !!bound?.bridge), consumeProjectionBytes: (bytes, text) => { if (bound && (bound.bytes += bytes) > (bound.video ? videoControlBytes : searchControlBytes)) searchUnavailable(); if (bound?.video && text !== undefined) inspectVideoRecord(text, bound); },
          selectGrant: request => this.selectGrant(request, bound), selectionState: poolKey => this.selectionState(poolKey, bound), planGrant: request => this.planGrant(request, bound),
        }),
        };
  }

  private privateControlPhase<T>(bound: AuthorityReadBound, run: () => T): T {
    // Original reads/hash roots have settled and their source owners cleared.
    // Synchronous normalization/choice reuse the SAME precharged windows.
    const ticket = bound.bridge!.ticket; ticket.enter("source");
    try { ticket.enter("read"); try { return run(); } finally { ticket.leave("read"); } }
    finally { ticket.leave("source"); }
  }

  private async privateReadRecord<T>(bound: AuthorityReadBound, key: string): Promise<T | null> {
    const source = bound.identity!, bytes = Math.min(1048576, 2097152 - source.bytes), text = Math.min(1048576, 2097152 - source.text);
    const vector = { C: 1 + Math.min(16384, 32768 - source.containers),
      P: 8192 + 2 * Math.min(32768, 65536 - source.members) + Math.min(16384, 32768 - source.entries),
      N: Math.min(65536, 131072 - source.values),
      U: 2 * text + Math.min(1048576, 2097152 - source.units) + 16384,
      B: bytes + 16384 };
    // The 8192 fixed wire views keep their existing separate DATA channel. They
    // are not passive containers or CONTROL objects reclassified by this policy.
    const lease = reserveAdmissionScratch(bound.bridge!.ticket, this.privatePayloadBase(bound) + 8192 * 8, vector);
    let result: T | null | undefined, completed = false;
    try {
      result = await consumeAdmissionBridge(bound.bridge!.ticket, () => this.env.POLICY_KV.get(key, "stream"), source, "record", value => value as T);
      const plan = identityPlan("record"); plan.item(result, 0);
      // ORIGINAL acquisition/read/FIRSTcancel/unlock have all joined. Transfer
      // only the returned parsed graph; wire/text/decoder/backing aliases cleared.
      lease.retain({ C: plan.counts.containers, P: 2 * plan.counts.members + plan.counts.entries,
        N: plan.counts.values, U: plan.counts.units, B: 0 }); completed = true;
      return result;
    } finally { result = undefined; key = ""; if (!completed) lease.retire(); }
  }

  private privateSqlValue<T>(bound: AuthorityReadBound, bytes: number, run: () => T, complete = false): T {
    const source = bound.identity!, maximum = complete ? 2097152 : 1048576;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) throw identityFailure("limit");
    // Metadata is already admitted. Fund the ORIGINAL SQL text and the largest
    // remaining parsed graph before SELECT materializes any value. Returned
    // graphs keep their residue through the final decision/commit clear boundary.
    const vector = { C: 2 + Math.min(complete ? 32768 : 16384, 32768 - source.containers),
      P: 4 + 2 * Math.min(complete ? 65536 : 32768, 65536 - source.members)
        + Math.min(complete ? 32768 : 16384, 32768 - source.entries),
      N: 2 + Math.min(complete ? 131072 : 65536, 131072 - source.values),
      U: bytes + Math.min(maximum, 2097152 - source.units) + 1024, B: 0 };
    const lease = reserveAdmissionScratch(bound.bridge!.ticket, this.privatePayloadBase(bound), vector);
    let residue: AdmissionScratchVector | undefined;
    try {
      const result = run(), plan = identityPlan(); plan.item(result, 0);
      residue = { C: plan.counts.containers, P: 2 * plan.counts.members + plan.counts.entries,
        N: plan.counts.values, U: plan.counts.units, B: 0 };
      return result;
    } finally {
      run = undefined as never;
      if (residue) { try { lease.retain(residue); } catch (error) { residue = undefined; lease.retire(); throw error; } }
      else lease.retire();
    }
  }

  private privateCloneRecord<T>(bound: AuthorityReadBound, raw: unknown, run: () => T): T {
    const plan = identityPlan("record"); plan.item(raw, 0);
    // Shallow normalizer/rest copies borrow nested source objects. Fields and
    // every string occurrence (including both derived transforms) remain funded.
    return this.privateScratchPhase(bound, { C: 2, P: 4 * (plan.counts.members + 32),
      N: 2 * plan.counts.values + 64, U: 2 * plan.counts.units + 2 * plan.counts.bytes + 64, B: 0 }, run, true);
  }

  private privateGeneratedRecord<T>(bound: AuthorityReadBound, raw: unknown,
    run: (admit: (emit: (plan: ReturnType<typeof identityPlan>) => void) => void) => T, profile: "record" | "complete" = "record"): T {
    const input = identityPlan("record"); input.item(raw, 0);
    // Two bounded scalar/rest copies plus the fixed publication/retention/tariff
    // readers. Unknown nested input objects remain borrowed under this ticket.
    const fixed = { C: 2 * input.counts.containers + 145,
      P: 2 * (2 * input.counts.members + input.counts.entries) + 824,
      N: 2 * input.counts.values + 132,
      U: 2 * input.counts.units + 1048576 + 4 * 65536, B: 0 };
    const lease = reserveAdmissionScratch(bound.bridge!.ticket, this.privatePayloadBase(bound), fixed);
    let output = { C: 0, P: 0, N: 0, U: 0, B: 0 }, outputBytes = 0, completed = false;
    try {
      const result = run(emit => {
        const plan = identityPlan(profile); emit(plan);
        const next = { C: plan.counts.containers, P: 2 * plan.counts.members + plan.counts.entries,
          N: plan.counts.values, U: plan.counts.units, B: 0 };
        const bytes = admissionGraphPayload(plan.counts);
        if (bytes > outputBytes) { output = next; outputBytes = bytes; }
        lease.admit({ C: fixed.C + output.C, P: fixed.P + output.P, N: fixed.N + output.N, U: fixed.U + output.U, B: 0 });
      });
      // Fixed funded fields include the user's normalized email and outer
      // wrapper, which the record-only prospective visitor intentionally omits.
      // Transfer the entire actual return graph, not only its inner record.
      const returned = identityPlan(); returned.item(result, 0);
      output = { C: returned.counts.containers, P: 2 * returned.counts.members + returned.counts.entries,
        N: returned.counts.values, U: returned.counts.units, B: 0 };
      completed = true; return result;
    } finally {
      raw = undefined; run = undefined as never;
      if (completed) { try { lease.retain(output); } catch (error) { lease.retire(); throw error; } }
      else lease.retire();
    }
  }

  private privatePayloadBase(bound: AuthorityReadBound): number {
    // Source is cumulative, so this intentionally retains credit for already
    // cleared source graphs too. It never turns source counters into new credit.
    let base = admissionGraphPayload(bound.identity!);
    const journal = bound.bridge!;
    if (journal.result) {
      const plan = identityPlan(); plan.item(journal.result, 0);
      base += admissionGraphPayload(plan.counts);
    }
    if (journal.prior) {
      const plan = identityPlan(); plan.item(journal.prior, 0);
      base += admissionGraphPayload(plan.counts);
    }
    for (const entry of journal.entries) {
      base += 2 * (entry.kind.length + (entry.kind === "selection" ? entry.poolKey.length + entry.selectedKey.length + (entry.cursorKey?.length ?? 0) : entry.key.length));
      if (entry.kind === "seed") {
        const plan = identityPlan("record"); plan.item(entry.value, 0);
        base += admissionGraphPayload(plan.counts) + 2 * (entry.text.length + entry.marker.length);
      } else if (entry.kind === "projection") base += 2 * (entry.text?.length ?? 0);
      else if (entry.kind === "dependency") base += 16 + 2 * (entry.text?.length ?? 0);
    }
    return base;
  }

  private privateScratchPhase<T>(bound: AuthorityReadBound, vector: AdmissionScratchVector, run: () => T, retained = false): T {
    const lease = reserveAdmissionScratch(bound.bridge!.ticket, this.privatePayloadBase(bound), vector);
    let completed = false;
    try { const value = run(); completed = true; return value; }
    finally {
      // Only closed synchronous consumers use retire. Returning passive data
      // uses retain until the final journal/result/request alias clear boundary.
      if (retained && completed) lease.retain(); else lease.retire();
    }
  }

  private async privateHashPhase(bound: AuthorityReadBound, identity: string): Promise<[string, string]> {
    const lease = reserveAdmissionScratch(bound.bridge!.ticket, this.privatePayloadBase(bound), privateHashScratch(identity));
    let completed = false;
    try {
      const operation = privateAdmissionHashes(identity); identity = "";
      const hashes = await operation; completed = true; return hashes;
    } finally {
      identity = "";
      // BOTH originals have settled; only the two hex results/tuple escape.
      // Transfer their funded residue atomically until final owner clear.
      if (completed) lease.retain({ C: 1, P: 2, N: 0, U: 128, B: 0 });
      else lease.retire();
    }
  }

  private appendAdmissionJournal(bound: AuthorityReadBound, entry?: AdmissionJournalEntry): void {
    const journal = bound.bridge!;
    if (journal.attempted) throw identityFailure("limit");
    if (entry?.kind === "dependency") {
      // A projection and its final-choice dependency use the SAME bounded
      // journal slot. An earlier observed dependency is never overwritten.
      for (let index = 0; index < journal.entries.length; index++) {
        const current = journal.entries[index];
        if ((current.kind !== "projection" && current.kind !== "dependency") || current.key !== entry.key) continue;
        if (current.kind === "projection" && !current.eligible) {
          // A canonical publication won before this candidate was observed.
          // Its unpublishable text is dropped; its funding stays held. Record
          // the observed dependency even when the revision happens to match.
          journal.entries[index] = entry;
        }
        return;
      }
    }
    if (journal.entries.length >= 231) throw identityFailure("limit");
    if (entry) journal.entries.push(entry);
  }

  private executeAdmissionJournal(bound: AuthorityReadBound): void {
    const journal = bound.bridge!;
    if (journal.attempted) throw identityFailure("protocol");
    // Set before the FIRST effect. SQL errors can leave earlier effects; neither
    // this journal nor its selection entry can replay or promise compensation.
    journal.attempted = true;
    for (const entry of journal.entries) {
      if (entry.kind === "seed") {
        const [table, keyColumn, column] = admissionSeedTables[entry.family];
        rows(this.sql.exec(`INSERT INTO ${table} (${keyColumn}, ${column}) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${keyColumn} = ?) AND NOT EXISTS (SELECT 1 FROM policy_binding_meta WHERE meta_key = ?)`, entry.key, entry.text, entry.key, entry.marker));
      } else if (entry.kind === "marker") this.putMeta(entry.key);
      else if (entry.kind === "dependency") continue; // final validation only; never an SQL effect
      else if (entry.kind === "projection") {
        if (entry.eligible && this.grantAttachment(entry.key, true).revision === entry.revision) rows(this.sql.exec("INSERT OR IGNORE INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, ?, ?)", entry.key, entry.text, entry.legacy));
      } else {
        if (entry.attempted) throw identityFailure("protocol");
        entry.attempted = true;
        if (entry.cursorKey) rows(this.sql.exec("INSERT OR REPLACE INTO upstream_grant_pool_cursors (pool_key, grant_key) VALUES (?, ?)", entry.poolKey, entry.cursorKey));
        rows(this.sql.exec("INSERT INTO upstream_grant_selection (pool_key, grant_key, selected_count, last_selected_ms) VALUES (?, ?, 1, ?) ON CONFLICT (pool_key, grant_key) DO UPDATE SET selected_count = selected_count + 1, last_selected_ms = excluded.last_selected_ms RETURNING selected_count", entry.poolKey, entry.selectedKey, entry.nowMs));
      }
    }
  }

  private privateProjectionCurrent(bound: AuthorityReadBound,
    entry: Extract<AdmissionJournalEntry, { kind: "dependency" | "projection" }>): boolean {
    // SAME-generation publications can change the full projection without a
    // revision change. Meter this ORIGINAL final reread, metadata before value.
    const size = rows<{ bytes: number | null; legacy: number }>(this.sql.exec(
      "SELECT length(CAST(projection_json AS BLOB)) AS bytes, legacy FROM upstream_grant_projections WHERE grant_key = ?", entry.key))[0];
    if (!size) return entry.kind === "projection"; // still-owned absent staged row
    if (size.legacy !== entry.legacy || (size.bytes === null) !== (entry.text === null)) return false;
    if (size.bytes === null) return true;
    admitIdentityBytes(bound.identity!, size.bytes);
    return this.privateSqlValue(bound, size.bytes, () => {
      const row = rows<{ projection_json: string | null; legacy: number }>(this.sql.exec(
        "SELECT projection_json, legacy FROM upstream_grant_projections WHERE grant_key = ?", entry.key))[0];
      if (!row || row.projection_json === null) throw identityFailure("protocol");
      parseIdentity(row.projection_json, bound.identity!); // full cumulative source, including discarded fields
      return row.legacy === entry.legacy && row.projection_json === entry.text;
    });
  }

  private finalPrivateAdmission(input: AdmissionRequest, prior: AdmissionResult, bound: AuthorityReadBound): AdmissionResult {
    // AFTER the last await. The canonical, pool and projection segments are
    // synchronous and sequential; resolveGrantPool owns its own windows.
    const ticket = bound.bridge!.ticket, same = equalAdmissionJson;
    let credential: ProxyCredentialEntry | null = null, policy: AccessPolicyEntry | null = null;
    let owner: AccessControlUser | null = null, fresh: AdmissionResult;
    let routingCurrent = false, permitted = false;
    ticket.enter("source");
    try { ticket.enter("read"); try {
      credential = this.getCredential(input.credentialId, bound);
      const secretMatches = !!credential && !!input.secretSha256 && safeEqual(input.secretSha256.toLowerCase(), credential.credential.secretSha256.toLowerCase());
      policy = secretMatches ? this.getPolicy(credential!.credential.policyId, bound) : null;
      const principal = policy && credential?.credential.enabled && !credentialExpired(credential.credential) && policy.policy.enabled && credential.credential.policyGeneration === policy.policy.generation ? credential.credential.principalId : null;
      owner = principal ? this.getUser(principal, bound) : null;
      fresh = { ...prior, credential, policy, owner };
      bound.bridge!.prior = prior; bound.bridge!.result = fresh;
      routingCurrent = same(credential, prior.credential) && same(policy, prior.policy) && same(owner, prior.owner);
      permitted = !!(policy && credential && input.secretSha256 && safeEqual(input.secretSha256, credential.credential.secretSha256)
        && credential.credential.enabled && !credentialExpired(credential.credential) && policy.policy.enabled
        && credential.credential.policyGeneration === policy.policy.generation && owner?.record.enabled !== false);
      if (permitted) {
        fresh.connections = this.resolvePrivateProviderConnections(input.providers ?? [], bound,
          input.allConnections ? undefined : policy!.policy.providers);
        routingCurrent &&= same(fresh.connections, prior.connections);
        fresh.pools = {};
      } else { fresh.connections = []; fresh.pools = {}; routingCurrent = false; }
    } finally { ticket.leave("read"); } }
    finally { ticket.leave("source"); }

    if (permitted && policy) for (const provider of input.providers ?? []) {
      if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id)) continue;
      // Outer function/loop frames stay charged; their windows are idle here.
      const pool = this.resolveGrantPool({ providerId: provider.id, policyId: policy.policyId, tenantId: policy.policy.tenantId ?? "default" },
        bound, { tokenRef: provider.tokenRef });
      ticket.enter("source");
      try { ticket.enter("read"); try {
        fresh.pools[provider.id] = pool;
        routingCurrent &&= same(pool, prior.pools[provider.id]);
      } finally { ticket.leave("read"); } }
      finally { ticket.leave("source"); }
    }

    ticket.enter("source");
    try { ticket.enter("read"); try {
      // Every observed projection, including unselected/snapshot-only, is
      // compared at this final synchronous boundary before any journal effect.
      for (const entry of bound.bridge!.entries) if (entry.kind === "dependency" || entry.kind === "projection" && entry.eligible) {
        const current = this.grantAttachment(entry.key, true);
        if (current.revision !== entry.revision || !this.privateProjectionCurrent(bound, entry)) routingCurrent = false;
      }
      if (prior.selection?.selected) {
        const selected = prior.selection.selected;
        routingCurrent &&= this.grantAttachment(selected.key, true).revision === selected.authorityRevision;
      }
      if (!routingCurrent) {
        delete fresh.selection; delete fresh.snapshots;
        for (let i = bound.bridge!.entries.length - 1; i >= 0; i--) if (bound.bridge!.entries[i].kind === "selection") bound.bridge!.entries.splice(i, 1);
      }
    } finally { ticket.leave("read"); } }
    finally { ticket.leave("source"); }
    return fresh;
  }

  private async completePrivateAdmission(request: Request | undefined, ticket: PreflightTicket): Promise<Response> {
    let envelope: ReturnType<typeof closeAdmissionEnvelope<AdmissionRequest>> | null | undefined;
    let result: AdmissionResult | undefined, bound: AuthorityReadBound | undefined, text: string | undefined;
    let handedOff = false, signal = request?.signal;
    try {
      const intake = identitySourceBudget();
      envelope = await consumeAdmissionBridge(ticket, () => Promise.resolve(request?.body ?? null), intake, "complete", closeAdmissionEnvelope<AdmissionRequest>, request?.signal, () => {
        if (!request || request.method !== "POST" || request.headers.get(admissionContinuationHeader) !== admissionContinuationVersion) throw identityFailure("protocol");
        admitIdentityHeaders(request.headers);
      }, "continuation");
      request = undefined;
      if (!envelope) throw identityFailure("protocol");
      checkPreflightIdentity(envelope.admission.credentialId, envelope.admission.secretSha256);
      if (envelope.admission.cover !== undefined || envelope.admission.video !== undefined || envelope.admission.search !== undefined) throw identityFailure("protocol");
      envelope.source = addIdentitySources(envelope.source, intake);
      bound = { bytes: 0, identity: envelope.source, bridge: { ticket, entries: [], attempted: false } };
      result = await resolveAdmission(this.env, envelope.admission, this.admissionStore(bound));
      bound.bridge!.prior = undefined; bound.bridge!.result = result;
      if (signal?.aborted) throw identityFailure("transport");
      text = this.storage.transactionSync(() => {
        result = this.finalPrivateAdmission(envelope!.admission, result!, bound!);
        admitAdmission(result);
        const reply = { admission: result, source: envelope!.source };
        const plan = identityPlan(); plan.item(reply, 0);
        // Prospective actual consumer allowance BEFORE any deferred effect. Sent
        // counters are replaced once by producer cumulative + actual reply read.
        checkIdentitySourceAddition(envelope!.source, plan.counts);
        return this.privateScratchPhase(bound!, { C: 0, P: 0, N: 0, U: plan.counts.text, B: 0 }, () => {
          const serialized = JSON.stringify(reply);
          this.executeAdmissionJournal(bound!);
          return serialized;
        }, true);
      });
      bound.bridge!.entries.length = 0; bound = undefined; result = undefined; envelope = undefined; signal = undefined;
      const response = admissionBridgeReplyResponse(ticket, text); text = undefined; handedOff = true;
      return response;
    } catch (error) {
      // This boundary retains only the existing sanitized authority envelope.
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "authority_error";
      const message = error instanceof HttpError ? error.message : "authority request failed";
      error = undefined;
      if (bound?.bridge) bound.bridge.entries.length = 0;
      bound = undefined; result = undefined; envelope = undefined; signal = undefined; request = undefined;
      text = JSON.stringify({ error: { code, message } });
      const response = admissionBridgeReplyResponse(ticket, text, status); text = undefined; handedOff = true;
      return response;
    } finally {
      if (bound?.bridge) bound.bridge.entries.length = 0;
      bound = undefined; result = undefined; envelope = undefined; signal = undefined; request = undefined; text = undefined;
      if (!handedOff) { retireAdmissionScratch(ticket); ticket.release(); }
    }
  }

  private async credentialPreflight(request: Request | undefined, ticket: PreflightTicket): Promise<Response> {
    let input: CredentialPreflightRequest | undefined;
    let staged: { credential: ProxyCredential; text: string; counts: IdentitySourceBudget } | undefined;
    let replyText: string | undefined;
    let handedOff = false;
    try {
      const intake = consumePreflightRequest(request, ticket);
      request = undefined;
      input = await intake;
      const source = input.source, id = input.credentialId, digest = input.secretSha256;
      const bound: AuthorityReadBound = { bytes: 0, identity: source };
      await prepareCredentialPreflight(input, {
        getCredential: key => this.getCredential(key, bound), hasMeta: key => this.hasMeta(key),
        seedCredential: (key, raw) => {
          // CURRENT winner and global fence precede normalization after KV await.
          if (this.getCredential(key, bound) || this.hasMeta("credentials_global_initialized")) return;
          const { copilotPublicIdentity: _untrusted, ...credential } = normalizeCredentialRecord(raw, key);
          // New route only: admit the staged value ONCE before serialization.
          // Its aliases are funded payload; they are not a second source credit.
          const plan = identityPlan("record"); plan.item(credential, 0);
          staged = { credential, text: JSON.stringify(credential), counts: plan.counts };
        },
      }, key => consumePreflightCredential(ticket, () => this.env.POLICY_KV.get(key, "stream"), source));
      replyText = this.storage.transactionSync(() => {
        let current = this.getCredential(id, bound);
        const seed = !current && staged && !this.hasMeta("credentials_global_initialized") ? staged : undefined;
        // This is a prospective check, not source consumption. Actual SQL still
        // performs LENGTH-before-value and charges its original full reread ONCE.
        // No await/other owner can change the winner before commit + reread.
        const finalSource = seed ? addIdentitySources(source, seed.counts) : source;
        const credential = current?.credential ?? seed?.credential;
        const outcome = !credential ? "unknown" : typeof credential.secretSha256 === "string" && safeEqual(digest, credential.secretSha256.toLowerCase()) ? "matched" : "invalid";
        const reply: CredentialPreflightReply = { outcome, source: finalSource };
        const replyPlan = identityPlan(); replyPlan.item(reply, 0);
        // Reserve room for the consumer's ORIGINAL reply read too. Outbound JSON
        // planning itself is NOT a source read and is never charged twice.
        checkIdentitySourceAddition(finalSource, replyPlan.counts);
        const text = JSON.stringify(reply);
        if (seed) {
          rows(this.sql.exec("INSERT INTO proxy_credentials (credential_id, credential_json) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM proxy_credentials WHERE credential_id = ?) AND NOT EXISTS (SELECT 1 FROM policy_binding_meta WHERE meta_key = ?)", id, seed.text, id, "credentials_global_initialized"));
          current = this.getCredential(id, bound);
          // SQL errors are errors, not profile rollback claims. The transaction
          // has no unrelated await, and the exact staged text was admitted above.
          if (!current) throw identityFailure("protocol");
        }
        current = null;
        return text;
      });
      staged = undefined; input = undefined;
      const response = preflightReplyResponse(ticket, replyText);
      replyText = undefined; handedOff = true;
      return response;
    } catch (error) {
      if (!ticket.bytes) throw error;
      // The existing private HTTP error boundary remains sanitized. This new
      // route also owns its error response until ORIGINAL body EOF/cancel.
      staged = undefined; input = undefined;
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "authority_error";
      const message = error instanceof HttpError ? error.message : "authority request failed";
      replyText = JSON.stringify({ error: { code, message } });
      const response = preflightReplyResponse(ticket, replyText, status);
      replyText = undefined; handedOff = true;
      return response;
    } finally {
      request = undefined; input = undefined; staged = undefined; replyText = undefined;
      if (!handedOff) ticket.release();
    }
  }

  private stageIdentityRecord(bound: AuthorityReadBound, table: string, keyColumn: string, column: string, key: string, value: unknown, marker: string): void {
    if (bound.bridge) {
      const family = admissionSeedTables.findIndex(row => row[0] === table && row[1] === keyColumn && row[2] === column);
      if (family < 0) throw identityFailure("protocol");
      if (bound.bridge.entries.some(entry => entry.kind === "seed" && entry.family === family && entry.key === key)) return;
      const plan = identityPlan();
      plan.array(0, entry => { for (const row of bound.bridge!.entries) if (row.kind === "seed") entry(row.value); entry(value); });
      const record = identityPlan("record"); record.item(value, 0);
      this.privateScratchPhase(bound, { C: 0, P: 0, N: 0, U: record.counts.text, B: 0 }, () => {
        this.appendAdmissionJournal(bound); // entry/index capacity before construction
        const text = JSON.stringify(value);
        this.appendAdmissionJournal(bound, { kind: "seed", family, key, value, text, marker });
      }, true);
      return;
    }
    const text = identityJson(value, "record"), identity = `${table}/${key}`;
    if (bound.staged!.has(identity)) return;
    const plan = identityPlan();
    plan.array(0, entry => { for (const row of bound.staged!.values()) entry(row.value); entry(value); });
    bound.staged!.set(identity, { value, marker });
    bound.commit!.push(() => this.sql.exec(`INSERT INTO ${table} (${keyColumn}, ${column}) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${keyColumn} = ?) AND NOT EXISTS (SELECT 1 FROM policy_binding_meta WHERE meta_key = ?)`, key, text, key, marker));
  }

  private searchStored(table: string, column: string, keyColumn: string, key: string, bound: AuthorityReadBound, envelope = false): unknown {
    const size = rows<{ bytes: number }>(this.sql.exec(`SELECT length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE ${keyColumn} = ?`, key))[0];
    if (!size) {
      if (bound.bridge) {
        const family = admissionSeedTables.findIndex(row => row[0] === table);
        const staged = bound.bridge.entries.find(entry => entry.kind === "seed" && entry.family === family && entry.key === key);
        return staged?.kind === "seed" && !this.hasMeta(staged.marker) ? envelope ? { value: staged.value } : staged.value : null;
      }
      const staged = bound.staged?.get(`${table}/${key}`);
      return staged && !this.hasMeta(staged.marker) ? envelope ? { value: staged.value } : staged.value : null;
    }
    if (bound.identity) {
      if (size.bytes === null) return null;
      admitIdentityBytes(bound.identity, size.bytes);
      if (bound.bridge) return this.privateSqlValue(bound, size.bytes, () => {
        let row = rows<{ value: string }>(this.sql.exec(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn} = ?`, key))[0];
        if (!row) throw identityFailure("protocol");
        const value = parseIdentity(row.value, bound.identity!); row = undefined as never;
        return envelope ? { value } : value;
      });
      const row = rows<{ value: string }>(this.sql.exec(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn} = ?`, key))[0];
      if (!row) throw identityFailure("protocol");
      const value = parseIdentity(row.value, bound.identity);
      return envelope ? { value } : value;
    }
    if ((bound.records = (bound.records ?? 0) + 1) > 32) searchUnavailable();
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || (bound.bytes += size.bytes) > (bound.video ? videoControlBytes : searchControlBytes)) searchUnavailable();
    const row = rows<{ value: string }>(this.sql.exec(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn} = ?`, key))[0];
    if (!row) searchUnavailable();
    if (bound.video) inspectVideoRecord(row.value, bound); else inspectSearchJson(row.value);
    return JSON.parse(row.value);
  }

  private privatePrincipal(bound: AuthorityReadBound, value: string): string | null {
    // BEFORE trim/lowercase; retain the returned normalized occurrence across
    // the actual cold-user await. No prelength denial of valid padded emails.
    const ticket = bound.bridge!.ticket; ticket.enter("source");
    try { return this.privateScratchPhase(bound, { C: 0, P: 0, N: 0,
      U: 3 * (typeof value === "string" ? identityUtf8(value) : 0) + 64, B: 0 },
      () => normalizeEmail(value), true); }
    finally { ticket.leave("source"); }
  }

  private getUser(email: string, bound?: AuthorityReadBound): AccessControlUser | null {
    if (bound?.bridge) return this.privateScratchPhase(bound, { C: 1, P: 4, N: 0,
      U: 3 * (typeof email === "string" ? identityUtf8(email) : 0) + 64, B: 0 }, () => {
      const normalized = normalizeEmail(email); if (!normalized) return null;
      const row = this.searchStored("access_users", "user_json", "email", normalized, bound, true) as { value: AccessUserRecord } | null;
      return row ? { email: normalized, record: row.value } : null;
    }, true);
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    if (bound?.identity) {
      const row = this.searchStored("access_users", "user_json", "email", normalized, bound, true) as { value: AccessUserRecord } | null;
      return row ? { email: normalized, record: row.value } : null;
    }
    if (bound) { const record = this.searchStored("access_users", "user_json", "email", normalized, bound) as AccessUserRecord | null; return record ? { email: normalized, record } : null; }
    const row = rows<{ user_json: string }>(this.sql.exec("SELECT user_json FROM access_users WHERE email = ?", normalized))[0];
    return row ? { email: normalized, record: JSON.parse(row.user_json) } : null;
  }

  // Only marked selected-user requests use these source budgets. Unmarked
  // getUser/list/bulk initialization semantics and other namespaces are unchanged.
  private materializedUser(email: string, budget: UserRecordBudget): AccessControlUser | null {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const size = rows<{ bytes: number }>(this.sql.exec("SELECT length(CAST(user_json AS BLOB)) AS bytes FROM access_users WHERE email = ?", normalized))[0];
    if (!size) return null;
    admitUserRecordBytes(budget, size.bytes);
    const row = rows<{ user_json: string }>(this.sql.exec("SELECT user_json FROM access_users WHERE email = ?", normalized))[0];
    if (!row) throw userMaterializationFailure("protocol");
    // Preserve getUser's row-wrapper truthiness, including parsed null/false/0.
    return { email: normalized, record: parseUserRecord(row.user_json, budget) as AccessUserRecord };
  }

  private resolveMaterializedUsers(emails: string[]): { users: AccessControlUser[]; missingEmails: string[] } {
    const budget = userRecordBudget(), users: AccessControlUser[] = [], missingEmails: string[] = [];
    for (const email of new Set(emails.map(normalizeEmail).filter(Boolean) as string[])) {
      const user = this.materializedUser(email, budget);
      if (user) users.push(user); else missingEmails.push(email);
    }
    return { users, missingEmails };
  }

  private initializeMaterializedUsers(users: AccessControlUser[]): void {
    if (this.hasMeta("users_global_initialized")) return;
    const budget = userRecordBudget(), candidates: AccessControlUser[] = [], inserted = new Set<string>();
    for (const raw of users) {
      const email = normalizeEmail(raw.email);
      // Simulate earlier first-wins candidates, without inserting early. Every
      // actual canonical read is charged and parsed, even when it wins the race.
      if (email && inserted.has(email) || this.materializedUser(raw.email, budget)) continue;
      const user = normalizeUser(raw);
      candidates.push(user); inserted.add(user.email);
    }
    admitUserJson(candidates, "complete");
    const prepared = candidates.map(user => ({ email: user.email, text: JSON.stringify(user.record) }));
    // All resource/validation/serialization work precedes the FIRST write. SQL
    // failures retain existing partial-commit uncertainty; no new transaction.
    for (const row of prepared) this.sql.exec("INSERT OR REPLACE INTO access_users (email, user_json) VALUES (?, ?)", row.email, row.text);
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

  private assignmentUser(email: string): AccessControlUser | null {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const size = rows<{ bytes: number }>(this.sql.exec("SELECT length(CAST(user_json AS BLOB)) AS bytes FROM access_users WHERE email = ?", normalized))[0];
    if (!size) return null;
    const budget = assignmentSourceBudget(); admitAssignmentBytes(budget, size.bytes);
    const row = rows<{ user_json: string }>(this.sql.exec("SELECT user_json FROM access_users WHERE email = ?", normalized))[0];
    if (!row) throw assignmentSourceFailure("protocol");
    return { email: normalized, record: parseAssignmentSource(row.user_json, budget) as AccessUserRecord };
  }

  private reconcileUserAssignments(request: AssignmentReconcileRequest, bounded = false) {
    const predecessor = this.assignmentTail;
    let release!: () => void;
    this.assignmentTail = new Promise<void>(resolve => { release = resolve; });
    const actual = (async () => {
      let snapshot, captured, failed = false, reason: unknown;
      try {
        snapshot = bounded ? captureAdmittedAssignmentRules(request.rules) : captureAssignmentRules(request.rules);
        captured = { email: request.email, legacy: request.legacy, evidence: request.evidence, force: request.force };
      } catch (error) { failed = true; reason = error; }
      // Even a synchronous snapshot failure must not let a successor overtake.
      await predecessor;
      if (failed) throw reason;
      const prepared = await prepareAssignmentRules(snapshot!);
      const user = bounded ? this.assignmentUser(captured!.email) : this.getUser(captured!.email);
      if (!user) throw new HttpError(404, "unknown_user", "access user not found");
      const candidate = bounded ? withAdmittedLegacyAssignmentState(user, captured!.legacy) : withLegacyAssignmentState(user, captured!.legacy);
      const result = evaluatePreparedUserAssignments(candidate, prepared, captured!.evidence, captured!.force);
      if (bounded) {
        // Normalize ONCE, only for an already-required write. Preserve the
        // existing projection, raw-group dedup/defaults, and full reply fields.
        const normalized = result.changed ? normalizeUser(result.user) : undefined;
        const stored = normalized ? assignmentJsonText(normalized.record, true) : undefined;
        const reply = assignmentJsonText(result);
        // Both serialized outputs precede the first mutation. No new rollback.
        if (normalized && stored !== undefined) {
          try { this.sql.exec("INSERT OR REPLACE INTO access_users (email, user_json) VALUES (?, ?)", normalized.email, stored); }
          catch { throw assignmentSourceFailure("transport"); }
        }
        return reply;
      }
      if (result.changed) this.putUser(result.user);
      return result;
    })();
    // A separate void slot observes every outcome without retaining result/error
    // graphs in the tail. Never clear a successor's slot from an older completion.
    void actual.then(() => release(), () => release());
    return actual;
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
  private getPolicy(id: string, bound?: AuthorityReadBound): AccessPolicyEntry | null {
    if (bound?.bridge) return this.privateScratchPhase(bound, { C: 1, P: 4, N: 0,
      U: (typeof id === "string" ? id.length : 0) + 32, B: 0 }, () => {
      const row = this.searchStored("access_policies", "policy_json", "policy_id", id, bound, true) as { value: AccessPolicy } | null;
      return row ? { policyId: id, policy: row.value } : null;
    }, true);
    if (bound?.identity) {
      const row = this.searchStored("access_policies", "policy_json", "policy_id", id, bound, true) as { value: AccessPolicy } | null;
      return row ? { policyId: id, policy: row.value } : null;
    }
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

  private authorizeSearchGrant(input: SearchGrantAttestation, tombstone = false): SearchGrantAttestation {
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
      || input.resultGeneration !== input.original.generation + (tombstone ? 0 : 1)
      || tombstone && (!input.original.exists || input.resultLineage !== input.original.lineage)
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

  private authorizeMusicGrant(input: MusicGrantAttestation): MusicGrantAttestation {
    searchJsonBytes(input);
    if (!input || Object.keys(input).sort().join(",") !== "actor,admissionRevision,digest,domain,key,mode,original,resultGeneration,resultLineage,scope"
      || input.domain !== "clawrouter.minimax-music-mutation.v1"
      || !["preserve", "replace", "revoke", "tombstone"].includes(input.mode)
      || !Array.isArray(input.scope) || input.scope.length !== 3
      || JSON.stringify(input.scope) !== JSON.stringify(grantPoolIdentity(input.key)))
      throw new HttpError(403, "minimax_music_admin_required", "Current Music mutation authority is required");
    const { domain: _domain, scope: _scope, mode, ...proof } = input;
    // Same last SQL role/revision check, with only the Music tombstone's
    // idempotent generation rule. Search's mutation contract stays unchanged.
    this.authorizeSearchGrant(proof, mode === "tombstone");
    if ((mode === "revoke" || mode === "tombstone") && this.grantAttachment(input.key).pending)
      throw new HttpError(403, "minimax_music_admin_required", "Pending Music mutations require explicit recovery");
    return input;
  }

  private authorizeVideoGrant(input: VideoGrantAttestation): VideoGrantAttestation {
    searchJsonBytes(input);
    if (!input || Object.keys(input).sort().join(",") !== "actor,admissionRevision,digest,domain,key,mode,original,resultGeneration,resultLineage,scope"
      || input.domain !== "clawrouter.minimax-video-mutation.v1"
      || !["preserve", "replace", "revoke", "tombstone"].includes(input.mode)
      || !Array.isArray(input.scope) || input.scope.length !== 3
      || JSON.stringify(input.scope) !== JSON.stringify(grantPoolIdentity(input.key)))
      throw new HttpError(403, "minimax_video_admin_required", "Current video mutation authority is required");
    const { domain: _domain, scope: _scope, mode, ...proof } = input;
    this.authorizeSearchGrant(proof, mode === "tombstone");
    if ((mode === "revoke" || mode === "tombstone") && this.grantAttachment(input.key).pending)
      throw new HttpError(403, "minimax_video_admin_required", "Pending video mutations require explicit recovery");
    return input;
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
  private getCredential(id: string, bound?: AuthorityReadBound): ProxyCredentialEntry | null {
    if (bound?.bridge) return this.privateScratchPhase(bound, { C: 1, P: 4, N: 0,
      U: (typeof id === "string" ? id.length : 0) + 32, B: 0 }, () => {
      const row = this.searchStored("proxy_credentials", "credential_json", "credential_id", id, bound, true) as { value: ProxyCredential } | null;
      return row ? { credentialId: id, credential: row.value } : null;
    }, true);
    if (bound?.identity) {
      const row = this.searchStored("proxy_credentials", "credential_json", "credential_id", id, bound, true) as { value: ProxyCredential } | null;
      return row ? { credentialId: id, credential: row.value } : null;
    }
    if (bound) { const credential = this.searchStored("proxy_credentials", "credential_json", "credential_id", id, bound) as ProxyCredential | null; return credential ? { credentialId: id, credential } : null; }
    const row = rows<{ credential_json: string }>(this.sql.exec("SELECT credential_json FROM proxy_credentials WHERE credential_id = ?", id))[0];
    return row ? { credentialId: id, credential: JSON.parse(row.credential_json) } : null;
  }
  private authorizationSnapshot(input: AuthorizationSnapshotRequest, bound?: AuthorityReadBound): AuthorizationSnapshot {
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
  private getConnection(id: string, bound?: AuthorityReadBound): ProviderConnection | null {
    if (bound) return this.searchStored("provider_connections", "connection_json", "provider_id", id, bound) as ProviderConnection | null;
    const row = rows<{ connection_json: string }>(this.sql.exec("SELECT connection_json FROM provider_connections WHERE provider_id = ?", id))[0];
    return row ? JSON.parse(row.connection_json) : null;
  }
  private resolveConnections(ids: string[], bound?: AuthorityReadBound): { initialized: boolean; connections: ProviderConnection[]; missingProviderIds: string[] } {
    if (bound?.identity) { admitIdentity(ids); admitIdentityCount(ids.length, 128); }
    if (bound?.bridge) {
      let units = 0; for (const id of ids) if (typeof id === "string") units += id.length;
      return this.privateScratchPhase(bound, { C: 3, P: 2 * ids.length + 6, N: ids.length + 1, U: 2 * units + 64, B: 0 }, () => {
        const connections: ProviderConnection[] = [], missingProviderIds: string[] = [];
        for (let index = 0; index < ids.length; index++) if (ids.indexOf(ids[index]) === index) { const id = ids[index], entry = this.getConnection(id, bound); if (entry) connections.push(entry); else missingProviderIds.push(id); }
        return { initialized: this.hasMeta("connections_global_initialized"), connections, missingProviderIds };
      }, true);
    }
    const connections: ProviderConnection[] = [], missingProviderIds: string[] = [];
    for (const id of [...new Set(ids)]) { const entry = this.getConnection(id, bound); if (entry) connections.push(entry); else missingProviderIds.push(id); }
    return { initialized: this.hasMeta("connections_global_initialized"), connections, missingProviderIds };
  }

  private resolvePrivateProviderConnections(providers: NonNullable<AdmissionRequest["providers"]>, bound: AuthorityReadBound,
    allowed?: string[]): ProviderConnection[] {
    // Same ids/order/unique canonical reads without a 128-index mapped id array.
    const plan = identityPlan(); let count = 0;
    plan.array(0, entry => { for (const provider of providers) if (!allowed?.length || allowed.includes(provider.id)) { entry(provider.id); count++; } });
    admitIdentityCount(count, 128);
    return this.privateScratchPhase(bound, { C: 1, P: count, N: 0, U: 0, B: 0 }, () => {
      const connections: ProviderConnection[] = [];
      for (let index = 0; index < providers.length; index++) {
        const id = providers[index].id;
        if (allowed?.length && !allowed.includes(id)) continue;
        let duplicate = false;
        for (let before = 0; before < index; before++) if (providers[before].id === id) { duplicate = true; break; }
        if (!duplicate) { const entry = this.getConnection(id, bound); if (entry) connections.push(entry); }
      }
      this.hasMeta("connections_global_initialized"); // retain the original resolver's metadata probe
      return connections;
    }, true);
  }

  private resolveGrantPool(input: GrantPoolResolveRequest, bound?: AuthorityReadBound, defaults?: { tokenRef: unknown }): { keys: string[]; states: Record<string, GrantRuntimeState>; hasAttachment: boolean } {
    if (defaults && bound?.bridge) {
      // Template coercion originally precedes resolver validation. Preserve its
      // error ordering, but visit borrowed fragments instead of joining them.
      for (const _ of privateDefaultKeyParts(input.policyId, input.tenantId, defaults.tokenRef, false)) { /* scalar coercion only */ }
      for (const _ of privateDefaultKeyParts(input.policyId, input.tenantId, defaults.tokenRef, true)) { /* scalar coercion only */ }
    }
    const providerId = grantSegment(input.providerId, "providerId");
    const policyId = grantPoolScopeId(input.policyId);
    const tenantId = grantPoolScopeId(input.tenantId);
    // Only the stored consumer policy can share another scope's owner. Never
    // accept membership from a request or follow another policy's references.
    const shared = policyId ? this.getPolicy(policyId, bound)?.policy.grantRouting?.sharedGrants?.[providerId] ?? [] : [];
    if (bound && !bound.identity) {
      if (shared.length) searchUnavailable();
      let members = 0, bytes = 0;
      for (const [scope, id] of [["policies", policyId], ["tenants", tenantId]]) {
        if (!id) continue;
        const count = rows<{ count: number; bytes: number }>(this.sql.exec("SELECT count(*) AS count, coalesce(sum(length(CAST(token_ref AS BLOB))),0) AS bytes FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ?", scope, id, providerId))[0];
        members += count.count; bytes += count.bytes;
      }
      if (members > 32 || bytes > (bound.video ? videoControlBytes : searchControlBytes)) searchUnavailable();
    }
    if (bound?.identity) {
      if (defaults && bound.bridge) {
        const plan = identityPlan();
        plan.object(0, field => {
          field("providerId", input.providerId); field("policyId", input.policyId); field("tenantId", input.tenantId);
          field("defaultKeys", undefined, () => plan.array(1, entry => {
            entry(undefined, () => planPrivateIdentityString(plan, privateDefaultKeyParts(input.policyId, input.tenantId, defaults.tokenRef, false)));
            entry(undefined, () => planPrivateIdentityString(plan, privateDefaultKeyParts(input.policyId, input.tenantId, defaults.tokenRef, true)));
          }));
        });
      } else admitIdentity(input);
      admitIdentity(shared);
      let count = (defaults && bound.bridge ? 2 : (input.defaultKeys ?? []).length) + shared.length;
      for (const [scope, id] of [["policies", policyId], ["tenants", tenantId]]) if (id) {
        const size = rows<{ count: number }>(this.sql.exec("SELECT count(*) AS count FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? AND status IN ('legacy', 'active')", scope, id, providerId))[0];
        count += size.count;
      }
      admitIdentityCount(count, 256);
    }
    if (bound?.bridge) return this.privateControlPhase(bound, () => this.privateScratchPhase(bound,
      { C: 5, P: 98 + 2 * 98 + 32 + 8, N: 1, U: (256 + 32) * 1024 + 256, B: 0 },
      () => this.resolvePrivateGrantPool(input, bound, providerId, policyId, tenantId, shared, defaults), true));
    const sharedKeys = shared.filter(key => {
      if (this.attachmentMember(grantPoolIdentity(key), providerId)?.status !== "active") return false;
      if (bound?.identity) {
        const grant = this.searchStored("upstream_grant_projections", "projection_json", "grant_key", key, bound) as UpstreamGrant | null;
        return grant?.kind === "subscription" && grant.provider === providerId;
      }
      const row = rows<{ projection_json: string | null }>(this.sql.exec("SELECT projection_json FROM upstream_grant_projections WHERE grant_key = ? AND legacy = 0", key))[0];
      const grant: UpstreamGrant | null = row?.projection_json ? JSON.parse(row.projection_json) : null;
      return grant?.kind === "subscription" && grant.provider === providerId;
    });
    const keys = [...new Set([
      ...(bound && !bound.identity ? [] : (input.defaultKeys ?? []).map((key) => grantKey(key))),
      ...(policyId ? this.poolTokenRefs("policies", policyId, providerId, bound).map((tokenRef) => `oauth/${policyId}/${tokenRef}`) : []),
      ...(tenantId ? this.poolTokenRefs("tenants", tenantId, providerId, bound).map((tokenRef) => `oauth/tenants/${tenantId}/${tokenRef}`) : []),
      ...sharedKeys,
    ])];
    const hasAttachment = shared.length > 0 || [policyId && ["policies", policyId], tenantId && ["tenants", tenantId]].some((scope) => scope && rows(this.sql.exec("SELECT 1 FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? LIMIT 1", ...scope, providerId)).length > 0);
    if (bound && !bound.identity && keys.length > 32) searchUnavailable();
    if (bound?.bridge?.result) {
      let count = keys.length;
      for (const id in bound.bridge.result.pools) if (Object.hasOwn(bound.bridge.result.pools, id) && id !== providerId) count += bound.bridge.result.pools[id].keys.length;
      admitIdentityCount(count, 1024);
    }
    return { keys, states: this.grantRuntimeStates(keys, bound, providerId, hasAttachment), hasAttachment };
  }

  private resolvePrivateGrantPool(input: GrantPoolResolveRequest, bound: AuthorityReadBound, providerId: string,
    policyId: string | null, tenantId: string | null, shared: string[], defaults?: { tokenRef: unknown }): AdmissionPool {
    const keys: string[] = [], sharedKeys: string[] = [];
    try {
      // Preserve shared-projection read order, without filter/Map/Set batches.
      for (const key of shared) {
        if (this.attachmentMember(privateGrantPoolIdentity(key), providerId)?.status !== "active") continue;
        const grant = this.searchStored("upstream_grant_projections", "projection_json", "grant_key", key, bound) as UpstreamGrant | null;
        if (grant?.kind === "subscription" && grant.provider === providerId) sharedKeys.push(key);
      }
      const hasScope = (scope: string, id: string | null) => !!id && rows(this.sql.exec("SELECT 1 FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? LIMIT 1", scope, id, providerId)).length > 0;
      const hasAttachment = shared.length > 0 || hasScope("policies", policyId) || hasScope("tenants", tenantId);
      const plan = identityPlan();
      // Admit the growing COMPLETE partial-result layout before each key slot.
      // SQL values are still original source reads; output planning adds no source.
      const result = bound.bridge!.result!;
      plan.object(0, field => {
        for (const key in result) if (Object.hasOwn(result, key) && key !== "pools") field(key, (result as unknown as Record<string, unknown>)[key]);
        field("pools", undefined, () => plan.object(1, pool => {
          let total = 0;
          for (const id in result.pools) if (Object.hasOwn(result.pools, id) && id !== providerId) { pool(id, result.pools[id]); total += result.pools[id].keys.length; }
          pool(providerId, undefined, () => plan.object(2, member => {
            member("states", {}); member("hasAttachment", hasAttachment);
            member("keys", undefined, () => plan.array(3, entry => {
              const append = (raw: unknown) => { const key = grantKey(raw); if (keys.includes(key)) return; admitIdentityCount(total + keys.length + 1, 1024); entry(key); keys.push(key); };
              if (defaults) {
                append(privateDefaultGrantKey(input.policyId, input.tenantId, defaults.tokenRef, false));
                append(privateDefaultGrantKey(input.policyId, input.tenantId, defaults.tokenRef, true));
              } else for (const key of input.defaultKeys ?? []) append(key);
              const refs = (scope: string, id: string | null) => {
                if (!id) return;
                let values = identitySqlRows(this.sql, "SELECT json_object('token_ref', token_ref) AS value FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? AND status IN ('legacy', 'active') ORDER BY token_ref", [scope, id, providerId], bound.identity!, 256, (bytes, run) => this.privateSqlValue(bound, bytes, run, true)) as { token_ref: string }[];
                try { for (const value of values) append(scope === "tenants" ? `oauth/tenants/${id}/${value.token_ref}` : `oauth/${id}/${value.token_ref}`); }
                finally { values.length = 0; values = undefined as never; }
              };
              refs("policies", policyId); refs("tenants", tenantId);
              for (const key of sharedKeys) append(key);
            }));
          }));
        }));
      });
      sharedKeys.length = 0;
      return { keys, states: this.grantRuntimeStates(keys, bound, providerId, hasAttachment), hasAttachment };
    } finally { sharedKeys.length = 0; }
  }

  private grantAttachment(key: string, privateBridge = false): GrantAttachmentSnapshot {
    const identity = privateBridge ? privateGrantPoolIdentity(key) : grantPoolIdentity(key);
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

  private grantRuntimeStates(rawKeys: unknown, bound?: AuthorityReadBound, providerId?: string, hasAttachment = false): Record<string, GrantRuntimeState> {
    if (!Array.isArray(rawKeys) || rawKeys.length > 98) invalidAuthorityRequest("grant runtime keys must be a bounded array");
    const states: Record<string, GrantRuntimeState> = {};
    const keys = bound?.bridge ? rawKeys : [...new Set(rawKeys.map((value) => grantKey(value)))];
    for (const value of keys) {
      const key = bound?.bridge ? grantKey(value) : value as string;
      if (bound) {
        const state = this.searchStored("upstream_grant_runtime", "state_json", "grant_key", key, bound);
        if (state) states[key] = bound.bridge?.result && providerId
          ? this.privateGeneratedRecord(bound, state, admit => normalizePrivateGrantRuntimeState(state, raw => {
            planPrivateRuntime(bound.bridge!.result!, providerId, rawKeys as string[], states, key, raw, hasAttachment);
            admit(plan => admitGeneratedRuntime(raw, plan, key, 0, true));
          }), "complete")
          : normalizeGrantRuntimeState(state); continue;
      }
      const row = rows<{ state_json: string }>(this.sql.exec("SELECT state_json FROM upstream_grant_runtime WHERE grant_key = ?", key))[0];
      if (row) states[key] = normalizeGrantRuntimeState(JSON.parse(row.state_json));
    }
    return states;
  }

  private selectGrant(input: GrantPoolSelectRequest, bound?: AuthorityReadBound): { selectedKey: string; selectedCount: number; lastSelectedAt: string } {
    if (bound?.identity) { const plan = this.planGrant(input, bound); if (!plan.commit) throw identityFailure("protocol"); plan.commit(); return plan.result; }
    const poolKey = grantSelectionPoolKey(input.poolKey);
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 98) invalidAuthorityRequest("grant selection candidates must be a bounded array");
    if (bound) {
      const size = rows<{ count: number; bytes: number }>(this.sql.exec("SELECT count(*) AS count, coalesce(sum(length(CAST(grant_key AS BLOB))),0) AS bytes FROM upstream_grant_selection WHERE pool_key = ?", poolKey))[0];
      if (size.count > 32 || (bound.bytes += size.bytes) > (bound.video ? videoControlBytes : searchControlBytes)) searchUnavailable();
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

  private planGrant(input: GrantPoolSelectRequest, bound?: AuthorityReadBound) {
    const poolKey = grantSelectionPoolKey(input.poolKey);
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 98) invalidAuthorityRequest("grant selection candidates must be a bounded array");
    if (bound && !bound.identity) {
      const size = rows<{ count: number; bytes: number }>(this.sql.exec("SELECT count(*) AS count, coalesce(sum(length(CAST(grant_key AS BLOB))),0) AS bytes FROM upstream_grant_selection WHERE pool_key = ?", poolKey))[0];
      if (size.count > 32 || (bound.bytes += size.bytes) > (bound.video ? videoControlBytes : searchControlBytes)) searchUnavailable();
    }
    if (bound?.identity) admitIdentity(input);
    const previous = bound?.identity ? this.selectionState(poolKey, bound) : undefined;
    const candidates = bound?.bridge ? consumeOwnedChoiceCandidates(input.candidates, grantKey) : normalizedChoiceCandidates(input.candidates, grantKey);
    const cursorKey = previous ? previous.cursorKey : rows<{ grant_key: string }>(this.sql.exec("SELECT grant_key FROM upstream_grant_pool_cursors WHERE pool_key = ?", poolKey))[0]?.grant_key ?? null;
    const choice = bound?.bridge ? chooseOwnedGrantKey(input, candidates, cursorKey, key => previous?.counts[key])
      : chooseGrantKey(input, candidates, { cursorKey, counts: input.strategy === "least_used" ? previous ? new Map(Object.entries(previous.counts)) : this.selectionCounts(poolKey) : new Map() });
    const nowMs = Date.now(), lastSelectedAt = new Date(nowMs).toISOString();
    const current = previous?.counts[choice.selectedKey]?.count ?? (rows<{ selected_count: number }>(this.sql.exec("SELECT selected_count FROM upstream_grant_selection WHERE pool_key = ? AND grant_key = ?", poolKey, choice.selectedKey))[0]?.selected_count ?? 0);
    const result = { selectedKey: choice.selectedKey, selectedCount: current + 1, lastSelectedAt };
    if (previous) {
      const plan = identityPlan();
      plan.object(0, field => {
        field("cursorKey", choice.cursorKey ?? cursorKey);
        field("counts", undefined, () => plan.object(1, count => {
          for (const key in previous.counts) if (Object.hasOwn(previous.counts, key) && key !== choice.selectedKey) count(key, previous.counts[key]);
          count(choice.selectedKey, { count: result.selectedCount, lastMs: nowMs });
        }));
      });
    }
    let state: typeof previous;
    if (bound?.bridge && previous) {
      const plan = identityPlan(); plan.item(previous, 0);
      state = this.privateScratchPhase(bound, { C: plan.counts.containers + 2,
        P: 2 * plan.counts.members + plan.counts.entries + 8, N: plan.counts.values + 2,
        U: plan.counts.units + choice.selectedKey.length + 64, B: 0 }, () =>
        ({ cursorKey: choice.cursorKey ?? cursorKey, counts: { ...previous.counts, [choice.selectedKey]: { count: result.selectedCount, lastMs: nowMs } } }), true);
    } else state = previous ? { cursorKey: choice.cursorKey ?? cursorKey, counts: { ...previous.counts, [choice.selectedKey]: { count: result.selectedCount, lastMs: nowMs } } } : undefined;
    if (bound?.identity) { admitIdentity(result); admitIdentity(state); }
    if (bound?.bridge) {
      this.appendAdmissionJournal(bound); // reserve the final execution entry before its factory
      return { result, state, journal: { kind: "selection" as const, poolKey, selectedKey: choice.selectedKey, cursorKey: choice.cursorKey ?? null, nowMs, attempted: false }, commit: undefined };
    }
    let committed = false;
    return { result, state, commit: () => {
      if (committed) return; committed = true;
      if (choice.cursorKey) this.sql.exec("INSERT OR REPLACE INTO upstream_grant_pool_cursors (pool_key, grant_key) VALUES (?, ?)", poolKey, choice.cursorKey);
      rows(this.sql.exec("INSERT INTO upstream_grant_selection (pool_key, grant_key, selected_count, last_selected_ms) VALUES (?, ?, 1, ?) ON CONFLICT (pool_key, grant_key) DO UPDATE SET selected_count = selected_count + 1, last_selected_ms = excluded.last_selected_ms RETURNING selected_count", poolKey, choice.selectedKey, nowMs));
    } };
  }

  /** Pool counters and cursor for an isolate-local selection snapshot. */
  private selectionState(rawPoolKey: string, bound?: AuthorityReadBound): { cursorKey: string | null; counts: Record<string, { count: number; lastMs: number }> } {
    const poolKey = grantSelectionPoolKey(rawPoolKey);
    if (bound?.identity) {
      const cursor = identitySqlRows(this.sql, "SELECT json_object('grant_key', grant_key) AS value FROM upstream_grant_pool_cursors WHERE pool_key = ?", [poolKey], bound.identity, 1, bound.bridge ? (bytes, run) => this.privateSqlValue(bound, bytes, run, true) : undefined) as { grant_key: string }[];
      if (bound.bridge) {
        const counts = foldIdentitySqlHistory(this.sql, poolKey, bound.identity, (bytes, run) => this.privateSqlValue(bound, bytes, run, true));
        return { cursorKey: cursor[0]?.grant_key ?? null, counts };
      }
      const history = identitySqlRows(this.sql, "SELECT json_object('grant_key', grant_key, 'selected_count', selected_count, 'last_selected_ms', last_selected_ms) AS value FROM upstream_grant_selection WHERE pool_key = ?", [poolKey], bound.identity) as { grant_key: string; selected_count: number; last_selected_ms: number }[];
      admitIdentity(history);
      return { cursorKey: cursor[0]?.grant_key ?? null, counts: Object.fromEntries(history.map(row => [row.grant_key, { count: row.selected_count, lastMs: row.last_selected_ms }])) };
    }
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

  private poolTokenRefs(scope: "policies" | "tenants", scopeId: string, providerId: string, bound?: AuthorityReadBound): string[] {
    if (bound?.identity) return (identitySqlRows(this.sql, "SELECT json_object('token_ref', token_ref) AS value FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND provider_id = ? AND status IN ('legacy', 'active') ORDER BY token_ref", [scope, scopeId, providerId], bound.identity, 256) as { token_ref: string }[]).map(row => row.token_ref);
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

// Profile and all earlier canonical/shared checks have already run. Validate
// the existing grant-key grammar on borrowed pieces BEFORE allocating the key.
function privateDefaultGrantKey(policyId: string, tenantId: string, tokenRef: unknown, tenant: boolean): string {
  let length = 0;
  for (const part of privateDefaultKeyParts(policyId, tenantId, tokenRef, tenant)) {
    length += part.length;
    if (length > 1024 || /[\u0000-\u001f\u007f]/.test(part)) invalidAuthorityRequest("grant key is invalid");
  }
  let key = "";
  for (const part of privateDefaultKeyParts(policyId, tenantId, tokenRef, tenant)) key += part;
  return key;
}

function grantPoolIdentity(value: string): [string, string, string] {
  const parts = grantKey(value).split("/");
  if (parts.length === 4 && parts[1] === "tenants") return ["tenants", grantSegment(parts[2], "scopeId"), grantSegment(parts[3], "tokenRef")];
  if (parts.length === 3 && parts[1] !== "tenants") return ["policies", grantSegment(parts[1], "scopeId"), grantSegment(parts[2], "tokenRef")];
  return invalidAuthorityRequest("grant key is invalid");
}

function privateGrantPoolIdentity(value: string): [string, string, string] {
  if (!privateGrantKey(value)) invalidAuthorityRequest("grant key is invalid");
  // Grammar/length are already bounded before the three small substrings.
  if (value.startsWith("oauth/tenants/")) { const end = value.indexOf("/", 14); return ["tenants", value.slice(14, end), value.slice(end + 1)]; }
  const end = value.indexOf("/", 6); return ["policies", value.slice(6, end), value.slice(end + 1)];
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


export async function authorityCall<T>(env: Env, path: string, body: unknown, objectName = "policy-bindings", signal?: AbortSignal, wan?: WanManagedOperation, search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, cover?: MiniMaxMusicCoverControl, identityBudget?: IdentitySourceBudget): Promise<T> {
  const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(objectName));
  if (cover) {
    if (!isMusicCoverControl(cover) || objectName !== "policy-bindings" || !["/admission/resolve", "/authorization/snapshot", "/connections/resolve"].includes(path)) musicCoverUnavailable();
    return cover.controlJson<T>(body, (text, active) => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text,
      signal: active, redirect: "manual", headers: { "content-type": "application/json", [musicCoverControlHeader]: musicCoverControlVersion } }), false, signal, path === "/admission/resolve");
  }
  if (path === "/grant-search/authorize" || path === "/grant-music/authorize" || path === "/grant-video/authorize") {
    searchJsonBytes(body);
    const response = await stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body), signal, redirect: "manual", headers: { "content-type": "application/json" } });
    let input: InputRetirement | undefined;
    try {
      const result = await readSearchJson(response, signal ?? new AbortController().signal, "control", owner => { input = owner; });
      if (!response.ok) throw new HttpError(403, "access_admin_required", "Current administrator authority is required");
      return result as T;
    } finally { await input?.retired.catch(() => undefined); }
  }
  if (video) return video.controlJson<T>(body, (text, active) => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal: active, redirect: "manual", headers: { "content-type": "application/json", [videoControlHeader]: videoControlVersion } }), false, signal);
  if (search) return search.controlJson<T>(body, (text, active) => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal: active, redirect: "manual", headers: { "content-type": "application/json", [searchControlHeader]: searchControlVersion } }), false, signal);
  if (wan) return wan.controlJson<T>(body, (text, active) => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal: active, redirect: "manual" }), false, signal);
  if (objectName === "policy-bindings" && path === "/users/reconcile-assignments") {
    const text = assignmentJsonText(body);
    return await readAssignmentResponse(() => stub.fetch("https://clawrouter.internal/users/reconcile-assignments", {
      method: "POST", body: text, signal, headers: { [assignmentSourceHeader]: assignmentSourceVersion },
    }), signal) as T;
  }
  if (objectName === "policy-bindings" && ["/admission/resolve", "/grant-pools/resolve", "/grant-pools/select"].includes(path)) {
    const text = identityJson(body);
    return readIdentityResponse<T>(() => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal,
      headers: { [identityHeader]: identityVersion } }), identityBudget ?? identitySourceBudget(), signal, undefined, path === "/admission/resolve" ? "identity" : "generic");
  }
  const collection = objectName === "policy-bindings" && isPolicyCollectionPath(path);
  if (collection) admitPolicyCall(path, body);
  const ack = objectName === "policy-bindings" ? authorityAck(path) : undefined;
  if (ack) {
    const text = collection ? policyJsonText(body) : JSON.stringify(body);
    return await readAuthorityAck(() => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal,
      ...(collection ? { headers: { [policyCollectionHeader]: policyCollectionVersion } } : {}) }), ack, signal) as T;
  }
  if (collection) {
    const text = policyJsonText(body);
    return await readPolicyResponse(() => stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: text, signal,
      headers: { [policyCollectionHeader]: policyCollectionVersion } }), signal, path) as T;
  }
  if (objectName === "policy-bindings" && path === "/users/resolve") {
    const text = userJsonText(body, "query");
    return await readAuthorityUserResponse(() => stub.fetch("https://clawrouter.internal/users/resolve", { method: "POST", body: text, signal,
      headers: { [userMaterializationHeader]: userMaterializationVersion } }), signal) as T;
  }
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
export async function resolvePolicies(env: Env, ids: string[], collection = new PolicyCollection()): Promise<AccessPolicyEntry[]> {
  admitPolicyIds(ids);
  const result = await authorityCall<{ initialized: boolean; policies: AccessPolicyEntry[]; missingPolicyIds: string[] }>(env, "/policies/resolve", { policyIds: ids });
  admitPolicyJson(result); admitPolicyIds(result.missingPolicyIds);
  if (result.initialized || !result.missingPolicyIds.length) return result.policies;
  const seeded: AccessPolicyEntry[] = [], plan = policySequencePlan();
  for (const policyId of result.missingPolicyIds) {
    const value = await collection.read(env, `policies/${policyId}`) ?? await genuineLegacyKey(env, policyId, key => collection.read(env, key));
    if (value) { const entry = { policyId, policy: value as unknown as AccessPolicy }; plan(entry); seeded.push(entry); }
  }
  if (seeded.length) await authorityCall(env, "/policies/initialize", { entries: seeded, retainRequestContentDefault: contentRetentionDefault(env) });
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
  const seeded: AccessControlUser[] = [], budget = userRecordBudget();
  for (const email of result.missingEmails) {
    const record = await readUserKvRecord(() => env.POLICY_KV.get(`access/users/${email}`, "stream"), budget) as AccessUserRecord;
    if (record) seeded.push({ email, record });
  }
  if (seeded.length) {
    // This private cold path alone marks initialization. Raw ignored seeds are
    // admitted here; only the owner can determine which candidates to normalize.
    const text = userJsonText(seeded, "init");
    const stub = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
    await readAuthorityAck(() => stub.fetch("https://clawrouter.internal/users/initialize", { method: "POST", body: text,
      headers: { [userMaterializationHeader]: userMaterializationVersion } }), "initialized");
  }
  return (await authorityCall<typeof result>(env, "/users/resolve", { emails })).users;
}
export async function resolveBindings(env: Env, principals: Principal[], collection = new PolicyCollection()): Promise<PolicyBinding[]> {
  admitPolicyPrincipals(principals);
  const result = await authorityCall<{ initialized: boolean; bindings: PolicyBinding[]; missingPrincipals: Principal[] }>(env, "/resolve", { principals });
  admitPolicyBindings(result.bindings); admitPolicyPrincipals(result.missingPrincipals);
  if (result.initialized || !result.missingPrincipals.length) return result.bindings;
  const seeds: Seed[] = [], plan = policySequencePlan();
  for (const principal of result.missingPrincipals) {
    const prefix = `access/bindings/${principal.principalType}/${encodeURIComponent(principal.principalId)}/`;
    const seed = { principal, bindings: await collection.listBindings(env, prefix) };
    plan(seed); seeds.push(seed);
  }
  await authorityCall(env, "/initialize", seeds);
  const final = (await authorityCall<typeof result>(env, "/resolve", { principals })).bindings;
  admitPolicyBindings(final); return final;
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

export async function resolveConnection(env: Env, providerId: string, wan?: WanManagedOperation, search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, cover?: MiniMaxMusicCoverControl): Promise<ProviderConnection | null> {
  if (cover) {
    const result = await authorityCall<{ connections: ProviderConnection[]; missingProviderIds: string[] }>(env,
      "/connections/resolve", { providerIds: [providerId] }, "policy-bindings", cover.operation.signal, undefined, undefined, undefined, cover);
    if (providerId !== "minimax" || result.missingProviderIds.length || result.connections.length !== 1 || result.connections[0].providerId !== providerId) musicCoverUnavailable();
    return result.connections[0];
  }
  if (video) {
    const result = await authorityCall<{ connections: ProviderConnection[]; missingProviderIds: string[] }>(env,
      "/connections/resolve", { providerIds: [providerId] }, "policy-bindings", video.controlSignal, undefined, undefined, video);
    if (result.missingProviderIds.length || result.connections.length !== 1 || result.connections[0].providerId !== providerId) searchUnavailable();
    return result.connections[0];
  }
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
