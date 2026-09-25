import type { CharacterPricing, CompiledEndpoint, ModelPricing, ServiceTierPricing, TokenPricing, TokenRates } from "./types";
import { googleField, googleInt32, googleRequestServiceTier, googleServiceTier } from "./google-protocol.ts";
import type { ToolKnowledge } from "./responses-tool-evidence.ts";

export interface CostEstimate {
  reserveMicros: number;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingAvailable?: false;
}

export interface PricedTokens {
  serviceTier?: string | null;
  billable?: false;
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
  cacheWriteInput: number | null;
  cacheWrite5mInput: number | null;
  cacheWrite1hInput: number | null;
}

export type PricingGap = "model_request_fee" | "hosted_tool_fee" | "hosted_tool_usage" | "retained_tool_unknown";

export function requestPricingGap(pricing: ModelPricing | null | undefined, body: Record<string, unknown>, requestFormat: string, parentTools?: ToolKnowledge): PricingGap | null {
  if (pricing?.unit !== "character" && pricing?.unpricedCosts?.includes("request_fee")) return "model_request_fee";
  if (requestFormat === "openai.chat_completions" && isObject(body.web_search_options)) return "hosted_tool_fee";
  // Saved Responses prompts retain tools; an opaque reference cannot prove
  // that the effective request has only the declared token charges.
  if (requestFormat === "openai.responses" && body.prompt != null) return "hosted_tool_usage";
  if (requestFormat === "openai.responses" && isObject(body.multi_agent) && body.multi_agent.enabled === true) return "hosted_tool_usage";
  if (requestFormat === "anthropic.messages" && Array.isArray(body.mcp_servers) && body.mcp_servers.length) return "hosted_tool_usage";
  // Claude bills compaction iterations outside the ordinary top-level usage.
  if (requestFormat === "anthropic.messages" && (isObject(body.compaction) && body.compaction.type === "summarize"
    || isObject(body.context_management) && Array.isArray(body.context_management.edits) && body.context_management.edits.some((edit) => isObject(edit) && edit.type === "compact_20260112"))) return "hosted_tool_usage";
  // CachedContent retains tools and toolConfig. The reference alone cannot
  // prove that generation has only the token costs represented by this card.
  if (requestFormat === "google.generate_content" && googleField(body, "cachedContent", "cached_content") != null) return "hosted_tool_usage";
  // Responses Lite and tool search load executable declarations through tagged
  // input items. Do not search ordinary output data, content, or function schemas.
  const inputTools = requestFormat === "openai.responses" && Array.isArray(body.input)
    ? body.input.flatMap((item) => isObject(item) && (item.type === "additional_tools" || item.type === "tool_search_output") && Array.isArray(item.tools) ? item.tools : []) : [];
  const current = hostedToolPricingGap((Array.isArray(body.tools) ? body.tools : []).concat(inputTools), requestFormat);
  if (current) return current;
  if (requestFormat !== "openai.responses" || typeof body.previous_response_id !== "string" || body.previous_response_id === "") return null;
  // A response ID can retain executable declarations omitted from this delta.
  // Only final parent knowledge proves ordinary token pricing; omission is unknown.
  return parentTools === "token_only" ? null : parentTools === "hosted_tool_fee" || parentTools === "hosted_tool_usage" ? parentTools : "retained_tool_unknown";
}

