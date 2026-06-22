import { type FormEvent, useState } from "react";
import { errorMessage, optionalNumber, parseGroups } from "../../domain";
import { defaultAssignmentRule, demo } from "../../ui-config";
import { assignmentRuleFormFromRule, demoRuleFromForm, request } from "../../ui-helpers";
import type { AssignmentRule, AssignmentRuleForm } from "../../ui-types";

interface Dependencies {
  allowDemo: boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  setError: (message: string) => void;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
}

export function useAssignmentAdmin({ allowDemo, gatewayOrigin, demoMode, setError, setStatus, refresh }: Dependencies) {
  const [rules, setRules] = useState<AssignmentRule[]>(allowDemo ? demo.assignmentRules : []);
  const [form, setForm] = useState<AssignmentRuleForm>(allowDemo && demo.assignmentRules[0] ? assignmentRuleFormFromRule(demo.assignmentRules[0]) : defaultAssignmentRule);
  const [selectedId, setSelectedId] = useState(allowDemo ? demo.assignmentRules[0]?.ruleId ?? "" : "");
  const selected = rules.find((rule) => rule.ruleId === selectedId);

  function hydrate(nextRules: AssignmentRule[], background: boolean) {
    setRules(nextRules);
    if (background) return;
    const refreshed = nextRules.find((rule) => rule.ruleId === selectedId) ?? nextRules[0];
    setSelectedId(refreshed?.ruleId ?? "");
    setForm(refreshed ? assignmentRuleFormFromRule(refreshed) : defaultAssignmentRule);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      setError("");
      const ruleId = form.ruleId.trim();
      if (!/^[a-z0-9_]{4,48}$/.test(ruleId)) throw new Error("rule id must use 4-48 lowercase letters, numbers, or underscores");
      if (!form.subject.trim()) throw new Error("rule subject is required");
      const body = { version: 1, enabled: form.enabled, kind: form.kind, subject: form.subject.trim(), groups: parseGroups(form.groups), policyIds: form.policyIds, priority: optionalNumber(form.priority) ?? 100, revokeOnLoss: form.revokeOnLoss, provenance: form.provenance.trim() };
      setStatus("saving assignment rule");
      let saved: AssignmentRule;
      if (demoMode) {
        saved = demoRuleFromForm(form);
        setRules((current) => [saved, ...current.filter((rule) => rule.ruleId !== saved.ruleId)]);
      } else {
        saved = await request<AssignmentRule>(gatewayOrigin, `/v1/admin/assignment-rules/${encodeURIComponent(ruleId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        await refresh();
      }
      setSelectedId(saved.ruleId);
      setForm(assignmentRuleFormFromRule(saved));
      setStatus("saved assignment rule");
    } catch (caught) { handleError(caught); }
  }

  async function reconcile() {
    try {
      setError("");
      setStatus("reconciling assignments");
      if (!demoMode) {
        await request<{ results: unknown[] }>(gatewayOrigin, "/v1/admin/assignment-rules/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
        await refresh();
      }
      setStatus("reconciled assignments");
    } catch (caught) { handleError(caught); }
  }

  function edit(rule: AssignmentRule) { setSelectedId(rule.ruleId); setForm(assignmentRuleFormFromRule(rule)); }
  function startNew() { setSelectedId(""); setForm({ ...defaultAssignmentRule, policyIds: [] }); }
  function handleError(caught: unknown) { const message = errorMessage(caught); setError(message); setStatus(message); }

  return { assignments: { items: rules, setItems: setRules, selected, selectedId, setSelectedId, form, setForm, save, reconcile, edit, startNew }, hydrate };
}
