import type { UsageTokens } from "./token-usage.ts";

export type DecisionJson = null | boolean | number | string | DecisionJson[] | { [key: string]: DecisionJson };
export type DecisionEntry = string | DecisionJson[] | { [key: string]: DecisionJson } | null;
export function requireDecision(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`invalid_decision_${field}`);
}
export function decisionRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function decisionProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function decisionJson(value: unknown, depth = 0): value is DecisionJson {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => decisionJson(item, depth + 1));
  const object = decisionRecord(value);
  return !!object && Object.values(object).every(item => decisionJson(item, depth + 1));
}
export function decisionEntry(value: unknown): value is DecisionEntry {
  return (value === null || typeof value === "string" || typeof value === "object") && decisionJson(value);
}
export function decisionBody(value: unknown, limit = 4 * 1024 * 1024): Record<string, unknown> {
  const body = decisionRecord(value);
  requireDecision(body && decisionJson(body), "body");
  requireDecision(new TextEncoder().encode(JSON.stringify(body)).length < limit, "body_limit");
  return body;
}
export function decisionKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function sameDecisionJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameDecisionJson(value, right[index]));
  const a = decisionRecord(left), b = decisionRecord(right);
  return !!a && !!b && decisionKeys(a, Object.keys(b)) && Object.keys(a).every(key => sameDecisionJson(a[key], b[key]));
}
export function decisionUsage(value: unknown): UsageTokens | null {
  const usage = decisionRecord(value), input = usage?.input_tokens, output = usage?.output_tokens;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 || !Number.isSafeInteger(input + output)) return null;
  return { input, output, total: input + output, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
}
