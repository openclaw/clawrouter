import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { edgeProof, validatePlan, renderEdgeConfig } from "../scripts/edge-proof-profile.mjs";
import { cases, newRuntimeAuthority, secretProjections, teardownGuard } from "../scripts/edge-proof.mjs";
import { deploymentTarget, assertDeploymentMutation } from "../scripts/deployment-profile.mjs";
import { parseSdkReceipts, readBoundedJson } from "./openclaw-edge-native-cancellation.test.mjs";

const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { transform } = require("esbuild");
function plan(now = Date.now()) {
  return { environment: "edge-proof", sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, accountId: "a".repeat(32), runId: "b".repeat(32), createdAt: now - 1, expiresAt: now + 300000,
    edgeOrigin: "https://clawrouter-edge-proof.synthetic.workers.dev", upstreamOrigin: "https://clawrouter-upstream-proof.synthetic.workers.dev",
    resources: { workerName: edgeProof.workerName, upstreamWorkerName: edgeProof.upstreamWorkerName, policyKvNamespace: edgeProof.policyKvNamespace, policyKvId: "1".repeat(32), queueName: edgeProof.queueName, queueId: "2".repeat(32), queueDlqName: edgeProof.queueDlqName, queueDlqId: "3".repeat(32) },
    custody: { owner: "offline-unit", accountId: "a".repeat(32), resourceNames: [edgeProof.workerName, edgeProof.upstreamWorkerName, edgeProof.policyKvNamespace, edgeProof.queueName, edgeProof.queueDlqName], exclusive: true, nonproduction: true, observedAt: now - 1 } };
}
test("edge plan requires exact explicit source and all isolated resource identities", () => {
  const valid = plan(); assert.deepEqual(validatePlan(valid), valid);
  for (const key of Object.keys(valid)) { const missing = structuredClone(valid); delete missing[key]; assert.throws(() => validatePlan(missing), key); }
  for (const mutate of [p => { p.sourceSha = "0".repeat(40); }, p => { p.sourceTree = "0".repeat(40); }, p => { p.environment = "production"; }, p => { p.resources.workerName = "clawrouter-edge"; }, p => { p.resources.queueId = p.resources.queueDlqId; }, p => { p.custody.exclusive = false; }, p => { p.custody.accountId = "c".repeat(32); }, p => { p.expiresAt = Date.now() - 1; }, p => { p.custody.observedAt = 0; }, p => { p.edgeOrigin = "https://clawrouter.openclaw.ai"; }, p => { p.upstreamOrigin = p.edgeOrigin; }, p => { p.extra = "forbidden"; }]) { const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => validatePlan(invalid)); }
  assert.throws(() => deploymentTarget({ CLAWROUTER_DEPLOY_ENV: "edge-proof" }));
  assert.throws(() => assertDeploymentMutation({ environment: "edge-proof" }));
});
test("proof projections exclude production assets, cron, R2 and containers", () => {
  const value = plan();
  for (const kind of ["edge", "upstream"]) {
    const text = renderEdgeConfig(value, kind, `${kind}.mjs`);
    assert.match(text, /no_bundle = true/); assert.match(text, /enable_request_signal/);
    assert.doesNotMatch(text, /\[assets\]|\[triggers\]|r2_buckets|\[\[containers\]\]|\[build\]|clawrouter-content|clawrouter-usage"|fixture-secret/);
  }
  assert.throws(() => renderEdgeConfig(value, "edge", "../worker.mjs"));
  assert.throws(() => renderEdgeConfig(value, "production", "edge.mjs"));
});
test("new authorities are unpredictable, distinct and limited to eight fresh roles", () => {
  const first = newRuntimeAuthority(), second = newRuntimeAuthority();
  const tokens = value => [value.admin, ...value.cases.flatMap(row => [row.proxy, row.control, row.upstream])];
  assert.equal(new Set([...tokens(first), ...tokens(second)]).size, 50);
  assert.ok(tokens(first).every(token => /^[a-f0-9]{64}$/.test(token)));
  assert.deepEqual(first.cases.map(({ id, api, role }) => ({ id, api, role })), cases);
  assert.equal(cases.length, 8);
  const projections = secretProjections(first);
  assert.ok(!projections.upstream.includes(first.admin) && !projections.upstream.includes(first.cases[0].proxy));
  assert.ok(!projections.sdk.includes(first.cases[0].upstream) && !projections.sdk.includes(first.admin));
  assert.throws(() => secretProjections({ ...first, cases: first.cases.slice(1) }));
});
test("teardown guard denies missing original joins, revocation, queue drain and foreign references", () => {
  const value = plan(), proof = { runId: value.runId, sourceSha: edgeProof.sourceSha, accountId: value.accountId, resources: value.resources, observedAt: Date.now(), allOriginalsJoined: true, syntheticCredentialsRevoked: true, usageQueueDrained: true, deadLetterQueueDrained: true, noForeignReferences: true, separateDestructiveLease: true, pending: 0, failedCleanup: 0 };
  assert.equal(teardownGuard(value, proof).deletionExecuted, false);
  for (const key of Object.keys(proof)) { const missing = { ...proof }; delete missing[key]; assert.throws(() => teardownGuard(value, missing)); }
});
test("closed SDK receipts reject foreign pins, duplicates, payload fields and overflow", () => {
  const row = cases[0], record = { version: 1, pin: edgeProof.sdkSha, ...row, body: true, callerAborted: false, partial: false, operations: 10, leases: 2, errors: 0, joined: true };
  const line = "EDGE_PROOF_V1 " + JSON.stringify(record);
  assert.equal(parseSdkReceipts("untrusted child output ignored\n" + line)[0].id, row.id);
  assert.deepEqual(parseSdkReceipts("no owned records"), []);
  assert.throws(() => parseSdkReceipts(line + "\n" + line));
  for (const invalid of [{ ...record, pin: "f".repeat(40) }, { ...record, message: "not permitted" }, { ...record, operations: null }, { ...record, id: "unknown" }]) assert.throws(() => parseSdkReceipts("EDGE_PROOF_V1 " + JSON.stringify(invalid)));
  assert.throws(() => parseSdkReceipts("EDGE_PROOF_V1 " + "x".repeat(768)));
});
test("control collector retains original undefined rejection and independently fails cleanup", async () => {
  let canceled = 0, unlocked = 0;
  const closed = Promise.reject(undefined); void closed.catch(() => {});
  const response = { status: 200, body: { getReader: () => ({ closed, read: () => Promise.reject(undefined), cancel: () => { canceled++; return Promise.reject(null); }, releaseLock: () => { unlocked++; throw false; } }) } };
  await assert.rejects(readBoundedJson(response), error => error instanceof AggregateError && error.errors.length === 4 && error.errors[0] === undefined && error.errors[1] === null && error.errors[2] === undefined && error.errors[3] === false);
  assert.equal(canceled, 1); assert.equal(unlocked, 1);
  assert.deepEqual(await readBoundedJson(Response.json({ safe: true })), { safe: true });
});
test("actual SDK original-operation drain observes work registered during earlier joins", async () => {
  const source = await readFile(new URL("./fixtures/openclaw-edge-native-cancellation-contract.test.ts", import.meta.url), "utf8");
  const start = source.indexOf("function raise("), end = source.indexOf("\nfunction observeBody(");
  assert.ok(start >= 0 && end > start);
  const code = await transform(source.slice(start, end) + "\nexport {drainOriginals};", { loader: "ts", format: "esm", target: "es2022" });
  const { drainOriginals } = await import("data:text/javascript;base64," + Buffer.from(code.code).toString("base64"));
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const records = [{ kind: "closed", original: first.promise }]; let finished = false;
  const joined = drainOriginals(records).finally(() => { finished = true; });
  records.push({ kind: "cancel", original: second.promise }); first.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false);
  second.reject(undefined);
  let caught = false; try { await joined; } catch (error) { caught = true; assert.equal(error, undefined); } assert.equal(caught, true);
  const acquisition = Promise.withResolvers(), release = Promise.withResolvers(), close = Promise.withResolvers();
  const lateOperations = [{ kind: "acquisition", original: acquisition.promise }], leases = [];
  let retired = false;
  const lateJoin = drainOriginals(lateOperations, leases).then(() => { retired = true; });
  leases.push({ released: release.promise }); acquisition.resolve();
  await Promise.resolve(); await Promise.resolve(); assert.equal(retired, false);
  lateOperations.push({ kind: "dispatcher", original: close.promise }); release.resolve();
  await Promise.resolve(); await Promise.resolve(); assert.equal(retired, false);
  close.resolve(null); await lateJoin; assert.equal(retired, true);
});
test("actual authority initialization places all eight cases before global fences", async () => {
  const source = await readFile(new URL("../worker/fixtures/edge-native-cancellation.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function initializeProofAuthorities("), end = source.indexOf("\nexport class ProofRecords");
  assert.ok(start >= 0 && end > start);
  const code = await transform(source.slice(start, end), { loader: "ts", format: "cjs", target: "es2022" });
  const inserted = new Map(), calls = [], authority = newRuntimeAuthority();
  const call = async (_env, path, entries) => { calls.push(path); if (!inserted.has(path)) inserted.set(path, entries); };
  const hash = async text => createHash("sha256").update(text).digest("hex");
  const exports = { exports: {} };
  new Function("module", "authorityCall", "sha256Hex", code.code)(exports, call, hash);
  const env = { EDGE_PROOF_RUN: "b".repeat(32) };
  await exports.exports.initializeProofAuthorities(env, authority);
  await exports.exports.initializeProofAuthorities(env, authority);
  assert.deepEqual(calls, ["/policies/initialize-all", "/credentials/initialize-all", "/connections/initialize-all", "/policies/initialize-all", "/credentials/initialize-all", "/connections/initialize-all"]);
  const policies = inserted.get("/policies/initialize-all"), credentials = inserted.get("/credentials/initialize-all");
  assert.deepEqual(policies.map(row => row.policyId), cases.map(row => row.id));
  assert.deepEqual(credentials.map(row => row.credentialId), cases.map(row => row.id));
  for (const [index, row] of credentials.entries()) {
    assert.equal(row.credential.secretSha256, await hash(authority.cases[index].proxy));
    assert.equal(row.credential.policyGeneration, env.EDGE_PROOF_RUN);
    assert.equal(policies[index].policy.requestCostMicros, 7);
    assert.equal(policies[index].policy.grantRouting.environmentFallback, false);
  }
  const originalFailure = undefined; let caught = false, invoked = 0;
  const failing = { exports: {} };
  new Function("module", "authorityCall", "sha256Hex", code.code)(failing, async () => { invoked++; throw originalFailure; }, hash);
  try { await failing.exports.initializeProofAuthorities(env, authority); } catch (error) { caught = true; assert.equal(error, originalFailure); }
  assert.equal(caught, true); assert.equal(invoked, 1);
});
