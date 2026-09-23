import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PolicyBindingIndexObject, resolveConnection } from "../authority.ts";
import { sha256Hex } from "../utils.ts";

const { default: worker } = await import("../index.ts");
const initial = { providerId: "openai", enabled: true, label: "Shared", monthlyBudgetMicros: 1_000_000 };
const token = "synthetic-connection-admin";
const tokenHash = await sha256Hex(token);

for (const first of [{ enabled: false }, { monthlyBudgetMicros: 2_000_000 }]) {
  const second = "enabled" in first ? { monthlyBudgetMicros: 2_000_000 } : { enabled: false };
  test(`connection owner merges ${Object.keys(first)[0]} after another field commits`, async t => {
    const fixture = connectionEnv(t);
    await fixture.put(initial);
    // Hold one request body while the other owner invocation commits to actual SQLite.
    let finishBody;
    const body = new ReadableStream({ start(controller) { finishBody = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ providerId: "openai", ...first }))); controller.close(); }; } });
    const pending = fixture.authority.fetch(new Request("https://authority/connections/put", { method: "POST", body, duplex: "half" }));
    await fixture.put({ providerId: "openai", ...second });
    finishBody();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...initial, ...first, ...second });
    assert.deepEqual(await resolveConnection(fixture.env, "openai"), { ...initial, ...first, ...second });
  });

  test(`two admin clients preserve ${Object.keys(second)[0]} when an earlier PATCH finishes later`, async t => {
    const fixture = connectionEnv(t);
    await fixture.put(initial);
    const arrived = deferred(), release = deferred();
    fixture.beforePut = async () => { arrived.resolve(); await release.promise; };
    const pending = fixture.request("PATCH", first);
    await arrived.promise;
    assert.deepEqual(await (await fixture.request("PATCH", second)).json(), { ...initial, ...second });
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...initial, ...first, ...second });
  });
}

test("PUT keeps shipped enabled and label defaults but resolves an omitted budget at commit", async t => {
  const fixture = connectionEnv(t);
  await fixture.put({ ...initial, enabled: false });
  const arrived = deferred(), release = deferred();
  fixture.beforePut = async () => { arrived.resolve(); await release.promise; };
  const pending = fixture.request("PUT", {});
  await arrived.promise;
  await fixture.request("PATCH", { monthlyBudgetMicros: 2_000_000 });
  release.resolve();
  assert.deepEqual(await (await pending).json(), { ...initial, enabled: true, label: null, monthlyBudgetMicros: 2_000_000 });
});

test("PATCH preserves a canonical disable made during legacy initialization", async t => {
  const fixture = connectionEnv(t, initial);
  fixture.beforeLegacyRead = () => fixture.put({ ...initial, enabled: false, label: "Canonical" });
  const response = await fixture.request("PATCH", { monthlyBudgetMicros: 3_000_000 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...initial, enabled: false, label: "Canonical", monthlyBudgetMicros: 3_000_000 });
});

test("PATCH is idempotent, clears explicit nulls and ignores fields outside the mutation schema", async t => {
  const fixture = connectionEnv(t);
  await fixture.put({ ...initial, enabled: false });
  const patch = { providerId: "other", label: "  ", monthlyBudgetMicros: null, spentMicros: 42, remainingMicros: 42, ignored: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fixture.request("PATCH", patch);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...initial, enabled: false, label: null, monthlyBudgetMicros: null });
  }
  assert.deepEqual(await (await fixture.request("PATCH", {})).json(), { ...initial, enabled: false, label: null, monthlyBudgetMicros: null });
  assert.equal((await (await fixture.request("PATCH", { label: " Ops ", monthlyBudgetMicros: 0 })).json()).monthlyBudgetMicros, 0);
  assert.equal((await (await fixture.request("PATCH", { label: null })).json()).label, null);
});

test("new connections use existing defaults and reject malformed mutations without writes", async t => {
  const fixture = connectionEnv(t);
  assert.deepEqual(await (await fixture.request("PATCH", { monthlyBudgetMicros: 0 })).json(), { providerId: "openai", enabled: true, label: null, monthlyBudgetMicros: 0 });
  for (const body of [null, [], { enabled: null }, { enabled: 0 }, { label: 1 }, ...[-1, 1.5, "50000000", Number.MAX_SAFE_INTEGER + 1].map(monthlyBudgetMicros => ({ monthlyBudgetMicros }))]) {
    for (const method of ["PATCH", "PUT"]) {
      const response = await fixture.request(method, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "invalid_provider_connection");
    }
  }
  assert.deepEqual(await resolveConnection(fixture.env, "openai"), { providerId: "openai", enabled: true, label: null, monthlyBudgetMicros: 0 });
  const preflight = await worker.fetch(new Request("https://router.example/v1/admin/connections/openai", { method: "OPTIONS" }), fixture.env, {});
  assert.match(preflight.headers.get("access-control-allow-methods"), /\bPATCH\b/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function connectionEnv(t, legacy = null) {
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
    authority, beforePut: null, beforeLegacyRead: null,
    async put(body) {
      const response = await authority.fetch(new Request("https://authority/connections/put", { method: "POST", body: JSON.stringify(body) }));
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    request(method, body) {
      return worker.fetch(new Request("https://router.example/v1/admin/connections/openai", { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), fixture.env, {});
    },
    env: {
      CLAWROUTER_ADMIN_TOKEN_SHA256: tokenHash,
      ACCESS_CONTROL: { idFromName: name => name, get: () => ({ async fetch(url, init) {
        if (new URL(url).pathname === "/connections/put") {
          const action = fixture.beforePut;
          fixture.beforePut = null;
          await action?.();
        }
        return authority.fetch(new Request(url, init));
      } }) },
      POLICY_KV: { async get() { const action = fixture.beforeLegacyRead; fixture.beforeLegacyRead = null; await action?.(); return structuredClone(legacy); } },
    },
  };
  return fixture;
}
