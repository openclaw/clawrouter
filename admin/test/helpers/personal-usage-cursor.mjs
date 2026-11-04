import { personalUsage } from '../../../worker/usage-report.ts';
import { ensureUsageReportSchema, queryUsageEvents, queryUsageReport } from '../../../worker/usage-report-store.ts';
import { usageReportFixture } from '../../../worker/test/usage-report-fixture.mjs';

// Real shipped range parsing, SQL pagination and opaque cursor binding; only
// session authority, stored metadata and the Durable Object transport are fake.
export function cursorUsageFixture(now) {
  const fixture = usageReportFixture(now);
  for (let index = 0; index < 42; index++) fixture.insert(fixture.event(index, {
    policy_id: 'policy', principal_id: 'member@example.com', model: 'cursor-model',
    occurred_at_ms: now - (index + 1) * 60_000,
  }));
  ensureUsageReportSchema(fixture.state.storage.sql); fixture.migrate({ apply: true });
  const env = { USAGE_LEDGER: {
    idFromName: name => name,
    get: () => ({ async fetch(url, init) {
      const { query, limit, before } = JSON.parse(init.body);
      return Response.json(url.endsWith('/personal-events')
        ? queryUsageEvents(fixture.state.storage.sql, query, limit, before)
        : queryUsageReport(fixture.state.storage.sql, query));
    } }),
  } };
  return {
    read(path, at = now, { principal = 'member@example.com', policies = [{ tenantId: 'tenant', policyId: 'policy' }] } = {}) {
      const url = new URL(path, 'https://console.example');
      return personalUsage(env, policies, principal, url.searchParams, url.pathname.endsWith('/events'), at);
    },
    close: () => fixture.db.close(),
  };
}
