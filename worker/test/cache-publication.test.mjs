import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HotCache, hotCacheConfig, hotCacheNow, setHotCacheClock, hotCacheAcquiredAt, fenceSharedHotCache, sharedHotCacheFence, resetSharedHotCacheFence } from '../hot-cache.ts';
import { cachedGrantCredentials, evictGrantCredentials } from '../credential-cache.ts';
const config = hotCacheConfig({});
const cacheable = value => ({ value, cacheable: true });
const gate = () => Promise.withResolvers();

for (const invalidate of ['clear', 'delete', 'prefix', 'value']) for (const outcome of ['cacheable', 'uncacheable', 'rejected']) {
  test(`${invalidate} invalidation fences old ${outcome} completion and preserves a newer explicit value`, async () => {
    const cache = new HotCache(4), held = gate();
    const old = cache.load('grant\n1', config, async () => {
      await held.promise;
      if (outcome === 'rejected') throw new Error('old loader');
      return { value: 'old', cacheable: outcome === 'cacheable' };
    });
    const observed = outcome === 'rejected' ? assert.rejects(old, /old loader/) : old;
    try {
      assert.ok(cache.publication('grant\n1'), 'identity exists before loader completes');
      if (invalidate === 'clear') cache.clear();
      if (invalidate === 'delete') cache.delete('grant\n1');
      if (invalidate === 'prefix') cache.deleteKeys(key => key.startsWith('grant\n'));
      if (invalidate === 'value') cache.deleteWhere(() => false);
      assert.equal(cache.publication('grant\n1'), undefined);
      cache.set('grant\n1', 'new', config);
    } finally { held.resolve(); await observed; }
    assert.equal(cache.peek('grant\n1', config).value, 'new');
    assert.equal(cache.livePublications.size, 0);
  });
}

test('replacement leader and follower survive old completion without joining old I/O', async () => {
  const cache = new HotCache(4), first = gate(), second = gate();
  const old = cache.load('k', config, async () => { await first.promise; return cacheable('old'); });
  const follower = cache.load('k', config, async () => { await second.promise; return cacheable('new'); });
  try {
    cache.delete('k');
    // The follower's OWN timer must observe invalidation while the old I/O is held.
    for (let n = 0; n < 100 && !cache.publication('k'); n++) await new Promise(r => setTimeout(r, 1));
    const replacement = cache.publication('k'); assert.ok(replacement);
    first.resolve(); await old;
    assert.equal(cache.publication('k'), replacement, 'old finally cannot remove replacement');
    second.resolve(); assert.equal((await follower).value, 'new');
    assert.equal(cache.peek('k', config).value, 'new');
  } finally { first.resolve(); second.resolve(); await Promise.all([old, follower]); }
});

test('invalidated live identities remain bounded; overflow is uncached and unrelated keys progress', async () => {
  const cache = new HotCache(2), held = gate();
  const loads = ['a', 'b'].map(key => cache.load(key, config, async () => { await held.promise; return cacheable(key); }));
  try {
    cache.clear(); assert.equal(cache.livePublications.size, 2);
    assert.equal((await cache.load('c', config, async publication => {
      assert.equal(publication, undefined); return cacheable('c');
    })).value, 'c');
    assert.equal(cache.peek('c', config), undefined);
    assert.equal(cache.livePublications.size, 2, 'overflow cannot evict old fencing evidence');
  } finally { held.resolve(); await Promise.all(loads); }
  assert.equal(cache.livePublications.size, 0);
  await cache.load('c', config, async () => cacheable('fresh'));
  assert.equal(cache.peek('c', config).value, 'fresh');
});

test('key invalidation fences pending-only versions but preserves unrelated stored and pending grants', async () => {
  const held = gate(), grant = n => ({ provider: 'anthropic', kind: 'subscription', enabled: true, accessToken: 'synthetic', credentialGeneration: n, updatedAt: '2026-01-01T00:00:00Z' });
  let calls = 0;
  const load = (key, version, wait = false) => cachedGrantCredentials({}, key, grant(version), async () => {
    calls++; if (wait) await held.promise; return grant(version);
  });
  await load('other-stored', 1);
  const loads = [load('target', 1, true), load('target', 2, true), load('other-pending', 1, true)];
  try { evictGrantCredentials('target'); } finally { held.resolve(); await Promise.all(loads); }
  const before = calls;
  await load('target', 1); await load('target', 2);
  assert.equal(calls, before + 2);
  await load('other-stored', 1); await load('other-pending', 1);
  assert.equal(calls, before + 2, 'unrelated grants retain their stored/publication rights');
});