// Classify known executable declarations only. A null result does not attest
// that an unknown or partially observed tool inventory is complete.
export function hostedToolPricingGap(tools: readonly unknown[], requestFormat: string): "hosted_tool_fee" | "hosted_tool_usage" | null {
  let usageGap = false;
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    // Inspect protocol declarations, never function names or user JSON schemas.
    if (requestFormat === "openai.responses" && typeof tool.type === "string") {
      if (/^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type) || ["file_search", "code_interpreter", "image_generation"].includes(tool.type)) return "hosted_tool_fee";
      if (tool.type === "shell" && isObject(tool.environment) && ["container_auto", "container_reference"].includes(String(tool.environment.type))) return "hosted_tool_fee";
      // Hosted search has no qualified cumulative bound; this is not a fee claim.
      if (["mcp", "programmatic_tool_calling"].includes(tool.type) || tool.type === "tool_search" && tool.execution !== "client") usageGap = true;
    }
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && /^web_search_\d{8}$/.test(tool.type)) return "hosted_tool_fee";
    // Anthropic waives execution fees when these web-tool versions are present.
    // Their search fee, when applicable, is still handled by the branch above.
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && /^code_execution_\d{8}$/.test(tool.type) && !tools.some((candidate) => isObject(candidate) && typeof candidate.type === "string" && /^web_(?:search|fetch)_\d{8}$/.test(candidate.type) && candidate.type.slice(-8) >= "20260209")) return "hosted_tool_fee";
    // A waived execution fee does not bound accumulated server-loop input.
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && (/^(?:web_fetch|code_execution)_\d{8}$/.test(tool.type) || /^(?:tool_search_tool_regex|tool_search_tool_bm25)(?:_20251119)?$/.test(tool.type) || ["advisor_20260301", "mcp_toolset"].includes(tool.type))) usageGap = true;
    if (requestFormat === "google.generate_content") {
      if ([["googleSearch", "google_search"], ["googleSearchRetrieval", "google_search_retrieval"], ["googleMaps", "google_maps"]].some(([camel, proto]) => isObject(googleField(tool, camel, proto)))) return "hosted_tool_fee";
      // These tools have token charges rather than a flat tool fee, but their
      // server-side work is not covered by our ordinary prompt/output bounds.
      if ([["urlContext", "url_context"], ["fileSearch", "file_search"], ["codeExecution", "code_execution"]].some(([camel, proto]) => isObject(googleField(tool, camel, proto)))) usageGap = true;
      const servers = googleField(tool, "mcpServers", "mcp_servers");
      if (Array.isArray(servers) && servers.length) usageGap = true;
    }
  }
  return usageGap ? "hosted_tool_usage" : null;
}

export type PricingEndpoint = Pick<CompiledEndpoint, "request_format" | "outputTokenLimit">;

export function estimateModelCost(pricing: ModelPricing, body: Record<string, unknown>, endpoint?: PricingEndpoint): CostEstimate {
  if (pricing.unit === "character") {
    // UTF-8 bytes bound code points without assuming an upstream tokenizer.
    // Empty catalog probes retain the full bounded envelope; dispatch validates input.
    const bytes = typeof body.input === "string" ? new TextEncoder().encode(body.input).byteLength : pricing.maxInputCharacters * 4;
    return { reserveMicros: characterCost(bytes, pricing), inputTokens: null, outputTokens: null };
  }
  const google = endpoint?.request_format === "google.generate_content";
  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  const inputLimit = pricing.maxRequestInputTokens ?? pricing.maxInputTokens;
  const inputTokens = (google ? googleHasUnboundedInput(body) : requestHasUnboundedInput(body))
    ? inputLimit
    : Math.min(inputLimit, saturatingAdd(bytes, pricing.inputTokenOverhead));
  const config = google ? googleField(body, "generationConfig", "generation_config") : undefined;
  // Native maxOutputTokens includes both thoughts and visible candidate tokens.
  // Only the selected wire format decides which caller limits are meaningful.
  const requestedOutput = (google ? [googleInt32(googleField(config, "maxOutputTokens", "max_output_tokens"))] : [body.max_output_tokens, body.max_completion_tokens, body.max_tokens])
    .map(nonNegativeInteger)
    .filter((value): value is number => value != null);
  const choices = Math.max(1, (google ? googleInt32(googleField(config, "candidateCount", "candidate_count")) : nonNegativeInteger(body.n)) ?? 1);
  const limit = endpoint?.outputTokenLimit;
  const declaredOutput = limit ? nonNegativeInteger(body[limit.field]) : null;
  // Undocumented aliases and malformed/omitted limits cannot lower a declared
  // endpoint bound. This qualifies the estimate; the upstream body is unchanged.
  const output = limit ? declaredOutput != null && declaredOutput >= limit.minimum && declaredOutput <= limit.maximum ? declaredOutput : limit.maximum
    : requestedOutput.length ? Math.max(...requestedOutput) : pricing.defaultMaxOutputTokens;
  const outputTokens = saturatingMultiply(output, choices);
  const rates = resolveRates(pricing, inputTokens, google ? googleRequestServiceTier(body) : body.service_tier, true, google);
  if (!rates) return { reserveMicros: 0, inputTokens, outputTokens, pricingAvailable: false };
  const inputRate = reservationInputRate(body, rates);
  return {
    reserveMicros: saturatingAdd(tokenCost(inputTokens, inputRate), tokenCost(outputTokens, rates.output)),
    inputTokens,
    outputTokens,
  };
}

