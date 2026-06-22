import assert from "node:assert/strict";
import test from "node:test";
import { assignmentRulesRevision, evaluateUserAssignments, withLegacyAssignmentState } from "../assignment-evaluator.ts";

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