test('value predicates fence all unknown pending values and preserve unrelated stored values', async () => {
  const cache = new HotCache(4), held = gate(); cache.set('safe', 'safe', config); cache.set('remove', 'remove', config);
  const old = cache.load('pending', config, async () => { await held.promise; return cacheable('unknown'); });
  try { cache.deleteWhere((_key, value) => value === 'remove'); }
  finally { held.resolve(); await old; }
  assert.equal(cache.peek('safe', config).value, 'safe');
  assert.equal(cache.peek('remove', config), undefined); assert.equal(cache.peek('pending', config), undefined);
});

test('slow acquisitions keep their original age; equal and rollback clocks cannot reopen shared fences', async () => {
  let now = 1_000_000; setHotCacheClock(() => now); resetSharedHotCacheFence();
  const cache = new HotCache(4), held = gate();
  const old = cache.load('k', config, async () => { await held.promise; return cacheable('old'); });
  try { now += 60_000; held.resolve(); await old; assert.equal(cache.peek('k', config), undefined); }
  finally { held.resolve(); await old; }
  const acquired = hotCacheAcquiredAt(); fenceSharedHotCache();
  assert.ok(acquired <= sharedHotCacheFence(), 'equal-clock acquisition is fenced');
  now -= 120_000; fenceSharedHotCache();
  assert.ok(acquired <= sharedHotCacheFence(), 'rollback cannot lower the fence');
  assert.equal(hotCacheAcquiredAt(), hotCacheNow(), 'do not invent future freshness timestamps');
  setHotCacheClock(); resetSharedHotCacheFence();
});

for (const outcome of ['cacheable', 'uncacheable', 'rejected']) test(`explicit set alone supersedes old ${outcome} loader`, async () => {
  const cache = new HotCache(4), held = gate();
  const old = cache.load('k', config, async () => { await held.promise; if (outcome === 'rejected') throw new Error('old'); return { value: 'old', cacheable: outcome === 'cacheable' }; });
  const observed = outcome === 'rejected' ? assert.rejects(old, /old/) : old;
  try { cache.set('k', 'explicit', config); } finally { held.resolve(); await observed; }
  assert.equal(cache.peek('k', config).value, 'explicit');
});

test('loader synchronous invalidation is fenced because leadership precedes invocation', async () => {
  const cache = new HotCache(4);
  await cache.load('k', config, async owner => { assert.ok(owner); cache.clear(); return cacheable('old'); });
  assert.equal(cache.peek('k', config), undefined);
  assert.equal(cache.publish('k', Object.freeze({ acquiredAt: Date.now() }), 'forged', config), false);
});

test('an old stale refresh cannot overwrite a later load', async () => {
  let now = Date.now(); setHotCacheClock(() => now);
  const cache = new HotCache(4), held = gate();cache.set('k', 'first', config);now += 10001;
  const refreshing = cache.load('k', config, async () => { await held.promise; return cacheable('stale refresh'); });
  try { cache.delete('k');await cache.load('k', config, async () => cacheable('replacement')); }
  finally { held.resolve();await refreshing;setHotCacheClock(); }
  // Read before restoring the clock would also be fresh; retain its same source clock.
  setHotCacheClock(() => now);assert.equal(cache.peek('k', config).value, 'replacement');setHotCacheClock();
});

test('an admitted foreign stored timestamp raises the rollback fence without renewing age', () => {
  let now = 500;setHotCacheClock(() => now);resetSharedHotCacheFence();
  const cache = new HotCache(4), publication = cache.beginPublication('foreign');
  assert.equal(publication.acquiredAt, 500);now = 1000;
  assert.equal(cache.publish('foreign', publication, 'snapshot', config, Infinity, 900), true);
  cache.endPublication('foreign', publication);assert.equal(cache.entries.get('foreign').storedAt, 900);
  now = 600;cache.clear();fenceSharedHotCache();assert.equal(sharedHotCacheFence(), 900);
  now = 1000;assert.ok(900 <= sharedHotCacheFence());setHotCacheClock();resetSharedHotCacheFence();
});
