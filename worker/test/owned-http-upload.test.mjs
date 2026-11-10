import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { beginOwnedHttpRequest, beginOwnedHttpUpload, adoptOwnedHttpUploadSource, pipeOwnedHttpUpload,
  dispatchOwnedHttpUpload, abandonOwnedHttpUpload, finishOwnedHttpRequest, ownedHttpCompletion } from '../http-identity-owner.ts';
import { bodyBudgetCharged, bodyBudgetBytes, ExactBodyCharge } from '../body-budget.ts';
import { jsonBodyBytes, jsonBodyStream } from '../json-body.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.then(() => undefined, () => undefined);
  return { promise, resolve, reject };
};

// Every original gets an immediate outcome observer. A taken outcome has one
// reporting origin; the same promise can be joined again without duplicating it.
async function fixture(t, run) {
  const baseline = bodyBudgetCharged(), roots = [], origins = new WeakMap(), releases = [];
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
  try { assert.equal(bodyBudgetCharged(), baseline, 'last actual upload consumer retires its debit'); }
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
      assert.equal(failure.errors.length, 2); assert.equal(failure.errors[0], reason); assert.equal(failure.errors[1], reason);
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
