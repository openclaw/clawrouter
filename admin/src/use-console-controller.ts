import { useCallback, useEffect, useRef } from "react";
import { effectiveAccess, errorMessage, policyCoversProvider, policyUsageFallback } from "./domain";
import { useAccessAdmin } from "./hooks/use-access-admin";
import { useCatalog } from "./hooks/use-catalog";
import { usePlayground } from "./hooks/use-playground";
import { useSession } from "./hooks/use-session";
import { useUsage } from "./hooks/use-usage";
import { installAutoRefresh } from "./auto-refresh";
import { demo } from "./ui-config";
import { localDemoRole, oauthCallbackStatus, request, settled } from "./ui-helpers";
import { syntheticUsageTimeline } from "./usage-analytics";
import type {
  AccessUser,
  AdminBootstrapResponse,
  AdminUsageRow,
  EntitlementsResponse,
  ProviderResponse,
  RefreshOptions,
  RouteCatalog,
  SessionResponse,
  UpstreamGrant,
  UsageSnapshot,
  UsageSummary,
} from "./ui-types";

export function useConsoleController() {
  const session = useSession();
  const catalog = useCatalog(session.allowDemo);
  const usage = useUsage(session.allowDemo);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshBackgroundRef = useRef(false);
  const catalogLoadedRef = useRef(false);
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => undefined);
  const refreshCurrent = useCallback(() => refreshRef.current(), []);
  const access = useAccessAdmin({
    allowDemo: session.allowDemo,
    gatewayOrigin: session.gatewayOrigin,
    session: session.value,
    demoMode: session.demoMode,
    providers: catalog.providers,
    routes: catalog.routes,
    setStatus: session.setStatus,
    setProviderReadiness: catalog.setProviderReadiness,
    refresh: refreshCurrent,
    syncDemoAdmin: usage.syncDemoAdmin,
  });
  const playground = usePlayground({
    gatewayOrigin: session.gatewayOrigin,
    demoMode: session.demoMode,
    setStatus: session.setStatus,
    models: catalog.models,
    serviceRoutes: catalog.serviceRoutes,
    accessByProvider: catalog.accessByProvider,
    providerReadiness: catalog.providerReadiness,
  });
  const busyRef = useRef(session.busy);
  busyRef.current = session.busy;

  useEffect(() => {
    if (localDemoRole() === "user") {
      loadUserDemo();
      return;
    }
    void refresh();
  }, []);

  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    if (session.demoMode) return;
    return installAutoRefresh(() => {
      if (!busyRef.current) void refreshRef.current({ background: true });
    });
  }, [session.demoMode]);

  useEffect(() => {
    const onPopState = () => session.syncViewFromPath();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [session.setView]);

  useEffect(() => {
    session.enforceRoleView();
  }, [session.value.role, session.status, session.view]);

  useEffect(() => {
    if ((session.view === "home" || session.view === "usage") && session.value.role === "admin" && access.loaded && !session.demoMode && !usage.loaded) {
      void usage.refreshLedger(session.gatewayOrigin, session.setStatus, session.view === "usage");
    }
  }, [access.loaded, session.demoMode, session.value.role, session.view, usage.loaded, usage.refreshKey]);

  function refresh(options: RefreshOptions = {}): Promise<void> {
    if (refreshPromiseRef.current) {
      if (!options.background && refreshBackgroundRef.current) return refreshPromiseRef.current.then(() => refresh(options));
      return refreshPromiseRef.current;
    }
    refreshBackgroundRef.current = options.background ?? false;
    const operation = refreshData(options).finally(() => {
      if (refreshPromiseRef.current === operation) {
        refreshPromiseRef.current = null;
        refreshBackgroundRef.current = false;
      }
    });
    refreshPromiseRef.current = operation;
    return operation;
  }

  async function refreshData({ background = false }: RefreshOptions) {
    try {
      if (!background) {
        session.setStatus("loading");
        access.setLoaded(false);
      }
      const staticCatalog = catalogLoadedRef.current
        ? Promise.resolve({ providerData: { providers: catalog.providers }, routeData: catalog.routes })
        : Promise.all([
          request<ProviderResponse>(session.gatewayOrigin, "/v1/providers"),
          request<RouteCatalog>(session.gatewayOrigin, "/v1/routes"),
        ]).then(([providerData, routeData]) => ({ providerData, routeData }));
      const [sessionData, { providerData, routeData }] = await Promise.all([
        request<SessionResponse>(session.gatewayOrigin, "/v1/session"),
        staticCatalog,
      ]);
      session.setValue(sessionData);
      catalog.setProviders(providerData.providers);
      catalog.setRoutes(routeData);
      catalogLoadedRef.current = true;
      let warnings = sessionData.entitlementsError ? [`entitlements unavailable: ${sessionData.entitlementsError}`] : [];
      const sessionEntitlements: EntitlementsResponse | null = sessionData.entitlements
        ? {
          session: sessionData,
          providers: sessionData.entitlements.providers,
          contentRetention: sessionData.contentRetention ?? { enabled: false, retentionDays: 30, policyEnabled: false, userExempt: false },
        }
        : null;
      if (sessionEntitlements) catalog.setEntitlements(sessionEntitlements);
      else {
        const entitlementResult = await settled(() => request<EntitlementsResponse>(session.gatewayOrigin, "/v1/entitlements"));
        if (entitlementResult.ok) catalog.setEntitlements(entitlementResult.value);
        else {
          catalog.setEntitlements(null);
          warnings = [...warnings, `entitlements unavailable: ${entitlementResult.error}`];
        }
      }
      if (sessionData.role === "admin") warnings = await loadAdminData(sessionData, providerData, background, warnings);
      else warnings = await loadUserData(sessionData, warnings);
      session.setDemoMode(false);
      session.setLastUpdatedAt(Date.now());
      if (!background) session.setStatus(warnings.length ? warnings.join("; ") : oauthCallbackStatus() ?? "connected");
    } catch (caught) {
      const message = errorMessage(caught);
      if (session.allowDemo) {
        loadAdminDemo();
        return;
      }
      session.setDemoMode(false);
      if (!background) session.setStatus(`load error: ${message}`);
    }
  }

  async function loadAdminData(sessionData: SessionResponse, providerData: ProviderResponse, background: boolean, initialWarnings: string[]) {
    let warnings = initialWarnings;
    const data = await request<AdminBootstrapResponse>(session.gatewayOrigin, "/v1/admin/bootstrap");
    access.hydrateAdmin({
      policies: data.policies,
      credentials: data.credentials,
      connections: data.connections,
      users: data.users,
      bindings: data.bindings,
      grants: data.grants,
      rules: data.rules,
      fusion: data.fusion,
    }, background, sessionData, providerData.providers);
    catalog.mergeReadiness(data.providers);
    usage.setAdminOverview(data.overview);
    usage.setTenantSummaries(data.tenants);
    const usageResult = background && (session.view === "home" || session.view === "usage")
      ? await settled(() => request<{ policies?: AdminUsageRow[]; keys?: AdminUsageRow[]; usage: UsageSnapshot }>(session.gatewayOrigin, "/v1/admin/usage"))
      : null;
    if (usageResult?.ok) {
      usage.setRows(usageResult.value.policies ?? usageResult.value.keys ?? []);
      usage.setSnapshot(usageResult.value.usage);
      usage.setLoaded(true);
    } else if (usageResult) warnings = [...warnings, `usage ledger unavailable: ${usageResult.error}`];
    else if (!background) usage.resetLedger();
    if (!background && session.view === "usage") usage.requestRefresh();
    return warnings;
  }

  async function loadUserData(sessionData: SessionResponse, initialWarnings: string[]) {
    let warnings = initialWarnings;
    const user: AccessUser = {
      email: sessionData.email ?? "access-user",
      role: sessionData.role,
      tenantId: sessionData.tenantId ?? "default",
      enabled: sessionData.authenticated,
      groups: sessionData.groups ?? [],
      contentRetentionDisabled: sessionData.contentRetention?.userExempt ?? false,
    };
    access.hydrateUser(user);
    usage.setAdminOverview(null);
    usage.setTenantSummaries([]);
    const result = await settled(() => request<{ policies: AdminUsageRow[]; usage: UsageSnapshot }>(session.gatewayOrigin, "/v1/session/usage"));
    if (result.ok) {
      usage.setRows(result.value.policies);
      usage.setSnapshot(result.value.usage);
      usage.setLoaded(true);
    } else {
      usage.resetLedger();
      warnings = [...warnings, `quota status unavailable: ${result.error}`];
    }
    return warnings;
  }

  function loadAdminDemo() {
    session.setValue(demo.session);
    catalog.setProviders(demo.providers);
    catalog.setRoutes(demo.routes);
    catalog.setEntitlements(demo.entitlements);
    access.hydrateDemo();
    usage.setAdminOverview(demo.overview);
    usage.setTenantSummaries(demo.tenants);
    usage.setRows(demo.usageRows);
    usage.setSnapshot(demo.usage);
    usage.setLoaded(true);
    session.setDemoMode(true);
    session.setLastUpdatedAt(Date.now());
    session.setStatus("local demo data loaded");
  }

  function loadUserDemo() {
    const user = demo.users.find((candidate) => candidate.email === "research@example.com") ?? demo.users.find((candidate) => candidate.role === "user")!;
    const effective = effectiveAccess(user, demo.keys, demo.bindings, demo.services);
    const providerIds = new Set(effective.services.map((service) => service.provider));
    const providerUsage = demo.usage.providers.filter((provider) => providerIds.has(provider.provider));
    const summary = providerUsage.reduce<UsageSummary>((current, provider) => ({
      ...current,
      requestCount: current.requestCount + provider.requestCount,
      successCount: current.successCount + provider.successCount,
      errorCount: current.errorCount + provider.errorCount,
      totalTokens: current.totalTokens + provider.totalTokens,
      actualCostMicros: current.actualCostMicros + provider.actualCostMicros,
    }), { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 });
    const contentRetention = {
      enabled: !user.contentRetentionDisabled && effective.policies.some((policy) => policy.retainRequestContent),
      retentionDays: 30,
      policyEnabled: effective.policies.some((policy) => policy.retainRequestContent),
      userExempt: user.contentRetentionDisabled,
    };
    const entitlements: EntitlementsResponse = {
      session: { ...demo.session, ...user, auth: "demo", contentRetention },
      contentRetention,
      providers: demo.entitlements.providers.map((provider) => ({
        ...provider,
        allowed: providerIds.has(provider.provider),
        policies: effective.policies.filter((policy) => policyCoversProvider(policy, provider.provider)).map((policy) => policy.policyId),
      })),
    };
    session.setValue(entitlements.session);
    catalog.setProviders(demo.providers);
    catalog.setRoutes(demo.routes);
    catalog.setEntitlements(entitlements);
    access.hydrateUser(user);
    usage.setAdminOverview(null);
    usage.setTenantSummaries([]);
    usage.setRows(effective.policies.map(policyUsageFallback));
    usage.setSnapshot({ ...demo.usage, summary, providers: providerUsage, daily: syntheticUsageTimeline(Date.now(), summary), events: [] });
    usage.setLoaded(true);
    session.setLastUpdatedAt(Date.now());
    session.setStatus("local user demo loaded");
    session.setDemoMode(true);
  }

  return { session, catalog, access, usage, playground, refresh };
}

export type ConsoleController = ReturnType<typeof useConsoleController>;
