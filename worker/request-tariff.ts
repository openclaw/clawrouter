import { prepareXaiImage, type XaiImageRequest } from "./xai-images.ts";
import { imageRequestReserve, requestOutcomeCost, type ImageRequestSelection, type RequestCostReceipt } from "./pricing.ts";
import type { ImageRequestPricing, OutcomeRequestPricing } from "../shared/request-pricing.ts";
import type { CompiledEndpoint, ProxyRequestBody } from "./types.ts";
import { HttpError } from "./utils.ts";

// Only admission creates this snapshot. It contains the selected scalar rate,
// never the caller body, mutable manifest table, credential or native output.
export interface SuccessfulRequestTariff {
  kind: "successful_request";
  unit: "request";
  version: string;
  effectiveAt: string;
  source: string;
  micros: number;
  parameter: string;
  value: string | null;
}
export interface OutcomeRequestTariff {
  kind: "outcome_request";
  version: string;
  effectiveAt: string;
  pricing: Readonly<OutcomeRequestPricing>;
  model: string;
}
export interface ImageRequestTariff {
  kind: "image_request";
  version: string;
  effectiveAt: string;
  pricing: Readonly<ImageRequestPricing>;
  selection: Readonly<ImageRequestSelection>;
  micros: number;
}
export type RequestTariff = SuccessfulRequestTariff | OutcomeRequestTariff | ImageRequestTariff;
export type RequestTariffOutcome = "succeeded" | "failed" | "unknown" | "unsent";
export type RequestTariffEndpoint = Partial<Pick<CompiledEndpoint,
  "method" | "path" | "request_format" | "response_format" | "streaming" | "lifecycle" | "responsesLifecycle" | "websocket" | "modelPassthrough" | "query" | "requestPricing">>;

export function selectRequestTariff(endpoint: RequestTariffEndpoint, body: ProxyRequestBody, preparedImage?: XaiImageRequest): RequestTariff | undefined {
  const pricing = endpoint.requestPricing;
  if (pricing === undefined) return undefined;
  if (pricing.unit === "image") {
    const mode = nativeImageMode(endpoint.request_format ?? "");
    if (!mode || endpoint.method !== "POST" || endpoint.path !== `/v1/images/${mode === "generate" ? "generations" : "edits"}`
      || endpoint.response_format !== "xai.images" || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle
      || endpoint.websocket || endpoint.modelPassthrough || Object.keys(endpoint.query ?? {}).length || !versioned(pricing)) unqualified();
    let prepared: XaiImageRequest;
    try { prepared = preparedImage ?? prepareXaiImage(!Array.isArray(body) && typeof body.model === "string" ? body.model : "", mode, body); }
    catch { throw new HttpError(400, "invalid_native_image_request", "image input does not match the selected native model contract"); }
    const { model, servingModel, count, inputImages, resolution, quality, qualityBasis } = prepared;
    if (prepared.mode !== mode || prepared.path !== endpoint.path) unqualified();
    const selection = Object.freeze({ model, servingModel, mode, count, inputImages, resolution, quality, qualityBasis });
    const micros = imageRequestReserve(pricing, selection);
    if (micros === null) unqualified();
    return Object.freeze({ kind: "image_request", version: pricing.version, effectiveAt: pricing.effectiveAt,
      pricing: Object.freeze(structuredClone(pricing)), selection, micros });
  }
  if ("outcome" in pricing) {
    if (endpoint.method !== "POST" || endpoint.path !== "/v1/responses" || endpoint.request_format !== "openai.responses" || endpoint.response_format !== "openai.responses"
      || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.modelPassthrough || Object.keys(endpoint.query ?? {}).length
      || endpoint.streaming && endpoint.streaming !== "sse" || pricing.unit !== "request" || pricing.outcome !== "xai.responses_violation"
      || pricing.receipt !== "xai.usage.cost_in_usd_ticks" || pricing.maximumAdditionalMicros !== 50000
      || pricing.source !== "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee" || !versioned(pricing)
      || "successfulResponseMicros" in pricing || "parameterRates" in pricing) unqualified();
    if (Array.isArray(body) || !body || typeof body !== "object" || typeof body.model !== "string" || !body.model.length || body.model.length > 256
      || body.background !== undefined && body.background !== false || body.stream !== undefined && typeof body.stream !== "boolean") invalidParameter();
    return Object.freeze({ kind: "outcome_request", version: pricing.version, effectiveAt: pricing.effectiveAt,
      pricing: Object.freeze({ ...pricing }), model: body.model });
  }
  const rates = pricing.parameterRates;
  const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (endpoint.method !== "POST" || endpoint.path !== "/search" || endpoint.request_format !== "perplexity.search" || endpoint.response_format !== "perplexity.search"
    || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.modelPassthrough
    || Object.keys(endpoint.query ?? {}).length || pricing.unit !== "request" || typeof pricing.version !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(pricing.version)
    || typeof pricing.effectiveAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pricing.effectiveAt)
    || typeof pricing.source !== "string" || !/^https:\/\/[^\s]{1,2048}$/.test(pricing.source) || !amount(pricing.successfulResponseMicros)
    || rates?.parameter !== "search_type" || !rates.rates || Object.keys(rates.rates).sort().join(",") !== "fast,web"
    || !amount(rates.rates.web) || !amount(rates.rates.fast) || rates.rates.web !== pricing.successfulResponseMicros) {
    throw new HttpError(503, "request_tariff_unqualified", "the declared request tariff has no qualified operation contract");
  }
  if (Array.isArray(body) || !body || typeof body !== "object" || body.stream !== undefined && body.stream !== false) invalidParameter();
  const value = Object.hasOwn(body, rates.parameter) ? body[rates.parameter] : null;
  if (value !== null && (typeof value !== "string" || !Object.hasOwn(rates.rates, value)) || Object.hasOwn(body, rates.parameter) && value === null) invalidParameter();
  return Object.freeze({ kind: "successful_request", unit: "request", version: pricing.version, effectiveAt: pricing.effectiveAt,
    source: pricing.source, micros: value === null ? pricing.successfulResponseMicros : rates.rates[value as string], parameter: rates.parameter, value: value as string | null });
}

