import { type FormEvent, useRef, useState } from "react";
import { errorMessage, optionalNumber, parseGroups } from "../../domain";
import { defaultAssignmentRule, demo } from "../../ui-config";
import { assignmentRuleFormFromRule, demoRuleFromForm } from "../../ui-helpers";
import type { ConsoleRequest } from "../../dashboard-fetch";
import type { AssignmentRule, AssignmentRuleForm } from "../../ui-types";

interface Dependencies {
  request: ConsoleRequest;
  allowDemo: boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  setError: (message: string) => void;
  setStatus: (status: string) => void;
  refresh: () => Promise<void>;
}

interface RuleEditor {
  // null follows the initial inventory; an explicit New editor stays new.
  selectedId: string | null;
  base: AssignmentRuleForm;
  edits: Partial<AssignmentRuleForm> | null;
}

function editorFor(rule?: AssignmentRule): RuleEditor {
  return { selectedId: rule?.ruleId ?? null, base: rule ? assignmentRuleFormFromRule(rule) : defaultAssignmentRule, edits: null };
}

function includeSaved(items: AssignmentRule[], saved: AssignmentRule, overlapping: boolean) {
  const reported = items.find(rule => rule.ruleId === saved.ruleId);
  // After settlement, only a demonstrably older row loses to the receipt.
  if (!overlapping && (!reported?.updatedAt || !saved.updatedAt || reported.updatedAt >= saved.updatedAt)) return items;
  if (!reported) return [saved, ...items];
  if (reported.updatedAt && saved.updatedAt && reported.updatedAt > saved.updatedAt) return items;
  return items.map(rule => rule === reported ? saved : rule);
}

export function useAssignmentAdmin({ request, allowDemo, gatewayOrigin, demoMode, setError, setStatus, refresh }: Dependencies) {
  const [rules, setRules] = useState<AssignmentRule[]>(allowDemo ? demo.assignmentRules : []);
  const [editor, setEditor] = useState(() => editorFor(rules[0]));
  const write = useRef<{ phase: "idle" | "put" | "refresh"; saved?: AssignmentRule }>({ phase: "idle" });
  const selectedId = editor.selectedId ?? "";
  const form = { ...editor.base, ...editor.edits };
  const selected = rules.find((rule) => rule.ruleId === selectedId);

  function hydrate(nextRules: AssignmentRule[], background: boolean) {
    // The overlapping inventory may predate the PUT. Refresh every other row.
    const { saved, phase } = write.current;
    const items = saved ? includeSaved(nextRules, saved, phase === "refresh") : nextRules;
    setRules(items);
    if (background) return;
    setEditor(current => current.edits || current.selectedId === "" ? current
      : editorFor(items.find(rule => rule.ruleId === current.selectedId) ?? items[0]));
  }

  function setForm(next: AssignmentRuleForm) {
    const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== form[key as keyof AssignmentRuleForm]));
    setEditor(current => ({ ...current, edits: { ...current.edits, ...changes } }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (write.current.phase !== "idle") return;
    write.current.phase = "put";
    try {
      setError("");
      const ruleId = form.ruleId.trim();
      if (!/^[a-z0-9_]{4,48}$/.test(ruleId)) throw new Error("rule id must use 4-48 lowercase letters, numbers, or underscores");
      if (!form.subject.trim()) throw new Error("rule subject is required");
      const body = { version: 1, enabled: form.enabled, kind: form.kind, subject: form.subject.trim(), groups: parseGroups(form.groups), policyIds: form.policyIds, priority: optionalNumber(form.priority) ?? 100, revokeOnLoss: form.revokeOnLoss, provenance: form.provenance.trim() };
      setStatus("saving assignment rule");
      // Only input after submission overlays the acknowledged values.
      setEditor({ ...editor, base: form, edits: {} });
      const saved = demoMode ? demoRuleFromForm(form)
        : await request<AssignmentRule>(gatewayOrigin, `/v1/admin/assignment-rules/${encodeURIComponent(ruleId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      write.current = { phase: "refresh", saved };
      setRules(current => includeSaved(current, saved, true));
      setEditor(current => {
        const sameNew = !current.selectedId && current.base === form && (current.edits?.ruleId ?? ruleId) === saved.ruleId;
        if (current.selectedId !== saved.ruleId && !sameNew) return current;
        const edits = current.edits && Object.keys(current.edits).length ? current.edits : null;
        return { ...editorFor(saved), edits };
      });
      if (!demoMode) await refresh();
      setStatus("saved assignment rule");
    } catch (caught) { handleError(caught); }
    finally { write.current.phase = "idle"; }
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

  function edit(rule: AssignmentRule) { setEditor(editorFor(rule)); }
  function startNew() { setEditor({ ...editorFor(), selectedId: "" }); }
  function handleError(caught: unknown) { const message = errorMessage(caught); setError(message); setStatus(message); }

  return { assignments: { items: rules, selected, selectedId, form, setForm, save, reconcile, edit, startNew }, hydrate };
}
