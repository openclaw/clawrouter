import { ownedStaticHeld } from '../../test/helpers/owned-static-custody-observer.mjs';
await import('./typescript-setup.mjs');
import assert from 'node:assert/strict';
import test from 'node:test';
const { beginOwnedHttpRequest, beginOwnedHttpUpload, adoptOwnedHttpUploadSource, pipeOwnedHttpUpload,
  dispatchOwnedHttpUpload, abandonOwnedHttpUpload, finishOwnedHttpRequest, ownedHttpCompletion,
  ownOwnedHttpResponse } = await import('../http-identity-owner.ts');
const { bodyBudgetCharged, bodyBudgetBytes, ExactBodyCharge } = await import('../body-budget.ts');
const { jsonBodyBytes, jsonBodyStream } = await import('../json-body.ts');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.then(() => undefined, () => undefined);
  return { promise, resolve, reject };
};

// Every original gets an immediate outcome observer. A taken outcome has one
// reporting origin; the same promise can be joined again without duplicating it.
async function fixture(t, run) {
  const sharedBefore = ownedStaticHeld(), baseline = bodyBudgetCharged(), roots = [], origins = new WeakMap(), releases = [];
  const cap = beginOwnedHttpRequest(new Request('https://router.example/v1/chat/completions'), {});
  let cleanupPromise, retirement, hasPrimary = false, primary, finished = false;
  const own = promise => {
    if (origins.has(promise)) return origins.get(promise);
    const root = { taken: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) };
    roots.push(root); origins.set(promise, root); return root;
  };
  const take = async root => { const result = await root.outcome; root.taken = true; if (result.failed) throw result.error; return result.value; };
  const finish = () => retirement ??= own(finishOwnedHttpRequest(cap));
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
    // This initiates cancellation of all unused uploads BEFORE any join.
    finish();
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) {
      const outcome = await root.outcome;
      if (outcome.failed && !root.taken) { root.taken = true; failures.push(outcome.error); }
    }
    return failures;
  })();
  t.after(async () => {
    if (!finished) {
      const failures = await cleanup();
      if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'upload fixture teardown');
    }
  });
  try { await run({ cap, own, take, releases, finish }); }
  catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  try { assert.equal(bodyBudgetCharged(), baseline + ownedStaticHeld() - sharedBefore, 'exact upload retirement plus observed permanent custody'); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'upload fixture outcomes');
  if (hasPrimary) throw primary;
}

test('owned upload sends the complete 1 MiB ASCII Chat body through its ORIGINAL pipe', async t => {
  await fixture(t, async f => {
    const body = { model: 'fixture-chat', messages: [{ role: 'user', content: 'a'.repeat(1024 * 1024) }] };
    const upload = beginOwnedHttpUpload(f.cap), source = jsonBodyStream(body);
    adoptOwnedHttpUploadSource(upload, source);
    const readable = pipeOwnedHttpUpload(upload, source, new FixedLengthStream(jsonBodyBytes(body)));
    dispatchOwnedHttpUpload(upload);
    const delivered = f.own(ownedHttpCompletion(f.cap).start(() => new Response(readable).text()));
    assert.deepEqual(JSON.parse(await f.take(delivered)), body);
    await f.take(f.finish());
    assert.equal(source.locked, false, 'ORIGINAL pipe releases its reader');
  });
});

for (const label of ['post-preparation budget denial', 'unused alternate']) {
  test(`${label} cancels BEFORE joining an unconsumed backpressured upload`, async t => {
    await fixture(t, async f => {
      const entered = deferred(), release = deferred(); let cancels = 0;
      f.releases.push(release.resolve);
      const upload = beginOwnedHttpUpload(f.cap);
      const source = new ReadableStream({ cancel() { cancels++; entered.resolve(); return release.promise; } }, { highWaterMark: 0 });
      adoptOwnedHttpUploadSource(upload, source);
      pipeOwnedHttpUpload(upload, source, new FixedLengthStream(1));
      const first = abandonOwnedHttpUpload(upload), again = abandonOwnedHttpUpload(upload);
      assert.equal(first, again, 'one cleanup promise, not another cancel');
      const joined = f.own(first);
      await Promise.race([entered.promise, joined.outcome.then(() => { throw Error('cleanup settled before ORIGINAL cancellation'); })]);
      assert.equal(cancels, 1); assert.equal(source.locked, true);
      assert.ok(bodyBudgetCharged() > 0, 'funding stays held with ORIGINAL cancellation');
      release.resolve(); await f.take(joined);
      const terminal = await f.take(f.finish()).then(() => ({ ok: true }), error => ({ ok: false, error }));
      // pipeTo rejects on owned abort even when its ORIGINAL cancel succeeds.
      assert.equal(terminal.ok, false); assert.ok(terminal.error instanceof AggregateError);
      assert.equal(terminal.error.errors.length, 1); assert.equal(source.locked, false);
    });
  });
}

