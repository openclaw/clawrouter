import type { FusionConfig, FusionReadiness, FusionReadinessCall } from "../shared/contracts";
import { buildAdviserBody, buildAggregatorBody, buildFusionReservationProposals } from "./fusion.ts";
import { estimateModelCost } from "./pricing.ts";
import type { AccessPolicyEntry, CompiledModel } from "./types.ts";

export interface FusionReadinessRoute {
  modelId: string;
  providerId: string;
  providerDisplayName: string;
  endpointId: string;
  model: CompiledModel;
}

export interface FusionProviderReadiness {
  id: string;
  executableEndpoints: string[];
  verified: boolean;
  reasons: string[];
}

export interface FusionBudgetReadiness {
  configured: boolean;
  ledger: string;
  remainingMicros: number | null;
}

export function fusionReadiness(config: FusionConfig, entry: AccessPolicyEntry, readiness: FusionProviderReadiness[], routes: FusionReadinessRoute[], budget: FusionBudgetReadiness): FusionReadiness {
  const routesByModel = new Map(routes.map((route) => [route.modelId, route]));
  // NUL has the maximum JSON escape expansion per UTF-16 code unit.
  const textEnvelope = { messages: [{ role: "user", content: "\0".repeat(config.maxInputChars) }] };
  const calls: FusionReadinessCall[] = config.adviserModels.map((model, index) => readinessCall(
    "adviser",
    index + 1,
    model,
    buildAdviserBody(textEnvelope, model, config, index),
    entry,
    readiness,
    routesByModel.get(model)!,
  ));
  const synthesizerEnvelope = {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:,fusion-readiness" } }] }],
  };
  calls.push(readinessCall(
    "synthesizer",
    null,
    config.aggregatorModel,
    buildAggregatorBody(synthesizerEnvelope, config, buildFusionReservationProposals(config)),
    entry,
    readiness,
    routesByModel.get(config.aggregatorModel)!,
  ));
  const synthesizer = calls.at(-1)!;
  applyBudgetReadiness(calls, synthesizer, budget);
  const estimatedReservationMicros = synthesizer.executable
    ? calls.filter((call) => call.executable).reduce((total, call) => total + call.estimatedReservationMicros, 0)
    : 0;
  const budgetSufficientForAll = budget.remainingMicros == null ? budget.configured ? false : null : estimatedReservationMicros <= budget.remainingMicros;
  if (budgetSufficientForAll === false && synthesizer.executable) {
    for (const call of calls) if (call.stage === "adviser" && call.executable) call.reasons.push("Remaining budget may admit only a subset of fail-open advisers.");
  }
  return {
    policyId: entry.policyId,
    policyEnabled: entry.policy.enabled,
    configEnabled: config.enabled,
    executable: synthesizer.executable,
    advertisable: config.enabled && synthesizer.executable,
    readyAdviserCount: calls.filter((call) => call.stage === "adviser" && call.executable).length,
    adviserCount: config.adviserModels.length,
    callCount: calls.length,
    estimatedReservationMicros,
    budgetConfigured: budget.configured,
    budgetLedger: budget.ledger,
    remainingBudgetMicros: budget.remainingMicros,
    budgetSufficientForAll,
    estimateNote: entry.policy.requestCostMicros != null
      ? "Exact configured price for currently eligible calls; fail-open adviser reservations may be lower."
      : "Advisers use configured bounds; the synthesizer uses manifest maximum input and default output. Live request parameters can reserve more.",
    calls,
  };
}

function applyBudgetReadiness(calls: FusionReadinessCall[], synthesizer: FusionReadinessCall, budget: FusionBudgetReadiness): void {
  if (budget.configured && budget.ledger === "unavailable") block(synthesizer, "Budget ledger is unavailable.");
  if (budget.configured && budget.ledger === "blocked") block(synthesizer, "Policy budget is disabled.");
  if (budget.configured && synthesizer.estimateBasis === "flat_fallback") block(synthesizer, "Budgeted calls require manifest pricing or a fixed policy request price.");
  if (budget.remainingMicros != null && synthesizer.estimatedReservationMicros > budget.remainingMicros) block(synthesizer, "Remaining budget cannot reserve the synthesizer estimate.");
  if (!synthesizer.executable) {
    for (const call of calls) if (call.stage === "adviser" && call.executable) block(call, "Synthesizer preflight prevents adviser fan-out.");
    return;
  }
  const adviserBudget = budget.remainingMicros == null ? null : budget.remainingMicros - synthesizer.estimatedReservationMicros;
  for (const call of calls) {
    if (call.stage !== "adviser" || !call.executable) continue;
    if (budget.configured && call.estimateBasis === "flat_fallback") block(call, "Budgeted calls require manifest pricing or a fixed policy request price.");
    else if (adviserBudget != null && call.estimatedReservationMicros > adviserBudget) block(call, "Remaining budget after the synthesizer cannot reserve this adviser.");
  }
}

function block(call: FusionReadinessCall, reason: string): void {
  call.executable = false;
  call.verified = false;
  call.status = "blocked";
  if (!call.reasons.includes(reason)) call.reasons.push(reason);
}

function readinessCall(stage: FusionReadinessCall["stage"], index: number | null, modelId: string, body: Record<string, unknown>, entry: AccessPolicyEntry, readiness: FusionProviderReadiness[], route: FusionReadinessRoute): FusionReadinessCall {
  const providerReadiness = readiness.find((candidate) => candidate.id === route.providerId);
  const policyAllowed = entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(route.providerId));
  const executable = policyAllowed && providerReadiness?.executableEndpoints.includes(route.endpointId) === true;
  const reasons = [
    ...(!entry.policy.enabled ? ["Policy is disabled."] : []),
    ...(entry.policy.enabled && !policyAllowed ? [`Policy does not allow ${route.providerDisplayName}.`] : []),
    ...(policyAllowed && !executable ? providerReadiness?.reasons.length ? providerReadiness.reasons : ["Chat completions are not executable for this provider."] : []),
    ...(executable && providerReadiness?.verified !== true ? ["Executable, but not verified by a recent live smoke test."] : []),
  ];
  const estimate = reservationEstimate(route.model, body, entry.policy.requestCostMicros);
  return {
    stage,
    index,
    model: modelId,
    provider: route.providerId,
    policyAllowed,
    executable,
    verified: executable && providerReadiness?.verified === true,
    status: executable ? providerReadiness?.verified ? "verified" : "unverified" : "blocked",
    reasons,
    ...estimate,
  };
}

function reservationEstimate(model: CompiledModel, body: Record<string, unknown>, fixed: number | null | undefined): Pick<FusionReadinessCall, "estimatedReservationMicros" | "estimateBasis"> {
  if (fixed != null) return { estimatedReservationMicros: fixed, estimateBasis: "policy_fixed" };
  if (!model.pricing) return { estimatedReservationMicros: 1, estimateBasis: "flat_fallback" };
  return { estimatedReservationMicros: estimateModelCost(model.pricing, body).reserveMicros, estimateBasis: "manifest_pricing" };
}
