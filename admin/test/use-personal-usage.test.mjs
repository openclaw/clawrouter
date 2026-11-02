import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { refreshUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString } from '../src/personal-usage.ts';
const source = stripTypeScriptTypes(await readFile(new URL('../src/hooks/use-personal-usage.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function usePersonalUsage', 'function usePersonalUsage');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function mount() {
  const slots = [], effects = [], pending = [], requests = [];
  let cursor = 0, alive = true;
  const props = { active: true, full: true, scope: { origin: 'https://console.example', epoch: 1, session: { tenantId: 'tenant-a', email: 'a@example.com' }, isCurrent: () => alive }, request: (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, signal: init.signal, resolve, reject })) };
  const useState = initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (setup, deps) => { const index = cursor++; const previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: setup() }; }); };
  const useHook = new Function('useState', 'useRef', 'useEffect', 'refreshUsageQuery', 'rollingUsageQuery', 'UsageQueryCache', 'usageQueryString', source + '\nreturn usePersonalUsage;')(useState, useRef, useEffect, refreshUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString);
  return { props, requests, retire: () => { alive = false; for (const effect of effects) effect?.cleanup?.(); }, render: () => { cursor = 0; const result = useHook(props); while (pending.length) pending.shift()(); return result; } };
}
test('report loads first; events are a separate bounded read and pagination keeps report', async () => {
  const fixture = mount(); fixture.render();
  assert.equal(fixture.render().report.loading, true); assert.equal(fixture.requests.length, 1);
  fixture.requests[0].resolve({ metrics: { calls: 42 } }); await flush();
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
  fixture.requests[1].resolve({ marker: 'new' }); await flush();
  fixture.requests[0].resolve({ marker: 'old' }); await flush();
  assert.equal(fixture.render().report.value.marker, 'new'); fixture.retire();
});
test('event query changes abort and clear the old page, even on a cached report', async () => {
  const fixture = mount(); let hook = fixture.render();
  fixture.requests[0].resolve({ marker: 'first' }); await flush(); hook = fixture.render();
  const oldEvents = fixture.requests[1]; hook.setQuery({ ...hook.query, groupBy: 'provider' }); fixture.render();
  assert.equal(oldEvents.signal.aborted, true); assert.equal(fixture.render().events.value, undefined);
  oldEvents.resolve({ events: [{ id: 'late' }] }); await flush();
  assert.equal(fixture.render().events.value, undefined); fixture.retire();
});
test('navigation cancels pending reads; returning uses fresh per-lifetime report cache', async () => {
  const fixture = mount(); fixture.render(); fixture.requests[0].resolve({ marker: 'cached' }); await flush(); fixture.render();
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
  current.requests[1].resolve({ marker: 'recovered' }); await flush(); assert.equal(current.render().report.value.marker, 'recovered'); current.retire();
});


test('refresh advances explicit rolling presets and preserves pinned custom ranges', () => {
  const first = rollingUsageQuery(7, Date.parse('2026-11-01T12:00:00Z'));
  const next = refreshUsageQuery({ ...first, filters: { ...first.filters, model: 'chosen' } }, Date.parse('2026-11-02T12:00:00Z'));
  assert.equal(next.to, '2026-11-02T12:00:00.000Z');
  assert.equal(Date.parse(next.to) - Date.parse(next.from), 7 * 86400000);
  assert.equal(next.filters.model, 'chosen');
  assert.equal(new URLSearchParams(usageQueryString(next)).has('rollingDays'), false);
  const custom = { ...first, rollingDays: undefined };
  assert.equal(refreshUsageQuery(custom, Date.parse('2026-11-02T12:00:00Z')), custom);
});
test('home refresh timer retires on navigation and never moves an open detail view', t => {
  let callback, retired = 0;
  t.mock.method(globalThis, 'setInterval', fn => { callback = fn; return 123; });
  t.mock.method(globalThis, 'clearInterval', timer => { assert.equal(timer, 123); retired++; });
  const fixture = mount(); fixture.render(); assert.equal(callback, undefined, 'full report stays pinned');
  fixture.props.full = false; let state = fixture.render(); assert.ok(callback);
  const oldEnd = Date.parse(state.query.to);
  t.mock.method(Date, 'now', () => oldEnd + 31000);
  callback(); state = fixture.render();
  assert.equal(Date.parse(state.query.to), oldEnd + 31000);
  fixture.props.active = false; fixture.render(); assert.ok(retired >= 1);
  fixture.retire();
});
