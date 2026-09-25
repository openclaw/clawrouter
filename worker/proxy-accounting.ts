import { emptyReservation, finalizeAccounting, type BudgetReservation, type EstimatedCost } from "./accounting";
import { correlationMetadata } from "./correlation";
import { googleField, googleRequestServiceTier, googleResponseServiceTier, googleServiceTier } from "./google-protocol.ts";
import { actualCharacterCost, actualModelCost, estimateModelCost, requestPricingGap, type PricingEndpoint } from "./pricing";
import type { ProxySelection } from "./proxy-selection";
import type { ObservedUsage } from "./proxy-response";
import { extractServiceTier, type UsageTokens } from "./token-usage";
import type { AuthorizedIdentity, CompiledModel, Env, ProxyRequestBody, UsageEvent } from "./types";
import { randomId } from "./utils";
import type { ToolKnowledge } from "./responses-tool-evidence.ts";

export interface CompoundRequestContext {
  id: string;
  stage: "fusion_adviser" | "fusion_synthesizer";
  index: number | null;
  size: number;
  startedAtMs: number;
}

interface AccountingContext {
  env: Env;
  context: ExecutionContext;
  auth: AuthorizedIdentity;
  selection: ProxySelection;
  request: Request;
  cost?: EstimatedCost;
  compound?: CompoundRequestContext;
  // Cost is captured after preflight; duration still includes those awaits.
  startedAtMs?: number;
}

// These facts contain attribution and prices, never the generation body. A
// durable owner freezes them before dispatch and freezes the resulting event
// before delivery to any accounting sink.
export interface AccountingFacts {
  event: UsageEvent;
  model: Pick<CompiledModel, "pricing"> | null;
  fixed: number | null;
  cost: EstimatedCost;
  requestFormat: string;
  startedAtMs: number;
}

export interface AccountingOutcome {
  occurredAtMs: number;
  statusCode: UsageEvent["status_code"];
  status: UsageEvent["status"];
  billable: boolean;
  tokens: UsageTokens | null;
  reservation: BudgetReservation;
  contentRef: string | null;
  servedTier?: string | null;
  characterEstimate?: number | null;
}

export function accountingReceipt(facts: AccountingFacts, outcome: AccountingOutcome): UsageEvent {
  const { model, fixed, cost, requestFormat, event } = facts;
  const { tokens, billable, reservation, contentRef, characterEstimate = null } = outcome;
  // Token totals and a served tier cannot resolve omitted fees or hosted work.
  const measured = cost.pricingGap ? null : tokens ? actualCost(model, tokens, fixed, requestFormat)
    : characterEstimate === null ? null : fixed ?? characterEstimate;
  const actual = billable ? measured ?? cost.reserveMicros : 0;
  const knownNoCharge = !billable || (tokens?.billable === false && actual === 0 && cost.basis !== "policy_fixed");
  const measuredBasis = characterEstimate !== null ? "request_character_estimate"
    : model?.pricing?.unit !== "character" && model?.pricing?.settlementBasis === "published_upper_bound" ? "manifest_rate_upper_bound" : "manifest_pricing";
  const basis = knownNoCharge ? "none" : cost.pricingGap ? "unpriced_usage" : cost.basis === "unpriced_service_tier"
    ? measured == null ? "unpriced_usage" : measuredBasis
    : cost.basis === "manifest_pricing" ? measured == null ? "manifest_reservation" : measuredBasis : cost.basis;
  return { ...event, occurred_at_ms: outcome.occurredAtMs, status_code: outcome.statusCode, status: outcome.status,
    input_tokens: tokens?.input ?? null, output_tokens: tokens?.output ?? null, total_tokens: tokens?.total ?? null,
    cached_input_tokens: tokens?.cached ?? null, cache_write_input_tokens: tokens?.cacheWrite ?? null,
    reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: actual, cost_basis: basis,
    served_service_tier: outcome.servedTier === undefined ? tokens?.serviceTier ?? null : outcome.servedTier,
    duration_ms: outcome.occurredAtMs - facts.startedAtMs, content_retained: !!contentRef, content_ref: contentRef };
}

