import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  playgroundAccessEndpoint,
  playgroundBlocker,
  playgroundPayload,
  playgroundResponseText,
  playgroundServicePreset,
  routeKey,
  errorMessage,
} from "../domain";
import { demo, demoServicePreset } from "../ui-config";
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

export function usePlayground({ gatewayOrigin, demoMode, setStatus, models, serviceRoutes, accessByProvider, providerReadiness }: PlaygroundDependencies) {
  const initializedModelsRef = useRef(false);
  const [form, setForm] = useState<PlaygroundForm>({
    mode: "model",
    model: catalogModels(demo.routes)[0]?.id ?? "",
    endpoint: "/v1/chat/completions",
    ...demoServicePreset,
    system: "You are concise and useful.",
    prompt: "Say hello from ClawRouter in one short sentence.",
    maxTokens: "128",
    temperature: "0.7",
  });
  const [turns, setTurns] = useState<PlaygroundTurn[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState("");
  const [requestMode, setRequestMode] = useState<"json" | "curl">("json");
  const [error, setError] = useState("");
  const selectedModel = models.find((model) => model.id === form.model) ?? models[0];
  const selectedServiceRoute = serviceRoutes.find((route) => routeKey(route) === form.serviceRoute) ?? serviceRoutes[0];

  useEffect(() => {
    if (!models.length) return;
    if (!initializedModelsRef.current || !models.some((model) => model.id === form.model)) {
      initializedModelsRef.current = true;
      const usable = models.filter((model) => accessByProvider.get(model.provider)?.allowed && providerReadiness[model.provider]?.executable);
      const preferred = usable.find((model) => model.provider === "openai") ?? usable[0] ?? models[0];
      setForm((current) => ({ ...current, model: preferred.id }));
    }
  }, [accessByProvider, form.model, models, providerReadiness]);

  useEffect(() => {
    if (serviceRoutes.length && !serviceRoutes.some((route) => routeKey(route) === form.serviceRoute)) {
      setForm((current) => ({ ...current, ...playgroundServicePreset(serviceRoutes[0]) }));
    }
  }, [form.serviceRoute, serviceRoutes]);

  async function run(event: FormEvent) {
    event.preventDefault();
    const startedAt = performance.now();
    const prompt = form.mode === "model" ? form.prompt.trim() : form.servicePayload.trim();
    const conversation = form.mode === "model"
      ? turns.filter((turn) => turn.mode === "model" && !turn.error).flatMap((turn) => [
        { role: "user" as const, content: turn.prompt },
        { role: "assistant" as const, content: turn.response },
      ])
      : [];
    const provider = form.mode === "model" ? selectedModel?.provider ?? "unknown" : selectedServiceRoute?.provider ?? "unknown";
    const model = form.mode === "model" ? selectedModel?.id ?? form.model : selectedServiceRoute?.endpoint ?? form.serviceRoute;
    const endpoint = playgroundAccessEndpoint(form, selectedServiceRoute);
    let requestPreview = "";
    try {
      if (!prompt) throw new Error(form.mode === "model" ? "Enter a message." : "Enter a JSON request body.");
      setError("");
      setStatus("running playground");
      const guard = playgroundBlocker(form, selectedModel, selectedServiceRoute, accessByProvider, providerReadiness);
      if (guard) throw new Error(guard);
      const payload = playgroundPayload(form, selectedServiceRoute, conversation);
      requestPreview = JSON.stringify(payload, null, 2);
      if (demoMode) {
        const raw = JSON.stringify(form.mode === "model"
          ? { provider: selectedModel?.provider, model: selectedModel?.id, output: "Hello from ClawRouter demo mode." }
          : { provider: selectedServiceRoute?.provider, route: selectedServiceRoute?.route, output: "Service proxy demo response." }, null, 2);
        appendTurn({ prompt, raw, requestPreview, provider, model, endpoint, status: 200, startedAt, retention: "demo" });
        if (form.mode === "model") setForm((current) => ({ ...current, prompt: "" }));
        setStatus("playground ready");
        return;
      }
      const result = await playgroundRequest(gatewayOrigin, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const responseError = result.ok ? undefined : playgroundResponseText(result.raw) || `Request failed with HTTP ${result.status}`;
      appendTurn({ prompt, raw: result.raw, requestPreview, provider, model, endpoint, status: result.status, startedAt, retention: result.retention, error: responseError });
      if (responseError) {
        setError(responseError);
        setStatus(responseError);
        return;
      }
      if (form.mode === "model") setForm((current) => ({ ...current, prompt: "" }));
      setStatus("playground ready");
    } catch (caught) {
      const message = errorMessage(caught);
      if (prompt) appendTurn({ prompt, raw: message, requestPreview, provider, model, endpoint, status: null, startedAt, retention: "unknown", error: message });
      setError(message);
      setStatus(message);
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
    setSelectedTurnId(turn.id);
  }

  function resetConversation() {
    setTurns([]);
    setSelectedTurnId("");
    setError("");
    setForm((current) => ({ ...current, prompt: "" }));
  }

  return {
    form,
    setForm,
    turns,
    setTurns,
    selectedTurnId,
    setSelectedTurnId,
    requestMode,
    setRequestMode,
    error,
    setError,
    selectedModel,
    selectedServiceRoute,
    run,
    resetConversation,
  };
}
