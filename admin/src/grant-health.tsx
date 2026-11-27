import { modelEligibility, policyGrants } from "../../shared/subscription-pool";
import type { AccessPolicy, UpstreamGrant } from "./ui-types";

export function degradedPools(policies: AccessPolicy[], grants: UpstreamGrant[]) {
  return policies.filter(policy => policy.enabled).flatMap(policy => {
    const pool = policyGrants(policy, grants).filter(grant => !grant.revokedAt);
    return [...new Set(pool.map(grant => grant.provider))].flatMap(provider => {
      const members = pool.filter(grant => grant.provider === provider);
      const reauth = members.filter(requiresReauthorization);
      const blocked = members.filter(grant => !requiresReauthorization(grant) && !!grant.refreshDiagnosis?.failure && (!grant.usable || localSettlementPending(grant)));
      const models = policy.models?.filter(model => model.startsWith(`${provider}/`));
      // Evaluate actual policy models when restricted; otherwise include each
      // observed family, so scoped exhaustion is not hidden by another family.
      const families = models?.length ? models : [...new Set(["", ...members.flatMap(grant => grant.quotaWindows.flatMap(window => window.models ?? []))])];
      const usable = Math.min(...families.map(model => members.filter(grant => modelEligibility(grant, model, policy) === "eligible").length));
      return reauth.length || blocked.length || (members.length > 1 && usable <= 1) || usable === 0
        ? [{ policyId: policy.policyId, provider, total: members.length, usable, reauth, blocked }]
        : [];
    });
  });
}

export function GrantRefreshHealth({ grant }: { grant: UpstreamGrant }) {
  const diagnosis = grant.refreshDiagnosis;
  if (!diagnosis && grant.credentialStatus !== "reauth_required" && !grant.hasRefreshToken) return null;
  const failure = diagnosis?.failure;
  const settling = localSettlementPending(grant);
  return <div aria-label="Refresh ownership and health">
    {grant.hasRefreshToken ? <p>Login provenance: {grant.credentialProvenance === "clawrouter_oauth" ? "Minted by ClawRouter OAuth" : "Imported"}.
      {grant.credentialProvenance !== "clawrouter_oauth" ? " Imported refreshable tokens may also be refreshed by another program. Use a fresh dedicated login; never copy an active Claude Code login." : " ClawRouter owns refresh for this dedicated login."}</p> : null}
    <p>{grant.credentialStatus === "reauth_required" ? "Reauth required" : settling ? "Local settlement pending — provider refresh will not be replayed" : refreshAtRisk(grant) ? "Refresh at risk — automatic replay stopped" : !grant.usable ? "Refresh unavailable" : failure ? "Refresh delayed" : "Refresh healthy"}
    {failure ? <> — {failure.oauthError} at <time dateTime={failure.lastFailureAt}>{new Date(failure.lastFailureAt).toLocaleString()}</time> · {failure.failureClass}{failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ""} · {failure.attemptCount} attempt(s)</> : null}
    {" · Last good refresh: "}{diagnosis?.lastSuccessfulRefreshAt ? <time dateTime={diagnosis.lastSuccessfulRefreshAt}>{new Date(diagnosis.lastSuccessfulRefreshAt).toLocaleString()}</time> : "Unknown"}
    {failure?.settlement ? <> · Local stage: {failure.settlement.stage} · {failure.settlement.code} · Reference: {failure.settlement.correlationId}</> : null}
    {failure?.nextRetryAt ? <> · {settling ? "Next local retry" : "Next retry"}: <time dateTime={failure.nextRetryAt}>{new Date(failure.nextRetryAt).toLocaleString()}</time></> : null}
    {requiresReauthorization(grant) ? " · Replace with credentials from a fresh dedicated login in Access. Renaming or enabling this grant does not reauthorize it." : null}
  </p></div>;
}

export function GrantPoolIncidents({ policies, grants, ready, error, onOpenGrant }: {
  policies: AccessPolicy[]; grants: UpstreamGrant[]; ready: boolean; error: string; onOpenGrant: (grant: UpstreamGrant) => void;
}) {
  const incidents = degradedPools(policies, grants);
  if (ready && !error && !incidents.length) return null;
  return <section className="dashboardPanel" aria-label="Credential maintenance incidents">
    <h2>Credential maintenance · degraded pools</h2>
    {!ready || error ? <p role="status">Pool health unavailable or stale. Last known incidents are retained; refresh access data before treating the pool as healthy.</p> : null}
    {incidents.map(incident => <article key={`${incident.policyId}/${incident.provider}`}>
      <h3>{incident.policyId} · {incident.provider}</h3>
      <p>{incident.usable}/{incident.total} grants eligible in the least-available model lane · {incident.blocked.length} refresh-blocked · {incident.reauth.length} require reauthorization. Fallback serving traffic does not resolve this incident.</p>
      {[...incident.reauth, ...incident.blocked].map(grant => <div key={grant.key}><button type="button" className="buttonSecondary" onClick={() => onOpenGrant(grant)}>Repair {grant.label || grant.tokenRef}</button><GrantRefreshHealth grant={grant} /></div>)}
    </article>)}
  </section>;
}

function refreshAtRisk(grant: UpstreamGrant): boolean {
  return ["ambiguous", "provider_ok_persist_failed"].includes(grant.refreshDiagnosis?.failure?.failureClass ?? "");
}

function localSettlementPending(grant: UpstreamGrant): boolean {
  const failure = grant.refreshDiagnosis?.failure;
  return failure?.failureClass === "provider_ok_persist_failed" && !!failure.settlement && !!failure.nextRetryAt;
}

function requiresReauthorization(grant: UpstreamGrant): boolean {
  return grant.credentialStatus === "reauth_required" || refreshAtRisk(grant) && !localSettlementPending(grant);
}
