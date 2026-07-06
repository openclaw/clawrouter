export function AppShell() {
  const [theme, setTheme] = React.useState(initialTheme);
  React.useEffect(() => { applyTheme(theme); }, [theme]);
  const { session: shell, catalog, access, usage, playground: playgroundDomain } = useConsole();
  const { view, value: session, status, lastUpdatedAt, demoMode, statusPresentation, busy, statusTone, navigateTo } = shell;
  const { providers, providerReadiness, accessByProvider, services, models, serviceRoutes, query, setQuery, kind, setKind, kinds, filteredServices, selectedService, setSelectedServiceId } = catalog;
  const { policies, credentials: credentialState, connections: connectionState, bindings: bindingState, upstream, assignments, users: userState, tab } = access;
  const { items: keys, selected: selectedPolicy, selectedId: selectedPolicyId, form: policyForm, setForm: setPolicyForm, error: policyError, save: savePolicy, revoke, edit: editPolicy, startNew: startNewPolicy, applyPreset, toggleProvider: togglePolicyProvider, setProviderGroup: setPolicyProviderGroup } = policies;
  const { items: credentials, selected: selectedCredential, form: credentialForm, setForm: setCredentialForm, issuedKey, issue: issueCredential, revoke: revokeCredential, setSelectedId: setSelectedCredentialId, setIssuedKey } = credentialState;
  const { items: connections, setEnabled: setProviderConnection } = connectionState;
  const { items: bindings, selected: selectedBinding, form: bindingForm, setForm: setBindingForm, save: saveBinding, edit: editBinding, startNew: startNewBinding } = bindingState;
  const { items: upstreamGrants, selected: selectedUpstreamGrant, form: upstreamGrantForm, setForm: setUpstreamGrantForm, save: saveUpstreamGrant, revoke: revokeUpstreamGrant, refresh: refreshUpstreamGrant, authorize: authorizeUpstreamGrant, edit: editUpstreamGrant, startNew: startNewUpstreamGrant } = upstream;
  const { items: assignmentRules, selected: selectedAssignmentRule, form: assignmentRuleForm, setForm: setAssignmentRuleForm, save: saveAssignmentRule, reconcile: reconcileAssignments, edit: editAssignmentRule, startNew: startNewAssignmentRule } = assignments;
  const { items: users, selected: selectedUser, setSelectedEmail: setSelectedUserEmail, form: accessForm, setForm: setAccessForm, error: userError, save: saveUser, startNew: startNewUser } = userState;
  const { value: accessTab, set: setAccessTab } = tab;
  const { adminOverview, tenantSummaries, rows: usageRows, snapshot: usageSnapshot, loaded: usageLoaded } = usage;
  const { form: playground, setForm: setPlayground, turns: playgroundTurns, selectedTurnId: selectedPlaygroundTurnId, setSelectedTurnId: setSelectedPlaygroundTurnId, requestMode, setRequestMode, error: playgroundError, selectedModel, selectedServiceRoute, run: runPlayground, resetConversation } = playgroundDomain;
  const retentionLabel = session.contentRetention ? session.contentRetention.enabled ? `${session.contentRetention.retentionDays}d` : "off" : "pending";
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
            <span className={`connectionMeta connectionMeta-${statusTone}`} title="Automatically refreshes every 30 seconds and when this tab regains focus">
              <span className="connectionDot" aria-hidden="true" />
              <strong>{statusPresentation.label}</strong>
              <span className="connectionSeparator" aria-hidden="true">·</span>
              <span>Updated</span>
              {lastUpdatedAt ? <time dateTime={new Date(lastUpdatedAt).toISOString()}>{formatTimestamp(lastUpdatedAt)}</time> : <span>pending</span>}
            </span>
            <ThemeToggle value={theme} onChange={setTheme} />
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
            onNewConversation={resetConversation}
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
import { applyTheme, initialTheme, navItems } from "./ui-config";
import { formatTimestamp } from "./ui-helpers";
import { useConsole } from "./console-controller-context";
