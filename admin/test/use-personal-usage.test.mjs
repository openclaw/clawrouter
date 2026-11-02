import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { refreshUsageQuery, resolvedUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString } from '../src/personal-usage.ts';
const source = stripTypeScriptTypes(await readFile(new URL('../src/hooks/use-personal-usage.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function usePersonalUsage', 'function usePersonalUsage');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const serverNow = Date.parse('2026-11-02T12:00:00.789Z');
const reportFixture = (extra = {}, from = serverNow - 7 * 86400000, to = serverNow) => ({ range: { from, to, timezone: 'Asia/Kathmandu' }, groupBy: 'model', ...extra });
function mount() {
  const slots = [], effects = [], pending = [], requests = [];
  let cursor = 0, alive = true;
  const props = { active: true, full: true, scope: { origin: 'https://console.example', epoch: 1, session: { tenantId: 'tenant-a', email: 'a@example.com' }, isCurrent: () => alive }, request: (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, signal: init.signal, resolve, reject })) };
  const useState = initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (setup, deps) => { const index = cursor++; const previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: setup() }; }); };
  const useMemo = (create, deps) => { const memo = useRef(); if (!memo.current || deps.some((value, i) => !Object.is(value, memo.current.deps[i]))) memo.current = { deps, value: create() }; return memo.current.value; };
  const useHook = new Function('useState', 'useRef', 'useEffect', 'useMemo', 'refreshUsageQuery', 'resolvedUsageQuery', 'rollingUsageQuery', 'UsageQueryCache', 'usageQueryString', source + '\nreturn usePersonalUsage;')(useState, useRef, useEffect, useMemo, refreshUsageQuery, resolvedUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString);
  return { props, requests, retire: () => { alive = false; for (const effect of effects) effect?.cleanup?.(); }, render: () => { cursor = 0; const result = useHook(props); while (pending.length) pending.shift()(); return result; } };
}
test('report loads first; events are a separate bounded read and pagination keeps report', async () => {
  const fixture = mount(); fixture.render();
  assert.equal(fixture.render().report.loading, true); assert.equal(fixture.requests.length, 1);
  fixture.requests[0].resolve(reportFixture({ metrics: { calls: 42 } })); await flush();
  const report = fixture.render().report.value;
  assert.equal(fixture.requests.length, 2); assert.match(fixture.requests[1].path, /limit=25/);
  fixture.requests[1].resolve({ events: [{ id: 'one' }], nextCursor: 'opaque+cursor', historyComplete: true }); await flush();
  fixture.render().nextPage(); const page2 = fixture.render();
  assert.equal(page2.report.value, report); assert.equal(page2.page, 2);
  assert.equal(fixture.render().events.loading, true); assert.match(fixture.requests[2].path, /cursor=opaque%2Bcursor/);
  fixture.retire(); assert.equal(fixture.requests[2].signal.aborted, true);
});
test('query changes abort report and never flash prior data; late results cannot win', async () => {
  const fixture = mount(); const hook = fixture.render();
  hook.setQuery({ ...hook.query, filters: { ...hook.query.filters, model: 'second' } });
  assert.equal(fixture.render().report.value, undefined); assert.equal(fixture.requests[0].signal.aborted, true);
  fixture.requests[1].resolve(reportFixture({ marker: 'new' })); await flush();
  fixture.requests[0].resolve(reportFixture({ marker: 'old' })); await flush();
  assert.equal(fixture.render().report.value.marker, 'new'); fixture.retire();
});
test('event query changes abort and clear the old page, even on a cached report', async () => {
  const fixture = mount(); let hook = fixture.render();
  fixture.requests[0].resolve(reportFixture({ marker: 'first' })); await flush(); hook = fixture.render();
  const oldEvents = fixture.requests[1]; hook.setQuery({ ...hook.query, groupBy: 'provider' }); fixture.render();
  assert.equal(oldEvents.signal.aborted, true); assert.equal(fixture.render().events.value, undefined);
  oldEvents.resolve({ events: [{ id: 'late' }] }); await flush();
  assert.equal(fixture.render().events.value, undefined); fixture.retire();
});
test('navigation cancels pending reads; returning uses fresh per-lifetime report cache', async () => {
  const fixture = mount(); fixture.render(); fixture.requests[0].resolve(reportFixture({ marker: 'cached' })); await flush(); fixture.render();
  fixture.props.active = false; fixture.props.full = false; fixture.render(); assert.equal(fixture.requests[1].signal.aborted, true);
  fixture.props.active = true; fixture.render(); assert.equal(fixture.requests.length, 2); assert.equal(fixture.render().report.value.marker, 'cached');
  fixture.retire(); const nextOwner = mount(); nextOwner.render(); assert.equal(nextOwner.render().report.value, undefined); nextOwner.retire();
});
for (const outcome of ['resolve', 'reject']) test('retired scope suppresses late ' + outcome + ' and errors recover without stale data', async () => {
  const fixture = mount(); fixture.render(); fixture.retire();
  fixture.requests[0][outcome](outcome === 'resolve' ? { marker: 'retired' } : new Error('retired failure')); await flush();
  assert.equal(fixture.render().report.value, undefined); assert.equal(fixture.render().report.error, '');
  const current = mount(); current.render(); current.requests[0].reject(new Error('offline')); await flush();
  let hook = current.render(); assert.equal(hook.report.error, 'offline'); hook.reload(); current.render();
  current.requests[1].resolve(reportFixture({ marker: 'recovered' })); await flush(); assert.equal(current.render().report.value.marker, 'recovered'); current.retire();
});


