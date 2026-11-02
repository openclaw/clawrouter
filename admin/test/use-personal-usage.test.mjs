import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { cursorUsageFixture } from './helpers/personal-usage-cursor.mjs';
import { refreshUsageQuery, resolvedUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString } from '../src/personal-usage.ts';
const source = stripTypeScriptTypes(await readFile(new URL('../src/hooks/use-personal-usage.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function usePersonalUsage', 'function usePersonalUsage');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const serverNow = Date.parse('2026-11-02T12:00:00.789Z');
const reportFixture = (extra = {}, from = serverNow - 7 * 86400000, to = serverNow) => ({ range: { from, to, timezone: 'Asia/Kathmandu' }, groupBy: 'model', ...extra });
function mount({ events = true } = {}) {
  const slots = [], effects = [], pending = [], requests = [];
  let cursor = 0, alive = true;
  const props = { active: true, full: true, scope: { origin: 'https://console.example', epoch: 1, session: { tenantId: 'tenant-a', email: 'a@example.com' }, isCurrent: () => alive }, request: (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, signal: init.signal, resolve, reject })) };
  const useState = initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (setup, deps) => { const index = cursor++; const previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: setup() }; }); };
  const useMemo = (create, deps) => { const memo = useRef(); if (!memo.current || deps.some((value, i) => !Object.is(value, memo.current.deps[i]))) memo.current = { deps, value: create() }; return memo.current.value; };
  const useHook = new Function('useState', 'useRef', 'useEffect', 'useMemo', 'refreshUsageQuery', 'resolvedUsageQuery', 'rollingUsageQuery', 'UsageQueryCache', 'usageQueryString', source + '\nreturn usePersonalUsage;')(useState, useRef, useEffect, useMemo, refreshUsageQuery, resolvedUsageQuery, rollingUsageQuery, UsageQueryCache, usageQueryString);
  return { props, requests, retire: () => { alive = false; for (const effect of effects) effect?.cleanup?.(); }, render: () => { cursor = 0; const result = useHook(props); while (pending.length) pending.shift()(); if (events) result.showEvents(true); return result; } };
}
test('event pages load only while a view requests them, then stop', async () => {
  const fixture = mount({ events: false }); fixture.render();
  fixture.requests[0].resolve(reportFixture({ metrics: { calls: 3 } })); await flush();
  let hook = fixture.render(); fixture.render();
  assert.equal(fixture.requests.length, 1, 'no events read for the overview');
  assert.equal(hook.events.loading, false);
  hook.showEvents(true); fixture.render(); hook = fixture.render();
  assert.equal(fixture.requests.length, 2); assert.match(fixture.requests[1].path, /^\/v1\/session\/usage\/events\?/);
  assert.equal(hook.events.loading, true);
  hook.showEvents(false); fixture.render();
  assert.equal(fixture.requests[1].signal.aborted, true);
  fixture.retire();
});
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
test('custom hook refresh and controls remain pinned; resolved fields cause no report refetch loop', async () => {
  const fixture = mount(); let hook = fixture.render();
  const query = { ...hook.query, rollingDays: undefined, from: '2026-10-28', to: '2026-10-29', timezone: 'UTC' };
  hook.setQuery(query); fixture.render();
  const response = reportFixture({}, Date.parse('2026-10-28T00:00:00Z'), Date.parse('2026-10-29T00:00:00Z')); response.range.timezone = 'UTC';
  fixture.requests.at(-1).resolve(response); await flush(); hook = fixture.render();
  assert.equal(hook.query.from, query.from); assert.equal(hook.query.rollingDays, undefined);
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

async function cursorPageTwo(t, custom = false) {
  let now = serverNow;
  t.mock.method(Date, 'now', () => now);
  const server = cursorUsageFixture(now); t.after(() => server.close());
  const fixture = mount(); t.after(() => fixture.retire());
  fixture.props.scope.session = { tenantId: 'tenant', email: 'member@example.com' };
  const initial = fixture.render();
  if (custom) { initial.setQuery({ ...initial.query, rollingDays: undefined, from: new Date(serverNow - 2 * 3600000).toISOString(), to: new Date(serverNow).toISOString() }); fixture.render(); }
  const answer = async request => {
    const value = await server.read(request.path, now, { principal: fixture.props.scope.session.email, policies: [{ tenantId: fixture.props.scope.session.tenantId, policyId: 'policy' }] });
    request.resolve(value); await flush(); return value;
  };
  await answer(fixture.requests.at(-1)); fixture.render();
  const first = await answer(fixture.requests.at(-1));
  assert.equal(first.events.length, 25);
  fixture.render().nextPage(); fixture.render();
  const second = await answer(fixture.requests.at(-1));
  assert.equal(second.events.length, 17); assert.equal(second.nextCursor, null);
  assert.equal(fixture.render().page, 2);
  return { fixture, server, answer, advance: ms => { now += ms; } };
}

test('expired rolling cache accepts a new anchor with no transient old cursor or previous-page stack', async t => {
  const { fixture, server, answer, advance } = await cursorPageTwo(t);
  const oldPage = new URL(fixture.requests.at(-1).path, fixture.props.scope.origin);
  fixture.props.active = false; fixture.render(); advance(16_000);
  fixture.props.active = true; fixture.render();
  const reportRead = fixture.requests.findLast(request => request.path.includes('/report?'));
  await answer(reportRead); const hook = fixture.render();
  const firstRead = fixture.requests.at(-1), params = new URL(firstRead.path, fixture.props.scope.origin).searchParams;
  assert.notEqual(params.get('to'), oldPage.searchParams.get('to'));
  assert.equal(params.has('cursor'), false, 'not even the first event request for the accepted anchor may reuse the cursor');
  assert.equal(hook.page, 1, 'the previous-page stack belongs to the old anchor too');
  const invalid = new URL(firstRead.path, fixture.props.scope.origin); invalid.searchParams.set('cursor', oldPage.searchParams.get('cursor'));
  await assert.rejects(server.read(invalid.href, serverNow + 16_000), /to must not be in the future/);
  invalid.searchParams.set('to', oldPage.searchParams.get('to'));
  await assert.rejects(server.read(invalid.href, serverNow + 16_000), /cursor does not match/);
  await answer(firstRead); fixture.render().nextPage(); fixture.render();
  const secondRead = fixture.requests.at(-1); secondRead.reject(new Error('temporary page-two failure')); await flush();
  assert.equal(fixture.render().page, 2); fixture.render().retryEvents(); fixture.render();
  assert.equal(fixture.requests.at(-1).path, secondRead.path, 'event retry keeps its new anchor and real cursor');
  await answer(fixture.requests.at(-1)); assert.equal(fixture.render().page, 2);
  fixture.render().previousPage(); fixture.render();
  assert.equal(fixture.render().page, 1); assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.has('cursor'), false);
});

test('same-anchor cached reentry keeps a valid second page without refetching the report', async t => {
  const { fixture, answer, advance } = await cursorPageTwo(t);
  const previous = fixture.requests.at(-1).path, reportReads = fixture.requests.filter(request => request.path.includes('/report?')).length;
  fixture.props.active = false; fixture.render(); advance(1_000);
  fixture.props.active = true; fixture.render();
  assert.equal(fixture.render().page, 2); assert.equal(fixture.requests.at(-1).path, previous);
  assert.equal(fixture.requests.filter(request => request.path.includes('/report?')).length, reportReads);
  await answer(fixture.requests.at(-1)); assert.equal(fixture.render().events.value.events.length, 17);
});

for (const field of ['epoch', 'origin', 'tenantId', 'email', 'subject']) test('accepted scope change clears both cursor and previous-page stack: ' + field, async t => {
  const { fixture, answer } = await cursorPageTwo(t);
  if (field === 'epoch') fixture.props.scope.epoch++;
  else if (field === 'origin') fixture.props.scope.origin = 'https://new-console.example';
  else fixture.props.scope.session = { ...fixture.props.scope.session, [field]: field === 'email' ? 'new@example.com' : 'new-' + field };
  fixture.render(); await answer(fixture.requests.at(-1));
  const hook = fixture.render();
  assert.equal(hook.page, 1);
  assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.has('cursor'), false);
});

