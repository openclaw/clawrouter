import { type FormEvent, type SetStateAction, useRef, useState } from "react";
import { DashboardRequestError, type ConsoleRequest } from "../../dashboard-fetch";
import { errorMessage } from "../../domain";
import { defaultUpstreamGrant, demo } from "../../ui-config";
import { demoGrantFromForm, parseCredentialBundle, upstreamGrantFormFromGrant } from "../../ui-helpers";
import type { AccessPolicy, ProviderRow, UpstreamGrant, UpstreamGrantForm } from "../../ui-types";

interface Dependencies {
  request: ConsoleRequest;
  isCurrent: () => boolean;
  allowDemo: boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  providers: ProviderRow[];
  policies: AccessPolicy[];
  selectedPolicyId: string;
  setStatus: (status: string) => void;
  refresh: (ownsOperation: () => boolean) => Promise<void>;
}

type Action = "save" | "revoke" | "refresh" | "quota-refresh";
type Field = keyof UpstreamGrantForm;
interface Draft { selection: string; value: UpstreamGrantForm; initialized: boolean }
interface Operation { phase: "writing" | "refreshing" }
const fields = Object.keys(defaultUpstreamGrant) as Field[];
const identityFields: Field[] = ["scope", "scopeId", "tokenRef", "provider", "kind"];
const secretFields: Field[] = ["credential", "credentialBundle", "accessToken", "refreshToken"];
const messages: Record<Action, [string, string]> = {
  save: ["saving upstream grant", "saved upstream grant"],
  revoke: ["revoking upstream grant", "revoked upstream grant"],
  refresh: ["refreshing upstream grant", "refreshed upstream grant"],
  "quota-refresh": ["refreshing provider quota", "refreshed provider quota"],
};

