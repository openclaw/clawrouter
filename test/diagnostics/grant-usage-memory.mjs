// Synthetic large-history workload: node test/diagnostics/grant-usage-memory.mjs
// Add "rolling" to distribute events across retained history. Run each sample
// in a fresh Linux container to reset cgroup peak memory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../helpers/workerd.mjs";

const temporary = await mkdtemp(join(tmpdir(), "grant-usage-memory-"));
let worker;
const rolling = process.argv[2] === "rolling";
try {
  worker = await startWorkerdFixture(temporary, `
    export * from "./worker/index.ts";
    import { UsageLedgerObject as Ledger, usageStub } from "./worker/ledgers.ts";
    export class UsageLedgerObject extends Ledger {
      constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
      async fetch(request) {
        if (new URL(request.url).pathname === "/seed") {
          this.fixtureSql.exec("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<999999) INSERT INTO usage_events (id, occurred_at_ms, tenant_id, policy_id, provider, status, input_tokens, output_tokens, actual_cost_micros, event_json, grant_key, grant_lane) SELECT CAST(x AS TEXT), ${rolling ? "? - 29 * 86400000 + CAST(x * 29 * 86400000 / 999999 AS INTEGER)" : "?"}, 'tenant', 'policy', 'anthropic', 'success', 2, 3, 0, ?, 'grant', 'subscription' FROM n", Date.now() - 1000, JSON.stringify({ model: "synthetic-model-" + "x".repeat(100), cached_input_tokens: 1, cache_write_input_tokens: 1 }));
          return new Response("seeded");
        }
        return super.fetch(request);
      }
    }
    export default { fetch(request, env) {
      return usageStub(env, "tenant", "policy").fetch(new Request("https://ledger" + new URL(request.url).pathname + "?policy_id=policy&days=7", request));
    } };
  `, 'export default { fetch() { throw new Error("unexpected upstream request"); } };', { preventEviction: true });
  const seeded = await worker.dispatchFetch("https://router.example/seed");
  assert.equal(seeded.status, 200);
  const memoryBefore = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8"));
  const started = performance.now();
  const response = await worker.dispatchFetch("https://router.example/grant-usage");
  assert.equal(response.status, 200);
  const report = await response.json();
  if (!rolling) assert.equal(report.grants[0].requests, 1_000_000);
  assert.equal(report.grants[0].inputTokens, report.grants[0].requests * 2);
  console.log(JSON.stringify({ events: 1_000_000, workload: rolling ? "rolling" : "full", requests: report.grants[0].requests, milliseconds: performance.now() - started,
    memoryBefore, memoryAfter: Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")),
    peakBytes: Number(readFileSync("/sys/fs/cgroup/memory.peak", "utf8")) }));
} finally {
  await worker?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
