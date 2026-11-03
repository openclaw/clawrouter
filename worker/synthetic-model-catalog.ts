import { HttpError } from "./utils";

export interface SyntheticModelRow {
  id: string;
  name: string;
  context_length: number;
  input_modalities: string[];
  output_modalities: string[];
  max_output_length?: number;
  supported_features?: string[];
  reasoning_parameters?: { efforts: string[] };
  pricing?: Partial<Record<"prompt" | "completion" | "input_cache_reads" | "input_cache_writes", string>>;
}

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Synthetic model metadata is invalid or exceeds the discovery scan bound");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max && !/[\p{Cc}]/u.test(normalized) ? normalized : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const result = value.map(item => text(item, 128));
  return result.every((item): item is string => item !== null) ? [...new Set(result)] : undefined;
}

// The native API returns {data:[...]} without OpenAI object tags. This codec
// belongs only to synthetic.models; it does not relax openai.models validation.
export function filterSyntheticModels(payload: unknown, allows: (id: string) => boolean): { data: SyntheticModelRow[] } {
  const envelope = record(payload);
  if (!envelope || !Array.isArray(envelope.data) || envelope.data.length > 4096
    || envelope.object !== undefined && envelope.object !== "list") invalid();
  const models = new Map<string, SyntheticModelRow>();
  for (const value of envelope.data) {
    const row = record(value), id = text(row?.id, 512);
    if (!row || !id || /\s/u.test(id)) invalid();
    const input = strings(row.input_modalities), output = strings(row.output_modalities);
    if (row.deprecated === true || row.active === false || !positiveInteger(row.context_length)
      || row.deprecated !== undefined && typeof row.deprecated !== "boolean"
      || row.active !== undefined && typeof row.active !== "boolean"
      || !input?.includes("text") || !output?.includes("text") || !allows(id)) continue;
    if (models.has(id)) invalid();
    const model: SyntheticModelRow = {
      id, name: text(row.name, 512) ?? id, context_length: row.context_length,
      input_modalities: input, output_modalities: output,
    };
    // Missing limits/features/prices remain absent. No frozen limit or zero-cost fallback.
    if (positiveInteger(row.max_output_length)) model.max_output_length = Math.min(row.max_output_length, row.context_length);
    const features = strings(row.supported_features), efforts = strings(record(row.reasoning_parameters)?.efforts);
    if (features !== undefined) model.supported_features = features;
    if (efforts !== undefined) model.reasoning_parameters = { efforts };
    const pricing = record(row.pricing), observed: NonNullable<SyntheticModelRow["pricing"]> = {};
    for (const key of ["prompt", "completion", "input_cache_reads", "input_cache_writes"] as const) {
      const rate = pricing?.[key];
      if (typeof rate === "string" && /^\$?(?:0|[1-9]\d{0,5})(?:\.\d{1,18})?$/.test(rate)) observed[key] = rate;
    }
    if (Object.keys(observed).length) model.pricing = observed;
    models.set(id, model);
  }
  return { data: [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
