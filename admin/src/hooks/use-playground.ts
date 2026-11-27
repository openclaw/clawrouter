import { type FormEvent, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import {
  playgroundAccessEndpoint,
  playgroundBlocker,
  playgroundResponseText,
  playgroundServicePreset,
  playgroundSupportsTemperature,
  optionalNumber,
  routeKey,
  errorMessage,
} from "../domain";
import { demo, demoServicePreset } from "../ui-config";
import { playgroundDraftPayload } from "../playground-draft";
import { catalogModels, createPlaygroundTurn, playgroundRequest } from "../ui-helpers";
import type { CatalogModel } from "../domain";
import type { PlaygroundForm, PlaygroundTurn, ProviderAccess, ProviderReadiness, RouteCatalog } from "../ui-types";

interface PlaygroundDependencies {
  gatewayOrigin: string;
  demoMode: boolean;
  setStatus: (status: string) => void;
  models: CatalogModel[];
  serviceRoutes: RouteCatalog["manifestProxy"];
  accessByProvider: Map<string, ProviderAccess>;
  providerReadiness: Record<string, ProviderReadiness>;
}

export interface PlaygroundDraftError {
  field: "composer" | "maxTokens" | "temperature";
  message: string;
}

function keepDraftError(error: PlaygroundDraftError | null, previous: PlaygroundForm, next: PlaygroundForm) {
  if (!error || next.mode !== previous.mode) return null;
  if (error.field === "temperature" && !playgroundSupportsTemperature(next.model)) return null;
  const field = error.field === "composer" ? (next.mode === "model" ? "prompt" : "servicePayload") : error.field;
  return previous[field] === next[field] ? error : null;
}

function payloadError(form: PlaygroundForm, cause: unknown): PlaygroundDraftError {
  if (form.mode === "service") {
    // Keep the parser's location when available, not engine-specific text that may echo the body.
    if (!(cause instanceof SyntaxError)) return { field: "composer", message: "Not sent. Simplify the JSON body and try again." };
    const location = /[(]line ([0-9]+) column ([0-9]+)[)]$/.exec(cause.message);
    return { field: "composer", message: location
      ? `Not sent. Check the JSON syntax at line ${location[1]}, column ${location[2]}.`
      : "Not sent. Enter valid JSON in the request body." };
  }
  // Use the same parser as playgroundPayload to distinguish the two numeric settings.
  try { optionalNumber(form.maxTokens); } catch {
    return { field: "maxTokens", message: "Not sent. Enter a non-negative whole number for Max tokens, such as 128." };
  }
  return { field: "temperature", message: "Not sent. Enter a number for Temperature." };
}

export function usePlayground({ gatewayOrigin, demoMode, setStatus, models, serviceRoutes, accessByProvider, providerReadiness }: PlaygroundDependencies) {
  const initializedModelsRef = useRef(false);
  const operationRef = useRef<{ controller: AbortController; followResult: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [{ form, error }, setDraft] = useState<{ form: PlaygroundForm; error: PlaygroundDraftError | null }>(() => ({
    form: {
      mode: "model",
      model: catalogModels(demo.routes)[0]?.id ?? "",
      endpoint: "/v1/chat/completions",
      ...demoServicePreset,
      system: "You are concise and useful.",
      prompt: "Say hello from ClawRouter in one short sentence.",
      maxTokens: "128",
      temperature: "0.7",
    },
    error: null,
  }));
  const setForm = useCallback((update: SetStateAction<PlaygroundForm>) => {
    setDraft((current) => {
      const next = typeof update === "function" ? update(current.form) : update;
      return { form: next, error: keepDraftError(current.error, current.form, next) };
    });
  }, []);
  function setError(error: PlaygroundDraftError | null) {
    setDraft((current) => ({ ...current, error }));
  }
  const [turns, setTurns] = useState<PlaygroundTurn[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState("");
  const [requestMode, setRequestMode] = useState<"json" | "curl">("json");
  const selectedModel = models.find((model) => model.id === form.model) ?? models[0];
  const selectedServiceRoute = serviceRoutes.find((route) => routeKey(route) === form.serviceRoute) ?? serviceRoutes[0];

  useEffect(() => () => {
    const operation = operationRef.current;
    operationRef.current = null;
    operation?.controller.abort();
  }, []);

  useEffect(() => {
    if (!models.length) return;
    if (!initializedModelsRef.current || !models.some((model) => model.id === form.model)) {
      initializedModelsRef.current = true;
      const usable = models.filter((model) => accessByProvider.get(model.provider)?.allowed && providerReadiness[model.provider]?.executable);
      const preferred = usable.find((model) => model.provider === "openai") ?? usable[0] ?? models[0];
      setForm((current) => ({ ...current, model: preferred.id }));
    }
  }, [accessByProvider, form.model, models, providerReadiness, setForm]);

  useEffect(() => {
    if (serviceRoutes.length && !serviceRoutes.some((route) => routeKey(route) === form.serviceRoute)) {
      setForm((current) => ({ ...current, ...playgroundServicePreset(serviceRoutes[0]) }));
    }
  }, [form.serviceRoute, serviceRoutes, setForm]);

  async function run(event: FormEvent) {
    event.preventDefault();
    if (operationRef.current) return;
    // The composer already shows the current access/readiness blocker.
    if (playgroundBlocker(form, selectedModel, selectedServiceRoute, accessByProvider, providerReadiness)) return;
    const prompt = form.mode === "model" ? form.prompt.trim() : form.servicePayload.trim();
    if (!prompt) {
      setError({ field: "composer", message: form.mode === "model" ? "Not sent. Enter a message." : "Not sent. Enter a JSON request body." });
      return;
    }
    const provider = form.mode === "model" ? selectedModel?.provider ?? "unknown" : selectedServiceRoute?.provider ?? "unknown";
    const model = form.mode === "model" ? selectedModel?.id ?? form.model : selectedServiceRoute?.endpoint ?? form.serviceRoute;
    const endpoint = playgroundAccessEndpoint(form, selectedServiceRoute);
    let payload: ReturnType<typeof playgroundDraftPayload>;
    let requestPreview: string;
    try {
      payload = playgroundDraftPayload(form, selectedServiceRoute, turns);
      requestPreview = JSON.stringify(payload, null, 2);
    } catch (cause) {
      const issue = payloadError(form, cause);
      if (issue.field !== "composer") setSelectedTurnId(""); // Reveal the invalid setting.
      setError(issue);
      return;
    }

    const operation = { controller: new AbortController(), followResult: true };
    operationRef.current = operation;
    const startedAt = performance.now();
    setError(null);
    setRunning(true);
    try {
      setStatus("running playground");
      // Clear the submitted draft now; a later reply must not erase newly typed text.
      if (form.mode === "model") setForm((current) => ({ ...current, prompt: "" }));
      if (demoMode) {
        const raw = JSON.stringify(form.mode === "model"
          ? { provider: selectedModel?.provider, model: selectedModel?.id, output: "Hello from ClawRouter demo mode." }
          : { provider: selectedServiceRoute?.provider, route: selectedServiceRoute?.route, output: "Service proxy demo response." }, null, 2);
        appendTurn({ prompt, raw, requestPreview, provider, model, endpoint, status: 200, startedAt, retention: "demo" });
        setStatus("playground ready");
        return;
      }
      const result = await playgroundRequest(gatewayOrigin, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: operation.controller.signal,
      });
      if (operationRef.current !== operation) return;
      const responseError = result.ok ? undefined : playgroundResponseText(result.raw) || `Request failed with HTTP ${result.status}`;
      appendTurn({ prompt, raw: result.raw, requestPreview, provider, model, endpoint, status: result.status, startedAt, retention: result.retention, error: responseError });
      if (responseError) {
        setStatus(responseError);
        return;
      }
      setStatus("playground ready");
    } catch (caught) {
      if (operationRef.current !== operation) return;
      const message = errorMessage(caught);
      appendTurn({ prompt, raw: message, requestPreview, provider, model, endpoint, status: null, startedAt, retention: "unknown", error: message });
      setStatus(message);
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setRunning(false);
      }
    }
  }

  function appendTurn(input: {
    prompt: string;
    raw: string;
    requestPreview: string;
    provider: string;
    model: string;
    endpoint: string;
    status: number | null;
    startedAt: number;
    retention: string;
    error?: string;
  }) {
    const turn = createPlaygroundTurn({
      mode: form.mode,
      prompt: input.prompt,
      raw: input.raw,
      request: input.requestPreview,
      provider: input.provider,
      model: input.model,
      endpoint: input.endpoint,
      status: input.status,
      durationMs: Math.max(1, Math.round(performance.now() - input.startedAt)),
      retention: input.retention,
      error: input.error,
    });
    setTurns((current) => [...current, turn]);
    if (operationRef.current?.followResult) setSelectedTurnId(turn.id);
  }

  // The action matters even when the operator selects the already-active turn or side.
  function holdInspector() {
    if (operationRef.current) operationRef.current.followResult = false;
  }

  function resetConversation() {
    const operation = operationRef.current;
    // Invalidate before aborting: an old completion must not own the new chat.
    operationRef.current = null;
    operation?.controller.abort();
    setRunning(false);
    if (operation) setStatus("playground ready");
    setTurns([]);
    setSelectedTurnId("");
    setError(null);
    setForm((current) => ({ ...current, prompt: "" }));
  }

  return {
    form,
    setForm,
    turns,
    setTurns,
    selectedTurnId,
    setSelectedTurnId: (id: string) => { holdInspector(); setSelectedTurnId(id); },
    requestMode,
    setRequestMode: (mode: typeof requestMode) => { holdInspector(); setRequestMode(mode); },
    error,
    selectedModel,
    selectedServiceRoute,
    running,
    run,
    resetConversation,
  };
}
