import type { AccessControlUser, AssignmentRule, AssignmentState, AssignmentStateEntry } from "./types";
import { admitAssignmentJson, admitAssignmentRevision, assignmentMapPlan, assignmentSequencePlan } from "./assignment-source.ts";

export interface AssignmentEvidence {
  source: string;
  verified: boolean;
  githubOrgs: string[];
  githubTeams: string[];
}

export interface AssignmentRuleEntry extends AssignmentRule { ruleId: string; generatedGroup: string }

const snapshotBrand = Symbol("assignment rules snapshot"), preparedBrand = Symbol("prepared assignment rules");
export interface AssignmentRuleSnapshot { readonly [snapshotBrand]: true }
export interface PreparedAssignmentRules { readonly [preparedBrand]: true }
type RuleSnapshot = { rules: AssignmentRuleEntry[]; legacyRevision: string; bounded: boolean };
const snapshots = new WeakMap<AssignmentRuleSnapshot, RuleSnapshot>();
const preparedRules = new WeakMap<PreparedAssignmentRules, RuleSnapshot & { revision: string }>();

/** Private owner interface: snapshot before waiting, hash only after its FIFO turn. */
export function captureAssignmentRules(rules: AssignmentRuleEntry[]): AssignmentRuleSnapshot {
  return captureRules(rules, false);
}

export function captureAdmittedAssignmentRules(rules: AssignmentRuleEntry[]): AssignmentRuleSnapshot {
  // Count the exact ordered legacy projection before map/nested array copies,
  // stringify, UTF8 encoding and digest. generatedGroup is deliberately absent.
  admitAssignmentJson(rules);
  admitAssignmentRevision(rules, revisionRule);
  return captureRules(rules, true);
}

function captureRules(rules: AssignmentRuleEntry[], bounded: boolean): AssignmentRuleSnapshot {
  const copied = rules.map(rule => {
    const copy = { ruleId: rule.ruleId, version: rule.version, enabled: rule.enabled, kind: rule.kind,
      subject: rule.subject, groups: [...rule.groups], policyIds: [...rule.policyIds], priority: rule.priority,
      revokeOnLoss: rule.revokeOnLoss, provenance: rule.provenance, generatedGroup: rule.generatedGroup };
    Object.freeze(copy.groups); Object.freeze(copy.policyIds); return Object.freeze(copy);
  });
  Object.freeze(copied);
  const capsule: AssignmentRuleSnapshot = Object.freeze({ [snapshotBrand]: true as const });
  snapshots.set(capsule, { rules: copied, legacyRevision: assignmentRulesRevision(copied), bounded });
  return capsule;
}

export async function prepareAssignmentRules(snapshot: AssignmentRuleSnapshot): Promise<PreparedAssignmentRules> {
  const state = snapshots.get(snapshot);
  if (!state) throw new TypeError("invalid assignment rules snapshot");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state.legacyRevision));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const capsule: PreparedAssignmentRules = Object.freeze({ [preparedBrand]: true as const });
  preparedRules.set(capsule, { ...state, revision: `assignment-rules.v1:sha256:${hex}` });
  return capsule;
}

export function evaluatePreparedUserAssignments(user: AccessControlUser, prepared: PreparedAssignmentRules, evidence?: AssignmentEvidence, force = false) {
  const state = preparedRules.get(prepared);
  if (!state) throw new TypeError("invalid prepared assignment rules");
  if (state.bounded) planAssignmentEvaluation(user, state.rules, state.legacyRevision, state.revision, evidence, force);
  return evaluateAssignments(user, state.rules, state.legacyRevision, state.revision, evidence, force, state.bounded);
}

export function withAdmittedLegacyAssignmentState(user: AccessControlUser, legacy: Partial<AssignmentState> | null): AccessControlUser {
  admitAssignmentJson(user); admitAssignmentJson(legacy);
  if (!user.record.assignmentState && legacy?.assignments && typeof legacy.assignments === "object") {
    const ids = assignmentSequencePlan(), groups = assignmentSequencePlan();
    for (const id in legacy.assignments) if (Object.hasOwn(legacy.assignments, id)) {
      const entry = legacy.assignments[id];
      if (!entry || !Array.isArray(entry.groups)) continue;
      ids.add(id);
      for (const group of entry.groups) groups.normalized(group);
    }
  }
  const candidate = withLegacyAssignmentState(user, legacy);
  admitAssignmentJson(candidate);
  return candidate;
}

