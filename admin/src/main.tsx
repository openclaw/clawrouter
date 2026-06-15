import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart3,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleSlash2,
  FlaskConical,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  ServerCog,
  ShieldCheck,
  Users,
} from "lucide-react";
import providerIconManifest from "../../crates/edge/src/provider-icons.json";
import {
  accessFormFromUser,
  accessMap,
  bindingFormFromBinding,
  bindingKey,
  currencyInput,
  effectiveAccess,
  errorMessage,
  grantNamesForService,
  optionalCurrencyMicros,
  optionalNumber,
  parseGroups,
  playgroundAccessEndpoint,
  playgroundBlockedForService,
  playgroundBlocker,
  playgroundPayload,
  policyCoversProvider,
  policyUsageFallback,
  readinessLabel,
  readinessMap,
  reconcileDirectUserBindings,
  routeKey,
  serviceOutcome,
  tenantSummaryFallback,
  unique,
} from "./domain";
import "./style.css";

type View = "catalog" | "playground" | "policies" | "users" | "usage";

const pathViews: Record<string, View> = {
  "/": "catalog",
  "/access": "policies",
  "/admin": "policies",
  "/catalog": "catalog",
  "/console": "catalog",
  "/dashboard": "catalog",
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

const viewPaths: Record<View, string> = {
  catalog: "/dashboard/catalog",
  playground: "/dashboard/playground",
  policies: "/dashboard/access",
  users: "/dashboard/users",
  usage: "/dashboard/usage",
};

function initialViewFromPath(): View {
  return pathViews[window.location.pathname] ?? "catalog";
}

function initialAccessTab(): AccessTab {
  const resource = new URLSearchParams(window.location.search).get("resource");
  return resource === "credentials" || resource === "bindings" ? resource : "policies";
}
type AccessRole = "admin" | "user";
type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;
type BrandIcon = { label?: string; title?: string; viewBox?: string; body?: string };

interface ProviderRow {
  id: string;
  display_name: string;
  class: string;
  service_kind: string;
  meter?: string | null;
  capabilities: Array<{ id: string }>;
}

interface ProviderResponse {
  providers: ProviderRow[];
}

interface RouteCatalog {
  openaiCompatible: Array<{
    provider: string;
    models: Array<{ id: string; capabilities: string[]; endpoints: string[] }>;
    modelPrefixes?: string[];
    endpoints: string[];
  }>;
  manifestProxy: Array<{
    provider: string;
    endpoint: string;
    route: string;
    methods: string[];
    pathParams?: string[];
    streaming?: boolean | null;
  }>;
}

interface AccessPolicy {
  policyId: string;
  enabled: boolean;
  providers: string[];
  tenantId?: string | null;
  tokenRole?: string | null;
  monthlyBudgetMicros?: number | null;
  requestCostMicros?: number | null;
}

interface ProxyCredential {
  credentialId: string;
  policyId: string;
  enabled: boolean;
}

interface ProviderConnection {
  providerId: string;
  enabled: boolean;
  label?: string | null;
}

interface SessionResponse {
  authenticated: boolean;
  auth: string;
  role: AccessRole;
  email?: string | null;
  subject?: string | null;
  tenantId?: string | null;
  groups?: string[];
  entitlements?: { providers: ProviderAccess[] } | null;
  entitlementsError?: string | null;
}

interface ProviderReadiness {
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
  openaiCompatible: boolean;
  manifestRoutes: number;
  modelCount: number;
  connectionEnabled?: boolean;
  verified?: boolean;
  lastCheckedAt?: string | null;
  latencyMs?: number | null;
  executable: boolean;
  status: string;
  reasons: string[];
}

interface ProviderAccess {
  provider: string;
  displayName: string;
  serviceKind: string;
  allowed: boolean;
  policies: string[];
  readiness: ProviderReadiness;
}

interface EntitlementsResponse {
  session: SessionResponse;
  providers: ProviderAccess[];
}

interface AccessUser {
  email: string;
  role: AccessRole;
  tenantId: string;
  enabled: boolean;
  groups: string[];
}

interface PolicyBinding {
  policyId: string;
  principalType: "user" | "group";
  principalId: string;
  enabled: boolean;
  priority: number;
}

interface AdminOverview {
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

interface AdminTenantSummary {
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

interface BudgetStatus {
  configured: boolean;
  ledger: string;
  windowKey?: string | null;
  limitMicros?: number | null;
  spentMicros?: number | null;
  remainingMicros?: number | null;
}

interface AdminUsageRow {
  policyId?: string;
  kid: string;
  tenantId: string;
  enabled: boolean;
  providers: string[];
  tokenRole?: string | null;
  monthlyBudgetMicros?: number | null;
  requestCostMicros?: number | null;
  budget: BudgetStatus;
}

interface UsageSummary {
  requestCount: number;
  successCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCostMicros: number;
}

interface ProviderUsageSummary {
  provider: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  totalTokens: number;
  actualCostMicros: number;
}

interface UsageAuditEvent {
  id: string;
  type: string;
  occurred_at_ms: number;
  tenant_id: string;
  policy_id?: string | null;
  credential_id?: string | null;
  principal_id?: string | null;
  auth_type?: string | null;
  key_id?: string | null;
  request_id?: string | null;
  provider: string;
  capability?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  reserved_cost_micros: number;
  actual_cost_micros: number;
  status_code?: number | null;
  duration_ms?: number | null;
  status: string;
}

interface UsageSnapshot {
  ledger: string;
  summary: UsageSummary;
  providers: ProviderUsageSummary[];
  events: UsageAuditEvent[];
}

interface ServiceItem {
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

type OutcomeTone = "active" | "revoked" | "neutral";

interface ServiceOutcome {
  label: string;
  detail: string;
  tone: OutcomeTone;
  playable: boolean;
  blocked: boolean;
}

interface PolicyForm {
  policyId: string;
  tokenRole: string;
  tenantId: string;
  enabled: boolean;
  monthlyBudgetMicros: string;
  requestCostMicros: string;
  providers: string[];
  allProviders: boolean;
}

interface AccessForm {
  email: string;
  tenantId: string;
  enabled: boolean;
  groups: string;
  policyIds: string[];
}

interface CredentialForm {
  credentialId: string;
  policyId: string;
}

interface BindingForm {
  policyId: string;
  principalType: "user" | "group";
  principalId: string;
  enabled: boolean;
  priority: string;
}

type AccessTab = "policies" | "credentials" | "bindings";

interface PlaygroundForm {
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

const demoDisabledProviderIds = new Set(["aws-bedrock", "cloudflare-ai-gateway"]);
const demoMissingConfigProviderIds = new Set(["azure-openai"]);
const demo = demoData();
const demoServiceRoute = demo.routes.manifestProxy.find((route) => route.provider === "tavily") ?? demo.routes.manifestProxy[0];
const emptyRoutes: RouteCatalog = { openaiCompatible: [], manifestProxy: [] };
const emptySession: SessionResponse = { authenticated: false, auth: "access", role: "user", email: null, tenantId: "default" };
const emptyUsageSnapshot: UsageSnapshot = {
  ledger: "unavailable",
  summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 },
  providers: [],
  events: [],
};

const defaultPolicy: PolicyForm = {
  policyId: "svc_docs",
  tokenRole: "service",
  tenantId: "default",
  enabled: true,
  monthlyBudgetMicros: "100",
  requestCostMicros: "1000",
  providers: ["openai", "tavily"],
  allProviders: false,
};

const defaultAccess: AccessForm = {
  email: "admin@example.com",
  tenantId: "default",
  enabled: true,
  groups: "",
  policyIds: [],
};
const defaultCredential: CredentialForm = { credentialId: "", policyId: "" };
const defaultBinding: BindingForm = { policyId: "", principalType: "group", principalId: "", enabled: true, priority: "100" };

const rolePresets = {
  sandbox: { budget: "5000000", request: "500", providers: ["openai", "openrouter"] },
  user: { budget: "50000000", request: "1000", providers: ["openai", "anthropic", "google-gemini", "tavily"] },
  service: { budget: "250000000", request: "1000", providers: [] },
  ops: { budget: "", request: "0", providers: [] },
};

const navItems: Array<{ id: View; label: string; icon: IconComponent; section: "workspace" | "admin" }> = [
  { id: "catalog", label: "Catalog", icon: Boxes, section: "workspace" },
  { id: "playground", label: "Playground", icon: FlaskConical, section: "workspace" },
  { id: "policies", label: "Access", icon: KeyRound, section: "admin" },
  { id: "users", label: "Users", icon: Users, section: "admin" },
  { id: "usage", label: "Usage", icon: BarChart3, section: "admin" },
];
const adminViews = new Set<View>(["policies", "users", "usage"]);

function App() {
  const [view, setView] = useState<View>(initialViewFromPath);
  const gatewayOrigin = window.location.origin;
  const allowDemo = isLocalDemoAllowed();
  const [session, setSession] = useState<SessionResponse>(allowDemo ? demo.session : emptySession);
  const [providers, setProviders] = useState<ProviderRow[]>(allowDemo ? demo.providers : []);
  const [routes, setRoutes] = useState<RouteCatalog>(allowDemo ? demo.routes : emptyRoutes);
  const [keys, setKeys] = useState<AccessPolicy[]>(allowDemo ? demo.keys : []);
  const [credentials, setCredentials] = useState<ProxyCredential[]>(allowDemo ? demo.credentials : []);
  const [connections, setConnections] = useState<ProviderConnection[]>(allowDemo ? demo.connections : []);
  const [policyDataLoaded, setPolicyDataLoaded] = useState(allowDemo);
  const [users, setUsers] = useState<AccessUser[]>(allowDemo ? demo.users : []);
  const [bindings, setBindings] = useState<PolicyBinding[]>(allowDemo ? demo.bindings : []);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(allowDemo ? demo.overview : null);
  const [tenantSummaries, setTenantSummaries] = useState<AdminTenantSummary[]>(allowDemo ? demo.tenants : []);
  const [usageRows, setUsageRows] = useState<AdminUsageRow[]>(allowDemo ? demo.usageRows : []);
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot>(allowDemo ? demo.usage : emptyUsageSnapshot);
  const [usageLoaded, setUsageLoaded] = useState(allowDemo);
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | null>(allowDemo ? demo.entitlements : null);
  const [providerReadiness, setProviderReadiness] = useState<Record<string, ProviderReadiness>>(allowDemo ? readinessMap(demo.entitlements.providers.map((item) => item.readiness)) : {});
  const [policyForm, setPolicyForm] = useState<PolicyForm>(allowDemo && demo.keys[0] ? policyFormFromPolicy(demo.keys[0]) : defaultPolicy);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(allowDemo && demo.keys[0] ? { credentialId: "", policyId: demo.keys[0].policyId } : defaultCredential);
  const [bindingForm, setBindingForm] = useState<BindingForm>(allowDemo && demo.keys[0] ? { ...defaultBinding, policyId: demo.keys[0].policyId } : defaultBinding);
  const [accessTab, setAccessTab] = useState<AccessTab>(initialAccessTab);
  const [accessForm, setAccessForm] = useState<AccessForm>(allowDemo && demo.users[0] ? accessFormFromUser(demo.users[0], demo.bindings) : defaultAccess);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedServiceId, setSelectedServiceId] = useState(demo.services[0]?.id ?? "");
  const [selectedPolicyId, setSelectedPolicyId] = useState(allowDemo ? demo.keys[0]?.policyId ?? "" : "");
  const [selectedCredentialId, setSelectedCredentialId] = useState(allowDemo ? demo.credentials[0]?.credentialId ?? "" : "");
  const [selectedBindingKey, setSelectedBindingKey] = useState(allowDemo ? bindingKey(demo.bindings[0]) : "");
  const [selectedUserEmail, setSelectedUserEmail] = useState(demo.users[0]?.email ?? "");
  const [status, setStatus] = useState(allowDemo ? "local demo data loaded" : "loading");
  const [demoMode, setDemoMode] = useState(allowDemo);
  const [issuedKey, setIssuedKey] = useState("");
  const [policyError, setPolicyError] = useState("");
  const [userError, setUserError] = useState("");
  const [playgroundError, setPlaygroundError] = useState("");
  const [playground, setPlayground] = useState<PlaygroundForm>({
    mode: "model",
    model: catalogModels(demo.routes)[0]?.id ?? "",
    endpoint: "/v1/chat/completions",
    serviceRoute: routeKey(demoServiceRoute),
    serviceMethod: demoServiceRoute?.methods[0] ?? "POST",
    servicePath: "search",
    servicePayload: '{\n  "query": "test"\n}',
    system: "You are concise and useful.",
    prompt: "Say hello from ClawRouter in one short sentence.",
    maxTokens: "128",
    temperature: "0.7",
  });
  const [playgroundResult, setPlaygroundResult] = useState("Run a request to see the raw response.");
  const [requestMode, setRequestMode] = useState<"json" | "curl">("json");

  const accessByProvider = useMemo(() => accessMap(entitlements), [entitlements]);
  const services = useMemo(() => serviceItems(providers, routes, providerReadiness, accessByProvider), [accessByProvider, providerReadiness, providers, routes]);
  const models = useMemo(() => catalogModels(routes), [routes]);
  const serviceRoutes = useMemo(() => routes.manifestProxy, [routes]);
  const kinds = useMemo(() => ["all", ...Array.from(new Set(services.map((item) => item.kind))).sort()], [services]);
  const filteredServices = useMemo(() => {
    return services.filter((item) => (kind === "all" || item.kind === kind) && matchesServiceQuery(item, query));
  }, [kind, query, services]);
  const selectedService = services.find((item) => item.id === selectedServiceId) ?? services[0];
  const selectedPolicy = keys.find((key) => key.policyId === selectedPolicyId);
  const selectedCredential = credentials.find((credential) => credential.credentialId === selectedCredentialId);
  const selectedBinding = bindings.find((binding) => bindingKey(binding) === selectedBindingKey);
  const selectedUser = selectedUserEmail ? users.find((user) => user.email === selectedUserEmail) : undefined;
  const selectedModel = models.find((model) => model.id === playground.model) ?? models[0];
  const selectedServiceRoute = serviceRoutes.find((route) => routeKey(route) === playground.serviceRoute) ?? serviceRoutes[0];
  const busy = status === "loading" || ["saving", "running", "revoking", "issuing", "enabling", "disabling"].some((prefix) => status.startsWith(prefix));
  const statusTone = statusKind(status);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const onPopState = () => setView(initialViewFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (status !== "loading" && session.role !== "admin" && adminViews.has(view)) navigateTo("catalog", true);
  }, [session.role, status, view]);

  useEffect(() => {
    if (view === "usage" && session.role === "admin" && policyDataLoaded && !demoMode && !usageLoaded) {
      void refreshUsageLedger();
    }
  }, [demoMode, policyDataLoaded, session.role, usageLoaded, usageRefreshKey, view]);

  useEffect(() => {
    if (models.length && !models.some((model) => model.id === playground.model)) {
      setPlayground((current) => ({ ...current, model: models[0].id }));
    }
  }, [models, playground.model]);

  useEffect(() => {
    if (serviceRoutes.length && !serviceRoutes.some((route) => routeKey(route) === playground.serviceRoute)) {
      const route = serviceRoutes[0];
      setPlayground((current) => ({ ...current, serviceRoute: routeKey(route), serviceMethod: route.methods[0] ?? "POST" }));
    }
  }, [playground.serviceRoute, serviceRoutes]);

  async function refresh() {
    try {
      setStatus("loading");
      setPolicyDataLoaded(false);
      const [sessionData, providerData, routeData] = await Promise.all([
        request<SessionResponse>(gatewayOrigin, "/v1/session"),
        request<ProviderResponse>(gatewayOrigin, "/v1/providers"),
        request<RouteCatalog>(gatewayOrigin, "/v1/routes"),
      ]);
      setSession(sessionData);
      setProviders(providerData.providers);
      setRoutes(routeData);
      let refreshWarnings = sessionData.entitlementsError ? [`entitlements unavailable: ${sessionData.entitlementsError}`] : [];
      const sessionEntitlements = sessionData.entitlements
        ? { session: sessionData, providers: sessionData.entitlements.providers }
        : null;
      if (sessionEntitlements) {
        setEntitlements(sessionEntitlements);
        setProviderReadiness(readinessMap(sessionEntitlements.providers.map((item) => item.readiness)));
      } else {
        const entitlementResult = await settled(() => request<EntitlementsResponse>(gatewayOrigin, "/v1/entitlements"));
        if (entitlementResult.ok) {
          setEntitlements(entitlementResult.value);
          setProviderReadiness(readinessMap(entitlementResult.value.providers.map((item) => item.readiness)));
        } else {
          setEntitlements(null);
          refreshWarnings = [...refreshWarnings, `entitlements unavailable: ${entitlementResult.error}`];
        }
      }
      if (sessionData.role === "admin") {
        const [policyData, credentialData, connectionData, userData, bindingData, readinessData] = await Promise.all([
          request<{ policies: AccessPolicy[] }>(gatewayOrigin, "/v1/admin/policies"),
          request<{ credentials: ProxyCredential[] }>(gatewayOrigin, "/v1/admin/credentials"),
          request<{ connections: ProviderConnection[] }>(gatewayOrigin, "/v1/admin/connections"),
          request<{ users: AccessUser[] }>(gatewayOrigin, "/v1/admin/access-users"),
          request<{ bindings: PolicyBinding[] }>(gatewayOrigin, "/v1/admin/policy-bindings"),
          request<{ providers: ProviderReadiness[] }>(gatewayOrigin, "/v1/admin/provider-status"),
        ]);
        setKeys(policyData.policies);
        setCredentials(credentialData.credentials);
        setConnections(connectionData.connections);
        const refreshedPolicy = policyData.policies.find((policy) => policy.policyId === selectedPolicyId) ?? policyData.policies[0];
        setSelectedPolicyId(refreshedPolicy?.policyId ?? "");
        setPolicyForm(refreshedPolicy ? policyFormFromPolicy(refreshedPolicy) : { ...defaultPolicy, policyId: "", tenantId: sessionData.tenantId ?? "default", providers: [...defaultPolicy.providers] });
        const refreshedCredential = credentialData.credentials.find((credential) => credential.credentialId === selectedCredentialId) ?? credentialData.credentials[0];
        setSelectedCredentialId(refreshedCredential?.credentialId ?? "");
        setCredentialForm({ credentialId: "", policyId: refreshedPolicy?.policyId ?? policyData.policies[0]?.policyId ?? "" });
        const refreshedBinding = bindingData.bindings.find((binding) => bindingKey(binding) === selectedBindingKey) ?? bindingData.bindings[0];
        setSelectedBindingKey(refreshedBinding ? bindingKey(refreshedBinding) : "");
        setBindingForm(refreshedBinding ? bindingFormFromBinding(refreshedBinding) : { ...defaultBinding, policyId: refreshedPolicy?.policyId ?? "" });
        setUsers(userData.users);
        setBindings(bindingData.bindings);
        const refreshedUser = userData.users.find((user) => user.email === selectedUserEmail) ?? userData.users[0];
        setSelectedUserEmail(refreshedUser?.email ?? "");
        setAccessForm(refreshedUser ? accessFormFromUser(refreshedUser, bindingData.bindings) : defaultAccess);
        setProviderReadiness((current) => ({ ...current, ...readinessMap(readinessData.providers) }));
        const [overviewResult, tenantResult] = await Promise.all([
          settled(() => request<AdminOverview>(gatewayOrigin, "/v1/admin/overview")),
          settled(() => request<{ tenants: AdminTenantSummary[] }>(gatewayOrigin, "/v1/admin/tenants")),
        ]);
        if (overviewResult.ok) {
          setAdminOverview(overviewResult.value);
        } else {
          setAdminOverview(null);
          refreshWarnings = [...refreshWarnings, `overview unavailable: ${overviewResult.error}`];
        }
        if (tenantResult.ok) {
          setTenantSummaries(tenantResult.value.tenants);
        } else {
          setTenantSummaries(tenantSummaryFallback(policyData.policies));
          refreshWarnings = [...refreshWarnings, `tenant summary unavailable: ${tenantResult.error}`];
        }
        setUsageRows([]);
        setUsageSnapshot(emptyUsageSnapshot);
        setUsageLoaded(false);
        setPolicyDataLoaded(true);
        if (view === "usage") setUsageRefreshKey((current) => current + 1);
      } else {
        const user = {
          email: sessionData.email ?? "access-user",
          role: sessionData.role,
          tenantId: sessionData.tenantId ?? "default",
          enabled: sessionData.authenticated,
          groups: sessionData.groups ?? [],
        };
        setKeys([]);
        setCredentials([]);
        setConnections([]);
        setPolicyDataLoaded(false);
        setUsers([user]);
        setBindings([]);
        setAdminOverview(null);
        setTenantSummaries([]);
        setUsageRows([]);
        setUsageSnapshot(emptyUsageSnapshot);
        setUsageLoaded(false);
        setSelectedUserEmail(user.email);
        setAccessForm(accessFormFromUser(user, []));
      }
      setDemoMode(false);
      setStatus(refreshWarnings.length ? refreshWarnings.join("; ") : "connected");
    } catch (error) {
      const message = errorMessage(error);
      if (allowDemo) {
        setSession(demo.session);
        setProviders(demo.providers);
        setRoutes(demo.routes);
        setKeys(demo.keys);
        setCredentials(demo.credentials);
        setConnections(demo.connections);
        setPolicyDataLoaded(true);
        setUsers(demo.users);
        setBindings(demo.bindings);
        setAdminOverview(demo.overview);
        setTenantSummaries(demo.tenants);
        setUsageRows(demo.usageRows);
        setUsageSnapshot(demo.usage);
        setUsageLoaded(true);
        setEntitlements(demo.entitlements);
        setProviderReadiness(readinessMap(demo.entitlements.providers.map((item) => item.readiness)));
        setSelectedPolicyId(demo.keys[0]?.policyId ?? "");
        setPolicyForm(demo.keys[0] ? policyFormFromPolicy(demo.keys[0]) : defaultPolicy);
        setSelectedCredentialId(demo.credentials[0]?.credentialId ?? "");
        setCredentialForm({ credentialId: "", policyId: demo.keys[0]?.policyId ?? "" });
        setSelectedBindingKey(demo.bindings[0] ? bindingKey(demo.bindings[0]) : "");
        setBindingForm(demo.bindings[0] ? bindingFormFromBinding(demo.bindings[0]) : defaultBinding);
        setSelectedUserEmail(demo.users[0]?.email ?? "");
        setAccessForm(demo.users[0] ? accessFormFromUser(demo.users[0], demo.bindings) : defaultAccess);
        setDemoMode(true);
        setStatus("local demo data loaded");
        return;
      }
      setDemoMode(false);
      setStatus(`load error: ${message}`);
    }
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      setStatus("saving policy");
      if (!policyForm.allProviders && !policyForm.providers.length) throw new Error("select at least one service");
      if (!/^[A-Za-z0-9_]{4,}$/.test(policyForm.policyId)) throw new Error("policy id must use 4 or more letters, numbers, or underscores");
      const existingPolicy = keys.some((key) => key.policyId === policyForm.policyId);
      if (existingPolicy && selectedPolicyId !== policyForm.policyId) throw new Error("policy id already exists; select it from the policy list to edit it");
      const next: AccessPolicy = {
        policyId: policyForm.policyId,
        enabled: policyForm.enabled,
        providers: policyForm.allProviders ? [] : policyForm.providers,
        tenantId: policyForm.tenantId || "default",
        tokenRole: policyForm.tokenRole || null,
        monthlyBudgetMicros: optionalCurrencyMicros(policyForm.monthlyBudgetMicros) ?? null,
        requestCostMicros: optionalNumber(policyForm.requestCostMicros) ?? null,
      };
      if (demoMode) {
        applyDemoKeys((current) => [next, ...current.filter((key) => key.policyId !== next.policyId)]);
        setSelectedPolicyId(next.policyId);
        setStatus("saved policy");
        return;
      }
      await request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyForm.policyId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...next, allProviders: policyForm.allProviders }),
      });
      await refresh();
      setSelectedPolicyId(next.policyId);
      setPolicyForm(policyFormFromPolicy(next));
      setStatus("saved policy");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }

  async function issueCredential(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      const policyId = credentialForm.policyId || selectedPolicyId;
      if (!keys.some((policy) => policy.policyId === policyId)) throw new Error("select a policy for this credential");
      const credentialId = credentialForm.credentialId.trim() || `${policyId}_${Date.now().toString(36)}`;
      if (!/^[A-Za-z0-9_]{4,}$/.test(credentialId)) throw new Error("credential id must use 4 or more letters, numbers, or underscores");
      if (credentials.some((credential) => credential.credentialId === credentialId)) throw new Error("credential id already exists");
      setStatus("issuing credential");
      const secret = generateSecret();
      const next: ProxyCredential = { credentialId, policyId, enabled: true };
      if (demoMode) {
        setCredentials((current) => [next, ...current]);
      } else {
        await request<ProxyCredential>(gatewayOrigin, `/v1/admin/credentials/${encodeURIComponent(credentialId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, policyId, secretSha256: await sha256Hex(secret) }),
        });
        await refresh();
      }
      setSelectedCredentialId(credentialId);
      setCredentialForm({ credentialId: "", policyId });
      setIssuedKey(`clawrouter-live-${credentialId}-${secret}`);
      setStatus("issued credential");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }

  async function revokeCredential(credentialId: string) {
    try {
      setStatus(`revoking ${credentialId}`);
      if (demoMode) {
        setCredentials((current) => current.map((credential) => credential.credentialId === credentialId ? { ...credential, enabled: false } : credential));
      } else {
        await request<ProxyCredential>(gatewayOrigin, `/v1/admin/credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST" });
        await refresh();
      }
      setIssuedKey("");
      setStatus(`revoked ${credentialId}`);
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }

  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    try {
      setPolicyError("");
      const principalId = bindingForm.principalId.trim().toLowerCase();
      if (!principalId) throw new Error("principal is required");
      if (!bindingForm.policyId) throw new Error("select a policy");
      const next: PolicyBinding = {
        policyId: bindingForm.policyId,
        principalType: bindingForm.principalType,
        principalId,
        enabled: bindingForm.enabled,
        priority: optionalNumber(bindingForm.priority) ?? 100,
      };
      setStatus("saving binding");
      if (demoMode) {
        setBindings((current) => [next, ...current.filter((binding) => bindingKey(binding) !== bindingKey(next))]);
      } else {
        await request<PolicyBinding>(gatewayOrigin, "/v1/admin/policy-bindings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        await refresh();
      }
      setSelectedBindingKey(bindingKey(next));
      setBindingForm(bindingFormFromBinding(next));
      setStatus("saved binding");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }

  async function setProviderConnection(providerId: string, enabled: boolean) {
    try {
      setStatus(`${enabled ? "enabling" : "disabling"} ${providerId}`);
      const current = connections.find((connection) => connection.providerId === providerId);
      const next: ProviderConnection = { providerId, enabled, label: current?.label ?? null };
      if (demoMode) {
        setConnections((items) => [next, ...items.filter((item) => item.providerId !== providerId)]);
        setProviderReadiness((items) => {
          const readiness = items[providerId];
          return readiness ? { ...items, [providerId]: { ...readiness, connectionEnabled: enabled, executable: enabled && readiness.configPresent && (!readiness.oauthGrantRequired || readiness.oauthGrantCount > 0), status: enabled ? (readiness.verified ? "verified" : "unverified") : "disabled" } } : items;
        });
      } else {
        await request<ProviderConnection>(gatewayOrigin, `/v1/admin/connections/${encodeURIComponent(providerId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        await refresh();
      }
      setStatus(`${enabled ? "enabled" : "disabled"} ${providerId}`);
    } catch (error) {
      const message = errorMessage(error);
      setStatus(message);
    }
  }

  async function refreshUsageLedger() {
    if (demoMode || session.role !== "admin") return;
    const result = await settled(() => request<{ policies?: AdminUsageRow[]; keys?: AdminUsageRow[]; usage: UsageSnapshot }>(gatewayOrigin, "/v1/admin/usage"));
    if (result.ok) {
      setUsageRows(result.value.policies ?? result.value.keys ?? []);
      setUsageSnapshot(result.value.usage);
      setUsageLoaded(true);
      return;
    }
    setUsageRows([]);
    setUsageSnapshot(emptyUsageSnapshot);
    setUsageLoaded(false);
    if (view === "usage") setStatus(`usage ledger unavailable: ${result.error}`);
  }

  async function saveUser(event: FormEvent) {
    event.preventDefault();
    try {
      setUserError("");
      setStatus("saving user");
      const email = accessForm.email.trim().toLowerCase();
      if (!email.includes("@")) throw new Error("enter a valid email");
      const next: AccessUser = {
        email,
        role: selectedUser?.role ?? "user",
        tenantId: accessForm.tenantId || "default",
        enabled: accessForm.enabled,
        groups: parseGroups(accessForm.groups),
      };
      if (demoMode) {
        setUsers((current) => [next, ...current.filter((user) => user.email !== email)]);
        setBindings((current) => reconcileDirectUserBindings(current, email, keys, accessForm.policyIds));
        setSelectedUserEmail(email);
        setAccessForm(accessFormFromUser(next, reconcileDirectUserBindings(bindings, email, keys, accessForm.policyIds)));
        setStatus("saved user");
        return;
      }
      await request<AccessUser>(gatewayOrigin, `/v1/admin/access-users/${encodeURIComponent(email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: next.tenantId, enabled: next.enabled, groups: next.groups }),
      });
      const bindingWrites = keys.flatMap((policy) => {
        const existing = bindings.find((binding) => binding.principalType === "user" && binding.principalId === email && binding.policyId === policy.policyId);
        const enabled = accessForm.policyIds.includes(policy.policyId);
        if (existing?.enabled === enabled || (!existing && !enabled)) return [];
        return [request<PolicyBinding>(gatewayOrigin, "/v1/admin/policy-bindings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            policyId: policy.policyId,
            principalType: "user",
            principalId: email,
            enabled,
            priority: existing?.priority ?? 100,
          }),
        })];
      });
      await Promise.all(bindingWrites);
      await refresh();
      setStatus("saved user");
    } catch (error) {
      const message = errorMessage(error);
      setUserError(message);
      setStatus(message);
    }
  }

  async function revoke(policyId: string) {
    try {
      setStatus(`revoking ${policyId}`);
      if (demoMode) {
        applyDemoKeys((current) => current.map((key) => (key.policyId === policyId ? { ...key, enabled: false } : key)));
        setStatus(`revoked ${policyId}`);
        return;
      }
      await request<AccessPolicy>(gatewayOrigin, `/v1/admin/policies/${encodeURIComponent(policyId)}/revoke`, { method: "POST" });
      await refresh();
      setStatus(`revoked ${policyId}`);
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }

  async function runPlayground(event: FormEvent) {
    event.preventDefault();
    try {
      setPlaygroundError("");
      setStatus("running playground");
      const guard = playgroundBlocker(playground, selectedModel, selectedServiceRoute, accessByProvider, providerReadiness);
      if (guard) throw new Error(guard);
      const payload = playgroundPayload(playground, selectedServiceRoute);
      if (demoMode) {
        setPlaygroundResult(JSON.stringify(playground.mode === "model"
          ? { provider: selectedModel?.provider, model: selectedModel?.id, output: "Hello from ClawRouter demo mode." }
          : { provider: selectedServiceRoute?.provider, route: selectedServiceRoute?.route, output: "Service proxy demo response." }, null, 2));
        setStatus("playground ready");
        return;
      }
      const method = "POST";
      const result = await playgroundRequest(gatewayOrigin, playgroundAccessEndpoint(playground, selectedServiceRoute), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setPlaygroundResult(result);
      setStatus("playground ready");
    } catch (error) {
      const message = errorMessage(error);
      setPlaygroundError(message);
      setPlaygroundResult(message);
      setStatus(message);
    }
  }

  function editPolicy(key: AccessPolicy) {
    setIssuedKey("");
    setSelectedPolicyId(key.policyId);
    setPolicyForm(policyFormFromPolicy(key));
    setCredentialForm((current) => ({ ...current, policyId: key.policyId }));
    setBindingForm((current) => ({ ...current, policyId: key.policyId }));
  }

  function startNewPolicy() {
    setIssuedKey("");
    setPolicyError("");
    setSelectedPolicyId("");
    setPolicyForm({ ...defaultPolicy, policyId: "", tenantId: session.tenantId ?? "default", providers: [...defaultPolicy.providers] });
  }

  function startNewUser() {
    setSelectedUserEmail("");
    setUserError("");
    setAccessForm({ ...defaultAccess, email: "", tenantId: session.tenantId ?? "default" });
  }

  function editBinding(binding: PolicyBinding) {
    setSelectedBindingKey(bindingKey(binding));
    setBindingForm(bindingFormFromBinding(binding));
  }

  function applyPreset(role: keyof typeof rolePresets) {
    const preset = rolePresets[role];
    const available = new Set(providers.map((provider) => provider.id));
    setPolicyForm((current) => ({
      ...current,
      tokenRole: role,
      monthlyBudgetMicros: currencyInput(optionalNumber(preset.budget)),
      requestCostMicros: preset.request,
      providers: preset.providers.length ? preset.providers.filter((id) => available.has(id)) : providers.map((provider) => provider.id),
      allProviders: false,
    }));
  }

  function togglePolicyProvider(providerId: string) {
    const allProviderIds = providers.map((provider) => provider.id);
    setPolicyForm((current) => ({
      ...current,
      allProviders: false,
      providers: (current.allProviders ? allProviderIds : current.providers).includes(providerId)
        ? (current.allProviders ? allProviderIds : current.providers).filter((id) => id !== providerId)
        : [...current.providers, providerId].sort(),
    }));
  }

  function setPolicyProviderGroup(providerIds: string[], checked: boolean) {
    const allProviderIds = providers.map((provider) => provider.id);
    setPolicyForm((current) => {
      if (current.allProviders && checked) return current;
      const selected = current.allProviders ? allProviderIds : current.providers;
      return {
        ...current,
        allProviders: false,
        providers: checked
          ? unique([...selected, ...providerIds]).sort()
          : selected.filter((id) => !providerIds.includes(id)),
      };
    });
  }

  function applyDemoKeys(updater: (current: AccessPolicy[]) => AccessPolicy[]) {
    setKeys((current) => {
      const next = updater(current);
      setAdminOverview(adminOverviewFromKeys(next, providers, routes));
      setTenantSummaries(tenantSummaryFallback(next));
      setUsageRows(next.map(policyUsageFallback));
      setUsageLoaded(true);
      return next;
    });
  }

  function navigateTo(nextView: View, replace = false) {
    setView(nextView);
    const nextPath = viewPaths[nextView];
    if (window.location.pathname !== nextPath) {
      const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
      if (replace) window.history.replaceState(null, "", nextUrl);
      else window.history.pushState(null, "", nextUrl);
    }
  }

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="brandBlock">
          <span className="brandMark"><Route aria-hidden="true" /></span>
          <div>
            <strong>ClawRouter</strong>
            <span>access gateway</span>
          </div>
        </div>
        <nav className="navTabs" aria-label="console">
          <div className="navGroup">
            <span className="navGroupLabel">Workspace</span>
            {navItems.filter((item) => item.section === "workspace").map(({ id, label, icon: Icon }) => (
              <button key={id} className={view === id ? "active" : ""} type="button" onClick={() => navigateTo(id)}>
                <Icon className="navIcon" aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          {session.role === "admin" ? (
            <div className="navGroup">
              <span className="navGroupLabel">Administration</span>
              {navItems.filter((item) => item.section === "admin").map(({ id, label, icon: Icon }) => (
                <button key={id} className={view === id ? "active" : ""} type="button" onClick={() => navigateTo(id)}>
                  <Icon className="navIcon" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </nav>
        <div className="tenantSwitch">
          <span className="contextIcon"><ShieldCheck aria-hidden="true" /></span>
          <div>
            <span>Active context</span>
            <strong>{session.email ?? "not signed in"}</strong>
            <small>{session.tenantId ?? "default"} · {session.role}</small>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="pageTitle">
            <span className="pageIcon">{React.createElement(viewIcon(view), { className: "pageIconSvg" })}</span>
            <div>
              <h1>{viewTitle(view)}</h1>
              <p>{viewSubtitle(view)}</p>
            </div>
          </div>
          <div className="topActions">
            <span className={`status ${session.role === "admin" ? "active" : "neutral"}`}>{session.role}</span>
            <button type="button" className="buttonSecondary" onClick={refresh} disabled={busy}>
              <RefreshCw className="buttonIcon" aria-hidden="true" />
              <span>Sync gateway</span>
            </button>
          </div>
        </header>

        <div className={`statusBar statusBar-${statusTone}`} role="status" aria-live="polite"><strong>{statusLabel(statusTone)}</strong><span>{status}</span>{demoMode ? <em>demo</em> : null}</div>

        {view === "catalog" ? (
          <CatalogScreen
            services={filteredServices}
            allServices={services}
            selected={selectedService}
            policies={keys}
            connections={connections}
            query={query}
            setQuery={setQuery}
            kind={kind}
            setKind={setKind}
            kinds={kinds}
            canAdminister={session.role === "admin"}
            onSelect={(service) => setSelectedServiceId(service.id)}
            onSetConnection={setProviderConnection}
            onPlay={(service) => {
              const model = models.find((item) => item.provider === service.provider);
              const proxyRoute = serviceRoutes.find((route) => route.provider === service.provider);
              setPlayground((current) => model
                ? { ...current, mode: "model", model: model.id }
                : proxyRoute ? { ...current, mode: "service", serviceRoute: routeKey(proxyRoute), serviceMethod: proxyRoute.methods[0] ?? "POST" } : current);
              navigateTo("playground");
            }}
            onAdd={(service) => {
              setPolicyForm((current) => ({
                ...current,
                providers: current.allProviders || current.providers.includes(service.provider) ? current.providers : [...current.providers, service.provider].sort(),
              }));
              navigateTo("policies");
            }}
          />
        ) : null}

        {view === "playground" ? (
          <PlaygroundScreen
            form={playground}
            setForm={setPlayground}
            models={models}
            selected={selectedModel}
            serviceRoutes={serviceRoutes}
            selectedServiceRoute={selectedServiceRoute}
            accessByProvider={accessByProvider}
            readinessByProvider={providerReadiness}
            requestMode={requestMode}
            setRequestMode={setRequestMode}
            result={playgroundResult}
            error={playgroundError}
            onRun={runPlayground}
            busy={busy}
          />
        ) : null}

        {view === "policies" && session.role === "admin" ? (
          <PoliciesScreen
            tab={accessTab}
            setTab={setAccessTab}
            keys={keys}
            selected={selectedPolicy}
            credentials={credentials}
            selectedCredential={selectedCredential}
            bindings={bindings}
            selectedBinding={selectedBinding}
            providers={providers}
            form={policyForm}
            setForm={setPolicyForm}
            credentialForm={credentialForm}
            setCredentialForm={setCredentialForm}
            bindingForm={bindingForm}
            setBindingForm={setBindingForm}
            issuedKey={issuedKey}
            error={policyError}
            onSave={savePolicy}
            onIssueCredential={issueCredential}
            onRevokeCredential={revokeCredential}
            onSaveBinding={saveBinding}
            onNew={startNewPolicy}
            onEdit={editPolicy}
            onEditCredential={(credential) => {
              setSelectedCredentialId(credential.credentialId);
              setCredentialForm({ credentialId: "", policyId: credential.policyId });
              setIssuedKey("");
            }}
            onEditBinding={editBinding}
            onNewBinding={() => {
              setSelectedBindingKey("");
              setBindingForm({ ...defaultBinding, policyId: selectedPolicyId || keys[0]?.policyId || "" });
            }}
            onRevoke={revoke}
            onPreset={applyPreset}
            onToggleProvider={togglePolicyProvider}
            onSetProviderGroup={setPolicyProviderGroup}
            busy={busy}
          />
        ) : null}

        {view === "users" && session.role === "admin" ? (
          <UsersScreen
            users={users}
            selected={selectedUser}
            policies={keys}
            bindings={bindings}
            services={services}
            form={accessForm}
            setForm={setAccessForm}
            error={userError}
            onOpenPolicy={(policy) => {
              editPolicy(policy);
              setAccessTab("policies");
              navigateTo("policies");
            }}
            onSelect={(user) => {
              setSelectedUserEmail(user.email);
              setAccessForm(accessFormFromUser(user, bindings));
            }}
            onNew={startNewUser}
            onSave={saveUser}
            busy={busy}
          />
        ) : null}

        {view === "usage" && session.role === "admin" ? <UsageScreen keys={keys} services={services} overview={adminOverview} tenants={tenantSummaries} usageRows={usageRows} usage={usageSnapshot} usageLoaded={usageLoaded} /> : null}
      </section>
    </main>
  );
}

function CatalogScreen({ services, allServices, selected, policies, connections, query, setQuery, kind, setKind, kinds, canAdminister, onSelect, onSetConnection, onPlay, onAdd }: {
  services: ServiceItem[];
  allServices: ServiceItem[];
  selected?: ServiceItem;
  policies: AccessPolicy[];
  connections: ProviderConnection[];
  query: string;
  setQuery: (value: string) => void;
  kind: string;
  setKind: (value: string) => void;
  kinds: string[];
  canAdminister: boolean;
  onSelect: (service: ServiceItem) => void;
  onSetConnection: (providerId: string, enabled: boolean) => void;
  onPlay: (service: ServiceItem) => void;
  onAdd: (service: ServiceItem) => void;
}) {
  const activePolicies = policies.filter((policy) => policy.enabled);
  const queryMatchedServices = allServices.filter((service) => matchesServiceQuery(service, query));
  const selectedPolicies = selected ? activePolicies.filter((policy) => policyCoversProvider(policy, selected.provider)) : [];
  const connectionByProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  const kindCounts = new Map(kinds.map((item) => [item, item === "all" ? queryMatchedServices.length : queryMatchedServices.filter((service) => service.kind === item).length]));
  const servicePolicies = (service: ServiceItem) => activePolicies.filter((policy) => policyCoversProvider(policy, service.provider));
  const outcomes = allServices.map((service) => serviceOutcome(service));
  const usableCount = outcomes.filter((outcome) => outcome.playable).length;
  const grantedCount = allServices.filter((service) => service.access?.allowed).length;
  const blockedCount = outcomes.filter((outcome) => outcome.blocked).length;

  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="catalogControls">
          <div className="catalogMeta"><strong>{services.length} services</strong><span>{usableCount} usable · {grantedCount} granted · {blockedCount} blocked</span></div>
          <label><span>search catalog</span><div className="inputWithIcon"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="service, provider, model, route" /></div></label>
          <div className="kindTabs" role="tablist" aria-label="service kind">
            {kinds.map((item) => <button key={item} type="button" className={kind === item ? "active" : ""} onClick={() => setKind(item)}>{kindLabel(item)}<span>{kindCounts.get(item) ?? 0}</span></button>)}
          </div>
        </div>
        <EntityTable
          columns={["service", "your access", "connection", "policies", "kind"]}
          columnTemplate="minmax(220px, 1.45fr) 124px 126px minmax(130px, 0.8fr) 116px"
          rows={services.map((service) => {
            const policiesForService = servicePolicies(service);
            const outcome = serviceOutcome(service);
            return {
              id: service.id,
              active: selected?.id === service.id,
              onClick: () => onSelect(service),
              cells: [
                <EntityName brandIcon={service.brandIcon} icon={kindIcon(service.kind)} title={service.name} subtitle={`${service.provider} · ${kindLabel(service.kind)}`} />,
                <Status label={service.access?.allowed ? "granted" : service.access ? "not granted" : "unknown"} tone={service.access?.allowed ? "active" : service.access ? "revoked" : "neutral"} />,
                <ReadinessStatus readiness={service.readiness} />,
                <GrantChips names={grantNamesForService(service, policiesForService)} />,
                kindLabel(service.kind),
              ],
            };
          })}
        />
      </section>
      <aside className="inspector">
        {selected ? (
          <>
            {(() => {
              const outcome = serviceOutcome(selected);
              const playBlocker = playgroundBlockedForService(selected);
              const connection = connectionByProvider.get(selected.provider);
              return (
                <>
            <InspectorHeader brandIcon={selected.brandIcon} icon={kindIcon(selected.kind)} title={selected.name} subtitle={`${kindLabel(selected.kind)} · ${selected.category}`} />
            <div className={`outcomeCallout ${outcome.tone}`}>
              <OutcomeStatus outcome={outcome} />
              <p>{outcome.detail}</p>
            </div>
            <dl className="facts">
              <dt>provider</dt><dd>{selected.provider}</dd>
              <dt>kind</dt><dd>{kindLabel(selected.kind)}</dd>
              <dt>routes</dt><dd>{selected.route}</dd>
              <dt>surfaces</dt><dd>{selected.surfaces.join(", ")}</dd>
              <dt>policies</dt><dd>{grantNamesForService(selected, selectedPolicies).join(", ") || "none"}</dd>
              <dt>connection</dt><dd>{connection?.enabled === false ? "disabled" : "enabled"}</dd>
              <dt>readiness</dt><dd>{readinessLabel(selected.readiness)}</dd>
              <dt>verified</dt><dd>{selected.readiness?.lastCheckedAt ? `${formatRelativeTime(selected.readiness.lastCheckedAt)} · ${formatDuration(selected.readiness.latencyMs)}` : "not checked"}</dd>
              <dt>missing</dt><dd>{selected.readiness?.missingConfig.length ? selected.readiness.missingConfig.join(", ") : "none"}</dd>
              <dt>oauth grants</dt><dd>{selected.readiness?.oauthGrantRequired ? selected.readiness.oauthGrantCount : "n/a"}</dd>
            </dl>
            {selected.readiness?.reasons.length ? <InlineNote>{selected.readiness.reasons.join("; ")}</InlineNote> : null}
            <div className="sectionTitle">Policies including this service</div>
            <div className="miniList">
              {grantNamesForService(selected, selectedPolicies).length ? grantNamesForService(selected, selectedPolicies).map((policyId) => <button key={policyId} type="button">{policyId}<span>{selectedPolicies.find((policy) => policy.policyId === policyId)?.tenantId ?? "identity policy"}</span></button>) : <p>No active policy includes this service yet.</p>}
            </div>
            <div className="inspectorActions">
              <button type="button" disabled={Boolean(playBlocker)} onClick={() => onPlay(selected)} title={playBlocker ?? undefined}><Play className="buttonIcon" aria-hidden="true" /><span>Try in playground</span></button>
              {canAdminister ? <button type="button" className={connection?.enabled === false ? "buttonSecondary" : "buttonDanger"} onClick={() => onSetConnection(selected.provider, connection?.enabled === false)}><ServerCog className="buttonIcon" aria-hidden="true" /><span>{connection?.enabled === false ? "Enable connection" : "Disable connection"}</span></button> : null}
              {canAdminister ? <button type="button" className="buttonSecondary" onClick={() => onAdd(selected)}><Plus className="buttonIcon" aria-hidden="true" /><span>Add to selected policy</span></button> : null}
            </div>
                </>
              );
            })()}
          </>
        ) : <p>Select a service.</p>}
      </aside>
    </div>
  );
}

function GrantChips({ names }: { names: string[] }) {
  if (!names.length) return <span className="emptyGrant">no policy</span>;
  const first = names[0];
  return (
    <span className="grantChips">
      <span className="grantChip" title={first}>{first}</span>
      {names.length > 1 ? <span className="grantMore" title={names.slice(1).join(", ")}>+{names.length - 1}</span> : null}
    </span>
  );
}

function PlaygroundScreen({ form, setForm, models, selected, serviceRoutes, selectedServiceRoute, accessByProvider, readinessByProvider, requestMode, setRequestMode, result, error, onRun, busy }: {
  form: PlaygroundForm;
  setForm: (form: PlaygroundForm) => void;
  models: CatalogModel[];
  selected?: CatalogModel;
  serviceRoutes: RouteCatalog["manifestProxy"];
  selectedServiceRoute?: RouteCatalog["manifestProxy"][number];
  accessByProvider: Map<string, ProviderAccess>;
  readinessByProvider: Record<string, ProviderReadiness>;
  requestMode: "json" | "curl";
  setRequestMode: (mode: "json" | "curl") => void;
  result: string;
  error: string;
  onRun: (event: FormEvent) => void;
  busy: boolean;
}) {
  const request = playgroundRequestPreview(form, requestMode, selectedServiceRoute);
  const blocker = playgroundBlocker(form, selected, selectedServiceRoute, accessByProvider, readinessByProvider);
  const selectedProvider = form.mode === "model" ? selected?.provider : selectedServiceRoute?.provider;
  const selectedAccess = selectedProvider ? accessByProvider.get(selectedProvider) : undefined;
  const selectedReadiness = selectedProvider ? readinessByProvider[selectedProvider] : undefined;
  const methods = selectedServiceRoute?.methods.length ? selectedServiceRoute.methods : ["POST"];
  return (
    <form className="playgroundLayout" onSubmit={onRun}>
      <aside className="playgroundSettings">
        <PanelTitle icon={ServerCog} title="Request setup" meta={form.mode === "model" ? "model invocation" : "service proxy"} />
        <div className="playgroundToolbar">
          {form.mode === "model" ? (
            <>
              <label><span>Model</span><select value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>{models.map((model) => <option key={`${model.provider}:${model.id}`} value={model.id}>{model.id}</option>)}</select></label>
              <label><span>Endpoint</span><select value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value as PlaygroundForm["endpoint"] })}><option value="/v1/chat/completions">chat completions</option><option value="/v1/responses">responses</option></select></label>
              <div className="playgroundSettingPair">
                <label><span>Max tokens</span><input value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: event.target.value })} /></label>
                <label><span>Temperature</span><input value={form.temperature} onChange={(event) => setForm({ ...form, temperature: event.target.value })} /></label>
              </div>
            </>
          ) : (
            <>
              <label><span>Service route</span><select value={form.serviceRoute} onChange={(event) => {
                const route = serviceRoutes.find((item) => routeKey(item) === event.target.value);
                setForm({ ...form, serviceRoute: event.target.value, serviceMethod: route?.methods[0] ?? "POST" });
              }}>{serviceRoutes.map((route) => <option key={routeKey(route)} value={routeKey(route)}>{route.provider} / {route.endpoint}</option>)}</select></label>
              <label><span>Method</span><select value={form.serviceMethod} onChange={(event) => setForm({ ...form, serviceMethod: event.target.value })}>{methods.map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
              <label><span>Path / id</span><input value={form.servicePath} onChange={(event) => setForm({ ...form, servicePath: event.target.value })} placeholder="replacement for route variables" /></label>
            </>
          )}
        </div>
        {blocker ? <InlineNote>{blocker}</InlineNote> : null}
        <dl className="facts">
          <dt>provider</dt><dd>{selectedProvider ?? "none"}</dd>
          <dt>readiness</dt><dd>{readinessLabel(selectedReadiness)}</dd>
          <dt>access</dt><dd>{selectedAccess ? (selectedAccess.allowed ? selectedAccess.policies.join(", ") || "session" : "not granted") : "unknown"}</dd>
          <dt>endpoint</dt><dd>{playgroundAccessEndpoint(form, selectedServiceRoute)}</dd>
        </dl>
      </aside>
      <section className="promptPane">
        <div className="playgroundHeader">
          <div className="modeTabs" role="tablist" aria-label="playground mode">
            <button type="button" className={form.mode === "model" ? "active" : ""} onClick={() => setForm({ ...form, mode: "model" })}>Model</button>
            <button type="button" className={form.mode === "service" ? "active" : ""} onClick={() => setForm({ ...form, mode: "service" })}>Service</button>
          </div>
          <button type="submit" disabled={busy || Boolean(blocker)} title={blocker ?? undefined}><Play className="buttonIcon" aria-hidden="true" /><span>Run request</span></button>
        </div>
        {error ? <InlineError message={error} /> : null}
        <div className="runtimeStrip">
          <ReadinessStatus readiness={selectedReadiness} />
          <span>{selectedAccess ? (selectedAccess.allowed ? `allowed by ${selectedAccess.policies.join(", ") || "session"}` : "not granted") : "access unknown"}</span>
          <span>{selectedProvider ?? "no provider"}</span>
        </div>
        <div className="playgroundCanvas">
          {form.mode === "model" ? (
            <div className="promptComposer">
              <label><span>System instructions</span><textarea className="systemPrompt" value={form.system} onChange={(event) => setForm({ ...form, system: event.target.value })} /></label>
              <label><span>User prompt</span><textarea className="mainPrompt" value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label>
            </div>
          ) : (
            <div className="promptComposer">
              <label><span>JSON body</span><textarea className="mainPrompt servicePayload" value={form.servicePayload} onChange={(event) => setForm({ ...form, servicePayload: event.target.value })} /></label>
            </div>
          )}
          <section className="responsePane">
            <div className="splitHeader">
              <PanelTitle icon={ChevronRight} title="Response" meta="raw response" />
            </div>
            <pre>{result}</pre>
          </section>
        </div>
        <details className="requestDrawer">
          <summary><span><ServerCog className="buttonIcon" aria-hidden="true" />Inspect request</span><strong>{requestMode}</strong></summary>
          <div className="requestDrawerToolbar">
            <div className="segmented"><button type="button" className={requestMode === "json" ? "active" : ""} onClick={() => setRequestMode("json")}>JSON</button><button type="button" className={requestMode === "curl" ? "active" : ""} onClick={() => setRequestMode("curl")}>curl</button></div>
          </div>
          <pre>{request}</pre>
        </details>
      </section>
    </form>
  );
}

function PoliciesScreen({ tab, setTab, keys, selected, credentials, selectedCredential, bindings, selectedBinding, providers, form, setForm, credentialForm, setCredentialForm, bindingForm, setBindingForm, issuedKey, error, onSave, onIssueCredential, onRevokeCredential, onSaveBinding, onNew, onEdit, onEditCredential, onEditBinding, onNewBinding, onRevoke, onPreset, onToggleProvider, onSetProviderGroup, busy }: {
  tab: AccessTab;
  setTab: (tab: AccessTab) => void;
  keys: AccessPolicy[];
  selected?: AccessPolicy;
  credentials: ProxyCredential[];
  selectedCredential?: ProxyCredential;
  bindings: PolicyBinding[];
  selectedBinding?: PolicyBinding;
  providers: ProviderRow[];
  form: PolicyForm;
  setForm: (form: PolicyForm) => void;
  credentialForm: CredentialForm;
  setCredentialForm: (form: CredentialForm) => void;
  bindingForm: BindingForm;
  setBindingForm: (form: BindingForm) => void;
  issuedKey: string;
  error: string;
  onSave: (event: FormEvent) => void;
  onIssueCredential: (event: FormEvent) => void;
  onRevokeCredential: (credentialId: string) => void;
  onSaveBinding: (event: FormEvent) => void;
  onNew: () => void;
  onEdit: (policy: AccessPolicy) => void;
  onEditCredential: (credential: ProxyCredential) => void;
  onEditBinding: (binding: PolicyBinding) => void;
  onNewBinding: () => void;
  onRevoke: (policyId: string) => void;
  onPreset: (role: keyof typeof rolePresets) => void;
  onToggleProvider: (id: string) => void;
  onSetProviderGroup: (ids: string[], checked: boolean) => void;
  busy: boolean;
}) {
  return (
    <div className="accessWorkspace">
      <div className="resourceTabs" role="tablist" aria-label="access resources">
        <button type="button" role="tab" aria-selected={tab === "policies"} className={tab === "policies" ? "active" : ""} onClick={() => setTab("policies")}>Policies <span>{keys.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "credentials"} className={tab === "credentials" ? "active" : ""} onClick={() => setTab("credentials")}>Credentials <span>{credentials.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "bindings"} className={tab === "bindings" ? "active" : ""} onClick={() => setTab("bindings")}>Bindings <span>{bindings.filter((binding) => binding.enabled).length}</span></button>
      </div>
      {tab === "policies" ? <PolicyPanel keys={keys} selected={selected} providers={providers} form={form} setForm={setForm} error={error} onSave={onSave} onNew={onNew} onEdit={onEdit} onRevoke={onRevoke} onPreset={onPreset} onToggleProvider={onToggleProvider} onSetProviderGroup={onSetProviderGroup} busy={busy} /> : null}
      {tab === "credentials" ? <CredentialPanel policies={keys} credentials={credentials} selected={selectedCredential} form={credentialForm} setForm={setCredentialForm} issuedKey={issuedKey} error={error} onIssue={onIssueCredential} onEdit={onEditCredential} onRevoke={onRevokeCredential} busy={busy} /> : null}
      {tab === "bindings" ? <BindingPanel policies={keys} bindings={bindings} selected={selectedBinding} form={bindingForm} setForm={setBindingForm} error={error} onSave={onSaveBinding} onEdit={onEditBinding} onNew={onNewBinding} busy={busy} /> : null}
    </div>
  );
}

function CredentialPanel({ policies, credentials, selected, form, setForm, issuedKey, error, onIssue, onEdit, onRevoke, busy }: {
  policies: AccessPolicy[];
  credentials: ProxyCredential[];
  selected?: ProxyCredential;
  form: CredentialForm;
  setForm: (form: CredentialForm) => void;
  issuedKey: string;
  error: string;
  onIssue: (event: FormEvent) => void;
  onEdit: (credential: ProxyCredential) => void;
  onRevoke: (credentialId: string) => void;
  busy: boolean;
}) {
  const copyIssuedKey = () => void navigator.clipboard?.writeText(issuedKey);
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="overviewStrip">
          <Metric label="active credentials" value={String(credentials.filter((credential) => credential.enabled).length)} meta={`${credentials.length} total`} />
          <Metric label="bound policies" value={String(new Set(credentials.map((credential) => credential.policyId)).size)} meta={`${policies.length} available`} />
          <Metric label="revoked" value={String(credentials.filter((credential) => !credential.enabled).length)} meta="individually disabled" />
        </div>
        <div className="tableSectionHeader"><div><strong>Issued credentials</strong><span>Machine access bound to policies</span></div><span>secrets reveal once</span></div>
        <EntityTable columns={["credential", "policy", "state"]} columnTemplate="minmax(220px, 1.3fr) minmax(180px, 1fr) 110px" rows={credentials.map((credential) => ({ id: credential.credentialId, active: selected?.credentialId === credential.credentialId, onClick: () => onEdit(credential), cells: [<EntityName icon={KeyRound} title={credential.credentialId} subtitle="proxy credential" />, credential.policyId, <Status label={credential.enabled ? "active" : "revoked"} tone={credential.enabled ? "active" : "revoked"} />] }))} />
      </section>
      <aside className="inspector">
        <form onSubmit={onIssue}>
          <InspectorHeader icon={KeyRound} title="Issue credential" subtitle="creates a new secret for one policy" />
          {error ? <InlineError message={error} /> : null}
          {issuedKey ? <div className="issuedKey"><div><span>copy now · shown once</span><code>{issuedKey}</code></div><button type="button" className="buttonSecondary" onClick={copyIssuedKey}>Copy</button></div> : null}
          <div className="formGrid compact">
            <label className="full"><span>credential id</span><input value={form.credentialId} onChange={(event) => setForm({ ...form, credentialId: event.target.value })} placeholder="auto-generated when blank" /></label>
            <label className="full"><span>policy</span><select value={form.policyId} onChange={(event) => setForm({ ...form, policyId: event.target.value })}>{policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.policyId}</option>)}</select></label>
          </div>
          <InlineNote>Credentials are optional. Maintainers using Cloudflare Access do not need a proxy key.</InlineNote>
          <div className="inspectorActions"><button type="submit" disabled={busy || !form.policyId}><Plus className="buttonIcon" aria-hidden="true" /><span>Issue credential</span></button></div>
          {selected ? <><div className="sectionTitle">Selected credential</div><dl className="facts"><dt>id</dt><dd>{selected.credentialId}</dd><dt>policy</dt><dd>{selected.policyId}</dd><dt>state</dt><dd>{selected.enabled ? "active" : "revoked"}</dd></dl><div className="inspectorActions"><button type="button" className="buttonDanger" disabled={busy || !selected.enabled} onClick={() => onRevoke(selected.credentialId)}><CircleSlash2 className="buttonIcon" aria-hidden="true" /><span>Revoke credential</span></button></div></> : null}
        </form>
      </aside>
    </div>
  );
}

