import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRecordedRepairRequest } from "./fusion-replay-feedback.mjs";

const warning = pid => `# (node:${pid}) [UNDICI-ES] Warning: EventSource is experimental, expect them to change at any time.`;
function request(pid = 159, extra = {}) {
  return { id: "task/cheap-repair", arm: "cheap-repair", model: "small", body: {
    model: "small", max_output_tokens: 4096, input: [
      { role: "system", content: "repair" }, { role: "user", content: "original" },
      { role: "user", content: JSON.stringify({ instruction: "repair original", candidate: [{ path: "source.js", content: "return 160" }],
        acceptance: { runtimePassed: false, compilerPassed: true, feedback: `${warning(pid)}\nnot ok 1 - keeps 160\nexpected: 160\nactual: 159`, ...extra } }) },
    ],
  } };
}

test("restores recorded bytes for only an EventSource warning PID change", () => {
  const actual = request(159), recorded = request(160), before = structuredClone(actual);
  const result = reconcileRecordedRepairRequest(actual, recorded);
  assert.deepEqual(result, { request: recorded, substituted: true, warnings: 1 });
  assert.deepEqual(actual, before);
  assert.notEqual(result.request, recorded);
  assert.deepEqual(reconcileRecordedRepairRequest(recorded, recorded), { request: recorded, substituted: false, warnings: 0 });
});

test("preserves verdicts, diagnostics, source, model settings and message framing", () => {
  const recorded = request(160);
  const edits = [
    r => { r.model = "strong"; }, r => { r.body.max_output_tokens = 8192; },
    r => { r.body.input[1].content = "other original"; },
    r => { r.body.input[2].role = "assistant"; },
    r => { const p = JSON.parse(r.body.input[2].content); p.acceptance.runtimePassed = true; r.body.input[2].content = JSON.stringify(p); },
    r => { r.body.input[2].content = r.body.input[2].content.replace("return 160", "return 159"); },
    r => { r.body.input[2].content = r.body.input[2].content.replace("expected: 160", "expected: 159"); },
    r => { r.body.input[2].content = r.body.input[2].content.replace("EventSource is experimental", "EventSource broke"); },
    r => { r.body.input[2].content = " " + r.body.input[2].content; },
  ];
  for (const edit of edits) {
    const actual = request(159); edit(actual);
    assert.throws(() => reconcileRecordedRepairRequest(actual, recorded), /recorded_repair_/);
  }
});

test("does not normalize similar prefixes or PID-like assertion values", () => {
  for (const prefix of ["node:", "# (node:0)", "# (node:-1)", "# (node:1) [OTHER] Warning:"]) {
    const a = request(159), b = request(160);
    a.body.input[2].content = a.body.input[2].content.replace(warning(159), prefix + " 159");
    b.body.input[2].content = b.body.input[2].content.replace(warning(160), prefix + " 160");
    assert.throws(() => reconcileRecordedRepairRequest(a, b), /recorded_repair_request_mismatch/);
  }
});
