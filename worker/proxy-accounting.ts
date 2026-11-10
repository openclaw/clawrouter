import type { MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import { checkOwnedHttpRequest, ownedHttpSinkOwner, growOwnedHttpRequest, checkOwnedHttpSinkOwner, beginOwnedHttpSinkRegistration, completeOwnedHttpSinkRegistration, abandonUnstartedOwnedHttpRegistration, type OwnedHttpRequest, type OwnedHttpSinkOwner } from "./http-identity-owner.ts";
import { vertexAnthropicRoute } from "./vertex-anthropic-dispatch.ts";
import { upstreamGenerationMayBeCharged } from "./upstream-billing-outcome.ts";
import { googleAudioRequest } from "./google-audio-classification.ts";
import { nativeEmbeddingMode } from "./native-embeddings.ts";
import { googleImageRequest } from "./google-image-classification.ts";
import { nativeRawFormat } from "./native-raw-input.ts";
import { nativeImageMode, selectRequestTariff, settleRequestTariff, type RequestTariff, type RequestTariffEndpoint, type RequestTariffOutcome } from "./request-tariff.ts";
import { reportingEstimate } from "./reporting-estimate.ts";
import { policyRequestCost } from "../shared/request-pricing.ts";
import { isModelDiscovery } from "./model-discovery.ts";
import { anthropicModifiers, anthropicPricing, type AnthropicModifiers } from "./anthropic-pricing.ts";
import { emptyReservation, accountingSinks, bindAccountingPlan, finalizeOwnedAccounting, type AccountingSinks, type BudgetReservation, type EstimatedCost } from "./accounting";
import { correlationMetadata } from "./correlation";
import { googleField, googleRequestServiceTier, googleResponseServiceTier, googleServiceTier } from "./google-protocol.ts";
import { actualModelCost, anthropicWebPrice, estimateModelCost, hostedSearchCost, hostedSearchPrice, outcomeRequestPricingGap, requestPricingGap, type AnthropicWebPrice, type HostedSearchPrice, type PricingEndpoint, type RequestCostReceipt } from "./pricing";
import type { ProxySelection } from "./proxy-selection";
import type { ObservedUsage } from "./proxy-response";
import { extractServiceTier, type UsageTokens } from "./token-usage";
import type { AuthorizedIdentity, CompiledModel, Env, ImageTokenPricing, ModelPricing, TokenRates, ProxyRequestBody, UsageEvent } from "./types";
import { accountingIdentity, admitAccountingJson, accountingStringCapacity, accountingNumberCapacity, copyAccountingJson } from "./json-body.ts";
import { randomId } from "./utils";
import { retainedToolBase, type ToolKnowledge } from "./responses-tool-evidence.ts";
import type { ProxyCompletion } from "./proxy-completion.ts";
import type { HostedSearchUsage } from "./responses-hosted-usage.ts";

export interface CompoundRequestContext {
  id: string;
  stage: "fusion_adviser" | "fusion_synthesizer";
  index: number | null;
  size: number;
  startedAtMs: number;
}

interface AccountingContext {
  ownedHttp?: OwnedHttpSinkOwner;
  completion?: ProxyCompletion;
  search?: MiniMaxSearchOperation;
  realtime?: true;
  env: Env;
  context: ExecutionContext;
  auth: AuthorizedIdentity;
  selection: ProxySelection;
  request: Request;
  cost?: EstimatedCost;
  compound?: CompoundRequestContext;
  grantKey?: string | null;
  grantLane?: import("./types").GrantLane | null;
  // Cost is captured after preflight; duration still includes those awaits.
  startedAtMs?: number;
}

// These facts contain attribution and prices, never the generation body. A
// durable owner freezes them before dispatch and freezes the resulting event
// before delivery to any accounting sink.
type AccountingPrice = Exclude<ModelPricing, ImageTokenPricing> | Pick<ImageTokenPricing,
  "unit" | "effectiveAt" | "source" | "textInputMicrosPerMillion" | "imageInputMicrosPerMillion" | "imageOutputMicrosPerMillion">;
export interface AccountingFacts {
  event: UsageEvent;
  model: { pricing: AccountingPrice | null; upstream?: string } | null;
  anthropicRequest?: AnthropicModifiers;
  fixed: number | null;
  cost: EstimatedCost;
  requestFormat: string;
  startedAtMs: number;
  hostedSearchPrice?: HostedSearchPrice;
  anthropicWebPrice?: AnthropicWebPrice;
  // Freeze the admission classification; an output token counter cannot price
  // image/audio generation, including generic GenerateContent and soft budgets.
  googleImage?: boolean;
  googleAudio?: boolean;
  nativeMusic?: boolean;
  nativeSpeech?: boolean;
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
  hostedSearch?: HostedSearchUsage;
  pricingUnavailable?: boolean;
  requestTariffOutcome?: RequestTariffOutcome;
  requestCostReceipt?: RequestCostReceipt;
}

export function accountingReceipt(facts: AccountingFacts, outcome: AccountingOutcome): UsageEvent {
  const { model, fixed, cost, requestFormat, event } = facts;
  // Moderation is a free upstream operation, not a generation tariff. Even
  // unknown delivery or a future usage-shaped payload cannot create a charge.
  if (requestFormat === "openai.moderations") return { ...event, occurred_at_ms: outcome.occurredAtMs, status_code: outcome.statusCode, status: outcome.status,
    reserved_cost_micros: 0, actual_cost_micros: 0, cost_basis: "none", reporting_known_cost_micros: null, duration_ms: outcome.occurredAtMs - facts.startedAtMs,
    content_retained: !!outcome.contentRef, content_ref: outcome.contentRef };
  const { tokens, billable, reservation, contentRef, characterEstimate = null } = outcome;
  if ((facts.googleImage || facts.googleAudio || facts.nativeMusic || facts.nativeSpeech || requestFormat === "minimax.speech" || requestFormat === "minimax.images") && fixed == null) return { ...event, occurred_at_ms: outcome.occurredAtMs, status_code: outcome.statusCode, status: outcome.status,
    reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: billable ? reservation.reservedMicros : 0,
    cost_basis: billable ? "unpriced_usage" : "none", input_tokens: null, output_tokens: null, total_tokens: null,
    pricing_ref: null, pricing_effective_at: null,
    cached_input_tokens: null, cache_write_input_tokens: null, duration_ms: outcome.occurredAtMs - facts.startedAtMs,
    content_retained: !!contentRef, content_ref: contentRef };
  if (cost.requestTariff && fixed == null) {
    const candidate = outcome.requestCostReceipt;
    const knownReceipt = candidate?.pricingVersion === cost.requestTariff.version
      && (cost.requestTariff.kind !== "deepseek_search" || candidate.basis === "manifest_request"
        && (candidate.costMicros === 0 || candidate.costMicros === cost.requestTariff.micros)) ? candidate : undefined;
    const settled = cost.requestTariff.kind === "successful_request" ? settleRequestTariff(cost.requestTariff, outcome.requestTariffOutcome ?? "unknown")
      : outcome.requestTariffOutcome === "unsent" ? { micros: 0, basis: "none" }
      : knownReceipt ? { micros: knownReceipt.costMicros, basis: knownReceipt.basis }
      : { micros: cost.reserveMicros, basis: cost.basis === "manifest_request" ? "manifest_request_reservation" : "unpriced_usage" };
    const inference = cost.requestTariff.kind === "outcome_request" ? tokens : null;
    return { ...event, occurred_at_ms: outcome.occurredAtMs, status_code: outcome.statusCode, status: outcome.status,
      reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: settled.micros, cost_basis: settled.basis,
      pricing_ref: cost.requestTariff.version, pricing_effective_at: cost.requestTariff.effectiveAt,
      input_tokens: inference?.input ?? null, output_tokens: inference?.output ?? null, total_tokens: inference?.total ?? null,
      cached_input_tokens: inference?.cached ?? null, cache_write_input_tokens: inference?.cacheWrite ?? null,
      duration_ms: outcome.occurredAtMs - facts.startedAtMs, content_retained: !!contentRef, content_ref: contentRef };
  }
  // Token totals and a served tier cannot resolve omitted fees or hosted work.
  const soft = reservation.charges !== undefined;
  const audioUnbounded = cost.pricingGap === "audio_upload_bound";
  const anthropicUnpriced = outcome.pricingUnavailable || tokens?.billable !== false && fixed == null && requestFormat === "anthropic.messages" && event.capability !== "llm.count_tokens" && !anthropicPricing(model?.pricing?.unit == null ? model?.pricing : null, model?.upstream, facts.anthropicRequest ?? {}, tokens?.anthropic ?? {});
  const claudeWeb = requestFormat === "anthropic.messages" ? facts.anthropicWebPrice : undefined;
  const measured = anthropicUnpriced ? null : cost.pricingGap && !soft && !audioUnbounded && !claudeWeb ? null : tokens ? ((soft || claudeWeb) && !model?.pricing && fixed == null ? null : actualCost(model, tokens, fixed, requestFormat, facts.anthropicRequest))
    : characterEstimate === null ? null : fixed ?? characterEstimate;
  const image = model?.pricing?.unit === "image_token";
  const searchCount = tokens?.webSearchRequests ?? null;
  const hosted = claudeWeb?.search ? { webSearch: searchCount ?? 0, complete: searchCount !== null } : outcome.hostedSearch;
  const searchPrice = claudeWeb ?? facts.hostedSearchPrice;
  const hostedEvent = hosted && (searchPrice || hosted.webSearch > 0);
  // OpenAI stays soft-only. Claude uses the authoritative usage counter for
  // soft and unmetered settlement; fixed policy tariffs remain unchanged.
  // Per-search fees are not token categories: speed/geo multipliers do not apply.
  const toolFee = billable && (claudeWeb || soft && !!reservation.charges?.length) && fixed == null && tokens && tokens.billable !== false && hosted?.complete
    ? hostedSearchCost(searchPrice, hosted.webSearch) : null;
  const actual = Math.min(Number.MAX_SAFE_INTEGER, (billable ? measured ?? (anthropicUnpriced ? reservation.reservedMicros : audioUnbounded || claudeWeb ? fixed ?? 0 : soft && !image ? fixed ?? 0 : fixed ?? cost.reserveMicros) : 0) + (toolFee ?? 0));
  const knownNoCharge = !billable || (tokens?.billable === false && actual === 0 && cost.basis !== "policy_fixed");
  const measuredBasis = characterEstimate !== null ? "request_character_estimate"
    : model?.pricing?.unit == null && model?.pricing?.settlementBasis === "published_upper_bound" ? "manifest_rate_upper_bound" : "manifest_pricing";
  const basis = anthropicUnpriced && billable ? "unpriced_usage" : audioUnbounded && billable ? measured === null ? "unpriced_usage" : measuredBasis : soft && !image && billable && measured == null && fixed == null ? "unpriced_usage" : knownNoCharge ? "none" : cost.pricingGap ? "unpriced_usage" : (cost.basis === "unpriced_service_tier" || cost.basis === "unpriced_modifier")
    ? measured == null ? "unpriced_usage" : measuredBasis
    : cost.basis === "manifest_pricing" ? measured == null ? "manifest_reservation" : measuredBasis : cost.basis;
  // An unproven reservation bound does not make a published tariff unknown.
  const claudeBasis = claudeWeb && fixed == null && billable
    ? knownNoCharge ? "none" : measured != null && claudeWeb.usageComplete && cost.pricingGap === "hosted_tool_usage" && (!claudeWeb.search || toolFee != null) ? measuredBasis : "unpriced_usage" : null;
  // Reporting can recover a disclosed estimate from a frozen card without changing the debit.
  // Hosted fees/partial usage keep their existing unknown remainder, never a token-only total.
  const reporting = billable && fixed == null && measured == null && actual === 0 && !cost.pricingGap
    ? reportingEstimate(model?.pricing?.unit == null ? model?.pricing : null, tokens, requestFormat) : null;
  // Reporting evidence is separate from the debit: measured token/tool costs
  // can establish a component, but fixed tariffs, character estimates, flat
  // fallbacks and retained reservation bounds cannot. In particular, a hard
  // Anthropic pricing failure retains its reservation without a known component.
  const finalBasis = claudeBasis ?? (billable && fixed == null && hostedEvent ? "unpriced_usage" : basis);
  const knownComponent = billable && fixed == null && tokens && tokens.billable !== false
    ? Math.min(Number.MAX_SAFE_INTEGER, (model?.pricing && characterEstimate === null && measuredBasis !== "manifest_rate_upper_bound" ? measured ?? 0 : 0) + (toolFee ?? 0)) : 0;
  const reportingKnown = finalBasis.startsWith("unpriced_") && Number.isSafeInteger(knownComponent) && knownComponent > 0 && knownComponent <= actual ? knownComponent : null;
  return { ...event, occurred_at_ms: outcome.occurredAtMs, status_code: outcome.statusCode, status: outcome.status,
    reporting_known_cost_micros: reportingKnown,
    ...(reporting ? { reporting_estimated_cost_micros: reporting.micros, reporting_estimate_reason: reporting.reason } : {}),
    ...(hostedEvent ? { hosted_tool_calls: { web_search: hosted.webSearch }, hosted_tool_calls_complete: hosted.complete,
      hosted_tool_cost_micros: toolFee, hosted_tool_pricing_ref: searchPrice?.version ?? null } : {}),
    input_tokens: tokens?.input ?? null, output_tokens: tokens?.output ?? null, total_tokens: tokens?.total ?? null,
    reasoning_output_tokens: tokens?.reasoning ?? null,
    ...(tokens?.image ? { image_usage: { text_input_tokens: tokens.image.textInput, image_input_tokens: tokens.image.imageInput, image_output_tokens: tokens.image.imageOutput } } : {}),
    cached_input_tokens: tokens?.cached ?? null, cache_write_input_tokens: tokens?.cacheWrite ?? null,
    reserved_cost_micros: reservation.reservedMicros, actual_cost_micros: actual, cost_basis: claudeBasis ?? (billable && fixed == null && hostedEvent ? "unpriced_usage" : basis),
    served_service_tier: outcome.servedTier === undefined ? tokens?.serviceTier ?? null : outcome.servedTier,
    duration_ms: outcome.occurredAtMs - facts.startedAtMs, content_retained: !!contentRef, content_ref: contentRef };
}

const controlSinkFacts = new WeakSet<AccountingFacts>();
interface AccountingFlags {
  billingBinding: Parameters<typeof upstreamGenerationMayBeCharged>[0]; google: boolean; requestedGoogleTier: string | null;
  vertex: boolean; nativeResponse: boolean; characterEstimate: number | null; realtime: boolean;
}
const accountingFlags = new WeakMap<AccountingFacts, AccountingFlags>();

// Covers the union of actual receipt branches BEFORE funding. Scalar producers
// are bound separately: service tiers <=64 (token-usage), content IDs 40
// (randomId), alternate grant IDs <=1024, Realtime IDs <=128 (session identity).
export function prospectiveAccountingEvent(facts: AccountingFacts,
  profile: "standard" | "search" | "realtime" = controlSinkFacts.has(facts) ? "search" : accountingFlags.get(facts)?.realtime ? "realtime" : "standard"): Record<string, unknown> {
  for (const key in facts.event) if (Object.hasOwn(facts.event, key)) {
    const value = facts.event[key as keyof UsageEvent];
    if (typeof value === "string") accountingIdentity(value);
  }
  accountingIdentity(facts.hostedSearchPrice?.version); accountingIdentity(facts.anthropicWebPrice?.version);
  const number = accountingNumberCapacity();
  const event: Record<string, unknown> = {};
  for (const key in facts.event) {
    if (!Object.hasOwn(facts.event, key)) continue;
    const value = facts.event[key as keyof UsageEvent];
    Object.defineProperty(event, key, { value: typeof value === "number" ? number : value, enumerable: true, writable: true, configurable: true });
  }
  Object.assign(event, {
    occurred_at_ms: number, input_tokens: number, output_tokens: number, total_tokens: number,
    cached_input_tokens: number, cache_write_input_tokens: number, reserved_input_tokens: number,
    reserved_output_tokens: number, reserved_cost_micros: number, actual_cost_micros: number,
    duration_ms: number, status_code: number, status: "provider_error", cost_basis: accountingStringCapacity(Math.max(64, facts.cost.basis.length)),
    reporting_known_cost_micros: number,
  });
  if (profile === "standard") Object.assign(event, {
    grant_key: accountingStringCapacity(1024), grant_lane: "subscription",
    reporting_estimated_cost_micros: number, reporting_estimate_reason: accountingStringCapacity(96),
    hosted_tool_calls: { web_search: number }, hosted_tool_calls_complete: false,
    hosted_tool_cost_micros: number, hosted_tool_pricing_ref: facts.anthropicWebPrice?.version ?? facts.hostedSearchPrice?.version ?? null,
    reasoning_output_tokens: number, image_usage: { text_input_tokens: number, image_input_tokens: number, image_output_tokens: number },
    served_service_tier: accountingStringCapacity(64), content_retained: false, content_ref: accountingStringCapacity(40),
  });
  if (profile === "search") event.reasoning_output_tokens = number;
  if (profile === "realtime") Object.assign(event, {
    realtime_usage: { unit_id: accountingStringCapacity(128), response_id: accountingStringCapacity(128),
      item_id: accountingStringCapacity(128), output_cap: number, text_input_tokens: number, audio_input_tokens: number,
      cached_text_input_tokens: number, cached_audio_input_tokens: number, text_output_tokens: number, audio_output_tokens: number },
  });
  return event;
}
export function admitAccountingFacts(facts: AccountingFacts, plan?: unknown, control = controlSinkFacts.has(facts)): void {
  const event = prospectiveAccountingEvent(facts, control ? "search" : accountingFlags.get(facts)?.realtime ? "realtime" : "standard");
  admitAccountingJson(event, "capsule");
  if (control) { admitAccountingJson(facts.event, "search"); admitAccountingJson(event, "search"); }
  admitAccountingJson({ ...facts, event, plan, flags: accountingFlags.get(facts) }, "capsule");
}

function immutableFacts(facts: AccountingFacts, control = false, flags?: AccountingFlags): AccountingFacts {
  if (flags) accountingFlags.set(facts, flags);
  admitAccountingFacts(facts, undefined, control);
  const copy = copyAccountingJson(facts, "capsule");
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const key in value) if (Object.hasOwn(value, key)) freeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  };
  freeze(copy);
  if (control) controlSinkFacts.add(copy);
  if (flags) accountingFlags.set(copy, flags);
  return copy;
}

