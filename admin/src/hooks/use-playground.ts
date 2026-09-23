import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  playgroundResponseText,
  errorMessage,
} from "../domain";
import { demoServicePreset } from "../ui-config";
import { createPlaygroundTurn, playgroundRequest } from "../ui-helpers";
import { targetBlocker, targetForm, targetRequest, type CatalogTarget } from "../catalog-offers";
import type { PlaygroundForm, PlaygroundTurn } from "../ui-types";

interface PlaygroundDependencies {
  gatewayOrigin: string;
  demoMode: boolean;
  setStatus: (status: string) => void;
  targets: CatalogTarget[];
  resolveTarget: (selected: CatalogTarget | null) => CatalogTarget | null;
}

export function usePlayground({ gatewayOrigin, demoMode, setStatus, targets, resolveTarget }: PlaygroundDependencies) {
  const [selection, setSelection] = useState<CatalogTarget | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [form, setForm] = useState<PlaygroundForm>({
    mode: "model",
    model: "",
    endpoint: "/v1/chat/completions",
    ...demoServicePreset,
    system: "You are concise and useful.",
    prompt: "Say hello from ClawRouter in one short sentence.",
    maxTokens: "128",
    temperature: "",
  });
  const [turns, setTurns] = useState<PlaygroundTurn[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState("");
  const [requestMode, setRequestMode] = useState<"json" | "curl">("json");
  const [error, setError] = useState("");
  const selected = resolveTarget(selection);
  const conversation = form.mode === "model"
    ? turns.filter((turn) => turn.mode === "model" && !turn.error).flatMap((turn) => [
      { role: "user" as const, content: turn.prompt },
      { role: "assistant" as const, content: turn.response },
    ])
    : [];
  let blocker = targetBlocker(targets, selection);
  let advisory = selected?.offer.affordability === "request-dependent" ? "Availability depends on the final request and budget reservation." : "";
  let requestPreview = "Choose an operation to preview its request.";
  if (selected && !blocker) {
    try {
      const { payload, assessment } = targetRequest(selected, form, conversation);
      blocker = assessment.conflicts.map((issue) => issue.message).join(" ") || null;
      advisory = [advisory, ...assessment.unknown.map((issue) => issue.message)].filter(Boolean).join(" ");
      requestPreview = JSON.stringify(payload, null, 2);
    } catch (caught) { blocker = errorMessage(caught); requestPreview = blocker; }
  }

  function selectTarget(target: CatalogTarget | null) {
    setSelection(target);
    if (target) setForm((current) => targetForm(current, target));
    setError("");
  }

  useEffect(() => () => {
    const operation = operationRef.current;
    operationRef.current = null;
    operation?.abort();
  }, []);

  async function run(event: FormEvent) {
    event.preventDefault();
    if (operationRef.current) return;
    const operation = new AbortController();
    operationRef.current = operation;
    setRunning(true);
    const startedAt = performance.now();
    const prompt = form.mode === "model" ? form.prompt.trim() : form.servicePayload.trim();
    const current = resolveTarget(selection);
    const provider = selection?.provider ?? "unknown";
    const model = selection?.offer.modelId ?? selection?.offer.endpoint ?? "unknown";
    const endpoint = selection?.offer.route ?? "";
    let requestPreview = "";
    try {
      if (!prompt) throw new Error(form.mode === "model" ? "Enter a message." : "Enter a JSON request body.");
      setError("");
      setStatus("running playground");
      const guard = targetBlocker(targets, selection);
      if (guard || !current) throw new Error(guard ?? "Selected operation unavailable.");
      const { payload, assessment } = targetRequest(current, form, conversation);
      if (assessment.conflicts.length) throw new Error(assessment.conflicts.map((issue) => issue.message).join(" "));
      requestPreview = JSON.stringify(payload, null, 2);
      // Clear the submitted draft now; a later reply must not erase newly typed text.
      if (form.mode === "model") setForm((current) => ({ ...current, prompt: "" }));
      if (demoMode) {
        const raw = JSON.stringify(form.mode === "model"
          ? { provider, model, output: "Hello from ClawRouter demo mode." }
          : { provider, route: endpoint, output: "Service proxy demo response." }, null, 2);
        appendTurn({ prompt, raw, requestPreview, provider, model, endpoint, status: 200, startedAt, retention: "demo" });
        setStatus("playground ready");
        return;
      }
      const result = await playgroundRequest(gatewayOrigin, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: operation.signal,
      });
      if (operationRef.current !== operation) return;
      const responseError = result.ok ? undefined : playgroundResponseText(result.raw) || `Request failed with HTTP ${result.status}`;
      appendTurn({ prompt, raw: result.raw, requestPreview, provider, model, endpoint, status: result.status, startedAt, retention: result.retention, error: responseError });
      if (responseError) {
        setError(responseError);
        setStatus(responseError);
        return;
      }
      setStatus("playground ready");
    } catch (caught) {
      if (operationRef.current !== operation) return;
      const message = errorMessage(caught);
      if (prompt) appendTurn({ prompt, raw: message, requestPreview, provider, model, endpoint, status: null, startedAt, retention: "unknown", error: message });
      setError(message);
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
    setSelectedTurnId(turn.id);
  }

  function resetConversation() {
    const operation = operationRef.current;
    // Invalidate before aborting: an old completion must not own the new chat.
    operationRef.current = null;
    operation?.abort();
    setRunning(false);
    if (operation) setStatus("playground ready");
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
    selection, selectTarget, selected, blocker, advisory, requestPreview,
    running,
    run,
    resetConversation,
  };
}
