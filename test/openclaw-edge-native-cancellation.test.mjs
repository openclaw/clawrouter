import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { cases } from "../scripts/edge-proof.mjs";
import { edgeProof, validatePlan } from "../scripts/edge-proof-profile.mjs";

export function parseSdkReceipts(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("edge-proof: child output capacity exceeded");
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("EDGE_PROOF_V1 ")) continue;
    if (Buffer.byteLength(line) > 768 || records.length === 8) throw new Error("edge-proof: receipt overflow");
    const record = JSON.parse(line.slice(14));
    const keys = ["version", "pin", "id", "api", "role", "body", "callerAborted", "partial", "operations", "leases", "errors", "joined"];
    if (!record || Object.keys(record).sort().join() !== keys.sort().join() || record.version !== 1 || record.pin !== edgeProof.sdkSha || !cases.some(row => row.id === record.id && row.api === record.api && row.role === record.role) || ["body", "partial", "joined"].some(key => typeof record[key] !== "boolean") || typeof record.callerAborted !== "boolean" || ["operations", "leases", "errors"].some(key => !Number.isSafeInteger(record[key]) || record[key] < 0 || record[key] > 256)) throw new Error("edge-proof: invalid closed SDK receipt");
    if (records.some(row => row.id === record.id)) throw new Error("edge-proof: duplicate SDK receipt");
    records.push(record);
  }
  return records;
}
export async function readBoundedJson(response) {
  if (!response.body) throw new Error("edge-proof: missing control response");
  const reader = response.body.getReader(), closed = reader.closed, errors = [], chunks = [];
  void closed.catch(() => {});
  let length = 0, complete = false;
  try {
    while (true) { const next = await reader.read(); if (next.done) { complete = true; break; } length += next.value.length; if (length > 32768) throw new Error("edge-proof: control response overflow"); chunks.push(next.value); }
  } catch (error) { errors.push(error); }
  if (!complete) try { await reader.cancel(); } catch (error) { errors.push(error); }
  try { await closed; } catch (error) { errors.push(error); }
  try { reader.releaseLock(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "edge-proof: original control body and cleanup failed");
  if (response.status !== 200) throw new Error("edge-proof: control refused");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
export function acceptCase(row, sdk, worker, upstream, accounting, helperFulfilled) {
  assert.equal(helperFulfilled, true);
  assert.equal(sdk.id, row.id); assert.equal(sdk.body, true); assert.equal(sdk.joined, true); assert.equal(sdk.errors, 0);
  const expected = row.role === "preabort" ? ["catalog"] : ["catalog", "inference"];
  assert.deepEqual(Object.keys(worker).sort(), expected.map(kind => "record/" + kind).sort());
  for (const kind of expected) {
    const proof = worker["record/" + kind];
    assert.equal(proof.id, row.id); assert.equal(proof.invalid, false); assert.equal(proof.overflow, false);
    assert.equal(proof.strict, true); assert.equal(proof.unlocked, true);
    assert.equal(proof.fetches.length, 1); assert.equal(proof.fetches[0].exact, true); assert.equal(typeof proof.fetches[0].effectiveAtInvoke, "boolean");
    assert.ok(["HTTP/1.0", "HTTP/1.1", "HTTP/2", "HTTP/3"].includes(proof.protocol));
    assert.ok(Array.isArray(proof.records) && proof.records.length > 0 && proof.records.every(record => record.state === "fulfilled"));
    assert.equal(upstream["claim/" + kind], true);
    assert.equal(upstream["report/" + kind]?.calls, 1);
    assert.equal(upstream["report/" + kind]?.expired, false);
  }
  if (row.role === "partial_abort") {
    assert.equal(sdk.callerAborted, true); assert.equal(sdk.partial, true);
    assert.equal(worker["record/inference"].ingressAborted, true);
    const source = upstream["report/inference"];
    assert.equal(source.canceled, true); assert.equal(source.cancelSettled, true); assert.equal(source.timerState, "rejected"); assert.equal(source.invalid, false);
  }
  if (row.role === "preabort") { assert.equal(upstream["claim/inference"], undefined); assert.equal(sdk.callerAborted, true); }
  if (row.role === "eof" || row.role === "provider_error") assert.equal(sdk.callerAborted, false);
  const events = accounting.usage.events;
  assert.equal(events.length, expected.length);
  for (const event of events) {
    assert.equal(event.provider, "litellm"); assert.equal(event.credential_id, row.id); assert.equal(event.policy_id, row.id);
    if (event.capability === "models.list") { assert.equal(event.cost_basis, "none"); assert.equal(event.reserved_cost_micros, 0); assert.equal(event.actual_cost_micros, 0); }
    else { assert.equal(event.reserved_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.model, "litellm/tenant/edge-proof"); assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null); assert.equal(event.actual_cost_micros, 7); if (row.role === "partial_abort") assert.equal(event.status, "client_error"); }
  }
  assert.equal(accounting.budget.spentMicros, row.role === "preabort" ? 0 : 7);
}

const execute = process.env.CLAWROUTER_EDGE_PROOF_EXECUTE === "1";
test("actual registered LiteLLM four controls per API on the isolated edge candidate", { skip: !execute, timeout: 300000 }, async t => {
  assert.equal(process.env.CI, "true", "ephemeral native SDK execution only");
  const plan = validatePlan(JSON.parse(await readFile(process.env.CLAWROUTER_EDGE_PROOF_PLAN, "utf8")));
  const authorityFile = process.env.CLAWROUTER_EDGE_PROOF_AUTHORITY_FILE;
  const metadata = await stat(authorityFile); assert.equal(metadata.mode & 0o077, 0);
  const authority = JSON.parse(await readFile(authorityFile, "utf8"));
  assert.deepEqual(authority.cases.map(({ id, api, role }) => ({ id, api, role })), cases);
  const receipts = [], failures = []; let helperFulfilled = false;
  try {
    await runOpenClawConsumer({ diagnostic(text) { receipts.push(...parseSdkReceipts(text)); } }, {
      source: process.env.CLAWROUTER_OPENCLAW_CHECKOUT, sourceHead: edgeProof.sdkSha,
      fixture: new URL("./fixtures/openclaw-edge-native-cancellation-contract.test.ts", import.meta.url),
      testPath: "extensions/litellm/edge-native-cancellation-contract.test.ts",
      env: { CLAWROUTER_EDGE_PROOF_SOURCE_HEAD: edgeProof.sdkSha, CLAWROUTER_EDGE_PROOF_ORIGIN: plan.edgeOrigin, CLAWROUTER_EDGE_PROOF_ADMIN: authority.admin,
        CLAWROUTER_EDGE_PROOF_CASES: JSON.stringify(authority.cases.map(({ upstream: _upstream, ...row }) => row)) },
    });
    helperFulfilled = true;
  } catch (error) { failures.push(error); }
  for (const row of authority.cases) {
    try {
      const control = async (origin, action) => readBoundedJson(await fetch(`${origin}/__proof/${action}/${row.id}`, { method: "POST", headers: { authorization: "Bearer " + row.control }, redirect: "error", signal: AbortSignal.timeout(15000) }));
      const worker = await control(plan.edgeOrigin, "state"), upstream = await control(plan.upstreamOrigin, "state"), accounting = await control(plan.edgeOrigin, "usage");
      const receipt = receipts.filter(record => record.id === row.id); assert.equal(receipt.length, 1);
      acceptCase(row, receipt[0], worker, upstream, accounting, helperFulfilled);
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "edge proof or independent original retirement failed");
  assert.equal(receipts.length, 8);
  t.diagnostic("8 genuine controls; instrumented frozen candidate; actual protocol recorded; no deployment or teardown credit");
});