// Select tariff fields only after the source card has been admitted. In
// particular, image request-generation tables never enter the receipt owner.
function receiptPricing(pricing: ModelPricing | null | undefined): AccountingPrice | null {
  if (!pricing) return null;
  const { unit, effectiveAt, source } = pricing;
  if (unit === "image_token") return { unit, effectiveAt, source, textInputMicrosPerMillion: pricing.textInputMicrosPerMillion,
    imageInputMicrosPerMillion: pricing.imageInputMicrosPerMillion, imageOutputMicrosPerMillion: pricing.imageOutputMicrosPerMillion };
  if (unit === "character") return { unit, effectiveAt, source, inputMicrosPerMillionCharacters: pricing.inputMicrosPerMillionCharacters, maxInputCharacters: pricing.maxInputCharacters };
  const rates = (value: TokenRates): TokenRates => ({ inputMicrosPerMillion: value.inputMicrosPerMillion, outputMicrosPerMillion: value.outputMicrosPerMillion,
    cachedInputMicrosPerMillion: value.cachedInputMicrosPerMillion, cacheWriteInputMicrosPerMillion: value.cacheWriteInputMicrosPerMillion,
    cacheWrite5mInputMicrosPerMillion: value.cacheWrite5mInputMicrosPerMillion, cacheWrite1hInputMicrosPerMillion: value.cacheWrite1hInputMicrosPerMillion });
  const long = (value: typeof pricing.longContext) => value ? { ...rates(value), thresholdInputTokens: value.thresholdInputTokens } : null;
  return { effectiveAt, source, ...rates(pricing), maxInputTokens: pricing.maxInputTokens, maxRequestInputTokens: pricing.maxRequestInputTokens,
    defaultMaxOutputTokens: pricing.defaultMaxOutputTokens, inputTokenOverhead: pricing.inputTokenOverhead, longContext: long(pricing.longContext),
    ...(pricing.serviceTiers ? { serviceTiers: pricing.serviceTiers.map(tier => ({ ...rates(tier), id: tier.id, aliases: tier.aliases,
      maxInputTokens: tier.maxInputTokens, longContext: long(tier.longContext) })) } : {}),
    ...(pricing.anthropicModifiers ? { anthropicModifiers: pricing.anthropicModifiers } : {}),
    ...(pricing.settlementBasis ? { settlementBasis: pricing.settlementBasis } : {}),
    // Runtime cards may retain this existing automatic-tier qualifier.
    ...("autoServiceTier" in pricing ? { autoServiceTier: pricing.autoServiceTier } : {}),
  };
}

