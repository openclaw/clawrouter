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

interface KeyPolicy {
  kid: string;
  enabled: boolean;
  providers: string[];
  tenantId?: string | null;
  tokenRole?: string | null;
  monthlyBudgetMicros?: number | null;
  requestCostMicros?: number | null;
}

interface SessionResponse {
  authenticated: boolean;
  auth: string;
  role: AccessRole;
  email?: string | null;
  subject?: string | null;
  tenantId?: string | null;
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
}

interface AdminOverview {
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
  kid: string;
  tenantId: string;
  enabled: boolean;
  providers: string[];
  tokenRole?: string | null;
  monthlyBudgetMicros?: number | null;
  requestCostMicros?: number | null;
  budget: BudgetStatus;
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
  kid: string;
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
  role: AccessRole;
  tenantId: string;
  enabled: boolean;
}

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

const demo = demoData();
const demoServiceRoute = demo.routes.manifestProxy.find((route) => route.provider === "tavily") ?? demo.routes.manifestProxy[0];
const emptyRoutes: RouteCatalog = { openaiCompatible: [], manifestProxy: [] };
const emptySession: SessionResponse = { authenticated: false, auth: "access", role: "user", email: null, tenantId: "default" };

const defaultPolicy: PolicyForm = {
  kid: "svc_docs",
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
  role: "user",
  tenantId: "default",
  enabled: true,
};

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
  const [keys, setKeys] = useState<KeyPolicy[]>(allowDemo ? demo.keys : []);
  const [policyDataLoaded, setPolicyDataLoaded] = useState(allowDemo);
  const [users, setUsers] = useState<AccessUser[]>(allowDemo ? demo.users : []);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(allowDemo ? demo.overview : null);
  const [tenantSummaries, setTenantSummaries] = useState<AdminTenantSummary[]>(allowDemo ? demo.tenants : []);
  const [usageRows, setUsageRows] = useState<AdminUsageRow[]>(allowDemo ? demo.usageRows : []);
  const [usageLoaded, setUsageLoaded] = useState(allowDemo);
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | null>(allowDemo ? demo.entitlements : null);
  const [providerReadiness, setProviderReadiness] = useState<Record<string, ProviderReadiness>>(allowDemo ? readinessMap(demo.entitlements.providers.map((item) => item.readiness)) : {});
  const [policyForm, setPolicyForm] = useState<PolicyForm>(allowDemo && demo.keys[0] ? policyFormFromKey(demo.keys[0]) : defaultPolicy);
  const [accessForm, setAccessForm] = useState<AccessForm>(allowDemo && demo.users[0] ? accessFormFromUser(demo.users[0]) : defaultAccess);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedServiceId, setSelectedServiceId] = useState(demo.services[0]?.id ?? "");
  const [selectedPolicyId, setSelectedPolicyId] = useState(allowDemo ? demo.keys[0]?.kid ?? "" : "");
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
  const selectedPolicy = keys.find((key) => key.kid === selectedPolicyId);
  const selectedUser = users.find((user) => user.email === selectedUserEmail) ?? users[0];
  const selectedModel = models.find((model) => model.id === playground.model) ?? models[0];
  const selectedServiceRoute = serviceRoutes.find((route) => routeKey(route) === playground.serviceRoute) ?? serviceRoutes[0];
  const busy = status === "loading" || status.startsWith("saving") || status.startsWith("running") || status.startsWith("revoking");
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
        const [keyData, userData, readinessData] = await Promise.all([
          request<{ keys: KeyPolicy[] }>(gatewayOrigin, "/v1/admin/keys"),
          request<{ users: AccessUser[] }>(gatewayOrigin, "/v1/admin/access-users"),
          request<{ providers: ProviderReadiness[] }>(gatewayOrigin, "/v1/admin/provider-status"),
        ]);
        setKeys(keyData.keys);
        if (!policyDataLoaded || demoMode) {
          const refreshedPolicy = keyData.keys.find((key) => key.kid === selectedPolicyId) ?? keyData.keys[0];
          setSelectedPolicyId(refreshedPolicy?.kid ?? "");
          setPolicyForm(refreshedPolicy ? policyFormFromKey(refreshedPolicy) : { ...defaultPolicy, kid: "", tenantId: sessionData.tenantId ?? "default", providers: [...defaultPolicy.providers] });
        }
        setUsers(userData.users);
        setProviderReadiness((current) => ({ ...current, ...readinessMap(readinessData.providers) }));
        const [overviewResult, tenantResult] = await Promise.all([
          settled(() => request<AdminOverview>(gatewayOrigin, "/v1/admin/overview")),
          settled(() => request<{ tenants: AdminTenantSummary[] }>(gatewayOrigin, "/v1/admin/users")),
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
          setTenantSummaries(tenantSummaryFallback(keyData.keys));
          refreshWarnings = [...refreshWarnings, `tenant summary unavailable: ${tenantResult.error}`];
        }
        setUsageRows([]);
        setUsageLoaded(false);
        setPolicyDataLoaded(true);
        if (view === "usage") setUsageRefreshKey((current) => current + 1);
      } else {
        const user = {
          email: sessionData.email ?? "access-user",
          role: sessionData.role,
          tenantId: sessionData.tenantId ?? "default",
          enabled: sessionData.authenticated,
        };
        setKeys([]);
        setPolicyDataLoaded(false);
        setUsers([user]);
        setAdminOverview(null);
        setTenantSummaries([]);
        setUsageRows([]);
        setUsageLoaded(false);
        setSelectedUserEmail(user.email);
        setAccessForm(accessFormFromUser(user));
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
        setPolicyDataLoaded(true);
        setUsers(demo.users);
        setAdminOverview(demo.overview);
        setTenantSummaries(demo.tenants);
        setUsageRows(demo.usageRows);
        setUsageLoaded(true);
        setEntitlements(demo.entitlements);
        setProviderReadiness(readinessMap(demo.entitlements.providers.map((item) => item.readiness)));
        setSelectedPolicyId(demo.keys[0]?.kid ?? "");
        setPolicyForm(demo.keys[0] ? policyFormFromKey(demo.keys[0]) : defaultPolicy);
        setSelectedUserEmail(demo.users[0]?.email ?? "");
        setAccessForm(demo.users[0] ? accessFormFromUser(demo.users[0]) : defaultAccess);
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
      setStatus("saving grant");
      if (!policyForm.allProviders && !policyForm.providers.length) throw new Error("select at least one service");
      if (!/^[A-Za-z0-9_]{4,}$/.test(policyForm.kid)) throw new Error("grant id must use 4 or more letters, numbers, or underscores");
      const existingPolicy = keys.some((key) => key.kid === policyForm.kid);
      if (existingPolicy && selectedPolicyId !== policyForm.kid) throw new Error("grant id already exists; select it from the grant list to edit it");
      const next: KeyPolicy = {
        kid: policyForm.kid,
        enabled: policyForm.enabled,
        providers: policyForm.allProviders ? [] : policyForm.providers,
        tenantId: policyForm.tenantId || "default",
        tokenRole: policyForm.tokenRole || null,
        monthlyBudgetMicros: optionalCurrencyMicros(policyForm.monthlyBudgetMicros) ?? null,
        requestCostMicros: optionalNumber(policyForm.requestCostMicros) ?? null,
      };
      if (demoMode) {
        applyDemoKeys((current) => [next, ...current.filter((key) => key.kid !== next.kid)]);
        setSelectedPolicyId(next.kid);
        setStatus("saved grant");
        return;
      }
      const generatedSecret = existingPolicy ? "" : generateSecret();
      const body = generatedSecret ? { ...next, secretSha256: await sha256Hex(generatedSecret) } : next;
      await request<KeyPolicy>(gatewayOrigin, `/v1/admin/keys/${encodeURIComponent(policyForm.kid)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await refresh();
      setSelectedPolicyId(next.kid);
      setPolicyForm(policyFormFromKey(next));
      setIssuedKey(generatedSecret ? `clawrouter-live-${policyForm.kid}-${generatedSecret}` : "");
      setStatus("saved grant");
    } catch (error) {
      const message = errorMessage(error);
      setPolicyError(message);
      setStatus(message);
    }
  }

  async function refreshUsageLedger() {
    if (demoMode || session.role !== "admin") return;
    const result = await settled(() => request<{ keys: AdminUsageRow[] }>(gatewayOrigin, "/v1/admin/usage"));
    if (result.ok) {
      setUsageRows(result.value.keys);
      setUsageLoaded(true);
      return;
    }
    setUsageRows([]);
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
      const next = { ...accessForm, email };
      if (demoMode) {
        setUsers((current) => [next, ...current.filter((user) => user.email !== email)]);
        setSelectedUserEmail(email);
        setStatus("saved user");
        return;
      }
      await request<AccessUser>(gatewayOrigin, `/v1/admin/access-users/${encodeURIComponent(email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: next.tenantId, enabled: next.enabled }),
      });
      await refresh();
      setStatus("saved user");
    } catch (error) {
      const message = errorMessage(error);
      setUserError(message);
      setStatus(message);
    }
  }

  async function revoke(kid: string) {
    try {
      setStatus(`revoking ${kid}`);
      if (demoMode) {
        applyDemoKeys((current) => current.map((key) => (key.kid === kid ? { ...key, enabled: false } : key)));
        setStatus(`revoked ${kid}`);
        return;
      }
      await request<KeyPolicy>(gatewayOrigin, `/v1/admin/keys/${encodeURIComponent(kid)}/revoke`, { method: "POST" });
      await refresh();
      setStatus(`revoked ${kid}`);
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

  function editPolicy(key: KeyPolicy) {
    setIssuedKey("");
    setSelectedPolicyId(key.kid);
    setPolicyForm(policyFormFromKey(key));
  }

  function startNewPolicy() {
    setIssuedKey("");
    setPolicyError("");
    setSelectedPolicyId("");
    setPolicyForm({ ...defaultPolicy, kid: "", tenantId: session.tenantId ?? "default", providers: [...defaultPolicy.providers] });
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

  function applyDemoKeys(updater: (current: KeyPolicy[]) => KeyPolicy[]) {
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
            policyFallbackAuthoritative={session.role === "admin" && policyDataLoaded}
            query={query}
            setQuery={setQuery}
            kind={kind}
            setKind={setKind}
            kinds={kinds}
            canAdminister={session.role === "admin"}
            onSelect={(service) => setSelectedServiceId(service.id)}
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
            keys={keys}
            selected={selectedPolicy}
            providers={providers}
            form={policyForm}
            setForm={setPolicyForm}
            issuedKey={issuedKey}
            error={policyError}
            onSave={savePolicy}
            onNew={startNewPolicy}
            onEdit={editPolicy}
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
            services={services}
            form={accessForm}
            setForm={setAccessForm}
            error={userError}
            onOpenPolicy={(policy) => {
              editPolicy(policy);
              navigateTo("policies");
            }}
            onSelect={(user) => {
              setSelectedUserEmail(user.email);
              setAccessForm(accessFormFromUser(user));
            }}
            onSave={saveUser}
            busy={busy}
          />
        ) : null}

        {view === "usage" && session.role === "admin" ? <UsageScreen keys={keys} services={services} overview={adminOverview} tenants={tenantSummaries} usageRows={usageRows} usageLoaded={usageLoaded} /> : null}
      </section>
    </main>
  );
}