export function useUpstreamAdmin({ request, isCurrent, allowDemo, gatewayOrigin, demoMode, providers, policies, selectedPolicyId, setStatus, refresh }: Dependencies) {
  const [grants, setGrants] = useState<UpstreamGrant[]>(allowDemo ? demo.upstreamGrants : []);
  const rows = useRef(grants);
  const [draft, setDraft] = useState<Draft>(() => ({ selection: grants[0]?.key ?? "", value: grants[0] ? upstreamGrantFormFromGrant(grants[0]) : defaultUpstreamGrant, initialized: allowDemo }));
  const currentDraft = useRef(draft);
  const baseline = useRef(draft.value);
  const incarnation = useRef(0);
  const revision = useRef(0);
  const fieldRevisions = useRef<Partial<Record<Field, number>>>({});
  const recordsEpoch = useRef(0);
  const operation = useRef<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = grants.find((grant) => grant.key === draft.selection);

  function captureHydration() { return operation.current ? null : recordsEpoch.current; }

  function hydrate(nextGrants: UpstreamGrant[], policyId: string, providerRows: ProviderRow[], snapshot: number | null) {
    // The dependent bootstrap reads projections, not a versioned owner receipt.
    // It may refresh other resources but cannot undo this operation's acknowledged row.
    if (!isCurrent() || snapshot === null || snapshot !== recordsEpoch.current || operation.current) return;
    updateRows(nextGrants);
    const current = currentDraft.current;
    if (current.initialized && !current.selection) return;
    const grant = current.initialized ? nextGrants.find((item) => item.key === current.selection) : nextGrants[0];
    if (grant) {
      const canonical = upstreamGrantFormFromGrant(grant);
      if (!current.initialized) resetDraft(grant.key, canonical);
      else rebaseDraft(grant.key, canonical, new Set(fields.filter((field) => current.value[field] !== baseline.current[field])));
    } else if (!current.initialized) resetDraft("", { ...defaultUpstreamGrant, scopeId: policyId, provider: providerRows[0]?.id ?? "", tokenRef: providerRows[0]?.id ?? "" });
  }

  async function save(event: FormEvent) { event.preventDefault(); await mutate("save"); }
  async function revoke(grant: UpstreamGrant) { await mutate("revoke", grant); }
  async function refreshGrant(grant: UpstreamGrant) { await mutate("refresh", grant); }
  async function refreshQuota(grant: UpstreamGrant) { await mutate("quota-refresh", grant); }

  async function mutate(action: Action, target?: UpstreamGrant) {
    if (!isCurrent() || operation.current?.phase === "writing") return;
    const op: Operation = { phase: "writing" };
    operation.current = op;
    recordsEpoch.current += 1;
    setBusy(true);
    setError("");
    const submitted = currentDraft.current, submittedIncarnation = incarnation.current, submittedRevision = revision.current;
    const dirty = new Set(fields.filter((field) => submitted.value[field] !== baseline.current[field]));
    const form = submitted.value;
    const identity = action === "save" ? { scope: form.scope, scopeId: form.scopeId.trim(), tokenRef: form.tokenRef.trim() } : target!;
    const key = identity.scope === "tenants" ? `oauth/tenants/${identity.scopeId}/${identity.tokenRef}` : `oauth/${identity.scopeId}/${identity.tokenRef}`;
    const existing = rows.current.find((grant) => grant.key === (action === "save" ? submitted.selection : key));
    let sent = false;
    setStatus(messages[action][0]);
    try {
      const body = action === "save" ? saveBody(form, existing) : undefined;
      const submittedSecrets: Partial<Record<Field, unknown>> = { credential: body?.credential, credentialBundle: body?.credentials, accessToken: body?.accessToken, refreshToken: body?.refreshToken };
      let saved: UpstreamGrant;
      if (demoMode) {
        saved = action === "save" ? demoGrantFromForm(form, existing)
          : action === "revoke" ? { ...target!, enabled: false, usable: false, hasCredential: false, credentialFields: [], hasAccessToken: false, hasRefreshToken: false, revokedAt: new Date().toISOString() }
          : target!;
      } else {
        const path = `/v1/admin/upstream-grants/${identity.scope}/${encodeURIComponent(identity.scopeId)}/${encodeURIComponent(identity.tokenRef)}${action === "save" ? "" : `/${action}`}`;
        sent = true;
        saved = await request<UpstreamGrant>(gatewayOrigin, path, { method: action === "save" ? "PUT" : "POST", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      }
      if (!isCurrent()) { release(op); return; }
      if (!saved || saved.key !== key || saved.scope !== identity.scope || saved.scopeId !== identity.scopeId || saved.tokenRef !== identity.tokenRef || typeof saved.enabled !== "boolean") throw new Error("invalid upstream grant response");
      updateRows([saved, ...rows.current.filter((grant) => grant.key !== key)]);
      // Rows belong to the request; the editor belongs to its current incarnation.
      // Field revisions preserve edits back to old values and later secret replacements.
      if (incarnation.current === submittedIncarnation && (submitted.selection === key || action === "save" && !submitted.selection)) {
        const preserve = new Set(fields.filter((field) => (fieldRevisions.current[field] ?? 0) > submittedRevision
          || action === "save" && secretFields.includes(field) && !submittedSecrets[field]
          || action !== "save" && dirty.has(field) && !(action === "revoke" && (field === "enabled" || secretFields.includes(field)))));
        rebaseDraft(key, upstreamGrantFormFromGrant(saved), preserve);
      }
      setStatus(messages[action][1]);
      // Keep the read fence through metadata refresh, but let the next write replace
      // this token. Its predecessor's cleanup must never release that newer write.
      op.phase = "refreshing";
      setBusy(false);
      if (demoMode) release(op);
      else void refresh(() => isCurrent() && operation.current === op).finally(() => release(op));
    } catch (caught) {
      release(op);
      if (!isCurrent()) return;
      const rejected = caught instanceof DashboardRequestError && caught.status >= 400 && caught.status < 500;
      const message = sent && !rejected
        ? `Change to ${identity.tokenRef} could not be confirmed. Refresh and inspect the grant before trying again; the server may have applied it.`
        : errorMessage(caught);
      if (incarnation.current === submittedIncarnation) setError(message);
      setStatus(`upstream grant ${action} failed (${identity.tokenRef}): ${message}`);
      // Failed refreshes can still change credential/quota state. Reconcile without
      // holding write admission or allowing this read to supersede another operation.
      const releasedEpoch = recordsEpoch.current;
      if (sent) void refresh(() => isCurrent() && !operation.current && recordsEpoch.current === releasedEpoch);
    }
  }

  function release(op: Operation) {
    if (operation.current !== op) return;
    recordsEpoch.current += 1;
    operation.current = null;
    if (isCurrent()) setBusy(false);
  }

  function saveBody(form: UpstreamGrantForm, existing?: UpstreamGrant) {
    if (!form.scopeId.trim() || !form.tokenRef.trim() || !form.provider.trim()) throw new Error("scope, token reference, and provider are required");
    const priority = Number(form.priority), weight = Number(form.weight);
    if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) throw new Error("priority must be an integer from 0 to 1000000");
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1_000_000) throw new Error("weight must be greater than 0 and at most 1000000");
    const credentialBundle = parseCredentialBundle(form.credentialBundle);
    const primarySecret = form.kind === "api_key" ? form.credential.trim() || Object.keys(credentialBundle).length : form.accessToken.trim();
    if (!existing && !primarySecret) throw new Error("a new upstream grant requires its primary secret");
    return {
      version: 1, enabled: form.enabled, priority, weight, kind: form.kind, provider: form.provider.trim(), label: form.label.trim() || undefined,
      tokenType: existing?.tokenType ?? "Bearer", expiresAt: form.expiresAt.trim() || undefined, scopes: existing?.scopes ?? [],
      accountId: form.accountId.trim() || undefined, subscription: existing?.subscription ?? undefined,
      maintenance: { keepWarm: form.kind === "subscription" && form.keepWarm },
      ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
      ...(Object.keys(credentialBundle).length ? { credentials: credentialBundle } : {}),
      ...(form.accessToken.trim() ? { accessToken: form.accessToken.trim() } : {}),
      ...(form.refreshToken.trim() ? { refreshToken: form.refreshToken.trim() } : {}),
    };
  }
  async function authorize() {
    if (!isCurrent() || operation.current?.phase === "writing") return;
    const form = currentDraft.current.value;
    try {
      setError("");
      const scopeId = form.scopeId.trim(), tokenRef = form.tokenRef.trim(), provider = form.provider.trim();
      if (!scopeId || !tokenRef || !provider) throw new Error("scope, token reference, and provider are required");
      const priority = Number(form.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) throw new Error("priority must be an integer from 0 to 1000000");
      const weight = Number(form.weight);
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1_000_000) throw new Error("weight must be greater than 0 and at most 1000000");
      if (!providers.find((item) => item.id === provider)?.auth?.authorization) throw new Error("selected provider does not support browser OAuth");
      setStatus("connecting upstream grant");
      if (demoMode) { setStatus("browser OAuth unavailable in local demo"); return; }
      const result = await request<{ authorizationUrl: string }>(gatewayOrigin, `/v1/admin/upstream-grants/${form.scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(tokenRef)}/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, priority, weight }) });
      if (isCurrent()) window.location.assign(result.authorizationUrl);
    } catch (caught) { if (isCurrent()) { const message = errorMessage(caught); setError(message); setStatus(message); } }
  }

  function updateRows(next: UpstreamGrant[]) { rows.current = next; setGrants(next); }
  function publishDraft(next: Draft) { currentDraft.current = next; setDraft(next); }
  function resetDraft(selection: string, value: UpstreamGrantForm) {
    incarnation.current += 1;
    fieldRevisions.current = {};
    baseline.current = value;
    publishDraft({ selection, value, initialized: true });
  }
  function rebaseDraft(selection: string, canonical: UpstreamGrantForm, preserve: Set<Field>) {
    const value = { ...canonical };
    for (const field of preserve) Object.assign(value, { [field]: currentDraft.current.value[field] });
    baseline.current = canonical;
    publishDraft({ selection, value, initialized: true });
  }
  function setForm(next: SetStateAction<UpstreamGrantForm>) {
    const current = currentDraft.current, value = typeof next === "function" ? next(current.value) : next;
    const changed = fields.filter((field) => value[field] !== current.value[field]);
    if (!changed.length) return;
    revision.current += 1;
    if (!current.selection && changed.some((field) => identityFields.includes(field))) incarnation.current += 1;
    for (const field of changed) fieldRevisions.current[field] = revision.current;
    publishDraft({ ...current, value, initialized: true });
  }
  function edit(grant: UpstreamGrant) { resetDraft(grant.key, upstreamGrantFormFromGrant(rows.current.find((item) => item.key === grant.key) ?? grant)); setError(""); }
  function startNew() { const provider = providers[0]?.id ?? ""; resetDraft("", { ...defaultUpstreamGrant, scopeId: selectedPolicyId || policies[0]?.policyId || "default", provider, tokenRef: provider }); setError(""); }

  return { upstream: { items: grants, selected, selectedKey: draft.selection, form: draft.value, setForm, busy, error, save, revoke, refresh: refreshGrant, refreshQuota, authorize, edit, startNew }, captureHydration, hydrate };
}
