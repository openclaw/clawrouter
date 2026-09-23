import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const { adminApi } = await import("../admin.ts");
const { authorizeAdmin } = await import("../access.ts");
const { authorityCall, PolicyBindingIndexObject, resolveUsers } = await import("../authority.ts");
const { localLogin, localSession } = await import("../local-auth.ts");
const { sha256Hex } = await import("../utils.ts");

const origin = "http://localhost:8787", email = "admin@local", token = "fixture-admin-token";

for (const route of ["access-users", "access-user-grants"]) {
  test(`${route} edits preserve the local administrator through the next request and login`, async (t) => {
    const fixture = await authorityFixture(t);
    const cookie = await fixture.login();
    const response = await fixture.admin(route, email, { groups: ["maintainers"], contentRetentionDisabled: true, policyIds: [], role: "user" }, cookie);
    assert.equal(response.status, 200);
    assert.equal((await fixture.user()).record.role, "admin");
    assert.equal((await localSession(new Request(`${origin}/v1/session`, { headers: { cookie } }), fixture.env)).role, "admin");
    assert.equal((await authorizeAdmin(new Request(`${origin}/v1/admin/overview`, { headers: { cookie } }), fixture.env)).role, "admin");
    const nextCookie = await fixture.login();
    assert.equal((await localSession(new Request(`${origin}/v1/session`, { headers: { cookie: nextCookie } }), fixture.env)).role, "admin");
  });

  test(`${route} cannot replay a role changed after its profile snapshot`, async (t) => {
    const fixture = await authorityFixture(t);
    const cookie = await fixture.login();
    fixture.beforeProfileWrite = async () => {
      const current = await fixture.user();
      await authorityCall(fixture.env, "/users/put", { ...current, record: { ...current.record, role: "user" } });
    };
    assert.equal((await fixture.admin(route, email, { groups: ["updated"], policyIds: [] }, cookie)).status, 200);
    assert.equal((await fixture.user()).record.role, "user");
    assert.deepEqual((await fixture.user()).record.groups, ["updated"]);
    const session = await localSession(new Request(`${origin}/v1/session`, { headers: { cookie } }), fixture.env);
    assert.equal(session.role, "user");
  });

  test(`${route} does not accept caller-supplied administrator roles for new or existing users`, async (t) => {
    const fixture = await authorityFixture(t);
    const cookie = await fixture.login();
    for (let save = 0; save < 2; save++) {
      assert.equal((await fixture.admin(route, "member@example.com", { role: "admin", policyIds: [] }, cookie)).status, 200);
      assert.equal((await fixture.user("member@example.com")).record.role, "user");
    }
  });
}

test("saving and reconciling assignment rules preserves local administrator roles", async (t) => {
  const fixture = await authorityFixture(t);
  const cookie = await fixture.login();
  const rule = { kind: "exact_email", subject: email, groups: ["members"], policyIds: [], enabled: true };
  assert.equal((await fixture.admin("assignment-rules", "members", rule, cookie)).status, 200);
  assert.equal((await fixture.user()).record.role, "admin");
  assert.deepEqual((await fixture.user()).record.groups, ["members"]);
  assert.equal((await fixture.admin("assignment-rules", "reconcile", { all: true }, cookie, "POST")).status, 200);
  assert.equal((await fixture.user()).record.role, "admin");
  const nextCookie = await fixture.login();
  assert.equal((await localSession(new Request(`${origin}/v1/session`, { headers: { cookie: nextCookie } }), fixture.env)).role, "admin");
});

async function authorityFixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query, ...bindings) {
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...bindings);
    statement.run(...bindings);
    return [];
  } };
  const authority = new PolicyBindingIndexObject({ storage: { sql } });
  const values = new Map();
  const fixture = { beforeProfileWrite: null };
  fixture.env = {
    CLAWROUTER_LOCAL_AUTH: "enabled",
    CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex(token),
    POLICY_KV: {
      async get(key, type) { const value = values.get(key); return value === undefined ? null : type === "json" ? JSON.parse(value) : value; },
      async put(key, value) { values.set(key, value); },
      async list({ prefix }) { return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ async fetch(url, init) {
      if (["/users/update-profile", "/users/put-bindings"].includes(new URL(url).pathname)) {
        const before = fixture.beforeProfileWrite;
        fixture.beforeProfileWrite = null;
        await before?.();
      }
      return authority.fetch(new Request(url, init));
    } }) },
  };
  fixture.user = async (principal = email) => (await resolveUsers(fixture.env, [principal]))[0];
  fixture.login = async () => {
    const response = await localLogin(new Request(`${origin}/v1/session/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ token }) }), fixture.env);
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  fixture.admin = (route, id, body, cookie, method = "PUT") => {
    const path = `/v1/admin/${route}/${encodeURIComponent(id)}`;
    return adminApi(new Request(`${origin}${path}`, { method, headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), fixture.env, path);
  };
  return fixture;
}
