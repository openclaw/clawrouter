import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { withCopiedConsumerFixture } from "./helpers/openclaw-consumer.mjs";
import { awaitWorkerdFixtureReady, startBundledWorkerdFixture } from "./helpers/workerd.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Rejection presence must not be inferred from a truthy reason.
const outcome = promise => promise.then(value => ({ rejected: false, value }), reason => ({ rejected: true, reason }));

test("ready Worker returns its original instance without disposal", async () => {
  let disposals = 0;
  const mf = { ready: Promise.resolve(), dispose() { disposals++; } };
  assert.equal(await awaitWorkerdFixtureReady(mf), mf);
  assert.equal(disposals, 0);
});

test("consumer copies, executes and removes once, preserving its return value", async () => {
  const calls = [], value = {};
  const result = await withCopiedConsumerFixture(
    () => { calls.push("copy"); },
    () => { calls.push("run"); return value; },
    () => { calls.push("remove"); },
  );
  assert.equal(result, value);
  assert.deepEqual(calls, ["copy", "run", "remove"]);
  assert.equal(await withCopiedConsumerFixture(() => {}, () => {}, () => {}), undefined);
});

const childError = Object.assign(new Error("fixture child failure"), {
  code: 7, killed: false, signal: null, stdout: "fixture stdout", stderr: "fixture stderr",
});
const cleanupError = new Error("fixture cleanup failure");

for (const owner of ["Worker", "consumer"]) {
  for (const [name, primary, cleanupFails, cleanup] of [
    ["primary only", childError, false, undefined],
    ["undefined primary only", undefined, false, undefined],
    ["both errors", childError, true, cleanupError],
    ["undefined primary and cleanup error", undefined, true, cleanupError],
    ["primary error and undefined cleanup", childError, true, undefined],
    ["both undefined", undefined, true, undefined],
  ]) {
    test(`${owner} preserves ${name} in original order`, async () => {
      let cleanups = 0, executions = 0;
      const remove = async () => { cleanups++; if (cleanupFails) throw cleanup; };
      const run = async () => { executions++; throw primary; };
      const result = await outcome(owner === "Worker"
        ? awaitWorkerdFixtureReady({ get ready() { return run(); }, dispose: remove })
        : withCopiedConsumerFixture(() => {}, run, remove));
      assert.equal(result.rejected, true);
      assert.equal(cleanups, 1);
      assert.equal(executions, 1);
      if (cleanupFails) {
        assert.ok(result.reason instanceof AggregateError);
        assert.equal(result.reason.errors.length, 2);
        assert.equal(result.reason.errors[0], primary);
        assert.equal(result.reason.errors[1], cleanup);
      } else {
        assert.equal(result.reason, primary);
      }
      assert.deepEqual({ ...childError }, { code: 7, killed: false, signal: null, stdout: "fixture stdout", stderr: "fixture stderr" });
    });
  }
}

for (const reason of [cleanupError, undefined]) {
  test(`consumer preserves cleanup-only ${reason === undefined ? "undefined" : "error"}`, async () => {
    const result = await outcome(withCopiedConsumerFixture(() => {}, () => {}, () => { throw reason; }));
    assert.equal(result.rejected, true);
    assert.equal(result.reason, reason);
  });
}

test("synchronous ready getter failure disposes the actual receiver once", async () => {
  let cleanups = 0;
  const mf = {
    get ready() { throw undefined; },
    dispose() { assert.equal(this, mf); cleanups++; throw cleanupError; },
  };
  const result = await outcome(awaitWorkerdFixtureReady(mf));
  assert.equal(result.rejected, true);
  assert.deepEqual(result.reason.errors, [undefined, cleanupError]);
  assert.equal(cleanups, 1);
});

test("synchronous child failure still removes exactly once", async () => {
  let removals = 0;
  const result = await outcome(withCopiedConsumerFixture(() => {}, () => { throw undefined; }, () => { removals++; }));
  assert.equal(result.rejected, true);
  assert.equal(result.reason, undefined);
  assert.equal(removals, 1);
});

