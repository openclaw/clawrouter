import React, { useEffect, useState } from "react";
import type { GrantPoolReadiness } from "../../../shared/contracts";
import { errorMessage } from "../domain";
import { request } from "../ui-helpers";

const prefix = "/v1/admin/grant-pools";

// Recovery must load independently: a corrupt legacy account can prevent the
// normal admin bootstrap from listing accounts, but must not hide this action.
export function GrantPoolRecovery({ gatewayOrigin, demoMode }: { gatewayOrigin: string; demoMode: boolean }) {
  const [state, setState] = useState<GrantPoolReadiness | null>(null);
  const [baseline, setBaseline] = useState<"existing" | "fresh">("existing");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcomes, setOutcomes] = useState<Array<{ key: string; outcome?: string; reason?: string }>>([]);
  const [repairCursor, setRepairCursor] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    if (!demoMode) request<GrantPoolReadiness>(gatewayOrigin, `${prefix}/readiness`).then(value => { if (current) setState(value); }).catch(caught => { if (current) setError(errorMessage(caught)); });
    return () => { current = false; };
  }, [gatewayOrigin, demoMode]);

  async function refresh() {
    setBusy(true); setError("");
    try { setState(await request<GrantPoolReadiness>(gatewayOrigin, `${prefix}/readiness`)); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function act(action: string, body: object) {
    setBusy(true); setError("");
    try {
      const result = await request<GrantPoolReadiness | { readiness: GrantPoolReadiness; outcomes: typeof outcomes; cursor?: string | null }>(gatewayOrigin, `${prefix}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if ("readiness" in result) { setState(result.readiness); setOutcomes(result.outcomes); if (action === "repair") setRepairCursor(result.cursor ?? null); }
      else { setState(result); setOutcomes([]); }
    } catch (caught) {
      setError(errorMessage(caught));
      try { setState(await request<GrantPoolReadiness>(gatewayOrigin, `${prefix}/readiness`)); } catch { /* keep the failed action visible */ }
    } finally { setBusy(false); }
  }

  if (demoMode) return <section className="inspectorPanel"><h2>Account routing readiness</h2><p>Recovery is available on a connected router.</p></section>;
  const changed = state?.scanRevision !== null && state?.scanRevision !== state?.revision;
  const canActivate = state?.phase === "complete" && !changed && !state.issues.length && !state.overflow;
  return <section className="inspectorPanel" aria-label="account routing recovery">
    <h2>Account routing readiness</h2>
    <p>{!state ? "Read the router's current account routing status to continue." : state.activatedAt ? "Active. Paused and reauthorization-required accounts keep their provider attached and block environment fallback." : "Environment fallback is blocked until the account inventory is reconciled and activated. Existing scoped accounts and admin recovery remain available."}</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh readiness</button>
    {error ? <p role="alert">{error}</p> : null}
    {!state ? <p>Readiness has not loaded. The authenticated CLI can inspect it with <code>pnpm cf:accounts -- --status</code>.</p> : <>
      {!state.baseline ? <>
        <label>Storage baseline <select value={baseline} onChange={event => { setBaseline(event.target.value as typeof baseline); setConfirmed(false); }} disabled={busy}>
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
