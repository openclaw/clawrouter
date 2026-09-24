import { type FormEvent, type SetStateAction, useRef, useState } from "react";
import { DashboardRequestError, type ConsoleRequest } from "../../dashboard-fetch";
import { errorMessage } from "../../domain";
import { defaultUpstreamGrant, demo } from "../../ui-config";
import { accountFromInventory, accountKey, accountMutationBody, accountPath, demoAccountMutation, demoAccountView, isAccountRow, mergeAccountInventory, readAccountReceipt, readAccountView, readLegacyAccount, upstreamGrantFormFromGrant, type AccountCreation, type AccountEntry, type AccountField, type AccountIdentity, type AccountIntent, type AccountRow } from "../../account-credentials";
import type { AccessPolicy, ProviderRow, UpstreamGrant, UpstreamGrantForm } from "../../ui-types";

interface Dependencies {
  request: ConsoleRequest; isCurrent: () => boolean; allowDemo: boolean; gatewayOrigin: string; demoMode: boolean;
  providers: ProviderRow[]; policies: AccessPolicy[]; selectedPolicyId: string;
  setStatus: (status: string) => void; refresh: (ownsOperation: () => boolean) => Promise<void>;
}
type Action = "save" | "pause" | "revoke" | "refresh" | "quota-refresh";
interface Draft {
  selection: string; value: UpstreamGrantForm; initialized: boolean; mode: AccountIntent;
  generation: number | null; inspection: "unread" | "loading" | "ready" | "failed" | "legacy";
  attempt: AccountIdentity | null; review: boolean; uncertain: boolean;
}
interface Operation { phase: "reading" | "writing" | "refreshing" }
const fields = Object.keys(defaultUpstreamGrant) as AccountField[];
const identityFields: AccountField[] = ["scope", "scopeId", "tokenRef", "provider", "kind"];
const secretFields: AccountField[] = ["credential", "credentialBundle", "accessToken", "refreshToken", "removeRefreshToken"];
const messages: Record<Action, [string, string]> = {
  save: ["saving account", "saved account"], pause: ["updating account state", "saved account state"],
  revoke: ["revoking account", "revoked account"], refresh: ["refreshing account token", "refreshed account token"],
  "quota-refresh": ["refreshing provider quota", "refreshed provider quota"],
};

