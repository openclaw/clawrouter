import { knownBasisClasses } from "./usage-report-cost.ts";

/** Request formats that are utility calls; shared by projectUsageEvent and its SQL twin. */
export const utilityFormats = new Set(["openai.models", "anthropic.models", "openai.responses_input_tokens", "anthropic.count_tokens", "openai.moderations"]);

const counterFields = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens", "actual_cost_micros", "reporting_known_cost_micros", "reporting_estimated_cost_micros"];
const textFields = ["model", "credential_id", "cost_basis", "grant_lane", "request_format", "capability", "reporting_estimate_reason"];
const jsonText = (json: string, field: string) => "CASE WHEN json_valid(" + json + ") THEN CASE WHEN json_type(" + json + ", '$." + field + "') = 'text' THEN json_extract(" + json + ", '$." + field + "') END END";
const jsonCounter = (json: string, field: string) => {
  const value = "json_extract(" + json + ", '$." + field + "')";
  return "CASE WHEN json_valid(" + json + ") THEN CASE WHEN json_type(" + json + ", '$." + field + "') IN ('integer', 'real') AND " + value + " BETWEEN 0 AND 9007199254740991 AND " + value + " = CAST(" + value + " AS INTEGER) THEN CAST(" + value + " AS INTEGER) END END";
};
/** Canonical columns plus scalar JSON fields of one ledger row (`row` is "" or "OLD."). */
export function twinOwnedColumns(row = ""): string {
  return ["id", "occurred_at_ms", "tenant_id", "policy_id", "principal_key", "provider", "status"].map(c => row + c + " AS " + c)
    .concat(counterFields.map(f => jsonCounter(row + "event_json", f) + " AS " + f), textFields.map(f => jsonText(row + "event_json", f) + " AS " + f)).join(", ");
}
const basisCase = "CASE cost_basis " + Object.entries(knownBasisClasses).map(([basis, cls]) => "WHEN '" + basis + "' THEN '" + cls + "'").join(" ") + " ELSE 'unknown' END";
const validated = "*, " + basisCase + " AS basis_class, " +
  "CASE WHEN cached_input_tokens <= input_tokens THEN cached_input_tokens END AS cache_read, " +
  "CASE WHEN cache_write_input_tokens <= input_tokens THEN cache_write_input_tokens END AS cache_write, " +
  "CASE WHEN reasoning_output_tokens <= output_tokens THEN reasoning_output_tokens END AS reasoning";
const classified = "*, CASE WHEN actual_cost_micros IS NULL OR (basis_class = 'no_charge' AND actual_cost_micros != 0) THEN 'unknown' " +
  "WHEN basis_class != 'unknown' THEN basis_class " +
  "WHEN substr(cost_basis, 1, 9) = 'unpriced_' AND reporting_known_cost_micros > 0 AND reporting_known_cost_micros <= actual_cost_micros THEN 'partial' " +
  "WHEN actual_cost_micros = 0 AND reporting_estimated_cost_micros IS NOT NULL AND reporting_estimate_reason != '' THEN 'estimated' ELSE 'unknown' END AS cost_class";
const source = "actual_cost_micros AS recorded_charge_micros, id, occurred_at_ms, tenant_id, policy_id, principal_key, provider, status, model, credential_id AS key_id, input_tokens, output_tokens, " +
  "CASE WHEN cache_read > input_tokens - cache_write THEN NULL ELSE cache_read END AS cached_input_tokens, " +
  "CASE WHEN cache_read > input_tokens - cache_write THEN NULL ELSE cache_write END AS cache_write_input_tokens, reasoning AS reasoning_output_tokens, " +
  "CASE WHEN request_format IN (" + [...utilityFormats].map(format => "'" + format + "'").join(", ") + ") OR (request_format = 'anthropic.messages' AND capability = 'llm.count_tokens') THEN 'utility' ELSE 'generation' END AS call_kind, " +
  "CASE grant_lane WHEN 'subscription' THEN 'subscription' WHEN 'api_key' THEN 'api' WHEN 'environment' THEN 'api' ELSE 'unattributed' END AS lane, cost_class, " +
  "CASE WHEN cost_class = 'unknown' THEN NULL WHEN basis_class = 'unknown' AND cost_class = 'partial' THEN reporting_known_cost_micros " +
  "WHEN basis_class = 'unknown' AND cost_class = 'estimated' THEN reporting_estimated_cost_micros ELSE actual_cost_micros END AS reporting_cost_micros";
/** Scalar-only SQL twin of projectUsageEvent as CTEs ending in `source`; `owned` selects twinOwnedColumns(). */
export function twinCte(owned: string): string {
  return "owned AS MATERIALIZED (" + owned + "), validated AS (SELECT " + validated + " FROM owned), classified AS (SELECT " + classified + " FROM validated), source AS (SELECT " + source + " FROM classified)";
}
/** The same twin as nested subqueries, for triggers (which cannot use CTEs). */
export function twinSubquery(owned: string): string {
  return "SELECT " + source + " FROM (SELECT " + classified + " FROM (SELECT " + validated + " FROM (" + owned + ")))";
}
/** Additive report counters of one twin/projection row, keyed by their response field names. */
export const reportCounters: ReadonlyArray<readonly [string, string]> = [
  ["calls", "1"], ["generationCalls", "call_kind = 'generation'"], ["utilityCalls", "call_kind = 'utility'"],
  ["successfulCalls", "status = 'success'"], ["errorCalls", "status NOT IN ('success', 'denied')"], ["deniedCalls", "status = 'denied'"],
  ["inputTokens", "COALESCE(input_tokens, 0)"], ["outputTokens", "COALESCE(output_tokens, 0)"], ["cachedInputTokens", "COALESCE(cached_input_tokens, 0)"],
  ["cacheWriteInputTokens", "COALESCE(cache_write_input_tokens, 0)"], ["reasoningOutputTokens", "COALESCE(reasoning_output_tokens, 0)"],
  ["inputReportedCalls", "input_tokens IS NOT NULL"], ["outputReportedCalls", "output_tokens IS NOT NULL"], ["cacheReadReportedCalls", "cached_input_tokens IS NOT NULL"],
  ["cacheWriteReportedCalls", "cache_write_input_tokens IS NOT NULL"], ["reasoningReportedCalls", "reasoning_output_tokens IS NOT NULL"],
  ["amountMicros", "COALESCE(reporting_cost_micros, 0)"], ["recordedChargeMicros", "COALESCE(recorded_charge_micros, 0)"], ["chargeReportedCalls", "recorded_charge_micros IS NOT NULL"],
];