export function nativeImageMode(format: string): "generate" | "edit" | null {
  return format === "xai.images_generations" ? "generate" : format === "xai.images_edits" ? "edit" : null;
}

export function settleRequestTariff(tariff: SuccessfulRequestTariff, outcome: RequestTariffOutcome): { micros: number; basis: string } {
  if (outcome === "unsent" || outcome === "failed") return { micros: 0, basis: "none" };
  return { micros: tariff.micros, basis: outcome === "succeeded" ? "manifest_request" : "manifest_request_reservation" };
}

function invalidParameter(): never {
  throw new HttpError(400, "invalid_request_tariff_parameter", "provide a supported native request price parameter; malformed values cannot select the default tariff");
}

function versioned(pricing: { version: string; effectiveAt: string }): boolean {
  return typeof pricing.version === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(pricing.version)
    && typeof pricing.effectiveAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pricing.effectiveAt);
}
function unqualified(): never {
  throw new HttpError(503, "request_tariff_unqualified", "the declared request tariff has no qualified operation contract");
}

// A connection override cannot borrow a global native tariff. Check the actual
// selected destination before admission, without retaining credentials or URLs.
export function assertRequestTariffDestination(endpoint: RequestTariffEndpoint, destination: string | URL): void {
  if (!endpoint.requestPricing) return;
  const expected = endpoint.requestPricing.unit === "image" ? `https://api.x.ai${endpoint.path}` : "outcome" in endpoint.requestPricing ? "https://api.x.ai/v1/responses" : "https://api.perplexity.ai/search";
  if (String(destination) !== expected) unqualified();
}

export interface ResponseReceiptInspection {
  accept(value: unknown, streaming: boolean): void;
  invalid(): void;
  done(): void;
  result(complete: boolean): RequestCostReceipt | undefined;
}

// Runs on the existing bounded Responses metadata projection. No output text,
// body clone, foreground I/O or running-charge accumulation is needed.
export function createResponseReceiptInspection(tariff: OutcomeRequestTariff): ResponseReceiptInspection {
  let invalid = false, identity: string | undefined, terminal: unknown, seenTerminal = false;
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  return {
    accept(value, streaming) {
      if (invalid) return;
      if (!object(value) || seenTerminal) { invalid = true; return; }
      const response = streaming ? value.response : value;
      if (streaming && (value.type === "error" || value.type === "response.failed" || value.error)) { invalid = true; return; }
      if (!object(response)) {
        if (!streaming || value.response !== undefined || ["response.completed", "response.incomplete"].includes(String(value.type))) invalid = true;
        return;
      }
      if (response.object !== "response" || typeof response.id !== "string" || !response.id.length || response.id.length > 256
        || response.model !== tariff.model || identity !== undefined && identity !== response.id) { invalid = true; return; }
      identity = response.id;
      const status = response.status;
      if (!["completed", "incomplete"].includes(String(status))) {
        if (!streaming || !["queued", "in_progress"].includes(String(status))) invalid = true;
        return;
      }
      if (streaming && value.type !== `response.${status}`) { invalid = true; return; }
      terminal = response; seenTerminal = true;
    },
    invalid() { invalid = true; },
    done() { if (!seenTerminal) invalid = true; },
    result(complete) { return !invalid && seenTerminal ? requestOutcomeCost(tariff.pricing, terminal, complete) ?? undefined : undefined; },
  };
}