function BindingPanel({ policies, bindings, selected, form, setForm, error, onSave, onEdit, onNew, busy }: {
  policies: AccessPolicy[];
  bindings: PolicyBinding[];
  selected?: PolicyBinding;
  form: BindingForm;
  setForm: (form: BindingForm) => void;
  error: string;
  onSave: (event: FormEvent) => void;
  onEdit: (binding: PolicyBinding) => void;
  onNew: () => void;
  busy: boolean;
}) {
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="overviewStrip">
          <Metric label="active bindings" value={String(bindings.filter((binding) => binding.enabled).length)} meta={`${bindings.length} total`} />
          <Metric label="users" value={String(new Set(bindings.filter((binding) => binding.principalType === "user").map((binding) => binding.principalId)).size)} meta="direct principals" />
          <Metric label="groups" value={String(new Set(bindings.filter((binding) => binding.principalType === "group").map((binding) => binding.principalId)).size)} meta="inherited principals" />
        </div>
        <div className="tableSectionHeader"><div><strong>Principal bindings</strong><span>Explicit policy assignment and priority</span></div><button type="button" onClick={onNew} disabled={busy}><Plus className="buttonIcon" aria-hidden="true" /><span>New binding</span></button></div>
        <EntityTable columns={["principal", "type", "policy", "priority", "state"]} columnTemplate="minmax(220px, 1.4fr) 90px minmax(170px, 1fr) 80px 100px" rows={bindings.map((binding) => ({ id: bindingKey(binding), active: selected ? bindingKey(selected) === bindingKey(binding) : false, onClick: () => onEdit(binding), cells: [<EntityName icon={Users} title={binding.principalId} subtitle={binding.principalType === "group" ? "inherited by group members" : "direct identity binding"} />, binding.principalType, binding.policyId, binding.priority, <Status label={binding.enabled ? "active" : "disabled"} tone={binding.enabled ? "active" : "revoked"} />] }))} />
      </section>
      <aside className="inspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={Users} title={selected ? "Edit binding" : "New binding"} subtitle="assign one policy to one principal" />
          {error ? <InlineError message={error} /> : null}
          <div className="formGrid compact">
            <label><span>principal type</span><select value={form.principalType} disabled={Boolean(selected)} onChange={(event) => setForm({ ...form, principalType: event.target.value as BindingForm["principalType"] })}><option value="group">group</option><option value="user">user</option></select></label>
            <label><span>priority</span><input inputMode="numeric" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} /></label>
            <label className="full"><span>principal</span><input value={form.principalId} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, principalId: event.target.value })} placeholder={form.principalType === "group" ? "maintainers" : "user@example.com"} /></label>
            <label className="full"><span>policy</span><select value={form.policyId} disabled={Boolean(selected)} onChange={(event) => setForm({ ...form, policyId: event.target.value })}>{policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.policyId}</option>)}</select></label>
            <label className="full"><span>state</span><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
          </div>
          <div className="inspectorActions"><button type="submit" disabled={busy || !form.policyId || !form.principalId.trim()}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save binding</span></button></div>
        </form>
      </aside>
    </div>
  );
}

