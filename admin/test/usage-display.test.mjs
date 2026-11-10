import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';

// Compile the real screens; only the unrelated console request boundary is inert.
// This is server-rendered output coverage, not browser or interaction proof.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await mkdtemp(root + 'test/.usage-display-');
let PersonalUsageSummary, MyUsageScreen, UsageScreen;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => 'light' } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} }, querySelector: () => null } });
  await build({
    root, configFile: false, publicDir: false, logLevel: 'error',
    plugins: [{
      name: 'no-console-requests', enforce: 'pre',
      resolveId(id) { if (id === '../console-controller-context') return '\0test-console'; },
      load(id) { if (id === '\0test-console') return 'export function useConsole() { return { request() { throw new Error("Unexpected console request"); } }; }'; },
    }],
    build: { ssr: true, outDir: output, minify: false, rollupOptions: {
      input: { personal: root + 'src/screens/my-usage.tsx', admin: root + 'src/screens/users-usage.tsx' },
      output: { entryFileNames: '[name].mjs' },
    } },
  });
  ({ PersonalUsageSummary, MyUsageScreen } = await import(pathToFileURL(output + '/personal.mjs')));
  ({ UsageScreen } = await import(pathToFileURL(output + '/admin.mjs')));
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else delete globalThis.window;
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
  else delete globalThis.document;
  await rm(output, { recursive: true, force: true });
}
const emptyMetrics = { calls: 0, generationCalls: 0, utilityCalls: 0, successfulCalls: 0, errorCalls: 0, deniedCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, inputReportedCalls: 0, outputReportedCalls: 0, cacheReadReportedCalls: 0, cacheWriteReportedCalls: 0, reasoningReportedCalls: 0 };
const range = { from: 1000, to: 2000, timezone: 'UTC', retentionStart: 500, clampedStart: false };
const report = (extra = {}) => ({ range, metrics: emptyMetrics, costs: [], groupBy: 'model', groups: [], buckets: [{ start: 1000, end: 2000, label: 'idle', metrics: emptyMetrics, costs: [] }], historyComplete: true, groupsTruncated: false, generatedAt: 2000, ...extra });
const noop = () => {};
const data = value => ({ report: { value, loading: false, error: '' }, query: { rollingDays: 7, from: '', to: '', timezone: 'UTC', groupBy: 'model', filters: {} }, reload: noop, setQuery: noop, showEvents: noop, events: { loading: false, error: '' }, page: 1 });
const summary = value => renderToStaticMarkup(createElement(PersonalUsageSummary, { data: data(value) }));
const apiCard = html => html.match(/<dt>Known API cost<\/dt>([\s\S]*?)<dt>Model calls<\/dt>/)?.[1];

test('complete idle summary and chart render zero tokens without a missing-data warning', () => {
  const html = renderToStaticMarkup(createElement(MyUsageScreen, { data: data(report()) }));
  assert.ok(html.includes('<dt>Total tokens</dt><dd>0</dd>'), 'complete idle tokens render as zero');
  assert.match(html, /0 input · 0 output/);
  assert.match(html, /<title>idle: 0 tokens<\/title>/);
  assert.doesNotMatch(html, /Gaps: not reported|No reported values/);
  assert.match(apiCard(html), />No API calls<\/dd>/);
  assert.doesNotMatch(apiCard(html), /Unavailable|attention|\$0\.00/);
});

test('subscription-only calls are not unavailable or a zero-dollar API invoice', () => {
  const html = summary(report({ metrics: { ...emptyMetrics, calls: 2, successfulCalls: 2 }, costs: [{ lane: 'subscription', costClass: 'calculated', calls: 2, amountMicros: 3000000 }] }));
  assert.match(apiCard(html), />No API calls<\/dd>/);
  assert.doesNotMatch(apiCard(html), /Unavailable|attention|\$0\.00/);
  assert.match(html, /<dt>Subscription equivalent<\/dt><dd[^>]*>\$3\.00<\/dd>/);
  assert.match(html, /<dt>Total tokens<\/dt><dd>Not reported<\/dd>/, 'positive calls without token reports remain unknown');
});

test('incomplete, clipped, outside-retention and missing price coverage do not invent emptiness', () => {
  for (const value of [
    report({ historyComplete: false }),
    report({ historyComplete: undefined }),
    report({ range: { ...range, clampedStart: true } }),
    report({ range: { ...range, retentionStart: 1500 } }),
    report({ metrics: { ...emptyMetrics, calls: 1 } }),
    report({ metrics: { ...emptyMetrics, calls: 2 }, costs: [{ lane: 'subscription', costClass: 'fixed', calls: 1, amountMicros: 1 }] }),
    report({ metrics: { ...emptyMetrics, calls: 1 }, costs: [{ lane: 'unattributed', costClass: 'fixed', calls: 1, amountMicros: 1 }] }),
    report({ metrics: { ...emptyMetrics, calls: 1 }, costs: [{ costClass: 'fixed', calls: 1, amountMicros: 1 }] }),
  ]) {
    const html = summary(value);
    assert.match(html, /<dt>Total tokens<\/dt><dd>Not reported<\/dd>/);
    assert.match(apiCard(html), />Unavailable<\/dd>/);
    assert.doesNotMatch(apiCard(html), /No API calls|\$0\.00/);
  }
});

test('known no-charge API calls remain money zero; unknown API prices remain unavailable', () => {
  for (const [costClass, expected] of [['no_charge', '$0.00'], ['unknown', 'Unavailable']]) {
    const html = summary(report({ metrics: { ...emptyMetrics, calls: 1 }, costs: [{ lane: 'api', costClass, calls: 1, amountMicros: 0 }] }));
    assert.ok(apiCard(html).includes('>' + expected + '</dd>'));
    assert.doesNotMatch(apiCard(html), /No API calls/);
  }
});

test('personal rendered success captions distinguish near-extremes from none and all', () => {
  for (const [successfulCalls, expected] of [[9999, '&gt;99.9%'], [1, '&lt;0.1%'], [0, '0%'], [10000, '100%']]) {
    assert.ok(summary(report({ metrics: { ...emptyMetrics, calls: 10000, successfulCalls } })).includes(expected + ' successful'));
  }
});

test('admin rendered success rate also distinguishes near-extremes from none and all', () => {
  for (const [successCount, expected] of [[9999, '&gt;99%'], [1, '&lt;1%'], [0, '0%'], [10000, '100%']]) {
    const usage = { summary: { requestCount: 10000, successCount, errorCount: 10000 - successCount, totalTokens: 0, actualCostMicros: 0, unpricedRequestCount: 0 }, providers: [], events: [], daily: [], ledger: 'ready' };
    const html = renderToStaticMarkup(createElement(UsageScreen, { keys: [], credentials: [], services: [], overview: null, tenants: [], usageRows: [], usage, usageLoaded: true, usageStale: false, usageError: '', usageUpdatedAt: null }));
    assert.ok(html.includes('<span>success rate</span><strong>' + expected + '</strong>'), 'successCount=' + successCount);
  }
});
