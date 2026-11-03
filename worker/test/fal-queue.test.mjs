import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { falQueuePaths, parseFalCancelAcknowledgement, parseFalQueueObservation, parseFalResult, parseFalSubmission, prepareFalQueueSubmit, validateFalRequestId, FAL_MAX_ENVELOPE_BYTES } from "../fal-queue.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/queue-lifecycle.json", import.meta.url), "utf8"));
const parse = (body, id = wire.requestId) => parseFalQueueObservation(JSON.stringify(body), id);

test("fal controls strip model subpaths and never use response-supplied URLs", () => {
  const paths = falQueuePaths(wire.endpointId, wire.requestId);
  assert.equal(paths.submit, wire.submit.path);
  for (const name of ["status", "result", "cancel"]) assert.equal(paths[name], wire.controls[name].path);
  assert.equal(parse(wire.observations.hostileUrls).id, wire.requestId);
  assert.equal(Object.hasOwn(parse(wire.observations.hostileUrls), "status_url"), false);
  for (const id of ["", "../escape", "owner/app?fal_webhook=x", "owner/app%2fother", "owner/app/../other", "https://untrusted.example/model", "a/b/".repeat(90)]) {
    assert.throws(() => falQueuePaths(id, wire.requestId), /invalid_fal_endpoint_id/);
  }
  for (const id of ["", "../job", "id%2fother", "id?x=1", "x".repeat(129), 42]) {
    assert.throws(() => validateFalRequestId(id), /invalid_fal_request_id/);
  }
});

test("fal polling submission does not forward callback or retry-policy overrides", () => {
  const submit = prepareFalQueueSubmit(wire.endpointId);
  assert.equal(submit.method, "POST");
  assert.equal(submit.path, wire.submit.path);
  assert.deepEqual(Object.fromEntries(submit.headers), {
    "content-type": "application/json", "x-fal-no-retry": "1", "x-fal-request-start-timeout": "600",
  });
  for (const query of ["fal_webhook=https://untrusted.example/hook", "fal_max_queue_length=0"]) {
    assert.throws(() => prepareFalQueueSubmit(wire.endpointId, new URLSearchParams(query)), /unsupported_fal_queue_query/);
  }
  assert.equal(parseFalSubmission(JSON.stringify({ request_id: wire.requestId })).id, wire.requestId);
});

test("fal COMPLETED is result readiness and can include a failed model run", () => {
  for (const name of ["queued", "running"]) {
    assert.equal(parse(wire.observations[name]).queueTerminal, false);
    assert.equal(parse(wire.observations[name]).resultRequired, false);
  }
  for (const name of ["completed", "failed"]) {
    assert.equal(parse(wire.observations[name]).queueTerminal, true);
    assert.equal(parse(wire.observations[name]).resultRequired, true);
  }
  assert.equal(parse(wire.observations.failed).failed, true);
  assert.equal(Object.hasOwn(parse(wire.observations.failed), "error"), false);
  assert.equal(parse(wire.observations.completed).inferenceTimeSeconds, 2.5);
  assert.equal(parse(wire.observations.failed).inferenceTimeSeconds, null);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
});

test("fal cancel acknowledgements distinguish removal, in-progress signal, completion race and unknown ownership", () => {
  for (const { httpStatus, body, ...expected } of wire.cancelAcks) {
    assert.deepEqual(parseFalCancelAcknowledgement(httpStatus, JSON.stringify(body)), expected);
  }
  assert.equal(parseFalCancelAcknowledgement(202, '{"status":"CANCELLATION_REQUESTED"}').queueTerminal, false);
  assert.equal(parse(wire.observations.completed).queueTerminal, true, "completion can still follow accepted cancellation");
  for (const [code, status] of [[200, "CANCELLATION_REQUESTED"], [202, "OK"], [500, "OK"], [200, "CANCELED"]]) {
    assert.throws(() => parseFalCancelAcknowledgement(code, JSON.stringify({ status })), /invalid_fal_cancel_acknowledgement/);
  }
});

test("fal result keeps model-specific media transient and distinguishes HTTP error from queue completion", () => {
  for (const [name, expected] of [["success", true], ["failed", false]]) {
    const { body, httpStatus } = wire.results[name];
    const result = parseFalResult(JSON.stringify(body), httpStatus);
    assert.equal(result.httpSucceeded, expected);
    assert.deepEqual(result.body, body);
  }
  assert.equal(parseFalResult('{"error":"synthetic"}', 200).httpSucceeded, false);
  assert.throws(() => parseFalResult("{}", 302), /invalid_fal_result_status/);
});

test("fal malformed, oversized and mismatched observations cannot settle another request", () => {
  assert.throws(() => parse({ ...wire.observations.completed, request_id: "another_job" }), /fal_request_id_mismatch/);
  for (const status of ["SUCCEEDED", "CANCELED", "", null]) {
    assert.throws(() => parse({ ...wire.observations.completed, status }), /unsupported_fal_queue_status/);
  }
  for (const metrics of [[], { inference_time: -1 }, { inference_time: "2.5" }]) {
    assert.throws(() => parse({ ...wire.observations.completed, metrics }), /invalid_fal_metrics/);
  }
  assert.throws(() => parse({ ...wire.observations.running, error: "synthetic" }), /invalid_fal_error/);
  for (const text of ["{", "null", "[]"]) assert.throws(() => parseFalQueueObservation(text), /invalid_fal_envelope/);
  assert.throws(() => parseFalQueueObservation("é".repeat(FAL_MAX_ENVELOPE_BYTES / 2 + 1)), /fal_envelope_too_large/);
});
