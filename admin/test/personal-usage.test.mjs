import assert from 'node:assert/strict';
import test from 'node:test';
import { costCell, csvCell, csvRows, eventsCsv, reportCsv, rollingUsageQuery, UsageQueryCache, usageGroupLabel, usageKeyLabel, usageQueryString } from '../src/personal-usage.ts';

test('rolling ranges preserve exact instants and exact filters are URL encoded', () => {
  const now = Date.parse('2026-11-02T12:34:56.789Z');
  const query = rollingUsageQuery(7, now);
  assert.equal(query.from, '2026-10-26T12:34:56.789Z');
  assert.equal(query.to, '2026-11-02T12:34:56.789Z');
  assert.equal(Date.parse(rollingUsageQuery(30, now).to) - Date.parse(rollingUsageQuery(30, now).from), 30 * 86400000);
  query.filters.model = 'provider/model + custom'; query.filters.key = '=key';
  const params = new URLSearchParams(usageQueryString(query));
  assert.equal(params.get('model'), query.filters.model); assert.equal(params.get('key'), '=key');
  assert.equal(params.has('provider'), false);
  query.from = '2026-10-31'; query.to = '2026-11-02'; query.timezone = 'America/New_York';
  assert.equal(new URLSearchParams(usageQueryString(query)).get('from'), '2026-10-31');
});
test('cost presentation never sums price quality or billing lanes and unknown is never zero', () => {
  const costs = [{ lane: 'api', costClass: 'calculated', amountMicros: 1_000_000, calls: 1 }, { lane: 'api', costClass: 'fixed', amountMicros: 500_000, calls: 2 }, { lane: 'api', costClass: 'estimated', amountMicros: 9_000_000, calls: 1 }, { lane: 'subscription', costClass: 'calculated', amountMicros: 4_000_000, calls: 1 }, { lane: 'unattributed', costClass: 'unknown', amountMicros: 0, calls: 3 }, { lane: 'api', costClass: 'no_charge', amountMicros: 0, calls: 1 }];
  assert.equal(costCell(costs, 'api', ['calculated', 'fixed']), '$1.50 · 3 calls');
  assert.equal(costCell(costs, 'subscription', ['calculated', 'fixed']), '$4.00 · 1 calls');
  assert.equal(costCell(costs, 'unattributed', ['unknown']), '3 calls · price unknown');
  assert.equal(costCell(costs, 'api', ['no_charge']), '1 calls · no charge');
  assert.equal(costCell(costs, 'subscription', ['estimated']), '—');
});
test('CSV quoting neutralizes formulas including whitespace, tabs, CR and embedded quotes', () => {
  for (const value of ['=SUM(1)', '+SUM(1)', '-1', '@formula', '  =formula', '\tformula', '\rformula', '\nformula', '\u0001=evil']) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('model,"safe"'), '"model,""safe"""');
  assert.equal(csvRows([['a', 'b'], ['c', null]]), '"a","b"\r\n"c",""');
});
test('bounded report export includes coverage/completeness and unknown amount stays blank', () => {
  const metrics = { calls: 1, inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, cacheWriteInputTokens: 0, reasoningOutputTokens: 1, inputReportedCalls: 1, outputReportedCalls: 1, cacheReadReportedCalls: 1, cacheWriteReportedCalls: 0, reasoningReportedCalls: 1 };
  const report = { range: { from: 0, to: 1, timezone: 'UTC' }, groupBy: 'model', groups: [{ value: '=formula', metrics, costs: [{ lane: 'api', costClass: 'unknown', calls: 1, amountMicros: 0 }] }], historyComplete: false, groupsTruncated: true };
  const csv = reportCsv(report);
  assert.match(csv, /input_reported_calls/); assert.match(csv, /"'=formula"/);
  const [row] = parseCsvRecords(csv);
  assert.equal(row.api_unknown_calls, '1');
  assert.equal(row.api_unknown_reporting_amount_usd, '');
  assert.equal(row.api_calculated_reporting_amount_usd, '');
  assert.equal(row.history_complete, 'false');
  assert.equal(row.groups_truncated, 'true');
  const events = eventsCsv([{ id: '+unsafe', costClass: 'unknown', reportingCostMicros: 0 }]);
  assert.match(events, /"'\+unsafe"/); assert.doesNotMatch(events.split('\r\n')[1], /"0"/);
});
test('query cache is 15s fresh, LRU bounded to eight, clearable and instance-local', () => {
  const cache = new UsageQueryCache();
  cache.set('old', 1, 0); assert.equal(cache.get('old', 14999), 1); assert.equal(cache.get('old', 15000), undefined);
  for (let index = 0; index < 8; index++) cache.set(String(index), index, 20000);
  cache.get('0', 20001); cache.set('8', 8, 20001);
  assert.equal(cache.get('1', 20001), undefined); assert.equal(cache.get('0', 20001), 0);
  assert.equal(new UsageQueryCache().get('0', 20001), undefined);
  cache.clear(); assert.equal(cache.get('0', 20001), undefined);
});

test('event CSV keeps reporting-only estimates and recorded budget charges in separate columns', () => {
  const csv = eventsCsv([{ id: 'estimated', costClass: 'estimated', reportingCostMicros: 18000, recordedChargeMicros: 0, costBasis: 'token_pricing', estimateReason: 'max_declared_rate', pricingRef: 'fixture' }]);
  assert.match(csv.split('\r\n')[0], /"reportingCostMicros","recordedChargeMicros","costBasis","estimateReason"/);
  assert.match(csv.split('\r\n')[1], /"18000","0","token_pricing","max_declared_rate"/);
});

