import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

test("workerd stops reading grant usage after the report group limit", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "grant-usage-limit-"));
  let worker;
  try {
    worker = await startWorkerdFixture(temporary, `
      export * from "./worker/index.ts";
      import { UsageLedgerObject as Ledger, usageStub } from "./worker/ledgers.ts";
      export class UsageLedgerObject extends Ledger {
        constructor(state) {
          const cursors = [], sql = state.storage.sql;
          const storage = new Proxy(state.storage, { get(target, key) {
            if (key === "sql") return { exec(...args) { const cursor = sql.exec(...args); cursors.push(cursor); return cursor; } };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          } });
          super(new Proxy(state, { get(target, key) { return key === "storage" ? storage : Reflect.get(target, key); } }));
          this.fixtureSql = sql; this.cursors = cursors;
        }
        async fetch(request) {
          if (new URL(request.url).pathname === "/seed") {
            this.fixtureSql.exec("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<49999) INSERT INTO usage_events (id, occurred_at_ms, tenant_id, policy_id, provider, status, actual_cost_micros, event_json) SELECT CAST(x AS TEXT), ?, 'tenant', 'policy', 'anthropic', 'success', 0, json_object('model', CAST(x AS TEXT)) FROM n", Date.now() - 1000);
            return new Response("seeded");
          }
          this.cursors.length = 0;
          const response = await super.fetch(request);
          return Response.json({ status: response.status, body: await response.json(), rowsRead: this.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0) });
        }
      }
      export default { fetch(request, env) {
        return usageStub(env, "tenant", "policy").fetch(new Request("https://ledger" + new URL(request.url).pathname + "?policy_id=policy&days=7", request));
      } };
    `, 'export default { fetch() { throw new Error("unexpected upstream request"); } };', { preventEviction: true });
    const seeded = await worker.dispatchFetch("https://router.example/seed");
    assert.equal(seeded.status, 200);
    const result = await (await worker.dispatchFetch("https://router.example/grant-usage")).json();
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, "usage_range_too_large");
    // Includes normal retention/coverage reads and permits index accounting.
    assert.ok(result.rowsRead < 40_000, `report limit read ${result.rowsRead} rows from 50000 events`);
  } finally {
    await worker?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