export function createProxyAccounting(options: AccountingContext) {
  const { env, context, auth, selection, request, compound } = options;
  const cost = options.cost ?? estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability, selection.endpoint);
  const providerId = selection.provider.id, model = selection.model, capability = selection.capability;
  const google = selection.endpoint.request_format === "google.generate_content";
  const requestedTier = google ? googleServiceTier(googleField(selection.body, "serviceTier", "service_tier"))
    : extractServiceTier(Array.isArray(selection.body) ? null : selection.body) ?? null;
  let responseTier: string | null | undefined;
  const correlation = correlationMetadata(request);
  const requestId = correlation.requestId;
  const started = options.startedAtMs ?? Date.now();
  const facts: AccountingFacts = {
    model: model ? { pricing: model.pricing } : null, fixed: auth.policy.requestCostMicros ?? null, cost, requestFormat: selection.endpoint.request_format, startedAtMs: started,
    event: {
      id: randomId("usage"), type: "clawrouter.usage.v1", occurred_at_ms: started, tenant_id: auth.policy.tenantId ?? "default",
      policy_id: auth.policyId, credential_id: auth.credentialId, principal_id: auth.principalId, auth_type: auth.authType,
      session_id: correlation.sessionId, agent_id: correlation.agentId, parent_agent_id: correlation.parentAgentId,
      project_id: correlation.projectId, client: correlation.client,
      key_id: auth.credentialId ?? auth.policyId, request_id: requestId,
      trace_id: correlation.traceId, span_id: correlation.spanId,
      compound_request_id: compound?.id ?? null, compound_request_stage: compound?.stage ?? null, compound_request_index: compound?.index ?? null,
      compound_request_size: compound?.size ?? null, compound_request_started_at_ms: compound?.startedAtMs ?? null,
      provider: providerId, capability,
      model: model?.id ?? null, input_tokens: null, output_tokens: null,
      total_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null,
      reserved_cost_micros: 0, actual_cost_micros: 0, reserved_input_tokens: cost.inputTokens,
      reserved_output_tokens: cost.outputTokens, pricing_ref: model?.pricing_ref ?? null,
      pricing_effective_at: model?.pricing?.effectiveAt ?? null, cost_basis: cost.basis, status_code: null,
      requested_service_tier: requestedTier, served_service_tier: null,
      duration_ms: null, content_retained: false, content_ref: null, status: "success",
    },
  };
  function settle(statusCode: UsageEvent["status_code"], status: UsageEvent["status"], billable: boolean, tokens: UsageTokens | null, reservation: BudgetReservation, contentRef: string | null, characterEstimate: number | null = null) {
    const event = accountingReceipt(facts, { occurredAtMs: Date.now(), statusCode, status, billable, tokens, reservation, contentRef, servedTier: responseTier, characterEstimate });
    return finalizeAccounting(env, reservation, event.actual_cost_micros, event);
  }
  return {
    settle,
    cost,
    requestId,
    facts,
    fail(statusCode: number, status: UsageEvent["status"], reservation = emptyReservation(), contentRef: string | null = null, dispatched = false) {
      // Missing response headers cannot prove that dispatched upstream work was free.
      context.waitUntil(settle(statusCode, status, dispatched, null, reservation, contentRef));
    },
    complete(response: Response, observed: ObservedUsage, reservation: BudgetReservation, contentRef: string | null, termination?: UsageEvent["status"]) {
      if (google) responseTier = googleResponseServiceTier(googleRequestServiceTier(selection.body), observed.tokens?.serviceTier, response.headers.get("x-gemini-service-tier"));
      const tokens = google && observed.tokens ? { ...observed.tokens, serviceTier: responseTier } : observed.tokens;
      const status = termination ?? (!response.ok ? response.status < 500 ? "client_error" : "provider_error" : observed.outcome ?? "success");
      // Protocol/delivery failure does not undo dispatched billable work. Keep
      // the actual HTTP status and any authoritative terminal usage separately.
      const characterEstimate = observed.binaryComplete && observed.delivery === "complete" && response.ok && !termination
        && selection.endpoint.request_format === "openai.audio_speech" && selection.endpoint.response_format === "audio.binary" && !Array.isArray(selection.body)
        ? actualCharacterCost(model?.pricing, selection.body.input) : null;
      return settle(response.status, status, response.ok, tokens, reservation, contentRef, characterEstimate);
    },
  };
}

export function estimateCost(model: CompiledModel | null, body: ProxyRequestBody, fixed: number | null | undefined, capability: string, endpoint: PricingEndpoint, parentTools?: ToolKnowledge): EstimatedCost {
  if (capability === "llm.count_tokens") return { reserveMicros: 0, basis: "none", inputTokens: 0, outputTokens: 0 };
  if (fixed != null) return { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null };
  if (Array.isArray(body)) return { reserveMicros: 1, basis: "flat_fallback", inputTokens: null, outputTokens: null };
  const pricing = model?.pricing;
  const pricingGap = requestPricingGap(pricing, body, endpoint.request_format, parentTools);
  if (pricingGap) return { reserveMicros: 0, basis: "unpriced_request", pricingGap, inputTokens: null, outputTokens: null };
  if (!pricing) return { reserveMicros: 1, basis: "flat_fallback", inputTokens: null, outputTokens: null };
  const estimate = estimateModelCost(pricing, body, endpoint);
  return { reserveMicros: estimate.reserveMicros, basis: estimate.pricingAvailable === false ? "unpriced_service_tier" : "manifest_pricing", inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens };
}

function actualCost(model: Pick<CompiledModel, "pricing"> | null, tokens: UsageTokens, fixed: number | null | undefined, requestFormat?: string): number | null {
  if (fixed != null) return fixed;
  const pricing = model?.pricing;
  if (!pricing) return 1;
  return actualModelCost(pricing, tokens, requestFormat);
}