test('refresh keeps explicit server-time presets and pinned custom ranges', () => {
  const first = rollingUsageQuery(7);
  const next = refreshUsageQuery({ ...first, from: 'server-start', to: 'server-end', filters: { ...first.filters, model: 'chosen' } });
  const params = new URLSearchParams(usageQueryString(next));
  assert.equal(params.get('days'), '7'); assert.equal(params.has('from'), false); assert.equal(params.has('to'), false);
  assert.equal(next.filters.model, 'chosen');
  assert.equal(new URLSearchParams(usageQueryString(next)).has('rollingDays'), false);
  const custom = { ...first, from: '2026-10-28', to: '2026-10-29', rollingDays: undefined };
  assert.equal(refreshUsageQuery(custom), custom);
});
test('home refresh timer retires on navigation and never moves an open detail view', t => {
  let callback, retired = 0;
  t.mock.method(globalThis, 'setInterval', fn => { callback = fn; return 123; });
  t.mock.method(globalThis, 'clearInterval', timer => { assert.equal(timer, 123); retired++; });
  const fixture = mount(); fixture.render(); assert.equal(callback, undefined, 'full report stays pinned');
  fixture.props.full = false; let state = fixture.render(); assert.ok(callback);
  t.mock.method(Date, 'now', () => serverNow + 60000);
  callback(); state = fixture.render();
  assert.equal(fixture.requests.length, 2);
  const params = new URL(fixture.requests[1].path, fixture.props.scope.origin).searchParams;
  assert.equal(params.get('days'), '7'); assert.equal(params.has('from'), false); assert.equal(params.has('to'), false);
  fixture.props.active = false; fixture.render(); assert.ok(retired >= 1);
  fixture.retire();
});

