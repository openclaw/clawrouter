
const themeStorageKey = "clawrouter-theme";

export function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* storage can be unavailable in privacy-restricted contexts */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0d120f" : "#fbfcf8");
  try { window.localStorage.setItem(themeStorageKey, theme); } catch { /* preference still applies for this page */ }
}

export const initialTheme = readTheme();
applyTheme(initialTheme);

export const pathViews: Record<string, View> = {
  "/": "home",
  "/access": "policies",
  "/admin": "policies",
  "/catalog": "catalog",
  "/console": "catalog",
  "/dashboard": "home",
  "/dashboard/home": "home",
  "/dashboard/access": "policies",
  "/dashboard/catalog": "catalog",
  "/dashboard/playground": "playground",
  "/dashboard/usage": "usage",
  "/dashboard/users": "users",
  "/policies": "policies",
  "/playground": "playground",
  "/routes": "catalog",
  "/account": "users",
  "/usage": "usage",
  "/users": "users",
};

export const viewPaths: Record<View, string> = {
  home: "/dashboard/home",
  catalog: "/dashboard/catalog",
  playground: "/dashboard/playground",
  policies: "/dashboard/access",
  users: "/dashboard/users",
  usage: "/dashboard/usage",
};

export function initialViewFromPath(): View {
  return pathViews[window.location.pathname] ?? "catalog";
}

export function initialAccessTab(): AccessTab {
  const resource = new URLSearchParams(window.location.search).get("resource");
  return resource === "credentials" || resource === "bindings" || resource === "upstream" || resource === "assignments" ? resource : "policies";
}
export const demoDisabledProviderIds = new Set(["aws-bedrock", "cloudflare-ai-gateway"]);
export const demoMissingConfigProviderIds = new Set(["azure-openai"]);
export const demo = demoData();
export const demoServiceRoute = demo.routes.manifestProxy.find((route) => route.provider === "tavily") ?? demo.routes.manifestProxy[0];
export const demoServicePreset = playgroundServicePreset(demoServiceRoute);
export const emptyRoutes: RouteCatalog = { openaiCompatible: [], manifestProxy: [] };
export const emptySession: SessionResponse = { authenticated: false, auth: "access", role: "user", email: null, tenantId: "default" };
export const emptyUsageSnapshot: UsageSnapshot = {
  ledger: "unavailable",
  summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 },
  providers: [],
  events: [],
};

export const defaultPolicy: PolicyForm = {
  policyId: "svc_docs",
  tokenRole: "service",
  tenantId: "default",
  enabled: true,
  monthlyBudgetMicros: "100",
  requestCostMicros: "1000",
  providers: ["openai", "tavily"],
  allProviders: false,
  retainRequestContent: true,
};

export const defaultAccess: AccessForm = {
  email: "admin@example.com",
  tenantId: "default",
  enabled: true,
  groups: "",
  policyIds: [],
  contentRetentionDisabled: false,
};
export const defaultCredential: CredentialForm = { credentialId: "", policyId: "", principalId: "" };
export const defaultBinding: BindingForm = { policyId: "", principalType: "group", principalId: "", enabled: true, priority: "100" };
export const defaultUpstreamGrant: UpstreamGrantForm = { scope: "policies", scopeId: "", tokenRef: "", kind: "api_key", provider: "", label: "", enabled: true, credential: "", credentialBundle: "", accessToken: "", refreshToken: "", accountId: "", expiresAt: "" };
export const defaultAssignmentRule: AssignmentRuleForm = { ruleId: "", enabled: true, kind: "email_domain", subject: "", groups: "", policyIds: [], priority: "100", revokeOnLoss: true, provenance: "cloudflare_access" };

export const rolePresets = {
  sandbox: { budget: "5000000", request: "500", providers: ["openai", "openrouter"] },
  user: { budget: "50000000", request: "1000", providers: ["openai", "anthropic", "google-gemini", "tavily"] },
  service: { budget: "250000000", request: "1000", providers: [] },
  ops: { budget: "", request: "0", providers: [] },
};

export const navItems: Array<{ id: View; label: string; icon: IconComponent; section: "workspace" | "admin" }> = [
  { id: "home", label: "Dashboard", icon: LayoutDashboard, section: "workspace" },
  { id: "catalog", label: "Catalog", icon: Boxes, section: "workspace" },
  { id: "playground", label: "Playground", icon: FlaskConical, section: "workspace" },
  { id: "policies", label: "Access", icon: KeyRound, section: "admin" },
  { id: "users", label: "Users", icon: Users, section: "admin" },
  { id: "usage", label: "Usage", icon: BarChart3, section: "admin" },
];
export const adminViews = new Set<View>(["policies", "users", "usage"]);
import { BarChart3, Boxes, FlaskConical, KeyRound, LayoutDashboard, Users } from "lucide-react";
import { playgroundServicePreset } from "./domain";
import { demoData } from "./demo-data";
import type { AccessForm, AccessTab, AssignmentRuleForm, BindingForm, CredentialForm, IconComponent, PlaygroundHttpResponse, PolicyForm, RouteCatalog, SessionResponse, Theme, UpstreamGrantForm, UsageSnapshot, View } from "./ui-types";