test('partial preparation owns source cancellation when FixedLengthStream construction has not completed', async t => {
  await fixture(t, async f => {
    const release = deferred(), entered = deferred(); let cancels = 0;
    f.releases.push(release.resolve);
    const upload = beginOwnedHttpUpload(f.cap), source = new ReadableStream({
      cancel() { cancels++; entered.resolve(); return release.promise; },
    });
    adoptOwnedHttpUploadSource(upload, source);
    const joined = f.own(abandonOwnedHttpUpload(upload));
    await Promise.race([entered.promise, joined.outcome.then(() => { throw Error('partial cleanup skipped ORIGINAL cancellation'); })]);
    assert.equal(cancels, 1); release.resolve(); await f.take(joined);
  });
});

for (const rejected of [false, true]) test(`dispatched upload retires after logical HTTP delivery without a completion self-join${rejected ? ' on original cancel rejection' : ''}`, async t => {
  await fixture(t, async f => {
    const entered = deferred(), release = deferred(), accounting = deferred(); let cancels = 0;
    f.releases.push(accounting.resolve, release.resolve);
    const upload = beginOwnedHttpUpload(f.cap);
    const source = new ReadableStream({ cancel() { cancels++; entered.resolve(); return release.promise; } }, { highWaterMark: 0 });
    adoptOwnedHttpUploadSource(upload, source);
    pipeOwnedHttpUpload(upload, source, new FixedLengthStream(1)); dispatchOwnedHttpUpload(upload);
    const accounted = f.own(ownedHttpCompletion(f.cap).start(() => accounting.promise));
    const response = ownOwnedHttpResponse(f.cap, new Response('data: {"prefix":true}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const delivered = f.own(response.text()), terminal = f.finish();
    assert.match(await f.take(delivered), /prefix/);
    assert.equal(cancels, 0, 'logical accounting still owns the dispatched attempt');
    accounting.resolve(); await f.take(accounted);
    await f.take(f.own(Promise.race([entered.promise, terminal.outcome.then(() => { throw Error('terminal skipped ORIGINAL cancellation'); })])));
    assert.equal(cancels, 1); assert.equal(source.locked, true);
    assert.ok(bodyBudgetCharged() > 0, 'public prefix is not original upload retirement');
    if (rejected) release.reject(undefined); else release.resolve();
    const ended = await f.take(terminal).then(() => ({ failed: false }), error => ({ failed: true, error }));
    assert.equal(ended.failed, true); assert.ok(ended.error instanceof AggregateError);
    assert.equal(ended.error.errors.length, 1);
    assert.equal(ended.error.errors[0].origin, 'pipe');
    if (rejected) assert.equal(ended.error.errors[0].primaryIsUndefined, true);
    assert.equal(source.locked, false);
  });
});

for (const reason of [undefined, new Error('shared fixture failure')]) {
  test(`independent ORIGINAL pipe failures preserve ${reason === undefined ? 'undefined' : 'shared reason'} by origin`, async t => {
    await fixture(t, async f => {
      for (let i = 0; i < 2; i++) {
        const upload = beginOwnedHttpUpload(f.cap), source = new ReadableStream({ cancel() { return Promise.reject(reason); } }, { highWaterMark: 0 });
        adoptOwnedHttpUploadSource(upload, source);
        pipeOwnedHttpUpload(upload, source, new FixedLengthStream(1));
        await f.take(f.own(abandonOwnedHttpUpload(upload)));
      }
      const terminal = f.finish();
      let hasFailure = false, failure;
      try { await f.take(terminal); } catch (error) { hasFailure = true; failure = error; }
      assert.equal(hasFailure, true); assert.ok(failure instanceof AggregateError);
      assert.equal(failure.errors.length, 2);
      assert.ok(failure.errors.every(error => error.origin === 'pipe' && error.primary && error.primaryIsUndefined === (reason === undefined)));
      assert.notEqual(failure.errors[0].ordinal, failure.errors[1].ordinal);
    });
  });
}

test('common capacity refusal precedes source and pipe factories', async t => {
  await fixture(t, async f => {
    const pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged());
    assert.ok(pressure); f.releases.push(() => pressure.release());
    let factoryCalls = 0;
    assert.throws(() => {
      const upload = beginOwnedHttpUpload(f.cap);
      factoryCalls++; const source = new ReadableStream();
      adoptOwnedHttpUploadSource(upload, source); pipeOwnedHttpUpload(upload, source, new FixedLengthStream(0));
    }, error => error.status === 503);
    assert.equal(factoryCalls, 0);
  });
});

for (const reason of [undefined, new Error('shared native reader cleanup')]) {
  test(`actual response consumer joins held FIRSTcancel and preserves independent ${reason === undefined ? 'undefined' : 'shared Error'} unlock`, async t => {
    await fixture(t, async f => {
      const entered = deferred(), release = deferred(); f.releases.push(release.resolve);
      let cancels = 0, unlocks = 0;
      const body = new ReadableStream({ cancel() { cancels++; entered.resolve(); return release.promise.then(() => { throw reason; }); } }, { highWaterMark: 0 });
      const getReader = body.getReader;
      Object.defineProperty(body, 'getReader', { configurable: true, value(...args) {
        const reader = Reflect.apply(getReader, this, args), unlock = reader.releaseLock;
        Object.defineProperty(reader, 'releaseLock', { configurable: true, value() { Reflect.apply(unlock, this, []); unlocks++; throw reason; } });
        return reader;
      } });
      const response = ownOwnedHttpResponse(f.cap, new Response(body));
      const canceled = f.own(response.body.cancel());
      const terminal = f.finish();
      await Promise.race([entered.promise, canceled.outcome.then(() => { throw Error('response retired before FIRSTcancel entry'); })]);
      assert.equal(cancels, 1); assert.equal(unlocks, 0); assert.equal(body.locked, true); assert.ok(bodyBudgetCharged() > 0);
      release.resolve();
      let hasCancel = false, cancelError;
      try { await f.take(canceled); } catch (error) { hasCancel = true; cancelError = error; }
      assert.equal(hasCancel, true); assert.equal(cancelError.origin, 'unlock');
      assert.equal(cancelError.primaryIsUndefined, reason === undefined, 'original unlock failure remains a bounded public cancellation outcome');
      let failed = false, failure;
      try { await f.take(terminal); } catch (error) { failed = true; failure = error; }
      assert.equal(failed, true); assert.ok(failure instanceof AggregateError);
      assert.deepEqual(failure.errors.map(error => error.origin), ['cancel', 'unlock'], 'FIRSTcancel and unlock are distinct origins');
      assert.ok(failure.errors.every(error => error.primaryIsUndefined === (reason === undefined)));
      assert.notEqual(failure.errors[0].ordinal, failure.errors[1].ordinal);
      assert.equal(unlocks, 1); assert.equal(body.locked, false);
    });
  });
}

test('response acquisition failure cancels the untouched original body and retains both undefined origins', async t => {
  await fixture(t, async f => {
    let cancels = 0;
    const body = new ReadableStream({ cancel() { cancels++; return Promise.reject(undefined); } });
    Object.defineProperty(body, 'getReader', { value() { throw undefined; } });
    let hasPrimary = false, primary;
    try { ownOwnedHttpResponse(f.cap, new Response(body)); }
    catch (error) { hasPrimary = true; primary = error; }
    assert.equal(hasPrimary, true); assert.equal(primary.origin, 'acquire'); assert.equal(primary.primaryIsUndefined, true);
    let failed = false, failure;
    try { await f.take(f.finish()); } catch (error) { failed = true; failure = error; }
    assert.equal(failed, true); assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors.map(error => [error.origin, error.primaryIsUndefined]), [['acquire', true], ['cancel', true]]); assert.equal(cancels, 1); assert.equal(body.locked, false);
  });
});

