export interface ProviderSnapshot {
  version: string;
  providers: CompiledProvider[];
  capability_index: Record<string, Array<{ provider: string; endpoint: string; methods: string[] }>>;
  model_index: Record<string, { provider: string; upstream: string; capabilities: string[]; pricing_ref: string | null; pricing: ModelPricing | null }>;
}

export interface CompiledProvider {
  id: string; display_name: string; status: string; class: string; service_platform: string; service_kind: string;
  config_keys: string[]; optional_config_keys: string[]; auth: { schemes: AuthScheme[]; authorization: AuthorizationConfig | null; refresh: RefreshConfig | null; grantTransports: Record<string, { baseUrl?: string | null; endpointPaths: Record<string, string>; headers: Record<string, string> }> };
  auth_schemes: string[]; base_urls: Record<string, string>; routing: { nativePrefixes: string[]; modelPrefixes: string[]; baseUrlParam: string | null; serviceParam: string | null };
  native_prefixes: string[]; adapter: { request: string | null; response: string | null; stream: string | null; error: string | null; passthroughHeaders: string[]; injectHeaders: Record<string, string>; injectQuery: Record<string, string>; requestTransforms: { renameFields: Array<{ from: string; to: string; paths: string[]; upstreams: string[]; upstreamConfig: string | null }> } };
  capabilities: Array<{ id: string; endpoint: string; methods: string[] }>;
  endpoints: CompiledEndpoint[]; models: CompiledModel[]; billing: { meter: string | null; dimensions: string[]; counters: Array<{ name: string; source: string; unit?: string | null }> }; meter: string | null;
  quota: CompiledQuotaConfig;
}

export type GrantQuotaKind = "requests" | "tokens" | "input_tokens" | "output_tokens" | "credits" | "subscription" | "generic";
export interface CompiledQuotaWindow {
  id: string;
  kind: GrantQuotaKind;
  unit: string | null;
  window: string | null;
  limitHeaders: string[];
  remainingHeaders: string[];
  usedHeaders: string[];
  resetHeaders: string[];
  fixedLimit: number | null;
}
export interface CompiledQuotaProbeWindow {
  id: string;
  kind: GrantQuotaKind;
  unit: string | null;
  window: string | null;
  limitPointer: string | null;
  remainingPointer: string | null;
  usedPointer: string | null;
  resetPointer: string | null;
  fixedLimit: number | null;
}
export interface CompiledQuotaProbe {
  grantKinds: Array<NonNullable<UpstreamGrant["kind"]>>;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  windows: CompiledQuotaProbeWindow[];
}
export interface CompiledQuotaConfig { responseHeaders: CompiledQuotaWindow[]; probes: CompiledQuotaProbe[] }

export type AuthScheme =
  | { type: "bearer"; header: string; format: string; secretKind: string; required: boolean }
  | { type: "api_key"; header: string; secretKind: string }
  | { type: "query_api_key"; param: string; secretKind: string }
  | { type: "oauth"; provider: string | null; scopes: string[]; tokenRef: string | null }
  | { type: "sig_v4"; service: string; regionParam: string | null }
  | { type: "cloudflare_binding" };

export interface AuthorizationConfig { authorizeUrl: string; tokenUrl: string; clientId: string | null; clientIdConfig: string | null; clientSecretConfig: string | null; scopes: string[]; grantKind: string; extraAuthorizeParams: Record<string, string>; extraTokenParams: Record<string, string>; accountIdJsonPointer: string | null; subscriptionPlanJsonPointer: string | null }
export interface RefreshConfig { tokenUrl: string; clientId: string | null; clientIdConfig: string | null; clientSecretConfig: string | null; extraParams: Record<string, string> }
export interface LongContextPricing { thresholdInputTokens: number; inputMicrosPerMillion: number; outputMicrosPerMillion: number; cachedInputMicrosPerMillion: number | null; cacheWriteInputMicrosPerMillion: number | null; cacheWrite5mInputMicrosPerMillion: number | null; cacheWrite1hInputMicrosPerMillion: number | null }
export interface ModelPricing { effectiveAt: string; source: string; inputMicrosPerMillion: number; outputMicrosPerMillion: number; cachedInputMicrosPerMillion: number | null; cacheWriteInputMicrosPerMillion: number | null; cacheWrite5mInputMicrosPerMillion: number | null; cacheWrite1hInputMicrosPerMillion: number | null; maxInputTokens: number; maxRequestInputTokens: number | null; defaultMaxOutputTokens: number; inputTokenOverhead: number; longContext: LongContextPricing | null }
export interface CompiledModel { id: string; upstream: string; capabilities: string[]; pricing_ref: string | null; pricing: ModelPricing | null }
export interface CompiledEndpoint { id: string; method: string; methods: string[]; path: string; native_proxy: boolean; auth: string | null; headers: Record<string, string>; request_headers: string[]; response_headers: string[]; query: Record<string, string>; path_params: string[]; path_param_styles: Record<string, string>; request_format: string; response_format: string; streaming: string | null; timeout_ms: number | null }

