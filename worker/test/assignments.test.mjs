import assert from "node:assert/strict";
import test from "node:test";
import { assignmentEvidenceFromAccessIdentity, assignmentRulesRevision, evaluateUserAssignments, withLegacyAssignmentState, captureAssignmentRules, prepareAssignmentRules, evaluatePreparedUserAssignments } from "../assignment-evaluator.ts";

const rule = {
  ruleId: "members",
  generatedGroup: "assignment.members",
  version: 1,
  enabled: true,
  kind: "email_domain",
  subject: "example.com",
  groups: ["members"],
  policyIds: ["policy"],
  priority: 10,
  revokeOnLoss: true,
  provenance: "cloudflare_access",
};

test("unchanged assignment revision performs no authority write", async () => {
  const revision = assignmentRulesRevision([rule]);
  const user = { email: "member@example.com", record: { groups: ["assignment.members", "members"], assignmentState: { version: 1, revision, assignments: { members: { groups: ["assignment.members", "members"], revokeOnLoss: true } }, updatedAt: "2026-06-22T00:00:00.000Z" } } };
  const result = evaluateUserAssignments(user, [rule]);
  assert.equal(result.user, user);
  assert.equal(result.changed, false);
});

test("changed assignment rules update the canonical user once", async () => {
  const user = { email: "member@example.com", record: { groups: ["manual"] } };
  const result = evaluateUserAssignments(user, [rule]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.user.record.groups, ["assignment.members", "manual", "members"]);
  assert.equal(result.user.record.assignmentState.revision, assignmentRulesRevision([rule]));
});

test("legacy GitHub assignment state survives first reconciliation without evidence", () => {
  const githubRule = { ...rule, ruleId: "org", generatedGroup: "assignment.org", kind: "github_org", subject: "openclaw", groups: ["maintainers"] };
  const user = { email: "member@example.com", record: { groups: ["assignment.org", "maintainers", "manual"] } };
  const migrated = withLegacyAssignmentState(user, { version: 1, assignments: { org: { groups: ["assignment.org", "maintainers"], revokeOnLoss: true } }, updatedAt: "2026-06-01T00:00:00.000Z" });
  const result = evaluateUserAssignments(migrated, [githubRule]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.retainedRuleIds, ["org"]);
  assert.deepEqual(result.user.record.groups, ["assignment.org", "maintainers", "manual"]);
  assert.equal(result.user.record.assignmentState.revision, assignmentRulesRevision([githubRule]));
});

test("forced GitHub reconciliation skips an unchanged authority write", () => {
  const githubRule = { ...rule, ruleId: "org", generatedGroup: "assignment.org", kind: "github_org", subject: "openclaw", groups: [] };
  const revision = assignmentRulesRevision([githubRule]);
  const user = { email: "member@example.com", record: { groups: ["assignment.org"], assignmentState: { version: 1, revision, assignments: { org: { groups: ["assignment.org"], revokeOnLoss: true } }, updatedAt: "2026-06-22T00:00:00.000Z" } } };
  const evidence = { source: "github", verified: true, githubOrgs: ["openclaw"], githubTeams: [] };
  const result = evaluateUserAssignments(user, [githubRule], evidence, true);
  assert.equal(result.changed, false);
  assert.equal(result.user, user);
});

test("verified GitHub membership loss revokes an existing managed assignment", () => {
  const githubRule = { ...rule, ruleId: "org", generatedGroup: "assignment.org", kind: "github_org", subject: "openclaw", groups: ["maintainers"] };
  const revision = assignmentRulesRevision([githubRule]);
  const user = { email: "member@example.com", record: { groups: ["assignment.org", "maintainers", "manual"], assignmentState: { version: 1, revision, assignments: { org: { groups: ["assignment.org", "maintainers"], revokeOnLoss: true } }, updatedAt: "2026-06-22T00:00:00.000Z" } } };
  const evidence = { source: "github", verified: true, githubOrgs: [], githubTeams: [] };
  const result = evaluateUserAssignments(user, [githubRule], evidence, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.user.record.groups, ["manual"]);
  assert.deepEqual(result.user.record.assignmentState.assignments, {});
});

