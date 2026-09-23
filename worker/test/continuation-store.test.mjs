import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { continuationCapacity, continuationRetentionMs } from "../continuation-store.ts";
import { continuationAuthority } from "./continuation-authority.mjs";

const owner = { providerId: "openai", endpointId: "responses", grantKey: "oauth/fixture/account-a", lineage: "lineage-a", routeSha256: "f".repeat(64), policyGeneration: "g1" };
const keys = ["a".repeat(64), "b".repeat(64)];
function fixture(t) {
  const namespace = continuationAuthority(t), stub = namespace.get("scope");
  return {
    get state() { return namespace.objects.get("scope"); },
    async call(action, extra = {}) {
      const response = await stub.fetch("https://clawrouter.internal/http-continuations", { method: "POST", body: JSON.stringify({ action, keys, owner, ...extra }) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    },
  };
}

test("identity claims are atomic, immutable, deduplicated and retained from first publication", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.call("resolve"), { owners: [null, null] });
  assert.deepEqual(await f.call("register"), { outcome: "stored" });
  const rows = f.state.db.prepare("SELECT * FROM http_continuations ORDER BY binding_key").all();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].expires_at_ms >= Date.now() + continuationRetentionMs - 1000);
  assert.deepEqual(await f.call("register", { owner: Object.fromEntries(Object.entries(owner).reverse()) }), { outcome: "stored" });
  assert.deepEqual(f.state.db.prepare("SELECT * FROM http_continuations ORDER BY binding_key").all(), rows);
  assert.deepEqual(await f.call("register", { keys: [keys[0], "c".repeat(64)], owner: { ...owner, lineage: "other" } }), { outcome: "conflict" });
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 2);
  assert.deepEqual(await f.call("resolve"), { owners: [owner, owner] });
  assert.equal(f.state.scheduled, rows[0].expires_at_ms);
});

test("capacity never evicts a live owner and failed multi-key claims insert nothing", async t => {
  const f = fixture(t);
  await f.call("resolve");
  f.state.db.prepare("UPDATE http_continuation_count SET count = ?").run(continuationCapacity - 1);
  assert.deepEqual(await f.call("register"), { outcome: "capacity" });
  assert.equal(f.state.db.prepare("SELECT count(*) AS count FROM http_continuations").get().count, 0);
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, continuationCapacity - 1);
});

test("idle records expire in bounded alarm batches with exact persisted counts", async t => {
  const f = fixture(t);
  await f.call("resolve");
  const insert = f.state.db.prepare("INSERT INTO http_continuations VALUES (?, ?, ?)");
  for (let i = 0; i < 300; i++) insert.run(i.toString(16).padStart(64, "0"), JSON.stringify(owner), Date.now() - 1);
  f.state.db.prepare("UPDATE http_continuation_count SET count = 300").run();
  await f.state.object.alarm();
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 44);
  assert.ok(f.state.scheduled <= Date.now() + 1000);
  await f.state.object.alarm();
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 0);
  assert.equal(f.state.scheduled, null);
});

test("an expired target beyond the cleanup batch can be registered without count drift", async t => {
  const f = fixture(t);
  await f.call("register");
  const insert = f.state.db.prepare("INSERT INTO http_continuations VALUES (?, ?, ?)");
  for (let i = 0; i < 300; i++) insert.run(i.toString(16).padStart(64, "0"), JSON.stringify(owner), 0);
  f.state.db.prepare("UPDATE http_continuation_count SET count = 302").run();
  f.state.db.prepare("UPDATE http_continuations SET expires_at_ms = ? WHERE binding_key IN (?, ?)").run(Date.now() - 1, ...keys);
  assert.deepEqual(await f.call("resolve"), { owners: [null, null] });
  assert.deepEqual(await f.call("register", { owner: { ...owner, lineage: "new-lineage" } }), { outcome: "stored" });
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 46);
});

test("alarm scheduling remains serialized with a concurrent registration", async t => {
  const f = fixture(t);
  await f.call("resolve");
  let release, scheduled;
  const entered = new Promise(resolve => { scheduled = resolve; });
  f.state.beforeSchedule = () => { scheduled(); return new Promise(resolve => { release = resolve; }); };
  const first = f.call("register", { keys: [keys[0]] });
  await entered;
  const second = f.call("register", { keys: [keys[1]] });
  f.state.beforeSchedule = null; release();
  await Promise.all([first, second]);
  assert.equal(f.state.scheduled, f.state.db.prepare("SELECT min(expires_at_ms) AS expiry FROM http_continuations").get().expiry);
});