function PolicyPanel({ keys, selected, providers, form, setForm, error, onSave, onNew, onEdit, onRevoke, onPreset, onToggleProvider, onSetProviderGroup, busy }: {
  keys: AccessPolicy[];
  selected?: AccessPolicy;
  providers: ProviderRow[];
  form: PolicyForm;
  setForm: (form: PolicyForm) => void;
  error: string;
  onSave: (event: FormEvent) => void;
  onNew: () => void;
  onEdit: (key: AccessPolicy) => void;
  onRevoke: (policyId: string) => void;
  onPreset: (role: keyof typeof rolePresets) => void;
  onToggleProvider: (id: string) => void;
  onSetProviderGroup: (ids: string[], checked: boolean) => void;
  busy: boolean;
}) {
  const [providerQuery, setProviderQuery] = useState("");
  const providerGroups = groupedProviders(providers, providerQuery);
  const visibleProviderCount = providerGroups.reduce((total, group) => total + group.providers.length, 0);
  const formServiceLabel = form.allProviders ? "all services" : `${form.providers.length} selected service${form.providers.length === 1 ? "" : "s"}`;
  const formSelectionLabel = form.allProviders ? `all services · ${visibleProviderCount} shown` : `${form.providers.length} selected · ${visibleProviderCount} shown`;
  const activeGrantCount = keys.filter((key) => key.enabled).length;
  const tenantCount = new Set(keys.map((key) => key.tenantId ?? "default")).size;
  const coveredServiceCount = keys.some((key) => key.enabled && key.providers.length === 0)
    ? providers.length
    : new Set(keys.filter((key) => key.enabled).flatMap((key) => key.providers)).size;
  return (
    <div className="entityLayout grantsLayout">
      <section className="mainPane grantListPane">
        <div className="overviewStrip grantOverview">
          <Metric label="active policies" value={String(activeGrantCount)} meta={`${keys.length} total`} />
          <Metric label="tenants" value={String(tenantCount)} meta="with configured policies" />
          <Metric label="service coverage" value={String(coveredServiceCount)} meta={`${providers.length} available`} />
        </div>
        <div className="tableSectionHeader grantListHeader"><div><strong>Access policies</strong><span>{keys.length} configured policies</span></div><button type="button" disabled={busy} onClick={onNew}><Plus className="buttonIcon" aria-hidden="true" /><span>New policy</span></button></div>
        <EntityTable
          columns={["policy", "tenant", "scope", "state"]}
          columnTemplate="minmax(170px, 1.35fr) minmax(96px, 0.8fr) minmax(100px, 0.8fr) 88px"
          rows={keys.map((key) => ({ id: key.policyId, active: selected?.policyId === key.policyId, onClick: busy ? undefined : () => onEdit(key), cells: [<EntityName icon={KeyRound} title={key.policyId} subtitle={key.tokenRole ?? "custom"} />, key.tenantId ?? "default", key.providers.length ? `${key.providers.length} services` : "all services", <Status label={key.enabled ? "active" : "revoked"} tone={key.enabled ? "active" : "revoked"} />] }))}
        />
      </section>
      <aside className="inspector wideInspector grantEditor">
        <form onSubmit={onSave}>
          <fieldset className="grantEditorFields" disabled={busy}>
          <div className="grantEditorHeader">
            <InspectorHeader icon={KeyRound} title={form.policyId || "New access policy"} subtitle={`${form.tenantId || "default"} · ${form.tokenRole || "custom"}`} />
            <Status label={form.enabled ? "active" : "disabled"} tone={form.enabled ? "active" : "revoked"} />
          </div>
          {error ? <InlineError message={error} /> : null}
          <div className="grantSummary">
            <strong>{form.tenantId || "default"}</strong>
            <span>{form.enabled ? "will have" : "would have"} access to {formServiceLabel} under the {form.tokenRole || "custom"} role.</span>
          </div>
          <div className="editorSectionHeader"><strong>Policy template</strong><span>Apply a starting scope</span></div>
          <div className="presetRow" aria-label="policy templates">{Object.keys(rolePresets).map((role) => <button key={role} type="button" className="buttonSecondary" onClick={() => onPreset(role as keyof typeof rolePresets)}>{role}</button>)}</div>
          <div className="editorSectionHeader"><strong>Policy details</strong><span>Tenant, role, and limits</span></div>
          <div className="formGrid compact">
            <label><span>policy id</span><input value={form.policyId} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, policyId: event.target.value })} /></label>
            <label><span>tenant</span><input value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} /></label>
            <label><span>role</span><input value={form.tokenRole} onChange={(event) => setForm({ ...form, tokenRole: event.target.value })} /></label>
            <label><span>status</span><select value={form.enabled ? "active" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "active" })}><option value="active">active</option><option value="disabled">disabled</option></select></label>
            <label><span>monthly budget ($)</span><input inputMode="decimal" value={form.monthlyBudgetMicros} onChange={(event) => setForm({ ...form, monthlyBudgetMicros: event.target.value })} placeholder="unlimited" /></label>
            <label><span>request cost (micros)</span><input inputMode="decimal" value={form.requestCostMicros} onChange={(event) => setForm({ ...form, requestCostMicros: event.target.value })} placeholder="server default: 1" /></label>
          </div>
          <div className="editorSectionHeader serviceAccessHeader"><div><strong>Service access</strong><span>{formSelectionLabel}</span></div>{form.allProviders ? <span className="wildcardScope">Wildcard scope · all current and future services</span> : null}</div>
          <div className="inputWithIcon providerFilter"><Search aria-hidden="true" /><input value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="filter services" /></div>
          <div className="serviceGroups">
            {providerGroups.length ? providerGroups.map((group) => {
              const groupIds = group.providers.map((provider) => provider.id);
              const selectedCount = form.allProviders ? group.providers.length : groupIds.filter((id) => form.providers.includes(id)).length;
              return (
                <section className="serviceGroup" key={group.kind}>
                  <div className="serviceGroupHeader">
                    <strong>{kindLabel(group.kind)}</strong>
                    <span>{selectedCount}/{group.providers.length}</span>
                    <button type="button" className="buttonSecondary" onClick={() => onSetProviderGroup(groupIds, true)}>All</button>
                    <button type="button" className="buttonSecondary" onClick={() => onSetProviderGroup(groupIds, false)}>None</button>
                  </div>
                  <div className="serviceMatrix">{group.providers.map((provider) => <label key={provider.id} title={provider.id}><input type="checkbox" checked={form.allProviders || form.providers.includes(provider.id)} onChange={() => onToggleProvider(provider.id)} /><span>{provider.display_name}</span><small>{provider.id}</small></label>)}</div>
                </section>
              );
            }) : <p>No services match this filter.</p>}
          </div>
          <div className="inspectorActions"><button type="submit" disabled={busy || (!form.allProviders && !form.providers.length)}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save policy</span></button>{selected ? <button type="button" className="buttonDanger" disabled={!selected.enabled || busy} onClick={() => onRevoke(selected.policyId)}><CircleSlash2 className="buttonIcon" aria-hidden="true" /><span>Disable policy</span></button> : null}</div>
          </fieldset>
        </form>
      </aside>
    </div>
  );
}