function planAssignmentEvaluation(user: AccessControlUser, rules: AssignmentRuleEntry[], legacyRevision: string, revision: string, evidence?: AssignmentEvidence, force = false): void {
  admitAssignmentJson(user); admitAssignmentJson(evidence);
  const previous = user.record.assignmentState?.assignments ?? {};
  const ids = assignmentSequencePlan();
  const same = user.record.assignmentState?.revision === legacyRevision || user.record.assignmentState?.revision === revision;
  if (!force && same) {
    for (const id in previous) if (Object.hasOwn(previous, id)) ids.add(id);
    return;
  }
  const oldGroups = assignmentSequencePlan(), nextGroups = assignmentSequencePlan(), combined = assignmentSequencePlan(), nextAssignments = assignmentMapPlan();
  const normalizedCurrent = assignmentSequencePlan();
  for (const id in previous) if (Object.hasOwn(previous, id)) for (const group of previous[id].groups) oldGroups.add(group);
  for (const group of user.record.groups ?? []) {
    normalizedCurrent.normalized(group);
    // No Object.values/flatMap/Set is built until the whole prospective sequence
    // has been admitted. Match the existing manual-group membership test.
    let assigned = false;
    for (const id in previous) if (Object.hasOwn(previous, id) && previous[id].groups.includes(group)) { assigned = true; break; }
    if (!assigned && !group.startsWith("assignment.")) combined.normalized(group);
  }
  for (const rule of rules) {
    const outcome = assignmentMatch(rule, user.email, evidence);
    if (outcome === "match") {
      ids.add(rule.ruleId);
      // Original source groups already have bounded backing. This prospective
      // entry counts multiplicity before the evaluator creates its map/arrays;
      // separate plans also charge normalization expansion and generated groups.
      nextAssignments.matched(rule.ruleId, rule.groups, rule.policyIds.length ? rule.generatedGroup : undefined, rule.revokeOnLoss);
      for (const group of rule.groups) { nextGroups.normalized(group); combined.normalized(group); }
      if (rule.policyIds.length) { nextGroups.normalized(rule.generatedGroup); combined.normalized(rule.generatedGroup); }
    } else if ((outcome === "unknown" || outcome === "no_match" && rule.enabled && !rule.revokeOnLoss) && previous[rule.ruleId]) {
      ids.add(rule.ruleId);
      nextAssignments.retained(rule.ruleId, previous[rule.ruleId]);
      for (const group of previous[rule.ruleId].groups) { nextGroups.add(group); combined.normalized(group); }
    }
  }
}

export function assignmentEvidenceFromAccessIdentity(value: unknown, expectedEmail: string): AssignmentEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const identity = value as Record<string, unknown>;
  const email = typeof identity.email === "string" ? identity.email.trim().toLowerCase() : "";
  const idp = identity.idp && typeof identity.idp === "object" ? identity.idp as Record<string, unknown> : null;
  if (!email || email !== expectedEmail.trim().toLowerCase() || idp?.type !== "github") return undefined;
  if (!Array.isArray(identity.orgs) || !Array.isArray(identity.teams)) return undefined;

  const organizations = records(identity.orgs);
  const teams = records(identity.teams);
  if (organizations.length !== identity.orgs.length || teams.length !== identity.teams.length) return undefined;
  const namesById = new Map(organizations.flatMap((organization) => {
    const id = scalarString(organization.id), name = scalarString(organization.name).toLowerCase();
    return id && name ? [[id, name] as const] : [];
  }));
  if (namesById.size !== organizations.length) return undefined;
  const githubOrgs = normalizeGroups(organizations.map((organization) => scalarString(organization.name)));
  const githubTeams = normalizeGroups(teams.flatMap((team) => {
    const organization = namesById.get(scalarString(team.org_id));
    const name = scalarString(team.name).toLowerCase();
    return organization && name ? [`${organization}/${name}`] : [];
  }));
  if (githubTeams.length !== teams.length) return undefined;
  return { source: "github", verified: true, githubOrgs, githubTeams };
}

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
  return evaluateAssignments(user, rules, revision, revision, evidence, force);
}

function evaluateAssignments(user: AccessControlUser, rules: AssignmentRuleEntry[], legacyRevision: string, revision: string, evidence?: AssignmentEvidence, force = false, bounded = false) {
  const previous = user.record.assignmentState ?? { version: 1, revision: "", assignments: {}, updatedAt: null } satisfies AssignmentState;
  const sameRevision = previous.revision === legacyRevision || previous.revision === revision;
  if (!force && sameRevision) return { changed: false as const, user, matchedRuleIds: Object.keys(previous.assignments).sort(), retainedRuleIds: [] as string[] };
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
  if (bounded) admitAssignmentJson(assignments);
  const previousGroups = new Set(Object.values(previous.assignments).flatMap((entry) => entry.groups));
  const manual = (user.record.groups ?? []).filter((group) => !previousGroups.has(group) && !group.startsWith("assignment."));
  const groups = normalizeGroups([...manual, ...Object.values(assignments).flatMap((entry) => entry.groups)]);
  if (sameRevision && JSON.stringify(previous.assignments) === JSON.stringify(assignments) && JSON.stringify(normalizeGroups(user.record.groups ?? [])) === JSON.stringify(groups)) {
    return { changed: false as const, user, matchedRuleIds, retainedRuleIds };
  }
  const assignmentState: AssignmentState = { version: 1, revision, assignments, updatedAt: new Date().toISOString() };
  const updated: AccessControlUser = { ...user, record: { ...user.record, role: user.record.role ?? "user", groups, assignmentState } };
  return { changed: true as const, user: updated, matchedRuleIds, retainedRuleIds };
}

export function assignmentRulesRevision(rules: AssignmentRuleEntry[]): string {
  return JSON.stringify(rules.map(revisionRule));
}
function revisionRule(rule: AssignmentRuleEntry) {
  return { ruleId: rule.ruleId, version: rule.version, enabled: rule.enabled, kind: rule.kind, subject: rule.subject, groups: rule.groups, policyIds: rule.policyIds, priority: rule.priority, revokeOnLoss: rule.revokeOnLoss, provenance: rule.provenance };
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

export function normalizeGroups(groups: string[]) { return [...new Set(groups.map((group) => group.trim().toLowerCase()).filter(Boolean))].sort(); }
function records(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : []; }
function scalarString(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value).trim() : ""; }
