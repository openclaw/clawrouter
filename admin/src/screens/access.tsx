export function PoliciesScreen({ tab, setTab, keys, selected, credentials, selectedCredential, bindings, selectedBinding, upstreamGrants, selectedUpstreamGrant, assignmentRules, selectedAssignmentRule, fusionConfig, fusionReadiness, fusionPolicyId, onSelectFusionPolicy, setFusionConfig, fusionModels, providers, form, setForm, credentialForm, setCredentialForm, bindingForm, setBindingForm, upstreamGrantForm, setUpstreamGrantForm, assignmentRuleForm, setAssignmentRuleForm, issuedKey, error, fusionError, onSave, onIssueCredential, onRevokeCredential, onSaveBinding, onSaveUpstreamGrant, onRevokeUpstreamGrant, onRefreshUpstreamGrant, onAuthorizeUpstreamGrant, onSaveAssignmentRule, onReconcileAssignments, onSaveFusion, onCheckFusion, onNew, onEdit, onEditCredential, onEditBinding, onNewBinding, onEditUpstreamGrant, onNewUpstreamGrant, onEditAssignmentRule, onNewAssignmentRule, onRevoke, onPreset, onToggleProvider, onSetProviderGroup, busy }: {
  tab: AccessTab;
  setTab: (tab: AccessTab) => void;
  keys: AccessPolicy[];
  selected?: AccessPolicy;
  credentials: ProxyCredential[];
  selectedCredential?: ProxyCredential;
  bindings: PolicyBinding[];
  selectedBinding?: PolicyBinding;
  upstreamGrants: UpstreamGrant[];
  selectedUpstreamGrant?: UpstreamGrant;
  assignmentRules: AssignmentRule[];
  selectedAssignmentRule?: AssignmentRule;
  fusionConfig: FusionConfig;
  fusionReadiness: FusionReadiness | null;
  fusionPolicyId: string;
  onSelectFusionPolicy: (policyId: string) => void;
  setFusionConfig: React.Dispatch<React.SetStateAction<FusionConfig>>;
  fusionModels: CatalogModel[];
  providers: ProviderRow[];
  form: PolicyForm;
  setForm: (form: PolicyForm) => void;
  credentialForm: CredentialForm;
  setCredentialForm: (form: CredentialForm) => void;
  bindingForm: BindingForm;
  setBindingForm: (form: BindingForm) => void;
  upstreamGrantForm: UpstreamGrantForm;
  setUpstreamGrantForm: (form: UpstreamGrantForm) => void;
  assignmentRuleForm: AssignmentRuleForm;
  setAssignmentRuleForm: (form: AssignmentRuleForm) => void;
  issuedKey: string;
  error: string;
  fusionError: string;
  onSave: (event: FormEvent) => void;
  onIssueCredential: (event: FormEvent) => void;
  onRevokeCredential: (credentialId: string) => void;
  onSaveBinding: (event: FormEvent) => void;
  onSaveUpstreamGrant: (event: FormEvent) => void;
  onRevokeUpstreamGrant: (grant: UpstreamGrant) => void;
  onRefreshUpstreamGrant: (grant: UpstreamGrant) => void;
  onAuthorizeUpstreamGrant: () => void;
  onSaveAssignmentRule: (event: FormEvent) => void;
  onReconcileAssignments: () => void;
  onSaveFusion: (event: FormEvent) => void;
  onCheckFusion: () => void;
  onNew: () => void;
  onEdit: (policy: AccessPolicy) => void;
  onEditCredential: (credential: ProxyCredential) => void;
  onEditBinding: (binding: PolicyBinding) => void;
  onNewBinding: () => void;
  onEditUpstreamGrant: (grant: UpstreamGrant) => void;
  onNewUpstreamGrant: () => void;
  onEditAssignmentRule: (rule: AssignmentRule) => void;
  onNewAssignmentRule: () => void;
  onRevoke: (policyId: string) => void;
  onPreset: (role: keyof typeof rolePresets) => void;
  onToggleProvider: (id: string) => void;
  onSetProviderGroup: (ids: string[], checked: boolean) => void;
  busy: boolean;
}) {
  const resourceTabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    resourceTabsRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  return (
    <div className="accessWorkspace">
      <div ref={resourceTabsRef} className="resourceTabs" role="tablist" aria-label="access resources">
        <button type="button" role="tab" aria-selected={tab === "policies"} className={tab === "policies" ? "active" : ""} onClick={() => setTab("policies")}>Policies <span>{keys.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "credentials"} className={tab === "credentials" ? "active" : ""} onClick={() => setTab("credentials")}>Credentials <span>{credentials.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "bindings"} className={tab === "bindings" ? "active" : ""} onClick={() => setTab("bindings")}>Bindings <span>{bindings.filter((binding) => binding.enabled).length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "upstream"} className={tab === "upstream" ? "active" : ""} onClick={() => setTab("upstream")}>Upstream <span>{upstreamGrants.filter((grant) => grant.enabled).length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "assignments"} className={tab === "assignments" ? "active" : ""} onClick={() => setTab("assignments")}>Assignments <span>{assignmentRules.filter((rule) => rule.enabled).length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "fusion"} className={tab === "fusion" ? "active" : ""} onClick={() => setTab("fusion")}>Fusion <span>{fusionConfig.enabled ? "on" : "off"}</span></button>
      </div>
      {tab === "policies" ? <PolicyPanel keys={keys} selected={selected} providers={providers} form={form} setForm={setForm} error={error} onSave={onSave} onNew={onNew} onEdit={onEdit} onRevoke={onRevoke} onPreset={onPreset} onToggleProvider={onToggleProvider} onSetProviderGroup={onSetProviderGroup} busy={busy} /> : null}
      {tab === "credentials" ? <CredentialPanel policies={keys} credentials={credentials} selected={selectedCredential} form={credentialForm} setForm={setCredentialForm} issuedKey={issuedKey} error={error} onIssue={onIssueCredential} onEdit={onEditCredential} onRevoke={onRevokeCredential} busy={busy} /> : null}
      {tab === "bindings" ? <BindingPanel policies={keys} bindings={bindings} selected={selectedBinding} form={bindingForm} setForm={setBindingForm} error={error} onSave={onSaveBinding} onEdit={onEditBinding} onNew={onNewBinding} busy={busy} /> : null}
      {tab === "upstream" ? <UpstreamGrantPanel policies={keys} providers={providers} grants={upstreamGrants} selected={selectedUpstreamGrant} form={upstreamGrantForm} setForm={setUpstreamGrantForm} error={error} onSave={onSaveUpstreamGrant} onEdit={onEditUpstreamGrant} onNew={onNewUpstreamGrant} onRefresh={onRefreshUpstreamGrant} onAuthorize={onAuthorizeUpstreamGrant} onRevoke={onRevokeUpstreamGrant} busy={busy} /> : null}
      {tab === "assignments" ? <AssignmentRulePanel policies={keys} rules={assignmentRules} selected={selectedAssignmentRule} form={assignmentRuleForm} setForm={setAssignmentRuleForm} error={error} onSave={onSaveAssignmentRule} onEdit={onEditAssignmentRule} onNew={onNewAssignmentRule} onReconcile={onReconcileAssignments} busy={busy} /> : null}
      {tab === "fusion" ? <FusionPanel config={fusionConfig} readiness={fusionReadiness} policies={keys} policyId={fusionPolicyId} onSelectPolicy={onSelectFusionPolicy} setConfig={setFusionConfig} models={fusionModels} error={fusionError} onSave={onSaveFusion} onCheck={onCheckFusion} busy={busy} /> : null}
    </div>
  );
}

