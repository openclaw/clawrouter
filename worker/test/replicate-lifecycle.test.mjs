import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseReplicatePrediction,
  prepareReplicateCreate,
  readReplicatePrediction,
  replicateCancelAfter,
  replicateControlPath,
  rewriteReplicatePredictionUrls,
  validateReplicatePredictionId,
  REPLICATE_MAX_PREDICTION_BYTES,
} from "../replicate-lifecycle.ts";

const fixture = JSON.parse(await readFile(new URL("../../providers/_fixtures/replicate/prediction-lifecycle.json", import.meta.url), "utf8"));
const id = fixture.responses.created.id;
const parse = (body, expectedId = id) => parseReplicatePrediction(JSON.stringify(body), expectedId);
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

test("native create stays async, rejects callbacks and leaves credentials to the bound runtime", () => {
  const prepared = prepareReplicateCreate(fixture.request.body, new Headers({
    Prefer: "wait=60", "Idempotency-Key": "synthetic-key", Authorization: "Bearer synthetic-token",
  }));
  assert.deepEqual(prepared.body, fixture.request.body);
  assert.equal(prepared.requestedVersion, fixture.request.body.version);
  assert.deepEqual(Object.fromEntries(prepared.headers), {
    "cancel-after": "600s", "content-type": "application/json",
  });
  for (const field of ["webhook", "webhook_events_filter", "stream"]) {
    assert.throws(() => prepareReplicateCreate({ ...fixture.request.body, [field]: null }), /replicate_polling_only/);
  }
  for (const body of [null, [], {}, { version: "", input: {} }, { version: fixture.request.body.version, input: [] }]) {
    assert.throws(() => prepareReplicateCreate(body), /invalid_replicate_create/);
  }
});

test("Cancel-After accepts bounded native durations and clamps to ten minutes", () => {
  for (const [input, expected] of [[null, "600s"], ["30", "30s"], ["5s", "5s"], ["5m", "300s"], ["1m30s", "90s"], ["2h30m", "600s"]]) {
    assert.equal(replicateCancelAfter(input), expected);
  }
  for (const input of ["", "0", "4s", "-5", "1.5s", "NaN", "10ms", "5s1h", "5s5s", "99999999999999999999999999999999999s"]) {
    assert.throws(() => replicateCancelAfter(input), /invalid_replicate_cancel_after/);
  }
});

test("partial output and cancellation acknowledgement do not create terminal evidence", () => {
  for (const name of ["created", "partial", "cancelAcknowledgedButOpen"]) {
    const { observation } = parse(fixture.responses[name]);
    assert.equal(observation.terminal, false, name);
    assert.deepEqual(Object.keys(observation).sort(), ["id", "predictTimeSeconds", "status", "terminal", "version"]);
  }
  assert.equal(parse(fixture.responses.partial).body.output[0], "https://media.example/partial.png");
});

test("terminal evidence preserves native runtime usage without manufacturing costs or free failures", () => {
  for (const name of ["succeeded", "failed", "canceled", "aborted"]) {
    assert.equal(parse(fixture.responses[name]).observation.terminal, true);
  }
  assert.equal(parse(fixture.responses.succeeded).observation.predictTimeSeconds, 2.5);
  assert.equal(parse(fixture.responses.canceled).observation.predictTimeSeconds, 1.75);
  assert.equal(parse(fixture.responses.failed).observation.predictTimeSeconds, null);
  assert.equal(fixture.billing.actualProviderCostMicrousd, null);
  const removed = parse(fixture.responses.dataRemoved);
  assert.equal(removed.observation.terminal, true);
  assert.equal(removed.body.output, null);
  assert.equal(removed.observation.predictTimeSeconds, 2.5);
});

test("unknown statuses and mismatched IDs cannot settle another prediction", () => {
  assert.throws(() => parse(fixture.responses.mismatchedId), /replicate_prediction_id_mismatch/);
  for (const status of ["completed", "SUCCEEDED", "", null, {}]) {
    assert.throws(() => parse({ ...fixture.responses.created, status }), /unsupported_replicate_prediction_status/);
  }
  for (const seconds of [-1, "2.5", {}, null]) {
    const body = { ...fixture.responses.succeeded, metrics: { predict_time: seconds } };
    if (seconds === null) assert.equal(parse(body).observation.predictTimeSeconds, null);
    else assert.throws(() => parse(body), /invalid_replicate_prediction_metrics/);
  }
  assert.throws(() => parseReplicatePrediction('{"id":"prediction_fixture_001","status":"succeeded","metrics":{"predict_time":1e999}}'), /invalid_replicate_prediction_metrics/);
});

