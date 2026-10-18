import { useEffect, useRef, useState } from "react";
import { useConsole } from "../console-controller-context";
import { InlineError, InlineNote } from "../components";
import { parseBudgetUsd } from "../cost-presentation";
import type { AccessPolicy, AccessUser, BudgetStatus } from "../ui-types";

type WindowName = "daily" | "weekly" | "monthly";
const windows: WindowName[] = ["daily", "weekly", "monthly"];
type Caps = { rows: Array<{ policy: AccessPolicy; members: Array<{ email: string; budget: BudgetStatus }> }>; users: AccessUser[] };
const field = (window: WindowName) => `${window}BudgetMicros` as const;
const dollars = (amount: number | null | undefined) => amount == null ? "unlimited" : `$${(amount / 1e6).toFixed(2)}`;

export function CapsView({ onBack }: { onBack: () => void }) {
  const { session, access, request } = useConsole();
  const demo = session.demoMode;
  const [data, setData] = useState<Caps | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [selected, setSelected] = useState("");
  const load = () => request<Caps>(session.gatewayOrigin, "/v1/admin/caps");
  useEffect(() => {
    let active = true;
    if (demo) setData({ users: access.users.items, rows: access.policies.items.map(policy => ({ policy, members: policy.budgetScope === "principal" ? access.users.items.map(user => ({ email: user.email, budget: { configured: true, ledger: "demo", spentMicros: 0, daily: { configured: false, ledger: "demo", spentMicros: 0, resetsAt: "" }, weekly: { configured: false, ledger: "demo", spentMicros: 0, resetsAt: "" } } })) : [] })) });
    else void load().then(value => { if (active) setData(value); }).catch(caught => { if (active) setError(String(caught)); });
    return () => { active = false; };
  }, []);
  if (session.value.role !== "admin") return null;
  const row = data?.rows.find(item => item.policy.policyId === selected) ?? data?.rows[0];
  async function save(window: WindowName, value: string, email?: string) {
    if (!row || !data || pending.current) return;
    const key = field(window);
    const amount = value === "inherit" ? undefined : value === "unlimited" ? null : parseBudgetUsd(value);
    if (amount !== undefined && amount !== null && (!value.trim() || !Number.isSafeInteger(amount) || amount < 0)) { setError("Enter non-negative USD with at most six decimal places."); return; }
    const user = data.users.find(item => item.email === email);
    const { updatedBy: _by, updatedAt: _at, ...current } = user?.budgetOverrides?.[row.policy.policyId] ?? {};
    const values = email ? { ...current, [key]: amount } : { [key]: amount };
    const path = email ? `/v1/admin/access-users/${encodeURIComponent(email)}/budget-overrides/${encodeURIComponent(row.policy.policyId)}` : `/v1/admin/policies/${encodeURIComponent(row.policy.policyId)}/budget-limits`;
    pending.current = true; setBusy(true); setError("");
    try {
      if (demo) {
        if (user) setData({ ...data, users: data.users.map(item => item.email === email ? { ...item, budgetOverrides: { ...item.budgetOverrides, [row.policy.policyId]: { ...values, updatedBy: session.value.email!, updatedAt: new Date().toISOString() } } } : item) });
        else setData({ ...data, rows: data.rows.map(item => item === row ? { ...item, policy: { ...item.policy, ...values } } : item) });
      } else {
        await request(session.gatewayOrigin, path, { method: "PUT", headers: { "content-type": "application/json", ...(email ? { "if-match": user?.budgetOverrides?.[row.policy.policyId]?.updatedAt ?? "absent" } : {}) }, body: JSON.stringify(values) });
        setData(await load());
      }
    } catch (caught) { setError(String(caught)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="mainPane capsView" aria-label="Caps">
    <div className="tableSectionHeader"><h2>Caps</h2><button onClick={onBack} disabled={busy}>Back to users</button></div>
    {error && <><InlineError message={error} /><button disabled={busy} onClick={() => { void load().then(value => { setData(value); setError(""); }).catch(caught => setError(String(caught))); }}>Refresh caps</button></>}
    <InlineNote>Default caps apply to a policy. Member overrides apply across that member’s keys and sessions. Zero blocks requests. Unlimited removes that window’s cap.</InlineNote>
    <label>Policy <select aria-label="Caps policy" value={row?.policy.policyId ?? ""} disabled={busy} onChange={event => setSelected(event.target.value)}>{data?.rows.map(item => <option key={item.policy.policyId}>{item.policy.policyId}</option>)}</select></label>
    {!data && !error && <p>Loading caps…</p>}
    {row && <>
      <h3>Policy defaults</h3><div className="capsDefaults">{windows.map(window => <CapEditor key={`${row.policy.policyId}-${window}`} label={`Default ${window} cap`} value={row.policy[field(window)]} disabled={busy} onSave={value => save(window, value)} />)}</div>
      {row.policy.budgetScope !== "principal" ? <InlineNote>This policy shares one budget. Member overrides apply only to principal-scoped policies.</InlineNote> : <>
        <h3>Member caps</h3><div className="capsTable"><table><thead><tr><th>Member</th>{windows.map(window => <th key={window}>{window} spend / cap</th>)}<th>Last changed</th></tr></thead><tbody>{row.members.map(member => {
          const override = data!.users.find(user => user.email === member.email)?.budgetOverrides?.[row.policy.policyId];
          return <tr key={member.email}><th scope="row">{member.email}</th>{windows.map(window => {
            const key = field(window), inherited = override?.[key] === undefined, cap = inherited ? row.policy[key] : override[key];
            const budget = window === "monthly" ? member.budget : member.budget[window];
            return <td key={window} data-label={`${window} spend / cap`}><p>{budget?.spentMicros == null ? "unknown" : dollars(budget.spentMicros)} / {dollars(cap)}{inherited ? " (inherited)" : " (override)"}</p><CapEditor key={`${row.policy.policyId}-${override?.updatedAt}-${cap}-${inherited}`} label={`${member.email} ${window} cap`} value={inherited ? undefined : cap} inherit disabled={busy} onSave={value => save(window, value, member.email)} /></td>;
          })}<td>{override ? `${override.updatedBy} · ${override.updatedAt}` : "Policy default"}</td></tr>;
        })}</tbody></table></div>
      </>}
    </>}
  </section>;
}

function CapEditor({ label, value, inherit, disabled, onSave }: { label: string; value?: number | null; inherit?: boolean; disabled: boolean; onSave: (value: string) => Promise<void> }) {
  const [mode, setMode] = useState(value === undefined && inherit ? "inherit" : value == null ? "unlimited" : "number");
  const [amount, setAmount] = useState(value == null ? "" : String(value / 1e6));
  return <form className="capEditor" onSubmit={event => { event.preventDefault(); void onSave(mode === "number" ? amount : mode); }}><label><span className={inherit ? "srOnly" : undefined}>{label}</span><select aria-label={`${label} mode`} value={mode} disabled={disabled} onChange={event => setMode(event.target.value)}>{inherit && <option value="inherit">Inherit</option>}<option value="unlimited">Unlimited</option><option value="number">Amount (USD)</option></select></label>{mode === "number" && <input aria-label={`${label} USD`} inputMode="decimal" value={amount} disabled={disabled} onChange={event => setAmount(event.target.value)} />}<button disabled={disabled} type="submit" aria-label={`Save ${label}`}>Save</button></form>;
}
