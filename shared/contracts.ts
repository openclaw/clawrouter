export interface ProviderRow {
  id: string;
  display_name: string;
  class: string;
  service_kind: string;
  meter?: string | null;
  capabilities: Array<{ id: string }>;
  auth?: { authorization?: { grantKind?: "oauth" | "subscription" } | null };
}

export interface ProviderResponse { providers: ProviderRow[] }

export interface RouteCatalog {
  openaiCompatible: Array<{ provider: string; models: Array<{ id: string; capabilities: string[]; endpoints: string[] }>; modelPrefixes?: string[]; endpoints: string[] }>;
  manifestProxy: Array<{ provider: string; endpoint: string; route: string; methods: string[]; pathParams?: string[]; requestFormat?: string; responseFormat?: string; sampleModel?: string | null; models?: Array<{ id: string; capabilities: string[] }>; streaming?: boolean | null }>;
}

export interface AccessPolicy {
  policyId: string;
  enabled: boolean;
  providers: string[];
  tenantId?: string | null;
  tokenRole?: string | null;
  monthlyBudgetMicros?: number | null;
  requestCostMicros?: number | null;
  retainRequestContent: boolean;
}

export interface ProxyCredential {
  credentialId: string;
  policyId: string;
  enabled: boolean;
  policyEnabled?: boolean;
  generationMatches?: boolean;
  active?: boolean;
  principalId?: string | null;
}

export interface ProviderConnection { providerId: string; enabled: boolean; label?: string | null }

export interface UpstreamGrant {
  key: string;
  scope: "policies" | "tenants";
  scopeId: string;
  tokenRef: string;
  version: number;
  enabled: boolean;
  kind: "api_key" | "oauth" | "subscription";
  provider?: string | null;
  label?: string | null;
  tokenType: string;
  expiresAt?: string | null;
  scopes: string[];
  accountId?: string | null;
  subscription?: { plan?: string | null; subject?: string | null } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
  hasCredential: boolean;
  credentialFields: string[];
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  refreshConfigured: boolean;
  usable: boolean;
}

export interface AssignmentRule {
  ruleId: string;
  version: number;
  enabled: boolean;
  kind: "exact_email" | "email_domain" | "github_org" | "github_team";
  subject: string;
  groups: string[];
  policyIds: string[];
  priority: number;
  revokeOnLoss: boolean;
  provenance: string;
  generatedGroup: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type AccessRole = "admin" | "user";
export interface ContentRetention { enabled: boolean; retentionDays: number; policyEnabled: boolean; userExempt: boolean }
export interface SessionResponse {
  authenticated: boolean;
  auth: string;
  role: AccessRole;
  email?: string | null;
  subject?: string | null;
  tenantId?: string | null;
  groups?: string[];
  entitlements?: { providers: ProviderAccess[] } | null;
  entitlementsError?: string | null;
  contentRetention?: ContentRetention;
}

export interface ProviderReadiness {
  id: string;
  displayName: string;
  class: string;
  serviceKind: string;
  requiredConfig: string[];
  optionalConfig: string[];
  missingConfig: string[];
  configPresent: boolean;
  oauthGrantRequired: boolean;
  oauthGrantCount: number;
  upstreamGrantCount: number;
  openaiCompatible: boolean;
  manifestRoutes: number;
  executableEndpoints?: string[];
  modelCount: number;
  connectionEnabled?: boolean;
  verified?: boolean;
  lastCheckedAt?: string | null;
  latencyMs?: number | null;
  executable: boolean;
  status: string;
  reasons: string[];
}

export interface ProviderAccess { provider: string; displayName: string; serviceKind: string; allowed: boolean; policies: string[]; readiness: ProviderReadiness }
export interface EntitlementsResponse { session: SessionResponse; providers: ProviderAccess[]; contentRetention: ContentRetention }
export interface AccessUser { email: string; role: AccessRole; tenantId: string; enabled: boolean; groups: string[]; contentRetentionDisabled: boolean }
export interface PolicyBinding { policyId: string; principalType: "user" | "group"; principalId: string; enabled: boolean; priority: number }

export interface AdminOverview {
  policiesTotal?: number;
  policiesActive?: number;
  keysTotal: number;
  keysActive: number;
  tenantsTotal: number;
  providerCount: number;
  openaiCompatibleProviders: number;
  manifestRoutes: number;
  monthlyBudgetMicros: number;
  requestCostMicros: number;
}

export interface AdminTenantSummary {
  tenantId: string;
  policies?: number;
  activePolicies?: number;
  keys: number;
  activeKeys: number;
  providers: string[];
  allProviders?: boolean;
  monthlyBudgetMicros: number;
  requestCostMicros: number;
}

export interface BudgetStatus { configured: boolean; ledger: string; windowKey?: string | null; limitMicros?: number | null; spentMicros?: number | null; remainingMicros?: number | null }
export interface AdminUsageRow { policyId?: string; kid: string; tenantId: string; enabled: boolean; providers: string[]; tokenRole?: string | null; monthlyBudgetMicros?: number | null; requestCostMicros?: number | null; budget: BudgetStatus }
export interface UsageSummary { requestCount: number; successCount: number; errorCount: number; inputTokens: number; outputTokens: number; totalTokens: number; actualCostMicros: number }
export interface ProviderUsageSummary { provider: string; requestCount: number; successCount: number; errorCount: number; totalTokens: number; actualCostMicros: number }
export interface UsageDailySummary { dayStartMs: number; requestCount: number; successCount: number; errorCount: number; totalTokens: number; actualCostMicros: number }
export interface UsageAuditEvent {
  id: string;
  type: string;
  occurred_at_ms: number;
  tenant_id: string;
  policy_id?: string | null;
  credential_id?: string | null;
  principal_id?: string | null;
  auth_type?: string | null;
  session_id?: string | null;
  agent_id?: string | null;
  parent_agent_id?: string | null;
  project_id?: string | null;
  client?: string | null;
  key_id?: string | null;
  request_id?: string | null;
  provider: string;
  capability?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  cached_input_tokens?: number | null;
  cache_write_input_tokens?: number | null;
  reserved_cost_micros: number;
  actual_cost_micros: number;
  reserved_input_tokens?: number | null;
  reserved_output_tokens?: number | null;
  pricing_ref?: string | null;
  pricing_effective_at?: string | null;
  cost_basis?: string | null;
  status_code?: number | null;
  duration_ms?: number | null;
  status: string;
  content_retained?: boolean;
  content_ref?: string | null;
}
export interface UsageSnapshot { ledger: string; summary: UsageSummary; providers: ProviderUsageSummary[]; daily?: UsageDailySummary[]; events: UsageAuditEvent[] }
export interface RetainedRequestContent { requestId: string; occurredAtMs: number; expiresAtMs: number; principalId?: string | null; provider: string; capability: string; model?: string | null; body: unknown }

export interface AdminBootstrapResponse {
  policies: AccessPolicy[];
  credentials: ProxyCredential[];
  connections: ProviderConnection[];
  users: AccessUser[];
  bindings: PolicyBinding[];
  providers: ProviderReadiness[];
  grants: UpstreamGrant[];
  rules: AssignmentRule[];
  overview: AdminOverview;
  tenants: AdminTenantSummary[];
}