test('native errored-stream cancellation propagates one read origin without reason-value deduplication', async t => {
  await fixture(t, async f => {
    let canceled = 0;
    const body = new ReadableStream({ pull(controller) { controller.error(undefined); }, cancel() { canceled++; } }, { highWaterMark: 0 });
    const response = ownOwnedHttpResponse(f.cap, new Response(body));
    let hasRead = false, readFailure;
    try { await f.take(f.own(response.text())); } catch (error) { hasRead = true; readFailure = error; }
    assert.equal(hasRead, true); assert.equal(readFailure.origin, 'read'); assert.equal(readFailure.primaryIsUndefined, true);
    let failed = false, failure;
    try { await f.take(f.finish()); } catch (error) { failed = true; failure = error; }
    assert.equal(failed, true); assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors.map(error => [error.origin, error.primaryIsUndefined]), [['read', true]]); assert.equal(canceled, 0, 'native errored stream never calls underlying cancel');
    assert.equal(body.locked, false);
  });
});


test('post-native cancel rejection is independent of an already failed read', async t => {
  await fixture(t, async f => {
    const body = new ReadableStream({ pull(controller) { controller.error(undefined); } }, { highWaterMark: 0 });
    const getReader = body.getReader; let cancels = 0, unlocks = 0;
    Object.defineProperty(body, 'getReader', { value(...args) {
      const reader = Reflect.apply(getReader, this, args), cancel = reader.cancel, unlock = reader.releaseLock;
      Object.defineProperty(reader, 'cancel', { value(...values) {
        cancels++;
        return Reflect.apply(cancel, this, values).then(() => { throw undefined; }, () => { throw undefined; });
      } });
      Object.defineProperty(reader, 'releaseLock', { value() { unlocks++; return Reflect.apply(unlock, this, []); } });
      return reader;
    } });
    const response = ownOwnedHttpResponse(f.cap, new Response(body));
    let hasRead = false;
    try { await f.take(f.own(response.text())); } catch (error) { hasRead = true; assert.equal(error.origin, 'read'); }
    assert.equal(hasRead, true);
    let failed = false, failure;
    try { await f.take(f.finish()); } catch (error) { failed = true; failure = error; }
    assert.equal(failed, true); assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors.map(error => [error.origin, error.primaryIsUndefined]), [['read', true], ['cancel', true]]);
    assert.notEqual(failure.errors[0].ordinal, failure.errors[1].ordinal);
    assert.equal(cancels, 1); assert.equal(unlocks, 1); assert.equal(body.locked, false);
  });
});