test('null credential groups identify Dashboard session without inventing a policy or key ID', () => {
  assert.equal(usageGroupLabel('key', null), 'Dashboard session');
  assert.equal(usageGroupLabel('key', 'actual-credential-id'), 'actual-credential-id');
  assert.equal(usageGroupLabel('model', null), 'Unattributed');
  const report = { range: { from: 0, to: 1, timezone: 'UTC' }, groupBy: 'key', groups: [{ value: null, metrics: { calls: 1 }, costs: [] }], historyComplete: true, groupsTruncated: false };
  assert.match(reportCsv(report), /"key","Dashboard session","1"/);
  assert.equal(parseCsvRecords(reportCsv(report))[0].group, 'Dashboard session');
});

test('available personal key names include the real ID and missing metadata never becomes a policy label', () => {
  const keys = [{ credentialId: 'key-a', name: 'Studio' }, { credentialId: 'key-b', name: 'Studio' }, { credentialId: 'key-empty', name: '  ' }];
  assert.equal(usageKeyLabel('key-a', keys), 'Studio · key-a');
  assert.equal(usageKeyLabel('key-b', keys), 'Studio · key-b');
  assert.equal(usageKeyLabel('removed-key', keys), 'removed-key');
  assert.equal(usageKeyLabel('key-empty', keys), 'key-empty');
  assert.equal(usageKeyLabel(null, keys), 'Dashboard session');
});

// Parse the emitted RFC4180 quoting, including embedded commas, quotes and newlines.
function parseCsvRecords(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { field += '"'; index++; }
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ',') { row.push(field); field = ''; }
    else if (!quoted && character === '\r' && text[index + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; index++; }
    else field += character;
  }
  if (row.length || field.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.map(values => Object.fromEntries(header.map((key, index) => [key, values[index]])));
}
function csvReportFixture(groups) {
  return { range: { from: 0, to: 1, timezone: 'UTC' }, groupBy: 'model', groups, historyComplete: false, groupsTruncated: true };
}
function csvMetricFixture(calls, inputTokens) {
  return { calls, inputTokens, outputTokens: calls * 3, cachedInputTokens: calls, cacheWriteInputTokens: calls, reasoningOutputTokens: calls, inputReportedCalls: calls, outputReportedCalls: calls, cacheReadReportedCalls: calls, cacheWriteReportedCalls: calls, reasoningReportedCalls: calls };
}
test('one CSV row per group keeps summed calls, input and coverage additive across every lane and quality', () => {
  const groups = [
    { value: '=first, "quoted"', metrics: csvMetricFixture(4, 100), costs: [
      { lane: 'api', costClass: 'calculated', calls: 1, amountMicros: 100_000 },
      { lane: 'api', costClass: 'fixed', calls: 1, amountMicros: 20_000 },
      { lane: 'subscription', costClass: 'estimated', calls: 1, amountMicros: 300_000 },
      { lane: 'unattributed', costClass: 'unknown', calls: 1, amountMicros: 0 },
    ] },
    { value: 'second\nline', metrics: csvMetricFixture(2, 70), costs: [{ lane: 'api', costClass: 'no_charge', calls: 2, amountMicros: 0 }] },
    { value: null, metrics: csvMetricFixture(1, 10), costs: [] },
  ];
  const csv = reportCsv(csvReportFixture(groups)), rows = parseCsvRecords(csv);
  assert.equal(rows.length, groups.length);
  assert.equal(rows[0].group, '\'=first, "quoted"');
  assert.equal(rows[1].group, 'second\nline');
  for (const [column, metric] of [['model_calls', 'calls'], ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['input_reported_calls', 'inputReportedCalls'], ['cache_read_tokens', 'cachedInputTokens']]) {
    assert.equal(rows.filter(row => row[column] !== '').reduce((sum, row) => sum + Number(row[column]), 0), groups.reduce((sum, group) => sum + group.metrics[metric], 0), column + ' must appear exactly once per group');
  }
  const callsColumns = Object.keys(rows[0]).filter(key => /^(api|subscription|unattributed)_.+_calls$/.test(key));
  assert.equal(callsColumns.length, 21);
  assert.equal(rows[0].api_calculated_reporting_amount_usd, '0.1');
  assert.equal(rows[0].api_fixed_reporting_amount_usd, '0.02');
  assert.equal(rows[0].subscription_estimated_reporting_amount_usd, '0.3');
  assert.equal(rows[0].unattributed_unknown_calls, '1');
  assert.equal(rows[0].unattributed_unknown_reporting_amount_usd, '');
  assert.equal(rows[1].api_no_charge_reporting_amount_usd, '0');
  assert.equal(rows[2].api_calculated_reporting_amount_usd, '');
  assert.equal(rows[2].api_calculated_calls, '0');
  assert.doesNotMatch(csv.split('\r\n')[0], /grand_total|total_cost/);
});
test('CSV allowlists exclude added scope, identity, content and secret fields', () => {
  const extras = { scope: 'scope-marker-must-not-export', tenantId: 'tenant-marker-must-not-export', email: 'email-marker-must-not-export', secret: 'secret-marker-must-not-export', prompt: 'content-marker-must-not-export' };
  const report = { ...csvReportFixture([{ value: 'model-a', metrics: csvMetricFixture(1, 2), costs: [], ...extras }]), ...extras };
  const event = { id: 'event-a', costClass: 'estimated', reportingCostMicros: 10, recordedChargeMicros: 5, estimateReason: 'max_declared_rate', ...extras };
  for (const csv of [reportCsv(report), eventsCsv([event])]) for (const marker of Object.values(extras)) assert.ok(!csv.includes(marker), marker);
});