test('expired report failure and retry, then event failure and retry, remain on the newly accepted anchor', async t => {
  const { fixture, answer, advance } = await cursorPageTwo(t);
  fixture.props.active = false; fixture.render(); advance(16_000); fixture.props.active = true; fixture.render();
  fixture.requests.findLast(request => request.path.includes('/report?')).reject(new Error('temporary report failure')); await flush();
  fixture.render().reload(); fixture.render(); await answer(fixture.requests.at(-1)); fixture.render();
  const firstRead = fixture.requests.at(-1); firstRead.reject(new Error('temporary event failure')); await flush();
  const hook = fixture.render(); assert.equal(hook.page, 1); assert.equal(hook.events.error, 'temporary event failure');
  advance(60_000); hook.retryEvents(); fixture.render();
  assert.equal(fixture.requests.at(-1).path, firstRead.path);
  assert.equal(new URL(firstRead.path, fixture.props.scope.origin).searchParams.has('cursor'), false);
  await answer(fixture.requests.at(-1)); assert.equal(fixture.render().events.value.events.length, 25);
});

test('expired pinned custom report preserves valid page two; explicit refresh stays pinned but resets pagination', async t => {
  const { fixture, answer, advance } = await cursorPageTwo(t, true);
  const pinned = fixture.requests.findLast(request => request.path.includes('/report?')).path, pageTwo = fixture.requests.at(-1).path;
  fixture.props.active = false; fixture.render(); advance(16_000); fixture.props.active = true; fixture.render();
  const fresh = fixture.requests.findLast(request => request.path.includes('/report?'));
  assert.equal(fresh.path, pinned); await answer(fresh); fixture.render();
  assert.equal(fixture.render().page, 2); assert.equal(fixture.requests.at(-1).path, pageTwo);
  await answer(fixture.requests.at(-1)); fixture.render().reload(); fixture.render();
  assert.equal(fixture.requests.at(-1).path, pinned); await answer(fixture.requests.at(-1)); fixture.render();
  assert.equal(fixture.render().page, 1); assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.has('cursor'), false);
  await answer(fixture.requests.at(-1)); const count = fixture.requests.length;
  for (let i = 0; i < 5; i++) fixture.render();
  assert.equal(fixture.requests.length, count, 'accepting identical bounds cannot refetch-loop');
});

