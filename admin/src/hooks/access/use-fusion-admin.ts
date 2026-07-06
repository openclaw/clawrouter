import { type FormEvent, type SetStateAction, useRef, useState } from "react";
import { errorMessage } from "../../domain";
import { defaultFusion, demo } from "../../ui-config";
import { request } from "../../ui-helpers";
import type { AccessPolicy, FusionConfig, FusionReadiness } from "../../ui-types";

interface Dependencies {
  allowDemo: boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  policies: AccessPolicy[];
  selectedPolicyId: string;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
}

export function useFusionAdmin({ allowDemo, gatewayOrigin, demoMode, policies, selectedPolicyId, setStatus, refresh }: Dependencies) {
  const [config, setConfig] = useState<FusionConfig>(allowDemo ? demo.fusion : defaultFusion);
  const [policyId, setPolicyId] = useState(selectedPolicyId);
  const [readiness, setReadiness] = useState<FusionReadiness | null>(null);
  const [error, setError] = useState("");
  const draftGeneration = useRef(0);

  function updateConfig(next: SetStateAction<FusionConfig>) {
    draftGeneration.current += 1;
    setReadiness(null);
    setConfig(next);
  }

  function selectPolicy(next: string) {
    draftGeneration.current += 1;
    setReadiness(null);
    setPolicyId(next);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      setError("");
      setStatus("saving fusion model");
      const next = { ...config, adviserModels: cleanModels(config.adviserModels) };
      const preview = await checkConfig(next, policyId);
      if (next.enabled && !preview.executable) throw new Error("selected policy cannot execute the Fusion synthesizer");
      if (demoMode) setConfig(next);
      else {
        const saved = await request<FusionConfig>(gatewayOrigin, "/v1/admin/fusion", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        setConfig(saved);
        await refresh();
      }
      setStatus("saved fusion model");
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(message);
    }
  }

  async function check() {
    try {
      setError("");
      setStatus("checking fusion readiness");
      await checkConfig({ ...config, adviserModels: cleanModels(config.adviserModels) }, policyId);
      setStatus("checked fusion readiness");
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(message);
    }
  }

  async function checkConfig(next: FusionConfig, policyId: string) {
    if (!policyId) throw new Error("select a policy to check Fusion readiness");
    const generation = ++draftGeneration.current;
    const value = demoMode
      ? demoReadiness(next, policies.find((policy) => policy.policyId === policyId))
      : await request<FusionReadiness>(gatewayOrigin, "/v1/admin/fusion/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policyId, config: next }),
      });
    if (generation !== draftGeneration.current) throw new Error("Fusion draft changed while readiness was being checked; check again");
    setReadiness(value);
    return value;
  }

  return {
    fusion: { config, setConfig: updateConfig, policyId, setPolicyId: selectPolicy, readiness, error, save, check },
    hydrate: (next: FusionConfig, background: boolean, nextPolicyId?: string, availablePolicyIds: string[] = []) => {
      if (background) return;
      draftGeneration.current += 1;
      setConfig(next);
      setPolicyId((current) => availablePolicyIds.includes(current) ? current : nextPolicyId ?? availablePolicyIds[0] ?? "");
      setReadiness(null);
    },
  };
}

function demoReadiness(config: FusionConfig, policy?: AccessPolicy): FusionReadiness {
  if (!policy) throw new Error("select a policy to check Fusion readiness");
  const models = [...config.adviserModels, config.aggregatorModel];
  const calls = models.map((model, index) => {
    const provider = model.startsWith("local/") ? "local-openai" : model.split("/")[0] ?? "unknown";
    const policyAllowed = policy.enabled && (!policy.providers.length || policy.providers.includes(provider));
    return {
      stage: index === models.length - 1 ? "synthesizer" as const : "adviser" as const,
      index: index === models.length - 1 ? null : index + 1,
      model,
      provider,
      policyAllowed,
      executable: policyAllowed,
      verified: policyAllowed,
      status: policyAllowed ? "verified" : "blocked",
      reasons: policyAllowed ? [] : [`Policy does not allow ${provider}.`],
      estimatedReservationMicros: policy.requestCostMicros ?? 1,
      estimateBasis: policy.requestCostMicros != null ? "policy_fixed" as const : "flat_fallback" as const,
    };
  });
  const executable = calls.at(-1)?.executable === true;
  return {
    policyId: policy.policyId,
    policyEnabled: policy.enabled,
    configEnabled: config.enabled,
    executable,
    advertisable: config.enabled && executable,
    readyAdviserCount: calls.filter((call) => call.stage === "adviser" && call.executable).length,
    adviserCount: config.adviserModels.length,
    callCount: calls.length,
    estimatedReservationMicros: calls.reduce((sum, call) => sum + call.estimatedReservationMicros, 0),
    budgetConfigured: policy.monthlyBudgetMicros != null,
    budgetLedger: policy.monthlyBudgetMicros != null ? "demo" : "unmetered",
    remainingBudgetMicros: policy.monthlyBudgetMicros ?? null,
    budgetSufficientForAll: policy.monthlyBudgetMicros == null ? null : calls.reduce((sum, call) => sum + call.estimatedReservationMicros, 0) <= policy.monthlyBudgetMicros,
    estimateNote: policy.requestCostMicros != null ? "Exact configured price for currently eligible calls; fail-open adviser reservations may be lower." : "Demo estimate; live request preflight remains authoritative.",
    calls,
  };
}

function cleanModels(models: string[]) {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean))).slice(0, 4);
}
