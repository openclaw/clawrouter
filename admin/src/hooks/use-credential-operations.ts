import { useRef, useState } from "react";
import { DashboardRequestError } from "../dashboard-fetch";
import { errorMessage } from "../domain";
import { generateSecret, request, sha256Hex } from "../ui-helpers";
import type { ProxyCredential, SessionResponse } from "../ui-types";

type Surface = "admin" | "personal";
type Intent = { surface: Surface; operation: "create" | "rotate" | "revoke"; credentialId: string; policyId: string; principalId?: string | null };
type Scope = { origin: string; demo: boolean; session: SessionResponse };
type Reveal = { key: string; credentialId: string; policyId: string; operation: "create" | "rotate"; scope: number; presentation: number };
type Feedback = { surface: Surface; error: string; notice: string; reveal: Reveal | null };
const emptyFeedback: Feedback = { surface: "personal", error: "", notice: "", reveal: null };
const emptyRows = { admin: [] as ProxyCredential[], personal: [] as ProxyCredential[], policyIds: [] as string[] };

function scopeKey({ origin, demo, session }: Scope) {
  return JSON.stringify([origin, demo, session.auth, session.email, session.tenantId, session.role, session.authenticated]);
}

export function useCredentialOperations(initial: Scope, setStatus: (status: string) => void, refresh: (ownsScope: () => boolean) => Promise<void>) {
  const scopeRef = useRef({ ...initial, key: scopeKey(initial), epoch: 0 });
  const presentationRef = useRef({ surface: null as Surface | null, epoch: 0 });
  const mutationRef = useRef(0);
  const pendingRef = useRef<(Intent & { scope: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(emptyRows);
  const [feedback, setFeedback] = useState<Feedback>(emptyFeedback);
  const [scopeEpoch, setScopeEpoch] = useState(0);

  function setScope(next: Scope | null) {
    const key = next ? scopeKey(next) : "signed-out";
    if (scopeRef.current.key === key) return;
    scopeRef.current = { ...(next ?? scopeRef.current), key, epoch: scopeRef.current.epoch + 1 };
    mutationRef.current += 1;
    presentationRef.current.epoch += 1;
    setScopeEpoch(scopeRef.current.epoch);
    setRows(emptyRows);
    setFeedback(emptyFeedback);
    if (pendingRef.current) setStatus("credential result cleared after sign-in changed");
    // A dispatched request still owns admission until its outcome is known.
  }

  function invalidatePresentation() {
    presentationRef.current.epoch += 1;
    setFeedback((current) => ({ ...current, reveal: null }));
  }

  function captureScope() {
    // Same-identity mutations cannot invalidate an outstanding authentication observation.
    const epoch = scopeRef.current.epoch;
    const isCurrent = () => scopeRef.current.epoch === epoch;
    return { isCurrent, invalidate: () => { if (isCurrent()) setScope(null); } };
  }

  function observePresentation(surface: Surface | null) {
    if (presentationRef.current.surface === surface) return;
    presentationRef.current = { surface, epoch: presentationRef.current.epoch + 1 };
  }

  function captureHydration() { return mutationRef.current; }
  function hydrate(surface: Surface, credentials: ProxyCredential[], snapshot: number, policies: string[] = []) {
    if (scopeRef.current.key === "signed-out" || pendingRef.current?.scope === scopeRef.current.epoch || snapshot !== mutationRef.current) return;
    if (surface === "admin" && scopeRef.current.session.role !== "admin") return;
    setRows((current) => ({ ...current, [surface]: credentials, ...(surface === "personal" ? { policyIds: [...new Set(policies)].sort() } : {}) }));
  }

  function reject(surface: Surface, error: string) {
    if (pendingRef.current) return;
    invalidatePresentation();
    setFeedback({ surface, error, notice: "", reveal: null });
  }

  async function mutate(intent: Intent): Promise<{ credential: ProxyCredential; presented: boolean } | null> {
    if (pendingRef.current) return null;
    const scope = scopeRef.current;
    if (scope.key === "signed-out" || !scope.session.authenticated || (intent.surface === "admin" && scope.session.role !== "admin")) return null;
    const operation = { ...intent, scope: scope.epoch };
    pendingRef.current = operation;
    mutationRef.current += 1;
    setBusy(true);
    setFeedback({ ...emptyFeedback, surface: intent.surface });
    const presentation = presentationRef.current.epoch;
    const capturedScope = captureScope();
    const ownsScope = capturedScope.isCurrent;
    const ownsPresentation = () => ownsScope() && presentationRef.current.epoch === presentation && presentationRef.current.surface === intent.surface;
    let sent = false;
    setStatus(`${intent.operation === "create" ? "issuing" : intent.operation === "rotate" ? "rotating" : "revoking"} credential`);
    try {
      const secret = intent.operation === "revoke" ? "" : generateSecret(24);
      const digest = secret ? await sha256Hex(secret) : "";
      // Leaving and returning must not dispatch an intent admitted by the old panel.
      if (!ownsPresentation()) {
        if (ownsScope()) setStatus("credential change canceled before sending");
        return null;
      }
      const collection = `/v1/${intent.surface === "admin" ? "admin" : "session"}/credentials`;
      const path = intent.operation === "create" ? collection : `${collection}/${encodeURIComponent(intent.credentialId)}/${intent.operation}`;
      const body = intent.operation === "create"
        ? { credentialId: intent.credentialId, policyId: intent.policyId, ...(intent.surface === "admin" ? { principalId: intent.principalId ?? null } : {}), secretSha256: digest }
        : intent.operation === "rotate" ? { secretSha256: digest } : undefined;
      sent = true;
      const credential = scope.demo
        ? { credentialId: intent.credentialId, policyId: intent.policyId, principalId: intent.surface === "admin" ? intent.principalId ?? null : scope.session.email, enabled: intent.operation !== "revoke", active: intent.operation !== "revoke" }
        : await request<ProxyCredential>(scope.origin, path, { method: "POST", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (!credential || credential.credentialId !== intent.credentialId || typeof credential.policyId !== "string" || (intent.operation === "create" && credential.policyId !== intent.policyId) || typeof credential.enabled !== "boolean") throw new Error("invalid credential response");
      if (!ownsScope()) return null;
      const update = (items: ProxyCredential[]) => [...items.filter((item) => item.credentialId !== credential.credentialId), credential].sort((a, b) => a.credentialId.localeCompare(b.credentialId));
      setRows((current) => ({
        ...current,
        admin: scope.session.role === "admin" ? update(current.admin) : [],
        personal: intent.surface === "personal" || (Boolean(scope.session.email) && credential.principalId?.trim().toLowerCase() === scope.session.email?.trim().toLowerCase()) ? update(current.personal) : current.personal.filter((item) => item.credentialId !== credential.credentialId),
      }));
      const verb = intent.operation === "create" ? "Created" : intent.operation === "rotate" ? "Rotated" : "Revoked";
      const reveal = secret && ownsPresentation() ? { key: `clawrouter-live-${intent.credentialId}-${secret}`, credentialId: intent.credentialId, policyId: credential.policyId, operation: intent.operation as "create" | "rotate", scope: scope.epoch, presentation } : null;
      const notice = `${verb} ${intent.credentialId}.${secret && !reveal ? " The one-time secret was dismissed. Rotate the active key to obtain a new secret." : ""}`;
      setFeedback({ surface: intent.surface, error: "", notice, reveal });
      setStatus(`${intent.operation === "create" ? "issued" : verb.toLowerCase()} credential`);
      return { credential, presented: ownsPresentation() };
    } catch (caught) {
      if (!ownsScope()) return null;
      if (intent.surface === "personal" && caught instanceof DashboardRequestError && caught.status === 401 && caught.message.includes("access_session_required")) {
        capturedScope.invalidate();
        setFeedback({ surface: intent.surface, error: "Sign-in required. Sign in again, then refresh keys.", notice: "", reveal: null });
        setStatus("credential error: sign-in required");
        return null;
      }
      const rejected = caught instanceof DashboardRequestError && caught.status >= 400 && caught.status < 500;
      const error = sent && !rejected
        ? `Change to ${intent.credentialId} could not be confirmed. Refresh and check this key before trying again; the server may have applied it. No secret can be recovered.`
        : errorMessage(caught);
      setFeedback({ surface: intent.surface, error, notice: "", reveal: null });
      setStatus(`credential error: ${error}`);
      return null;
    } finally {
      if (pendingRef.current === operation) {
        pendingRef.current = null;
        // An old identity may still own admission, but cannot stale the new identity's reads.
        if (ownsScope()) mutationRef.current += 1;
        setBusy(false);
      }
      // Metadata freshness is independent of the canonical mutation outcome.
      if (sent && ownsScope() && !scope.demo) void refresh(ownsScope);
    }
  }

  function forSurface(surface: Surface) {
    const owned = feedback.surface === surface;
    const reveal = owned && feedback.reveal?.scope === scopeRef.current.epoch && feedback.reveal.presentation === presentationRef.current.epoch && presentationRef.current.surface === surface ? feedback.reveal : null;
    const pendingReveal = busy && pendingRef.current?.surface === surface && pendingRef.current.scope === scopeRef.current.epoch && pendingRef.current.operation !== "revoke";
    return { items: rows[surface], busy, pendingReveal, error: owned ? feedback.error : "", notice: owned ? feedback.notice : "", reveal, dismiss: invalidatePresentation, refresh: () => refresh(captureScope().isCurrent) };
  }

  return { rows, scopeEpoch, busy, setScope, captureScope, observePresentation, invalidatePresentation, captureHydration, hydrate, mutate, forSurface, reject };
}

export type CredentialOperations = ReturnType<typeof useCredentialOperations>;
