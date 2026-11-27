import { refreshExpiryWarning } from "../../shared/refresh-expiry";
import { policyGrants } from "../../shared/subscription-pool";
import type { AccessPolicy, UpstreamGrant } from "./ui-types";

const warningLabels = { unknown: "Refresh/session expiry unknown", none: "Refresh/session expiry", warning: "Reauthorize within 3 days", critical: "Reauthorize within 12 hours", expired: "Refresh/session expiry reached" };

export function GrantExpiry({ grant }: { grant: UpstreamGrant }) {
  if (!grant.hasRefreshToken) return null;
  const warning = refreshExpiryWarning(grant.refreshTokenExpiresAt);
  return <div aria-label="Refresh session lifetime">
    <p><strong>{warningLabels[warning]}</strong>{grant.refreshTokenExpiresAt ? <> · <time dateTime={grant.refreshTokenExpiresAt}>{new Date(grant.refreshTokenExpiresAt).toLocaleString()}</time></> : " · No provider deadline supplied."}</p>
    <p>Last manual authorization: {grant.lastManualAuthorizationAt ? <time dateTime={grant.lastManualAuthorizationAt}>{new Date(grant.lastManualAuthorizationAt).toLocaleString()}</time> : "Unknown"}. Automatic refresh does not reset this date.</p>
    {["warning", "critical", "expired"].includes(warning) ? <p>Replace this grant with credentials from a fresh dedicated login in Access. Keep-warm does not extend the session lifetime.</p> : null}
  </div>;
}

/** Separate from readiness: fallback can serve traffic while logins approach expiry. */
export function GrantExpiryPools({ policies, grants, ready, error, onOpenGrant }: {
  policies: AccessPolicy[]; grants: UpstreamGrant[]; ready: boolean; error: string; onOpenGrant: (grant: UpstreamGrant) => void;
}) {
  const pools = policies.filter(policy => policy.enabled).flatMap(policy => {
    const expiring = policyGrants(policy, grants).filter(grant => grant.enabled && !grant.revokedAt && grant.hasRefreshToken && ["warning", "critical", "expired"].includes(refreshExpiryWarning(grant.refreshTokenExpiresAt)));
    return expiring.length ? [{ policyId: policy.policyId, expiring }] : [];
  });
  if (ready && !error && !pools.length) return null;
  return <section className="dashboardPanel" aria-label="Pool refresh expiry health">
    <h2>Pool health · upcoming login expiry</h2>
    {!ready || error ? <p role="status">Refresh expiry health unavailable or stale. Last known deadlines remain visible.</p> : null}
    {pools.map(pool => <article key={pool.policyId}><h3>{pool.policyId}</h3><p>{pool.expiring.length} grant(s) need a fresh login soon. Working fallback does not extend these sessions.</p>
      {pool.expiring.map(grant => <div key={grant.key}><button type="button" className="buttonSecondary" onClick={() => onOpenGrant(grant)}>Renew {grant.label || grant.tokenRef}</button><GrantExpiry grant={grant} /></div>)}
    </article>)}
  </section>;
}
