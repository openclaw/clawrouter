import type { GrantKind, GrantQuotaKind } from "../shared/provider-snapshot.ts";
import type { MiniMaxAnthropicBinding } from "./minimax-anthropic-binding.ts";
import type { GrantRoutingPolicy, GrantAccount, GrantExtraUsage, GrantLane, BudgetOverride } from "../shared/contracts";
export type { GrantSelectionStrategy, GrantStickiness, GrantRoutingPolicy, ProviderConnection, GrantAccount, GrantExtraUsage, GrantLane, BudgetOverride, PolicyBinding } from "../shared/contracts";
export type { ModelRequestParameters, ProviderReasoningEffort } from "../shared/model-request-parameters";

export type ProxyRequestBody = Record<string, unknown> | Record<string, unknown>[];

export type {
  ProviderSnapshot,
  CompiledProvider,
  GrantQuotaKind,
  CompiledQuotaWindow,
  CompiledQuotaProbeWindow,
  CompiledQuotaProbe,
  CompiledQuotaConfig,
  GrantTransportAuth,
  CompiledGrantTransport,
  AuthScheme,
  AuthorizationConfig,
  RefreshConfig,
  CompiledModel,
  OutputTokenLimit,
  ToolPricing,
  CompiledEndpoint,
  GrantKind,
} from "../shared/provider-snapshot.ts";
export type { TokenRates, LongContextPricing, ServiceTierPricing, TokenPricing, CharacterPricing, ImageTokenPricing, ModelPricing } from "../shared/contracts";

export interface Env {
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  // Object bindings, never generic provider environment strings or grant-pool entries.
  PRIVATE_CODEX_POLICY?: { get(): Promise<string> };
  PRIVATE_CODEX_UPSTREAM?: { get(): Promise<string> };
  POLICY_KV: KVNamespace;
  BUDGET_LEDGER: DurableObjectNamespace;
  USAGE_LEDGER: DurableObjectNamespace;
  ACCESS_CONTROL: DurableObjectNamespace;
  GRANT_CREDENTIALS: DurableObjectNamespace;
  USAGE_QUEUE: Queue<QueueMessage>;
  CONTENT_ARCHIVE: R2Bucket;
  CONTENT_CLEANUP: DurableObjectNamespace;
  ASSETS: Fetcher;
  CLAWROUTER_ADMIN_TOKEN_SHA256?: string;
  CLAWROUTER_ACCESS_TEAM_DOMAIN?: string;
  CLAWROUTER_ACCESS_AUD?: string;
  CLAWROUTER_ACCESS_ADMIN_EMAILS?: string;
  CLAWROUTER_ACCESS_ADMIN_DOMAINS?: string;
  CLAWROUTER_ACCESS_DEFAULT_TENANT?: string;
  CLAWROUTER_LOCAL_AUTH?: string;
  CLAWROUTER_LOCAL_ADMIN_EMAIL?: string;
  CLAWROUTER_PUBLIC_ORIGIN?: string;
  CLAWROUTER_UPSTREAM_RETENTION_BINDINGS?: string;
  CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING?: string;
  CLAWROUTER_CONTENT_RETENTION_DEFAULT?: string;
  /** Isolate hot-cache max age in seconds (default 60); 0 disables admission/credential/budget caching. */
  CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS?: string;
  CLAWROUTER_DEPLOY_ENV?: string;
  [name: string]: unknown;
}

export interface AccessPolicy {
  budgetOverride?: BudgetOverride;
  enabled: boolean;
  generation: string;
  providers: string[];
  models?: string[] | null;
  poolStatus?: "hidden" | "visible";
  tenantId?: string | null;
  tokenRole?: string | null;
  monthlyBudgetMicros?: number | null;
  dailyBudgetMicros?: number | null;
  weeklyBudgetMicros?: number | null;
  limitHint?: string | null;
  serviceTiers?: import("../shared/service-tiers").PolicyServiceTiers | null;
  requestCostMicros?: number | null;
  requestCostsMicros?: Record<string, number> | null;
  budgetScope?: "policy" | "principal";
  budgetMode?: "reserve" | "soft";
  upstreamRetention?: import("../shared/upstream-retention.ts").UpstreamRetentionPolicy | null;
  inputPublication?: import("../shared/input-publication.ts").InputPublicationPolicy | null;
  retainRequestContent: boolean;
  grantRouting: GrantRoutingPolicy;
}