test('filter transition and cached return to the former query never restore its previous-page stack', async t => {
  const { fixture, answer } = await cursorPageTwo(t);
  const original = fixture.render().query;
  fixture.render().setQuery({ ...original, filters: { ...original.filters, model: 'different-model' } }); fixture.render();
  assert.equal(fixture.render().page, 1); await answer(fixture.requests.at(-1)); fixture.render();
  assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.has('cursor'), false);
  await answer(fixture.requests.at(-1)); const count = fixture.requests.filter(request => request.path.includes('/report?')).length;
  fixture.render().setQuery(original); fixture.render(); fixture.render();
  assert.equal(fixture.render().page, 1);
  assert.equal(fixture.requests.filter(request => request.path.includes('/report?')).length, count, 'original query still uses its valid report cache');
  assert.equal(new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams.has('cursor'), false);
  await answer(fixture.requests.at(-1)); assert.equal(fixture.render().events.value.events.length, 25);
});


const retentionMs = 30 * 86400000;
for (const timezone of ['UTC', 'America/Los_Angeles']) {
  test('fully expired custom range preserves original controls across grouping, filters, Retry and refresh: ' + timezone, async t => {
    const { fixture, server, answer } = await cursorPageTwo(t);
    const original = { ...fixture.render().query, rollingDays: undefined, from: '2026-10-01', to: '2026-10-02', timezone };
    const eventCount = () => fixture.requests.filter(read => read.path.includes('/events?')).length;
    const before = eventCount();
    const assertRequest = read => {
      const params = new URL(read.path, fixture.props.scope.origin).searchParams;
      assert.equal(params.get('from'), original.from); assert.equal(params.get('to'), original.to);
      assert.equal(params.get('timezone'), timezone); assert.equal(params.has('days'), false);
    };
    const acceptEmpty = async () => {
      const read = fixture.requests.at(-1); assertRequest(read);
      const response = await answer(read);
      assert.equal(response.range.from, response.range.to); assert.equal(response.range.clampedStart, true);
      assert.equal(response.generatedAt, serverNow);
      await assert.rejects(server.read('/v1/session/usage/events?' + usageQueryString({ ...resolvedUsageQuery(original, response), rollingDays: undefined }), serverNow), /range must be positive/);
      let hook = fixture.render(); hook = fixture.render();
      assert.equal(hook.query.from, original.from); assert.equal(hook.query.to, original.to); assert.equal(hook.query.timezone, timezone);
      assert.equal(hook.report.value, response, 'keep the server report and all of its usage/history metadata intact');
      assert.equal(hook.page, 1); assert.equal(hook.events.loading, false); assert.equal(hook.events.error, '');
      assert.deepEqual(hook.events.value, { events: [], nextCursor: null, historyComplete: response.historyComplete, historySource: response.historySource, projectionComplete: response.projectionComplete });
      assert.equal(eventCount(), before, 'no equal-bound event HTTP request');
      return hook;
    };
    fixture.render().setQuery(original); fixture.render(); let hook = await acceptEmpty();
    const count = fixture.requests.length; hook.nextPage(); hook.previousPage(); fixture.render(); fixture.render();
    assert.equal(fixture.render().page, 1); assert.equal(fixture.requests.length, count);
    hook.retryEvents(); fixture.render(); hook = fixture.render();
    assert.equal(hook.events.loading, false); assert.deepEqual(hook.events.value.events, []); assert.equal(fixture.requests.length, count);
    hook.setQuery({ ...hook.query, groupBy: 'provider' }); fixture.render(); hook = await acceptEmpty();
    assert.equal(hook.report.value.groupBy, 'provider');
    hook.setQuery({ ...hook.query, filters: { ...hook.query.filters, model: 'missing-model' } }); fixture.render(); hook = await acceptEmpty();
    assert.equal(hook.query.filters.model, 'missing-model');
    hook.reload(); fixture.render(); assertRequest(fixture.requests.at(-1));
    fixture.requests.at(-1).reject(new Error('temporary expired report failure')); await flush();
    hook = fixture.render(); assert.equal(hook.report.error, 'temporary expired report failure');
    hook.reload(); fixture.render(); await acceptEmpty();
    const stable = fixture.requests.length; for (let i = 0; i < 5; i++) fixture.render();
    assert.equal(fixture.requests.length, stable, 'no render/refetch loop');
  });

  test('partially expired custom controls stay original while every event read uses clipped server bounds: ' + timezone, async t => {
    const { fixture, answer } = await cursorPageTwo(t);
    const original = { ...fixture.render().query, rollingDays: undefined, from: '2026-10-02', to: '2026-11-01', timezone };
    fixture.render().setQuery(original); fixture.render();
    const response = await answer(fixture.requests.at(-1));
    assert.equal(response.range.from, serverNow - retentionMs); assert.ok(response.range.from < response.range.to);
    assert.equal(response.range.clampedStart, true);
    assert.equal(new Date(response.range.to).toISOString(), timezone === 'UTC' ? '2026-11-01T00:00:00.000Z' : '2026-11-01T07:00:00.000Z');
    let hook = fixture.render();
    assert.equal(hook.query.from, original.from); assert.equal(hook.query.to, original.to);
    const eventRead = fixture.requests.at(-1), params = new URL(eventRead.path, fixture.props.scope.origin).searchParams;
    assert.equal(params.get('from'), new Date(response.range.from).toISOString()); assert.equal(params.get('to'), new Date(response.range.to).toISOString());
    assert.ok(Date.parse(params.get('to')) <= serverNow); assert.equal(params.has('cursor'), false);
    eventRead.reject(new Error('temporary clipped event failure')); await flush();
    hook = fixture.render(); assert.equal(hook.events.error, 'temporary clipped event failure'); hook.retryEvents(); fixture.render();
    assert.equal(fixture.requests.at(-1).path, eventRead.path); await answer(fixture.requests.at(-1));
    hook = fixture.render(); assert.equal(hook.events.value.events.length, 0);
    hook.setQuery({ ...hook.query, groupBy: 'key', filters: { ...hook.query.filters, model: 'missing-model' } }); fixture.render();
    const changed = new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams;
    assert.equal(changed.get('from'), original.from); assert.equal(changed.get('to'), original.to);
    const changedResponse = await answer(fixture.requests.at(-1)); fixture.render();
    const changedEvents = new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams;
    assert.equal(changedEvents.get('from'), new Date(changedResponse.range.from).toISOString()); assert.equal(changedEvents.get('to'), params.get('to'));
    await answer(fixture.requests.at(-1)); fixture.render().reload(); fixture.render();
    const refreshed = new URL(fixture.requests.at(-1).path, fixture.props.scope.origin).searchParams;
    assert.equal(refreshed.get('from'), original.from); assert.equal(refreshed.get('to'), original.to);
  });

  test('valid nonempty current range with no calls still reads events and retries normally: ' + timezone, async t => {
    const { fixture, answer } = await cursorPageTwo(t);
    const original = { ...fixture.render().query, rollingDays: undefined, from: '2026-11-01', to: '2026-11-02', timezone };
    fixture.render().setQuery(original); fixture.render();
    const response = await answer(fixture.requests.at(-1)); assert.equal(response.metrics.calls, 0);
    assert.equal(response.range.clampedStart, false); assert.ok(response.range.from < response.range.to);
    const count = fixture.requests.length; let hook = fixture.render();
    assert.equal(fixture.requests.length, count + 1, 'empty metrics do not suppress a valid event read');
    assert.equal(hook.query.from, original.from); assert.equal(hook.query.to, original.to);
    const read = fixture.requests.at(-1); read.reject(new Error('temporary empty event failure')); await flush();
    hook = fixture.render(); assert.equal(hook.events.error, 'temporary empty event failure'); hook.retryEvents(); fixture.render();
    assert.equal(fixture.requests.at(-1).path, read.path); const events = await answer(fixture.requests.at(-1));
    assert.deepEqual(events.events, []); assert.equal(fixture.render().events.loading, false);
  });
}

test('locally empty event page preserves incomplete retained-ledger metadata without altering report values', async () => {
  const fixture = mount(); fixture.render();
  const response = reportFixture({ historyComplete: false, projectionComplete: false, historySource: 'retained_ledger', generatedAt: serverNow }, serverNow - 31 * 86400000, serverNow - 31 * 86400000);
  fixture.requests[0].resolve(response); await flush(); fixture.render(); const hook = fixture.render();
  assert.equal(fixture.requests.length, 1); assert.equal(hook.report.value, response);
  assert.deepEqual(hook.events.value, { events: [], nextCursor: null, historyComplete: false, historySource: 'retained_ledger', projectionComplete: false });
  fixture.retire();
});
