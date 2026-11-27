import { authorityCall } from "./authority.ts";
import {
  type AssignmentEvidence,
  type AssignmentRuleEntry,
} from "./assignment-evaluator.ts";
import type { AccessControlUser, AssignmentRule, AssignmentState, Env } from "./types";
import { admitAssignmentCursor, admitAssignmentJson, admitAssignmentPage, assignmentActual, assignmentListingPlan, assignmentSourceBudget, assignmentSourceFailure, readAssignmentKv } from "./assignment-source.ts";

export { assignmentRulesRevision, normalizeAssignmentEvidence, normalizeGroups } from "./assignment-evaluator.ts";
export type { AssignmentEvidence, AssignmentRuleEntry } from "./assignment-evaluator.ts";

export async function listAssignmentRules(env: Env): Promise<AssignmentRuleEntry[]> {
  const entries: AssignmentRuleEntry[] = [];
  const budget = assignmentSourceBudget();
  const admitEntry = assignmentListingPlan();
  let pages = 0, occurrences = 0;
  let cursor: string | undefined;
  do {
    if (++pages > 128) throw assignmentSourceFailure("limit");
    const page = await assignmentActual(() => env.POLICY_KV.list({ prefix: "access/assignment-rules/", cursor, limit: 64 }));
    admitAssignmentPage(page, budget);
    if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== "boolean") throw assignmentSourceFailure("protocol");
    if (page.keys.length > 64 || page.keys.length > 4096 - occurrences) throw assignmentSourceFailure("limit");
    occurrences += page.keys.length;
    for (const key of page.keys) {
      // Null/discarded rows still consume occurrence/metadata admission.
      if (key === null) continue;
      if (!key || typeof key.name !== "string" || !key.name.startsWith("access/assignment-rules/")) throw assignmentSourceFailure("protocol");
      const rule = await readAssignmentKv(() => env.POLICY_KV.get(key.name, "stream"), budget) as AssignmentRule | null;
      if (!rule) continue;
      const { ruleId, generatedGroup } = admitEntry(rule, key.name);
      entries.push({ ruleId, ...rule, generatedGroup });
    }
    if (page.list_complete) break;
    admitAssignmentCursor(page.cursor); cursor = page.cursor;
  } while (true);
  admitAssignmentJson(entries);
  return entries.sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
}

export async function reconcileUserAssignments(user: AccessControlUser, rules: AssignmentRuleEntry[], env: Env, evidence?: AssignmentEvidence, force = false): Promise<{ user: AccessControlUser; matchedRuleIds: string[]; retainedRuleIds: string[] }> {
  admitAssignmentJson({ email: user.email, rules, evidence, force });
  const legacy = user.record.assignmentState
    ? null
    : await readAssignmentKv(() => env.POLICY_KV.get(`access/assignment-state/${user.email.trim().toLowerCase()}`, "stream"), assignmentSourceBudget()) as Partial<AssignmentState> | null;
  return authorityCall(env, "/users/reconcile-assignments", { email: user.email, rules, legacy, evidence, force });
}
