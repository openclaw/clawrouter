export function AppShell({ controller }: { controller: ReturnType<typeof useConsoleController> }) {
  const [theme, setTheme] = React.useState(initialTheme);
  React.useEffect(() => { applyTheme(theme); }, [theme]);
  const { view, setView, gatewayOrigin, allowDemo, session, setSession, providers, setProviders, routes, setRoutes, keys, setKeys, credentials, setCredentials, connections, setConnections, upstreamGrants, setUpstreamGrants, assignmentRules, setAssignmentRules, policyDataLoaded, setPolicyDataLoaded, users, setUsers, bindings, setBindings, adminOverview, setAdminOverview, tenantSummaries, setTenantSummaries, usageRows, setUsageRows, usageSnapshot, setUsageSnapshot, usageLoaded, setUsageLoaded, usageRefreshKey, setUsageRefreshKey, entitlements, setEntitlements, providerReadiness, setProviderReadiness, policyForm, setPolicyForm, credentialForm, setCredentialForm, bindingForm, setBindingForm, upstreamGrantForm, setUpstreamGrantForm, assignmentRuleForm, setAssignmentRuleForm, accessTab, setAccessTab, accessForm, setAccessForm, query, setQuery, kind, setKind, selectedServiceId, setSelectedServiceId, selectedPolicyId, setSelectedPolicyId, selectedCredentialId, setSelectedCredentialId, selectedBindingKey, setSelectedBindingKey, selectedUpstreamGrantKey, setSelectedUpstreamGrantKey, selectedAssignmentRuleId, setSelectedAssignmentRuleId, selectedUserEmail, setSelectedUserEmail, status, setStatus, lastUpdatedAt, setLastUpdatedAt, demoMode, setDemoMode, issuedKey, setIssuedKey, policyError, setPolicyError, userError, setUserError, playgroundError, setPlaygroundError, playground, setPlayground, playgroundTurns, setPlaygroundTurns, selectedPlaygroundTurnId, setSelectedPlaygroundTurnId, requestMode, setRequestMode, refreshPromiseRef, refreshBackgroundRef, refreshRef, accessByProvider, services, models, serviceRoutes, kinds, filteredServices, selectedService, selectedPolicy, selectedCredential, selectedBinding, selectedUpstreamGrant, selectedAssignmentRule, selectedUser, selectedModel, selectedServiceRoute, statusPresentation, busy, busyRef, statusTone, refresh, refreshData, loadUserDemo, savePolicy, issueCredential, revokeCredential, saveBinding, saveUpstreamGrant, revokeUpstreamGrant, refreshUpstreamGrant, authorizeUpstreamGrant, saveAssignmentRule, reconcileAssignments, setProviderConnection, refreshUsageLedger, saveUser, revoke, runPlayground, editPolicy, startNewPolicy, startNewUser, editBinding, editUpstreamGrant, startNewUpstreamGrant, editAssignmentRule, startNewAssignmentRule, applyPreset, togglePolicyProvider, setPolicyProviderGroup, applyDemoKeys, applyDemoCredentials, navigateTo } = controller;
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
        <div className="tenantSwitch" title={`${session.tenantId ?? "default"} tenant · ${session.role}`}>
          <UserAvatar email={session.email} />
          <div>
            <strong>{session.email ?? "not signed in"}</strong>
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
            <ThemeToggle value={theme} onChange={setTheme} />
            <span className={`status ${session.contentRetention?.enabled ? "active" : "neutral"}`} title={session.contentRetention ? session.contentRetention.enabled ? `Request content retained for ${session.contentRetention.retentionDays} days` : "Request content retention is off for this identity" : "Loading request content retention status"}>
              retention {session.contentRetention ? session.contentRetention.enabled ? `on · ${session.contentRetention.retentionDays}d` : "off" : "pending"}
            </span>
            <span className={`status ${session.role === "admin" ? "active" : "neutral"}`}>{session.role}</span>
            <span className={`connectionMeta connectionMeta-${statusTone}`} title="Automatically refreshes every 30 seconds and when this tab regains focus">
              <span className="connectionDot" aria-hidden="true" />
              <strong>{statusPresentation.label}</strong>
              <span className="connectionSeparator" aria-hidden="true">·</span>
              <span>Updated</span>
              {lastUpdatedAt ? <time dateTime={new Date(lastUpdatedAt).toISOString()}>{formatTimestamp(lastUpdatedAt)}</time> : <span>pending</span>}
            </span>
          </div>
        </header>

        {statusPresentation.showBar ? <div className={`statusBar statusBar-${statusTone}`} role="status" aria-live="polite"><strong>{statusPresentation.label}</strong><span>{status}</span>{demoMode ? <em>demo</em> : null}</div> : null}

        {view === "home" ? (
          <DashboardScreen
            session={session}
            services={services}
            policies={keys}
            credentials={credentials}
            users={users}
            tenants={tenantSummaries}
            overview={adminOverview}
            usageRows={usageRows}
            usage={usageSnapshot}
            usageLoaded={usageLoaded}
            onOpenCatalog={() => navigateTo("catalog")}
            onOpenPlayground={() => navigateTo("playground")}
            onOpenUsage={() => navigateTo("usage")}
            onOpenAccess={() => navigateTo("policies")}
          />
        ) : null}

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
                : proxyRoute ? { ...current, mode: "service", ...playgroundServicePreset(proxyRoute) } : current);
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
            turns={playgroundTurns}
            selectedTurnId={selectedPlaygroundTurnId}
            setSelectedTurnId={setSelectedPlaygroundTurnId}
            error={playgroundError}
            onRun={runPlayground}
            onNewConversation={() => {
              setPlaygroundTurns([]);
              setSelectedPlaygroundTurnId("");
              setPlaygroundError("");
              setPlayground((current) => ({ ...current, prompt: "" }));
            }}
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
            upstreamGrants={upstreamGrants}
            selectedUpstreamGrant={selectedUpstreamGrant}
            assignmentRules={assignmentRules}
            selectedAssignmentRule={selectedAssignmentRule}
            providers={providers}
            form={policyForm}
            setForm={setPolicyForm}
            credentialForm={credentialForm}
            setCredentialForm={setCredentialForm}
            bindingForm={bindingForm}
            setBindingForm={setBindingForm}
            upstreamGrantForm={upstreamGrantForm}
            setUpstreamGrantForm={setUpstreamGrantForm}
            assignmentRuleForm={assignmentRuleForm}
            setAssignmentRuleForm={setAssignmentRuleForm}
            issuedKey={issuedKey}
            error={policyError}
            onSave={savePolicy}
            onIssueCredential={issueCredential}
            onRevokeCredential={revokeCredential}
            onSaveBinding={saveBinding}
            onSaveUpstreamGrant={saveUpstreamGrant}
            onRevokeUpstreamGrant={revokeUpstreamGrant}
            onRefreshUpstreamGrant={refreshUpstreamGrant}
            onAuthorizeUpstreamGrant={authorizeUpstreamGrant}
            onSaveAssignmentRule={saveAssignmentRule}
            onReconcileAssignments={reconcileAssignments}
            onNew={startNewPolicy}
            onEdit={editPolicy}
            onEditCredential={(credential) => {
              setSelectedCredentialId(credential.credentialId);
              setCredentialForm({ credentialId: "", policyId: credential.policyId, principalId: credential.principalId ?? "" });
              setIssuedKey("");
            }}
            onEditBinding={editBinding}
            onNewBinding={() => {
              setSelectedBindingKey("");
              setBindingForm({ ...defaultBinding, policyId: selectedPolicyId || keys[0]?.policyId || "" });
            }}
            onEditUpstreamGrant={editUpstreamGrant}
            onNewUpstreamGrant={startNewUpstreamGrant}
            onEditAssignmentRule={editAssignmentRule}
            onNewAssignmentRule={startNewAssignmentRule}
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

        {view === "usage" && session.role === "admin" ? <UsageScreen keys={keys} credentials={credentials} services={services} overview={adminOverview} tenants={tenantSummaries} usageRows={usageRows} usage={usageSnapshot} usageLoaded={usageLoaded} /> : null}
      </section>
    </main>
  );
}
import React from "react";
import { Route } from "lucide-react";
import { accessFormFromUser, playgroundServicePreset } from "./domain";
import { BrandMark,EntityName,InlineError,InlineNote,InspectorHeader,OutcomeStatus,PanelTitle,ReadinessStatus,Status,ThemeToggle,viewIcon,viewSubtitle,viewTitle } from "./components";
import { DashboardScreen, CatalogScreen, UserAvatar } from "./screens/dashboard-catalog";
import { PlaygroundScreen } from "./screens/playground";
import { PoliciesScreen } from "./screens/access";
import { UsageScreen, UsersScreen } from "./screens/users-usage";
import { applyTheme, defaultBinding, initialTheme, navItems } from "./ui-config";
import { formatTimestamp } from "./ui-helpers";
import { useConsoleController } from "./use-console-controller";
