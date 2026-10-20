import type { ImageTokenPricing } from "./types";
import type { UsageTokens } from "./token-usage.ts";
import { HttpError } from "./utils.ts";

const fields = new Set(["model", "prompt", "n", "size", "quality", "background", "output_format", "output_compression", "moderation", "safety_identifier", "user", "stream"]);

// JSON generation only. Unknown options cannot silently escape the reservation
// contract; edits, hosted tools and partial-image SSE are distinct surfaces.
export function validateImageGeneration(body: Record<string, unknown>, pricing: ImageTokenPricing): void {
  const fail = (message: string): never => { throw new HttpError(400, "invalid_image_generation", message); };
  if (Object.keys(body).some(key => !fields.has(key))) fail("unsupported image generation option; streaming and partial_images are not supported");
  if (body.stream !== undefined && body.stream !== false) fail("image streaming is not supported; use JSON generation");
  const limits = pricing.generation;
  if (typeof body.prompt !== "string" || !body.prompt.length || [...body.prompt].length > limits.maxPromptCharacters) fail("image prompt must be a nonempty string of at most " + limits.maxPromptCharacters + " Unicode code points");
  if (body.n !== undefined && (!Number.isSafeInteger(body.n) || Number(body.n) < 1 || Number(body.n) > limits.maxImages)) fail("image n must be an integer from 1 to " + limits.maxImages);
  const option = (key: string, values: string[]) => { if (body[key] !== undefined && !values.includes(body[key] as string)) fail("unsupported image " + key); };
  option("quality", [...Object.keys(limits.outputTokenBound.qualityFactors), "auto"]);
  option("background", ["auto", "opaque", "transparent"]);
  option("output_format", ["png", "jpeg", "webp"]);
  option("moderation", ["auto", "low"]);
  if (body.background === "transparent" && body.output_format === "jpeg") fail("transparent output requires PNG or WebP");
  if (body.output_compression !== undefined && (!Number.isSafeInteger(body.output_compression) || Number(body.output_compression) < 0 || Number(body.output_compression) > 100 || !["jpeg", "webp"].includes(body.output_format as string))) fail("compression requires JPEG or WebP and an integer from 0 to 100");
  for (const key of ["safety_identifier", "user"]) if (body[key] !== undefined && (typeof body[key] !== "string" || [...body[key] as string].length > 128)) fail("image safety identifier must be at most 128 characters");
  if (body.size !== undefined && body.size !== "auto") {
    const dimensions = typeof body.size === "string" && /^(\d{1,4})x(\d{1,4})$/.exec(body.size);
    if (!dimensions) return fail("image size must be auto or WIDTHxHEIGHT");
    const width = Number(dimensions[1]), height = Number(dimensions[2]), pixels = width * height;
    if (!width || !height || width % limits.dimensionMultiple || height % limits.dimensionMultiple || Math.max(width, height) > limits.maxEdge || Math.max(width, height) / Math.min(width, height) > limits.maxAspectRatio || pixels < limits.minPixels || pixels > limits.maxPixels) fail("image dimensions exceed the qualified bounds");
  }
}

export function estimateImageCost(pricing: ImageTokenPricing, body: Record<string, unknown>) {
  const limits = pricing.generation, bound = limits.outputTokenBound;
  const n = typeof body.n === "number" && Number.isSafeInteger(body.n) && body.n >= 1 && body.n <= limits.maxImages ? body.n : body.n === undefined && Object.keys(body).length ? 1 : limits.maxImages;
  const quality = typeof body.quality === "string" && Object.hasOwn(bound.qualityFactors, body.quality) ? bound.qualityFactors[body.quality] : undefined;
  const factor = quality ?? Math.max(...Object.values(bound.qualityFactors));
  // The calculator rounds the short-axis factor to even. Each axis is at most
  // factor, so factor^2 at the maximum pixel count bounds every valid dimension,
  // including auto. Never use the older GPT Image 2 coefficients for 2.5.
  const perImage = Math.ceil(factor * factor * (bound.basePixels + limits.maxPixels) / bound.divisor);
  // Reserve each prompt per image; UTF-8 bytes bound tokenizer input. Extra
  // framing allowance is admission headroom, not fabricated billable usage.
  const bytes = typeof body.prompt === "string" ? new TextEncoder().encode(body.prompt).byteLength : limits.maxPromptCharacters * 4;
  const inputTokens = (bytes + 1024) * n, outputTokens = perImage * n;
  return { reserveMicros: Math.ceil((inputTokens * pricing.textInputMicrosPerMillion + outputTokens * pricing.imageOutputMicrosPerMillion) / 1_000_000), inputTokens, outputTokens };
}

// Direct Images requests do not receive cached-input pricing for these models.
// Preserve the modality split; chat-shaped or inconsistent usage cannot settle
// this tariff. GPT Image 2.5 does not bill text output if it is reported.
export function extractImageUsageTokens(value: unknown): UsageTokens | null {
  const usage = record(record(value)?.usage), details = record(usage?.input_tokens_details), output = record(usage?.output_tokens_details);
  if (!usage || !details) return null;
  const input = counter(usage.input_tokens), total = counter(usage.total_tokens), generated = counter(usage.output_tokens);
  const textInput = counter(details.text_tokens), imageInput = counter(details.image_tokens);
  const imageOutput = output ? counter(output.image_tokens) : generated;
  const textOutput = output ? counter(output.text_tokens) : 0;
  if (input == null || generated == null || total == null || textInput == null || imageInput == null || imageOutput == null || textOutput == null || input !== textInput + imageInput || generated !== imageOutput + textOutput || total !== input + generated) return null;
  return { input, output: generated, total, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null, image: { textInput, imageInput, imageOutput } };
}

export function actualImageCost(pricing: ImageTokenPricing, tokens: Pick<UsageTokens, "image">): number | null {
  const image = tokens.image;
  return image ? Math.ceil((image.textInput * pricing.textInputMicrosPerMillion + image.imageInput * pricing.imageInputMicrosPerMillion + image.imageOutput * pricing.imageOutputMicrosPerMillion) / 1_000_000) : null;
}
function counter(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function record(value: unknown): Record<string, unknown> | null { return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
