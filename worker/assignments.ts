import { authorityCall } from "./authority";
import {
  assignmentGroup,
  evaluateUserAssignments,
  normalizeAssignmentEvidence,
  withLegacyAssignmentState,
  type AssignmentEvidence,
  type AssignmentRuleEntry,
} from "./assignment-evaluator";
import type { AccessControlUser, AssignmentRule, AssignmentState, Env } from "./types";

export { assignmentRulesRevision, normalizeAssignmentEvidence } from "./assignment-evaluator";
export type { AssignmentEvidence, AssignmentRuleEntry } from "./assignment-evaluator";

export async function listAssignmentRules(env: Env): Promise<AssignmentRuleEntry[]> {
  const entries: AssignmentRuleEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.POLICY_KV.list({ prefix: "access/assignment-rules/", cursor });
    for (const key of page.keys) {
      const rule = await env.POLICY_KV.get<AssignmentRule>(key.name, "json");
      if (!rule) continue;
      const ruleId = key.name.slice("access/assignment-rules/".length);
      entries.push({ ruleId, ...rule, generatedGroup: assignmentGroup(ruleId) });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries.sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
}

export async function reconcileUserAssignments(user: AccessControlUser, rules: AssignmentRuleEntry[], env: Env, evidence?: AssignmentEvidence, force = false): Promise<{ user: AccessControlUser; matchedRuleIds: string[]; retainedRuleIds: string[] }> {
  const legacy = user.record.assignmentState
    ? null
    : await env.POLICY_KV.get<Partial<AssignmentState>>(`access/assignment-state/${user.email.trim().toLowerCase()}`, "json");
  const candidate = withLegacyAssignmentState(user, legacy);
  const evaluated = evaluateUserAssignments(candidate, rules, evidence, force);
  if (!evaluated.changed) return { user, matchedRuleIds: evaluated.matchedRuleIds, retainedRuleIds: evaluated.retainedRuleIds };
  await authorityCall(env, "/users/put", evaluated.user);
  return { user: evaluated.user, matchedRuleIds: evaluated.matchedRuleIds, retainedRuleIds: evaluated.retainedRuleIds };
}
