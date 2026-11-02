import { usageFixture, syntheticUsage } from "./usage-snapshot-fixture.mjs";
import { queryUsageReport, queryUsageEvents, migrateUsageReport } from "../usage-report-store.ts";
import { parseUsageReportQuery, mergeUsageReports } from "../usage-report.ts";
export function usageReportFixture(now = Date.now()) {
  const f = usageFixture();
  const query = (params = new URLSearchParams()) => ({ ...parseUsageReportQuery(params, now), principal: "alice@example.com", tenantId: "tenant", policyId: "policy" });
  return { ...f, now, query,
    event(index, extra = {}) { return { ...syntheticUsage(index, now), principal_id: "alice@example.com", key_id: "policy-fallback", credential_id: "key-a", request_format: "openai.responses", capability: "llm.responses", ...extra }; },
    migrate(options = {}) { return migrateUsageReport(f.state.storage.sql, f.state.storage.transactionSync.bind(f.state.storage), { now, ...options }); },
    report(q = query()) { return mergeUsageReports([queryUsageReport(f.state.storage.sql, q)], q, now); },
    events(q = query(), limit = 25, before) { return queryUsageEvents(f.state.storage.sql, q, limit, before); },
    ingest(ledger, event) { return ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify(event) })); },
  };
}