function CatalogScreen({ services, allServices, selected, policies, policyFallbackAuthoritative, query, setQuery, kind, setKind, kinds, canAdminister, onSelect, onPlay, onAdd }: {
  services: ServiceItem[];
  allServices: ServiceItem[];
  selected?: ServiceItem;
  policies: KeyPolicy[];
  policyFallbackAuthoritative: boolean;
  query: string;
  setQuery: (value: string) => void;
  kind: string;
  setKind: (value: string) => void;
  kinds: string[];
  canAdminister: boolean;
  onSelect: (service: ServiceItem) => void;
  onPlay: (service: ServiceItem) => void;
  onAdd: (service: ServiceItem) => void;
}) {
  const activePolicies = policies.filter((policy) => policy.enabled);
  const queryMatchedServices = allServices.filter((service) => matchesServiceQuery(service, query));
  const selectedPolicies = selected ? activePolicies.filter((policy) => policyCoversProvider(policy, selected.provider)) : [];
  const kindCounts = new Map(kinds.map((item) => [item, item === "all" ? queryMatchedServices.length : queryMatchedServices.filter((service) => service.kind === item).length]));
  const servicePolicies = (service: ServiceItem) => activePolicies.filter((policy) => policyCoversProvider(policy, service.provider));
  const outcomes = allServices.map((service) => serviceOutcome(service, servicePolicies(service), policyFallbackAuthoritative));
  const usableCount = outcomes.filter((outcome) => outcome.playable).length;
  const grantedCount = allServices.filter((service) => servicePolicies(service).length || service.access?.allowed).length;
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
          columns={["service", "status", "granted by", "kind", "interface"]}
          columnTemplate="minmax(220px, 1.45fr) 138px minmax(130px, 0.8fr) 120px minmax(150px, 0.9fr)"
          rows={services.map((service) => {
            const policiesForService = servicePolicies(service);
            const outcome = serviceOutcome(service, policiesForService, policyFallbackAuthoritative);
            return {
              id: service.id,
              active: selected?.id === service.id,
              onClick: () => onSelect(service),
              cells: [
                <EntityName brandIcon={service.brandIcon} icon={kindIcon(service.kind)} title={service.name} subtitle={`${service.provider} · ${kindLabel(service.kind)}`} />,
                <OutcomeStatus outcome={outcome} />,
                <GrantChips names={grantNamesForService(service, policiesForService)} />,
                kindLabel(service.kind),
                service.surfaces.join(", "),
              ],
            };
          })}
        />
      </section>
      <aside className="inspector">
        {selected ? (
          <>
            {(() => {
              const outcome = serviceOutcome(selected, selectedPolicies, policyFallbackAuthoritative);
              const playBlocker = playgroundBlockedForService(selected, selectedPolicies, policyFallbackAuthoritative);
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
              <dt>grant</dt><dd>{grantNamesForService(selected, selectedPolicies).join(", ") || "none"}</dd>
              <dt>readiness</dt><dd>{readinessLabel(selected.readiness)}</dd>
              <dt>missing</dt><dd>{selected.readiness?.missingConfig.length ? selected.readiness.missingConfig.join(", ") : "none"}</dd>
              <dt>oauth grants</dt><dd>{selected.readiness?.oauthGrantRequired ? selected.readiness.oauthGrantCount : "n/a"}</dd>
            </dl>
            {selected.readiness?.reasons.length ? <InlineNote>{selected.readiness.reasons.join("; ")}</InlineNote> : null}
            <div className="sectionTitle">Granting access</div>
            <div className="miniList">
              {grantNamesForService(selected, selectedPolicies).length ? grantNamesForService(selected, selectedPolicies).map((grant) => <button key={grant} type="button">{grant}<span>{selectedPolicies.find((policy) => policy.kid === grant)?.tenantId ?? "entitlement"}</span></button>) : <p>No active grant includes this service yet.</p>}
            </div>
            <div className="inspectorActions">
              <button type="button" disabled={Boolean(playBlocker)} onClick={() => onPlay(selected)} title={playBlocker ?? undefined}><Play className="buttonIcon" aria-hidden="true" /><span>Try in playground</span></button>
              {canAdminister ? <button type="button" className="buttonSecondary" onClick={() => onAdd(selected)}><Plus className="buttonIcon" aria-hidden="true" /><span>Add to grant</span></button> : null}
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
  if (!names.length) return <span className="emptyGrant">no grant</span>;
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

function PoliciesScreen({ keys, selected, providers, form, setForm, issuedKey, error, onSave, onNew, onEdit, onRevoke, onPreset, onToggleProvider, onSetProviderGroup, busy }: {
  keys: KeyPolicy[];
  selected?: KeyPolicy;
  providers: ProviderRow[];
  form: PolicyForm;
  setForm: (form: PolicyForm) => void;
  issuedKey: string;
  error: string;
  onSave: (event: FormEvent) => void;
  onNew: () => void;
  onEdit: (key: KeyPolicy) => void;
  onRevoke: (kid: string) => void;
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
  const copyIssuedKey = () => {
    void navigator.clipboard?.writeText(issuedKey);
  };
  return (
    <div className="entityLayout grantsLayout">
      <section className="mainPane grantListPane">
        <div className="overviewStrip grantOverview">
          <Metric label="active grants" value={String(activeGrantCount)} meta={`${keys.length} total`} />
          <Metric label="tenants" value={String(tenantCount)} meta="with configured grants" />
          <Metric label="service coverage" value={String(coveredServiceCount)} meta={`${providers.length} available`} />
        </div>
        <div className="tableSectionHeader grantListHeader"><div><strong>Access grants</strong><span>{keys.length} configured grants</span></div><button type="button" disabled={busy} onClick={onNew}><Plus className="buttonIcon" aria-hidden="true" /><span>New grant</span></button></div>
        <EntityTable
          columns={["grant", "tenant", "scope", "state"]}
          columnTemplate="minmax(170px, 1.35fr) minmax(96px, 0.8fr) minmax(100px, 0.8fr) 88px"
          rows={keys.map((key) => ({ id: key.kid, active: selected?.kid === key.kid, onClick: busy ? undefined : () => onEdit(key), cells: [<EntityName icon={KeyRound} title={key.kid} subtitle={key.tokenRole ?? "custom"} />, key.tenantId ?? "default", key.providers.length ? `${key.providers.length} services` : "all services", <Status label={key.enabled ? "active" : "revoked"} tone={key.enabled ? "active" : "revoked"} />] }))}
        />
      </section>
      <aside className="inspector wideInspector grantEditor">
        <form onSubmit={onSave}>
          <fieldset className="grantEditorFields" disabled={busy}>
          <div className="grantEditorHeader">
            <InspectorHeader icon={KeyRound} title={form.kid || "New access grant"} subtitle={`${form.tenantId || "default"} · ${form.tokenRole || "custom"}`} />
            <Status label={form.enabled ? "active" : "disabled"} tone={form.enabled ? "active" : "revoked"} />
          </div>
          {error ? <InlineError message={error} /> : null}
          {issuedKey ? (
            <div className="issuedKey">
              <div><span>issued key</span><code>{issuedKey}</code></div>
              <button type="button" className="buttonSecondary" onClick={copyIssuedKey}>Copy</button>
            </div>
          ) : null}
          <div className="grantSummary">
            <strong>{form.tenantId || "default"}</strong>
            <span>{form.enabled ? "will have" : "would have"} access to {formServiceLabel} under the {form.tokenRole || "custom"} role.</span>
          </div>
          <div className="editorSectionHeader"><strong>Grant template</strong><span>Apply a starting policy</span></div>
          <div className="presetRow" aria-label="grant templates">{Object.keys(rolePresets).map((role) => <button key={role} type="button" className="buttonSecondary" onClick={() => onPreset(role as keyof typeof rolePresets)}>{role}</button>)}</div>
          <div className="editorSectionHeader"><strong>Grant details</strong><span>Identity, role, and limits</span></div>
          <div className="formGrid compact">
            <label><span>grant id</span><input value={form.kid} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, kid: event.target.value })} /></label>
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
          <div className="inspectorActions"><button type="submit" disabled={busy || (!form.allProviders && !form.providers.length)}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save grant</span></button>{selected ? <button type="button" className="buttonDanger" disabled={!selected.enabled || busy} onClick={() => onRevoke(selected.kid)}><CircleSlash2 className="buttonIcon" aria-hidden="true" /><span>Revoke grant</span></button> : null}</div>
          </fieldset>
        </form>
      </aside>
    </div>
  );
}

function UsersScreen({ users, selected, policies, services, form, setForm, error, onOpenPolicy, onSelect, onSave, busy }: {
  users: AccessUser[];
  selected?: AccessUser;
  policies: KeyPolicy[];
  services: ServiceItem[];
  form: AccessForm;
  setForm: (form: AccessForm) => void;
  error: string;
  onOpenPolicy: (policy: KeyPolicy) => void;
  onSelect: (user: AccessUser) => void;
  onSave: (event: FormEvent) => void;
  busy: boolean;
}) {
  const accessForUser = (user: AccessUser | undefined) => effectiveAccess(user, policies, services);
  const selectedAccess = accessForUser(selected);
  const selectedServices = selectedAccess.services.map((service) => ({ service, label: "granted" }));
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <EntityTable columns={["identity", "role", "tenant", "grants", "services", "status"]} columnTemplate="minmax(260px, 1.5fr) 90px 130px 96px 96px 116px" rows={users.map((user) => {
          const access = accessForUser(user);
          return { id: user.email, active: selected?.email === user.email, onClick: () => onSelect(user), cells: [<EntityName icon={Users} title={user.email} subtitle="Cloudflare Access" />, user.role, user.tenantId, String(access.policies.length), String(access.services.length), <Status label={user.enabled ? "enabled" : "disabled"} tone={user.enabled ? "active" : "revoked"} />] };
        })} />
      </section>
      <aside className="inspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={Users} title="Access user" subtitle={selected?.email ?? "new user"} />
          {error ? <InlineError message={error} /> : null}
          <InlineNote>Users are created from Cloudflare Access on first login. Admin status is controlled by the Worker admin allowlist; this record only controls tenant and enabled state.</InlineNote>
          <div className="formGrid compact">
            <label className="full"><span>email</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <label><span>tenant</span><input value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} /></label>
            <label><span>status</span><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
          </div>
          <dl className="facts"><dt>granted services</dt><dd>{selectedAccess.services.length}</dd><dt>active grants</dt><dd>{selectedAccess.policies.length}</dd><dt>role</dt><dd>{selected?.role ?? "user"}</dd><dt>tenant</dt><dd>{selected?.tenantId ?? form.tenantId}</dd></dl>
          <div className="sectionTitle">Tenant grants</div>
          <div className="miniList">{selectedAccess.policies.length ? selectedAccess.policies.map((policy) => <button type="button" key={policy.kid} onClick={() => onOpenPolicy(policy)}>{policy.kid}<span>{effectiveProviderCount(policy.providers, services)} services · {formatBudget(policy.monthlyBudgetMicros)}</span></button>) : <p>No active grant gives this tenant service access.</p>}</div>
          <div className="sectionTitle">Effective access</div>
          <div className="miniList">{selectedServices.length ? selectedServices.slice(0, 8).map(({ service, label }) => <button type="button" key={service.id}>{service.name}<span>{label} · {kindLabel(service.kind)}</span></button>) : <p>No services available for this user.</p>}</div>
          <div className="inspectorActions"><button type="submit" disabled={busy}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save user</span></button></div>
        </form>
      </aside>
    </div>
  );
}

function UsageScreen({ keys, services, overview, tenants, usageRows, usageLoaded }: { keys: KeyPolicy[]; services: ServiceItem[]; overview: AdminOverview | null; tenants: AdminTenantSummary[]; usageRows: AdminUsageRow[]; usageLoaded: boolean }) {
  const activeKeys = keys.filter((key) => key.enabled);
  const readyServices = readyCount(services);
  const blockedServices = services.filter((service) => service.readiness && !service.readiness.executable);
  const rows = usageRows.length ? usageRows : keys.map(policyUsageFallback);
  const tenantRows = tenants.length ? tenants : tenantSummaryFallback(keys);
  const serviceProviderCount = new Set(services.map((service) => service.provider)).size;
  const grantedServiceCount = activeKeys.some((key) => key.providers.length === 0)
    ? serviceProviderCount
    : new Set(activeKeys.flatMap((key) => key.providers)).size;
  const hasUnlimitedBudget = activeKeys.some((key) => key.monthlyBudgetMicros === undefined || key.monthlyBudgetMicros === null);
  const activeBudgetValues = activeKeys.map((key) => key.monthlyBudgetMicros);
  const totalBudget = activeBudgetValues.some((value) => value === undefined || value === null)
    ? null
    : activeBudgetValues.reduce<number>((total, value) => total + (value ?? 0), 0);
  const totalBudgetLabel = hasUnlimitedBudget ? "unlimited" : formatMicros(totalBudget);
  const totalSpent = !usageLoaded || rows.some((row) => row.budget.spentMicros === undefined || row.budget.spentMicros === null)
    ? null
    : rows.reduce((total, row) => total + (row.budget.spentMicros ?? 0), 0);
  const routeTotal = services.reduce((total, service) => total + service.routeCount, 0);
  const providerTotal = overview?.providerCount ?? new Set(services.map((service) => service.provider)).size;
  const untrackedRows = rows.filter((row) => row.enabled && row.budget.ledger === "untracked");
  const exhaustedRows = rows.filter((row) => row.enabled && row.budget.configured && row.budget.remainingMicros !== undefined && row.budget.remainingMicros !== null && row.budget.remainingMicros <= 0);
  const ledgerFailureRows = rows.filter((row) => row.enabled && (row.budget.ledger === "unavailable" || row.budget.ledger === "invalid_policy"));
  return (
    <div className="entityLayout usageLayout">
      <section className="mainPane usageMainPane">
        <div className="overviewStrip">
          <Metric label="active grants" value={String(overview?.keysActive ?? activeKeys.length)} meta={`${overview?.keysTotal ?? keys.length} total`} />
          <Metric label="tenants" value={String(overview?.tenantsTotal ?? tenantRows.length)} meta={`${grantedServiceCount} granted services`} />
          <Metric label="service routes" value={String(routeTotal)} meta={`${providerTotal} providers`} />
          <Metric label="budget" value={totalBudgetLabel} meta={`${formatMicros(totalSpent)} spent`} />
        </div>
        <div className="tableSectionHeader"><div><strong>Grant budget ledger</strong><span>{rows.length} configured grants</span></div><span>{usageLoaded ? "live ledger" : "policy fallback"}</span></div>
        <EntityTable columns={["grant", "tenant", "budget usage", "services", "health"]} columnTemplate="minmax(210px, 1.15fr) minmax(120px, 0.7fr) minmax(250px, 1.45fr) 96px 120px" rows={rows.map((row) => ({ id: row.kid, cells: [<EntityName icon={KeyRound} title={row.kid} subtitle={row.tokenRole ?? "custom"} />, row.tenantId, <BudgetUsage row={row} />, effectiveProviderCount(row.providers, services), <UsageHealth row={row} />] }))} />
      </section>
      <aside className="inspector usageInspector">
        <InspectorHeader icon={BarChart3} title="Operational health" subtitle={`${readyServices}/${services.length} services executable`} />
        <div className="attentionGrid">
          <div className={blockedServices.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{blockedServices.length}</strong><span>services need configuration</span></div>
          {usageLoaded ? (
            <>
              <div className={untrackedRows.length ? "attentionMetric warning" : "attentionMetric healthy"}><strong>{untrackedRows.length}</strong><span>grants not reporting spend</span></div>
              <div className={ledgerFailureRows.length ? "attentionMetric danger" : "attentionMetric healthy"}><strong>{ledgerFailureRows.length}</strong><span>budget ledger failures</span></div>
            </>
          ) : <div className="attentionMetric danger"><strong>!</strong><span>live usage ledger unavailable</span></div>}
          <div className={exhaustedRows.length ? "attentionMetric danger" : "attentionMetric healthy"}><strong>{exhaustedRows.length}</strong><span>grants out of budget</span></div>
        </div>
        <div className="sectionTitle">Tenant coverage</div>
        <div className="miniList">{tenantRows.length ? tenantRows.slice(0, 8).map((tenant) => <button type="button" key={tenant.tenantId}>{tenant.tenantId}<span>{tenant.activeKeys}/{tenant.keys} grants · {effectiveProviderCount(tenant.providers, services, tenant.allProviders)} services</span></button>) : <p>No tenant grants yet.</p>}</div>
        <div className="sectionTitle">Needs configuration</div>
        <div className="miniList">{blockedServices.length ? blockedServices.slice(0, 8).map((service) => <button type="button" key={service.id}>{service.name}<span>{readinessLabel(service.readiness)}</span></button>) : <p>All visible services are executable.</p>}</div>
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
  const tone = readiness.status === "ready" ? "active" : readiness.status === "missing_config" || readiness.status === "grant_required" || readiness.status === "unsupported" ? "revoked" : "neutral";
  return <Status label={readinessLabel(readiness)} tone={tone} />;
}

function viewTitle(view: View) {
  return ({ catalog: "Catalog", playground: "Playground", policies: "Access", users: "Users", usage: "Usage" } as const)[view];
}

function viewSubtitle(view: View) {
  return {
    catalog: "Service access catalog",
    playground: "Run through the same access path",
    policies: "Grant services to tenants",
    users: "Cloudflare Access identities",
    usage: "Tenant budget ledger",
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

function readinessMap(readiness: ProviderReadiness[]) {
  return Object.fromEntries(readiness.map((item) => [item.id, item]));
}

function accessMap(entitlements: EntitlementsResponse | null) {
  return new Map((entitlements?.providers ?? []).map((item) => [item.provider, item]));
}

function readyCount(services: ServiceItem[]) {
  return services.filter((service) => service.readiness?.status === "ready").length;
}

function grantNamesForService(service: ServiceItem, policies: KeyPolicy[] = []) {
  return unique([...policies.map((policy) => policy.kid), ...(service.access?.policies ?? [])]);
}

function serviceOutcome(service: ServiceItem, policies: KeyPolicy[] = [], policyFallbackAuthoritative = false): ServiceOutcome {
  const grantedBySession = Boolean(service.access?.allowed);
  if (service.access && !service.access.allowed) {
    return {
      label: "denied",
      detail: "Current Cloudflare Access identity is denied by policy.",
      tone: "revoked",
      playable: false,
      blocked: true,
    };
  }
  const granted = grantedBySession || (!service.access && policies.length > 0);
  const policyNames = service.access?.policies.length ? service.access.policies : policies.map((policy) => policy.kid);
  if (!granted) {
    if (!service.access && !policyFallbackAuthoritative) {
      return {
        label: "unknown",
        detail: "Access entitlements are unavailable, so this identity's grant status cannot be determined.",
        tone: "neutral",
        playable: false,
        blocked: false,
      };
    }
    return {
      label: "not granted",
      detail: "No active grant currently includes this service.",
      tone: "revoked",
      playable: false,
      blocked: true,
    };
  }
  if (!service.readiness) {
    return {
      label: "unknown",
      detail: `Granted by ${policyNames.join(", ") || "session"}, but runtime readiness has not loaded yet.`,
      tone: "neutral",
      playable: false,
      blocked: true,
    };
  }
  if (service.readiness.executable) {
    return {
      label: "usable",
      detail: `Granted by ${policyNames.join(", ") || "session"} and executable in the gateway.`,
      tone: "active",
      playable: true,
      blocked: false,
    };
  }
  const missing = service.readiness.missingConfig.length ? `Missing ${service.readiness.missingConfig.join(", ")}.` : "";
  const oauth = service.readiness.oauthGrantRequired ? "OAuth grant required before calls can run." : "";
  return {
    label: service.readiness.status === "missing_config" ? "missing config" : service.readiness.status === "grant_required" ? "needs OAuth" : readinessLabel(service.readiness),
    detail: [service.readiness.reasons[0], missing, oauth].filter(Boolean).join(" "),
    tone: "revoked",
    playable: false,
    blocked: true,
  };
}

function readinessLabel(readiness: ProviderReadiness | undefined) {
  if (!readiness) return "unknown";
  return readiness.status.replace(/_/g, " ");
}

function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${value} is not a non-negative safe integer`);
  return parsed;
}

function optionalCurrencyMicros(value: string) {
  if (!value.trim()) return undefined;
  const normalized = value.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${value} is not a valid budget`);
  return Math.round(parsed * 1_000_000);
}

function currencyInput(value: number | null | undefined) {
  if (value === undefined || value === null) return "";
  return String(value / 1_000_000);
}

function optionalDecimal(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${value} is not a number`);
  return parsed;
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatBudget(value: number | null | undefined) {
  if (value === undefined || value === null) return "unlimited";
  if (value === 0) return "blocked";
  return formatMicros(value);
}

function formatMicros(value: number | null | undefined) {
  if (value === undefined || value === null) return "unknown";
  if (!value) return "none";
  return `$${(value / 1_000_000).toFixed(2)}`;
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

function policyFormFromKey(key: KeyPolicy): PolicyForm {
  return {
    kid: key.kid,
    tokenRole: key.tokenRole ?? "",
    tenantId: key.tenantId ?? "default",
    enabled: key.enabled,
    monthlyBudgetMicros: currencyInput(key.monthlyBudgetMicros),
    requestCostMicros: key.requestCostMicros?.toString() ?? "",
    providers: key.providers,
    allProviders: key.providers.length === 0,
  };
}

function policyCoversProvider(policy: KeyPolicy, providerId: string) {
  return policy.providers.length === 0 || policy.providers.includes(providerId);
}

function accessFormFromUser(user: AccessUser): AccessForm {
  return {
    email: user.email,
    role: user.role,
    tenantId: user.tenantId,
    enabled: user.enabled,
  };
}

function effectiveAccess(user: AccessUser | undefined, policies: KeyPolicy[], services: ServiceItem[]) {
  if (!user || !user.enabled) return { policies: [] as KeyPolicy[], services: [] as ServiceItem[] };
  const userPolicies = policies.filter((policy) => policy.enabled && (user.role === "admin" || (policy.tenantId ?? "default") === user.tenantId));
  const hasWildcardGrant = userPolicies.some((policy) => policy.providers.length === 0);
  const providerIds = new Set(userPolicies.flatMap((policy) => policy.providers));
  return { policies: userPolicies, services: services.filter((service) => hasWildcardGrant || providerIds.has(service.provider)) };
}

function policyUsageFallback(policy: KeyPolicy): AdminUsageRow {
  const limit = policy.monthlyBudgetMicros;
  const blocked = limit === 0;
  const unmetered = limit === undefined || limit === null;
  return {
    kid: policy.kid,
    tenantId: policy.tenantId ?? "default",
    enabled: policy.enabled,
    providers: policy.providers,
    tokenRole: policy.tokenRole,
    monthlyBudgetMicros: policy.monthlyBudgetMicros,
    requestCostMicros: policy.requestCostMicros,
    budget: {
      configured: !unmetered,
      ledger: blocked ? "blocked" : unmetered ? "unmetered" : "untracked",
      limitMicros: limit,
      spentMicros: blocked ? 0 : null,
      remainingMicros: blocked ? 0 : limit,
    },
  };
}

function tenantSummaryFallback(keys: KeyPolicy[]): AdminTenantSummary[] {
  const groups = keys.reduce((acc, key) => {
    const tenantId = key.tenantId ?? "default";
    const current = acc.get(tenantId) ?? { tenantId, keys: 0, activeKeys: 0, providers: new Set<string>(), allProviders: false, monthlyBudgetMicros: 0, requestCostMicros: 0 };
    current.keys += 1;
    if (key.enabled) {
      current.activeKeys += 1;
      if (key.providers.length) {
        key.providers.forEach((provider) => current.providers.add(provider));
      } else {
        current.allProviders = true;
      }
    }
    current.monthlyBudgetMicros += key.monthlyBudgetMicros ?? 0;
    current.requestCostMicros += key.requestCostMicros ?? 0;
    acc.set(tenantId, current);
    return acc;
  }, new Map<string, { tenantId: string; keys: number; activeKeys: number; providers: Set<string>; allProviders: boolean; monthlyBudgetMicros: number; requestCostMicros: number }>());
  return Array.from(groups.values()).map((tenant) => ({ ...tenant, providers: Array.from(tenant.providers).sort() }));
}

function adminOverviewFromKeys(keys: KeyPolicy[], providers: ProviderRow[], routes: RouteCatalog): AdminOverview {
  const tenants = tenantSummaryFallback(keys);
  return {
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

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
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

function playgroundPayload(form: PlaygroundForm, route?: RouteCatalog["manifestProxy"][number]) {
  if (form.mode === "service") {
    const body = form.servicePayload.trim() ? JSON.parse(form.servicePayload) : {};
    return {
      method: form.serviceMethod,
      pathParams: pathParamsForRoute(route, form.servicePath),
      body,
    };
  }
  const maxTokens = optionalNumber(form.maxTokens);
  const temperature = optionalDecimal(form.temperature);
  if (form.endpoint === "/v1/responses") {
    return { model: form.model, input: form.prompt, instructions: form.system || undefined, max_output_tokens: maxTokens, temperature };
  }
  return { model: form.model, messages: [...(form.system ? [{ role: "system", content: form.system }] : []), { role: "user", content: form.prompt }], max_tokens: maxTokens, temperature };
}

function playgroundCurl(form: PlaygroundForm, payload: unknown, route?: RouteCatalog["manifestProxy"][number]) {
  const method = "POST";
  const endpoint = playgroundAccessEndpoint(form, route);
  const lines = [`curl -X ${method} '${window.location.origin}${endpoint}' \\`, `  -b '$CLOUDFLARE_ACCESS_COOKIE' \\`, `  -H 'content-type: application/json' \\`, `  -d '${JSON.stringify(payload ?? {}, null, 2).replace(/'/g, `'\\''`)}'`];
  return lines.join("\n");
}

function playgroundAccessEndpoint(form: PlaygroundForm, route?: RouteCatalog["manifestProxy"][number]) {
  if (form.mode === "service") {
    return resolveProxyRoute(route).replace(/^\/v1\/proxy/, "/v1/playground/proxy");
  }
  return `/v1/playground${form.endpoint}`;
}

function playgroundRequestPreview(form: PlaygroundForm, mode: "json" | "curl", route?: RouteCatalog["manifestProxy"][number]) {
  try {
    const payload = playgroundPayload(form, route);
    return mode === "json" ? JSON.stringify(payload, null, 2) : playgroundCurl(form, payload, route);
  } catch (error) {
    return errorMessage(error);
  }
}

function playgroundBlocker(form: PlaygroundForm, model: CatalogModel | undefined, route: RouteCatalog["manifestProxy"][number] | undefined, accessByProvider: Map<string, ProviderAccess>, readinessByProvider: Record<string, ProviderReadiness>) {
  if (form.mode === "model" && !model) return "select a model";
  if (form.mode === "service" && !route) return "select a service route";
  const provider = form.mode === "model" ? model?.provider : route?.provider;
  if (!provider) return null;
  const access = accessByProvider.get(provider);
  if (!access?.allowed) return "Cloudflare Access identity is not granted this provider";
  const readiness = readinessByProvider[provider];
  if (!readiness) return "provider readiness is unknown";
  if (!readiness.executable) return readiness.reasons[0] ?? `provider is ${readinessLabel(readiness)}`;
  return null;
}

function playgroundBlockedForService(service: ServiceItem, policies: KeyPolicy[] = [], policyFallbackAuthoritative = false) {
  const outcome = serviceOutcome(service, policies, policyFallbackAuthoritative);
  if (!outcome.playable) return outcome.detail;
  if (service.readiness && !service.readiness.executable) return service.readiness.reasons[0] ?? `service is ${readinessLabel(service.readiness)}`;
  if (!service.models && service.surfaces.includes("provider")) return "no executable model or proxy route declared";
  return null;
}

function routeKey(route: RouteCatalog["manifestProxy"][number] | undefined) {
  return route ? `${route.provider}:${route.endpoint}:${route.route}` : "";
}

function resolveProxyRoute(route: RouteCatalog["manifestProxy"][number] | undefined) {
  if (!route) return "/v1/proxy";
  return route.route;
}

function pathParamsForRoute(route: RouteCatalog["manifestProxy"][number] | undefined, value: string) {
  const params: Record<string, string> = {};
  for (const param of route?.pathParams ?? []) {
    params[param] = value.trim() || "demo";
  }
  return params;
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
    provider("github", "GitHub", "oauth_rest_json", "oauth_platform", ["tool.invoke"]),
    provider("google-gemini", "Google Gemini", "rest_json", "model_provider", ["llm.generate", "llm.stream"]),
    provider("groq", "Groq", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("huggingface", "Hugging Face", "rest_json", "model_provider", ["llm.invoke"]),
    provider("linear", "Linear", "oauth_rest_json", "oauth_platform", ["tool.invoke"]),
    provider("minimax", "MiniMax", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("mistral", "Mistral AI", "openai_compatible", "model_provider", ["llm.chat", "llm.embeddings"]),
    provider("notion", "Notion", "oauth_rest_json", "oauth_platform", ["tool.invoke"]),
    provider("openai", "OpenAI", "openai_compatible", "model_provider", ["llm.responses", "llm.chat", "llm.embeddings"]),
    provider("openrouter", "OpenRouter", "openai_compatible", "gateway_platform", ["llm.chat"]),
    provider("perplexity", "Perplexity", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("replicate", "Replicate", "rest_json", "tool_provider", ["media.predict", "media.prediction.read"]),
    provider("slack", "Slack", "oauth_rest_json", "oauth_platform", ["tool.invoke"]),
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
      manifestRoute("github", "rest", "/v1/proxy/github/rest", ["GET", "POST", "PATCH", "PUT", "DELETE"], ["path"]),
      manifestRoute("linear", "graphql", "/v1/proxy/linear/graphql", ["POST"]),
      manifestRoute("notion", "rest", "/v1/proxy/notion/rest", ["GET", "POST", "PATCH"], ["path"]),
      manifestRoute("replicate", "predictions", "/v1/proxy/replicate/predictions", ["POST"]),
      manifestRoute("replicate", "prediction", "/v1/proxy/replicate/prediction", ["GET"], ["prediction_id"]),
      manifestRoute("slack", "method", "/v1/proxy/slack/method", ["GET", "POST"], ["method"]),
      manifestRoute("tavily", "search", "/v1/proxy/tavily/search", ["POST"]),
      manifestRoute("tavily", "extract", "/v1/proxy/tavily/extract", ["POST"]),
      manifestRoute("tavily", "crawl", "/v1/proxy/tavily/crawl", ["POST"]),
    ],
  };
  const keys: KeyPolicy[] = [
    { kid: "maintainer_models", enabled: true, providers: ["anthropic", "aws-bedrock", "azure-openai", "cloudflare-ai-gateway", "cohere", "deepseek", "fireworks", "google-gemini", "groq", "huggingface", "minimax", "mistral", "openai", "openrouter", "perplexity", "together", "xai"], tenantId: "openclaw", tokenRole: "maintainer", monthlyBudgetMicros: 250000000, requestCostMicros: 1000 },
    { kid: "openclaw_tools", enabled: true, providers: ["github", "linear", "replicate", "tavily"], tenantId: "openclaw", tokenRole: "tooling", monthlyBudgetMicros: 75000000, requestCostMicros: 500 },
    { kid: "user_research", enabled: true, providers: ["openai", "google-gemini", "github", "tavily"], tenantId: "research", tokenRole: "user", monthlyBudgetMicros: 50000000, requestCostMicros: 1000 },
    { kid: "sandbox_eval", enabled: false, providers: ["openai"], tenantId: "sandbox", tokenRole: "sandbox", monthlyBudgetMicros: 5000000, requestCostMicros: 500 },
  ];
  const users: AccessUser[] = [
    { email: "admin@example.com", role: "admin", tenantId: "openclaw", enabled: true },
    { email: "maintainer@example.com", role: "user", tenantId: "docs", enabled: true },
    { email: "research@example.com", role: "user", tenantId: "research", enabled: true },
  ];
  const models = routes.openaiCompatible.flatMap((route) => route.models.map((model) => ({ ...model, provider: route.provider })));
  const session = { authenticated: true, auth: "demo", role: "admin" as AccessRole, email: "admin@example.com", tenantId: "openclaw" };
  const entitlements: EntitlementsResponse = {
    session,
    providers: providers.map((item) => {
      const policies = keys.filter((key) => key.enabled && (key.tenantId ?? "default") === session.tenantId && policyCoversProvider(key, item.id)).map((key) => key.kid);
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
  const tenants = tenantSummaryFallback(keys);
  const overview = adminOverviewFromKeys(keys, providers, routes);
  return { session, providers, routes, keys, users, overview, tenants, usageRows, entitlements, services: serviceItems(providers, routes, readinessByProvider, accessByProvider), models };
}

function demoReadiness(provider: ProviderRow, routes: RouteCatalog): ProviderReadiness {
  const openaiRoute = routes.openaiCompatible.find((route) => route.provider === provider.id);
  const manifestRoutes = routes.manifestProxy.filter((route) => route.provider === provider.id);
  const grantRequired = provider.class.includes("oauth");
  const declared = Boolean(openaiRoute || manifestRoutes.length);
  const offline = ["azure-openai", "aws-bedrock", "cloudflare-ai-gateway", "notion", "slack"].includes(provider.id);
  const status = offline ? "missing_config" : grantRequired ? "grant_required" : declared ? "ready" : "declared";
  return {
    id: provider.id,
    displayName: provider.display_name,
    class: provider.class,
    serviceKind: provider.service_kind,
    requiredConfig: offline ? [`${provider.id.toUpperCase().replace(/-/g, "_")}_CONFIG`] : [],
    optionalConfig: [],
    missingConfig: offline ? [`${provider.id.toUpperCase().replace(/-/g, "_")}_CONFIG`] : [],
    configPresent: !offline,
    oauthGrantRequired: grantRequired,
    oauthGrantCount: 0,
    openaiCompatible: Boolean(openaiRoute),
    manifestRoutes: manifestRoutes.length,
    modelCount: openaiRoute?.models.length ?? 0,
    executable: status === "ready",
    status,
    reasons: status === "ready" ? [] : status === "grant_required" ? ["OAuth grant required before service calls can run."] : status === "missing_config" ? ["Provider config is not present in the runtime environment."] : ["Provider is declared but has no executable route."],
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