test("Cloudflare GitHub identity becomes normalized assignment evidence", () => {
  const evidence = assignmentEvidenceFromAccessIdentity({
    email: "Member@Example.com",
    idp: { type: "github" },
    orgs: [{ id: 7, name: "OpenClaw" }, { id: "8", name: "Example" }],
    teams: [{ org_id: "7", name: "Maintainers" }, { org_id: 8, name: "Docs" }],
  }, "member@example.com");
  assert.deepEqual(evidence, { source: "github", verified: true, githubOrgs: ["example", "openclaw"], githubTeams: ["example/docs", "openclaw/maintainers"] });
  assert.deepEqual(assignmentEvidenceFromAccessIdentity({ email: "member@example.com", idp: { type: "github" }, orgs: [], teams: [] }, "member@example.com"), { source: "github", verified: true, githubOrgs: [], githubTeams: [] });
  assert.equal(assignmentEvidenceFromAccessIdentity({ email: "member@example.com", idp: { type: "github" }, orgs: [] }, "member@example.com"), undefined);
  assert.equal(assignmentEvidenceFromAccessIdentity({ email: "member@example.com", idp: { type: "github" }, orgs: [{ id: 7, name: "OpenClaw" }], teams: [{ org_id: 8, name: "Maintainers" }] }, "member@example.com"), undefined);
  assert.equal(assignmentEvidenceFromAccessIdentity({ email: "member@example.com", idp: { type: "google" }, orgs: [{ id: 7, name: "OpenClaw" }], teams: [] }, "member@example.com"), undefined);
  assert.equal(assignmentEvidenceFromAccessIdentity({ email: "other@example.com", idp: { type: "github" }, orgs: [{ id: 7, name: "OpenClaw" }], teams: [] }, "member@example.com"), undefined);
});

const prepared = rules => prepareAssignmentRules(captureAssignmentRules(rules));

test("compact writer hashes the exact ordered legacy serialization, excluding generatedGroup", async () => {
  const rules = Array.from({ length: 1000 }, (_, i) => ({ ...rule, ruleId: `nonmatching-${i}`, subject: `absent-${i}.example`, groups: [`group-${i}`], policyIds: [] }));
  const legacy = assignmentRulesRevision(rules);
  assert.ok(Buffer.byteLength(legacy) > 64 * 1024, 'measured legacy text, not a response-cap claim');
  const user = { email: 'member@example.com', record: { groups: ['manual'] } };
  const next = evaluatePreparedUserAssignments(user, await prepared(rules));
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacy))).toString('hex');
  assert.equal(next.changed, true);
  assert.equal(next.user.record.assignmentState.revision, `assignment-rules.v1:sha256:${hash}`);
  assert.deepEqual(next.user.record.groups, ['manual']);
  const reversed = evaluatePreparedUserAssignments(user, await prepared([...rules].reverse()));
  assert.notEqual(reversed.user.record.assignmentState.revision, next.user.record.assignmentState.revision);
  const changedGroup = rules.map(r => ({ ...r, generatedGroup: 'assignment.other' }));
  assert.equal(evaluatePreparedUserAssignments(user, await prepared(changedGroup)).user.record.assignmentState.revision, next.user.record.assignmentState.revision);
});

test("legacy and compact no-ops preserve original bytes and timestamp even when forced", async () => {
  const original = { email: 'member@example.com', record: { groups: ['manual'] } };
  const legacy = evaluateUserAssignments(original, [rule]).user;
  assert.equal(typeof legacy.then, 'undefined', 'the original evaluator remains synchronous');
  const compact = evaluatePreparedUserAssignments(original, await prepared([rule])).user;
  for (const user of [legacy, compact]) for (const force of [false, true]) {
    const before = JSON.stringify(user), result = evaluatePreparedUserAssignments(user, await prepared([rule]), undefined, force);
    assert.equal(result.changed, false); assert.equal(result.user, user); assert.equal(JSON.stringify(result.user), before);
  }
});

