import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUsageReportRange, reportDayMs } from '../usage-report-range.ts';

const serverNow = Date.parse('2026-11-02T12:34:56.789Z');
for (const days of [7, 30]) test('rolling ' + days + ' days resolves against the Worker Date.now clock on every read', t => {
  let now = serverNow;
  t.mock.method(Date, 'now', () => now);
  const params = new URLSearchParams({ days: String(days), timezone: 'Asia/Kathmandu' });
  const first = parseUsageReportRange(params);
  assert.equal(first.to, serverNow); assert.equal(first.from, serverNow - days * reportDayMs);
  assert.equal(first.clampedStart, false);
  now += 60_000;
  const refreshed = parseUsageReportRange(params);
  assert.equal(refreshed.to, now); assert.equal(refreshed.from, now - days * reportDayMs);
  assert.equal(refreshed.timezone, 'Asia/Kathmandu');
});
test('presets reject unsupported values and any custom-boundary mixing with 400', () => {
  for (const data of [{ days: '' }, { days: '1' }, { days: '07' }, { days: '7.0' }, { days: '31' }, { days: '7', from: '' }, { days: '30', to: '' }, { days: '7', from: '2026-11-01' }, { days: '7', to: new Date(serverNow).toISOString() }]) {
    assert.throws(() => parseUsageReportRange(new URLSearchParams(data), serverNow), error => error.status === 400 && error.code === 'invalid_usage_range');
  }
});
test('custom future instants stay strict 400; custom historical ranges remain pinned on refresh', t => {
  let now = serverNow; t.mock.method(Date, 'now', () => now);
  for (const ahead of [1, 60_000]) {
    const params = new URLSearchParams({ from: '2026-11-01T00:00:00Z', to: new Date(serverNow + ahead).toISOString() });
    assert.throws(() => parseUsageReportRange(params), error => error.status === 400 && /future/.test(error.message));
  }
  const custom = new URLSearchParams({ from: '2026-10-28', to: '2026-10-29', timezone: 'America/New_York' });
  const first = parseUsageReportRange(custom); now += 60_000;
  const refreshed = parseUsageReportRange(custom);
  assert.equal(refreshed.from, first.from); assert.equal(refreshed.to, first.to);
});