// Bounds without a request: inspect every declared tier/context, including cache
// rates. A zero balance alone cannot exclude output-only or zero-price requests.
export function modelReservationBounds(pricing: ModelPricing): { minimumMicros: number; zero: boolean } {
  if (pricing.unit === "character") return { minimumMicros: characterCost(1, pricing), zero: pricing.inputMicrosPerMillionCharacters === 0 };
  const cards = pricing.serviceTiers?.length ? pricing.serviceTiers : [pricing];
  const rates = cards.flatMap((card) => [card, ...(card.longContext ? [card.longContext] : [])]).map(ratesFromPricing);
  const zero = rates.every((rate) => Object.values(rate).every((value) => value == null || value === 0));
  return { minimumMicros: rates.every((rate) => reservationInputRate({}, rate) > 0) ? 1 : 0, zero };
}

export function actualModelCost(pricing: ModelPricing, tokens: PricedTokens, requestFormat?: string): number | null {
  if (pricing.unit === "character") return null;
  if (tokens.billable === false) return 0;
  if (tokens.input == null) return null;
  const rates = resolveRates(pricing, tokens.input, tokens.serviceTier, false, requestFormat === "google.generate_content");
  if (!rates) return null;
  if (tokens.output == null && rates.output > 0) return null;
  if (rates.cacheWriteInput != null && tokens.cacheWrite == null) return null;
  const cached = Math.min(tokens.input, tokens.cached ?? 0);
  let remaining = Math.max(0, tokens.input - cached);
  const write5m = Math.min(remaining, tokens.cacheWrite5m ?? 0); remaining -= write5m;
  const write1h = Math.min(remaining, tokens.cacheWrite1h ?? 0); remaining -= write1h;
  const genericWrite = Math.min(remaining, Math.max(0, (tokens.cacheWrite ?? 0) - write5m - write1h)); remaining -= genericWrite;
  const write5mRate = rates.cacheWrite5mInput ?? rates.input;
  const write1hRate = rates.cacheWrite1hInput ?? write5mRate;
  const genericWriteRate = rates.cacheWriteInput ?? Math.max(write5mRate, write1hRate);
  return weightedTokenCost([
    [remaining, rates.input],
    [cached, rates.cachedInput ?? rates.input],
    [write5m, write5mRate],
    [write1h, write1hRate],
    [genericWrite, genericWriteRate],
    [tokens.output ?? 0, rates.output],
  ]);
}

export function actualCharacterCost(pricing: ModelPricing | null | undefined, input: unknown): number | null {
  return pricing?.unit === "character" && typeof input === "string"
    ? characterCost([...input].length, pricing) : null;
}

function characterCost(characters: number, pricing: CharacterPricing): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(characters * pricing.inputMicrosPerMillionCharacters / 1_000_000));
}

