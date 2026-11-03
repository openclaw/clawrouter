import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { kieTaskPath, parseKieResultUrls, parseKieSubmission, parseKieTask, prepareKieTask, validateKieTaskId, KIE_MAX_ENVELOPE_BYTES } from "../kie-jobs.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/jobs.json", import.meta.url), "utf8"));
const id = wire.submission.data.taskId;
const parse = (body) => parseKieTask(JSON.stringify(body), 200, id);

test("Kie create preserves native model input and refuses callbacks in the polling slice", () => {
  assert.deepEqual(prepareKieTask(wire.request.body), { body: wire.request.body, model: wire.request.body.model });
  assert.throws(() => prepareKieTask({ ...wire.request.body, callBackUrl: null }), /kie_polling_only/);
  for (const body of [null, {}, { model: "", input: {} }, { model: "kling-2.6/text-to-video", input: [] }]) {
    assert.throws(() => prepareKieTask(body), /invalid_kie_create/);
  }
  assert.deepEqual(parseKieSubmission(JSON.stringify(wire.submission), 200), { id });
});

test("Kie HTTP-200 API errors cannot become success or terminal free failures", () => {
  for (const name of ["authError", "foreignTask"]) {
    assert.throws(() => parse(wire.responses[name]), { message: "kie_request_rejected" });
    assert.throws(() => parseKieSubmission(JSON.stringify(wire.responses[name]), 200), /kie_request_rejected/);
  }
  assert.throws(() => parseKieTask(JSON.stringify(wire.responses.success), 503, id), /kie_request_rejected/);
  assert.throws(() => parse({ ...wire.responses.success, success: false }), /kie_request_rejected/);
  assert.throws(() => parse({ ...wire.responses.success, code: "200" }), /kie_request_rejected/);
});

test("Kie partial result URLs do not terminate polling and failed jobs need no metrics", () => {
  for (const name of ["waiting", "queuing", "partial"]) {
    assert.equal(parse(wire.responses[name]).terminal, false);
  }
  assert.throws(() => parseKieResultUrls(JSON.stringify(wire.responses.partial), 200, id), /kie_result_not_successful/);
  const failed = parse(wire.responses.failed);
  assert.equal(failed.terminal, true);
  assert.equal(failed.creditsConsumed, null);
  assert.equal(Object.hasOwn(failed, "failMsg"), false);
});

test("Kie success preserves native credits without inferring dollars or retaining media", () => {
  assert.deepEqual(parse(wire.responses.success), { id, state: "success", terminal: true, creditsConsumed: 50 });
  assert.deepEqual(parseKieResultUrls(JSON.stringify(wire.responses.success), 200, id), ["https://media.example/final.mp4"]);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
});

test("Kie status and result are bound to the original task ID", () => {
  assert.equal(kieTaskPath(id), wire.read.path);
  for (const bad of ["", "../other", "x&taskId=other", "x%26taskId=other", "x".repeat(129), 1]) {
    assert.throws(() => validateKieTaskId(bad), /invalid_kie_task_id/);
  }
  const other = { ...wire.responses.success, data: { ...wire.responses.success.data, taskId: "other_task" } };
  assert.throws(() => parse(other), /kie_task_id_mismatch/);
  assert.throws(() => parseKieResultUrls(JSON.stringify(other), 200, id), /kie_task_id_mismatch/);
});

test("Kie malformed nested result JSON and credential-bearing media URLs fail closed", () => {
  for (const resultJson of ["{", "[]", "{}", JSON.stringify({ resultUrls: [] }), JSON.stringify({ resultUrls: Array(65).fill("https://media.example/a") }), ...["javascript:alert(1)", "https://user:pass@media.example/file", "file:///tmp/output"].map(url => JSON.stringify({ resultUrls: [url] }))]) {
    const body = { ...wire.responses.success, data: { ...wire.responses.success.data, resultJson } };
    assert.throws(() => parseKieResultUrls(JSON.stringify(body), 200, id), /invalid_kie_/);
  }
});

test("Kie unknown states, invalid credits and incomplete envelopes remain unqualified", () => {
  for (const state of ["completed", "cancelled", "", null]) {
    assert.throws(() => parse({ ...wire.responses.success, data: { ...wire.responses.success.data, state } }), /unsupported_kie_task_state/);
  }
  for (const creditsConsumed of [-1, "50", {}]) {
    assert.throws(() => parse({ ...wire.responses.success, data: { ...wire.responses.success.data, creditsConsumed } }), /invalid_kie_credits/);
  }
  for (const text of ["{", "[]", "null"]) assert.throws(() => parseKieTask(text, 200, id), /invalid_kie_envelope/);
  assert.throws(() => parseKieTask("é".repeat(KIE_MAX_ENVELOPE_BYTES / 2 + 1), 200, id), /kie_envelope_too_large/);
});