function UsersScreen({ users, selected, policies, bindings, services, form, setForm, error, onOpenPolicy, onSelect, onNew, onSave, busy }: {
  users: AccessUser[];
  selected?: AccessUser;
  policies: AccessPolicy[];
  bindings: PolicyBinding[];
  services: ServiceItem[];
  form: AccessForm;
  setForm: (form: AccessForm) => void;
  error: string;
  onOpenPolicy: (policy: AccessPolicy) => void;
  onSelect: (user: AccessUser) => void;
  onNew: () => void;
  onSave: (event: FormEvent) => void;
  busy: boolean;
}) {
  const [userQuery, setUserQuery] = useState("");
  const accessForUser = (user: AccessUser | undefined) => effectiveAccess(user, policies, bindings, services);
  const selectedAccess = accessForUser(selected);
  const selectedServices = selectedAccess.services.map((service) => ({ service, label: "granted" }));
  const selectedGroups = new Set(selected?.groups ?? []);
  const selectedBindings = bindings
    .filter((binding) => binding.enabled && selected && (binding.principalType === "user" ? binding.principalId === selected.email : selectedGroups.has(binding.principalId)))
    .sort((a, b) => a.priority - b.priority || a.policyId.localeCompare(b.policyId));
  const visibleUsers = users.filter((user) => !userQuery.trim() || [user.email, user.tenantId, user.groups.join(" ")].join(" ").toLowerCase().includes(userQuery.trim().toLowerCase()));
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="tableSectionHeader userListHeader"><label className="inputWithIcon"><Search aria-hidden="true" /><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="search identities or groups" /></label><button type="button" onClick={onNew} disabled={busy}><Plus className="buttonIcon" aria-hidden="true" /><span>New identity</span></button></div>
        <EntityTable columns={["identity", "role", "tenant", "policies", "services", "status"]} columnTemplate="minmax(260px, 1.5fr) 90px 130px 96px 96px 116px" rows={visibleUsers.map((user) => {
          const access = accessForUser(user);
          return { id: user.email, active: selected?.email === user.email, onClick: () => onSelect(user), cells: [<EntityName icon={Users} title={user.email} subtitle="Cloudflare Access" />, user.role, user.tenantId, String(access.policies.length), String(access.services.length), <Status label={user.enabled ? "enabled" : "disabled"} tone={user.enabled ? "active" : "revoked"} />] };
        })} />
      </section>
      <aside className="inspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={Users} title="Access user" subtitle={selected?.email ?? "new user"} />
          {error ? <InlineError message={error} /> : null}
          <InlineNote>Users are created from Cloudflare Access on first login with no policies. Admin status controls the console only; service access always requires an explicit user or group binding.</InlineNote>
          <div className="formGrid compact">
            <label className="full"><span>email</span><input type="email" value={form.email} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <label><span>tenant</span><input value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} /></label>
            <label><span>status</span><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
            <label className="full"><span>groups</span><input value={form.groups} onChange={(event) => setForm({ ...form, groups: event.target.value })} placeholder="maintainers, docs" /></label>
          </div>
          <dl className="facts"><dt>granted services</dt><dd>{selectedAccess.services.length}</dd><dt>active policies</dt><dd>{selectedAccess.policies.length}</dd><dt>console role</dt><dd>{selected?.role ?? "user"}</dd><dt>tenant</dt><dd>{selected?.tenantId ?? form.tenantId}</dd></dl>
          <div className="sectionTitle">Direct policies</div>
          <div className="serviceMatrix">{policies.map((policy) => <label key={policy.policyId}><input type="checkbox" checked={form.policyIds.includes(policy.policyId)} onChange={() => setForm({ ...form, policyIds: form.policyIds.includes(policy.policyId) ? form.policyIds.filter((id) => id !== policy.policyId) : [...form.policyIds, policy.policyId].sort() })} /><span>{policy.policyId}</span><small>{effectiveProviderCount(policy.providers, services)} services</small></label>)}</div>
          <div className="sectionTitle">Effective policies</div>
          <div className="miniList">{selectedBindings.length ? selectedBindings.map((binding) => {
            const policy = policies.find((item) => item.policyId === binding.policyId);
            return <button type="button" key={bindingKey(binding)} onClick={() => policy && onOpenPolicy(policy)}>{binding.policyId}<span>{binding.principalType === "user" ? "direct" : `via ${binding.principalId}`} · priority {binding.priority}</span></button>;
          }) : <p>No user or group policies assigned.</p>}</div>
          <div className="sectionTitle">Effective access</div>
          <div className="miniList">{selectedServices.length ? selectedServices.slice(0, 8).map(({ service, label }) => <button type="button" key={service.id}>{service.name}<span>{label} · {kindLabel(service.kind)}</span></button>) : <p>No services available for this user.</p>}</div>
          <div className="inspectorActions"><button type="submit" disabled={busy}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save user</span></button></div>
        </form>
      </aside>
    </div>
  );
}