export function FusionPanel({ config, readiness, policies, policyId, onSelectPolicy, setConfig, models, error, onSave, onCheck, busy }: {
  config: FusionConfig;
  readiness: FusionReadiness | null;
  policies: AccessPolicy[];
  policyId: string;
  onSelectPolicy: (policyId: string) => void;
  setConfig: React.Dispatch<React.SetStateAction<FusionConfig>>;
  models: CatalogModel[];
  error: string;
  onSave: (event: FormEvent) => void;
  onCheck: () => void;
  busy: boolean;
}) {
  const choices = models.filter((model) => model.id !== config.modelId);
  return (
    <div className="entityLayout fusionWorkspace">
      <section className="mainPane">
        <div className="overviewStrip">
          <Metric label="virtual model" value="fusion" meta={config.enabled ? "selectable now" : "disabled"} />
          <Metric label="parallel advisers" value={String(config.adviserModels.length)} meta="maximum four" />
          <Metric label="synthesizer" value={shortFusionModel(config.aggregatorModel)} meta="final answer authority" />
        </div>
        <div className="tableSectionHeader"><div><strong>On-demand intelligence route</strong><span>Select <code>{config.modelId}</code> only when a turn deserves the ensemble.</span></div><Status label={config.enabled ? "active" : "disabled"} tone={config.enabled ? "active" : "neutral"} /></div>
        <div className="fusionTopology" aria-label="Fusion request flow">
          <div className="fusionInput"><span>01</span><strong>{config.modelId}</strong><small>explicit model selection</small></div>
          <div className="fusionArrow" aria-hidden="true">→</div>
          <div className="fusionAdvisers">
            {config.adviserModels.map((model, index) => <div key={`${model}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{model}</strong><small>private, bounded proposal</small></div>)}
            {!config.adviserModels.length ? <div><span>—</span><strong>No advisers</strong><small>Add at least one model</small></div> : null}
          </div>
          <div className="fusionArrow" aria-hidden="true">→</div>
          <div className="fusionOutput"><span>FINAL</span><strong>{config.aggregatorModel}</strong><small>verify, resolve, synthesize</small></div>
        </div>
        <div className="fusionPrinciples">
          <article><strong>Policy-native</strong><p>Every adviser and final call keeps normal provider grants, budgets, retention, and usage accounting.</p></article>
          <article><strong>Fail-open advisers</strong><p>Unavailable advisers are omitted; the configured synthesizer still answers.</p></article>
          <article><strong>Tool-safe</strong><p>Tool definitions stay out of adviser requests and remain available to the final model.</p></article>
        </div>
        <FusionReadinessPanel readiness={readiness} />
      </section>
      <aside className="inspector wideInspector fusionInspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={ServerCog} title="Configure fusion" subtitle="one sparse adviser layer + one final synthesizer" />
          {error ? <InlineError message={error} /> : null}
          <div className="formGrid compact">
            <label className="full"><span>readiness policy</span><select value={policyId} onChange={(event) => onSelectPolicy(event.target.value)}>{policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.policyId}{policy.enabled ? "" : " · disabled"}</option>)}</select></label>
            <label className="full"><span>state</span><select value={config.enabled ? "enabled" : "disabled"} onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.value === "enabled" }))}><option value="enabled">enabled · advertise model</option><option value="disabled">disabled</option></select></label>
            <label className="full"><span>final synthesizer</span><input list="fusion-model-options" value={config.aggregatorModel} onChange={(event) => setConfig((current) => ({ ...current, aggregatorModel: event.target.value }))} placeholder="openai/gpt-4.1-mini" /></label>
            <label className="full"><span>adviser models · one per line, maximum four</span><textarea value={config.adviserModels.join("\n")} onChange={(event) => setConfig((current) => ({ ...current, adviserModels: event.target.value.split(/[\n,]+/).map((model) => model.trim()).filter(Boolean).slice(0, 4) }))} placeholder={"local/qwen3:8b\nopenai/gpt-4.1-mini"} /></label>
            <datalist id="fusion-model-options">{choices.map((model) => <option key={model.id} value={model.id}>{model.provider}</option>)}</datalist>
            <label><span>adviser timeout (ms)</span><input type="number" min="1000" max="120000" value={config.adviserTimeoutMs} onChange={(event) => setConfig((current) => ({ ...current, adviserTimeoutMs: Number(event.target.value) }))} /></label>
            <label><span>proposal tokens</span><input type="number" min="64" max="4096" value={config.maxOutputTokens} onChange={(event) => setConfig((current) => ({ ...current, maxOutputTokens: Number(event.target.value) }))} /></label>
            <label><span>local input chars</span><input type="number" min="1000" max="200000" value={config.maxInputChars} onChange={(event) => setConfig((current) => ({ ...current, maxInputChars: Number(event.target.value) }))} /></label>
            <label><span>injected chars / adviser</span><input type="number" min="256" max="20000" value={config.maxProposalChars} onChange={(event) => setConfig((current) => ({ ...current, maxProposalChars: Number(event.target.value) }))} /></label>
            <label className="full"><span>adviser temperature</span><input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={(event) => setConfig((current) => ({ ...current, temperature: Number(event.target.value) }))} /></label>
          </div>
          <InlineNote><code>local/*</code> targets the Local OpenAI-compatible provider. A hosted Cloudflare Worker cannot reach your laptop&apos;s loopback address; configure a network-reachable endpoint, or run ClawRouter locally with Ollama/LM Studio.</InlineNote>
          <div className="inspectorActions"><button type="button" className="buttonSecondary" disabled={busy || !policyId || !config.aggregatorModel.trim()} onClick={onCheck}><RefreshCw className="buttonIcon" aria-hidden="true" /><span>Check readiness</span></button><button type="submit" disabled={busy || !policyId || !config.aggregatorModel.trim() || !config.adviserModels.length}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save fusion model</span></button></div>
        </form>
      </aside>
    </div>
  );
}

function FusionReadinessPanel({ readiness }: { readiness: FusionReadiness | null }) {
  if (!readiness) return <div className="fusionReadiness fusionReadiness-empty"><strong>Readiness pending</strong><span>Select a policy and check the draft profile before enabling it.</span></div>;
  return (
    <section className="fusionReadiness" aria-label="Fusion readiness">
      <div className="fusionReadinessHeader">
        <div><strong>Policy preflight</strong><span><code>{readiness.policyId}</code> · {readiness.readyAdviserCount}/{readiness.adviserCount} advisers executable · {readiness.callCount} maximum calls</span></div>
        <Status label={readiness.executable ? readiness.advertisable ? "ready" : "executable" : "blocked"} tone={readiness.executable ? "active" : "revoked"} />
      </div>
      <div className="fusionReadinessCalls">
        {readiness.calls.map((call) => <article key={`${call.stage}-${call.index ?? "final"}`} className={call.executable ? "ready" : "blocked"}>
          <span>{call.stage === "synthesizer" ? "FINAL" : `A${call.index}`}</span>
          <div><strong>{call.model}</strong><small>{call.provider} · {call.status}</small>{call.reasons.map((reason) => <em key={reason}>{reason}</em>)}</div>
          <b>{formatMicros(call.estimatedReservationMicros)}</b>
        </article>)}
      </div>
      <div className="fusionReadinessEstimate"><span>Eligible-call reservation</span><strong>{formatMicros(readiness.estimatedReservationMicros)}</strong><small>{readiness.estimateNote} {readiness.budgetConfigured ? `${readiness.remainingBudgetMicros == null ? "Budget unavailable" : `${formatMicros(readiness.remainingBudgetMicros)} remains`}${readiness.budgetSufficientForAll === false ? "; not enough for every eligible call" : ""}.` : "Policy is unmetered."}</small></div>
    </section>
  );
}

function shortFusionModel(model: string) {
  const value = model.split("/").at(-1) ?? model;
  return value.length > 18 ? `${value.slice(0, 16)}…` : value;
}

export function UpstreamGrantPanel({ policies, providers, grants, selected, form, setForm, error, onSave, onEdit, onNew, onRefresh, onAuthorize, onRevoke, busy }: {
  policies: AccessPolicy[];
  providers: ProviderRow[];
  grants: UpstreamGrant[];
  selected?: UpstreamGrant;
  form: UpstreamGrantForm;
  setForm: (form: UpstreamGrantForm) => void;
  error: string;
  onSave: (event: FormEvent) => void;
  onEdit: (grant: UpstreamGrant) => void;
  onNew: () => void;
  onRefresh: (grant: UpstreamGrant) => void;
  onAuthorize: () => void;
  onRevoke: (grant: UpstreamGrant) => void;
  busy: boolean;
}) {
  const active = grants.filter((grant) => grant.enabled).length;
  const usable = grants.filter((grant) => grant.usable).length;
  const refreshable = grants.filter((grant) => grant.refreshConfigured && grant.hasRefreshToken).length;
  const selectedProvider = providers.find((provider) => provider.id === form.provider);
  const authorizationKind = selectedProvider?.auth?.authorization?.grantKind;
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="overviewStrip">
          <Metric label="active grants" value={String(active)} meta={`${grants.length} total`} />
          <Metric label="usable" value={String(usable)} meta="ready for routing" />
          <Metric label="refreshable" value={String(refreshable)} meta="rotatable OAuth grants" />
        </div>
        <div className="tableSectionHeader"><div><strong>Upstream credentials</strong><span>Policy and tenant scoped provider access</span></div><button type="button" onClick={onNew} disabled={busy}><Plus className="buttonIcon" aria-hidden="true" /><span>New grant</span></button></div>
        <EntityTable
          columns={["connection", "scope", "provider", "priority", "state"]}
          columnTemplate="minmax(220px, 1.4fr) minmax(150px, 1fr) minmax(130px, .8fr) 90px 100px"
          rows={grants.map((grant) => ({ id: grant.key, active: selected?.key === grant.key, onClick: () => onEdit(grant), cells: [<EntityName icon={ServerCog} title={grant.label || grant.tokenRef} subtitle={`${grant.tokenRef} · ${grant.kind.replace("_", " ")}`} />, `${grant.scope === "policies" ? "policy" : "tenant"} · ${grant.scopeId}`, grant.provider ?? "legacy", String(grant.priority), <Status label={grant.usable ? "usable" : grant.enabled ? "blocked" : "revoked"} tone={grant.usable ? "active" : "revoked"} />] }))}
        />
      </section>
      <aside className="inspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={ServerCog} title={selected ? "Edit upstream grant" : "New upstream grant"} subtitle={selected?.key ?? "provider credential"} />
          {error ? <InlineError message={error} /> : null}
          <div className="formGrid compact">
            <label><span>scope</span><select value={form.scope} disabled={Boolean(selected)} onChange={(event) => setForm({ ...form, scope: event.target.value as UpstreamGrantForm["scope"], scopeId: event.target.value === "policies" ? policies[0]?.policyId ?? "" : "default" })}><option value="policies">policy</option><option value="tenants">tenant</option></select></label>
            <label><span>scope id</span>{form.scope === "policies" ? <select value={form.scopeId} disabled={Boolean(selected)} onChange={(event) => setForm({ ...form, scopeId: event.target.value })}>{policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.policyId}</option>)}</select> : <input value={form.scopeId} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, scopeId: event.target.value })} />}</label>
            <label><span>provider</span><select value={form.provider} disabled={Boolean(selected)} onChange={(event) => { const provider = providers.find((item) => item.id === event.target.value); setForm({ ...form, provider: event.target.value, kind: provider?.auth?.authorization?.grantKind ?? form.kind, tokenRef: !form.tokenRef || form.tokenRef === form.provider ? event.target.value : form.tokenRef }); }}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.display_name}</option>)}</select></label>
            <label><span>kind</span><select value={form.kind} disabled={Boolean(selected)} onChange={(event) => setForm({ ...form, kind: event.target.value as UpstreamGrant["kind"], credential: "", credentialBundle: "", accessToken: "", refreshToken: "" })}><option value="api_key">API key</option><option value="oauth">OAuth</option><option value="subscription">subscription</option></select></label>
            <label className="full"><span>token reference</span><input value={form.tokenRef} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, tokenRef: event.target.value })} /></label>
            <label className="full"><span>label</span><input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></label>
            <label><span>pool priority</span><input inputMode="numeric" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} /></label>
            {form.kind === "api_key" ? <label className="full"><span>{selected?.hasCredential ? "replace API key" : "API key"}</span><input type="password" autoComplete="off" value={form.credential} onChange={(event) => setForm({ ...form, credential: event.target.value })} /></label> : <label className="full"><span>{selected?.hasAccessToken ? "replace access token" : "access token"}</span><input type="password" autoComplete="off" value={form.accessToken} onChange={(event) => setForm({ ...form, accessToken: event.target.value })} /></label>}
            {form.kind === "api_key" ? <label className="full"><span>{selected?.credentialFields.length ? "replace credential bundle JSON" : "credential bundle JSON"}</span><textarea value={form.credentialBundle} onChange={(event) => setForm({ ...form, credentialBundle: event.target.value })} placeholder={'{"accessKeyId":"...","secretAccessKey":"...","sessionToken":"..."}'} /></label> : null}
            {form.kind !== "api_key" ? <label className="full"><span>{selected?.hasRefreshToken ? "replace refresh token" : "refresh token"}</span><input type="password" autoComplete="off" value={form.refreshToken} onChange={(event) => setForm({ ...form, refreshToken: event.target.value })} /></label> : null}
            {form.kind === "subscription" ? <label className="full"><span>account id</span><input value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })} /></label> : null}
            <label><span>expires at</span><input value={form.expiresAt} onChange={(event) => setForm({ ...form, expiresAt: event.target.value })} placeholder="ISO-8601 or blank" /></label>
            <label><span>state</span><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
          </div>
          <InlineNote>Lower priorities route first. Equal priorities use a stable grant order. Secret values are write-only.</InlineNote>
          {selected ? <dl className="facts"><dt>primary secret</dt><dd>{selected.hasCredential || selected.hasAccessToken || selected.credentialFields.length ? "stored" : "missing"}</dd><dt>credential fields</dt><dd>{selected.credentialFields.length ? selected.credentialFields.join(", ") : "none"}</dd><dt>refresh token</dt><dd>{selected.hasRefreshToken ? "stored" : "none"}</dd><dt>refresh config</dt><dd>{selected.refreshConfigured ? "manifest approved" : "none"}</dd><dt>state</dt><dd>{selected.usable ? "usable" : "blocked"}</dd></dl> : null}
          <div className="inspectorActions">{authorizationKind ? <button type="button" disabled={busy || !form.scopeId || !form.tokenRef || !form.provider} onClick={onAuthorize}><LogIn className="buttonIcon" aria-hidden="true" /><span>{selected ? "Reconnect" : "Connect"} with provider</span></button> : null}<button type="submit" className={authorizationKind ? "buttonSecondary" : undefined} disabled={busy || !form.scopeId || !form.tokenRef || !form.provider}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save grant</span></button>{selected?.refreshConfigured && selected.hasRefreshToken ? <button type="button" className="buttonSecondary" disabled={busy || !selected.enabled} onClick={() => onRefresh(selected)}><RefreshCw className="buttonIcon" aria-hidden="true" /><span>Refresh</span></button> : null}{selected ? <button type="button" className="buttonDanger" disabled={busy || !selected.enabled} onClick={() => onRevoke(selected)}><CircleSlash2 className="buttonIcon" aria-hidden="true" /><span>Revoke</span></button> : null}</div>
        </form>
      </aside>
    </div>
  );
}

export function AssignmentRulePanel({ policies, rules, selected, form, setForm, error, onSave, onEdit, onNew, onReconcile, busy }: {
  policies: AccessPolicy[];
  rules: AssignmentRule[];
  selected?: AssignmentRule;
  form: AssignmentRuleForm;
  setForm: (form: AssignmentRuleForm) => void;
  error: string;
  onSave: (event: FormEvent) => void;
  onEdit: (rule: AssignmentRule) => void;
  onNew: () => void;
  onReconcile: () => void;
  busy: boolean;
}) {
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="overviewStrip">
          <Metric label="active rules" value={String(rules.filter((rule) => rule.enabled).length)} meta={`${rules.length} total`} />
          <Metric label="email rules" value={String(rules.filter((rule) => rule.kind.startsWith("email") || rule.kind === "exact_email").length)} meta="reconcile on rule change" />
          <Metric label="GitHub rules" value={String(rules.filter((rule) => rule.kind.startsWith("github")).length)} meta="verified evidence only" />
        </div>
        <div className="tableSectionHeader"><div><strong>Automatic assignments</strong><span>Identity evidence to managed group access</span></div><div className="inlineActions"><button type="button" className="buttonSecondary" onClick={onReconcile} disabled={busy}><RefreshCw className="buttonIcon" aria-hidden="true" /><span>Reconcile all</span></button><button type="button" onClick={onNew} disabled={busy}><Plus className="buttonIcon" aria-hidden="true" /><span>New rule</span></button></div></div>
        <EntityTable columns={["rule", "match", "groups", "policies", "state"]} columnTemplate="minmax(180px, 1fr) minmax(220px, 1.4fr) 90px 90px 100px" rows={rules.map((rule) => ({ id: rule.ruleId, active: selected?.ruleId === rule.ruleId, onClick: () => onEdit(rule), cells: [<EntityName icon={Users} title={rule.ruleId} subtitle={rule.provenance} />, `${rule.kind.replaceAll("_", " ")} · ${rule.subject}`, String(rule.groups.length), String(rule.policyIds.length), <Status label={rule.enabled ? "active" : "disabled"} tone={rule.enabled ? "active" : "revoked"} />] }))} />
      </section>
      <aside className="inspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={Users} title={selected ? "Edit assignment rule" : "New assignment rule"} subtitle={selected?.generatedGroup ?? "managed identity access"} />
          {error ? <InlineError message={error} /> : null}
          <div className="formGrid compact">
            <label className="full"><span>rule id</span><input value={form.ruleId} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, ruleId: event.target.value })} /></label>
            <label><span>match kind</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as AssignmentRule["kind"] })}><option value="exact_email">exact email</option><option value="email_domain">email domain</option><option value="github_org">GitHub organization</option><option value="github_team">GitHub team</option></select></label>
            <label><span>priority</span><input inputMode="numeric" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} /></label>
            <label className="full"><span>subject</span><input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} placeholder={form.kind === "exact_email" ? "user@example.com" : form.kind === "email_domain" ? "example.com" : form.kind === "github_team" ? "org/team" : "organization"} /></label>
            <label className="full"><span>groups</span><input value={form.groups} onChange={(event) => setForm({ ...form, groups: event.target.value })} placeholder="maintainers, docs" /></label>
            <label className="full"><span>provenance</span><input value={form.provenance} onChange={(event) => setForm({ ...form, provenance: event.target.value })} /></label>
            <label><span>state</span><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
            <label className="checkLabel"><input type="checkbox" checked={form.revokeOnLoss} onChange={(event) => setForm({ ...form, revokeOnLoss: event.target.checked })} /><span>revoke on loss</span></label>
          </div>
          <div className="sectionTitle">Managed policies</div>
          <div className="serviceMatrix">{policies.map((policy) => <label key={policy.policyId}><input type="checkbox" checked={form.policyIds.includes(policy.policyId)} onChange={() => setForm({ ...form, policyIds: form.policyIds.includes(policy.policyId) ? form.policyIds.filter((id) => id !== policy.policyId) : [...form.policyIds, policy.policyId].sort() })} /><span>{policy.policyId}</span><small>{policy.providers.length ? `${policy.providers.length} services` : "all services"}</small></label>)}</div>
          <div className="inspectorActions"><button type="submit" disabled={busy || !form.ruleId || !form.subject.trim() || !form.provenance.trim()}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save rule</span></button></div>
        </form>
      </aside>
    </div>
  );
}

export function CredentialPanel({ policies, credentials, selected, form, setForm, issuedKey, error, onIssue, onEdit, onRevoke, busy }: {
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
  const outcomes = new Map(credentials.map((credential) => [credential.credentialId, credentialOutcome(credential, policies)]));
  const selectedOutcome = selected ? outcomes.get(selected.credentialId) : undefined;
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="overviewStrip">
          <Metric label="active credentials" value={String(Array.from(outcomes.values()).filter((outcome) => outcome.active).length)} meta={`${credentials.length} total`} />
          <Metric label="bound policies" value={String(new Set(credentials.map((credential) => credential.policyId)).size)} meta={`${policies.length} available`} />
          <Metric label="inactive" value={String(Array.from(outcomes.values()).filter((outcome) => !outcome.active).length)} meta="revoked, stale, or policy-disabled" />
        </div>
        <div className="tableSectionHeader"><div><strong>Issued credentials</strong><span>Machine access bound to policies</span></div><span>secrets reveal once</span></div>
        <EntityTable columns={["credential", "policy", "owner", "state"]} columnTemplate="minmax(190px, 1.25fr) minmax(150px, .9fr) minmax(180px, 1fr) 110px" rows={credentials.map((credential) => { const outcome = outcomes.get(credential.credentialId)!; return { id: credential.credentialId, active: selected?.credentialId === credential.credentialId, onClick: () => onEdit(credential), cells: [<EntityName icon={KeyRound} title={credential.credentialId} subtitle="proxy credential" />, credential.policyId, credential.principalId ?? "unassigned", <Status label={outcome.label} tone={outcome.tone} />] }; })} />
      </section>
      <aside className="inspector">
        <form onSubmit={onIssue}>
          <InspectorHeader icon={KeyRound} title="Issue credential" subtitle="creates a new secret for one policy" />
          {error ? <InlineError message={error} /> : null}
          {issuedKey ? <div className="issuedKey"><div><span>copy now · shown once</span><code>{issuedKey}</code></div><button type="button" className="buttonSecondary" onClick={copyIssuedKey}>Copy</button></div> : null}
          <div className="formGrid compact">
            <label className="full"><span>credential id</span><input value={form.credentialId} onChange={(event) => setForm({ ...form, credentialId: event.target.value })} placeholder="auto-generated when blank" /></label>
            <label className="full"><span>policy</span><select value={form.policyId} onChange={(event) => setForm({ ...form, policyId: event.target.value })}>{policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.policyId}</option>)}</select></label>
            <label className="full"><span>owner email</span><input type="email" value={form.principalId} onChange={(event) => setForm({ ...form, principalId: event.target.value })} placeholder="required for per-user retention exemption" /></label>
          </div>
          <InlineNote>The owner sees policy retention status through the token profile and response header. Their exemption wins before content is stored.</InlineNote>
          <div className="inspectorActions"><button type="submit" disabled={busy || !form.policyId}><Plus className="buttonIcon" aria-hidden="true" /><span>Issue credential</span></button></div>
          {selected ? <><div className="sectionTitle">Selected credential</div><dl className="facts"><dt>id</dt><dd>{selected.credentialId}</dd><dt>policy</dt><dd>{selected.policyId}</dd><dt>owner</dt><dd>{selected.principalId ?? "unassigned"}</dd><dt>state</dt><dd>{selectedOutcome?.label ?? "inactive"}</dd></dl><div className="inspectorActions"><button type="button" className="buttonDanger" disabled={busy || !selected.enabled} onClick={() => onRevoke(selected.credentialId)}><CircleSlash2 className="buttonIcon" aria-hidden="true" /><span>Revoke credential</span></button></div></> : null}
        </form>
      </aside>
    </div>
  );
}

export function BindingPanel({ policies, bindings, selected, form, setForm, error, onSave, onEdit, onNew, busy }: {
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

export function PolicyPanel({ keys, selected, providers, form, setForm, error, onSave, onNew, onEdit, onRevoke, onPreset, onToggleProvider, onSetProviderGroup, busy }: {
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
          columns={["policy", "tenant", "scope", "retention", "state"]}
          columnTemplate="minmax(170px, 1.35fr) minmax(90px, 0.7fr) minmax(96px, 0.75fr) 86px 88px"
          rows={keys.map((key) => ({ id: key.policyId, active: selected?.policyId === key.policyId, onClick: busy ? undefined : () => onEdit(key), cells: [<EntityName icon={KeyRound} title={key.policyId} subtitle={key.tokenRole ?? "custom"} />, key.tenantId ?? "default", key.providers.length ? `${key.providers.length} services` : "all services", <Status label={key.retainRequestContent ? "30 days" : "off"} tone={key.retainRequestContent ? "active" : "neutral"} />, <Status label={key.enabled ? "active" : "revoked"} tone={key.enabled ? "active" : "revoked"} />] }))}
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
            <label><span>fixed request cost (micros)</span><input inputMode="decimal" value={form.requestCostMicros} onChange={(event) => setForm({ ...form, requestCostMicros: event.target.value })} placeholder="blank = manifest-priced routes only" title="Required for any budgeted route without manifest pricing; blank uses versioned list pricing where available." /></label>
            <label className="full"><span>request content retention</span><select value={form.retainRequestContent ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, retainRequestContent: event.target.value === "enabled" })}><option value="enabled">enabled · retain 30 days</option><option value="disabled">disabled</option></select></label>
          </div>
          <InlineNote>Enabled by default. Users see this setting before use. A per-user exemption always overrides the policy.</InlineNote>
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
import React, { type FormEvent, useEffect, useRef, useState } from "react";
import { CircleSlash2, KeyRound, LogIn, Plus, RefreshCw, Search, ServerCog, ShieldCheck, Users } from "lucide-react";
import { bindingKey, type CatalogModel } from "../domain";
import { EntityName, InlineError, InlineNote, InspectorHeader, Status, kindLabel } from "../components";
import { rolePresets } from "../ui-config";
import { credentialOutcome, formatMicros, groupedProviders } from "../ui-helpers";
import { EntityTable, Metric } from "./users-usage";
import type { AccessForm,AccessPolicy,AccessRole,AccessTab,AccessUser,AdminOverview,AdminTenantSummary,AdminUsageRow,AssignmentRule,AssignmentRuleForm,BindingForm,BrandIcon,BudgetStatus,ContentRetention,CredentialForm,EntitlementsResponse,FusionConfig,FusionReadiness,IconComponent,OutcomeTone,PlaygroundForm,PlaygroundHttpResponse,PlaygroundTurn,PolicyBinding,PolicyForm,ProviderAccess,ProviderConnection,ProviderReadiness,ProviderResponse,ProviderRow,ProviderUsageSummary,ProxyCredential,RefreshOptions,RetainedRequestContent,RouteCatalog,ServiceItem,ServiceOutcome,SessionResponse,UpstreamGrant,UpstreamGrantForm,UsageAuditEvent,UsageSnapshot,UsageSummary,View } from "../ui-types";
