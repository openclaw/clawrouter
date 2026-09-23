import { type FormEvent, useEffect, useRef } from "react";
import { ArrowUp, Bot, Bug, MessageSquare, Plus, ServerCog, SlidersHorizontal } from "lucide-react";
import { InlineError, InlineNote, PanelTitle } from "../components";
import { OfferPicker } from "../offer-picker";
import type { CatalogTarget } from "../catalog-offers";
import type { PlaygroundForm, PlaygroundTurn } from "../ui-types";

export function PlaygroundScreen({ form, setForm, targets, selection, selected, onSelect, blocker, advisory, catalogNotice, requestPreview, requestMode, setRequestMode, turns, selectedTurnId, setSelectedTurnId, error, onRun, onNewConversation, busy }: {
  form: PlaygroundForm;
  setForm: (form: PlaygroundForm) => void;
  targets: CatalogTarget[];
  selection: CatalogTarget | null;
  selected: CatalogTarget | null;
  onSelect: (target: CatalogTarget | null) => void;
  blocker: string | null;
  advisory: string;
  catalogNotice: string;
  requestPreview: string;
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
  const methods = selected?.descriptor?.methods ?? ["POST"];
  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId);
  useEffect(() => {
    const element = transcript.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: turns.length > 1 ? "smooth" : "auto" });
  }, [busy, turns.length]);

  return (
    <form className="playgroundLayout chatPlayground" onSubmit={onRun}>
      <section className="chatWorkspace">
        <header className="chatHeader">
          <div>
            <span className="conversationKicker"><MessageSquare aria-hidden="true" /> Live conversation</span>
            <strong>{selection ? `${selection.providerName} / ${selection.offer.modelId ?? selection.offer.endpoint}${selected ? "" : " · unavailable"}` : "Choose a provider and operation"}</strong>
          </div>
          <button type="button" className="buttonSecondary" onClick={onNewConversation}><Plus className="buttonIcon" aria-hidden="true" /> New chat</button>
        </header>

        <div className="chatTranscript" ref={transcript} aria-live="polite">
          {!turns.length ? (
            <div className="chatEmpty">
              <span><Bot aria-hidden="true" /></span>
              <h2>Test the route as a conversation.</h2>
              <p>Choose any granted model or service, send a message, then click a response to inspect the exact gateway exchange.</p>
              {form.mode === "model" ? <div className="promptSuggestions">
                {["Explain this service in two sentences.", "Return a concise JSON example.", "What can you help me test?"].map((prompt) => (
                  <button key={prompt} type="button" onClick={() => setForm({ ...form, prompt })}>{prompt}</button>
                ))}
              </div> : null}
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
          {catalogNotice ? <InlineNote>{catalogNotice}</InlineNote> : null}
          {advisory ? <InlineNote>{advisory}</InlineNote> : null}
          {blocker ? <InlineNote>{blocker}</InlineNote> : null}
          <div className="composerShell">
            <textarea
              aria-label={form.mode === "model" ? "Message" : "JSON request body"}
              value={form.mode === "model" ? form.prompt : form.servicePayload}
              onChange={(event) => setForm(form.mode === "model" ? { ...form, prompt: event.target.value } : { ...form, servicePayload: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (busy || blocker) return;
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={form.mode === "model" ? "Message the model…" : "Enter the service JSON body…"}
              rows={2}
            />
            <div className="composerControls">
              <OfferPicker targets={targets} selected={selection} onSelect={onSelect} />
              <span className="composerStatus"><span className={`connectionDot ${selected && !blocker ? "ready" : ""}`} />{selected && !blocker ? "available" : "unavailable"}</span>
              <button type="button" className="composerInspect" aria-label="Conversation controls" onClick={() => setSelectedTurnId(selectedTurnId === "setup" ? "" : "setup")}><SlidersHorizontal aria-hidden="true" /><span>Controls</span></button>
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
                  <label><span>System instructions</span><textarea className="systemPrompt" value={form.system} onChange={(event) => setForm({ ...form, system: event.target.value })} /></label>
                  <div className="playgroundSettingPair">
                    <label><span>Max tokens</span><input inputMode="numeric" value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: event.target.value })} /></label>
                    <label><span>Temperature</span><input inputMode="decimal" value={form.temperature} placeholder="omit when blank" onChange={(event) => setForm({ ...form, temperature: event.target.value })} /></label>
                  </div>
                </>
              ) : selection?.offer.routeKind === "playground" ? (
                <>
                  <label><span>Method</span><select value={form.serviceMethod} onChange={(event) => setForm({ ...form, serviceMethod: event.target.value })}>{methods.map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
                  {selected?.descriptor?.pathParams?.length ? <label><span>{selected.descriptor!.pathParams!.join(" / ")}</span><input value={form.servicePath} onChange={(event) => setForm({ ...form, servicePath: event.target.value })} placeholder="route path value" /></label> : null}
                </>
              ) : null}
            </div>
            <dl className="facts chatFacts">
              <dt>provider</dt><dd>{selection?.provider ?? "none"}</dd>
              <dt>availability</dt><dd>{selected ? selected.offer.affordability : "unknown"}</dd>
              <dt>policy</dt><dd>{selection?.offer.policyId ?? "none"}</dd>
              <dt>policy generation</dt><dd>{selection?.offer.policyGeneration ?? "none"}</dd>
              <dt>catalog observed</dt><dd>{(selected ?? selection)?.observedAt ?? "unknown"}</dd>
              <dt>endpoint</dt><dd>{selection?.offer.route ?? "Choose an operation"}</dd>
            </dl>
            <details className="requestDrawer">
              <summary><span><ServerCog className="buttonIcon" aria-hidden="true" /> Preview request</span></summary>
              <pre>{requestPreview}</pre>
            </details>
          </>
        )}
      </aside>
    </form>
  );
}