test("deadline abortion without metrics closes observation without inventing a zero-cost receipt", async () => {
  const before = parse(fixture.responses.created).observation;
  assert.equal(before.terminal, false);
  const after = (await readReplicatePrediction(response(fixture.responses.aborted), id)).observation;
  assert.equal(after.status, "aborted");
  assert.equal(after.terminal, true, "the collector must stop polling this known terminal job");
  assert.equal(after.predictTimeSeconds, null, "absent usage is not a measured zero");
  assert.equal(after.version, fixture.request.body.version);
  assert.equal(Object.hasOwn(after, "actualCostMicrousd"), false);
  assert.equal(fixture.billing.actualProviderCostMicrousd, null);
  assert.equal(fixture.billing.basis, "policy_fixed");
  assert.equal(fixture.billing.fixturePolicyRequestMicrousd, 700);
});

test("control paths use trusted templates and bounded IDs, never supplied URLs", () => {
  assert.equal(replicateControlPath("/v1/predictions/${prediction_id}", id), fixture.controls.get.path);
  assert.equal(replicateControlPath("/v1/predictions/${prediction_id}/cancel", id), fixture.controls.cancel.path);
  for (const value of ["", "../other", "id?token=secret", "id#fragment", "%2fother", "a/b", "a\\b", "☃", "x".repeat(129), 12]) {
    assert.throws(() => validateReplicatePredictionId(value), /invalid_replicate_prediction_id/);
  }
  assert.throws(() => replicateControlPath(fixture.responses.hostileUrls.urls.get, id), /invalid_replicate_control_path/);
  assert.equal(validateReplicatePredictionId("x".repeat(128)).length, 128);
});

test("bound delivery replaces all control URLs while leaving output data transient and unchanged", () => {
  const parsed = parse(fixture.responses.hostileUrls);
  const routerPaths = { get: `/replicate/v1/predictions/${id}`, cancel: `/replicate/v1/predictions/${id}/cancel` };
  const rewritten = rewriteReplicatePredictionUrls(parsed, routerPaths);
  assert.deepEqual(rewritten.urls, routerPaths);
  assert.equal(parsed.body.urls.stream, "https://untrusted.example/steal");
  const final = parse(fixture.responses.succeeded);
  assert.deepEqual(rewriteReplicatePredictionUrls(final, routerPaths).output, final.body.output);
  for (const get of ["//untrusted.example/job", "https://untrusted.example/job", "/route?token=secret", "/../job", "/route\\job"]) {
    assert.throws(() => rewriteReplicatePredictionUrls(parsed, { ...routerPaths, get }), /invalid_replicate_router_path/);
  }
});

test("response parsing accepts immediate terminal create and matching cancel observations", async () => {
  assert.equal((await readReplicatePrediction(response(fixture.responses.succeeded), id)).observation.terminal, true);
  assert.equal((await readReplicatePrediction(response(fixture.responses.cancelAcknowledgedButOpen), id)).observation.terminal, false);
  await assert.rejects(readReplicatePrediction(new Response(null, { status: 202 }), id), /invalid_replicate_prediction_response/);
  await assert.rejects(readReplicatePrediction(response({ detail: "missing" }, 404), id), /invalid_replicate_prediction_response/);
  await assert.rejects(readReplicatePrediction(response(fixture.responses.mismatchedId), id), /replicate_prediction_id_mismatch/);
});

test("truncated or malformed envelopes cannot turn a partial delivery into success", async () => {
  for (const body of ["", "null", "[]", '{"id":"prediction_fixture_001","status":"succeeded"']) {
    await assert.rejects(readReplicatePrediction(new Response(body, { headers: { "Content-Type": "application/json" } }), id), /invalid_replicate_prediction/);
  }
  await assert.rejects(readReplicatePrediction(new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }), id), /incomplete_replicate_prediction_response/);
});

test("streamed response size is bounded even when Content-Length is absent or false", async () => {
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(REPLICATE_MAX_PREDICTION_BYTES + 1)); },
    cancel() { canceled = true; },
  });
  await assert.rejects(readReplicatePrediction(new Response(body, { headers: { "Content-Type": "application/json", "Content-Length": "1" } }), id), /incomplete_replicate_prediction_response/);
  assert.equal(canceled, true);
  assert.throws(() => parseReplicatePrediction("é".repeat(REPLICATE_MAX_PREDICTION_BYTES / 2 + 1)), /replicate_prediction_too_large/);
});

test("stream failure is sanitized and never treated as a completed prediction", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("synthetic private content")); } });
  await assert.rejects(readReplicatePrediction(new Response(body, { headers: { "Content-Type": "application/json" } }), id), (error) => {
    assert.equal(error.message, "incomplete_replicate_prediction_response");
    return true;
  });
});
