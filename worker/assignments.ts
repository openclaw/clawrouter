import { authorityCall } from "./authority";
import type { AccessControlUser, AssignmentRule, Env } from "./types";
import { normalizeEmail, nowIso } from "./utils";

export interface AssignmentEvidence {
  source: string;
  verified: boolean;
  githubOrgs: string[];
  githubTeams: string[];
}

export interface AssignmentRuleEntry extends AssignmentRule { ruleId: string; generatedGroup: string }

interface AssignmentStateEntry { groups: string[]; revokeOnLoss: boolean }
interface AssignmentState { version: number; assignments: Record<string, AssignmentStateEntry>; updatedAt: string | null }

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

export async function reconcileUserAssignments(user: AccessControlUser, rules: AssignmentRuleEntry[], env: Env, evidence?: AssignmentEvidence): Promise<{ user: AccessControlUser; matchedRuleIds: string[]; retainedRuleIds: string[] }> {
  const previous = await assignmentState(env, user.email);
  const assignments: Record<string, AssignmentStateEntry> = {};
  const matchedRuleIds: string[] = [], retainedRuleIds: string[] = [];
  for (const rule of rules) {
    const outcome = assignmentMatch(rule, user.email, evidence);
    if (outcome === "match") {
      assignments[rule.ruleId] = assignmentEntry(rule);
      matchedRuleIds.push(rule.ruleId);
    } else if (outcome === "unknown" || (outcome === "no_match" && rule.enabled && !rule.revokeOnLoss)) {
      if (previous.assignments[rule.ruleId]) {
        assignments[rule.ruleId] = previous.assignments[rule.ruleId];
        retainedRuleIds.push(rule.ruleId);
      }
    }
  }
  const previousGroups = new Set(Object.values(previous.assignments).flatMap((entry) => entry.groups));
  const manual = (user.record.groups ?? []).filter((group) => !previousGroups.has(group) && !group.startsWith("assignment."));
  const groups = normalizeGroups([...manual, ...Object.values(assignments).flatMap((entry) => entry.groups)]);
  const updated: AccessControlUser = { ...user, record: { ...user.record, role: "user", groups } };
  await authorityCall(env, "/users/put", updated);
  await Promise.all([
    env.POLICY_KV.put(`access/users/${user.email}`, JSON.stringify(updated.record)),
    env.POLICY_KV.put(assignmentStateKey(user.email), JSON.stringify({ version: 1, assignments, updatedAt: nowIso() } satisfies AssignmentState)),
  ]);
  return { user: updated, matchedRuleIds, retainedRuleIds };
}

export function normalizeAssignmentEvidence(value: AssignmentEvidence | undefined): AssignmentEvidence | undefined {
  if (!value) return undefined;
  if (value.source?.trim().toLowerCase() !== "github" || value.verified !== true) throw new Error("GitHub assignment evidence must be explicitly verified");
  return { source: "github", verified: true, githubOrgs: normalizeGroups(value.githubOrgs ?? []), githubTeams: normalizeGroups(value.githubTeams ?? []) };
}

function assignmentMatch(rule: AssignmentRuleEntry, email: string, evidence?: AssignmentEvidence): "match" | "no_match" | "unknown" {
  if (!rule.enabled) return "no_match";
  if (rule.kind === "exact_email") return email === rule.subject ? "match" : "no_match";
  if (rule.kind === "email_domain") return email.split("@")[1] === rule.subject ? "match" : "no_match";
  if (!evidence) return "unknown";
  const values = rule.kind === "github_org" ? evidence.githubOrgs : evidence.githubTeams;
  return values.includes(rule.subject) ? "match" : "no_match";
}

function assignmentEntry(rule: AssignmentRuleEntry): AssignmentStateEntry {
  return { groups: normalizeGroups([...rule.groups, ...(rule.policyIds.length ? [rule.generatedGroup] : [])]), revokeOnLoss: rule.revokeOnLoss };
}

async function assignmentState(env: Env, email: string): Promise<AssignmentState> {
  return await env.POLICY_KV.get<AssignmentState>(assignmentStateKey(email), "json") ?? { version: 1, assignments: {}, updatedAt: null };
}

function assignmentStateKey(email: string) { return `access/assignment-state/${normalizeEmail(email)}`; }
function assignmentGroup(ruleId: string) { return `assignment.${ruleId}`; }
function normalizeGroups(groups: string[]) { return [...new Set(groups.map((group) => group.trim().toLowerCase()).filter(Boolean))].sort(); }