for (const offset of [-60_000, 60_000]) test('actual hook uses server preset clock with browser offset ' + offset + ' and pins every event page/retry', async t => {
  let browserNow = serverNow + offset;
  t.mock.method(Date, 'now', () => browserNow);
  const fixture = mount(); let hook = fixture.render();
  const query = { ...hook.query, rollingDays: 30, timezone: 'Asia/Kathmandu', groupBy: 'key', filters: { model: 'model + custom', provider: 'openai', key: 'studio', status: 'error', costClass: 'unknown', lane: 'api' } };
  hook.setQuery(query); fixture.render();
  const read = fixture.requests.at(-1), params = new URL(read.path, fixture.props.scope.origin).searchParams;
  assert.equal(params.get('days'), '30'); assert.equal(params.has('from'), false); assert.equal(params.has('to'), false);
  const response = reportFixture({ groupBy: 'key' }, serverNow - 30 * 86400000);
  read.resolve(response); await flush(); hook = fixture.render();
  assert.equal(hook.query.from, new Date(response.range.from).toISOString()); assert.equal(hook.query.to, new Date(serverNow).toISOString());
  assert.equal(hook.query.rollingDays, 30);
  const expected = new URLSearchParams(usageQueryString({ ...query, from: hook.query.from, to: hook.query.to, rollingDays: undefined })); expected.set('limit', '25');
  assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.toString(), expected.toString());
  fixture.requests.at(-1).resolve({ events: [], nextCursor: 'stable-anchor', historyComplete: true }); await flush();
  browserNow += 5 * 60000; hook = fixture.render(); hook.nextPage(); hook = fixture.render();
  expected.set('cursor', 'stable-anchor');
  assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.toString(), expected.toString());
  fixture.requests.at(-1).reject(new Error('temporary')); await flush();
  fixture.render().retryEvents(); fixture.render();
  assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.toString(), expected.toString());
  fixture.requests.at(-1).resolve({ events: [], nextCursor: null, historyComplete: true }); await flush();
  fixture.render().reload(); hook = fixture.render();
  assert.equal(hook.page, 1);
  const refreshed = new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams;
  assert.equal(refreshed.get('days'), '30'); assert.equal(refreshed.has('from'), false); assert.equal(refreshed.has('to'), false);
  fixture.requests.at(-1).resolve(reportFixture({ groupBy: 'key' }, serverNow + 60000 - 30 * 86400000, serverNow + 60000)); await flush(); hook = fixture.render();
  assert.equal(hook.query.to, new Date(serverNow + 60000).toISOString());
  assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.get('to'), hook.query.to);
  fixture.retire();
});
test('custom hook refresh remains pinned; canonical display fields cause no report refetch loop', async () => {
  const fixture = mount(); let hook = fixture.render();
  const query = { ...hook.query, rollingDays: undefined, from: '2026-10-28', to: '2026-10-29', timezone: 'UTC' };
  hook.setQuery(query); fixture.render();
  const response = reportFixture({}, Date.parse('2026-10-28T00:00:00Z'), Date.parse('2026-10-29T00:00:00Z')); response.range.timezone = 'UTC';
  fixture.requests.at(-1).resolve(response); await flush(); hook = fixture.render();
  assert.equal(hook.query.from, '2026-10-28T00:00:00.000Z'); assert.equal(hook.query.rollingDays, undefined);
  const count = fixture.requests.length; for (let index = 0; index < 5; index++) fixture.render();
  assert.equal(fixture.requests.length, count);
  hook.reload(); fixture.render();
  const params = new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams;
  assert.equal(params.get('from'), query.from); assert.equal(params.get('to'), query.to); assert.equal(params.has('days'), false);
  fixture.retire();
});
test('selecting the same rolling preset still resolves a fresh server anchor instead of reusing its cache', async () => {
  const fixture = mount(); fixture.props.full = false; fixture.render();
  fixture.requests[0].resolve(reportFixture()); await flush();
  const hook = fixture.render(); hook.setQuery({ ...hook.query, rollingDays: 7 }); fixture.render();
  assert.equal(fixture.requests.length, 2);
  const params = new URL(fixture.requests[1].path, fixture.props.scope.origin).searchParams;
  assert.equal(params.get('days'), '7'); assert.equal(params.has('from'), false); assert.equal(params.has('to'), false);
  fixture.retire();
});
