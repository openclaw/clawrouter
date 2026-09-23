import type { FusionConfig, FusionReadiness, FusionReadinessCall } from "../shared/contracts";
import { buildAdviserBody, buildAggregatorBody, buildFusionReservationProposals } from "./fusion.ts";
import { validateBudgetReservation } from "./accounting.ts";
import { estimateCost } from "./proxy-accounting.ts";
import type { AccessPolicyEntry, CompiledModel, ProviderConnection } from "./types.ts";
import { HttpError } from "./utils.ts";

export interface FusionReadinessRoute {
  modelId: string;
  providerId: string;
  providerDisplayName: string;
  endpointId: string;
  requestFormat: string;
  connection?: ProviderConnection;
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
      : calls.some((call) => call.executable && call.estimateBasis === "unpriced_request") ? "Complete prices are unavailable for some eligible calls. Token rates do not cover their request fees or hosted work."
      : "Advisers use configured bounds; the synthesizer uses manifest maximum input and default output. Live request parameters can reserve more.",
    calls,
  };
}

function applyBudgetReadiness(calls: FusionReadinessCall[], synthesizer: FusionReadinessCall, budget: FusionBudgetReadiness): void {
  if (budget.configured && budget.ledger === "unavailable") block(synthesizer, "Budget ledger is unavailable.");
  if (budget.configured && budget.ledger === "blocked") block(synthesizer, "Policy budget is disabled.");
  if (budget.remainingMicros != null && synthesizer.estimatedReservationMicros > budget.remainingMicros) block(synthesizer, "Remaining budget cannot reserve the synthesizer estimate.");
  if (!synthesizer.executable) {
    for (const call of calls) if (call.stage === "adviser" && call.executable) block(call, "Synthesizer preflight prevents adviser fan-out.");
    return;
  }
  const adviserBudget = budget.remainingMicros == null ? null : budget.remainingMicros - synthesizer.estimatedReservationMicros;
  for (const call of calls) {
    if (call.stage !== "adviser" || !call.executable) continue;
    if (adviserBudget != null && call.estimatedReservationMicros > adviserBudget) block(call, "Remaining budget after the synthesizer cannot reserve this adviser.");
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
  const cost = estimateCost(route.model, body, entry.policy.requestCostMicros, "llm.chat", route.requestFormat);
  const call: FusionReadinessCall = {
    stage,
    index,
    model: modelId,
    provider: route.providerId,
    policyAllowed,
    executable,
    verified: executable && providerReadiness?.verified === true,
    status: executable ? providerReadiness?.verified ? "verified" : "unverified" : "blocked",
    reasons,
    estimatedReservationMicros: cost.reserveMicros,
    estimateBasis: cost.pricingGap ? "unpriced_request" : cost.basis === "policy_fixed" ? "policy_fixed" : cost.basis === "manifest_pricing" ? "manifest_pricing" : "flat_fallback",
  };
  try { validateBudgetReservation("llm.chat", cost, entry.policy.monthlyBudgetMicros, route.connection); }
  catch (error) {
    if (!(error instanceof HttpError)) throw error;
    block(call, error.message);
  }
  return call;
}
