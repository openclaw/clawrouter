import type { LongContextPricing, ModelPricing } from "./types";

export interface CostEstimate {
  reserveMicros: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PricedTokens {
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheWrite: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
}

interface Rates {
  input: number;
  output: number;
  cachedInput: number | null;
  cacheWrite5mInput: number | null;
  cacheWrite1hInput: number | null;
}

export function estimateModelCost(pricing: ModelPricing, body: Record<string, unknown>): CostEstimate {
  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  const inputLimit = pricing.maxRequestInputTokens ?? pricing.maxInputTokens;
  const inputTokens = requestHasUnboundedInput(body)
    ? inputLimit
    : Math.min(inputLimit, saturatingAdd(bytes, pricing.inputTokenOverhead));
  const requestedOutput = [body.max_output_tokens, body.max_completion_tokens, body.max_tokens]
    .map(nonNegativeInteger)
    .filter((value): value is number => value != null);
  const choices = Math.max(1, nonNegativeInteger(body.n) ?? 1);
  const outputTokens = saturatingMultiply(requestedOutput.length ? Math.max(...requestedOutput) : pricing.defaultMaxOutputTokens, choices);
  const rates = reservationRates(pricing, inputTokens);
  const inputRate = reservationInputRate(body, rates);
  return {
    reserveMicros: saturatingAdd(tokenCost(inputTokens, inputRate), tokenCost(outputTokens, rates.output)),
    inputTokens,
    outputTokens,
  };
}

export function actualModelCost(pricing: ModelPricing, tokens: PricedTokens): number | null {
  if (tokens.input == null) return null;
  const rates = effectiveRates(pricing, tokens.input);
  if (tokens.output == null && rates.output > 0) return null;
  const cached = Math.min(tokens.input, tokens.cached ?? 0);
  let remaining = Math.max(0, tokens.input - cached);
  const write5m = Math.min(remaining, tokens.cacheWrite5m ?? 0); remaining -= write5m;
  const write1h = Math.min(remaining, tokens.cacheWrite1h ?? 0); remaining -= write1h;
  const genericWrite = Math.min(remaining, tokens.cacheWrite ?? 0); remaining -= genericWrite;
  const write5mRate = rates.cacheWrite5mInput ?? rates.input;
  const write1hRate = rates.cacheWrite1hInput ?? write5mRate;
  return weightedTokenCost([
    [remaining, rates.input],
    [cached, rates.cachedInput ?? rates.input],
    [write5m, write5mRate],
    [write1h, write1hRate],
    [genericWrite, Math.max(write5mRate, write1hRate)],
    [tokens.output ?? 0, rates.output],
  ]);
}

function effectiveRates(pricing: ModelPricing, inputTokens: number): Rates {
  const long = pricing.longContext;
  return long && inputTokens > long.thresholdInputTokens ? ratesFromLong(long) : ratesFromPricing(pricing);
}

function reservationRates(pricing: ModelPricing, inputTokens: number): Rates {
  const base = ratesFromPricing(pricing), long = pricing.longContext;
  if (!long || inputTokens <= long.thresholdInputTokens) return base;
  const extended = ratesFromLong(long);
  return {
    input: Math.max(base.input, extended.input),
    output: Math.max(base.output, extended.output),
    cachedInput: maxOptional(base.cachedInput, extended.cachedInput),
    cacheWrite5mInput: maxOptional(base.cacheWrite5mInput, extended.cacheWrite5mInput),
    cacheWrite1hInput: maxOptional(base.cacheWrite1hInput, extended.cacheWrite1hInput),
  };
}

function reservationInputRate(body: unknown, rates: Rates): number {
  let rate = Math.max(rates.input, rates.cachedInput ?? rates.input);
  if (jsonHasCacheTtl(body, "1h")) return Math.max(rate, rates.cacheWrite1hInput ?? rates.input);
  if (jsonHasKey(body, "cache_control")) rate = Math.max(rate, rates.cacheWrite5mInput ?? rates.input);
  return rate;
}

function ratesFromPricing(pricing: ModelPricing): Rates {
  return { input: pricing.inputMicrosPerMillion, output: pricing.outputMicrosPerMillion, cachedInput: pricing.cachedInputMicrosPerMillion, cacheWrite5mInput: pricing.cacheWrite5mInputMicrosPerMillion, cacheWrite1hInput: pricing.cacheWrite1hInputMicrosPerMillion };
}

function ratesFromLong(pricing: LongContextPricing): Rates {
  return { input: pricing.inputMicrosPerMillion, output: pricing.outputMicrosPerMillion, cachedInput: pricing.cachedInputMicrosPerMillion, cacheWrite5mInput: pricing.cacheWrite5mInputMicrosPerMillion, cacheWrite1hInput: pricing.cacheWrite1hInputMicrosPerMillion };
}

function requestHasUnboundedInput(body: Record<string, unknown>): boolean {
  if (["previous_response_id", "conversation", "prompt"].some((key) => body[key] != null)) return true;
  if (body.input != null && contentHasUnboundedInput(body.input)) return true;
  if (Array.isArray(body.messages) && body.messages.some((message) => isObject(message) && contentHasUnboundedInput(message.content))) return true;
  return Array.isArray(body.tools) && body.tools.some((tool) => isObject(tool) && providerAddedTool(tool.type));
}

function contentHasUnboundedInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(contentHasUnboundedInput);
  if (!isObject(value)) return false;
  const kind = typeof value.type === "string" ? value.type : "";
  if (["image", "image_url", "document", "file", "input_image", "input_file", "item_reference", "computer_screenshot"].includes(kind)) return true;
  if ("image_url" in value || "file_id" in value) return true;
  return Object.values(value).some(contentHasUnboundedInput);
}

function providerAddedTool(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith("web_fetch_") || ["bash_", "text_editor_", "computer_", "memory_"].some((prefix) => value.startsWith(prefix));
}

function jsonHasKey(value: unknown, target: string): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonHasKey(item, target));
  return isObject(value) && (target in value || Object.values(value).some((item) => jsonHasKey(item, target)));
}

function jsonHasCacheTtl(value: unknown, ttl: string): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonHasCacheTtl(item, ttl));
  if (!isObject(value)) return false;
  if (isObject(value.cache_control) && value.cache_control.ttl === ttl) return true;
  return Object.values(value).some((item) => jsonHasCacheTtl(item, ttl));
}

function weightedTokenCost(components: Array<[number, number]>): number {
  return Math.ceil(components.reduce((total, [tokens, rate]) => total + tokens * rate, 0) / 1_000_000);
}

function tokenCost(tokens: number, rate: number): number { return Math.ceil(tokens * rate / 1_000_000); }
function nonNegativeInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function saturatingAdd(left: number, right: number): number { return Math.min(Number.MAX_SAFE_INTEGER, left + right); }
function saturatingMultiply(left: number, right: number): number { return left === 0 || right === 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, left * right); }
function maxOptional(left: number | null, right: number | null): number | null { return left == null ? right : right == null ? left : Math.max(left, right); }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