for (const owner of ["Worker", "consumer"]) {
  test(`${owner} cannot settle before its original cleanup settles`, { timeout: 5_000 }, async () => {
    const started = deferred(), release = deferred();
    let settled = false, cleanups = 0;
    const cleanup = () => { cleanups++; started.resolve(); return release.promise; };
    const pending = owner === "Worker"
      ? awaitWorkerdFixtureReady({ ready: Promise.reject(undefined), dispose: cleanup })
      : withCopiedConsumerFixture(() => {}, () => { throw undefined; }, cleanup);
    const observed = outcome(pending).then(value => { settled = true; return value; });
    try {
      await started.promise;
      await setImmediate();
      assert.equal(settled, false);
      assert.equal(cleanups, 1);
    } finally {
      release.resolve();
      await observed;
    }
    assert.deepEqual(await observed, { rejected: true, reason: undefined });
  });
}

test("failed copy, including synchronous undefined, never executes or removes", async () => {
  let executions = 0, removals = 0;
  const result = await outcome(withCopiedConsumerFixture(() => { throw undefined; }, () => { executions++; }, () => { removals++; }));
  assert.equal(result.rejected, true);
  assert.equal(result.reason, undefined);
  assert.equal(executions, 0);
  assert.equal(removals, 0);
});

test("exclusive-copy collision preserves a pre-existing fixture", async t => {
  const directory = await mkdtemp(join(tmpdir(), "consumer-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), target = join(directory, "target");
  await writeFile(source, "incoming fixture");
  await writeFile(target, "existing fixture");
  let executions = 0, removals = 0;
  const result = await outcome(withCopiedConsumerFixture(
    () => copyFile(source, target, constants.COPYFILE_EXCL),
    () => { executions++; },
    () => { removals++; return rm(target); },
  ));
  assert.equal(result.rejected, true);
  assert.equal(result.reason.code, "EEXIST");
  assert.equal(await readFile(target, "utf8"), "existing fixture");
  assert.equal(executions, 0);
  assert.equal(removals, 0);
});

test("competing copies leave removal to the successful copy owner", { timeout: 5_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "consumer-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), target = join(directory, "target");
  await writeFile(source, "owned fixture");
  const started = deferred(), release = deferred();
  let winnerRuns = 0, winnerRemoves = 0, loserRuns = 0, loserRemoves = 0;
  const winner = outcome(withCopiedConsumerFixture(
    () => copyFile(source, target, constants.COPYFILE_EXCL),
    () => { winnerRuns++; started.resolve(); return release.promise; },
    () => { winnerRemoves++; return rm(target); },
  ));
  try {
    await Promise.race([started.promise, winner.then(result => {
      if (result.rejected) throw result.reason;
    })]);
    const loser = await outcome(withCopiedConsumerFixture(
      () => copyFile(source, target, constants.COPYFILE_EXCL),
      () => { loserRuns++; },
      () => { loserRemoves++; return rm(target); },
    ));
    assert.equal(loser.rejected, true);
    assert.equal(loser.reason.code, "EEXIST");
    assert.equal(await readFile(target, "utf8"), "owned fixture");
    assert.equal(winnerRemoves, 0);
  } finally {
    release.resolve();
    await winner;
  }
  assert.deepEqual(await winner, { rejected: false, value: undefined });
  assert.deepEqual([winnerRuns, winnerRemoves, loserRuns, loserRemoves], [1, 1, 0, 0]);
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("real Worker readiness succeeds and invalid startup rejects before handoff", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "workerd-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const router = `${["PolicyBindingIndexObject", "BudgetLedgerObject", "UsageLedgerObject", "GrantCredentialObject"].map(name => `export class ${name} {}`).join("\n")}
    export default { fetch() { return new Response("ready"); } };`;
  const upstream = 'export default { fetch() { return new Response("unused"); } };';
  const mf = await startBundledWorkerdFixture(directory, router, upstream);
  const failures = [];
  try {
    assert.equal(await (await mf.dispatchFetch("https://fixture.invalid/")).text(), "ready");
  } catch (error) {
    failures.push(error);
  }
  try { await mf.dispose(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Worker smoke and disposal failed");
  // Failed readiness belongs to the helper; there is no returned instance to dispose again.
  await assert.rejects(startBundledWorkerdFixture(directory, "export default {", upstream));
});
