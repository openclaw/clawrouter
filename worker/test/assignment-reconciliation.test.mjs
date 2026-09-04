import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PolicyBindingIndexObject } from "../authority.ts";
import { evaluateUserAssignments } from "../assignment-evaluator.ts";
import { reconcileUserAssignments } from "../assignments.ts";

const rule = { ruleId: "members", generatedGroup: "assignment.members", version: 1, enabled: true,
  kind: "email_domain", subject: "example.com", groups: ["members"], policyIds: ["policy"],
  priority: 10, revokeOnLoss: true, provenance: "cloudflare_access" };
const user = { email: "member@example.com", record: { enabled: true, role: "user", tenantId: "original", groups: ["old-manual"], contentRetentionDisabled: false } };

test("assignment reconciliation preserves administrative changes made during legacy reads", async t => {
  const fixture = authorityEnv(t);
  await fixture.put(user);
  const updated = { ...user, record: { ...user.record, enabled: false, tenantId: "updated", groups: ["new-manual"], contentRetentionDisabled: true } };
  fixture.beforeLegacyRead = () => fixture.put(updated);
  const result = await reconcileUserAssignments(user, [rule], fixture.env);
  assert.equal(result.user.record.enabled, false);
  assert.equal(result.user.record.tenantId, "updated");
  assert.equal(result.user.record.contentRetentionDisabled, true);
  assert.deepEqual(result.user.record.groups, ["assignment.members", "members", "new-manual"]);
  assert.deepEqual(await fixture.current(), result.user);
});

test("unchanged assignments return the current user without rewriting it", async t => {
  const fixture = authorityEnv(t);
  const assigned = evaluateUserAssignments(user, [rule]).user;
  const updated = { ...assigned, record: { ...assigned.record, enabled: false, tenantId: "updated" } };
  await fixture.put(updated);
  const writes = fixture.writes;
  const result = await reconcileUserAssignments(assigned, [rule], fixture.env);
  assert.deepEqual(result.user, updated);
  assert.equal(fixture.writes, writes);
});

test("membership-loss reconciliation preserves current manual groups and disabled state", async t => {
  const fixture = authorityEnv(t);
  const githubRule = { ...rule, kind: "github_org", subject: "example" };
  const evidence = { source: "github", verified: true, githubOrgs: ["example"], githubTeams: [] };
  const assigned = evaluateUserAssignments(user, [githubRule], evidence, true).user;
  const updated = { ...assigned, record: { ...assigned.record, enabled: false, groups: ["assignment.members", "members", "new-manual"] } };
  await fixture.put(updated);
  const result = await reconcileUserAssignments(assigned, [githubRule], fixture.env, { ...evidence, githubOrgs: [] }, true);
  assert.equal(result.user.record.enabled, false);
  assert.deepEqual(result.user.record.groups, ["new-manual"]);
  assert.deepEqual(result.user.record.assignmentState.assignments, {});
  assert.deepEqual(await fixture.current(), result.user);
});

test("reconciliation cannot recreate a missing canonical user from a stale snapshot", async t => {
  const fixture = authorityEnv(t);
  await assert.rejects(reconcileUserAssignments(user, [rule], fixture.env));
  assert.equal(await fixture.current(), undefined);
});

test("automatic creation preserves existing users after migration closes", async t => {
  const fixture = authorityEnv(t);
  await fixture.call("/users/initialize-all", []);
  const disabled = { ...user, record: { ...user.record, enabled: false, tenantId: "managed" } };
  const responses = await Promise.all([fixture.call("/users/create", disabled), fixture.call("/users/create", user)]);
  for (const response of responses) assert.deepEqual(await response.json(), disabled);
  assert.equal(fixture.writes, 1);
  assert.deepEqual(await fixture.current(), disabled);
});

function authorityEnv(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query, ...bindings) {
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...bindings);
    if (query.startsWith("INSERT OR REPLACE INTO access_users")) fixture.writes++;
    statement.run(...bindings);
    return [];
  } };
  const fixture = { writes: 0, beforeLegacyRead: null };
  const authority = new PolicyBindingIndexObject({ storage: { sql } });
  const call = (path, body) => authority.fetch(new Request(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) }));
  fixture.call = call;
  fixture.put = async value => { assert.equal((await call("/users/put", value)).status, 200); };
  fixture.current = async () => (await (await call("/users/resolve", { emails: [user.email] })).json()).users[0];
  fixture.env = {
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: (url, init) => authority.fetch(new Request(url, init)) }) },
    POLICY_KV: { async get() { await fixture.beforeLegacyRead?.(); return null; } },
  };
  return fixture;
}
