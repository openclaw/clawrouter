// Price normalization and semantic checks after provider manifest schema validation.
const optionalRateFields = ["cachedInputMicrosPerMillion", "cacheWriteInputMicrosPerMillion", "cacheWrite5mInputMicrosPerMillion", "cacheWrite1hInputMicrosPerMillion"];

export function normalizePricing(pricing) {
  if (pricing.unit === "image_token") return structuredClone(pricing);
  if (pricing.unit === "character") return { unit: pricing.unit, effectiveAt: pricing.effectiveAt, source: pricing.source, inputMicrosPerMillionCharacters: pricing.inputMicrosPerMillionCharacters, maxInputCharacters: pricing.maxInputCharacters };
  return {
    effectiveAt: pricing.effectiveAt,
    ...(pricing.checkedAt ? { checkedAt: pricing.checkedAt } : {}),
    source: pricing.source,
    ...normalizeRates(pricing),
    maxInputTokens: pricing.maxInputTokens,
    maxRequestInputTokens: pricing.maxRequestInputTokens ?? null,
    defaultMaxOutputTokens: pricing.defaultMaxOutputTokens,
    inputTokenOverhead: pricing.inputTokenOverhead ?? 1024,
    ...(pricing.unpricedCosts ? { unpricedCosts: pricing.unpricedCosts } : {}),
    ...(pricing.settlementBasis ? { settlementBasis: pricing.settlementBasis } : {}),
    ...(pricing.autoServiceTier ? { autoServiceTier: pricing.autoServiceTier } : {}),
    ...(pricing.anthropicModifiers ? { anthropicModifiers: structuredClone(pricing.anthropicModifiers) } : {}),
    longContext: normalizeLongContext(pricing.longContext),
    ...(pricing.serviceTiers ? { serviceTiers: pricing.serviceTiers.map((tier) => ({ id: tier.id, aliases: tier.aliases ?? [], ...normalizeRates(tier), maxInputTokens: tier.maxInputTokens ?? null, longContext: normalizeLongContext(tier.longContext) })) } : {}),
  };
}

function normalizeRates(value) {
  return { inputMicrosPerMillion: value.inputMicrosPerMillion, outputMicrosPerMillion: value.outputMicrosPerMillion, ...Object.fromEntries(optionalRateFields.map((field) => [field, value[field] ?? null])) };
}

function normalizeLongContext(value) {
  return value ? { thresholdInputTokens: value.thresholdInputTokens, ...normalizeRates(value) } : null;
}

export function validatePricing(pricing, modelId) {
  if (!pricing) return;
  if (pricing.unit === "image_token") {
    const g = pricing.generation, b = g.outputTokenBound;
    const maxFactor = Math.max(...Object.values(b.qualityFactors));
    const output = Math.ceil(maxFactor * maxFactor * (b.basePixels + g.maxPixels) / b.divisor) * g.maxImages;
    const input = (g.maxPromptCharacters * 4 + 1024) * g.maxImages;
    if (g.minPixels > g.maxPixels || g.maxEdge % g.dimensionMultiple || !Number.isSafeInteger(output * pricing.imageOutputMicrosPerMillion + input * pricing.textInputMicrosPerMillion)) throw new Error("image pricing has an invalid reservation envelope");
    return;
  }
  if (pricing.longContext && pricing.longContext.thresholdInputTokens >= pricing.maxInputTokens) throw new Error(`model ${modelId} has an invalid long-context threshold`);
  if (pricing.autoServiceTier && !pricing.serviceTiers?.length) throw new Error(`model ${modelId} autoServiceTier requires explicit service-tier cards`);
  if (pricing.serviceTiers === undefined) return;
  const tiers = pricing.serviceTiers;
  const fail = (message) => { throw new Error(`model ${modelId} serviceTiers ${message}`); };
  const ids = new Set();
  for (const tier of tiers) {
    for (const id of [tier.id, ...(tier.aliases ?? [])]) {
      if (id === "auto" || ids.has(id)) fail("ids and aliases must be unique bounded wire values other than auto");
      ids.add(id);
    }
    if (tier.maxInputTokens != null && tier.maxInputTokens > pricing.maxInputTokens) fail("has an invalid input limit");
    if (tier.longContext && tier.longContext.thresholdInputTokens >= (tier.maxInputTokens ?? pricing.maxInputTokens)) fail("has an invalid long-context threshold");
  }
  const standard = tiers.find((tier) => tier.id === "default");
  if (!standard || standard.maxInputTokens != null || JSON.stringify(normalizeRates(standard)) !== JSON.stringify(normalizeRates(pricing)) || JSON.stringify(normalizeLongContext(standard.longContext)) !== JSON.stringify(normalizeLongContext(pricing.longContext))) fail("default card must match the canonical model rates and context");
}