// Requested tiers choose admission bounds; only the served tier can choose a
// settlement price. OpenAI omitted/auto requests can inherit a paid default;
// native Gemini defaults to Standard and never upgrades Flex.
function resolveRates(pricing: TokenPricing, inputTokens: number, tier: unknown, reserve: boolean, google = false): Rates | null {
  if (google) {
    tier = googleServiceTier(tier);
    if (tier == null) return null;
  }
  const tiers = pricing.serviceTiers;
  if (!tiers?.length) return !google || tier === "standard" ? contextRates(pricing, inputTokens, reserve) : null;
  const selected = tiers.find((card) => card.id === tier || card.aliases.includes(tier as string));
  if (!reserve) return selected && (selected.maxInputTokens == null || inputTokens <= selected.maxInputTokens)
    ? contextRates(selected, inputTokens, false) : null;
  if (tier != null && tier !== "auto" && !selected) return null;
  const candidates = selected ? tiers.filter((card) => card === selected || ((!google || tier === "priority") && card.id === "default")) : tiers;
  // A byte upper bound may cross a tier's published context limit while actual
  // tokens do not. Its short rates must remain in the admission envelope.
  return candidates.map((card) => contextRates(card, Math.min(inputTokens, card.maxInputTokens ?? inputTokens), true)).reduce(maxRates);
}

function contextRates(pricing: Pick<TokenPricing, keyof TokenRates | "longContext"> | ServiceTierPricing, inputTokens: number, reserve: boolean): Rates {
  const base = ratesFromPricing(pricing), long = pricing.longContext;
  if (!long || inputTokens <= long.thresholdInputTokens) return base;
  const extended = ratesFromPricing(long);
  return reserve ? maxRates(base, extended) : extended;
}

function maxRates(base: Rates, extended: Rates): Rates {
  return {
    input: Math.max(base.input, extended.input),
    output: Math.max(base.output, extended.output),
    cachedInput: maxOptional(base.cachedInput, extended.cachedInput),
    cacheWriteInput: maxOptional(base.cacheWriteInput, extended.cacheWriteInput),
    cacheWrite5mInput: maxOptional(base.cacheWrite5mInput, extended.cacheWrite5mInput),
    cacheWrite1hInput: maxOptional(base.cacheWrite1hInput, extended.cacheWrite1hInput),
  };
}

function reservationInputRate(body: unknown, rates: Rates): number {
  let rate = Math.max(rates.input, rates.cachedInput ?? rates.input, rates.cacheWriteInput ?? rates.input);
  if (jsonHasCacheTtl(body, "1h")) return Math.max(rate, rates.cacheWrite1hInput ?? rates.input);
  if (jsonHasKey(body, "cache_control")) rate = Math.max(rate, rates.cacheWrite5mInput ?? rates.input);
  return rate;
}

function ratesFromPricing(pricing: TokenRates): Rates {
  return { input: pricing.inputMicrosPerMillion, output: pricing.outputMicrosPerMillion, cachedInput: pricing.cachedInputMicrosPerMillion, cacheWriteInput: pricing.cacheWriteInputMicrosPerMillion, cacheWrite5mInput: pricing.cacheWrite5mInputMicrosPerMillion, cacheWrite1hInput: pricing.cacheWrite1hInputMicrosPerMillion };
}

function requestHasUnboundedInput(body: Record<string, unknown>): boolean {
  if (["previous_response_id", "conversation", "prompt"].some((key) => body[key] != null)) return true;
  if (body.input != null && contentHasUnboundedInput(body.input)) return true;
  if (Array.isArray(body.messages) && body.messages.some((message) => isObject(message) && contentHasUnboundedInput(message.content))) return true;
  return Array.isArray(body.tools) && body.tools.some((tool) => isObject(tool) && providerAddedTool(tool.type));
}

function googleHasUnboundedInput(body: Record<string, unknown>): boolean {
  if (googleField(body, "cachedContent", "cached_content")) return true;
  return googleContentHasMedia(body.contents) || googleContentHasMedia(googleField(body, "systemInstruction", "system_instruction"));
}

function googleContentHasMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(googleContentHasMedia);
  if (!isObject(value) || !Array.isArray(value.parts)) return false;
  return value.parts.some(part => isObject(part) && (
    googleField(part, "fileData", "file_data") != null || googleField(part, "inlineData", "inline_data") != null
    || googleContentHasMedia(googleField(part, "functionResponse", "function_response"))
  ));
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
