import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PolicyBindingIndexObject } from "../authority.ts";
import { evaluateUserAssignments, assignmentRulesRevision } from "../assignment-evaluator.ts";
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

function reconciliationOwner(t) {
  const releases = [], roots = [];
  let hasPrimary = false, primary;
  const releaseAll = () => { for (const release of releases) release(); };
  t.signal.addEventListener('abort', releaseAll, { once: true });
  // This hook precedes authorityEnv's SQLite close hook.
  t.after(async () => {
    releaseAll(); await Promise.all(roots.map(root => root.observed)); t.signal.removeEventListener('abort', releaseAll);
    const failures = []; let primaryAccounted = false;
    for (const root of roots) if (root.rejected && !(root.hasExpected && root.expected(root.reason))) {
      if (hasPrimary && !primaryAccounted && root.reason === primary) { primaryAccounted = true; continue; }
      failures.push(root.reason);
    }
    if (failures.length) throw new AggregateError(failures, 'independent reconciliation cleanup failures');
  });
  return {
    async run(work) { try { return await work(); } catch (error) { hasPrimary = true; primary = error; throw error; } },
    hold() { const gate = Promise.withResolvers(); releases.push(gate.resolve); return gate; },
    start(start, expected) {
      const actual = start(), root = { rejected: false, reason: undefined, hasExpected: expected !== undefined, expected };
      root.observed = actual.then(() => {}, reason => { root.rejected = true; root.reason = reason; }); roots.push(root); return actual;
    },
  };
}
async function arrival(arrived, actual) {
  let timer;
  const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('reconciliation arrival missing')), 2000); });
  try { await Promise.race([arrived, actual.then(() => { throw Error('reconciliation completed before arrival'); }), bound]); }
  finally { clearTimeout(timer); }
}
const revisionText = data => new TextDecoder().decode(data);
const requestFor = rules => ({ email: user.email, rules, legacy: null, force: false });

test('FIFO captures rules before waits and reads the current canonical profile only after hashing', async t => {
  const owned = reconciliationOwner(t); return owned.run(async () => {
  const fixture = authorityEnv(t); await fixture.put(user);
  const release = owned.hold(), entered = Promise.withResolvers(), digest = crypto.subtle.digest.bind(crypto.subtle), text = assignmentRulesRevision([rule]);
  t.mock.method(crypto.subtle, 'digest', async (...args) => {
    const result = await digest(...args);
    if (revisionText(args[1]) === text) { entered.resolve(); await release.promise; } // Native digest ALREADY settled.
    return result;
  });
  const a = owned.start(() => fixture.direct(requestFor([rule]))); await arrival(entered.promise, a);
  const mutable = { ...rule, enabled: false, groups: [...rule.groups], policyIds: [...rule.policyIds] };
  const b = owned.start(() => fixture.direct(requestFor([mutable]))); let bDone = false; b.then(() => { bDone = true; }, () => { bDone = true; });
  mutable.enabled = true; mutable.groups.push('late'); mutable.generatedGroup = 'assignment.late';
  const profile = { ...user, record: { ...user.record, enabled: false, role: 'admin', tenantId: 'updated', groups: ['new-manual'], contentRetentionDisabled: true,
    budgetOverrides: { policy: { monthlyBudgetMicros: 17, updatedBy: 'admin@example.com', updatedAt: '2026-01-01T00:00:00.000Z' } } } };
  await fixture.put(profile); const writes = fixture.writes;
  assert.equal(bDone, false); assert.equal(fixture.writes, writes); assert.equal((await fixture.current()).record.assignmentState, undefined);
  release.resolve(); const first = await a, last = await b;
  assert.deepEqual(first.user.record.groups, ['assignment.members', 'members', 'new-manual']);
  assert.deepEqual(last.user.record.groups, ['new-manual']);
  for (const key of ['enabled', 'role', 'tenantId', 'contentRetentionDisabled', 'budgetOverrides']) assert.deepEqual(last.user.record[key], profile.record[key]);
  assert.equal(fixture.writes, writes + 2); assert.deepEqual(await fixture.current(), last.user);
  });
});

