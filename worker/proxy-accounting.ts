import { emptyReservation, finalizeAccounting, type BudgetReservation, type EstimatedCost } from "./accounting";
import { correlationMetadata } from "./correlation";
import { actualModelCost, estimateModelCost, requestPricingGap } from "./pricing";
import type { ProxySelection } from "./proxy-selection";
import type { ObservedUsage } from "./proxy-response";
import { extractServiceTier, type UsageTokens } from "./token-usage";
import type { AuthorizedIdentity, CompiledModel, Env, ProxyRequestBody, UsageEvent } from "./types";
import { randomId } from "./utils";

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
}

export function createProxyAccounting(options: AccountingContext) {
  const { env, context, auth, selection, request, compound } = options;
  const cost = options.cost ?? estimateCost(selection.model, selection.body, auth.policy.requestCostMicros, selection.capability, selection.endpoint.request_format);
  const unpricedRequest = cost.pricingGap != null;
  const providerId = selection.provider.id, model = selection.model, capability = selection.capability;
  const requestedTier = extractServiceTier(Array.isArray(selection.body) ? null : selection.body) ?? null;
  const correlation = correlationMetadata(request);
  const requestId = correlation.requestId;
  const started = Date.now();
  function finish(statusCode: number, status: UsageEvent["status"], reservation = emptyReservation(), actual = 0, tokens: UsageTokens | null = null, contentRef: string | null = null, basis = cost.basis) {
    const event: UsageEvent = {
      id: randomId("usage"), type: "clawrouter.usage.v1", occurred_at_ms: Date.now(), tenant_id: auth.policy.tenantId ?? "default",
      policy_id: auth.policyId, credential_id: auth.credentialId, principal_id: auth.principalId, auth_type: auth.authType,
      session_id: correlation.sessionId, agent_id: correlation.agentId, parent_agent_id: correlation.parentAgentId,
      project_id: correlation.projectId, client: correlation.client,
      key_id: auth.credentialId ?? auth.policyId, request_id: requestId,
      trace_id: correlation.traceId, span_id: correlation.spanId,
      compound_request_id: compound?.id ?? null, compound_request_stage: compound?.stage ?? null, compound_request_index: compound?.index ?? null,
      compound_request_size: compound?.size ?? null, compound_request_started_at_ms: compound?.startedAtMs ?? null,
      provider: providerId, capability,
      model: model?.id ?? null, input_tokens: tokens?.input ?? null, output_tokens: tokens?.output ?? null,
      total_tokens: tokens?.total ?? null, cached_input_tokens: tokens?.cached ?? null, cache_write_input_tokens: tokens?.cacheWrite ?? null,
      reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: actual, reserved_input_tokens: cost.inputTokens,
      reserved_output_tokens: cost.outputTokens, pricing_ref: model?.pricing_ref ?? null,
      pricing_effective_at: model?.pricing?.effectiveAt ?? null, cost_basis: basis, status_code: statusCode,
      requested_service_tier: requestedTier, served_service_tier: tokens?.serviceTier ?? null,
      duration_ms: Date.now() - started, content_retained: !!contentRef, content_ref: contentRef, status,
    };
    return finalizeAccounting(env, reservation, actual, event);
  }
  function settle(statusCode: number, status: UsageEvent["status"], billable: boolean, tokens: UsageTokens | null, reservation: BudgetReservation, contentRef: string | null) {
    // Token totals and a served tier cannot resolve omitted fees or hosted work.
    const measured = tokens && !unpricedRequest ? actualCost(model, tokens, auth.policy.requestCostMicros) : null;
    const actual = billable ? measured ?? cost.reserveMicros : 0;
    // Zero accounted micros with an unpriced basis means unavailable, not free.
    // A known served tier can supply a price even for an undeclared request tier.
    const basis = unpricedRequest ? !billable || tokens?.billable === false ? "none" : "unpriced_usage" : cost.basis === "unpriced_service_tier"
      ? !billable ? "none" : measured == null ? "unpriced_usage" : "manifest_pricing"
      : billable && measured == null && cost.basis === "manifest_pricing" ? "manifest_reservation" : cost.basis;
    return finish(statusCode, status, reservation, actual, tokens, contentRef, basis);
  }
  return {
    settle,
    cost,
    requestId,
    fail(statusCode: number, status: UsageEvent["status"], reservation = emptyReservation(), contentRef: string | null = null, dispatched = false) {
      // Missing response headers cannot prove that dispatched upstream work was free.
      context.waitUntil(settle(statusCode, status, dispatched, null, reservation, contentRef));
    },
    complete(response: Response, observed: ObservedUsage, reservation: BudgetReservation, contentRef: string | null) {
      const status = !response.ok ? response.status < 500 ? "client_error" : "provider_error"
        : observed.delivery === "canceled" ? "client_error" : observed.delivery === "failed" ? "provider_error" : observed.outcome ?? "success";
      // Protocol/delivery failure does not undo dispatched billable work. Keep
      // the actual HTTP status and any authoritative terminal usage separately.
      return settle(response.status, status, response.ok, observed.tokens, reservation, contentRef);
    },
  };
}

export function estimateCost(model: CompiledModel | null, body: ProxyRequestBody, fixed: number | null | undefined, capability: string, requestFormat: string): EstimatedCost {
  if (capability === "llm.count_tokens") return { reserveMicros: 0, basis: "none", inputTokens: 0, outputTokens: 0 };
  if (fixed != null) return { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null };
  if (Array.isArray(body)) return { reserveMicros: 1, basis: "flat_fallback", inputTokens: null, outputTokens: null };
  const pricing = model?.pricing;
  const pricingGap = requestPricingGap(pricing, body, requestFormat);
  if (pricingGap) return { reserveMicros: 0, basis: "unpriced_request", pricingGap, inputTokens: null, outputTokens: null };
  if (!pricing) return { reserveMicros: 1, basis: "flat_fallback", inputTokens: null, outputTokens: null };
  const estimate = estimateModelCost(pricing, body, requestFormat);
  return { reserveMicros: estimate.reserveMicros, basis: estimate.pricingAvailable === false ? "unpriced_service_tier" : "manifest_pricing", inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens };
}

function actualCost(model: CompiledModel | null, tokens: UsageTokens, fixed: number | null | undefined): number | null {
  if (fixed != null) return fixed;
  const pricing = model?.pricing;
  if (!pricing) return 1;
  return actualModelCost(pricing, tokens);
}
