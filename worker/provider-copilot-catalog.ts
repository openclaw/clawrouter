import { copilotModelFormats, isCopilotCatalogModelVisible } from "./provider-copilot.ts";
import { inspectCopilotJsonText } from "./copilot-json-guard.ts";

const maxRows = 4096;

type CopilotModelLimits = Readonly<{
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
}>;
type CopilotModelSupports = Readonly<{
  vision?: boolean;
  tool_calls?: boolean;
  streaming?: boolean;
  reasoning_effort?: readonly string[] | null;
}>;
export type CopilotModelRow = Readonly<{
  id: string;
  name?: string;
  vendor?: string;
  object?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  model_picker_category?: string;
  policy?: Readonly<{ state?: string }>;
  supported_endpoints?: readonly string[];
  capabilities?: Readonly<{ type?: string; limits?: CopilotModelLimits; supports?: CopilotModelSupports }>;
}>;
export type CopilotModelCatalog = Readonly<{ data: readonly CopilotModelRow[] }>;

function invalid(): never { throw new Error("invalid_copilot_model_catalog"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) invalid();
  return value;
}
function optionalBoolean(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") invalid();
  return value;
}
function optionalString(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== "string") invalid();
  return value;
}
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function observedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preparse(text: string): void {
  try { inspectCopilotJsonText(text, "catalog"); } catch { invalid(); }
}

function limits(value: unknown): CopilotModelLimits | undefined {
  if (value === undefined) return;
  const input = object(value);
  const output: { max_context_window_tokens?: number; max_prompt_tokens?: number; max_output_tokens?: number } = {};
  for (const key of ["max_context_window_tokens", "max_prompt_tokens", "max_output_tokens"] as const) {
    const fact = positive(input[key]);
    if (fact !== undefined) output[key] = fact;
  }
  return Object.freeze(output);
}
function supports(value: unknown): CopilotModelSupports | undefined {
  if (value === undefined) return;
  const input = object(value);
  const output: { vision?: boolean; tool_calls?: boolean; streaming?: boolean; reasoning_effort?: readonly string[] | null } = {};
  for (const key of ["vision", "tool_calls", "streaming"] as const) {
    const fact = optionalBoolean(input[key]);
    if (fact !== undefined) output[key] = fact;
  }
  const efforts = input.reasoning_effort;
  if (efforts === null) output.reasoning_effort = null;
  else if (efforts !== undefined) {
    if (!Array.isArray(efforts) || !efforts.every((effort): effort is string => typeof effort === "string")) invalid();
    output.reasoning_effort = Object.freeze([...new Set(efforts.map(effort => effort.trim().toLowerCase()).filter(Boolean))]);
  }
  return Object.freeze(output);
}

function normalize(value: Record<string, unknown>, id: string): CopilotModelRow {
  const row: {
    id: string; name?: string; vendor?: string; object?: string; preview?: boolean;
    model_picker_enabled?: boolean; model_picker_category?: string;
    policy?: Readonly<{ state?: string }>; supported_endpoints?: readonly string[];
    capabilities?: Readonly<{ type?: string; limits?: CopilotModelLimits; supports?: CopilotModelSupports }>;
  } = { id };
  for (const key of ["name", "vendor", "model_picker_category"] as const) {
    const fact = observedText(value[key]);
    if (fact !== undefined) row[key] = fact;
  }
  for (const key of ["preview", "model_picker_enabled"] as const) {
    const fact = optionalBoolean(value[key]);
    if (fact !== undefined) row[key] = fact;
  }
  const kind = optionalString(value.object);
  if (kind !== undefined) row.object = kind;
  if (value.policy !== undefined) {
    const policy = object(value.policy), state = optionalString(policy.state);
    row.policy = Object.freeze(state === undefined ? {} : { state: state.trim().toLowerCase() });
  }
  if (value.supported_endpoints !== undefined) {
    const endpoints = value.supported_endpoints;
    if (!Array.isArray(endpoints) || !endpoints.every((endpoint): endpoint is string => typeof endpoint === "string")) invalid();
    row.supported_endpoints = Object.freeze([...endpoints]);
  }
  if (value.capabilities !== undefined) {
    const input = object(value.capabilities), type = optionalString(input.type);
    const observedLimits = limits(input.limits), observedSupports = supports(input.supports);
    row.capabilities = Object.freeze({ ...(type === undefined ? {} : { type }),
      ...(observedLimits === undefined ? {} : { limits: observedLimits }),
      ...(observedSupports === undefined ? {} : { supports: observedSupports }) });
  }
  return Object.freeze(row);
}

// Pure candidate projection only. The original owner must freshly authorize
// publication with filterCopilotModels/current policy after the complete read.
export function decodeCopilotModelCatalog(text: string): CopilotModelCatalog {
  preparse(text);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { invalid(); }
  const envelope = object(payload);
  if (!Array.isArray(envelope.data) || envelope.data.length > maxRows) invalid();
  const seen = new Set<string>(), data: CopilotModelRow[] = [];
  for (const value of envelope.data) {
    const input = object(value);
    if (typeof input.id !== "string") invalid();
    const id = input.id.trim();
    if (!id || id.length > 512 || seen.has(id)) invalid();
    seen.add(id);
    // Validate every row before exclusion: hidden/foreign objects cannot hide
    // malformed authority containers or a duplicate normalized identity.
    const row = normalize(input, id);
    if (row.object !== undefined && row.object !== "model" || row.capabilities?.type !== undefined && row.capabilities.type !== "chat" || id.startsWith("accounts/")) continue;
    if (!isCopilotCatalogModelVisible(row) || !copilotModelFormats(row).length) continue;
    data.push(row);
  }
  return Object.freeze({ data: Object.freeze(data) });
}