export function createProxyAccounting(options: AccountingContext) {
  return createAccounting(options, false);
}

export interface OwnedHttpPreparationAccounting {
  fail(statusCode: number, status: UsageEvent["status"], reservation?: BudgetReservation, contentRef?: string | null, dispatched?: boolean): void;
  close(): void;
  retireUnused(): Promise<void>;
}

// This command cannot expose a cost or reserve a budget. Its early estimate and
// failure receipt retain the ordinary ordering, but need no plan-map binding.
export function createOwnedHttpPreparationAccounting(owner: OwnedHttpRequest, options: AccountingContext): OwnedHttpPreparationAccounting {
  checkOwnedHttpRequest(owner, options.request, options.env);
  if (options.ownedHttp !== ownedHttpSinkOwner(owner) || !options.completion
    || options.cost !== undefined || options.search !== undefined)
    throw new TypeError("owned preparation accounting unavailable");
  growOwnedHttpRequest(owner, 512); // Closed facade, captured cells and empty-child join products.
  let command: ReturnType<typeof createAccounting> | undefined = createAccounting(options, true);
  let used = false;
  options = undefined as never; owner = undefined as never;
  return {
    fail(statusCode, status, reservation, contentRef, dispatched) {
      if (used || !command) throw new TypeError("owned preparation accounting consumed");
      used = true; command.fail(statusCode, status, reservation, contentRef, dispatched);
    },
    close() {
      if (command) accountingFlags.delete(command.facts);
      try { command?.close(); } finally { command = undefined; }
    },
    async retireUnused() {
      if (used || !command) throw new TypeError("owned preparation accounting consumed");
      used = true;
      const completion = command.completion;
      accountingFlags.delete(command.facts);
      try { command.close(); } finally { command = undefined; }
      // No terminal work was started. Join only this empty child, never the
      // encompassing HTTP completion or any delivery-dependent sink.
      const receipt = await completion;
      if (!receipt?.unused || receipt.failed) throw new TypeError("owned preparation accounting was used");
    },
  };
}

