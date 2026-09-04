import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PolicyBindingIndexObject, listBindings, listConnections, listCredentials, listPolicies, listUsers,
  resolveBindings, resolveConnections, resolveCredentials, resolvePolicies, resolveUsers,
} from "../authority.ts";

const principal = { principalType: "user", principalId: "fixture@example.com" };
const families = [
  { name: "policies", key: "policies/fixture", value: { enabled: true, generation: "v1", providers: [] },
    row: value => ({ policyId: "fixture", policy: value }), enabled: row => row.policy.enabled,
    put: "/policies/put", close: "/policies/initialize-all", list: listPolicies, resolve: env => resolvePolicies(env, ["fixture"]) },
  { name: "credentials", key: "credentials/fixture", value: { enabled: true, policyId: "fixture", policyGeneration: "v1", secretSha256: "a".repeat(64) },
    row: value => ({ credentialId: "fixture", credential: value }), enabled: row => row.credential.enabled,
    put: "/credentials/put", close: "/credentials/initialize-all", list: listCredentials, resolve: env => resolveCredentials(env, ["fixture"]) },
  { name: "users", key: "access/users/fixture@example.com", value: { enabled: true, role: "user", tenantId: "fixture", groups: [] },
    row: value => ({ email: "fixture@example.com", record: value }), enabled: row => row.record.enabled,
    put: "/users/put", close: "/users/initialize-all", list: listUsers, resolve: env => resolveUsers(env, ["fixture@example.com"]) },
  { name: "connections", key: "connections/fixture", value: { providerId: "fixture", enabled: true },
    row: value => value, enabled: row => row.enabled,
    put: "/connections/put", close: "/connections/initialize-all", list: env => listConnections(env, ["fixture"]), resolve: env => resolveConnections(env, ["fixture"]) },
  { name: "bindings", key: `access/bindings/user/${encodeURIComponent(principal.principalId)}/fixture`, value: { ...principal, policyId: "fixture", enabled: true, priority: 100 },
    row: value => ({ seed: { principal, bindings: [] }, binding: value }), enabled: row => row.enabled,
    put: "/mutate", close: "/initialize-all", list: listBindings, resolve: env => resolveBindings(env, [principal]) },
];

for (const family of families) {
  for (const mode of ["list", "resolve"]) {
    test(`${family.name} ${mode} returns the canonical update made during a legacy read`, async t => {
      const fixture = migrationEnv(t, family);
      fixture.beforeRead = () => fixture.call(family.put, family.row({ ...family.value, enabled: false }));
      const rows = await family[mode](fixture.env);
      assert.equal(rows.length, 1);
      assert.equal(family.enabled(rows[0]), false);
    });

    test(`${family.name} ${mode} cannot seed after migration closes during its legacy read`, async t => {
      const fixture = migrationEnv(t, family);
      fixture.beforeRead = () => fixture.call(family.close, []);
      assert.deepEqual(await family[mode](fixture.env), []);
      assert.deepEqual(await family.resolve(fixture.env), []);
      assert.equal(fixture.reads, 1, "closed migrations never read KV again");
      await fixture.call(family.put, family.row({ ...family.value, enabled: false }));
      const current = await family.resolve(fixture.env);
      assert.equal(current.length, 1, "explicit canonical writes remain available");
      assert.equal(family.enabled(current[0]), false);
    });
  }
}

for (const family of families.slice(0, 2)) {
  test(`${family.name} import keeps canonical and explicit-record precedence over combined legacy keys`, async t => {
    const fixture = migrationEnv(t, family);
    fixture.store.set("keys/fixture", { enabled: false, generation: "legacy" });
    const imported = await family.list(fixture.env);
    assert.equal(imported.length, 1);
    assert.equal(family.enabled(imported[0]), true, "explicit KV record wins over a combined legacy key");
    await fixture.call(family.put, family.row({ ...family.value, enabled: false }));
    assert.equal(family.enabled((await family.list(fixture.env))[0]), false, "canonical data stays authoritative");
  });
}

function migrationEnv(t, family) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query, ...bindings) {
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...bindings);
    statement.run(...bindings);
    return [];
  } };
  const authority = new PolicyBindingIndexObject({ storage: { sql } });
  const fixture = {
    beforeRead: null, reads: 0, store: new Map([[family.key, family.value]]),
    async call(path, body) {
      const response = await authority.fetch(new Request(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) }));
      assert.equal(response.status, 200, await response.clone().text());
      return response;
    },
    env: {
      ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: (url, init) => authority.fetch(new Request(url, init)) }) },
      POLICY_KV: {
        async list({ prefix }) { return { list_complete: true, keys: [...fixture.store.keys()].filter(name => name.startsWith(prefix)).map(name => ({ name })) }; },
        async get(key) {
          if (!fixture.store.has(key)) return null;
          fixture.reads++;
          const action = fixture.beforeRead;
          fixture.beforeRead = null;
          await action?.();
          return structuredClone(fixture.store.get(key));
        },
      },
    },
  };
  return fixture;
}