for (const failure of ['snapshot-undefined', 'hash-undefined', 'hash-error']) test(`FIFO failure ${failure} joins its predecessor and cannot poison or be overtaken`, async t => {
  const owned = reconciliationOwner(t); return owned.run(async () => {
  const fixture = authorityEnv(t); await fixture.put(user);
  const releaseA = owned.hold(), releaseB = owned.hold(), enteredA = Promise.withResolvers(), enteredB = Promise.withResolvers();
  const bRule = { ...rule, version: 2, enabled: false }, cRule = { ...rule, version: 3, groups: ['successor'] };
  const aText = assignmentRulesRevision([rule]), bText = assignmentRulesRevision([bRule]), cText = assignmentRulesRevision([cRule]);
  const reason = failure === 'hash-error' ? new Error('original hash failure') : undefined;
  const digest = crypto.subtle.digest.bind(crypto.subtle); let cHashes = 0, snapshotAttempted = false;
  t.mock.method(crypto.subtle, 'digest', async (...args) => {
    const text = revisionText(args[1]), result = await digest(...args);
    if (text === aText) { enteredA.resolve(); await releaseA.promise; }
    if (text === bText) { enteredB.resolve(); await releaseB.promise; throw reason; }
    if (text === cText) cHashes++;
    return result;
  });
  const a = owned.start(() => fixture.direct(requestFor([rule]))); await arrival(enteredA.promise, a);
  // Deliberate getter fault at the DIRECT-owner Node boundary, not HTTP JSON.
  const bRules = failure === 'snapshot-undefined' ? [{ ...bRule, get groups() { snapshotAttempted = true; throw undefined; } }] : [bRule];
  const b = owned.start(() => fixture.direct(requestFor(bRules)), error => error === reason);
  const c = owned.start(() => fixture.direct(requestFor([cRule]))); let bDone = false, cDone = false;
  b.then(() => { bDone = true; }, () => { bDone = true; }); c.then(() => { cDone = true; }, () => { cDone = true; });
  await Promise.resolve(); assert.equal(bDone, false); assert.equal(cDone, false); assert.equal(cHashes, 0);
  assert.equal(snapshotAttempted, failure === 'snapshot-undefined'); assert.equal(fixture.writes, 1);
  releaseA.resolve(); await a;
  if (failure !== 'snapshot-undefined') { await arrival(enteredB.promise, b); assert.equal(cHashes, 0); assert.equal(cDone, false); releaseB.resolve(); }
  await b.then(() => assert.fail('expected original failure'), error => assert.equal(error, reason));
  const result = await c; assert.deepEqual(result.user.record.groups, ['assignment.members', 'old-manual', 'successor']);
  assert.equal(cHashes, 1); assert.deepEqual(await fixture.current(), result.user);
  // A successor can enroll from completion without an old cleanup clearing it.
  const d = await owned.start(() => fixture.direct(requestFor([{ ...cRule, version: 4, groups: ['final'] }])));
  assert.deepEqual(d.user.record.groups, ['assignment.members', 'final', 'old-manual']);
  });
});

test('deletion during the held logical digest cannot resurrect a canonical user', async t => {
  const owned = reconciliationOwner(t); return owned.run(async () => {
  const fixture = authorityEnv(t); await fixture.put(user);
  const release = owned.hold(), entered = Promise.withResolvers(), digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => { const result = await digest(...args); entered.resolve(); await release.promise; return result; });
  const actual = owned.start(() => fixture.direct(requestFor([rule])), error => error?.status === 404 && error?.code === 'unknown_user'); await arrival(entered.promise, actual);
  fixture.deleteCanonical(); release.resolve();
  await assert.rejects(actual, error => error.status === 404 && error.code === 'unknown_user');
  assert.equal(await fixture.current(), undefined); assert.equal(fixture.writes, 1);
  });
});

test('large legacy no-op bytes stay unchanged and extra RPC revision cannot supply equality', async t => {
  const fixture = authorityEnv(t), rules = Array.from({ length: 1000 }, (_, i) => ({ ...rule, ruleId: `absent-${i}`, subject: `absent-${i}.example`, policyIds: [] }));
  const assigned = evaluateUserAssignments(user, rules).user; await fixture.put(assigned);
  assert.ok(Buffer.byteLength(assigned.record.assignmentState.revision) > 65536);
  const before = fixture.stored(), writes = fixture.writes;
  const unchanged = await fixture.call('/users/reconcile-assignments', { ...requestFor(rules), force: true });
  assert.equal((await unchanged.json()).changed, false); assert.equal(fixture.stored(), before); assert.equal(fixture.writes, writes);
  const changed = await fixture.call('/users/reconcile-assignments', { ...requestFor([rule]), revision: assigned.record.assignmentState.revision, prepared: { revision: assigned.record.assignmentState.revision } });
  const result = await changed.json(); assert.equal(result.changed, true); assert.match(result.user.record.assignmentState.revision, /^assignment-rules\.v1:sha256:[a-f0-9]{64}$/);
  assert.equal(fixture.writes, writes + 1);
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
  fixture.direct = request => authority.reconcileUserAssignments(request);
  fixture.deleteCanonical = () => sql.exec('DELETE FROM access_users WHERE email = ?', user.email);
  fixture.stored = () => db.prepare('SELECT user_json FROM access_users WHERE email = ?').get(user.email)?.user_json;
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