function createAccounting(options: AccountingContext, preparation: boolean) {
  if (options.ownedHttp !== undefined) checkOwnedHttpSinkOwner(options.ownedHttp);
  const { env, context, auth, selection, request, compound } = options;
  for (const value of [auth.policyId, auth.policy.tenantId, auth.credentialId, auth.principalId, auth.authType,
    selection.provider.id, selection.capability, selection.model?.id, selection.model?.upstream,
    selection.model?.pricing_ref, selection.endpoint.request_format, selection.method, options.grantKey, options.grantLane,
    compound?.id, compound?.stage, auth.policy.limitHint]) accountingIdentity(value);
  if (selection.model?.pricing) admitAccountingJson(selection.model.pricing, "capsule");
  if (options.cost) admitAccountingJson(options.cost, "capsule");
  const cost = options.cost ?? estimateCost(selection.model, selection.body, policyRequestCost(auth.policy, selection.capability), selection.capability, selection.endpoint, undefined, selection.nativeResponse?.tariff, selection.provider.id);
  admitAccountingJson(cost, "capsule");
  for (const value of [cost.basis, cost.requestTariff?.version, cost.requestTariff?.effectiveAt, selection.model?.pricing?.effectiveAt]) accountingIdentity(value);
  const providerId = selection.provider.id, model = selection.model, capability = selection.capability;
  const billingBinding = { providerId, capability, requestFormat: selection.endpoint.request_format, method: selection.method, selectedModel: model?.upstream ?? null };
  const google = selection.endpoint.request_format === "google.generate_content";
  const count = selection.endpoint.request_format === "openai.responses_input_tokens";
  const requestedTier = google ? googleServiceTier(googleField(selection.body, "serviceTier", "service_tier"))
    : extractServiceTier(Array.isArray(selection.body) ? null : selection.body) ?? null;
  const correlation = correlationMetadata(request);
  const requestId = correlation.requestId;
  const started = options.startedAtMs ?? Date.now();
  const facts: AccountingFacts = {
    googleImage: googleImageRequest(selection.model?.upstream ?? selection.pathParams?.model, selection.body, selection.endpoint.request_format),
    googleAudio: googleAudioRequest(selection.model?.upstream ?? selection.pathParams?.model, selection.body, selection.endpoint.request_format),
    nativeSpeech: selection.provider.id === "openrouter" && selection.capability === "audio.speech" && selection.endpoint.request_format === "openai.audio_speech",
    nativeMusic: selection.capability === "music.generate" && selection.endpoint.request_format === "openai.chat_completions",
    ...(selection.endpoint.request_format === "anthropic.messages" && capability !== "llm.count_tokens"
      ? { anthropicWebPrice: anthropicWebPrice(selection.endpoint.toolPricing, selection.body) } : {}),
    hostedSearchPrice: hostedSearchPrice(selection.endpoint.toolPricing, selection.body, model?.upstream, request.headers.has("x-codex-turn-state")),
    ...(selection.endpoint.request_format === "anthropic.messages" && !Array.isArray(selection.body) ? { anthropicRequest: anthropicModifiers(selection.body) } : {}),
    // Counting is not generation: neither model rates nor a fixed request tariff apply.
    model: !count && model ? { pricing: model.pricing, upstream: model.upstream } : null, fixed: count || isModelDiscovery(selection.endpoint) ? 0 : policyRequestCost(auth.policy, selection.capability) ?? null, cost, requestFormat: selection.endpoint.request_format, startedAtMs: started,
    event: {
      id: randomId("usage"), type: "clawrouter.usage.v1", occurred_at_ms: started, tenant_id: auth.policy.tenantId ?? "default",
      grant_key: options.grantKey ?? null, grant_lane: options.grantLane ?? null,
      policy_id: auth.policyId, credential_id: auth.credentialId, principal_id: auth.principalId, auth_type: auth.authType,
      session_id: correlation.sessionId, agent_id: correlation.agentId, parent_agent_id: correlation.parentAgentId,
      project_id: correlation.projectId, client: correlation.client,
      key_id: auth.credentialId ?? auth.policyId, request_id: requestId,
      trace_id: correlation.traceId, span_id: correlation.spanId,
      compound_request_id: compound?.id ?? null, compound_request_stage: compound?.stage ?? null, compound_request_index: compound?.index ?? null,
      compound_request_size: compound?.size ?? null, compound_request_started_at_ms: compound?.startedAtMs ?? null,
      provider: providerId, capability, request_format: selection.endpoint.request_format,
      model: model?.id ?? null, input_tokens: null, output_tokens: null,
      total_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null,
      reserved_cost_micros: 0, actual_cost_micros: 0, reserved_input_tokens: cost.inputTokens,
      reserved_output_tokens: cost.outputTokens, pricing_ref: count ? null : cost.requestTariff?.version ?? model?.pricing_ref ?? null,
      pricing_effective_at: count ? null : cost.requestTariff?.effectiveAt ?? model?.pricing?.effectiveAt ?? null, cost_basis: cost.basis, status_code: null,
      requested_service_tier: requestedTier, served_service_tier: null,
      duration_ms: null, content_retained: false, content_ref: null, status: "success",
    },
  };
  let characterEstimate: number | null = null;
  if (selection.endpoint.request_format === "openai.audio_speech" && selection.endpoint.response_format === "audio.binary"
    && !Array.isArray(selection.body) && typeof selection.body.input === "string" && model?.pricing?.unit === "character") {
    let characters = 0;
    for (const _character of selection.body.input) characters++;
    characterEstimate = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(characters * model.pricing.inputMicrosPerMillionCharacters / 1_000_000));
  }
  const flags: AccountingFlags = {
    billingBinding, google, requestedGoogleTier: google ? googleRequestServiceTier(selection.body) : null,
    vertex: vertexAnthropicRoute(selection.provider, selection.endpoint), nativeResponse: !!selection.nativeResponse,
    characterEstimate, realtime: options.realtime === true,
  };
  admitAccountingJson(flags, "capsule");
  Object.freeze(flags.billingBinding); Object.freeze(flags);
  accountingFlags.set(facts, flags);
  try {
    admitAccountingFacts(facts, undefined, !!options.search);
    if (facts.model && model) facts.model = { pricing: receiptPricing(model.pricing), upstream: model.upstream };
    return ownedProxyAccounting(immutableFacts(facts, !!options.search, flags), accountingSinks(env, options.ownedHttp), context.waitUntil?.bind(context), options.search, flags, options.completion?.fork(), options.ownedHttp !== undefined ? context : undefined, preparation);
  } finally { if (preparation) accountingFlags.delete(facts); }
}

