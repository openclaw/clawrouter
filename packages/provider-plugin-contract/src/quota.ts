import type { ProviderGrantKind as GrantKind } from "./products.ts";
import type { GrantAccount, GrantExtraUsage } from "./observations.ts";

// Compiled observation recipes, not polling or admission state.
export type GrantQuotaKind = "requests" | "tokens" | "input_tokens" | "output_tokens" | "credits" | "subscription" | "generic";
export interface CompiledQuotaWindow {
  id: string;
  kind: GrantQuotaKind;
  unit: string | null;
  window: string | null;
  limitHeaders: string[];
  remainingHeaders: string[];
  usedHeaders: string[];
  resetHeaders: string[];
  fixedLimit: number | null;
  metricScale: number;
}
export interface CompiledQuotaProbeWindow {
  models?: string[] | null;
  collection?: { pointer: string; filter: { pointer: string; equals: string }; modelPointer?: string } | null;
  id: string;
  kind: GrantQuotaKind;
  unit: string | null;
  window: string | null;
  limitPointer: string | null;
  remainingPointer: string | null;
  usedPointer: string | null;
  resetPointer: string | null;
  fixedLimit: number | null;
  metricScale: number;
}
export interface CompiledQuotaProbe {
  grantKinds: GrantKind[];
  requiresRefreshToken: boolean;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  windows: CompiledQuotaProbeWindow[];
  facts?: { account?: Partial<Record<keyof GrantAccount, string>>; extraUsage?: Partial<Record<keyof GrantExtraUsage, string>> };
}
export interface CompiledQuotaConfig { responseHeaders: CompiledQuotaWindow[]; probes: CompiledQuotaProbe[] }
