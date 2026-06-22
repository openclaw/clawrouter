export function PlaygroundScreen({ form, setForm, models, selected, serviceRoutes, selectedServiceRoute, accessByProvider, readinessByProvider, requestMode, setRequestMode, turns, selectedTurnId, setSelectedTurnId, error, onRun, onNewConversation, busy }: {
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
  turns: PlaygroundTurn[];
  selectedTurnId: string;
  setSelectedTurnId: (id: string) => void;
  error: string;
  onRun: (event: FormEvent) => void;
  onNewConversation: () => void;
  busy: boolean;
}) {
  const transcript = useRef<HTMLDivElement>(null);
  const blocker = playgroundBlocker(form, selected, selectedServiceRoute, accessByProvider, readinessByProvider);
  const selectedProvider = form.mode === "model" ? selected?.provider : selectedServiceRoute?.provider;
  const selectedAccess = selectedProvider ? accessByProvider.get(selectedProvider) : undefined;
  const selectedReadiness = selectedProvider ? readinessByProvider[selectedProvider] : undefined;
  const methods = selectedServiceRoute?.methods.length ? selectedServiceRoute.methods : ["POST"];
  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId);
  const currentRequest = playgroundRequestPreview(form, requestMode, selectedServiceRoute);

  useEffect(() => {
    const element = transcript.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: turns.length > 1 ? "smooth" : "auto" });
  }, [busy, turns.length]);

  const providerIds = Array.from(new Set([
    ...models.map((model) => model.provider),
    ...serviceRoutes.map((route) => route.provider),
  ])).sort((left, right) => providerName(left, readinessByProvider).localeCompare(providerName(right, readinessByProvider)));
  const activeProvider = selectedProvider ?? providerIds[0] ?? "";
  const providerModels = models.filter((model) => model.provider === activeProvider);
  const providerRoutes = serviceRoutes.filter((route) => route.provider === activeProvider);
  const serviceModelTargets = providerModels.length ? [] : serviceModelOptions(providerRoutes);
  const routeTargets = providerModels.length || serviceModelTargets.length ? [] : providerRoutes;
  const selectedServiceModel = serviceModelFromForm(form, selectedServiceRoute);
  const targetValue = form.mode === "model"
    ? `model:${form.model}`
    : serviceModelTargets.find((target) => routeKey(target.route) === form.serviceRoute && target.model === selectedServiceModel)?.value
      ?? `service:${form.serviceRoute}`;

  function selectProvider(provider: string) {
    const model = models.find((item) => item.provider === provider);
    if (model) {
      setForm({ ...form, mode: "model", model: model.id, endpoint: preferredPlaygroundEndpoint(model) });
      return;
    }
    const routes = serviceRoutes.filter((item) => item.provider === provider);
    const target = serviceModelOptions(routes)[0];
    setForm({ ...form, mode: "service", ...playgroundServicePreset(target?.route ?? routes[0], target?.model) });
  }

  function selectTarget(value: string) {
    if (value.startsWith("model:")) {
      const model = models.find((item) => item.id === value.slice(6));
      setForm({ ...form, mode: "model", model: value.slice(6), ...(model ? { endpoint: preferredPlaygroundEndpoint(model) } : {}) });
      return;
    }
    const modelTarget = serviceModelTargets.find((target) => target.value === value);
    if (modelTarget) {
      setForm({ ...form, mode: "service", ...playgroundServicePreset(modelTarget.route, modelTarget.model) });
      return;
    }
    const route = serviceRoutes.find((item) => routeKey(item) === value.slice(8));
    setForm({ ...form, mode: "service", ...playgroundServicePreset(route) });
  }
  return (
    <form className="playgroundLayout chatPlayground" onSubmit={onRun}>
      <section className="chatWorkspace">
        <header className="chatHeader">
          <div>
            <span className="conversationKicker"><MessageSquare aria-hidden="true" /> Live conversation</span>
            <strong>{form.mode === "model" ? selected?.id ?? "Select a model" : `${selectedServiceRoute?.provider ?? "service"} / ${selectedServiceRoute?.endpoint ?? "route"}`}</strong>
          </div>
          <button type="button" className="buttonSecondary" onClick={onNewConversation}><Plus className="buttonIcon" aria-hidden="true" /> New chat</button>
        </header>

        <div className="chatTranscript" ref={transcript} aria-live="polite">
          {!turns.length ? (
            <div className="chatEmpty">
              <span><Bot aria-hidden="true" /></span>
              <h2>Test the route as a conversation.</h2>
              <p>Choose any granted model or service, send a message, then click a response to inspect the exact gateway exchange.</p>
              <div className="promptSuggestions">
                {["Explain this service in two sentences.", "Return a concise JSON example.", "What can you help me test?"].map((prompt) => (
                  <button key={prompt} type="button" onClick={() => setForm({ ...form, mode: "model", prompt })}>{prompt}</button>
                ))}
              </div>
            </div>
          ) : turns.map((turn) => (
            <article key={turn.id} className={`chatExchange ${selectedTurnId === turn.id ? "selected" : ""}`}>
              <button type="button" className="chatMessage chatMessageUser" onClick={() => setSelectedTurnId(turn.id)} aria-label="Inspect user message">
                <span className="messageRole">You</span>
                <span className="messageBody">{turn.prompt}</span>
              </button>
              <button type="button" className={`chatMessage chatMessageAssistant ${turn.error ? "errored" : ""}`} onClick={() => setSelectedTurnId(turn.id)} aria-label="Inspect assistant response">
                <span className="assistantMark"><Bot aria-hidden="true" /></span>
                <span className="messageContent">
                  <span className="messageRole">{turn.error ? "Gateway error" : turn.provider}</span>
                  <span className="messageBody">{turn.response}</span>
                  <span className="messageMeta">{turn.status ?? "failed"} · {turn.durationMs} ms · click to inspect</span>
                </span>
              </button>
            </article>
          ))}
          {busy ? <div className="chatThinking"><span /><span /><span /><em>Gateway is responding</em></div> : null}
        </div>

        <div className="composerDock">
          {error && !turns.length ? <InlineError message={error} /> : null}
          {blocker ? <InlineNote>{blocker}</InlineNote> : null}
          <div className="composerShell">
            <textarea
              aria-label={form.mode === "model" ? "Message" : "JSON request body"}
              value={form.mode === "model" ? form.prompt : form.servicePayload}
              onChange={(event) => setForm(form.mode === "model" ? { ...form, prompt: event.target.value } : { ...form, servicePayload: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={form.mode === "model" ? "Message the model…" : "Enter the service JSON body…"}
              rows={2}
            />
            <div className="composerControls">
              <select className="providerPicker" aria-label="Provider" value={activeProvider} onChange={(event) => selectProvider(event.target.value)}>
                {providerIds.map((provider) => <option key={provider} value={provider}>{providerName(provider, readinessByProvider)}</option>)}
              </select>
              <select className="modelPicker" aria-label="Model or route" value={targetValue} onChange={(event) => selectTarget(event.target.value)}>
                {providerModels.map((model) => <option key={model.id} value={`model:${model.id}`}>{shortModelName(model.id, activeProvider)}</option>)}
                {serviceModelTargets.map((target) => <option key={target.value} value={target.value}>{shortModelName(target.model, activeProvider)}</option>)}
                {routeTargets.map((route) => <option key={routeKey(route)} value={`service:${routeKey(route)}`}>{route.endpoint.replaceAll("_", " ")}</option>)}
              </select>
              <span className="composerStatus"><span className={`connectionDot ${selectedReadiness?.executable ? "ready" : ""}`} />{readinessLabel(selectedReadiness)}</span>
              <button type="button" className="composerInspect" onClick={() => setSelectedTurnId(selectedTurnId === "setup" ? "" : "setup")}><SlidersHorizontal aria-hidden="true" /><span>Controls</span></button>
              <button type="submit" className="composerSend" disabled={busy || Boolean(blocker)} title={blocker ?? "Send message"}><ArrowUp aria-hidden="true" /><span className="srOnly">Send</span></button>
            </div>
          </div>
          <p className="composerHint">Enter to send · Shift+Enter for a new line · requests use your active access policy</p>
        </div>
      </section>

      <aside className="playgroundInspector">
        {selectedTurn ? (
          <>
            <div className="inspectorTopline">
              <PanelTitle icon={Bug} title="Turn inspector" meta={`${selectedTurn.status ?? "failed"} · ${selectedTurn.durationMs} ms`} />
              <button type="button" className="iconButton" onClick={() => setSelectedTurnId("")} aria-label="Close turn inspector">×</button>
            </div>
            <dl className="facts chatFacts">
              <dt>provider</dt><dd>{selectedTurn.provider}</dd>
              <dt>model / route</dt><dd>{selectedTurn.model}</dd>
              <dt>endpoint</dt><dd>{selectedTurn.endpoint}</dd>
              <dt>retention</dt><dd>{selectedTurn.retention}</dd>
            </dl>
            <div className="inspectorTabs segmented">
              <button type="button" className={requestMode === "json" ? "active" : ""} onClick={() => setRequestMode("json")}>Request</button>
              <button type="button" className={requestMode === "curl" ? "active" : ""} onClick={() => setRequestMode("curl")}>Response</button>
            </div>
            <pre className="debugPayload">{requestMode === "json" ? selectedTurn.request : selectedTurn.rawResponse}</pre>
          </>
        ) : (
          <>
            <PanelTitle icon={SlidersHorizontal} title="Conversation controls" meta={form.mode === "model" ? "model invocation" : "service proxy"} />
            <div className="playgroundToolbar">
              {form.mode === "model" ? (
                <>
                  <label><span>Endpoint</span><select value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value as PlaygroundForm["endpoint"] })}>{selected?.capabilities.includes("llm.chat") ? <option value="/v1/chat/completions">chat completions</option> : null}{selected?.capabilities.includes("llm.responses") ? <option value="/v1/responses">responses</option> : null}</select></label>
                  <label><span>System instructions</span><textarea className="systemPrompt" value={form.system} onChange={(event) => setForm({ ...form, system: event.target.value })} /></label>
                  <div className="playgroundSettingPair">
                    <label><span>Max tokens</span><input inputMode="numeric" value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: event.target.value })} /></label>
                    <label><span>Temperature</span><input inputMode="decimal" value={playgroundSupportsTemperature(form.model) ? form.temperature : ""} disabled={!playgroundSupportsTemperature(form.model)} placeholder={playgroundSupportsTemperature(form.model) ? undefined : "not supported"} onChange={(event) => setForm({ ...form, temperature: event.target.value })} /></label>
                  </div>
                </>
              ) : (
                <>
                  <label><span>Method</span><select value={form.serviceMethod} onChange={(event) => setForm({ ...form, serviceMethod: event.target.value })}>{methods.map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
                  {selectedServiceRoute?.pathParams?.length ? <label><span>{selectedServiceRoute.pathParams.join(" / ")}</span><input value={form.servicePath} onChange={(event) => setForm({ ...form, servicePath: event.target.value })} placeholder="route path value" /></label> : null}
                </>
              )}
            </div>
            <dl className="facts chatFacts">
              <dt>provider</dt><dd>{selectedProvider ?? "none"}</dd>
              <dt>readiness</dt><dd>{readinessLabel(selectedReadiness)}</dd>
              <dt>access</dt><dd>{selectedAccess ? (selectedAccess.allowed ? selectedAccess.policies.join(", ") || "session" : "not granted") : "unknown"}</dd>
              <dt>endpoint</dt><dd>{playgroundAccessEndpoint(form, selectedServiceRoute)}</dd>
            </dl>
            <details className="requestDrawer">
              <summary><span><ServerCog className="buttonIcon" aria-hidden="true" /> Preview request</span></summary>
              <pre>{currentRequest}</pre>
            </details>
          </>
        )}
      </aside>
    </form>
  );
}
import React, { type FormEvent, useEffect, useRef } from "react";
import { ArrowUp, Bot, Bug, CheckCircle2, MessageSquare, Plus, ServerCog, SlidersHorizontal } from "lucide-react";
import { playgroundAccessEndpoint, playgroundBlocker, playgroundPayload, playgroundServicePreset, playgroundSupportsTemperature, preferredPlaygroundEndpoint, readinessLabel, routeKey } from "../domain";
import { BrandMark, InlineError, InlineNote, PanelTitle, Status } from "../components";
import { type CatalogModel, formatDuration, playgroundRequestPreview, providerBrandIcon, providerName, serviceModelFromForm, serviceModelOptions, shortModelName } from "../ui-helpers";
import type { AccessForm,AccessPolicy,AccessRole,AccessTab,AccessUser,AdminOverview,AdminTenantSummary,AdminUsageRow,AssignmentRule,AssignmentRuleForm,BindingForm,BrandIcon,BudgetStatus,ContentRetention,CredentialForm,EntitlementsResponse,IconComponent,OutcomeTone,PlaygroundForm,PlaygroundHttpResponse,PlaygroundTurn,PolicyBinding,PolicyForm,ProviderAccess,ProviderConnection,ProviderReadiness,ProviderResponse,ProviderRow,ProviderUsageSummary,ProxyCredential,RefreshOptions,RetainedRequestContent,RouteCatalog,ServiceItem,ServiceOutcome,SessionResponse,UpstreamGrant,UpstreamGrantForm,UsageAuditEvent,UsageSnapshot,UsageSummary,View } from "../ui-types";
