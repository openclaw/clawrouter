import React from "react";
import { Route } from "lucide-react";
import { accessFormFromUser, playgroundServicePreset } from "./domain";
import { ThemeToggle, viewIcon, viewSubtitle, viewTitle } from "./components";
import { DashboardScreen, CatalogScreen, UserAvatar } from "./screens/dashboard-catalog";
import { PlaygroundScreen } from "./screens/playground";
import { PoliciesScreen } from "./screens/access";
import { UsageScreen, UsersScreen } from "./screens/users-usage";
import { applyTheme, navItems, readTheme } from "./ui-config";
import { formatTimestamp } from "./ui-helpers";
import { useConsole } from "./console-controller-context";
import { consoleStatusPresentation } from "./status-display";
import type { AccessPolicy } from "./ui-types";

export function AppShell() {
  const [theme, setTheme] = React.useState(readTheme);
  React.useEffect(() => { applyTheme(theme); }, [theme]);
  const { session: shell, catalog, access, grantPoolRecovery, usage, selfServiceKeys, credentialOwner, playground: playgroundDomain, refresh } = useConsole();
  const { view, value: session, status, lastUpdatedAt, demoMode, busy, navigateTo } = shell;
  const refreshError = [shell.refreshError, usage.error].filter(Boolean).join("; ");
  const statusPresentation = consoleStatusPresentation(status, demoMode, Boolean(refreshError), shell.refreshing);
  const statusTone = statusPresentation.tone;
  const { providers, providerReadiness, accessByProvider, services, models, serviceRoutes, query, setQuery, kind, setKind, kinds, filteredServices, selectedService, setSelectedServiceId } = catalog;
  const { policies, credentials: credentialState, connections: connectionState, bindings: bindingState, upstream, assignments, fusion, users: userState, tab } = access;
  const { items: keys, selected: selectedPolicy, form: policyForm, setForm: setPolicyForm, error: policyError, save: savePolicy, revoke, edit: editPolicy, startNew: startNewPolicy, applyPreset, toggleProvider: togglePolicyProvider, setProviderGroup: setPolicyProviderGroup } = policies;
  const { items: credentials, selected: selectedCredential, form: credentialForm, setForm: setCredentialForm, issue: issueCredential, rotate: rotateCredential, revoke: revokeCredential, edit: editCredential, startNew: startNewCredential } = credentialState;
  const { items: connections, pendingProviderIds, setEnabled: setProviderConnection, setBudget: setProviderBudget } = connectionState;
  const { items: bindings, selected: selectedBinding, form: bindingForm, setForm: setBindingForm, save: saveBinding, edit: editBinding, startNew: startNewBinding } = bindingState;
  const { items: upstreamGrants, selected: selectedUpstreamGrant, form: upstreamGrantForm, setForm: setUpstreamGrantForm, save: saveUpstreamGrant, revoke: revokeUpstreamGrant, refresh: refreshUpstreamGrant, refreshQuota: refreshUpstreamGrantQuota, authorize: authorizeUpstreamGrant, edit: editUpstreamGrant, startNew: startNewUpstreamGrant } = upstream;
  const { items: assignmentRules, selected: selectedAssignmentRule, form: assignmentRuleForm, setForm: setAssignmentRuleForm, save: saveAssignmentRule, reconcile: reconcileAssignments, edit: editAssignmentRule, startNew: startNewAssignmentRule } = assignments;
  const { config: fusionConfig, setConfig: setFusionConfig, policyId: fusionPolicyId, setPolicyId: setFusionPolicyId, readiness: fusionReadiness, error: fusionError, save: saveFusion, check: checkFusion } = fusion;
  const { items: users, selected: selectedUser, setSelectedEmail: setSelectedUserEmail, form: accessForm, setForm: setAccessForm, error: userError, save: saveUser, startNew: startNewUser } = userState;
  const { value: accessTab, set: setAccessTab } = tab;
  const { adminOverview, tenantSummaries, rows: usageRows, snapshot: usageSnapshot, loaded: usageLoaded } = usage;
  const { form: playground, setForm: setPlayground, turns: playgroundTurns, selectedTurnId: selectedPlaygroundTurnId, setSelectedTurnId: setSelectedPlaygroundTurnId, requestMode, setRequestMode, error: playgroundError, selectedModel, selectedServiceRoute, running: playgroundRunning, run: runPlayground, resetConversation } = playgroundDomain;
  const retentionLabel = session.contentRetention ? session.contentRetention.enabled ? `${session.contentRetention.retentionDays}d` : "off" : "pending";
  function openPolicy(policy: AccessPolicy) {
    if (!editPolicy(policy)) return;
    setAccessTab("policies");
    navigateTo("policies");
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
        <div className="tenantSwitch" title={`${session.tenantId ?? "default"} tenant · ${session.role} · retention ${retentionLabel}`}>
          <UserAvatar email={session.email} />
          <div>
            <strong>{session.email ?? "not signed in"}</strong>
            <span>{session.tenantId ?? "default"} · {session.role} · retention {retentionLabel}</span>
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
            <span className={`connectionMeta connectionMeta-${statusTone}`} title="Last successful access-data refresh. Automatically refreshes every 30 seconds and when this tab regains focus.">
              <span className="connectionDot" aria-hidden="true" />
              <strong>{statusPresentation.label}</strong>
              <span className="connectionSeparator" aria-hidden="true">·</span>
              <span>Updated</span>
              {lastUpdatedAt ? <time dateTime={new Date(lastUpdatedAt).toISOString()}>{formatTimestamp(lastUpdatedAt)}</time> : <span>pending</span>}
            </span>
            <ThemeToggle value={theme} onChange={setTheme} />
          </div>
        </header>

        {statusPresentation.showBar ? <div className={`statusBar statusBar-${statusTone}`} role="status" aria-live="polite"><strong>{statusPresentation.label}</strong><span>{shell.refreshing ? "Refreshing console data" : status}</span>{refreshError ? <><span>{refreshError} Displayed data may be out of date.</span><button type="button" className="buttonSecondary" disabled={busy} onClick={() => void refresh()}>Retry refresh</button></> : null}{demoMode ? <em>demo</em> : null}</div> : null}

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
            usageStale={usage.stale}
            usageError={usage.error}
            usageUpdatedAt={usage.updatedAt}
            myCredentials={selfServiceKeys.items}
            myPolicyIds={selfServiceKeys.policyIds}
            myKeyFeedback={credentialOwner.forSurface("personal")}
            myKeyScope={credentialOwner.scopeEpoch}
            myKeysBusy={busy || credentialOwner.busy}
            onMyKeyDraftChange={credentialOwner.invalidatePresentation}
            onIssueMyKey={selfServiceKeys.issue}
            onRevokeMyKey={selfServiceKeys.revoke}
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
            pendingProviderIds={pendingProviderIds}
            query={query}
            setQuery={setQuery}
            kind={kind}
            setKind={setKind}
            kinds={kinds}
            canAdminister={session.role === "admin"}
            onOpenPolicy={openPolicy}
            onSelect={(service) => setSelectedServiceId(service.id)}
            onSetConnection={setProviderConnection}
            onSetProviderBudget={setProviderBudget}
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
                allProviders: current.allProviders,
                providers: current.allProviders || current.providers.includes(service.provider) ? current.providers : [...current.providers, service.provider].sort(),
              }));
              setAccessTab("policies");
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
            onNewConversation={resetConversation}
            busy={busy || playgroundRunning}
          />
        ) : null}

        {view === "policies" && session.role === "admin" ? (
          <PoliciesScreen
            grantPoolRecovery={grantPoolRecovery}
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
            upstreamBusy={upstream.busy}
            upstreamReady={upstream.ready}
            upstreamError={upstream.error}
            assignmentRules={assignmentRules}
            selectedAssignmentRule={selectedAssignmentRule}
            fusionConfig={fusionConfig}
            fusionReadiness={fusionReadiness}
            fusionPolicyId={fusionPolicyId}
            onSelectFusionPolicy={setFusionPolicyId}
            setFusionConfig={setFusionConfig}
            fusionModels={models}
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
            credentialFeedback={credentialOwner.forSurface("admin")}
            error={access.error}
            policyError={policyError}
            policyDirty={policies.dirty}
            policyMissing={policies.missing}
            policyReady={policies.ready}
            policyBusy={policies.busy}
            onDiscardPolicy={policies.discard}
            fusionError={fusionError}
            onSave={savePolicy}
            onIssueCredential={issueCredential}
            onRevokeCredential={revokeCredential}
            onRotateCredential={rotateCredential}
            onNewCredential={startNewCredential}
            onSaveBinding={saveBinding}
            onSaveUpstreamGrant={saveUpstreamGrant}
            onRevokeUpstreamGrant={revokeUpstreamGrant}
            onRefreshUpstreamGrant={refreshUpstreamGrant}
            onRefreshUpstreamGrantQuota={refreshUpstreamGrantQuota}
            onAuthorizeUpstreamGrant={authorizeUpstreamGrant}
            onSaveAssignmentRule={saveAssignmentRule}
            onReconcileAssignments={reconcileAssignments}
            onSaveFusion={saveFusion}
            onCheckFusion={checkFusion}
            onNew={startNewPolicy}
            onEdit={editPolicy}
            onEditCredential={editCredential}
            onEditBinding={editBinding}
            onNewBinding={startNewBinding}
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
            onOpenPolicy={openPolicy}
            onSelect={(user) => {
              setSelectedUserEmail(user.email);
              setAccessForm(accessFormFromUser(user, bindings));
            }}
            onNew={startNewUser}
            onSave={saveUser}
            busy={busy}
          />
        ) : null}

        {view === "usage" && session.role === "admin" ? <UsageScreen keys={keys} credentials={credentials} services={services} overview={adminOverview} tenants={tenantSummaries} usageRows={usageRows} usage={usageSnapshot} usageLoaded={usageLoaded} usageStale={usage.stale} usageError={usage.error} usageUpdatedAt={usage.updatedAt} /> : null}
      </section>
    </main>
  );
}
