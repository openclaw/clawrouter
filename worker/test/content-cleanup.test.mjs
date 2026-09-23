import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { ContentArchiveCleanupObject, scheduledContentCleanup } = await import("../content-cleanup.ts");
const { retainedContentDeadline } = await import("../content-retention.ts");
const now = 1_800_000_000_000, period = 30 * 86_400_000;
const sweep = (owner) => owner.fetch(new Request("https://cleanup/sweep", { method: "POST" }));

function fixture(t, values, pageSize = 1000, path = ":memory:") {
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const objects = new Map(values.map((value) => [value.key, value]));
  const calls = [], deletes = [];
  const archive = {
    async list(options) {
      assert.deepEqual({ prefix: options.prefix, limit: options.limit, include: options.include }, { prefix: "v1/", limit: 1000, include: ["customMetadata"] });
      calls.push(options.cursor ?? null);
      const matching = [...objects.values()].filter(({ key }) => key.startsWith(options.prefix) && (!options.cursor || key > options.cursor)).sort((a, b) => a.key.localeCompare(b.key));
      const page = matching.slice(0, Math.min(options.limit, pageSize));
      return { objects: page, truncated: page.length < matching.length, cursor: page.at(-1)?.key };
    },
    async delete(keys) {
      assert.ok(keys.length <= 1000);
      deletes.push(keys);
      for (const key of keys) objects.delete(key);
    },
  };
  const sql = { exec(query, ...args) {
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...args);
    statement.run(...args);
    return [];
  } };
  const state = () => {
    const row = db.prepare("SELECT state_json FROM content_cleanup WHERE id = 1").get();
    return row ? JSON.parse(row.state_json) : null;
  };
  return { db, sql, objects, archive, calls, deletes, state, owner: () => new ContentArchiveCleanupObject({ storage: { sql } }, { CONTENT_ARCHIVE: archive }) };
}

function object(key, expiry, uploaded = now) {
  return { key, uploaded: new Date(uploaded), customMetadata: expiry === undefined ? {} : { expiresAt: expiry } };
}

test("metadata cleanup includes legacy and orphan archives while preserving fresh and unrelated objects", async (t) => {
  t.mock.method(Date, "now", () => now);
  const f = fixture(t, [
    object("v1/expired", String(now - 1)), object("v1/boundary", String(now)),
    object("v1/legacy", undefined, now - period), object("v1/invalid", "invalid", now - period),
    object("v1/empty", " ", now - period), object("v1/infinite", "Infinity", now - period),
    object("v1/overstated", String(now + period), now - period),
    object("v1/fresh", String(now + 1)), object("v1/fresh-legacy", undefined),
    object("other/expired", String(now - 1)),
  ]);
  const response = await sweep(f.owner());
  assert.equal(response.status, 200);
  assert.deepEqual([...f.objects.keys()].sort(), ["other/expired", "v1/fresh", "v1/fresh-legacy"]);
  assert.deepEqual(await response.json(), { cycleStartedAt: now, lastAttemptAt: now, lastCompletedAt: now, scanned: 9, deleted: 7, failed: false, backlog: false });
  assert.equal(f.state().cursor, null);
  assert.equal(retainedContentDeadline(object("v1/fixture", String(now + period), now - period)), now);
});

test("short metadata pages checkpoint persisted cursors and reset EOF for earlier keys", async (t) => {
  t.mock.method(Date, "now", () => now);
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-cleanup-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, [object("v1/a", String(now + 1)), object("v1/b", "1"), object("v1/c", "1")], 2, join(dir, "cleanup.sqlite"));
  assert.equal((await (await sweep(f.owner())).json()).backlog, true);
  assert.equal(f.state().cursor, "v1/b");
  const reopened = new DatabaseSync(join(dir, "cleanup.sqlite"));
  assert.equal(JSON.parse(reopened.prepare("SELECT state_json FROM content_cleanup WHERE id = 1").get().state_json).cursor, "v1/b");
  reopened.close();
  f.objects.set("v1/0", object("v1/0", "1"));
  f.objects.set("v1/a", object("v1/a", "1"));
  assert.equal((await (await sweep(f.owner())).json()).backlog, false);
  assert.deepEqual([...f.objects.keys()], ["v1/a", "v1/0"]);
  await sweep(f.owner());
  assert.equal(f.objects.size, 0);
  assert.deepEqual(f.calls, [null, "v1/b", null]);
});

test("delete failure and interruption before checkpoint retry without skipping objects", async (t) => {
  t.mock.method(Date, "now", () => now);
  const f = fixture(t, [object("v1/a", "1"), object("v1/b", "1"), object("v1/c", "1")], 2);
  const remove = f.archive.delete;
  f.archive.delete = async () => { throw new Error("synthetic delete failure"); };
  assert.equal((await sweep(f.owner())).status, 500);
  assert.equal(f.state().cursor, null);
  assert.equal(f.state().failed, true);
  f.archive.delete = remove;
  const exec = f.sql.exec;
  let interrupt = true;
  f.sql.exec = (query, ...args) => {
    if (interrupt && query.startsWith("INSERT") && f.objects.size === 1) {
      interrupt = false;
      throw new Error("synthetic checkpoint interruption");
    }
    return exec(query, ...args);
  };
  assert.equal((await sweep(f.owner())).status, 500);
  assert.equal(f.objects.size, 1);
  assert.equal(f.state().cursor, null);
  assert.equal((await sweep(f.owner())).status, 200);
  assert.equal(f.objects.size, 0);
  assert.deepEqual(f.calls, [null, null, null]);
});

test("concurrent triggers serialize across R2 awaits and bulk deletion never exceeds 1000", async (t) => {
  t.mock.method(Date, "now", () => now);
  const f = fixture(t, Array.from({ length: 1001 }, (_, index) => object(`v1/${String(index).padStart(4, "0")}`, "1")));
  const list = f.archive.list;
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  f.archive.list = async (...args) => { await paused; return list(...args); };
  const owner = f.owner(), first = sweep(owner), second = sweep(owner);
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(f.deletes.map((keys) => keys.length), [1000, 1]);
  assert.equal(f.state().cursor, null);
});

test("native scheduled timestamps never become the expiry authority", async (t) => {
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "info", () => undefined);
  const f = fixture(t, [object("v1/fresh", String(now + 1))]);
  const owner = f.owner();
  await scheduledContentCleanup({ scheduledTime: now + period, cron: "* * * * *" }, {
    CONTENT_CLEANUP: { idFromName(name) { assert.equal(name, "content-archive-v1"); return name; }, get() { return { fetch: (url, options) => owner.fetch(new Request(url, options)) }; } },
  });
  assert.equal(f.objects.size, 1);
  assert.equal(f.deletes.length, 0);
  assert.equal((await owner.fetch(new Request("https://cleanup/sweep"))).status, 404);
});
