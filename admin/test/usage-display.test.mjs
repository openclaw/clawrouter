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
let PersonalUsageSummary, MyUsageScreen, UsageScreen, CompleteUsageScreen, ExactRanking;
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
      input: { personal: root + 'src/screens/my-usage.tsx', admin: root + 'src/screens/users-usage.tsx', complete: root + 'src/screens/complete-usage.tsx' },
      output: { entryFileNames: '[name].mjs' },
    } },
  });
  ({ PersonalUsageSummary, MyUsageScreen } = await import(pathToFileURL(output + '/personal.mjs')));
  ({ UsageScreen } = await import(pathToFileURL(output + '/admin.mjs')));
  ({ CompleteUsageScreen, ExactRanking } = await import(pathToFileURL(output + '/complete.mjs')));
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

function completeData(extra={},audience='personal'){
 const v={query:{from:1000,to:2000,timezone:'UTC',grain:'day',groupBy:audience==='admin'?'user':'model',rankBy:'calls',rankOffset:0,filters:{}},cut:'a'.repeat(43),metrics:emptyMetrics,costs:[],recordedChargeMicros:0,chargeReportedCalls:0,groups:[],buckets:[{start:1000,end:2000,label:'idle',metrics:emptyMetrics,costs:[]}],remainder:{metrics:emptyMetrics,costs:[],recordedChargeMicros:0,chargeReportedCalls:0},rank:{offset:0,distinctGroups:0,hasMore:false,exact:true},coverage:{authority:audience==='admin'?'admin_retained':'current_access',scope:audience==='admin'?'admin_current_plus_tracked_retired':'personal_current_access',discoveredScopeEnumeration:'complete',allDiscoveredSourcesAnswered:true,retainedAttributionComplete:true,historicalLocations:'not_exhaustively_assessed',formerLocationLateWrites:'not_bounded',effectiveFrom:1000,clippedFrom:null,capturedBetween:{from:3000,to:3001},captureAudit:{startedAt:500,verifiedSince:500,captureGapObserved:false}},...extra};
 return {audience,report:{value:v,error:'',loading:false},query:v.query,events:{error:'',loading:false},exportState:{busy:false,message:''},page:1,eventsShown:false,reload:noop,refine:noop,back:noop,newRange:noop,preset:noop,showEvents:noop,startExport:noop,cancelExport:noop};
}
function personalData(extra={}){const c=completeData(extra),v=c.report.value;return {...data(report({metrics:v.metrics,costs:v.costs,historyComplete:undefined,discoveredScopeAnswered:v.coverage.allDiscoveredSourcesAnswered,range:{...range,retentionStart:v.coverage.effectiveFrom,clampedStart:v.coverage.clippedFrom!==null}})),complete:c};}
test('new discovered-scope personal zero preserves zero chart values and never promises exhaustive history',()=>{
 const html=renderToStaticMarkup(createElement(MyUsageScreen,{data:personalData()}));
 assert.match(html,/<dt>Total tokens<\/dt><dd>0<\/dd>/);assert.match(html,/<title>idle: 0 tokens<\/title>/);assert.match(html,/For your current access/);assert.match(html,/No calls in discovered locations for this range/);assert.match(html,/Not all historical locations have been assessed/);assert.doesNotMatch(html,/History complete|Gaps: not reported/);assert.match(html,/Export refreshed snapshot/);
});
test('new personal missing fields remain unknown, known zero money remains zero and clipping remains explicit',()=>{
 const m={...emptyMetrics,calls:1,generationCalls:1,successfulCalls:1};
 const value=personalData({metrics:m,costs:[{lane:'api',costClass:'unknown',calls:1,amountMicros:0}],recordedChargeMicros:0,chargeReportedCalls:1});
 const html=renderToStaticMarkup(createElement(PersonalUsageSummary,{data:value}));assert.match(html,/<dt>Total tokens<\/dt><dd>Not reported<\/dd>/);assert.match(apiCard(html),/Unavailable/);assert.match(html,/Recorded accounting amount/);assert.match(html,/\$0\.00/);assert.match(html,/not proof of upstream price or completed budget settlement/);
 value.complete.report.value.coverage={...value.complete.report.value.coverage,effectiveFrom:1500,clippedFrom:1000,captureAudit:{startedAt:1600,verifiedSince:1600,captureGapObserved:true}};value.report.value.range={...range,retentionStart:1500,clampedStart:true};const clipped=renderToStaticMarkup(createElement(MyUsageScreen,{data:value}));assert.match(clipped,/Start clipped/);assert.match(clipped,/predates the verified tracking interval/);assert.match(clipped,/affected usage is unknown/);assert.match(clipped,/Not all historical locations have been assessed/);
});
test('admin zero, missing values, retained identities, exact remainder and stale states are honest in rendered output',()=>{
 const d=completeData({},'admin');let html=renderToStaticMarkup(createElement(CompleteUsageScreen,{data:d}));assert.match(html,/Usage in discovered locations/);assert.match(html,/No calls in discovered locations for this range/);assert.match(html,/Other former locations may contain retained calls/);assert.match(html,/Not all historical locations have been assessed/);assert.match(html,/Recorded accounting amount/);assert.match(html,/Not reported/);
 d.report.value.groups=[{identity:{owner:'retired@example.com',value:'retired-key'},metrics:{...emptyMetrics,calls:3},costs:[],recordedChargeMicros:0,chargeReportedCalls:0}];d.report.value.query.groupBy='key';d.report.value.rank={offset:100,distinctGroups:201,hasMore:true,exact:true};d.report.value.remainder.metrics={...emptyMetrics,calls:7};html=renderToStaticMarkup(createElement(ExactRanking,{data:d}));assert.match(html,/retired@example.com · retired-key/);assert.match(html,/Exact remainder outside this rank page: 7 calls/);assert.match(html,/Previous ranks/);assert.match(html,/Next ranks/);
 d.eventsShown=true;d.events.error='Refresh required (410)';html=renderToStaticMarkup(createElement(CompleteUsageScreen,{data:d}));assert.match(html,/Old displayed report; Refresh required/);assert.match(html,/not a current usable snapshot/);
 for(const error of ['No current access','Outside retained range','Usage capacity unavailable']){const failed={...d,report:{loading:false,error},query:undefined};html=renderToStaticMarkup(createElement(CompleteUsageScreen,{data:failed}));assert.ok(html.includes(error));assert.doesNotMatch(html,/No calls in discovered locations for this range/);}
});