export interface AccessPolicyEntry { policyId: string; policy: AccessPolicy }

export interface ProxyCredential {
  /** Private administrator attestation. Never projected as caller authority. */
  copilotPublicIdentity?: import("./copilot-public-identity.ts").CopilotPublicIdentityAttestation;
  name?: string | null;
  enabled: boolean;
  secretSha256: string;
  policyId: string;
  policyGeneration: string;
  principalId?: string | null;
  expiresAt?: string | null;
  serviceTiers?: string[] | null;
}

export interface ProxyCredentialEntry { credentialId: string; credential: ProxyCredential }

export interface ProviderHealth {
  providerId: string;
  status: string;
  checkedAt: string;
  latencyMs?: number | null;
  statusCode?: number | null;
  error?: string | null;
}

export interface AccessUserRecord {
  budgetOverrides?: Record<string, BudgetOverride>;
  role?: "admin" | "user";
  tenantId?: string | null;
  enabled?: boolean | null;
  groups?: string[];
  contentRetentionDisabled?: boolean;
  assignmentState?: AssignmentState;
}

export interface AssignmentStateEntry { groups: string[]; revokeOnLoss: boolean }
export interface AssignmentState { version: 1; revision: string; assignments: Record<string, AssignmentStateEntry>; updatedAt: string | null }

export interface AccessControlUser { email: string; record: AccessUserRecord }

export interface AccessSession {
  budgetOverrides?: Record<string, BudgetOverride>;
  authenticated: true;
  auth: "cloudflare_access" | "local" | "admin_token";
  role: "admin" | "user";
  email: string;
  subject: string | null;
  tenantId: string;
  groups: string[];
  contentRetentionDisabled: boolean;
}

export interface OAuthState {
  state: string;
  verifier: string;
  actorEmail: string;
  grantKey: string;
  provider: string;
  priority?: number;
  weight?: number;
  redirectUri: string;
  expiresAtMs: number;
}

