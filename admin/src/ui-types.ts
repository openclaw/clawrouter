import type React from "react";
import type {
  AccessPolicy,
  AccessRole,
  AccessUser,
  AdminBootstrapResponse,
  AdminOverview,
  AdminTenantSummary,
  AdminUsageRow,
  AssignmentRule,
  BudgetStatus,
  ContentRetention,
  EntitlementsResponse,
  FusionConfig,
  PolicyBinding,
  ProviderAccess,
  ProviderConnection,
  ProviderReadiness,
  ProviderResponse,
  ProviderRow,
  ProviderUsageSummary,
  ProxyCredential,
  RetainedRequestContent,
  RouteCatalog,
  SessionResponse,
  UpstreamGrant,
  UsageAuditEvent,
  UsageSnapshot,
  UsageSummary,
} from "../../shared/contracts";

export type {
  AccessPolicy,
  AccessRole,
  AccessUser,
  AdminBootstrapResponse,
  AdminOverview,
  AdminTenantSummary,
  AdminUsageRow,
  AssignmentRule,
  BudgetStatus,
  ContentRetention,
  EntitlementsResponse,
  FusionConfig,
  PolicyBinding,
  ProviderAccess,
  ProviderConnection,
  ProviderReadiness,
  ProviderResponse,
  ProviderRow,
  ProviderUsageSummary,
  ProxyCredential,
  RetainedRequestContent,
  RouteCatalog,
  SessionResponse,
  UpstreamGrant,
  UsageAuditEvent,
  UsageSnapshot,
  UsageSummary,
} from "../../shared/contracts";

export type View = "home" | "catalog" | "playground" | "policies" | "users" | "usage";
export type Theme = "light" | "dark";
export type RefreshOptions = { background?: boolean };
export type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;
export type BrandIcon = { label?: string; title?: string; viewBox?: string; body?: string };

export interface ServiceItem {
  id: string;
  name: string;
  provider: string;
  kind: string;
  category: string;
  capabilities: string[];
  surfaces: string[];
  route: string;
  routeCount: number;
  models: number;
  modelIds: string[];
  access?: ProviderAccess;
  readiness?: ProviderReadiness;
  brandIcon?: BrandIcon;
}

export type OutcomeTone = "active" | "revoked" | "neutral";
export interface ServiceOutcome { label: string; detail: string; tone: OutcomeTone; playable: boolean; blocked: boolean }

export interface PolicyForm {
  policyId: string;
  tokenRole: string;
  tenantId: string;
  enabled: boolean;
  monthlyBudgetMicros: string;
  requestCostMicros: string;
  providers: string[];
  allProviders: boolean;
  retainRequestContent: boolean;
}

export interface AccessForm { email: string; tenantId: string; enabled: boolean; groups: string; policyIds: string[]; contentRetentionDisabled: boolean }
export interface CredentialForm { credentialId: string; policyId: string; principalId: string }
export interface BindingForm { policyId: string; principalType: "user" | "group"; principalId: string; enabled: boolean; priority: string }
export interface UpstreamGrantForm { scope: "policies" | "tenants"; scopeId: string; tokenRef: string; kind: UpstreamGrant["kind"]; provider: string; label: string; enabled: boolean; credential: string; credentialBundle: string; accessToken: string; refreshToken: string; accountId: string; expiresAt: string }
export interface AssignmentRuleForm { ruleId: string; enabled: boolean; kind: AssignmentRule["kind"]; subject: string; groups: string; policyIds: string[]; priority: string; revokeOnLoss: boolean; provenance: string }
export type AccessTab = "policies" | "credentials" | "bindings" | "upstream" | "assignments" | "fusion";

export interface PlaygroundForm {
  mode: "model" | "service";
  model: string;
  endpoint: "/v1/chat/completions" | "/v1/responses";
  serviceRoute: string;
  serviceMethod: string;
  servicePath: string;
  servicePayload: string;
  system: string;
  prompt: string;
  maxTokens: string;
  temperature: string;
}

export interface PlaygroundTurn { id: string; mode: PlaygroundForm["mode"]; prompt: string; response: string; rawResponse: string; request: string; provider: string; model: string; endpoint: string; status: number | null; durationMs: number; retention: string; error?: string }
export interface PlaygroundHttpResponse { ok: boolean; raw: string; status: number; statusText: string; contentType: string; retention: string }