export function useUpstreamAdmin({ request, isCurrent, allowDemo, gatewayOrigin, demoMode, providers, policies, selectedPolicyId, setStatus, refresh }: Dependencies) {
  const [entries, setEntries] = useState<AccountEntry[]>(allowDemo ? demo.upstreamGrants.map(accountFromInventory) : []);
  const grants = entries.filter(isAccountRow);
  const rows = useRef(entries);
  const [ready, setReady] = useState(demoMode), readyRef = useRef(ready);
  const [draft, setDraft] = useState<Draft>(() => ({ selection: grants[0]?.key ?? "", value: grants[0] ? upstreamGrantFormFromGrant(grants[0]) : newForm(), initialized: allowDemo,
    mode: grants[0] ? "edit" : "create", generation: null, inspection: grants[0] ? "unread" : "ready", attempt: null, review: false, uncertain: false }));
  const currentDraft = useRef(draft), incarnation = useRef(0), revision = useRef(0);
  // Neither reporting nor pure GET acknowledges edit-back or a secret whose
  // write reply was lost. Only its receipt or an explicit discard can do that.
  const fieldRevisions = useRef<Partial<Record<AccountField, number>>>({});
  const recordsEpoch = useRef(0), operation = useRef<Operation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const selected = grants.find(grant => grant.key === draft.selection);
  const inspected = grants.find(grant => grant.key === accountKey(draft.attempt ?? draft.value));
  const canReview = inspected?.source === "owner" && draft.inspection === "ready";

  function newForm(): UpstreamGrantForm { return { ...defaultUpstreamGrant, tokenRef: `acct_${crypto.randomUUID()}` }; }
  function captureHydration() { return operation.current ? null : recordsEpoch.current; }
  function hydrate(nextGrants: UpstreamGrant[], policyId: string, providerRows: ProviderRow[], snapshot: number | null) {
    if (!isCurrent() || snapshot === null || snapshot !== recordsEpoch.current || operation.current) return;
    const firstAdmission = !readyRef.current;
    updateRows(mergeAccountInventory(rows.current, nextGrants));
    readyRef.current = true; setReady(true);
    const current = currentDraft.current;
    if (current.initialized && !current.selection) {
      if (firstAdmission) {
        const value = { ...current.value };
        if (value.scope === "policies" && !fieldRevisions.current.scopeId) value.scopeId = policyId;
        if (!fieldRevisions.current.provider) value.provider = providerRows[0]?.id ?? "";
        publishDraft({ ...current, value });
      }
      return;
    }
    const known = rows.current.filter(isAccountRow);
    const grant = current.initialized ? known.find(item => item.key === current.selection) : known[0];
    if (grant) {
      if (!current.initialized) resetDraft(grant.key, upstreamGrantFormFromGrant(grant));
      else if (current.mode === "edit") rebaseDraft(grant.key, upstreamGrantFormFromGrant(grant), markedFields());
    } else if (!current.initialized) resetDraft("", { ...newForm(), scopeId: policyId, provider: providerRows[0]?.id ?? "" });
    inspectIfNeeded();
  }

  function begin(phase: "reading" | "writing"): Operation | null {
    if (!isCurrent() || phase === "writing" && !readyRef.current || operation.current && operation.current.phase !== "refreshing") return null;
    const op: Operation = { phase };
    operation.current = op; recordsEpoch.current += 1; setBusy(true);
    return op;
  }
  function inspectIfNeeded() {
    if (currentDraft.current.selection && currentDraft.current.inspection === "unread" && (!operation.current || operation.current.phase === "refreshing")) void inspect();
  }
  async function inspect() {
    const submitted = currentDraft.current, identity = submitted.attempt ?? submitted.value;
    if (!submitted.selection && !submitted.attempt) return;
    const op = begin("reading"); if (!op) return;
    setError("");
    const editor = incarnation.current;
    publishDraft({ ...submitted, inspection: "loading" });
    try {
      const existing = rows.current.filter(isAccountRow).find(row => row.key === accountKey(identity));
      const value = demoMode && existing ? demoAccountView(existing) : await request<unknown>(gatewayOrigin, accountPath(identity));
      if (isCurrent() && operation.current === op && incarnation.current === editor) {
        const view = readAccountView(value, identity);
        putRow({ ...view, source: "owner", observations: existing?.observations });
        updateCreation(identity, creation => ({ ...creation, inspection: "ready", error: "" }));
        const current = currentDraft.current, initial = current.generation === null && !current.uncertain && !current.review;
        // The first owned read admits editing. Later reads may show a new version,
        // but cannot silently move an existing edit's CAS baseline.
        publishDraft({ ...current, inspection: "ready", generation: initial ? view.credentialGeneration : current.generation,
          review: current.review || current.uncertain || !initial && current.generation !== view.credentialGeneration });
        if (current.mode === "edit") rebaseDraft(current.selection, upstreamGrantFormFromGrant(view), markedFields());
      }
    } catch (caught) {
      if (isCurrent() && operation.current === op && incarnation.current === editor) {
        const legacy = caught instanceof DashboardRequestError && ["grant_credential_missing", "grant_owner_initialization_required"].includes(caught.code ?? "");
        publishDraft({ ...currentDraft.current, inspection: legacy ? "legacy" : "failed" });
        setError(legacy ? submitted.selection ? "No initialized account owner was found. Inspect publication recovery, or explicitly replace the legacy account with fresh credentials or revoke it."
          : "No owner is currently readable for this account. Keep its reference, inspect publication recovery, then check again. Starting a new account is a separate intent; checking does not replay creation." : errorMessage(caught));
      }
    } finally { release(op); }
    return isCurrent() && !operation.current ? recordsEpoch.current : null;
  }

  async function save(event: FormEvent) { event.preventDefault(); await mutate("save"); }
  async function revoke(grant: AccountRow) { await mutate("revoke", grant); }
  async function refreshGrant(grant: AccountRow) { await mutate("refresh", grant); }
  async function refreshQuota(grant: AccountRow) { await mutate("quota-refresh", grant); }
  async function pause(grant: AccountRow) { await mutate("pause", grant); }
  async function mutate(action: Action, target?: AccountRow) {
    const submitted = currentDraft.current;
    const strictEdit = action === "pause" || action === "save" && ["edit", "replace"].includes(submitted.mode);
    if ((strictEdit && (submitted.inspection !== "ready" || submitted.generation === null) || action === "save" && submitted.mode === "legacy-replace" && submitted.inspection !== "legacy")
      || (action === "save" || action === "pause") && (submitted.review || submitted.uncertain)) {
      setError("Check the account and review its current version before saving."); return;
    }
    if (target && submitted.selection !== target.key) return;
    const op = begin("writing"); if (!op) return;
    setError("");
    const submittedIncarnation = incarnation.current, submittedRevision = revision.current, intentFields = markedFields();
    const form = action === "pause" && target ? { ...upstreamGrantFormFromGrant(target), enabled: !target.enabled } : submitted.value;
    const identity: AccountIdentity = { scope: target?.scope ?? form.scope, scopeId: target?.scopeId ?? form.scopeId.trim(), tokenRef: target?.tokenRef ?? form.tokenRef };
    const key = accountKey(identity), existing = rows.current.filter(isAccountRow).find(grant => grant.key === key), intent = action === "pause" ? "edit" : submitted.mode;
    const creating = action === "save" && intent === "create";
    const strictMutation = (action === "save" || action === "pause") && intent !== "legacy-replace";
    let sent = false;
    setStatus(messages[action][0]);
    try {
      const body = action === "save" || action === "pause" ? accountMutationBody(form, intent, action === "pause" ? new Set<AccountField>(["enabled"]) : intentFields, submitted.generation) : undefined;
      if (creating) {
        publishDraft({ ...currentDraft.current, attempt: identity });
        // The dispatched request owns its address even if the operator starts
        // another draft. This entry contains no secret or invented owner facts.
        const creation: AccountCreation = { status: "pending", requested: { provider: form.provider, label: form.label }, inspection: "unread", error: "" };
        updateRows([{ ...(existing ?? { ...identity, key, source: "attempt" as const }), creation }, ...rows.current.filter(row => row.key !== key)]);
      }
      let saved: AccountRow;
      if (demoMode) {
        saved = body ? { ...demoAccountMutation({ ...form, ...identity }, intent, body, existing), source: "owner" }
          : action === "revoke" ? { ...demoAccountView(target!), source: "owner", credentialGeneration: demoAccountView(target!).credentialGeneration + 1, enabled: false, usable: false, hasCredential: false, credentialFields: [], hasAccessToken: false, hasRefreshToken: false, revokedAt: new Date().toISOString() }
          : { ...demoAccountView(target!), source: "owner", observations: target?.observations };
      } else {
        const method = !body ? "POST" : intent === "edit" ? "PATCH" : intent === "legacy-replace" ? "PUT" : "POST";
        const suffix = !body ? `/${action}` : intent === "replace" ? "/replace" : intent === "legacy-replace" ? "?mode=replace" : "";
        sent = true;
        const result = await request<unknown>(gatewayOrigin, `${accountPath(identity)}${suffix}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
        if (strictMutation) saved = { ...readAccountReceipt(result, identity), source: "owner" };
        else saved = readLegacyAccount(result, identity);
      }
      if (!isCurrent()) { release(op); return; }
      putRow(saved, creating);
      const sameEditor = incarnation.current === submittedIncarnation;
      if (currentDraft.current.selection === key || sameEditor && action === "save" && !submitted.selection) {
        const assigned = new Set<AccountField>(body ? action === "pause" ? ["enabled"] : [...intentFields].filter(field => !secretFields.includes(field)) : []);
        if (body) for (const field of secretFields) {
          const sentField = field === "credentialBundle" ? "credentials" : field;
          if (field === "removeRefreshToken" ? body.refreshToken === null : Object.hasOwn(body, sentField) && body[sentField] !== null) assigned.add(field);
        }
        const preserve = new Set(fields.filter(field => !sameEditor ? Boolean(fieldRevisions.current[field]) || secretFields.includes(field)
          : (fieldRevisions.current[field] ?? 0) > submittedRevision
          || body && !assigned.has(field) && (intentFields.has(field) || secretFields.includes(field))
          || !body && intentFields.has(field) && !(action === "revoke" && (field === "enabled" || secretFields.includes(field)))));
        rebaseDraft(key, upstreamGrantFormFromGrant(saved), preserve);
        const remainingSecret = secretFields.some(field => field !== "removeRefreshToken" && Boolean(currentDraft.current.value[field]));
        // Refresh and revoke acknowledge their own action, not a previous
        // conflicted edit. Keep its CAS so the following GET remains a review.
        const unresolved = submitted.review || submitted.uncertain;
        if (sameEditor) publishDraft({ ...currentDraft.current, mode: action === "save" ? remainingSecret ? "replace" : "edit" : currentDraft.current.mode,
          generation: unresolved ? submitted.generation : saved.source === "owner" ? saved.credentialGeneration : null,
          inspection: saved.source === "owner" ? "ready" : "unread", attempt: unresolved ? submitted.attempt : null,
          review: unresolved && submitted.review, uncertain: unresolved && submitted.uncertain });
      }
      setStatus(messages[action][1]);
      op.phase = "refreshing"; setBusy(false);
      if (demoMode) release(op);
      else if (currentDraft.current.selection && currentDraft.current.inspection === "unread") {
        // Bare legacy responses do not admit a generation. Finish that owner
        // read before scheduling metadata, whose predicate runs after old reads.
        const epoch = await inspect();
        if (typeof epoch === "number") void refresh(() => isCurrent() && !operation.current && recordsEpoch.current === epoch);
      } else void refresh(() => isCurrent() && operation.current === op).finally(() => release(op));
    } catch (caught) {
      if (!isCurrent()) { release(op); return; }
      // Legacy adapters can return an attachment conflict after committing the
      // credential. Only strict receipts distinguish that from rejected edits.
      const rejected = caught instanceof DashboardRequestError && caught.status >= 400 && caught.status < 500 && (strictMutation || caught.status !== 409);
      const conflict = caught instanceof DashboardRequestError && caught.status === 409;
      const detail = caught instanceof DashboardRequestError ? caught.detail as { grant?: unknown } | null : null;
      if (detail?.grant) {
        try { putRow({ ...readAccountView(detail.grant, identity), source: "owner" }); } catch { /* A mismatched detail cannot change this account. */ }
      }
      const conflictMessage = caught instanceof DashboardRequestError && caught.code === "grant_reconnect_required"
        ? "This account was revoked. Check and review its current version, then prepare a credential replacement with a fresh primary secret."
        : caught instanceof DashboardRequestError && caught.code === "grant_generation_exhausted"
          ? "This account cannot accept another credential version. Use a new account for fresh credentials and ask the router operator to retire this reference. Checking will not reset its version."
          : "This account changed or already exists. Check its current version, then review it before saving again.";
      const message = sent && !rejected ? "The change could not be confirmed. Check this account's status before choosing another action; it may have committed."
        : conflict ? conflictMessage : errorMessage(caught);
      if (creating && sent) {
        if (rejected) resolveCreation(identity);
        else updateCreation(identity, creation => ({ ...creation, status: "unconfirmed", inspection: "unread", error: message }));
      }
      if (incarnation.current === submittedIncarnation) {
        publishDraft({ ...currentDraft.current, attempt: sent ? identity : currentDraft.current.attempt, review: currentDraft.current.review || conflict, uncertain: currentDraft.current.uncertain || sent && !rejected,
          inspection: conflict || sent && !rejected ? "failed" : currentDraft.current.inspection });
        setError(message);
      }
      setStatus(`account ${action} failed: ${message}`);
      release(op);
      const releasedEpoch = recordsEpoch.current;
      if (sent) void refresh(() => isCurrent() && !operation.current && recordsEpoch.current === releasedEpoch);
    }
  }

  function release(op: Operation) {
    if (operation.current !== op) return;
    recordsEpoch.current += 1; operation.current = null;
    if (isCurrent()) { setBusy(false); inspectIfNeeded(); }
  }
  async function authorize() {
    const op = begin("writing"); if (!op) return;
    setError("");
    const form = currentDraft.current.value;
    try {
      const scopeId = form.scopeId.trim(), tokenRef = form.tokenRef, provider = form.provider;
      if (!scopeId || !tokenRef || !provider) throw new Error("scope and provider are required");
      const priority = Number(form.priority), weight = Number(form.weight);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) throw new Error("priority must be an integer from 0 to 1000000");
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1_000_000) throw new Error("weight must be greater than 0 and at most 1000000");
      if (!providers.find(item => item.id === provider)?.auth?.authorization) throw new Error("selected provider does not support browser OAuth");
      setStatus("connecting account");
      if (demoMode) { release(op); setStatus("browser OAuth unavailable in local demo"); return; }
      const result = await request<{ authorizationUrl: string }>(gatewayOrigin, `${accountPath({ scope: form.scope, scopeId, tokenRef })}/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, priority, weight }) });
      if (!isCurrent()) { release(op); return; }
      // Navigation retains admission until unload. Inspection and sign-in
      // recovery must not replay a sent authorization.
      window.location.assign(result.authorizationUrl);
    } catch (caught) { release(op); if (isCurrent()) { setError(errorMessage(caught)); setStatus(errorMessage(caught)); } }
  }

  function updateRows(next: AccountEntry[]) { rows.current = next; setEntries(next); }
  function putRow(row: AccountRow, acknowledgedCreate = false) {
    const creation = rows.current.find(item => item.key === row.key)?.creation;
    updateRows([{ ...row, ...(!acknowledgedCreate && creation ? { creation } : {}) }, ...rows.current.filter(item => item.key !== row.key)]);
  }
  function updateCreation(identity: AccountIdentity, update: (creation: AccountCreation) => AccountCreation) {
    updateRows(rows.current.map(row => row.key === accountKey(identity) && row.creation ? { ...row, creation: update(row.creation) } : row));
  }
  function resolveCreation(identity: AccountIdentity) {
    updateRows(rows.current.flatMap(row => {
      if (row.key !== accountKey(identity)) return [row];
      if (!isAccountRow(row)) return [];
      const { creation: _creation, ...known } = row;
      return [known];
    }));
  }
  async function checkCreation(entry: AccountEntry) {
    const current = rows.current.find(row => row.key === entry.key);
    if (!current?.creation || current.creation.status === "pending") return;
    const op = begin("reading"); if (!op) return;
    const marker = { ...current.creation, inspection: "loading" as const, error: "" };
    updateCreation(current, () => marker);
    try {
      const value = await request<unknown>(gatewayOrigin, accountPath(current));
      if (!isCurrent() || operation.current !== op || rows.current.find(row => row.key === current.key)?.creation !== marker) return;
      const view = readAccountView(value, current);
      putRow({ ...view, source: "owner", observations: isAccountRow(current) ? current.observations : undefined });
      updateCreation(current, creation => ({ ...creation, inspection: "ready" }));
    } catch (caught) {
      if (isCurrent() && operation.current === op && rows.current.find(row => row.key === current.key)?.creation === marker) {
        updateCreation(current, creation => ({ ...creation, inspection: "failed", error: `Account status could not be read: ${errorMessage(caught)}. Keep this reference, check publication recovery, then check again. This does not replay creation.` }));
      }
    } finally { release(op); }
  }
  function reviewCreation(entry: AccountEntry) {
    const current = rows.current.find(row => row.key === entry.key);
    if (!isCurrent() || operation.current && operation.current.phase !== "refreshing" || current?.source !== "owner" || current.creation?.inspection !== "ready") return;
    // Deliberate navigation starts only from A's verified facts, never B's
    // fields or secrets. Adopting its version remains a separate decision.
    resetDraft(current.key, upstreamGrantFormFromGrant(current));
    publishDraft({ ...currentDraft.current, inspection: "ready", attempt: { scope: current.scope, scopeId: current.scopeId, tokenRef: current.tokenRef }, review: true, uncertain: current.creation.status === "unconfirmed" });
  }
  function publishDraft(next: Draft) { currentDraft.current = next; setDraft(next); }
  function markedFields() { return new Set(fields.filter(field => Boolean(fieldRevisions.current[field]))); }
  function resetDraft(selection: string, value: UpstreamGrantForm, mode: AccountIntent = selection ? "edit" : "create") {
    incarnation.current += 1; fieldRevisions.current = {};
    publishDraft({ selection, value, initialized: true, mode, generation: null, inspection: selection ? "unread" : "ready", attempt: null, review: false, uncertain: false });
    setError("");
  }
  function rebaseDraft(selection: string, canonical: UpstreamGrantForm, preserve: Set<AccountField>) {
    const value = { ...canonical };
    for (const field of fields) {
      if (preserve.has(field)) Object.assign(value, { [field]: currentDraft.current.value[field] });
      else delete fieldRevisions.current[field];
    }
    publishDraft({ ...currentDraft.current, selection, value, initialized: true });
  }
  function setForm(next: SetStateAction<UpstreamGrantForm>) {
    const current = currentDraft.current, value = typeof next === "function" ? next(current.value) : next;
    const changed = fields.filter(field => value[field] !== current.value[field]);
    // A sent create keeps its resource address through an uncertain reply.
    // Retargeting is an explicit New action, never another POST by accident.
    if (!changed.length || current.attempt && changed.some(field => identityFields.includes(field))) return;
    revision.current += 1;
    if (!current.selection && changed.some(field => identityFields.includes(field))) incarnation.current += 1;
    for (const field of changed) fieldRevisions.current[field] = revision.current;
    publishDraft({ ...current, value, initialized: true });
  }
  function edit(grant: AccountRow) {
    const found = rows.current.find(item => item.key === grant.key), current = found && isAccountRow(found) ? found : grant;
    resetDraft(grant.key, upstreamGrantFormFromGrant(current));
    if (current.creation) publishDraft({ ...currentDraft.current, attempt: { scope: current.scope, scopeId: current.scopeId, tokenRef: current.tokenRef }, review: true, uncertain: current.creation.status === "unconfirmed",
      inspection: current.source === "owner" && current.creation.inspection === "ready" ? "ready" : "unread" });
    inspectIfNeeded();
  }
  function startNew() { const provider = providers[0]?.id ?? ""; resetDraft("", { ...newForm(), scopeId: policies.find(policy => policy.policyId === selectedPolicyId)?.policyId ?? policies[0]?.policyId ?? "", provider }); }
  function startReplace(legacy = false) {
    const current = currentDraft.current;
    if (!current.selection || legacy && current.inspection !== "legacy" || !legacy && (current.generation === null || current.review || current.uncertain)) return;
    incarnation.current += 1; revision.current += 1;
    fieldRevisions.current = { ...fieldRevisions.current, ...Object.fromEntries([...secretFields, "accountId", "expiresAt"].map(field => [field, revision.current])) };
    publishDraft({ ...current, mode: legacy ? "legacy-replace" : "replace", value: { ...current.value, credential: "", credentialBundle: "", accessToken: "", refreshToken: "", removeRefreshToken: false, accountId: "", expiresAt: "" } });
    setError("");
  }
  function reviewCurrent(discard = false) {
    const current = currentDraft.current, identity = current.attempt ?? current.value;
    const row = rows.current.find(item => item.key === accountKey(identity));
    if (!isCurrent() || operation.current && operation.current.phase !== "refreshing" || current.inspection !== "ready" || row?.source !== "owner") return;
    if (!discard && (row.provider !== current.value.provider || row.kind !== current.value.kind)) { setError("The provider or credential kind changed. Use saved values to discard this draft, or start a new account."); return; }
    rebaseDraft(row.key, upstreamGrantFormFromGrant(row), discard ? new Set<AccountField>() : new Set([...markedFields(), ...secretFields]));
    incarnation.current += 1;
    resolveCreation(identity);
    publishDraft({ ...currentDraft.current, generation: row.credentialGeneration, inspection: "ready", mode: discard ? "edit" : current.mode === "create" ? "replace" : current.mode,
      review: false, uncertain: false, attempt: null });
    setError("");
  }

  return { upstream: { items: grants, creations: entries.filter(entry => entry.creation), checkCreation, reviewCreation, selected, selectedKey: draft.selection, form: draft.value, setForm, ready, busy, error, mode: draft.mode, inspection: draft.inspection,
    generation: draft.generation, needsReview: draft.review || draft.uncertain, uncertain: draft.uncertain, identityLocked: Boolean(draft.selection || draft.attempt), inspected, canReview,
    save, pause, revoke, refresh: refreshGrant, refreshQuota, authorize, edit, startNew, startReplace, inspect, reviewCurrent }, captureHydration, hydrate };
}

export type UpstreamAdminModel = ReturnType<typeof useUpstreamAdmin>["upstream"];