function ownedProxyAccounting(initial: AccountingFacts, sinks: AccountingSinks, waitUntil: ((work: Promise<unknown>) => void) | undefined,
  search: MiniMaxSearchOperation | undefined, flags: AccountingFlags, custody?: ProxyCompletion, registrationContext?: ExecutionContext, preparation = false) {
  let facts = initial, chargedUpstreamResponse = false;
  if (!preparation) bindAccountingPlan(facts.cost, plan => admitAccountingFacts(facts, plan));
  let responseTier: string | null | undefined;
  const { google } = flags;
  function terminal(start: () => Promise<boolean>): Promise<boolean> {
    if (!custody) return start();
    try {
      return custody.start(children => {
        const work = start();
        void work.then(ok => { if (!ok) children.fail(); }, () => {});
        return work;
      });
    } finally { custody.seal(); }
  }
  function settle(statusCode: UsageEvent["status_code"], status: UsageEvent["status"], billable: boolean, tokens: UsageTokens | null, reservation: BudgetReservation, contentRef: string | null, characterEstimate: number | null = null, hostedSearch?: HostedSearchUsage, requestTariffOutcome?: RequestTariffOutcome, requestCostReceipt?: RequestCostReceipt) {
    return terminal(() => {
      const outcome: AccountingOutcome = { occurredAtMs: Date.now(), statusCode, status, billable, tokens, reservation, contentRef, servedTier: responseTier, characterEstimate, hostedSearch, requestTariffOutcome, requestCostReceipt };
      // Error payloads are not a qualified usage receipt. Keep the dispatched
      // reservation conservative, separately from any explicit policy tariff.
      if (chargedUpstreamResponse) Object.assign(outcome, { billable: true, tokens: null, characterEstimate: null,
        pricingUnavailable: facts.fixed == null, hostedSearch: undefined, requestTariffOutcome: "unknown", requestCostReceipt: undefined });
      const event = accountingReceipt(facts, outcome);
      return finalizeOwnedAccounting(sinks, reservation, event.actual_cost_micros, event, search);
    });
  }
  return {
    completion: custody?.completion,
    close() { custody?.seal(); },
    settle,
    pricingFailure(tokens: UsageTokens | null, reservation: BudgetReservation, contentRef: string | null) {
      return terminal(() => {
        const event = accountingReceipt(facts, { occurredAtMs: Date.now(), statusCode: 502, status: "provider_error", billable: true, tokens, reservation, contentRef, pricingUnavailable: true });
        return finalizeOwnedAccounting(sinks, reservation, event.actual_cost_micros, event, search);
      });
    },
    cost: facts.cost,
    requestId: facts.event.request_id,
    get facts() { return facts; },
    fork() {
      // Same admitted shape and fixed-length event ID. No post-media admission.
      const child = Object.freeze({ ...facts, event: Object.freeze({ ...facts.event, id: randomId("usage") }) });
      if (search) controlSinkFacts.add(child);
      accountingFlags.set(child, flags);
      return ownedProxyAccounting(child, sinks, waitUntil, search, flags, custody?.fork(), registrationContext);
    },
    setGrant(key: string | null, lane: import("./types").GrantLane) {
      accountingIdentity(key); accountingIdentity(lane);
      facts = Object.freeze({ ...facts, event: Object.freeze({ ...facts.event, grant_key: key, grant_lane: lane }) });
      if (search) controlSinkFacts.add(facts);
      accountingFlags.set(facts, flags);
    },
    observeUpstreamResponse(response: Response, url: URL) {
      chargedUpstreamResponse ||= upstreamGenerationMayBeCharged(flags.billingBinding, url, response.status)
        || flags.vertex && !response.ok;
    },
    get upstreamChargePossible() { return chargedUpstreamResponse; },
    fail(statusCode: number, status: UsageEvent["status"], reservation = emptyReservation(), contentRef: string | null = null, dispatched = false) {
      // Missing response headers cannot prove that dispatched upstream work was free.
      const registration = sinks.ownedHttp !== undefined ? beginOwnedHttpSinkRegistration(sinks.ownedHttp) : undefined;
      if (registration && !waitUntil) completeOwnedHttpSinkRegistration(registration);
      if (!waitUntil) throw new TypeError("accounting background sink unavailable");
      let original: Promise<boolean>;
      try { original = settle(statusCode, status, dispatched, null, reservation, contentRef, null, undefined, dispatched ? "unknown" : "unsent"); }
      catch (error) {
        // No settlement promise exists on this local synchronous factory path.
        if (registration) {
          try { abandonUnstartedOwnedHttpRegistration(registration); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "owned accounting registration cleanup"); }
        }
        throw error;
      }
      if (registration) completeOwnedHttpSinkRegistration(registration, registrationContext!, original);
      else waitUntil(original);
    },
    complete(response: Response, observed: ObservedUsage, reservation: BudgetReservation, contentRef: string | null, termination?: UsageEvent["status"]) {
      if (google) responseTier = googleResponseServiceTier(flags.requestedGoogleTier, observed.tokens?.serviceTier, response.headers.get("x-gemini-service-tier"));
      const tokens = google && observed.tokens ? { ...observed.tokens, serviceTier: responseTier } : observed.tokens;
      if (flags.vertex && (observed.nonbillable || termination || observed.outcome === "provider_error")) chargedUpstreamResponse = true;
      const status = termination ?? (!response.ok ? response.status < 500 ? "client_error" : "provider_error" : observed.outcome ?? "success");
      // Errors after generation starts do not undo dispatched billable work.
      // A received pre-output rejection is known-free even with HTTP-200 SSE.
      // Keep actual wire status and authoritative terminal usage separately.
      const characterEstimate = observed.binaryComplete && observed.delivery === "complete" && response.ok && !termination
        ? flags.characterEstimate : null;
      return settle(response.status, status, (response.ok || flags.nativeResponse) && !observed.nonbillable, tokens, reservation, contentRef, characterEstimate, observed.hostedSearch, observed.requestTariffOutcome, observed.requestCostReceipt);
    },
  };
}

