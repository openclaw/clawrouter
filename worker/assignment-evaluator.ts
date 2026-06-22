import type { AccessControlUser, AssignmentRule, AssignmentState, AssignmentStateEntry } from "./types";

export interface AssignmentEvidence {
  source: string;
  verified: boolean;
  githubOrgs: string[];
  githubTeams: string[];
}

export interface AssignmentRuleEntry extends AssignmentRule { ruleId: string; generatedGroup: string }

export function withLegacyAssignmentState(user: AccessControlUser, legacy: Partial<AssignmentState> | null): AccessControlUser {
  if (user.record.assignmentState || !legacy?.assignments || typeof legacy.assignments !== "object") return user;
  const assignments = Object.fromEntries(Object.entries(legacy.assignments).flatMap(([ruleId, entry]) => {
    if (!entry || !Array.isArray(entry.groups)) return [];
    return [[ruleId, { groups: normalizeGroups(entry.groups), revokeOnLoss: entry.revokeOnLoss === true } satisfies AssignmentStateEntry]];
  }));
  return {
    ...user,
    record: {
      ...user.record,
      assignmentState: { version: 1, revision: "", assignments, updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : null },
    },
  };
}

export function evaluateUserAssignments(user: AccessControlUser, rules: AssignmentRuleEntry[], evidence?: AssignmentEvidence, force = false) {
  const revision = assignmentRulesRevision(rules);
  const previous = user.record.assignmentState ?? { version: 1, revision: "", assignments: {}, updatedAt: null } satisfies AssignmentState;
  if (!force && previous.revision === revision) return { changed: false as const, user, matchedRuleIds: Object.keys(previous.assignments).sort(), retainedRuleIds: [] as string[] };
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
  const assignmentState: AssignmentState = { version: 1, revision, assignments, updatedAt: new Date().toISOString() };
  const updated: AccessControlUser = { ...user, record: { ...user.record, role: "user", groups, assignmentState } };
  return { changed: true as const, user: updated, matchedRuleIds, retainedRuleIds };
}

export function assignmentRulesRevision(rules: AssignmentRuleEntry[]): string {
  return JSON.stringify(rules.map((rule) => ({ ruleId: rule.ruleId, version: rule.version, enabled: rule.enabled, kind: rule.kind, subject: rule.subject, groups: rule.groups, policyIds: rule.policyIds, priority: rule.priority, revokeOnLoss: rule.revokeOnLoss, provenance: rule.provenance })));
}

export function normalizeAssignmentEvidence(value: AssignmentEvidence | undefined): AssignmentEvidence | undefined {
  if (!value) return undefined;
  if (value.source?.trim().toLowerCase() !== "github" || value.verified !== true) throw new Error("GitHub assignment evidence must be explicitly verified");
  return { source: "github", verified: true, githubOrgs: normalizeGroups(value.githubOrgs ?? []), githubTeams: normalizeGroups(value.githubTeams ?? []) };
}

export function assignmentGroup(ruleId: string) { return `assignment.${ruleId}`; }

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

function normalizeGroups(groups: string[]) { return [...new Set(groups.map((group) => group.trim().toLowerCase()).filter(Boolean))].sort(); }