test("generatedGroup-only ordinary no-op and forced reassignment preserve legacy parity", async () => {
  const original = { email: 'member@example.com', record: { groups: ['manual'] } };
  const changed = { ...rule, generatedGroup: 'assignment.replaced' };
  const legacy = evaluateUserAssignments(original, [rule]).user;
  const capsule = await prepared([changed]);
  const ordinary = evaluatePreparedUserAssignments(legacy, capsule);
  assert.equal(ordinary.changed, false); assert.equal(ordinary.user, legacy);
  const forced = evaluatePreparedUserAssignments(legacy, capsule, undefined, true);
  const oldForced = evaluateUserAssignments(legacy, [changed], undefined, true);
  assert.equal(forced.changed, oldForced.changed); assert.equal(forced.changed, true);
  assert.deepEqual(forced.user.record.groups, oldForced.user.record.groups);
  assert.deepEqual(forced.user.record.assignmentState.assignments, oldForced.user.record.assignmentState.assignments);
  assert.match(forced.user.record.assignmentState.revision, /^assignment-rules\.v1:sha256:[a-f0-9]{64}$/);
});

test("private capsules bind hashing and evaluation to immutable captured rules", async () => {
  const mutable = structuredClone(rule), legacy = assignmentRulesRevision([mutable]);
  const snapshot = captureAssignmentRules([mutable]);
  mutable.groups.push('mutated'); mutable.policyIds.length = 0; mutable.generatedGroup = 'assignment.mutated'; mutable.enabled = false;
  const capsule = await prepareAssignmentRules(snapshot);
  const result = evaluatePreparedUserAssignments({ email: 'member@example.com', record: { groups: [] } }, capsule);
  assert.deepEqual(result.user.record.groups, ['assignment.members', 'members']);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacy))).toString('hex');
  assert.equal(result.user.record.assignmentState.revision, `assignment-rules.v1:sha256:${hash}`);
  await assert.rejects(prepareAssignmentRules({ ...snapshot }), /invalid assignment rules snapshot/);
  assert.throws(() => evaluatePreparedUserAssignments(result.user, { ...capsule }), /invalid prepared assignment rules/);
  assert.throws(() => evaluatePreparedUserAssignments(result.user, { revision: result.user.record.assignmentState.revision }), /invalid prepared assignment rules/);
});

test("prepared UNKNOWN, empty, nonrevoking, disabled and deleted rule outcomes match synchronous evaluation", async () => {
  const org = { ...rule, kind: 'github_org', subject: 'example' };
  const present = { source: 'github', verified: true, githubOrgs: ['example'], githubTeams: [] };
  const empty = { ...present, githubOrgs: [] };
  for (const [rules, evidence] of [[[org], undefined], [[org], empty], [[{ ...org, revokeOnLoss: false }], empty], [[{ ...org, enabled: false }], undefined], [[], undefined]]) {
    const initial = evaluateUserAssignments({ email: 'member@example.com', record: { enabled: false, groups: ['manual'] } }, [org], present, true).user;
    const old = evaluateUserAssignments(initial, rules, evidence, true), next = evaluatePreparedUserAssignments(initial, await prepared(rules), evidence, true);
    assert.equal(next.changed, old.changed); assert.deepEqual(next.user.record.groups, old.user.record.groups);
    assert.deepEqual(next.user.record.assignmentState.assignments, old.user.record.assignmentState.assignments);
    assert.deepEqual(next.retainedRuleIds, old.retainedRuleIds); assert.equal(next.user.record.enabled, false);
  }
});
