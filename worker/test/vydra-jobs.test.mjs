import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseVydraCancelAcknowledgement, parseVydraJob, parseVydraResult, parseVydraSubmission, prepareVydraJob, validateVydraJobId, vydraJobPath, VYDRA_MAX_ENVELOPE_BYTES } from "../vydra-jobs.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/vydra/jobs.json", import.meta.url), "utf8"));
const id = wire.submission.id;
const parse = body => parseVydraJob(JSON.stringify(body), 200, id);

test("Vydra media submission preserves workflow input and rejects callback/Studio contracts", () => {
  assert.deepEqual(prepareVydraJob(wire.request.body), { body: wire.request.body, workflow: "generate_video" });
  assert.throws(() => prepareVydraJob({ ...wire.request.body, webhookUrl: null }), /vydra_polling_only/);
  for (const body of [null, {}, { workflow: "improve_prompt", input: {} }, { workflow: "generate_image", input: [] }]) {
    assert.throws(() => prepareVydraJob(body), /unsupported_vydra_workflow/);
  }
  assert.throws(() => parseVydraSubmission('{"data":{"runId":"studio_fixture","status":"running"}}', 202), /invalid_vydra_job_id/);
});

test("Vydra immediate completion still retrieves the original scoped job for output", () => {
  const submitted = parseVydraSubmission(JSON.stringify(wire.responses.completed), 201);
  assert.equal(submitted.observation.terminal, true);
  assert.equal(submitted.retrieveResult, true);
  assert.equal(vydraJobPath(submitted.observation.id), wire.read.path);
  assert.equal(Object.hasOwn(parseVydraSubmission(JSON.stringify(wire.submission), 201).observation, "_links"), false);
});

test("Vydra partial output remains running and only documented final states stop observation", () => {
  for (const name of ["pending", "partial"]) assert.equal(parse(wire.responses[name]).terminal, false);
  for (const name of ["completed", "failed", "cancelled"]) assert.equal(parse(wire.responses[name]).terminal, true);
  assert.throws(() => parseVydraResult(JSON.stringify(wire.responses.partial), 200, id), /vydra_result_not_completed/);
  assert.deepEqual(parseVydraResult(JSON.stringify(wire.responses.completed), 200, id), wire.responses.completed.output);
  const { output, ...rest } = wire.responses.completed;
  assert.deepEqual(parseVydraResult(JSON.stringify({ ...rest, result: output }), 200, id), output);
  assert.throws(() => parseVydraResult(JSON.stringify({ ...wire.responses.completed, result: {} }), 200, id), /ambiguous_vydra_result/);
});

test("Vydra cancel refund acknowledgement still observes execution and can race success", () => {
  const ack = parseVydraCancelAcknowledgement(JSON.stringify(wire.cancel.response), 200);
  assert.deepEqual(ack, { observeJob: true, refundApplied: true, refundedLedgerUnits: 150 });
  assert.equal(Object.hasOwn(ack, "terminal"), false);
  assert.equal(parse(wire.responses.completed).status, "completed");
  assert.equal(parse(wire.responses.cancelled).status, "cancelled");
  assert.throws(() => parseVydraCancelAcknowledgement('{"success":false}', 200), /vydra_cancel_not_acknowledged/);
  assert.throws(() => parseVydraCancelAcknowledgement(JSON.stringify(wire.cancel.response), 404), /vydra_request_rejected/);
});

test("Vydra native ledger units and refunds never become a fabricated dollar price", () => {
  assert.equal(parse(wire.responses.completed).chargedLedgerUnits, 150);
  const failed = parse(wire.responses.failed);
  assert.equal(failed.chargedLedgerUnits, null);
  assert.equal(failed.refundedLedgerUnits, 150);
  assert.equal(failed.refundStatus, "completed");
  assert.equal(Object.hasOwn(failed, "error"), false);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
  const absent = parseVydraCancelAcknowledgement('{"success":true}', 200);
  assert.equal(absent.refundApplied, null);
  assert.equal(absent.refundedLedgerUnits, null);
});

test("Vydra unknown statuses and missing/mismatched IDs cannot settle another job", () => {
  for (const bad of ["", "../other", "id?key=x", "%2fother", "x".repeat(129), 1]) {
    assert.throws(() => validateVydraJobId(bad), /invalid_vydra_job_id/);
  }
  assert.throws(() => parse({ ...wire.responses.completed, id: "another_job" }), /vydra_job_id_mismatch/);
  for (const status of ["error", "canceled", "COMPLETED", "", null]) {
    assert.throws(() => parse({ ...wire.responses.completed, status }), /unsupported_vydra_job_status/);
  }
});

test("Vydra invalid credit evidence and incomplete envelopes remain unknown", () => {
  for (const creditsCharged of [-1, 0.5, "150", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parse({ ...wire.responses.completed, creditsCharged }), /invalid_vydra_credit_units/);
  }
  for (const text of ["{", "[]", "null"]) assert.throws(() => parseVydraJob(text, 200, id), /invalid_vydra_envelope/);
  assert.throws(() => parseVydraJob("é".repeat(VYDRA_MAX_ENVELOPE_BYTES / 2 + 1), 200, id), /vydra_envelope_too_large/);
  assert.throws(() => parseVydraJob(JSON.stringify(wire.responses.completed), 302, id), /vydra_request_rejected/);
});
