import type { AdminUsageRow, BudgetStatus, ProviderConnection, UsageSummary } from "./ui-types";

export function formatMicros(value: number | null | undefined): string {
  if (value == null) return "Unknown";
  if (value === 0) return "$0.00";
  if (value < 10_000) return "<$0.01";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

export function presentCost(micros: number, basis: string | null | undefined, reservation = false) {
  let label: string;
  let unavailable = false;
  switch (basis) {
    case "manifest_pricing": label = reservation ? "Token-based reservation estimate" : "Token-based estimate"; break;
    case "manifest_rate_upper_bound": label = "Token-based estimate (rate upper bound)"; break;
    case "policy_fixed": label = "Fixed policy tariff"; break;
    case "manifest_reservation": label = "Retained reservation estimate"; break;
    case "flat_fallback": label = "Fallback tariff"; break;
    case "none": label = "Accounted · no charge"; break;
    case "unpriced_usage": label = "Unpriced usage"; unavailable = true; break;
    case "unpriced_request": label = "Unpriced request"; unavailable = true; break;
    // Historical and future strings remain readable without inventing a basis.
    default: label = "Accounting basis unavailable";
  }
  return { value: unavailable ? "Price unavailable" : formatMicros(micros), label, unavailable };
}

export function presentAccountedSpend(summary: Pick<UsageSummary, "requestCount" | "actualCostMicros" | "unpricedRequestCount">, complete = true) {
  const { requestCount, actualCostMicros, unpricedRequestCount } = summary;
  const allUnpriced = requestCount > 0 && unpricedRequestCount === requestCount;
  const value = allUnpriced ? "Price unavailable" : `${complete ? "" : "≥"}${formatMicros(actualCostMicros)}${unpricedRequestCount ? ` accounted; ${unpricedRequestCount} unpriced` : ""}`;
  // Aggregates have no basis breakdown. The bounded event sample cannot supply one.
  const note = ["May include estimates", unpricedRequestCount == null ? "price coverage unavailable" : unpricedRequestCount ? `${unpricedRequestCount} unpriced calls excluded` : "", complete ? "" : "partial call history"].filter(Boolean).join(" · ");
  return { label: "accounted spend", value, note };
}

type BudgetScope = "policy" | "principal" | "provider";
type BudgetView = Pick<BudgetStatus, "ledger" | "limitMicros" | "spentMicros" | "remainingMicros">;

export function presentBudget(budget: BudgetView, scope: BudgetScope, enabled = true) {
  const { limitMicros: limit, spentMicros: used, remainingMicros: remaining, ledger } = budget;
  const perPrincipal = ledger === "per_principal";
  const noCap = limit == null;
  const unavailable = ledger === "unavailable" || ledger === "invalid_policy";
  const exhausted = ledger === "blocked" || limit === 0 || !perPrincipal && !noCap && remaining != null && remaining <= 0;
  const percent = unavailable || perPrincipal || noCap ? null : exhausted ? 100 : used == null ? null : Math.min(100, Math.max(0, used / limit * 100));
  const scopeLabel = scope === "provider" ? "Provider-wide" : scope === "principal" ? "Per principal" : "Shared policy pool";
  const limitLabel = ledger === "invalid_policy" ? "Limit unavailable" : noCap ? "No cap at this scope" : `${formatMicros(limit)} monthly limit`;
  const usedLabel = perPrincipal ? "Separate balance per principal" : unavailable || used == null ? "Used amount unavailable" : `${formatMicros(used)} used`;
  const remainingLabel = unavailable ? "Remaining unavailable" : noCap ? "No cap at this scope" : perPrincipal ? "Per-principal balances" : remaining == null ? "Remaining unavailable" : `${formatMicros(remaining)} remaining`;
  let health: { label: string; tone: "active" | "neutral" | "revoked" };
  if (!enabled) health = { label: "revoked", tone: "revoked" };
  else if (unavailable) health = { label: ledger === "invalid_policy" ? "invalid policy" : "ledger unavailable", tone: "revoked" };
  else if (exhausted) health = { label: "budget blocked", tone: "revoked" };
  else if (noCap) health = { label: "no cap at this scope", tone: "neutral" };
  else if (perPrincipal) health = { label: "per principal", tone: "neutral" };
  else if (used == null) health = { label: "usage unavailable", tone: "neutral" };
  else health = { label: "healthy", tone: "active" };
  const note = `${scopeLabel} · UTC calendar month · Used includes reservations.${noCap ? " Other policy or provider limits still apply." : ""}`;
  return { limit: limitLabel, used: usedLabel, remaining: remainingLabel, percent, exhausted, health, note, scopeLabel };
}

export function presentPolicyBudget(row: AdminUsageRow) {
  return presentBudget({ ...row.budget, limitMicros: row.budget.limitMicros ?? row.monthlyBudgetMicros }, row.budgetScope ?? "policy", row.enabled);
}

export function presentProviderBudget(connection: ProviderConnection) {
  return presentBudget({ ledger: "provider", limitMicros: connection.monthlyBudgetMicros, spentMicros: connection.spentMicros, remainingMicros: connection.remainingMicros }, "provider");
}
