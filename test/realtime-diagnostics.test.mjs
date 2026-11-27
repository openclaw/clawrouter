import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeLedger, parseRealtimeDiagnostic, realtimeDiagnosticText } from "../scripts/realtime-diagnostics.mjs";

const realtimeBoundary = () => ({ v: 1, kind: "realtime_boundary", case: "r01", operation: "assert_elapsed", failurePresent: true, reasonDefined: false, unreportedCases: 0 });

test("inert realtime deadline durations preserve unavailable close observations", () => {
  const rows = [], ledger = createRealtimeLedger("r01", text => rows.push(parseRealtimeDiagnostic(text)));
  ledger.timing(0, 1000); ledger.body(true, undefined); ledger.flush();
  assert.equal(rows[0].receiverMs, null); assert.equal(rows[0].clientCloseMs, null);
  assert.equal(rows[0].closeMs, 1000);
  assert.deepEqual(parseRealtimeDiagnostic(realtimeDiagnosticText(realtimeBoundary())), realtimeBoundary());
});
test("inert realtime deadline duration schema rejects unsafe and inconsistent values", () => {
  const timed = { ...realtimeBoundary(), mutationMs: 12, closeMs: 321, receiverMs: 300, clientCloseMs: 21 };
  for (const bad of [NaN, Infinity, -1, 0.5, 1000001, "321", {}, null]) {
    assert.throws(() => realtimeDiagnosticText({ ...timed, closeMs: bad }));
    assert.throws(() => realtimeDiagnosticText({ ...timed, mutationMs: bad }));
  }
  for (const change of [{ receiverMs: null }, { clientCloseMs: null }, { clientCloseMs: 22 }, { receiverMs: -1 }, { receiverMs: "300" }]) {
    assert.throws(() => realtimeDiagnosticText({ ...timed, ...change }));
  }
  const partial = { ...timed }; delete partial.mutationMs;
  assert.throws(() => realtimeDiagnosticText(partial));
  let touched = false;
  Object.defineProperty(timed, "closeMs", { get() { touched = true; return 321; } });
  assert.throws(() => realtimeDiagnosticText(timed)); assert.equal(touched, false);
});
