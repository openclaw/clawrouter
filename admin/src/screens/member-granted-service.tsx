import { BrandMark, Status, kindIcon } from "../components";
import { kindLabel } from "../domain";
import type { ProviderReadiness, ServiceItem } from "../ui-types";
import "../styles/member-granted-service.css";

// The personal route verdict owns callability. Provider checks are advisory;
// neither raw probe diagnostics nor configuration key names belong in this row.
function healthNote(readiness?: ProviderReadiness) {
  if (!readiness) return "Readiness not reported.";
  if (readiness.executable) {
    if (readiness.status === "failed") return "Last provider check failed.";
    if (readiness.status === "verified" && readiness.verified) return "Last provider check passed.";
    if (readiness.status === "unverified") return "No recent verification.";
    return "Verification not reported.";
  }
  switch (readiness.status) {
    case "disabled": return "The provider connection is disabled.";
    case "unconfigured":
    case "missing_config": return "Provider setup is incomplete.";
    case "grant_required": return "Provider authorization is required.";
    default: return "No callable route for this grant.";
  }
}

export function MemberGrantedService({ service }: { service: ServiceItem }) {
  const access = service.access;
  const readiness = access?.readiness;
  const callable = readiness?.executable;
  return <article className="dashboardService memberGrantedService" aria-label={service.name}>
    <span className="dashboardServiceMark" aria-hidden="true"><BrandMark brandIcon={service.brandIcon} fallback={kindIcon(service.kind)} /></span>
    <strong className="memberServiceName">{service.name}</strong>
    <Status label={callable === undefined ? "unknown" : callable ? "usable" : "unavailable"} tone={callable === undefined ? "neutral" : callable ? "active" : "revoked"} />
    <p className="memberServiceHealth">{healthNote(readiness)}</p>
    <small className="memberServiceGrant">{kindLabel(service.kind)} · {access?.policies.length ? "Granted by " + access.policies.join(", ") : "Session grant"}</small>
  </article>;
}
