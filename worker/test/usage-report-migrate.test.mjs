import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateReportingDatabase } from "../../scripts/usage-report-migrate.mjs";

test("offline migration defaults read-only dry-run and explicit apply persists resumable reporting-only progress", async () => {
  const root = join(process.cwd(), ".openclaw/tmp"); await mkdir(root, { recursive: true }); const temporary = await mkdtemp(join(root, "report-migrate-")); const path = join(temporary, "ledger.sqlite");
  try {
    const db = new DatabaseSync(path);
    // Match the canonical ledger columns used by reporting's scope/owner indexes.
    // A three-column stand-in cannot exercise the real offline migration.
    db.exec("CREATE TABLE usage_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, actual_cost_micros INTEGER NOT NULL, event_json TEXT NOT NULL, principal_key TEXT)");
    const insert = db.prepare("INSERT INTO usage_events (id, occurred_at_ms, event_json, tenant_id, policy_id, provider, status, actual_cost_micros, principal_key) VALUES (?, ?, ?, 'tenant', 'policy', 'openai', 'success', 17, 'alice@example.com')"); const now = Date.now();
    const original = [];
    for (let i = 0; i < 5; i++) { const event = { id: "history-" + i, occurred_at_ms: now - 1000, principal_id: "alice@example.com", tenant_id: "tenant", policy_id: "policy", key_id: "key", provider: "openai", model: "model", status: "success", actual_cost_micros: 17, cost_basis: "unpriced_usage", content_ref: "private", input_tokens: null, output_tokens: 0 }; const payload = JSON.stringify(event); original.push(payload); insert.run(event.id, event.occurred_at_ms, payload); }
    // Retention-expired metadata is not projected even if physically present in a backup.
    insert.run("expired", now - 31 * 86400000, JSON.stringify({ id: "expired", occurred_at_ms: now - 31 * 86400000 })); db.close();
    const preview = migrateReportingDatabase(path, { batchSize: 2, now }); assert.equal(preview.dryRun, true); assert.equal(preview.examined, 2); assert.equal(preview.complete, false); assert.deepEqual(preview.effects, [{ lane: "unattributed", costClass: "unknown", calls: 2, proposedReportingMicros: null, recordedChargeMicros: 34 }]);
    let verify = new DatabaseSync(path, { readOnly: true }); assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'usage_report_%'").get().n, 0); verify.close();
    assert.equal(migrateReportingDatabase(path, { batchSize: 2, afterRowid: 2, now }).lastRowid, 4);
    const apply = () => migrateReportingDatabase(path, { apply: true, batchSize: 2, now });
    assert.equal(apply().complete, false); assert.equal(apply().complete, false); assert.equal(apply().complete, true);
    verify = new DatabaseSync(path, { readOnly: true });
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM usage_report_events").get().n, 5); assert.equal(verify.prepare("SELECT complete FROM usage_report_migration").get().complete, 1);
    assert.deepEqual(verify.prepare("SELECT event_json FROM usage_events WHERE id != 'expired' ORDER BY id").all().map(r => r.event_json), original);
    const detail = JSON.parse(verify.prepare("SELECT detail_json FROM usage_report_events LIMIT 1").get().detail_json); assert.equal(detail.reportingCostMicros, null); assert.equal(detail.costClass, "unknown"); assert.equal(detail.recordedChargeMicros, 17); assert.equal(detail.inputTokens, null); assert.equal("content_ref" in detail, false);
    verify.close(); assert.equal(apply().examined, 0);
    assert.throws(() => migrateReportingDatabase(path, { batchSize: 2001 }), /batchSize/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