test('an admitted upload can FIRSTcancel and unlock with no remaining common-arena capacity', async t => {
  await fixture(t, async f => {
    const entered = deferred(), release = deferred(); f.releases.push(release.resolve);
    let cancels = 0;
    const upload = beginOwnedHttpUpload(f.cap);
    const source = new ReadableStream({ cancel() { cancels++; entered.resolve(); return release.promise; } }, { highWaterMark: 0 });
    adoptOwnedHttpUploadSource(upload, source); pipeOwnedHttpUpload(upload, source, new FixedLengthStream(1));
    const pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged()); assert.ok(pressure);
    f.releases.push(() => pressure.release());
    const original = abandonOwnedHttpUpload(upload), root = f.own(original);
    await Promise.race([entered.promise, original.then(() => { throw new Error('abandonment ended before original cancel entry'); })]);
    assert.equal(bodyBudgetCharged(), bodyBudgetBytes, 'cancellation does not acquire new common credit');
    release.resolve(); await f.take(root);
    assert.equal(cancels, 1); assert.equal(source.locked, false);
    pressure.release();
    let failure, failed = false;
    try { await f.take(f.finish()); } catch (error) { failed = true; failure = error; }
    assert.equal(failed, true); assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors.map(error => error.origin), ['pipe'], 'owned abort retains its original pipe outcome');
  });
});