export interface UpstreamGrant {
  minimaxSearchBinding?: import("../shared/minimax-search-binding").MiniMaxSearchBinding | null;
  minimaxVideoBinding?: import("../shared/minimax-video-binding").MiniMaxVideoBinding | null;
  minimaxImageBinding?: import("../shared/minimax-image-binding").MiniMaxImageBinding | null;
  vertexAnthropicBinding?: import("./vertex-anthropic-binding.ts").VertexAnthropicBinding | null;
  minimaxAnthropicBinding?: MiniMaxAnthropicBinding | null;
  nativeMediaBinding?: import("../shared/native-media-binding.ts").NativeMediaBinding | null;
  version?: number;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  kind?: GrantKind;
  provider?: string | null;
  label?: string | null;
  credential?: string | null;
  credentials?: Record<string, string>;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenType?: string;
  expiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
  lastManualAuthorizationAt?: string | null;
  scopes?: string[];
  accountId?: string | null;
  subscription?: { plan?: string | null; subject?: string | null } | null;
  maintenance?: { keepWarm?: boolean } | null;
  credentialStore?: "durable_object";
  credentialGeneration?: number;
  credentialLineage?: string;
  credentialStatus?: "active" | "reauth_required";
  // False: refresh ready; null: uncertain outcome; timestamp: retry floor.
  // Explicit false clears a stale block when an owner overlays KV metadata.
  credentialRefreshBlockedUntil?: string | null | false;
  credentialProvenance?: "clawrouter_oauth" | "imported" | null;
  refreshDiagnosis?: import("../shared/contracts").GrantRefreshDiagnosis | null;
  hasCredential?: boolean;
  credentialFields?: string[];
  hasAccessToken?: boolean;
  hasRefreshToken?: boolean;
  refresh?: {
    tokenUrl: string;
    clientId?: string | null;
    clientIdConfig?: string | null;
    clientSecretConfig?: string | null;
    requestFormat?: "form" | "json";
    extraParams?: Record<string, string>;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
}

export interface GrantQuotaWindow {
  observedAt?: string;
  models?: string[] | null;
  id: string;
  kind: GrantQuotaKind;
  unit: string | null;
  window: string | null;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
}

export interface GrantRuntimeState {
  status: "available" | "limited" | "cooldown";
  observedAt: string;
  source: "provider_response" | "provider_probe";
  cooldownUntil: string | null;
  lastSignal: "quota" | "rate_limited" | "authentication";
  grantRevision: string | null;
  windows: GrantQuotaWindow[];
  // Successful quota probes replace only their declared window scopes. A trailing * is a collection prefix.
  windowSnapshots?: Record<string, { observedAt: string; ids: string[] }>;
  account?: GrantAccount;
  extraUsage?: GrantExtraUsage;
}

export interface AssignmentRule {
  version: number;
  enabled: boolean;
  kind: "exact_email" | "email_domain" | "github_org" | "github_team";
  subject: string;
  groups: string[];
  policyIds: string[];
  priority: number;
  revokeOnLoss: boolean;
  provenance: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AuthorizedIdentity {
  serviceTiers?: string[] | null;
  credentialId: string | null;
  principalId: string | null;
  authType: "proxy_key" | "access";
  policyId: string;
  policy: AccessPolicy;
  contentRetentionDisabled: boolean;
}

export interface UsageEvent {
  /** Reporting metadata only. Not used by budget settlement. */
  request_format?: string;
  /** Measured token/tool component only; never a reservation or reporting estimate. */
  reporting_known_cost_micros?: number | null;
  reporting_estimated_cost_micros?: number | null;
  reporting_estimate_reason?: string | null;
  reasoning_output_tokens?: number | null;
  realtime_usage?: { item_id?: string | null; unit_id: string; response_id: string | null; output_cap: number; text_input_tokens?: number; audio_input_tokens?: number; cached_text_input_tokens?: number; cached_audio_input_tokens?: number; text_output_tokens?: number; audio_output_tokens?: number };
  hosted_tool_calls?: { web_search: number };
  hosted_tool_calls_complete?: boolean;
  hosted_tool_cost_micros?: number | null;
  hosted_tool_pricing_ref?: string | null;
  image_usage?: { text_input_tokens: number; image_input_tokens: number; image_output_tokens: number };
  id: string;
  type: "clawrouter.usage.v1";
  occurred_at_ms: number;
  tenant_id: string;
  policy_id: string;
  credential_id: string | null;
  grant_key: string | null;
  grant_lane: GrantLane | null;
  principal_id: string | null;
  auth_type: string;
  session_id: string | null;
  agent_id: string | null;
  parent_agent_id: string | null;
  project_id: string | null;
  client: string | null;
  key_id: string;
  request_id: string;
  trace_id: string | null;
  span_id: string | null;
  compound_request_id: string | null;
  compound_request_stage: "fusion_adviser" | "fusion_synthesizer" | null;
  compound_request_index: number | null;
  compound_request_size: number | null;
  compound_request_started_at_ms: number | null;
  provider: string;
  capability: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  reserved_cost_micros: number;
  actual_cost_micros: number;
  reserved_input_tokens: number | null;
  reserved_output_tokens: number | null;
  pricing_ref: string | null;
  pricing_effective_at: string | null;
  cost_basis: string;
  requested_service_tier?: string | null;
  served_service_tier?: string | null;
  status_code: number | null;
  duration_ms: number | null;
  content_retained: boolean;
  content_ref: string | null;
  status: "success" | "provider_error" | "client_error" | "denied" | "timeout";
}

export type QueueMessage = UsageEvent | { kind: "budget_charge"; ledger: { objectName: string }; request: BudgetChargeRequest } | ({ kind: "budget_settlement"; request: BudgetSettleRequest } & (
  { ledger: { objectName: string } }
  // Queued jobs from earlier deployments still carry their original scope.
  | { tenant_id: string; policy_id: string; principal_id?: string | null }
));

export interface BudgetReserveRequest {
  policyId: string;
  windowKey: string;
  scopeKey?: string | null;
  limitMicros: number;
  costMicros: number;
  reservationId: string;
  capability: string;
  dispatched?: true;
}

export interface BudgetChargeRequest {
  chargeId: string;
  policyId: string;
  windowKey: string;
  scopeKey: string;
  amountMicros: number;
  capability: string;
}

export interface BudgetSettleRequest {
  reservationId: string;
  actualCostMicros: number;
}

export interface ContentRecord {
  version: "clawrouter.retained-request.v1";
  contentRef: string;
  requestId: string;
  occurredAtMs: number;
  expiresAtMs: number;
  tenantId: string;
  policyId: string;
  credentialId: string | null;
  principalId: string | null;
  provider: string;
  capability: string;
  model: string | null;
  body: unknown;
}
