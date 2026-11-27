import { formatConfiguredLimit, presentBudget } from "../cost-presentation";
import { usagePolicyId } from "../ui-helpers";
import type { AdminUsageRow, BudgetStatus } from "../ui-types";

function reported(window: BudgetStatus | undefined): window is BudgetStatus {
  return window?.configured === true || window?.override === true;
}

export function hasShortBudgetWindow(budget: BudgetStatus) {
  return reported(budget.daily) || reported(budget.weekly);
}

const resetTime = new Intl.DateTimeFormat("en", {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23", timeZone: "UTC", timeZoneName: "short",
});

// Each configured window is independently enforced. Never substitute a sibling's balance or reset.
export function MemberBudgetWindows({ row, serviceCount }: { row: AdminUsageRow; serviceCount: string }) {
  const id = usagePolicyId(row);
  const budget = row.budget;
  const scope = row.budgetScope ?? "policy";
  return <article aria-label={id}>
    <header className="panelIntro quotaIdentity"><strong className="memberBudgetPolicyId">{id}</strong><small>{scope === "principal" ? "Per principal" : "Shared policy pool"} · {serviceCount} {serviceCount === "1" ? "service" : "services"}</small></header>
    {([["Daily", budget.daily], ["Weekly", budget.weekly], ["Monthly", budget]] as const).map(([period, window]) => {
      if (!reported(window)) return null;
      const limit = window.limitMicros === undefined && period === "Monthly" ? row.monthlyBudgetMicros : window.limitMicros;
      const { remaining, used, percent } = presentBudget({ ...window, limitMicros: limit }, scope);
      const memberOverride = scope === "principal" && window.override === true;
      const unlimited = limit === null && memberOverride;
      const limitLabel = limit != null ? formatConfiguredLimit(limit) + " " + period.toLowerCase() + " limit" : unlimited ? "Unlimited" : "Limit unavailable";
      const balance = unlimited ? "No " + period.toLowerCase() + " cap" : limit == null ? "Remaining unavailable" : remaining;
      const rounded = percent === null ? null : Math.round(percent);
      const percentLabel = rounded === 100 && percent !== 100 ? ">99%" : rounded === 0 && percent !== 0 ? "<1%" : rounded + "%";
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      return <div className="quotaRow" role="group" aria-label={period} key={period}>
        <span className="quotaIdentity"><strong>{period}</strong><small>{Number.isFinite(reset) ? <>Resets <time dateTime={window.resetsAt}>{resetTime.format(reset)}</time></> : "Reset not reported"}</small></span>
        <span className="quotaNumbers"><strong>{balance}</strong><small>{limitLabel} · {used}{memberOverride ? " · member override" : ""}</small></span>
        {percent !== null && <><span className={percent >= 90 ? "quotaTrack warning" : "quotaTrack"} aria-hidden="true"><span style={{ width: percent + "%" }} /></span><strong className="quotaPercent">{percentLabel}</strong></>}
      </div>;
    })}
  </article>;
}