export interface Env {
  POLICY_KV: KVNamespace;
  BUDGET_LEDGER: DurableObjectNamespace;
  USAGE_LEDGER: DurableObjectNamespace;
  ACCESS_CONTROL: DurableObjectNamespace;
  USAGE_QUEUE: Queue<QueueMessage>;
  CONTENT_ARCHIVE: R2Bucket;
  ASSETS: Fetcher;
  CLAWROUTER_ADMIN_TOKEN_SHA256?: string;
  CLAWROUTER_ACCESS_TEAM_DOMAIN?: string;
  CLAWROUTER_ACCESS_AUD?: string;
  CLAWROUTER_ACCESS_ADMIN_EMAILS?: string;
  CLAWROUTER_ACCESS_ADMIN_DOMAINS?: string;
  CLAWROUTER_ACCESS_DEFAULT_TENANT?: string;
  CLAWROUTER_LOCAL_AUTH?: string;
  CLAWROUTER_LOCAL_ADMIN_EMAIL?: string;
  CLAWROUTER_CONTENT_RETENTION_DEFAULT?: string;
  CLAWROUTER_DEPLOY_ENV?: string;
  [name: string]: unknown;
}

export interface AccessPolicy {
  enabled: boolean;
  generation: string;
  providers: string[];
  tenantId?: string | null;
  tokenRole?: string | null;
  monthlyBudgetMicros?: number | null;
  requestCostMicros?: number | null;
  budgetScope?: "policy" | "principal";
  retainRequestContent: boolean;
  grantRouting: GrantRoutingPolicy;
}

export type GrantSelectionStrategy = "priority" | "round_robin" | "least_used" | "most_remaining" | "weighted_random";
export type GrantStickiness = "none" | "identity" | "session";
export interface GrantRoutingPolicy {
  strategy: GrantSelectionStrategy;
  stickiness: GrantStickiness;
  failover: boolean;
  staleState: "allow" | "deny";
  staleAfterSeconds: number;
  eligibleGrants: Record<string, string[]>;
}

export interface AccessPolicyEntry { policyId: string; policy: AccessPolicy }

export interface ProxyCredential {
  enabled: boolean;
  secretSha256: string;
  policyId: string;
  policyGeneration: string;
  principalId?: string | null;
}

export interface ProxyCredentialEntry { credentialId: string; credential: ProxyCredential }

export interface ProviderConnection {
  providerId: string;
  enabled: boolean;
  label?: string | null;
}

export interface ProviderHealth {
  providerId: string;
  status: string;
  checkedAt: string;
  latencyMs?: number | null;
  statusCode?: number | null;
  error?: string | null;
}

export interface AccessUserRecord {
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
  authenticated: true;
  auth: "cloudflare_access" | "local" | "admin_token";
  role: "admin" | "user";
  email: string;
  subject: string | null;
  tenantId: string;
  groups: string[];
  contentRetentionDisabled: boolean;
}

export interface PolicyBinding {
  policyId: string;
  principalType: "user" | "group";
  principalId: string;
  enabled: boolean;
  priority: number;
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
  version?: number;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  kind?: "api_key" | "oauth" | "subscription";
  provider?: string | null;
  label?: string | null;
  credential?: string | null;
  credentials?: Record<string, string>;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenType?: string;
  expiresAt?: string | null;
  scopes?: string[];
  accountId?: string | null;
  subscription?: { plan?: string | null; subject?: string | null } | null;
  refresh?: {
    tokenUrl: string;
    clientId?: string | null;
    clientIdConfig?: string | null;
    clientSecretConfig?: string | null;
    extraParams?: Record<string, string>;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
}

export interface GrantQuotaWindow {
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
  credentialId: string | null;
  principalId: string | null;
  authType: "proxy_key" | "access";
  policyId: string;
  policy: AccessPolicy;
  contentRetentionDisabled: boolean;
}

export interface UsageEvent {
  id: string;
  type: "clawrouter.usage.v1";
  occurred_at_ms: number;
  tenant_id: string;
  policy_id: string;
  credential_id: string | null;
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
  status_code: number | null;
  duration_ms: number | null;
  content_retained: boolean;
  content_ref: string | null;
  status: "success" | "provider_error" | "client_error" | "denied" | "timeout";
}

export type QueueMessage = UsageEvent | { kind: "budget_settlement"; tenant_id: string; policy_id: string; principal_id?: string | null; request: BudgetSettleRequest };

export interface BudgetReserveRequest {
  policyId: string;
  windowKey: string;
  limitMicros: number;
  costMicros: number;
  reservationId: string;
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
