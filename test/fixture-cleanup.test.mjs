import assert from "node:assert/strict";
import test from "node:test";
import { cleanupFixture } from "./helpers/fixture-cleanup.mjs";

test("fixture cleanup retains primary and independent failures in order", async () => {
  const original = new AggregateError([undefined, { original: true }], "original");
  const cleanup = { cleanup: true };
  for (const primary of [{ failed: false }, { failed: true, error: undefined }, { failed: true, error: original }]) {
    for (const first of [null, { error: undefined }, { error: cleanup }]) {
      for (const second of [null, { error: undefined }, { error: cleanup }]) {
        const trace = [], expected = [];
        if (first || second) {
          if (primary.failed) expected.push(primary.error);
          if (first) expected.push(first.error);
          if (second) expected.push(second.error);
        }
        let failed = false, error;
        try {
          await cleanupFixture([
            () => { trace.push("first"); if (first) throw first.error; },
            async () => { trace.push("second"); if (second) throw second.error; },
          ], primary);
        } catch (caught) { failed = true; error = caught; }
        assert.deepEqual(trace, ["first", "second"]);
        assert.equal(failed, expected.length > 0);
        if (expected.length === 1) assert.equal(error, expected[0]);
        if (expected.length > 1) {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, expected.length);
          expected.forEach((reason, index) => assert.equal(error.errors[index], reason));
        }
      }
    }
  }
});

test("fixture cleanup awaits each original operation before starting the next", async () => {
  const trace = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const pending = cleanupFixture([
    async () => { trace.push("first"); await held; trace.push("joined"); },
    () => { trace.push("second"); },
  ]);
  assert.deepEqual(trace, ["first"]);
  release();
  await pending;
  assert.deepEqual(trace, ["first", "joined", "second"]);
});
