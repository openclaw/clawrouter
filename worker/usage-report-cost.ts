import type { UsageCostClass, UsageCostLane } from "../shared/usage-report.ts";
import type { UsageEvent } from "./types.ts";

/** Canonical complete-cost evidence. Shared with retained-ledger SQL classification. */
export const knownBasisClasses = Object.freeze({
  none: "no_charge",
  policy_fixed: "fixed",
  request_character_estimate: "estimated",
  manifest_reservation: "estimated",
  manifest_rate_upper_bound: "upper_bound",
  realtime_full_context_bound: "upper_bound",
  manifest_pricing: "calculated",
  realtime_modality_usage: "calculated",
  realtime_input_transcription_usage: "calculated",
} satisfies Record<string, UsageCostClass>);

const counter = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Evidence only: no repricing, reservation settlement, or budget authority. */
export function reportingCost(event: UsageEvent): { lane: UsageCostLane; costClass: UsageCostClass; amount: number | null } {
  const lane: UsageCostLane = event.grant_lane === "subscription" ? "subscription"
    : event.grant_lane === "api_key" || event.grant_lane === "environment" ? "api" : "unattributed";
  const basis = event.cost_basis;
  const canonicalClass = Object.hasOwn(knownBasisClasses, basis) ? knownBasisClasses[basis as keyof typeof knownBasisClasses] : "unknown";
  const actual = counter(event.actual_cost_micros);
  let costClass: UsageCostClass = actual === null || canonicalClass === "no_charge" && actual !== 0 ? "unknown" : canonicalClass;
  let amount = actual;
  // A retained reservation is not a measured component. Only the producer's
  // explicit marker can establish a partial amount under an unpriced basis.
  // Noncanonical partial/partial_usage labels alone establish nothing.
  const known = counter(event.reporting_known_cost_micros);
  if (costClass === "unknown" && typeof basis === "string" && basis.startsWith("unpriced_")
    && actual !== null && known !== null && known > 0 && known <= actual) {
    costClass = "partial";
    amount = known;
  }
  if (costClass === "unknown") {
    const estimate = counter(event.reporting_estimated_cost_micros);
    if (actual === 0 && estimate !== null && typeof event.reporting_estimate_reason === "string" && event.reporting_estimate_reason.length > 0) {
      costClass = "estimated";
      amount = estimate;
    } else amount = null;
  }
  return { lane, costClass, amount };
}
