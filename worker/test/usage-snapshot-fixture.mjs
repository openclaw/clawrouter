import { DatabaseSync } from "node:sqlite";
import { UsageLedgerObject } from "../ledgers.ts";
import { normalizeEmail } from "../utils.ts";
import { mergePrincipalUsage, usageCutoffs } from "../usage-sharding.ts";

// Pre-attribution schema and snapshot SQL from 2163d3f, retained as an independent
// correctness/performance reference. Fixtures contain synthetic metadata only.
export function usageFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE usage_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, actual_cost_micros INTEGER NOT NULL, event_json TEXT NOT NULL)");
  db.exec("CREATE INDEX usage_events_occurred_at ON usage_events (occurred_at_ms DESC); CREATE INDEX usage_events_policy ON usage_events (policy_id, occurred_at_ms DESC)");
  const insert = db.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const queries = [];
  let alarm = null;
  const state = { storage: {
    sql: { exec(query, ...bindings) {
      queries.push(query);
      const statement = db.prepare(query);
      if (statement.columns().length) return statement.all(...bindings);
      statement.run(...bindings); return [];
    } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    getAlarm: async () => alarm,
    setAlarm: async value => { alarm = value; },
  } };
  return {
    db, queries, state,
    insert(event) { insert.run(event.id, event.occurred_at_ms, event.tenant_id, event.policy_id, event.provider, event.status, event.status_code, event.input_tokens, event.output_tokens, event.total_tokens, event.actual_cost_micros, JSON.stringify(event)); },
    open: () => new UsageLedgerObject(state),
    alarm: () => alarm,
  };
}

export function snapshotRequest(scope, policies = ["policy"], limit = 100) {
  const url = new URL("https://ledger/snapshot");
  for (const id of policies) url.searchParams.append("policy_id", id);
  url.searchParams.set("events", scope.kind); url.searchParams.set("limit", String(limit));
  if (scope.kind !== "admin") url.searchParams.set("event_owner", scope.id);
  return new Request(url);
}

export function syntheticUsage(index, now) {
  const principal = [" Alice@Example.com ", "alice@example.com", "\u2003İDA@ExAmPlE.COM\u00a0", "i\u0307da@example.com", null, undefined, "invalid", "", "bob@example.com", "charlie@example.com", 42, false, { legacy: true }][index % 13];
  return {
    type: "clawrouter.usage.v1", id: `event-${index}`, occurred_at_ms: now - 1_000 - index * 23_000,
    tenant_id: "tenant", policy_id: index % 17 === 0 ? "other" : "policy", provider: ["openai", "anthropic", "google"][index % 3],
    status: index % 13 === 0 ? "server_error" : "success", status_code: index % 13 === 0 ? 502 : 200,
    input_tokens: index % 71, output_tokens: index % 31, total_tokens: index % 71 + index % 31,
    actual_cost_micros: index % 7, cost_basis: index % 19 === 0 ? "unpriced_usage" : "manifest_pricing",
    ...(principal === undefined ? {} : { principal_id: principal }), credential_id: `credential-${index % 7}`,
    model: "synthetic-model", request_id: `request-${index}`, metadata: "x".repeat(1084),
  };
}

export function legacySnapshot(db, scope, now, policies = ["policy"], limit = 100) {
  const cutoff = usageCutoffs(now);
  const ids = [...new Set(policies.filter(Boolean))];
  const where = ids.length ? `policy_id IN (${ids.map(() => "?").join(", ")}) AND occurred_at_ms >= ?` : "occurred_at_ms >= ?";
  const range = { where, params: [...ids, cutoff.rolling] }, dailyRange = { where, params: [...ids, cutoff.daily] };
  const all = (query, params) => db.prepare(query).all(...params);
  let owner;
  if (scope.kind === "credential") owner = { where: "json_extract(event_json, '$.principal_id') IS NULL AND json_extract(event_json, '$.credential_id') = ?", params: [scope.id] };
  if (scope.kind === "principal") {
    const principal = normalizeEmail(scope.id);
    const aliases = principal ? all(`SELECT DISTINCT json_extract(event_json, '$.principal_id') AS principal_id FROM usage_events WHERE ${range.where} AND json_type(event_json, '$.principal_id') = 'text'`, range.params).map(row => row.principal_id).filter(id => normalizeEmail(id) === principal) : [];
    owner = principal ? { where: "json_type(event_json, '$.principal_id') = 'text' AND json_extract(event_json, '$.principal_id') IN (SELECT value FROM json_each(?))", params: [JSON.stringify(aliases)] } : { where: "0", params: [] };
  }
  const restrict = (r, o) => ({ where: `${r.where} AND ${o.where}`, params: [...r.params, ...o.params] });
  const eventRange = owner ? restrict(range, owner) : range;
  const events = all(`SELECT event_json FROM usage_events WHERE ${eventRange.where} ORDER BY occurred_at_ms DESC LIMIT ?`, [...eventRange.params, limit]).map(row => JSON.parse(row.event_json));
  const total = "COUNT(*) AS request_count, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros, COALESCE(SUM(CASE WHEN json_extract(event_json, '$.cost_basis') = 'unpriced_usage' THEN 1 ELSE 0 END), 0) AS unpriced_request_count";
  const summary = `${total}, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens`;
  const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()), value]));
  const totals = (r, d) => ({
    summary: camel(all(`SELECT ${summary} FROM usage_events WHERE ${r.where}`, r.params)[0]),
    providers: all(`SELECT provider, ${total} FROM usage_events WHERE ${r.where} GROUP BY provider ORDER BY request_count DESC`, r.params).map(camel),
    daily: all(`SELECT CAST(occurred_at_ms / 86400000 AS INTEGER) * 86400000 AS day_start_ms, ${total} FROM usage_events WHERE ${d.where} GROUP BY CAST(occurred_at_ms / 86400000 AS INTEGER) ORDER BY day_start_ms`, d.params).map(camel),
  });
  const snapshot = { ledger: "durable_object", ...totals(range, dailyRange), events };
  if (owner) snapshot.personal = totals(restrict(range, owner), restrict(dailyRange, owner));
  else {
    const attributed = "json_type(event_json, '$.principal_id') = 'text'";
    snapshot.principals = mergePrincipalUsage(all(`SELECT CASE WHEN ${attributed} THEN json_extract(event_json, '$.principal_id') END AS principal_id, CASE WHEN ${attributed} THEN NULL ELSE json_extract(event_json, '$.credential_id') END AS credential_id, ${summary} FROM usage_events WHERE ${range.where} GROUP BY 1, 2`, range.params).map(({ principal_id, credential_id, ...counts }) => ({
      principalId: principal_id === null ? null : normalizeEmail(principal_id) ?? principal_id,
      credentialId: principal_id === null && typeof credential_id === "string" ? credential_id : null,
      summary: camel(counts),
    })));
  }
  return snapshot;
}
