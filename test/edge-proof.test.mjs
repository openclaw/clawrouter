import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { edgeProof, validatePlan, renderEdgeConfig } from "../scripts/edge-proof-profile.mjs";
import { cases, newRuntimeAuthority, secretProjections, teardownGuard, packagingEnvironment, validateNamespace, namespaceArguments, runOwnedProcess, requireProcessSuccess, verifyDryRun, compareCapsules, admitSource, qualifyInstalledInputs } from "../scripts/edge-proof.mjs";
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

function networkEvidence() {
  const parent = { net: "net:[10]", pid: "pid:[11]", mnt: "mnt:[12]", user: "user:[13]" };
  const evidence = { platform: "linux", pid: 1, ppid: 0, uid: 0, namespaces: { net: "net:[20]", pid: "pid:[21]", mnt: "mnt:[22]", user: "user:[23]" }, interfaces: ["lo"], routes4: [], routes6: [], sharedMount: false, procMounted: true };
  // PID is both a namespace name and process identity in the OS: keep them
  // separate in evidence so neither can accidentally overwrite the other.
  return { parent, evidence };
}
test("packaging environment is an explicit allowlist, never inherited credentials", () => {
  const env = packagingEnvironment("/tmp/offline-fixture", "/runtime/bin/node");
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "WRANGLER_LOG_PATH", "WRANGLER_SEND_METRICS", "DO_NOT_TRACK", "NO_COLOR", "LANG"].sort());
  assert.equal(env.PATH, "/runtime/bin:/usr/bin:/bin");
  assert.equal(env.HOME, "/tmp/offline-fixture/home");
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
  assert.equal(env.DO_NOT_TRACK, "1");
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "CLOUDFLARE_API_TOKEN", "HTTPS_PROXY", "NODE_OPTIONS", "FORCE_COLOR"]) assert.equal(Object.hasOwn(env, key), false);
});
test("namespace invocation contains private descendant and mount boundaries with no privileged fallback", () => {
  assert.deepEqual(namespaceArguments("/runtime/node", ["runner", "offline-child"]), ["--user", "--map-root-user", "--net", "--mount", "--propagation", "private", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", "--", "/runtime/node", "runner", "offline-child"]);
});
test("namespace evidence rejects absent, shared, external and malformed state", () => {
  const { parent, evidence } = networkEvidence();
  assert.equal(validateNamespace(evidence, parent), true);
  for (const change of [{ platform: "darwin" }, { pid: 2 }, { uid: 1 }, { namespaces: undefined }, { interfaces: [] }, { interfaces: ["lo", "eth0"] }, { routes4: ["lo 00000000"] }, { routes6: ["malformed"] }, { sharedMount: true }, { sharedMount: undefined }, { procMounted: false }]) assert.throws(() => validateNamespace({ ...evidence, ...change }, parent));
  for (const name of ["net", "pid", "mnt", "user"]) for (const value of [parent[name], undefined]) assert.throws(() => validateNamespace({ ...evidence, namespaces: { ...evidence.namespaces, [name]: value } }, parent));
  assert.equal(validateNamespace({ ...evidence, pid: 2, ppid: 1 }, parent, true), true);
  assert.throws(() => validateNamespace({ ...evidence, pid: 2, ppid: 3 }, parent, true));
  const reject = `${"0".repeat(32)} 00 ${"0".repeat(32)} 00 ${"0".repeat(32)} ffffffff 00000000 00000000 00200200 lo`;
  assert.equal(validateNamespace({ ...evidence, routes6: [reject] }, parent), true);
  assert.throws(() => validateNamespace({ ...evidence, routes6: [reject.replace("00200200", "00000001")] }, parent));
});
const successfulProcess = () => ({ code: 0, signal: null, closed: true, timedOut: false, interrupted: false, errors: [], remaining: [], observed: new Map(), stdout: "--dry-run: exiting now.\n", stderr: "" });
test("dry-run requires original successful close, marker and exact bytes, retaining undefined errors", () => {
  const bytes = Buffer.from("export default {};\n"), hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(verifyDryRun(successfulProcess(), bytes, hash).sha256, hash);
  for (const change of [{ code: 1 }, { signal: "SIGABRT" }, { closed: false }, { timedOut: true }, { interrupted: true }, { errors: [undefined] }, { remaining: null }, { remaining: [{ pid: 42 }] }, { stdout: "child exited zero" }]) assert.throws(() => verifyDryRun({ ...successfulProcess(), ...change }, bytes, hash));
  assert.throws(() => verifyDryRun(successfulProcess(), Buffer.alloc(0), hash));
  assert.throws(() => verifyDryRun(successfulProcess(), Buffer.from("changed"), hash));
  assert.throws(() => requireProcessSuccess({ ...successfulProcess(), errors: [undefined] }), error => error.errors.length === 2 && error.errors[1] === undefined);
});
test("source admission requires the exact commit and tree without fallback", () => {
  const calls = [];
  const git = (command, args) => { calls.push([command, args]); return args[1].endsWith("^{tree}") ? edgeProof.sourceTree : edgeProof.sourceSha; };
  admitSource("/owned", git); assert.equal(calls.length, 2);
  assert.ok(calls.every(([command, args]) => command === "git" && args[0] === "rev-parse"));
  assert.throws(() => admitSource("/owned", () => "0".repeat(40)));
  let caught = false; try { admitSource("/owned", () => { throw undefined; }); } catch (error) { caught = true; assert.equal(error, undefined); } assert.equal(caught, true);
});
test("two-root proof compares complete source, dependency and erasure receipts", () => {
  const receipt = { sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, sourceFiles: Array.from({ length: 600 }, (_, path) => ({ path, hash: "a" })), dependencyInputs: Array.from({ length: 268 }, (_, path) => ({ path, hash: "b" })), instrumentation: Array.from({ length: 4 }, (_, path) => ({ path, erasureExact: true })), observerSha256: "observer", harnessInputs: { one: "a" }, bundles: { edge: "b", upstream: "c" }, runtime: { node: "24.22.1" } };
  compareCapsules(receipt, structuredClone(receipt));
  for (const mutate of [r => { r.sourceFiles[1].hash = "x"; }, r => { r.dependencyInputs[0].hash = "x"; }, r => { r.instrumentation[0].erasureExact = false; }, r => { r.sourceFiles.pop(); }, r => { r.bundles.edge = "changed"; }, r => { r.sourceTree = "0".repeat(40); }]) { const changed = structuredClone(receipt); mutate(changed); assert.throws(() => compareCapsules(receipt, changed)); }
});
test("actual child success and unshare refusal retain original exit without executing namespaces", async () => {
  const options = { cwd: process.cwd(), env: packagingEnvironment(join(tmpdir(), "edge-unit-unused")), timeoutMs: 10000 };
  const success = await runOwnedProcess(process.execPath, ["-e", "process.stdout.write('complete\\n')"], options);
  requireProcessSuccess(success); assert.equal(success.stdout, "complete\n");
  const refused = await runOwnedProcess(process.execPath, ["-e", "process.exitCode=1"], options);
  assert.equal(refused.code, 1); assert.equal(refused.closed, true); assert.throws(() => requireProcessSuccess(refused));
  const missing = await runOwnedProcess("/nonexistent-edge-proof-command", [], options);
  assert.equal(missing.closed, true); assert.ok(missing.errors.length); assert.throws(() => requireProcessSuccess(missing));
});
for (const signal of ["SIGINT", "SIGTERM"]) test(`actual child ${signal} forwarding joins original close and records interruption`, async () => {
  const signals = new EventEmitter(); let ready = false;
  const spawnProcess = (...args) => {
    const child = spawn(...args);
    child.stdout.on("data", data => { if (data.toString().includes("READY")) { ready = true; signals.emit(signal); } });
    return child;
  };
  const source = `process.on('${signal}',()=>{process.stdout.write('TERM\\n');process.exitCode=7;clearInterval(held)});const held=setInterval(()=>{},1000);process.stdout.write('READY\\n')`;
  const result = await runOwnedProcess(process.execPath, ["-e", source], { cwd: process.cwd(), env: packagingEnvironment(join(tmpdir(), "edge-unit-unused")), spawnProcess, signalSource: signals, timeoutMs: 10000 });
  assert.equal(ready, true); assert.equal(result.interrupted, true); assert.equal(result.code, 7); assert.equal(result.closed, true); assert.match(result.stdout, /TERM/); assert.throws(() => requireProcessSuccess(result));
  assert.equal(signals.listenerCount(signal), 0);
});
test("actual timeout escalates the owned group and joins parent and descendant closes", async () => {
  const descendant = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);process.stdout.write('DESCENDANT_READY\\n')";
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});child.stdout.on('data',data=>process.stdout.write(data));child.on('close',()=>process.stdout.write('DESCENDANT_CLOSED\\n'));process.on('SIGTERM',()=>process.stdout.write('TERM\\n'));setInterval(()=>{},1000)`;
  const result = await runOwnedProcess(process.execPath, ["-e", source], { cwd: process.cwd(), env: packagingEnvironment(join(tmpdir(), "edge-unit-unused")), timeoutMs: 2000, graceMs: 250 });
  assert.match(result.stdout, /DESCENDANT_READY/); assert.match(result.stdout, /DESCENDANT_CLOSED/); assert.match(result.stdout, /TERM/);
  assert.equal(result.timedOut, true); assert.equal(result.signal, "SIGKILL"); assert.equal(result.closed, true); assert.throws(() => requireProcessSuccess(result));
});
test("sample and synchronous spawn errors preserve undefined without passing cleanup", async () => {
  const options = { cwd: process.cwd(), env: packagingEnvironment(join(tmpdir(), "edge-unit-unused")), timeoutMs: 10000 };
  const sync = await runOwnedProcess("unused", [], { ...options, spawnProcess: () => { throw undefined; } });
  assert.deepEqual(sync.errors, [undefined]); assert.equal(sync.closed, false); assert.throws(() => requireProcessSuccess(sync));
  const sample = await runOwnedProcess(process.execPath, ["-e", ""], { ...options, sample: async () => { throw undefined; } });
  assert.equal(sample.remaining, null); assert.ok(sample.errors.includes(undefined)); assert.throws(() => requireProcessSuccess(sample));
});
test("fresh packaging job uses pinned online setup and no credentials, upload, cache or activation", async () => {
  const workflow = YAML.parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = workflow.jobs["edge-offline-packaging"];
  assert.equal(job["runs-on"], "ubuntu-24.04"); assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.environment, undefined); assert.equal(job.env, undefined);
  assert.equal(job.steps[0].with["persist-credentials"], false);
  assert.equal(job.steps[1].with["node-version"], "24.22.1"); assert.equal(job.steps[2].with.version, "11.28.4");
  assert.ok(job.steps.filter(step => step.uses).every(step => /@[a-f0-9]{40}$/.test(step.uses)));
  const text = JSON.stringify(job);
  assert.doesNotMatch(text, /secrets\.|id-token|upload-artifact|actions\/cache|--execute|cf:provision|cf:deploy|sudo|sysctl|workflow_dispatch/);
  assert.match(text, /online setup/); assert.match(text, new RegExp(edgeProof.sourceSha)); assert.match(text, new RegExp(edgeProof.sourceTree));
  assert.equal(job.steps.at(-1).run, "node scripts/edge-proof.mjs offline-ci");
});
test("actual owned workspace installation qualifies contained links without a donor receipt", async () => {
  const result = await qualifyInstalledInputs(process.cwd());
  assert.equal(result.owned, true); assert.ok(result.containedLinks > 0);
  await assert.rejects(qualifyInstalledInputs(join(process.cwd(), "test")));
});
