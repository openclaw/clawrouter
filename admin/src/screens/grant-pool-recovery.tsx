import type { GrantPoolRecoveryModel } from "../hooks/access/use-grant-pool-recovery";

// Recovery must load independently: a corrupt legacy account can prevent the
// normal admin bootstrap from listing accounts, but must not hide this action.
export function GrantPoolRecovery({ model }: { model: GrantPoolRecoveryModel }) {
  const { state, baseline, confirmed, busy, error, outcomes, repairCursor, demoMode, refresh, act, setBaseline, setConfirmed } = model;

  if (demoMode) return <section className="inspectorPanel"><h2>Account routing readiness</h2><p>Recovery is available on a connected router.</p></section>;
  const changed = state?.scanRevision !== null && state?.scanRevision !== state?.revision;
  const canActivate = state?.phase === "complete" && !changed && !state.issues.length && !state.overflow;
  return <section id="account-publication-recovery" className="inspectorPanel" aria-label="account routing recovery" tabIndex={-1}>
    <h2>Account routing readiness</h2>
    <p>{!state ? "Read the router's current account routing status to continue." : state.activatedAt ? "Active. Paused and reauthorization-required accounts keep their provider attached and block environment fallback." : "Environment fallback is blocked until the account inventory is reconciled and activated. Existing scoped accounts and admin recovery remain available."}</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh readiness</button>
    {error ? <p role="alert">{error}</p> : null}
    {!state ? <p>Readiness has not loaded. The authenticated CLI can inspect it with <code>pnpm cf:accounts -- --status</code>.</p> : <>
      {!state.baseline ? <>
        <label>Storage baseline <select value={baseline} onChange={event => setBaseline(event.target.value as typeof baseline)} disabled={busy}>
          <option value="existing">Existing or unknown storage</option><option value="fresh">Newly provisioned storage</option>
        </select></label>
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />{baseline === "fresh" ? "I confirm this matched storage set was newly provisioned and contains no earlier accounts." : "I stopped all legacy writers and checked the complete account inventory, including paused accounts and keys absent from the old index. An empty scan alone is not proof."}</label>
        <button type="button" disabled={busy || !confirmed} onClick={() => void act("baseline", { revision: state.revision, baseline, confirmed })}>Accept baseline</button>
      </> : null}
      {state.baseline && !state.activatedAt ? <>
        <p>Scan: {state.phase}; {state.scanned} key observations. {changed ? "Accounts changed since this scan began. Start a new verification scan after repairs finish." : ""}</p>
        <button type="button" disabled={busy} onClick={() => void act("scan", { revision: state.revision })}>{state.phase === "idle" ? "Start account scan" : "Start new verification scan"}</button>
        {state.phase === "kv" || state.phase === "index" ? <button type="button" disabled={busy} onClick={() => void act("advance", { scanRevision: state.scanRevision, phase: state.phase, cursor: state.cursor })}>Reconcile next page</button> : null}
        <button type="button" disabled={busy || !canActivate} onClick={() => void act("activate", { revision: state.revision })}>Activate account routing</button>
      </> : null}
      <button type="button" disabled={busy} onClick={() => void act("repair", { cursor: repairCursor })}>{repairCursor ? "Repair next indexed page" : "Repair account publication"}</button>
      <p>Repair makes no upstream provider requests. It does not reconnect, refresh, or revoke accounts.</p>
      {state.issues.length || state.overflow ? <>
        <p>For an unavailable owner, restore service and retry the scan. For a raw legacy account, use <code>pnpm cf:oauth:put</code> with its scope, reference, provider, and secret stdin/file, or <code>pnpm cf:oauth:revoke</code> to remove it. Missing owner storage with a retained index requires matched-storage recovery; do not delete the index. Then start a new scan.</p>
        <ul>{state.issues.map(issue => <li key={issue.key}><code>{issue.key}</code>: {issue.reason}</li>)}</ul>
        {state.overflow ? <p>More than 64 unresolved keys were observed. Resolve these, then rescan for the next set.</p> : null}
      </> : null}
      {outcomes.length ? <ul aria-label="last repair outcomes">{outcomes.map(outcome => <li key={outcome.key}><code>{outcome.key}</code>: {outcome.reason ?? outcome.outcome}</li>)}</ul> : null}
    </>}
  </section>;
}