function UsageScreen({ keys, services, overview, tenants, usageRows, usage, usageLoaded }: { keys: AccessPolicy[]; services: ServiceItem[]; overview: AdminOverview | null; tenants: AdminTenantSummary[]; usageRows: AdminUsageRow[]; usage: UsageSnapshot; usageLoaded: boolean }) {
  const activeKeys = keys.filter((key) => key.enabled);
  const readyServices = readyCount(services);
  const blockedServices = services.filter((service) => service.readiness && !service.readiness.executable);
  const rows = usageRows.length ? usageRows : keys.map(policyUsageFallback);
  const tenantRows = tenants.length ? tenants : tenantSummaryFallback(keys);
  const serviceByProvider = new Map(services.map((service) => [service.provider, service]));
  const successRate = usage.summary.requestCount ? Math.round((usage.summary.successCount / usage.summary.requestCount) * 100) : 0;
  const untrackedRows = rows.filter((row) => row.enabled && row.budget.ledger === "untracked");
  const exhaustedRows = rows.filter((row) => row.enabled && row.budget.configured && row.budget.remainingMicros !== undefined && row.budget.remainingMicros !== null && row.budget.remainingMicros <= 0);
  const ledgerFailureRows = rows.filter((row) => row.enabled && (row.budget.ledger === "unavailable" || row.budget.ledger === "invalid_policy"));
  return (
    <div className="entityLayout usageLayout">
      <section className="mainPane usageMainPane">
        <div className="overviewStrip">
          <Metric label="requests" value={formatCount(usage.summary.requestCount)} meta={`${formatCount(usage.summary.totalTokens)} tokens`} />
          <Metric label="success rate" value={`${successRate}%`} meta={`${formatCount(usage.summary.successCount)} successful`} />
          <Metric label="errors" value={formatCount(usage.summary.errorCount)} meta="upstream and policy outcomes" />
          <Metric label="actual spend" value={formatMicros(usage.summary.actualCostMicros)} meta={`${usage.providers.length} active services`} />
        </div>
        <div className="tableSectionHeader"><div><strong>Recent requests</strong><span>{usage.events.length} most recent audit events</span></div><span>{usageLoaded ? usage.ledger : "unavailable"}</span></div>
        <EntityTable
          columns={["time", "identity", "service", "operation", "outcome", "latency", "cost"]}
          columnTemplate="92px minmax(170px, 1.2fr) minmax(145px, 1fr) minmax(150px, 1fr) 104px 74px 74px"
          rows={usage.events.map((event) => {
            const service = serviceByProvider.get(event.provider);
            return {
              id: event.id,
              cells: [
                <span className="auditTime" title={formatTimestamp(event.occurred_at_ms, true)}>{formatTimestamp(event.occurred_at_ms)}</span>,
                <span className="auditIdentity"><strong>{event.principal_id ?? event.credential_id ?? event.policy_id ?? "unknown"}</strong><small>{event.auth_type ?? event.tenant_id}</small></span>,
                <EntityName brandIcon={service?.brandIcon} icon={ServerCog} title={service?.name ?? event.provider} subtitle={event.provider} />,
                <span className="auditOperation"><strong>{event.capability ?? event.type}</strong><small>{event.model ?? event.request_id ?? "request"}</small></span>,
                <Status label={event.status_code ? `${event.status_code} ${event.status}` : event.status} tone={usageEventTone(event)} />,
                formatDuration(event.duration_ms),
                formatMicros(event.actual_cost_micros),
              ],
            };
          })}
        />
        {!usage.events.length ? <div className="emptyTable">No request audit events recorded yet.</div> : null}
        <div className="tableSectionHeader secondaryTableHeader"><div><strong>Policy budgets</strong><span>{rows.length} configured policies</span></div><span>{usageLoaded ? "live ledger" : "policy fallback"}</span></div>
        <EntityTable columns={["policy", "tenant", "budget usage", "services", "health"]} columnTemplate="minmax(210px, 1.15fr) minmax(120px, 0.7fr) minmax(250px, 1.45fr) 96px 120px" rows={rows.map((row) => ({ id: usagePolicyId(row), cells: [<EntityName icon={KeyRound} title={usagePolicyId(row)} subtitle={row.tokenRole ?? "custom"} />, row.tenantId, <BudgetUsage row={row} />, effectiveProviderCount(row.providers, services), <UsageHealth row={row} />] }))} />
      </section>
      <aside className="inspector usageInspector">
        <InspectorHeader icon={BarChart3} title="Request activity" subtitle={`${readyServices}/${services.length} services executable`} />
        <div className="attentionGrid">
          <div className={blockedServices.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{blockedServices.length}</strong><span>services need configuration</span></div>
          {usageLoaded ? (
            <>
              <div className={untrackedRows.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{untrackedRows.length}</strong><span>policies not reporting spend</span></div>
              <div className={ledgerFailureRows.length ? "attentionMetric danger" : "attentionMetric healthy"}><strong>{ledgerFailureRows.length}</strong><span>budget ledger failures</span></div>
            </>
          ) : <div className="attentionMetric danger"><strong>!</strong><span>live usage ledger unavailable</span></div>}
          <div className={exhaustedRows.length ? "attentionMetric danger" : "attentionMetric healthy"}><strong>{exhaustedRows.length}</strong><span>policies out of budget</span></div>
        </div>
        <div className="sectionTitle">Provider usage</div>
        <div className="providerUsageList">{usage.providers.length ? usage.providers.map((provider) => {
          const service = serviceByProvider.get(provider.provider);
          return <div key={provider.provider}><EntityName brandIcon={service?.brandIcon} icon={ServerCog} title={service?.name ?? provider.provider} subtitle={`${formatCount(provider.totalTokens)} tokens · ${formatMicros(provider.actualCostMicros)}`} /><span><strong>{formatCount(provider.requestCount)}</strong><small>{provider.errorCount ? `${provider.errorCount} errors` : "healthy"}</small></span></div>;
        }) : <p>No provider activity yet.</p>}</div>
        <div className="sectionTitle">Tenant coverage</div>
        <div className="miniList">{tenantRows.length ? tenantRows.slice(0, 8).map((tenant) => <button type="button" key={tenant.tenantId}>{tenant.tenantId}<span>{tenant.activePolicies ?? tenant.activeKeys}/{tenant.policies ?? tenant.keys} policies · {effectiveProviderCount(tenant.providers, services, tenant.allProviders)} services</span></button>) : <p>No tenant policies yet.</p>}</div>
        <dl className="facts"><dt>ledger</dt><dd>{usage.ledger}</dd><dt>retention</dt><dd>30 days of request metadata</dd><dt>policies</dt><dd>{overview?.policiesActive ?? overview?.keysActive ?? activeKeys.length} active</dd><dt>tenants</dt><dd>{overview?.tenantsTotal ?? tenantRows.length}</dd></dl>
      </aside>
    </div>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{meta}</small></div>;
}

function BudgetUsage({ row }: { row: AdminUsageRow }) {
  const limit = row.budget.limitMicros ?? row.monthlyBudgetMicros;
  const spent = row.budget.spentMicros;
  const blocked = row.budget.ledger === "blocked" || limit === 0;
  const percent = blocked ? 100 : limit !== undefined && limit !== null && spent !== undefined && spent !== null ? Math.min(100, Math.max(0, (spent / limit) * 100)) : null;
  const spendLabel = row.budget.ledger === "unavailable"
    ? "Ledger unavailable"
    : row.budget.ledger === "invalid_policy"
      ? "Invalid budget policy"
      : spent === undefined || spent === null
        ? "Spend unavailable"
        : `${formatMicros(spent)} spent`;
  return (
    <span className="budgetUsage">
      <span><strong>{spendLabel}</strong><small>{formatBudget(limit)} budget</small></span>
      <span className={`budgetTrack${blocked || (percent !== null && percent >= 100) ? " exhausted" : ""}`}><span style={{ width: `${percent ?? 0}%` }} /></span>
    </span>
  );
}

function UsageHealth({ row }: { row: AdminUsageRow }) {
  if (!row.enabled) return <Status label="revoked" tone="revoked" />;
  if (row.budget.ledger === "unavailable") return <Status label="ledger unavailable" tone="revoked" />;
  if (row.budget.ledger === "invalid_policy") return <Status label="invalid policy" tone="revoked" />;
  if (row.budget.ledger === "blocked") return <Status label="budget blocked" tone="revoked" />;
  if (row.budget.ledger === "unmetered") return <Status label="unmetered" tone="neutral" />;
  if (row.budget.ledger === "untracked") return <Status label="untracked" tone="neutral" />;
  if (!row.budget.configured) return <Status label="untracked" tone="neutral" />;
  if (row.budget.remainingMicros !== undefined && row.budget.remainingMicros !== null && row.budget.remainingMicros <= 0) return <Status label="budget blocked" tone="revoked" />;
  if (row.budget.spentMicros === undefined || row.budget.spentMicros === null) return <Status label="awaiting usage" tone="neutral" />;
  return <Status label="healthy" tone="active" />;
}

function EntityTable({ columns, columnTemplate, rows }: { columns: string[]; columnTemplate?: string; rows: Array<{ id: string; active?: boolean; onClick?: () => void; cells: React.ReactNode[] }> }) {
  return (
    <div className="entityTable" style={{ "--cols": columns.length, "--columns": columnTemplate } as React.CSSProperties}>
      <div className="tableHead">{columns.map((column) => <span key={column}>{column}</span>)}</div>
      <div className="tableBody">{rows.map((row) => {
        const content = row.cells.map((cell, index) => <span key={index} data-label={columns[index]}>{cell}</span>);
        const className = `tableRow${row.active ? " selected" : ""}${row.onClick ? " interactive" : ""}`;
        return row.onClick
          ? <button type="button" key={row.id} className={className} onClick={row.onClick}>{content}</button>
          : <div key={row.id} className={className}>{content}</div>;
      })}</div>
    </div>
  );
}

function EntityName({ brandIcon, icon: Icon, title, subtitle }: { brandIcon?: BrandIcon; icon?: IconComponent; title: string; subtitle: string }) {
  return (
    <span className="entityName">
      <span className="entityMark"><BrandMark brandIcon={brandIcon} fallback={Icon} className="entityLogo" /></span>
      <span><span className="entityTitle">{title}</span><small>{subtitle}</small></span>
    </span>
  );
}

function InspectorHeader({ brandIcon, icon: Icon, title, subtitle }: { brandIcon?: BrandIcon; icon?: IconComponent; title: string; subtitle: string }) {
  return (
    <div className="inspectorHeader">
      <span className="inspectorIcon"><BrandMark brandIcon={brandIcon} fallback={Icon} /></span>
      <div><h2>{title}</h2><p>{subtitle}</p></div>
    </div>
  );
}

function BrandMark({ brandIcon, fallback: Fallback, className = "" }: { brandIcon?: BrandIcon; fallback?: IconComponent; className?: string }) {
  if (brandIcon?.body && !brandIcon.body.includes("undefined")) {
    return <svg className={className ? `brandSvg ${className}` : "brandSvg"} viewBox={brandIcon.viewBox ?? "0 0 24 24"} aria-hidden="true" dangerouslySetInnerHTML={{ __html: brandIcon.body }} />;
  }
  return Fallback ? <Fallback className={className || undefined} aria-hidden="true" /> : null;
}

function PanelTitle({ icon: Icon, title, meta }: { icon?: IconComponent; title: string; meta: string }) {
  return <div className="panelTitle">{Icon ? <Icon className="panelIcon" aria-hidden="true" /> : null}<div><h2>{title}</h2><span>{meta}</span></div></div>;
}

function InlineError({ message }: { message: string }) {
  return <div className="inlineError" role="alert"><CircleSlash2 aria-hidden="true" /><span>{message}</span></div>;
}

function InlineNote({ children }: { children: React.ReactNode }) {
  return <div className="inlineNote">{children}</div>;
}

function Status({ label, tone }: { label: string; tone: OutcomeTone }) {
  const Icon = tone === "active" ? CheckCircle2 : tone === "revoked" ? CircleSlash2 : null;
  return <span className={`status ${tone}`}>{Icon ? <Icon aria-hidden="true" /> : null}{label}</span>;
}

function OutcomeStatus({ outcome }: { outcome: ServiceOutcome }) {
  return <Status label={outcome.label} tone={outcome.tone} />;
}

function ReadinessStatus({ readiness }: { readiness?: ProviderReadiness }) {
  if (!readiness) return <span className="status neutral">unknown</span>;
  const tone = readiness.verified ? "active" : !readiness.executable ? "revoked" : "neutral";
  return <Status label={readinessLabel(readiness)} tone={tone} />;
}

function viewTitle(view: View) {
  return ({ catalog: "Catalog", playground: "Playground", policies: "Access", users: "Users", usage: "Usage" } as const)[view];
}

function viewSubtitle(view: View) {
  return {
    catalog: "Service access catalog",
    playground: "Run through the same access path",
    policies: "Policies, credentials, and principal bindings",
    users: "Cloudflare Access identities",
    usage: "Request audit and policy budgets",
  }[view];
}

function viewIcon(view: View): IconComponent {
  return navItems.find((item) => item.id === view)?.icon ?? Boxes;
}

function kindLabel(kind: string) {
  const labels: Record<string, string> = {
    all: "all",
    gateway_platform: "gateway",
    llm: "model",
    "llm-gateway": "gateway",
    media: "media",
    model_provider: "model",
    oauth_platform: "oauth",
    search: "search",
    tool_provider: "tool",
  };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

function kindIcon(kind: string): IconComponent {
  if (kind === "model" || kind === "model_provider" || kind.includes("llm")) return FlaskConical;
  if (kind === "tool" || kind === "tool_provider" || kind === "oauth_platform") return ServerCog;
  return Boxes;
}

function statusKind(status: string) {
  if (status.includes("error") || status.includes("select") || status.includes("invalid") || status.includes("must") || status.includes("returned") || status.includes("paste")) return "error";
  if (status === "loading" || status.startsWith("saving") || status.startsWith("running") || status.startsWith("revoking")) return "pending";
  if (status.includes("loaded") || status.includes("saved") || status.includes("connected") || status.includes("ready") || status.includes("revoked")) return "success";
  return "neutral";
}

function statusLabel(kind: ReturnType<typeof statusKind>) {
  return kind === "success" ? "ready" : kind === "pending" ? "working" : kind === "error" ? "needs attention" : "standby";
}

function isLocalDemoAllowed() {
  const params = new URLSearchParams(window.location.search);
  return params.has("demo") || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

async function settled<T>(loader: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await loader() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function request<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, credentials: "same-origin", headers });
  if (!response.ok) throw new Error((await response.text()) || `${path} failed with ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error(`${path} returned a non-JSON response from ${baseUrl}`);
  return response.json() as Promise<T>;
}

async function playgroundRequest(baseUrl: string, path: string, init: RequestInit = {}): Promise<string> {
  const headers = new Headers(init.headers);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, credentials: "same-origin", headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.arrayBuffer();
  const text = isTextualResponse(contentType) ? new TextDecoder().decode(body) : "";
  if (!response.ok) throw new Error(text.trim() || `${path} failed with ${response.status}`);
  if (response.status === 204 || body.byteLength === 0) return `HTTP ${response.status} ${response.statusText || "No Content"}`.trim();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  if (text) return text;
  return `HTTP ${response.status} ${response.statusText || "OK"}\n${contentType || "binary"} response (${body.byteLength} bytes)`;
}

function isTextualResponse(contentType: string) {
  return /(^text\/|json|xml|html|csv|yaml|graphql|javascript)/i.test(contentType);
}

function readyCount(services: ServiceItem[]) {
  return services.filter((service) => service.readiness?.executable).length;
}

function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBudget(value: number | null | undefined) {
  if (value === undefined || value === null) return "unlimited";
  if (value === 0) return "blocked";
  return formatMicros(value);
}

function formatMicros(value: number | null | undefined) {
  if (value === undefined || value === null) return "unknown";
  if (!value) return "none";
  if (value < 10_000) return "<$0.01";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

function formatCount(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { notation: value !== undefined && value !== null && Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value ?? 0);
}

function formatDuration(value: number | null | undefined) {
  if (value === undefined || value === null) return "unknown";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function formatTimestamp(value: number, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return full
    ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "never";
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "unknown";
  if (elapsed < 60_000) return "checked just now";
  if (elapsed < 3_600_000) return `checked ${Math.floor(elapsed / 60_000)}m ago`;
  return `checked ${Math.floor(elapsed / 3_600_000)}h ago`;
}

function usageEventTone(event: UsageAuditEvent): OutcomeTone {
  if (event.status === "success" || (event.status_code !== undefined && event.status_code !== null && event.status_code < 400)) return "active";
  if (event.status === "denied" || event.status === "provider_error" || event.status === "client_error" || event.status === "timeout" || (event.status_code !== undefined && event.status_code !== null && event.status_code >= 400)) return "revoked";
  return "neutral";
}

function usagePolicyId(row: AdminUsageRow) {
  return row.policyId ?? row.kid;
}

function effectiveProviderCount(providerIds: string[], services: ServiceItem[], allProviders = providerIds.length === 0) {
  return allProviders ? `all ${new Set(services.map((service) => service.provider)).size}` : String(providerIds.length);
}

function catalogModels(routes: RouteCatalog): CatalogModel[] {
  return routes.openaiCompatible.flatMap((route) => route.models.map((model) => ({ id: model.id, provider: route.provider, capabilities: model.capabilities })));
}

function groupedProviders(providers: ProviderRow[], query: string) {
  const needle = query.trim().toLowerCase();
  const matches = providers.filter((provider) => {
    const text = [provider.id, provider.display_name, provider.service_kind, provider.class, provider.capabilities.map((capability) => capability.id).join(" ")].join(" ").toLowerCase();
    return !needle || text.includes(needle);
  });
  const groups = matches.reduce((acc, provider) => {
    const kind = provider.service_kind;
    acc.set(kind, [...(acc.get(kind) ?? []), provider]);
    return acc;
  }, new Map<string, ProviderRow[]>());
  return Array.from(groups.entries())
    .map(([kind, groupProviders]) => ({ kind, providers: groupProviders.sort((a, b) => a.display_name.localeCompare(b.display_name)) }))
    .sort((a, b) => kindLabel(a.kind).localeCompare(kindLabel(b.kind)));
}

function policyFormFromPolicy(key: AccessPolicy): PolicyForm {
  return {
    policyId: key.policyId,
    tokenRole: key.tokenRole ?? "",
    tenantId: key.tenantId ?? "default",
    enabled: key.enabled,
    monthlyBudgetMicros: currencyInput(key.monthlyBudgetMicros),
    requestCostMicros: key.requestCostMicros?.toString() ?? "",
    providers: key.providers,
    allProviders: key.providers.length === 0,
  };
}

function adminOverviewFromKeys(keys: AccessPolicy[], providers: ProviderRow[], routes: RouteCatalog): AdminOverview {
  const tenants = tenantSummaryFallback(keys);
  return {
    policiesTotal: keys.length,
    policiesActive: keys.filter((key) => key.enabled).length,
    keysTotal: keys.length,
    keysActive: keys.filter((key) => key.enabled).length,
    tenantsTotal: tenants.length,
    providerCount: providers.length,
    openaiCompatibleProviders: routes.openaiCompatible.length,
    manifestRoutes: routes.manifestProxy.length,
    monthlyBudgetMicros: keys.reduce((total, key) => total + (key.monthlyBudgetMicros ?? 0), 0),
    requestCostMicros: keys.reduce((total, key) => total + (key.requestCostMicros ?? 0), 0),
  };
}

function serviceItems(providers: ProviderRow[], routes: RouteCatalog, readinessByProvider: Record<string, ProviderReadiness> = {}, accessByProvider: Map<string, ProviderAccess> = new Map()): ServiceItem[] {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const modelServices = routes.openaiCompatible.map((route) => {
    const provider = providerById.get(route.provider);
    const modelCapabilities = route.models.flatMap((model) => model.capabilities);
    const modelEndpoints = route.models.flatMap((model) => model.endpoints);
    return {
      id: `${route.provider}:llm`,
      name: provider?.display_name || route.provider,
      provider: route.provider,
      kind: provider?.service_kind || "llm",
      category: provider?.class || "model route",
      capabilities: unique([...(provider?.capabilities.map((capability) => capability.id) ?? []), ...modelCapabilities]),
      surfaces: unique([...route.endpoints, ...modelEndpoints]),
      route: route.endpoints.join(", ") || "/v1/chat/completions",
      routeCount: unique([...route.endpoints, ...modelEndpoints]).length,
      models: route.models.length,
      modelIds: route.models.map((model) => model.id),
      access: accessByProvider.get(route.provider),
      readiness: readinessByProvider[route.provider],
      brandIcon: providerBrandIcon(route.provider),
    };
  });
  const proxyRoutesByProvider = routes.manifestProxy.reduce((groups, route) => {
    groups.set(route.provider, [...(groups.get(route.provider) ?? []), route]);
    return groups;
  }, new Map<string, RouteCatalog["manifestProxy"]>());
  const toolServices = Array.from(proxyRoutesByProvider.entries()).map(([providerId, providerRoutes]) => {
    const provider = providerById.get(providerId);
    return {
      id: `${providerId}:service`,
      name: provider?.display_name || providerId,
      provider: providerId,
      kind: provider?.service_kind || "service",
      category: provider?.class || "manifest proxy",
      capabilities: provider?.capabilities.map((capability) => capability.id) ?? [],
      surfaces: unique(providerRoutes.flatMap((route) => route.methods)),
      route: providerRoutes.map((route) => route.route).join(", "),
      routeCount: providerRoutes.length,
      models: 0,
      modelIds: [],
      access: accessByProvider.get(providerId),
      readiness: readinessByProvider[providerId],
      brandIcon: providerBrandIcon(providerId),
    };
  });
  const providerServices = providers
    .filter((provider) => !modelServices.some((service) => service.provider === provider.id) && !toolServices.some((service) => service.provider === provider.id))
    .map((provider) => ({
      id: `${provider.id}:provider`,
      name: provider.display_name || provider.id,
      provider: provider.id,
      kind: provider.service_kind,
      category: provider.class,
      capabilities: provider.capabilities.map((capability) => capability.id),
      surfaces: ["provider"],
      route: "/v1/proxy",
      routeCount: 0,
      models: 0,
      modelIds: [],
      access: accessByProvider.get(provider.id),
      readiness: readinessByProvider[provider.id],
      brandIcon: providerBrandIcon(provider.id),
    }));
  return [...modelServices, ...toolServices, ...providerServices].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

function matchesServiceQuery(item: ServiceItem, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.id, item.name, item.provider, item.kind, item.category, item.capabilities.join(" "), item.modelIds.join(" ")]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function providerBrandIcon(providerId: string): BrandIcon | undefined {
  return (providerIconManifest.icons as Record<string, BrandIcon>)[providerId];
}

interface CatalogModel {
  id: string;
  provider: string;
  capabilities: string[];
}

function playgroundCurl(form: PlaygroundForm, payload: unknown, route?: RouteCatalog["manifestProxy"][number]) {
  const method = "POST";
  const endpoint = playgroundAccessEndpoint(form, route);
  const lines = [`curl -X ${method} '${window.location.origin}${endpoint}' \\`, `  -b '$CLOUDFLARE_ACCESS_COOKIE' \\`, `  -H 'content-type: application/json' \\`, `  -d '${JSON.stringify(payload ?? {}, null, 2).replace(/'/g, `'\\''`)}'`];
  return lines.join("\n");
}

function playgroundRequestPreview(form: PlaygroundForm, mode: "json" | "curl", route?: RouteCatalog["manifestProxy"][number]) {
  try {
    const payload = playgroundPayload(form, route);
    return mode === "json" ? JSON.stringify(payload, null, 2) : playgroundCurl(form, payload, route);
  } catch (error) {
    return errorMessage(error);
  }
}

function demoUsageSnapshot(): UsageSnapshot {
  const now = Date.now();
  const events: UsageAuditEvent[] = [
    demoUsageEvent("usage_6", now - 26_000, "admin@example.com", "maintainer_models", "openai", "llm.responses", "gpt-4.1", 200, 842, 1000, "success", 1814),
    demoUsageEvent("usage_5", now - 74_000, "maintainer@example.com", "maintainer_models", "anthropic", "llm.messages", "claude-sonnet", 200, 1180, 1000, "success", 2631),
    demoUsageEvent("usage_4", now - 146_000, "admin@example.com", "openclaw_tools", "tavily", "web.search", null, 200, 436, 500, "success", 0),
    demoUsageEvent("usage_3", now - 318_000, "research@example.com", "user_research", "google-gemini", "llm.generate", "gemini-default", 429, 218, 0, "provider_error", 0),
    demoUsageEvent("usage_2", now - 522_000, "admin@example.com", "maintainer_models", "openrouter", "llm.chat", "openrouter/auto", 200, 1640, 1000, "success", 3250),
    demoUsageEvent("usage_1", now - 816_000, "maintainer@example.com", "openclaw_tools", "replicate", "media.predict", null, 502, 904, 0, "provider_error", 0),
  ];
  return {
    ledger: "ready",
    summary: { requestCount: 1284, successCount: 1247, errorCount: 37, inputTokens: 1_482_402, outputTokens: 382_151, totalTokens: 1_864_553, actualCostMicros: 8_432_100 },
    providers: [
      { provider: "openai", requestCount: 604, successCount: 596, errorCount: 8, totalTokens: 904_814, actualCostMicros: 3_904_000 },
      { provider: "anthropic", requestCount: 382, successCount: 374, errorCount: 8, totalTokens: 612_201, actualCostMicros: 3_120_000 },
      { provider: "tavily", requestCount: 174, successCount: 170, errorCount: 4, totalTokens: 0, actualCostMicros: 870_000 },
      { provider: "openrouter", requestCount: 88, successCount: 82, errorCount: 6, totalTokens: 347_538, actualCostMicros: 538_100 },
      { provider: "replicate", requestCount: 36, successCount: 25, errorCount: 11, totalTokens: 0, actualCostMicros: 0 },
    ],
    events,
  };
}

function demoUsageEvent(id: string, occurredAt: number, principal: string, policy: string, providerId: string, capability: string, model: string | null, statusCode: number, durationMs: number, cost: number, status: string, tokens: number): UsageAuditEvent {
  return {
    id,
    type: "clawrouter.usage.v1",
    occurred_at_ms: occurredAt,
    tenant_id: principal === "research@example.com" ? "research" : "openclaw",
    policy_id: policy,
    credential_id: null,
    principal_id: principal,
    auth_type: "access",
    key_id: "",
    request_id: `req_${id.slice(-1)}`,
    provider: providerId,
    capability,
    model,
    input_tokens: tokens ? Math.round(tokens * 0.7) : null,
    output_tokens: tokens ? Math.round(tokens * 0.3) : null,
    total_tokens: tokens,
    reserved_cost_micros: cost,
    actual_cost_micros: cost,
    status_code: statusCode,
    duration_ms: durationMs,
    status,
  };
}

function demoData() {
  const providers = [
    provider("anthropic", "Anthropic", "anthropic_compatible", "model_provider", ["llm.messages"]),
    provider("aws-bedrock", "AWS Bedrock", "custom_adapter", "model_provider", ["llm.invoke", "llm.stream"]),
    provider("azure-openai", "Azure OpenAI", "openai_compatible", "model_provider", ["llm.chat", "llm.embeddings"]),
    provider("cloudflare-ai-gateway", "Cloudflare AI Gateway", "cloudflare_ai_gateway", "gateway_platform", ["llm.chat", "llm.responses"]),
    provider("cohere", "Cohere", "rest_json", "model_provider", ["llm.chat", "llm.embeddings"]),
    provider("deepseek", "DeepSeek", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("fireworks", "Fireworks AI", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("google-gemini", "Google Gemini", "rest_json", "model_provider", ["llm.generate", "llm.stream"]),
    provider("groq", "Groq", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("huggingface", "Hugging Face", "rest_json", "model_provider", ["llm.invoke"]),
    provider("minimax", "MiniMax", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("mistral", "Mistral AI", "openai_compatible", "model_provider", ["llm.chat", "llm.embeddings"]),
    provider("openai", "OpenAI", "openai_compatible", "model_provider", ["llm.responses", "llm.chat", "llm.embeddings"]),
    provider("openrouter", "OpenRouter", "openai_compatible", "gateway_platform", ["llm.chat"]),
    provider("perplexity", "Perplexity", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("replicate", "Replicate", "rest_json", "tool_provider", ["media.predict", "media.prediction.read"]),
    provider("tavily", "Tavily", "rest_json", "tool_provider", ["web.search", "web.extract", "web.crawl"]),
    provider("together", "Together AI", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("xai", "xAI", "openai_compatible", "model_provider", ["llm.chat"]),
  ];
  const routes: RouteCatalog = {
    openaiCompatible: [
      modelRoute("anthropic", ["/v1/messages"], [modelEntry("anthropic/default", ["llm.messages"], ["/v1/messages"])]),
      modelRoute("aws-bedrock", ["/model/{model}/invoke", "/model/{model}/invoke-with-response-stream"], [modelEntry("bedrock/model", ["llm.invoke", "llm.stream"], ["/model/{model}/invoke", "/model/{model}/invoke-with-response-stream"])]),
      modelRoute("azure-openai", ["/openai/deployments/{deployment}/chat/completions", "/openai/deployments/{deployment}/embeddings"], [modelEntry("azure-openai/deployment", ["llm.chat", "llm.embeddings"], ["/openai/deployments/{deployment}/chat/completions", "/openai/deployments/{deployment}/embeddings"])]),
      modelRoute("cloudflare-ai-gateway", ["/"], [modelEntry("cloudflare-ai-gateway/auto", ["llm.chat", "llm.responses"], ["/"])]),
      modelRoute("cohere", ["/v2/chat", "/v2/embed"], [modelEntry("cohere/default", ["llm.chat", "llm.embeddings"], ["/v2/chat", "/v2/embed"])]),
      modelRoute("deepseek", ["/chat/completions"], [modelEntry("deepseek/default", ["llm.chat"], ["/chat/completions"])]),
      modelRoute("fireworks", ["/v1/chat/completions"], [modelEntry("fireworks/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("google-gemini", ["/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent"], [modelEntry("google/gemini-default", ["llm.generate", "llm.stream"], ["/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent"])]),
      modelRoute("groq", ["/v1/chat/completions"], [modelEntry("groq/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("huggingface", ["/models/{model}"], [modelEntry("huggingface/model", ["llm.invoke"], ["/models/{model}"])]),
      modelRoute("minimax", ["/v1/chat/completions"], [modelEntry("minimax/MiniMax-M3", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("mistral", ["/v1/chat/completions", "/v1/embeddings"], [modelEntry("mistral/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("openai", ["/v1/responses", "/v1/chat/completions", "/v1/embeddings"], [modelEntry("openai/gpt-5.5-mini", ["llm.responses", "llm.chat"], ["/v1/responses", "/v1/chat/completions"]), modelEntry("openai/text-embedding-3-large", ["llm.embeddings"], ["/v1/embeddings"])]),
      modelRoute("openrouter", ["/v1/chat/completions"], [modelEntry("openrouter/auto", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("perplexity", ["/chat/completions"], [modelEntry("perplexity/default", ["llm.chat"], ["/chat/completions"])]),
      modelRoute("together", ["/v1/chat/completions"], [modelEntry("together/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("xai", ["/v1/chat/completions"], [modelEntry("xai/default", ["llm.chat"], ["/v1/chat/completions"])]),
    ],
    manifestProxy: [
      manifestRoute("replicate", "predictions", "/v1/proxy/replicate/predictions", ["POST"]),
      manifestRoute("replicate", "prediction", "/v1/proxy/replicate/prediction", ["GET"], ["prediction_id"]),
      manifestRoute("tavily", "search", "/v1/proxy/tavily/search", ["POST"]),
      manifestRoute("tavily", "extract", "/v1/proxy/tavily/extract", ["POST"]),
      manifestRoute("tavily", "crawl", "/v1/proxy/tavily/crawl", ["POST"]),
    ],
  };
  const keys: AccessPolicy[] = [
    { policyId: "maintainer_models", enabled: true, providers: ["anthropic", "aws-bedrock", "azure-openai", "cloudflare-ai-gateway", "cohere", "deepseek", "fireworks", "google-gemini", "groq", "huggingface", "minimax", "mistral", "openai", "openrouter", "perplexity", "together", "xai"], tenantId: "openclaw", tokenRole: "maintainer", monthlyBudgetMicros: 250000000, requestCostMicros: 1000 },
    { policyId: "openclaw_tools", enabled: true, providers: ["replicate", "tavily"], tenantId: "openclaw", tokenRole: "tooling", monthlyBudgetMicros: 75000000, requestCostMicros: 500 },
    { policyId: "user_research", enabled: true, providers: ["openai", "google-gemini", "tavily"], tenantId: "research", tokenRole: "user", monthlyBudgetMicros: 50000000, requestCostMicros: 1000 },
    { policyId: "sandbox_eval", enabled: false, providers: ["openai"], tenantId: "sandbox", tokenRole: "sandbox", monthlyBudgetMicros: 5000000, requestCostMicros: 500 },
  ];
  const credentials: ProxyCredential[] = [
    { credentialId: "maintainer_cli", policyId: "maintainer_models", enabled: true },
    { credentialId: "openclaw_tools_ci", policyId: "openclaw_tools", enabled: true },
    { credentialId: "research_notebook", policyId: "user_research", enabled: false },
  ];
  const connections: ProviderConnection[] = providers.map((item) => ({ providerId: item.id, enabled: !demoDisabledProviderIds.has(item.id) }));
  const users: AccessUser[] = [
    { email: "admin@example.com", role: "admin", tenantId: "openclaw", enabled: true, groups: ["maintainers"] },
    { email: "maintainer@example.com", role: "user", tenantId: "docs", enabled: true, groups: ["maintainers"] },
    { email: "research@example.com", role: "user", tenantId: "research", enabled: true, groups: [] },
  ];
  const bindings: PolicyBinding[] = [
    { policyId: "maintainer_models", principalType: "group", principalId: "maintainers", enabled: true, priority: 10 },
    { policyId: "openclaw_tools", principalType: "group", principalId: "maintainers", enabled: true, priority: 20 },
    { policyId: "user_research", principalType: "user", principalId: "research@example.com", enabled: true, priority: 100 },
  ];
  const models = routes.openaiCompatible.flatMap((route) => route.models.map((model) => ({ ...model, provider: route.provider })));
  const session = { authenticated: true, auth: "demo", role: "admin" as AccessRole, email: "admin@example.com", tenantId: "openclaw", groups: ["maintainers"] };
  const sessionPolicies = effectiveAccess(users[0], keys, bindings, []).policies;
  const entitlements: EntitlementsResponse = {
    session,
    providers: providers.map((item) => {
      const policies = sessionPolicies.filter((key) => policyCoversProvider(key, item.id)).map((key) => key.policyId);
      return {
        provider: item.id,
        displayName: item.display_name,
        serviceKind: item.service_kind,
        allowed: policies.length > 0,
        policies,
        readiness: demoReadiness(item, routes),
      };
    }),
  };
  const accessByProvider = accessMap(entitlements);
  const readinessByProvider = readinessMap(entitlements.providers.map((item) => item.readiness));
  const usageRows = keys.map(policyUsageFallback);
  const usage = demoUsageSnapshot();
  const tenants = tenantSummaryFallback(keys);
  const overview = adminOverviewFromKeys(keys, providers, routes);
  return { session, providers, routes, keys, credentials, connections, users, bindings, overview, tenants, usageRows, usage, entitlements, services: serviceItems(providers, routes, readinessByProvider, accessByProvider), models };
}

function demoReadiness(provider: ProviderRow, routes: RouteCatalog): ProviderReadiness {
  const openaiRoute = routes.openaiCompatible.find((route) => route.provider === provider.id);
  const manifestRoutes = routes.manifestProxy.filter((route) => route.provider === provider.id);
  const grantRequired = provider.class.includes("oauth");
  const declared = Boolean(openaiRoute || manifestRoutes.length);
  const connectionEnabled = !demoDisabledProviderIds.has(provider.id);
  const missingConfig = demoMissingConfigProviderIds.has(provider.id);
  const status = !connectionEnabled ? "disabled" : missingConfig ? "missing_config" : grantRequired ? "grant_required" : declared ? "verified" : "declared";
  return {
    id: provider.id,
    displayName: provider.display_name,
    class: provider.class,
    serviceKind: provider.service_kind,
    requiredConfig: missingConfig ? [`${provider.id.toUpperCase().replace(/-/g, "_")}_CONFIG`] : [],
    optionalConfig: [],
    missingConfig: missingConfig ? [`${provider.id.toUpperCase().replace(/-/g, "_")}_CONFIG`] : [],
    configPresent: !missingConfig,
    connectionEnabled,
    oauthGrantRequired: grantRequired,
    oauthGrantCount: 0,
    openaiCompatible: Boolean(openaiRoute),
    manifestRoutes: manifestRoutes.length,
    modelCount: openaiRoute?.models.length ?? 0,
    executable: status === "verified",
    verified: status === "verified",
    lastCheckedAt: status === "verified" ? new Date(Date.now() - 45_000).toISOString() : null,
    latencyMs: status === "verified" ? 184 : null,
    status,
    reasons: status === "verified" ? [] : status === "disabled" ? ["Provider connection is disabled by an administrator."] : status === "grant_required" ? ["OAuth grant required before service calls can run."] : status === "missing_config" ? ["Provider config is not present in the runtime environment."] : ["Provider is declared but has no executable route."],
  };
}

function modelRoute(provider: string, endpoints: string[], models: RouteCatalog["openaiCompatible"][number]["models"]): RouteCatalog["openaiCompatible"][number] {
  return { provider, endpoints, models };
}

function modelEntry(id: string, capabilities: string[], endpoints: string[]) {
  return { id, capabilities, endpoints };
}

function manifestRoute(provider: string, endpoint: string, route: string, methods: string[], pathParams: string[] = []): RouteCatalog["manifestProxy"][number] {
  return { provider, endpoint, route, methods, pathParams };
}

function provider(id: string, display_name: string, providerClass: string, service_kind: string, capabilities: string[]): ProviderRow {
  return { id, display_name, class: providerClass, service_kind, meter: "request", capabilities: capabilities.map((capability) => ({ id: capability })) };
}

createRoot(document.getElementById("root")!).render(<App />);