export function estimateCost(model: CompiledModel | null, body: ProxyRequestBody, fixed: number | null | undefined, capability: string, endpoint: PricingEndpoint & RequestTariffEndpoint, parentTools?: ToolKnowledge, preparedTariff?: RequestTariff, providerId?: string): EstimatedCost {
  if (endpoint.request_format === "openai.moderations" || isModelDiscovery(endpoint) || capability === "llm.count_tokens") return { reserveMicros: 0, basis: "none", inputTokens: 0, outputTokens: 0 };
  if ((providerId === "github-copilot" || ["minimax.speech", "minimax.images", "minimax.music", "minimax.search", "minimax.video_create"].includes(endpoint.request_format)) && fixed == null)
    return { reserveMicros: 0, basis: "unpriced_request", pricingGap: "opaque_input_bound", inputTokens: null, outputTokens: null };
  if (fixed != null) return { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null };
  // Raw audio bytes and response duration cannot bound the whole upload price.
  // Keep catalog affordability and dispatch admission on the same verdict.
  if (endpoint.request_format === "deepgram.prerecorded") return { reserveMicros: 0, basis: "unpriced_request", pricingGap: "audio_upload_bound", inputTokens: null, outputTokens: null };
  // Provider context comes from the selected route, never the request model.
  // This native speech contract has no qualified character or token tariff.
  if (providerId === "openrouter" && capability === "audio.speech" && endpoint.request_format === "openai.audio_speech")
    return { reserveMicros: 0, basis: "unpriced_request", pricingGap: "opaque_input_bound", inputTokens: null, outputTokens: null };
  // A native music envelope carried over Chat SSE has no qualified token tariff.
  if (capability === "music.generate" && endpoint.request_format === "openai.chat_completions")
    return { reserveMicros: 0, basis: "unpriced_request", pricingGap: "opaque_input_bound", inputTokens: null, outputTokens: null };
  // Unknown Search fees stay closed. Only the frozen, route-qualified native
  // tariff can cover this model-less operation; Chat prices never substitute.
  if (endpoint.request_format === "deepseek.search") {
    const requestTariff = preparedTariff ?? selectRequestTariff(endpoint, body);
    if (model === null && capability === "search.web" && requestTariff?.kind === "deepseek_search")
      return { reserveMicros: requestTariff.micros, basis: "manifest_request", inputTokens: null, outputTokens: null, requestTariff };
    return { reserveMicros: 0, basis: "unpriced_request", pricingGap: "model_request_fee", inputTokens: null, outputTokens: null };
  }
  // Classify with trusted routing context, then consume the source-owned image
  // pricing guard. This changes no wire format and clears no other price gap.
  const imageGap = googleImageRequest(model?.upstream, body, endpoint.request_format)
    ? requestPricingGap(model?.pricing, Array.isArray(body) ? {} : body, "google.image_generate") : null;
  if (imageGap) return { reserveMicros: 0, basis: "unpriced_request", pricingGap: imageGap, inputTokens: null, outputTokens: null };
  // Native embedding shape/byte bounds are not qualified whole-request dollar bounds.
  if (nativeEmbeddingMode(endpoint.request_format) || nativeRawFormat(endpoint.request_format)) return { reserveMicros: 0, basis: "unpriced_request", pricingGap: "opaque_input_bound", inputTokens: null, outputTokens: null };
  const requestTariff = preparedTariff ?? selectRequestTariff(endpoint, body);
  if (requestTariff?.kind === "successful_request") return { reserveMicros: requestTariff.micros, basis: "manifest_request", inputTokens: null, outputTokens: null, requestTariff };
  if (requestTariff?.kind === "image_request") return { reserveMicros: requestTariff.micros, basis: "manifest_request", inputTokens: null, outputTokens: null, requestTariff };
  if (nativeImageMode(endpoint.request_format)) return { reserveMicros: 0, basis: "unpriced_request", pricingGap: "opaque_input_bound", inputTokens: null, outputTokens: null };
  if (Array.isArray(body)) return { reserveMicros: 1, basis: "flat_fallback", inputTokens: null, outputTokens: null };
  const pricing = model?.pricing;
  // Only the source-qualified outcome classifier can discharge request_fee.
  // Inventory completeness is independent of a known positive pricing gap.
  const outcomePricing = requestTariff?.kind === "outcome_request" ? requestTariff.pricing : undefined;
  const inventoryKnown = !outcomePricing || retainedToolBase(body, parentTools ?? "token_only") === "token_only"
    && (body.tools === undefined || retainedToolBase({ input: [{ type: "additional_tools", tools: body.tools }] }, "token_only") === "token_only");
  const pricingGap = (outcomePricing ? outcomeRequestPricingGap(pricing, body, endpoint.request_format, outcomePricing, parentTools)
    : requestPricingGap(pricing, body, endpoint.request_format, parentTools)) ?? (inventoryKnown ? null : "retained_tool_unknown");
  if (pricingGap) return { reserveMicros: 0, basis: "unpriced_request", pricingGap, inputTokens: null, outputTokens: null, ...(requestTariff ? { requestTariff } : {}) };
  if (!pricing) return requestTariff ? { reserveMicros: 0, basis: "unpriced_request", pricingGap: "model_request_fee", inputTokens: null, outputTokens: null, requestTariff }
    : { reserveMicros: 1, basis: "flat_fallback", inputTokens: null, outputTokens: null };
  const qualified = endpoint.request_format === "anthropic.messages" ? anthropicPricing(pricing, model?.upstream, anthropicModifiers(body)) : pricing;
  if (!qualified) return { reserveMicros: 0, basis: "unpriced_modifier", inputTokens: null, outputTokens: null };
  // Source-owned pricing can consume this selected model context without
  // interpreting body.model as caller authority or conflating router aliases.
  const pricingEndpoint = { ...endpoint, selectedUpstreamModel: model?.upstream ?? null };
  const estimate = estimateModelCost(qualified, body, pricingEndpoint, outcomePricing);
  return { reserveMicros: estimate.reserveMicros, basis: estimate.pricingAvailable === false ? "unpriced_service_tier" : requestTariff ? "manifest_request" : "manifest_pricing", inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, ...(requestTariff ? { requestTariff } : {}) };
}

function actualCost(model: AccountingFacts["model"], tokens: UsageTokens, fixed: number | null | undefined, requestFormat?: string, requested?: AnthropicModifiers): number | null {
  if (fixed != null) return fixed;
  const pricing = model?.pricing;
  if (requestFormat === "anthropic.messages") {
    if (tokens.billable === false) return 0;
    const qualified = anthropicPricing(pricing?.unit == null ? pricing : null, model?.upstream, requested ?? {}, tokens.anthropic ?? {});
    return qualified ? actualModelCost(qualified, tokens, requestFormat) : null;
  }
  if (!pricing) return 1;
  if (pricing.unit === "image_token") {
    const image = tokens.image;
    return requestFormat === "openai.images_generations" && image ? Math.ceil((image.textInput * pricing.textInputMicrosPerMillion
      + image.imageInput * pricing.imageInputMicrosPerMillion + image.imageOutput * pricing.imageOutputMicrosPerMillion) / 1_000_000) : null;
  }
  return actualModelCost(pricing, tokens, requestFormat);
}
