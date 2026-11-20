import { normalizeEmail } from "../utils.ts";
import { usageFixture, syntheticUsage } from "./usage-snapshot-fixture.mjs";
import { queryUsageReport, queryUsageEvents, migrateUsageReport } from "../usage-report-store.ts";
import { parseUsageReportQuery, mergeUsageReports } from "../usage-report.ts";
export function usageReportFixture(now = Date.now()) {
  const f = usageFixture();
  // 6fceb88 ingestion schema: principal_key is retained at original ingest.
  // Unlike the pre-attribution snapshot fixture, this models the shipped upgrade.
  f.db.exec("ALTER TABLE usage_events ADD COLUMN grant_key TEXT; ALTER TABLE usage_events ADD COLUMN grant_lane TEXT; ALTER TABLE usage_events ADD COLUMN principal_id TEXT; ALTER TABLE usage_events ADD COLUMN principal_key TEXT; ALTER TABLE usage_events ADD COLUMN credential_id TEXT; ALTER TABLE usage_events ADD COLUMN cost_basis TEXT; ALTER TABLE usage_events ADD COLUMN principal_nontext INTEGER NOT NULL DEFAULT 0");
  f.db.exec("CREATE INDEX usage_events_policy_principal ON usage_events (policy_id, principal_key, occurred_at_ms DESC); CREATE TABLE usage_attribution_migration (id INTEGER PRIMARY KEY, last_rowid INTEGER NOT NULL, upper_rowid INTEGER NOT NULL, complete INTEGER NOT NULL); INSERT INTO usage_attribution_migration VALUES (1, 0, 0, 1)");
  const insert = f.db.prepare("INSERT INTO usage_events (id, occurred_at_ms, tenant_id, policy_id, provider, status, status_code, input_tokens, output_tokens, total_tokens, actual_cost_micros, event_json, grant_key, grant_lane, principal_id, principal_key, credential_id, cost_basis, principal_nontext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  f.insert = event => {
    const principal = typeof event.principal_id === "string" ? event.principal_id : null;
    insert.run(event.id, event.occurred_at_ms, event.tenant_id, event.policy_id, event.provider, event.status, event.status_code, event.input_tokens, event.output_tokens, event.total_tokens, event.actual_cost_micros, JSON.stringify(event), event.grant_key ?? null, event.grant_lane ?? null, principal, principal === null ? null : normalizeEmail(principal), typeof event.credential_id === "string" ? event.credential_id : null, typeof event.cost_basis === "string" ? event.cost_basis : null, event.principal_id != null && principal === null ? 1 : 0);
  };
  const query = (params = new URLSearchParams()) => ({ ...parseUsageReportQuery(params, now), principal: "alice@example.com", tenantId: "tenant", policyId: "policy" });
  return { ...f, now, query,
    event(index, extra = {}) { return { ...syntheticUsage(index, now), principal_id: "alice@example.com", key_id: "policy-fallback", credential_id: "key-a", request_format: "openai.responses", capability: "llm.responses", ...extra }; },
    migrate(options = {}) { return migrateUsageReport(f.state.storage.sql, f.state.storage.transactionSync.bind(f.state.storage), { now, ...options }); },
    report(q = query()) { return mergeUsageReports([queryUsageReport(f.state.storage.sql, q)], q, now); },
    events(q = query(), limit = 25, before) { return queryUsageEvents(f.state.storage.sql, q, limit, before); },
    ingest(ledger, event) { return ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify(event) })); },
  };
}
