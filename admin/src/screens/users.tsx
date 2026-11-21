import { type FormEvent, useState } from "react";
import { Plus, Search, ShieldCheck, Users } from "lucide-react";
import { bindingKey, effectiveAccess, kindLabel } from "../domain";
import { EntityTable, EntityName, InlineError, InlineNote, InspectorHeader, MiniListItem, Status } from "../components";
import { effectiveProviderCount } from "../ui-helpers";
import { CapsView } from "./caps";
import type { AccessForm, AccessPolicy, AccessUser, PolicyBinding, ServiceItem } from "../ui-types";

export function UsersScreen({ users, selected, policies, bindings, services, form, setForm, error, onOpenPolicy, onSelect, onNew, onSave, busy }: {
  users: AccessUser[];
  selected?: AccessUser;
  policies: AccessPolicy[];
  bindings: PolicyBinding[];
  services: ServiceItem[];
  form: AccessForm;
  setForm: (form: AccessForm) => void;
  error: string;
  onOpenPolicy: (policy: AccessPolicy) => void;
  onSelect: (user: AccessUser) => void;
  onNew: () => void;
  onSave: (event: FormEvent) => void;
  busy: boolean;
}) {
  const [userQuery, setUserQuery] = useState("");
  const [caps, setCaps] = useState(false);
  const accessForUser = (user: AccessUser | undefined) => effectiveAccess(user, policies, bindings, services);
  const selectedAccess = accessForUser(selected);
  const selectedServices = selectedAccess.services.map((service) => ({ service, label: "granted" }));
  const selectedGroups = new Set(selected?.groups ?? []);
  const selectedBindings = bindings
    .filter((binding) => binding.enabled && selected && (binding.principalType === "user" ? binding.principalId === selected.email : selectedGroups.has(binding.principalId)))
    .sort((a, b) => a.priority - b.priority || a.policyId.localeCompare(b.policyId));
  if (caps) return <CapsView onBack={() => setCaps(false)} />;
  const visibleUsers = users.filter((user) => !userQuery.trim() || [user.email, user.tenantId, user.groups.join(" ")].join(" ").toLowerCase().includes(userQuery.trim().toLowerCase()));
  return (
    <div className="entityLayout">
      <section className="mainPane">
        <div className="tableSectionHeader userListHeader"><button type="button" onClick={() => setCaps(true)}>Caps</button><label className="inputWithIcon"><Search aria-hidden="true" /><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="search identities or groups" /></label><button type="button" onClick={onNew} disabled={busy}><Plus className="buttonIcon" aria-hidden="true" /><span>New identity</span></button></div>
        <EntityTable columns={["identity", "role", "tenant", "policies", "services", "retention", "status"]} columnTemplate="minmax(240px, 1.5fr) 80px 110px 78px 78px 92px 104px" rows={visibleUsers.map((user) => {
          const access = accessForUser(user);
          return { id: user.email, active: selected?.email === user.email, onClick: () => onSelect(user), cells: [<EntityName icon={Users} title={user.email} subtitle="Cloudflare Access" />, user.role, user.tenantId, String(access.policies.length), String(access.services.length), <Status label={user.contentRetentionDisabled ? "exempt" : "policy"} tone={user.contentRetentionDisabled ? "neutral" : "active"} />, <Status label={user.enabled ? "enabled" : "disabled"} tone={user.enabled ? "active" : "revoked"} />] };
        })} />
      </section>
      <aside className="inspector">
        <form onSubmit={onSave}>
          <InspectorHeader icon={Users} title="Access user" subtitle={selected?.email ?? "new user"} />
          {error ? <InlineError message={error} /> : null}
          <InlineNote>Users are created from Cloudflare Access on first login with no policies. Admin status controls the console only; service access always requires an explicit user or group binding.</InlineNote>
          <div className="formGrid compact">
            <label className="full"><span>email</span><input type="email" value={form.email} readOnly={Boolean(selected)} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <label><span>tenant</span><input value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} /></label>
            <label><span>status</span><select value={form.enabled ? "enabled" : "disabled"} onChange={(event) => setForm({ ...form, enabled: event.target.value === "enabled" })}><option value="enabled">enabled</option><option value="disabled">disabled</option></select></label>
            <label className="full"><span>groups</span><input value={form.groups} onChange={(event) => setForm({ ...form, groups: event.target.value })} placeholder="maintainers, docs" /></label>
            <label className="full"><span>request content retention</span><select value={form.contentRetentionDisabled ? "exempt" : "policy"} onChange={(event) => setForm({ ...form, contentRetentionDisabled: event.target.value === "exempt" })}><option value="policy">follow policy · retained by default</option><option value="exempt">exempt · never retain</option></select></label>
          </div>
          <InlineNote>Exemption wins across browser sessions and every proxy credential owned by this user.</InlineNote>
          <dl className="facts"><dt>granted services</dt><dd>{selectedAccess.services.length}</dd><dt>active policies</dt><dd>{selectedAccess.policies.length}</dd><dt>console role</dt><dd>{selected?.role ?? "user"}</dd><dt>tenant</dt><dd>{selected?.tenantId ?? form.tenantId}</dd></dl>
          <div className="sectionTitle">Direct policies</div>
          <div className="serviceMatrix">{policies.map((policy) => <label key={policy.policyId}><input type="checkbox" checked={form.policyIds.includes(policy.policyId)} onChange={() => setForm({ ...form, policyIds: form.policyIds.includes(policy.policyId) ? form.policyIds.filter((id) => id !== policy.policyId) : [...form.policyIds, policy.policyId].sort() })} /><span>{policy.policyId}</span><small>{effectiveProviderCount(policy.providers, services)} services</small></label>)}</div>
          <div className="sectionTitle">Effective policies</div>
          <div className="miniList">{selectedBindings.length ? selectedBindings.map((binding) => {
            const policy = policies.find((item) => item.policyId === binding.policyId);
            return <MiniListItem key={bindingKey(binding)} onClick={policy ? () => onOpenPolicy(policy) : undefined}>{binding.policyId}<span>{binding.principalType === "user" ? "direct" : `via ${binding.principalId}`} · priority {binding.priority}</span></MiniListItem>;
          }) : <p>No user or group policies assigned.</p>}</div>
          <div className="sectionTitle">Effective access</div>
          <div className="miniList">{selectedServices.length ? selectedServices.slice(0, 8).map(({ service, label }) => <MiniListItem key={service.id}>{service.name}<span>{label} · {kindLabel(service.kind)}</span></MiniListItem>) : <p>No services available for this user.</p>}</div>
          <div className="inspectorActions"><button type="submit" disabled={busy}><ShieldCheck className="buttonIcon" aria-hidden="true" /><span>Save user</span></button></div>
        </form>
      </aside>
    </div>
  );
}
