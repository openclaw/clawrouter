import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, realpath, readlink, readdir, lstat, stat, open, opendir } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import { Socket } from "node:net";
import { bindCensusControls, privateProcesses, createCensusComparisonWitness } from "./edge-proof.mjs";
import { validateCompileDetail, packAttachTerminalDiagnostic, validateCoordinatorRuntime } from "./edge-proof.mjs";
import { edgeProof } from "./edge-proof-profile.mjs";
import { runOwnedProcess, requireProcessSuccess, qualifyInstalledInputs, namespaceEvidence, namespaceIdentity, prepareEnvironment, runPackagingPipeline, createPackagingDiagnostics, createContainerDiagnostics, emitContainerFailure, imageBuildStages, nativePrepareStages, validateEnumerationDetail, createInitDiagnostics, initPrerequisiteStages, attachFailureBranches, validateContainerDiagnostic, initGuardTags, initSourcePhases, validateInitDetail, mountTargets, mountFilesystems, validateMountDetail, validateMaskDetail, parentAdmissionSources, parentAdmissionPredicates, parentAdmissionRoles, validateParentAdmission, validatePackagingDiagnostic, receiptOperations, receiptChildPhases, validateReceiptDiagnostic, projectionBoundaries, validateReceiptBoundaryDiagnostic, validateReceiptLifecycleDiagnostic, validateReceiptBuilderDiagnostic, validateReportedBuilderProcess, receiptBuilderSignals, packReceiptOwnedDiagnostic, packReceiptCodeDiagnostic, packReceiptAssociatedDiagnostic, packReceiptCensusDiagnostic, unpackCensusCloseDiagnostic, validateWranglerCloseDiagnostic, packReceiptObservedWranglerDiagnostic, validateObservedWranglerCloseDiagnostic } from "./edge-proof.mjs";
export { validateContainerDiagnostic, emitContainerFailure } from "./edge-proof.mjs";

export const containerContract = Object.freeze({
  version: 2,
  base: "docker.io/library/node@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02",
  input: "/opt/edge-input", node: "/usr/local/bin/node", git: "/usr/bin/git", reaper: "/opt/edge-reaper/reaper",
  cliHash: "934d8051582ed5d85336e9e6677126ec87324a47166974de22d49a5523ba4d11",
  memory: 4294967296, taskBytes: 2147483648, pids: 128, cpus: 2000000000,
});
export const harnessInputs = Object.freeze([
  ".github/workflows/ci.yml", "CHANGELOG.md", "config/deployments/edge-proof.json", "config/edge-proof/Dockerfile",
  "docs/edge-native-cancellation-proof.md", "scripts/assert-deployment-target.mjs", "scripts/deployment-profile.mjs",
  "scripts/edge-proof-build.mjs", "scripts/edge-proof-container.mjs", "scripts/edge-proof-profile.mjs", "scripts/edge-proof.mjs",
  "scripts/render-wrangler-config.mjs", "test/edge-proof-build.test.mjs", "test/edge-proof-container.test.mjs",
  "test/edge-proof-upstream.test.mjs", "test/edge-proof.test.mjs", "test/fixtures/openclaw-edge-native-cancellation-contract.test.ts",
  "test/openclaw-edge-native-cancellation.test.mjs", "worker/fixtures/edge-native-cancellation.ts", "worker/fixtures/edge-native-upstream.ts",
  "wrangler.edge-proof-upstream.toml", "wrangler.edge-proof.toml",
  "config/edge-proof/reaper.c",
]);
export const installInputs = Object.freeze({
  "package.json": "07130060a46c69fe292aa5865b331cc6c06e3b215a402c362787db4c30443841",
  "pnpm-lock.yaml": "3e1b8b9e668ee40bea41b46001c2c75a2fbc8be88d9f26b512dafb09cf16e4b2",
  "pnpm-workspace.yaml": "4170373a544197669e91120a9584d12f0d1e26912919546b8992615f0cea9b26",
  "admin/package.json": "cb5fc9f00b77d9da35f5499968a94460717118e21062728cc3bacca48d90ac7c",
});
const frozenInstallBlobs = Object.freeze({
  "package.json": "44cea586e784a7a8c5070d230366e703f34c8eb2",
  "pnpm-lock.yaml": "ccd79e35e8e0a1a734ea7faf81074b07bf7e11a1",
  "pnpm-workspace.yaml": "eb0c26a19a820af176ce88c501d4a6235b3fda52",
  "admin/package.json": "f7e97dcb4d1361cd7a6a8f0db64e94ebd6554014",
});
// Current packaging closure is observed only. The image installs installInputs,
// whose owner remains the frozen Worker source, never this current workspace.
export const currentWorkspaceMembers = Object.freeze(["admin", "packages/provider-plugin-contract"]);
export const currentInputInventory = Object.freeze(
[
  {
    "path": "admin/package.json",
    "blob": "f7e97dcb4d1361cd7a6a8f0db64e94ebd6554014",
    "sha256": "cb5fc9f00b77d9da35f5499968a94460717118e21062728cc3bacca48d90ac7c",
    "bytes": 799
  },
  {
    "path": "package.json",
    "blob": "23dca1a6ddafbce0a1e60b8742b4a81a59bb51f2",
    "sha256": "3f73d8efc5a9572ad32503507f9747baf8ca5458dda01769487ff0d851b1c39a",
    "bytes": 2859
  },
  {
    "path": "packages/provider-plugin-contract/LICENSE",
    "blob": "c6d2a30e1b9e1045dd901a83ad66acfbba7aa05e",
    "sha256": "6ae2daf92d73e912aef033d56ce374df997ae0ad1d88ca9ef76f0c11123aae27",
    "bytes": 1065
  },
  {
    "path": "packages/provider-plugin-contract/README.md",
    "blob": "4424d85f4b890eb0b44288a1b382ae4fa791b872",
    "sha256": "11a14a638620b86c65efa12beb680c54255269345b2940e46e80c9f586d7345d",
    "bytes": 5635
  },
  {
    "path": "packages/provider-plugin-contract/copy-manifest-schema.mjs",
    "blob": "a376028dfcb96cab0d9cf7a3ffd4c0447d3ab530",
    "sha256": "55101db5526756089d844c22281257b3ed146d5306175e11d9a1fa2e1a05cf82",
    "bytes": 287
  },
  {
    "path": "packages/provider-plugin-contract/package.json",
    "blob": "3e12adaf8e22a7649d3085bdb08def7614ad7b0f",
    "sha256": "ac60d0e916a850a332a181bd08e6d2b41e17f06a015c1c8d695f677198599ac2",
    "bytes": 693
  },
  {
    "path": "packages/provider-plugin-contract/src/auth.ts",
    "blob": "a4a6b2f19dcde32cd4962a1c82a5f3ed1aff21ab",
    "sha256": "5cb7ccb7d9024604ba443d7e1a68b97cb62f7864c1ef1bc0c535bde1874dbd6f",
    "bytes": 1927
  },
  {
    "path": "packages/provider-plugin-contract/src/bindings.ts",
    "blob": "b569f586b05ad74c9ce49fc645dff892df3d7aec",
    "sha256": "dcb7068cf63170e1282112e428c902c9a656c9f21e4adb8986b2087ebc2b28e1",
    "bytes": 3359
  },
  {
    "path": "packages/provider-plugin-contract/src/conformance.ts",
    "blob": "08024dbc187f17c9f18ddabec79d56be67ba5cf0",
    "sha256": "09ce95daf99ecc6f31ef01d08c94b6921131954ab9c057937ecf3aa96b2cb864",
    "bytes": 7719
  },
  {
    "path": "packages/provider-plugin-contract/src/endpoints.ts",
    "blob": "2102a8a85714c7bcbfc8005dfb9be09dd29ed193",
    "sha256": "d95280cd067bdc30bd5bedb738c50ec87bd83639361c7ea035a30e7a500c3825",
    "bytes": 1761
  },
  {
    "path": "packages/provider-plugin-contract/src/index.ts",
    "blob": "b4159a043c9673ed50e77cba1c5fc6f60086bf8d",
    "sha256": "aa8868073209a5756149b371418e24f3dd9e7b031b6beeb7c62827d87171d34e",
    "bytes": 2812
  },
  {
    "path": "packages/provider-plugin-contract/src/model-availability.ts",
    "blob": "5525659c1be1c6506bcdc84db80b801ff2f9e0a0",
    "sha256": "5525e683152c9c40859055ec1b424f31e88987084b9ca600888b3302b93be9cf",
    "bytes": 309
  },
  {
    "path": "packages/provider-plugin-contract/src/model-request-parameters.ts",
    "blob": "352762ccb542da4493336d6a937105eb04305acc",
    "sha256": "44ce4b2380156ced3ef3ff5d50e469b12c7454c2e64269067e4dec8cae76103a",
    "bytes": 457
  },
  {
    "path": "packages/provider-plugin-contract/src/models.ts",
    "blob": "8ebdd771f40bc4a943a03679ce99ea455a1d9b3f",
    "sha256": "255f499908019811d6ff384f3f965467ea224418ceac9c790a04f72061bad36f",
    "bytes": 1058
  },
  {
    "path": "packages/provider-plugin-contract/src/native-capabilities.ts",
    "blob": "ea796c0011ad29f5b86f687727b8351829094ab2",
    "sha256": "537886d04e5a1cc79bd733fbc13fb1017fe9158430ad2a61e0c93c211e6b6027",
    "bytes": 5169
  },
  {
    "path": "packages/provider-plugin-contract/src/observations.ts",
    "blob": "4b58eaab06b268954182fda822e6db94f1a1862b",
    "sha256": "138f7801c7205c35fb4bc4132eb630c2d16de27da5eab2372a6fad26de1721e5",
    "bytes": 416
  },
  {
    "path": "packages/provider-plugin-contract/src/package-index.ts",
    "blob": "454f53a1a801441b2c9c6e6259fb1ba23e0ed0ef",
    "sha256": "46a21483fae6f5723d1b04387f4e593479b9755b8ba24a66ded2958edb52f986",
    "bytes": 735
  },
  {
    "path": "packages/provider-plugin-contract/src/plugin-descriptor.ts",
    "blob": "c3cefaa973eab5149dfbdfabfc18844f53eec4f2",
    "sha256": "896cb754874cca6f3485692dd47a6adad043b01eebc22d947ca86c35479789a7",
    "bytes": 4769
  },
  {
    "path": "packages/provider-plugin-contract/src/pricing.ts",
    "blob": "99b0fe0ead76afcb3fe5caa7123a50ffa9edbc17",
    "sha256": "080646fa1303dd05083eae5ac38558ccbd943bc616c0c304f801189ab121c64c",
    "bytes": 4034
  },
  {
    "path": "packages/provider-plugin-contract/src/product-metadata.ts",
    "blob": "b8a50c10c106e20c71ca89306a7b6d7ad1c69737",
    "sha256": "b8a0310ca7606a32ae20b9eaf74f888092a3382769e775bbdc1ba7166c9fd81e",
    "bytes": 553
  },
  {
    "path": "packages/provider-plugin-contract/src/products.ts",
    "blob": "82e30671358be91baa5720d624170821aca1dfd3",
    "sha256": "23533b59fb4c71a13649f707ec564a2d6ffb6d7fe7366b07a8aec6dd342b0ada",
    "bytes": 1374
  },
  {
    "path": "packages/provider-plugin-contract/src/quota.ts",
    "blob": "ecdc2303d869657da4973c1a944dc37a7ed60d57",
    "sha256": "f45d6251dc221c4f9806fee7a846306612db4a42e2b98a55a3382f58324f769c",
    "bytes": 1526
  },
  {
    "path": "packages/provider-plugin-contract/src/snapshot.ts",
    "blob": "6803fe6c74f70b17c067b7c1eff89a3c5c647081",
    "sha256": "44185dde47be881fb020dbdb96f9a4742366d5d4df8c6a0e7e33c185a1aed11c",
    "bytes": 2110
  },
  {
    "path": "packages/provider-plugin-contract/tsconfig.json",
    "blob": "8215fdf9948885613864bd0ddcd0280b651c32bc",
    "sha256": "790af294f30d983e8dbf578f1f3e22355a3376c1368f4a6d91a7093f91dab997",
    "bytes": 367
  },
  {
    "path": "pnpm-lock.yaml",
    "blob": "6bbea6484ace8dcadba5a1b82ac74a095ab10e2a",
    "sha256": "00dfde610072dfde318c87a2a9f9905d737a108e7bef29fb3a16577d9cb18f53",
    "bytes": 57136
  },
  {
    "path": "pnpm-workspace.yaml",
    "blob": "5b29aab3e6705dd83c77f36c289fb9469bfdccaa",
    "sha256": "5504ac71d5ce21ef500542c033f4c9858c916d345636dd90b98cf385df0d77ea",
    "bytes": 296
  },
  {
    "path": "providers/_schema/service-provider.schema.json",
    "blob": "b6f7a26a40a1275e357df33f2afbda8faa5b347c",
    "sha256": "1d48a0e210dce57c0a43fbea6c0cccb39fa99d65a77e2afc8a6f8684667ec993",
    "bytes": 117620
  }
]
);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw new Error(`edge-container: ${code}`); };
const check = (value, code) => { if (!value) fail(code); };
const hashPattern = /^[a-f0-9]{64}$/;
const cidPattern = /^[a-f0-9]{64}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const protocol = "EDGE_CONTAINER_V2 ";
export function createInitGuardLedger() {
  const errors = []; let source = null, guard = null, sealed = false, detail, mount, mask;
  return { errors,
    source(value) { try { check(!sealed && initSourcePhases.includes(value), "init-source-phase"); source = value; } catch (error) { errors.push(error); } },
    guard(value) { try { check(!sealed && initGuardTags.includes(value), "init-guard-tag"); guard ??= value; } catch (error) { errors.push(error); } },
    mount(value) { try { check(!sealed && mount === undefined, "mount-detail-stale"); mount = validateMountDetail(value, source); } catch (error) { errors.push(error); } },
    mask(value) { try { check(!sealed && mask === undefined, "mask-detail-stale"); mask = validateMaskDetail(value); } catch (error) { errors.push(error); } },
    failure() { if (!sealed) { sealed = true; if (source !== null) detail = { guard, source, ...(mount === undefined ? {} : { m: mount }), ...(mask === undefined ? {} : { e: mask }) }; } return detail; },
  };
}
function initRecord(recorder, method, value) { if (recorder) try { recorder[method](value); } catch (error) { recorder.errors.push(error); } }
export function initGuardLeaf(value, recorder, tag) { if (!value) initRecord(recorder, "guard", tag); return value; }
function initGuardCheck(value, code, recorder, tag) { check(initGuardLeaf(value, recorder, tag), code); }
const own = (value, key) => {
  check(value && typeof value === "object", "data-object");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  check(descriptor && Object.hasOwn(descriptor, "value"), "own-data");
  return descriptor.value;
};
const receiptRecord = (recorder, method, ...args) => { if (recorder) try { recorder[method](...args); } catch (error) { recorder.errors.push(error); } };
const receiptCount = (recorder, value) => { receiptRecord(recorder, "count", value); return value; };
const receiptLeaf = (recorder, id, value) => { receiptRecord(recorder, "leaf", id, value); return value; };
const exactKeys = (value, keys, recorder) => check(receiptLeaf(recorder, 1, same(Object.getOwnPropertyNames(value).sort(), [...keys].sort())), "data-keys");
export function raiseContainerFailures(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "edge-container: independent failures");
}

// Private EDR1 wire. No identity or native error text is forwarded publicly.
export function reaperFrame(op, sequence, binding) {
  check([1,2,3,129,130,131].includes(op) && Number.isInteger(sequence) && sequence > 0 && sequence < 0xffffffff && Number.isInteger(binding.pid) && binding.pid > 1 && binding.pid <= 0x7fffffff && hashPattern.test(binding.nonce) && hashPattern.test(binding.contextHash), "reaper-frame-identity");
  const frame = Buffer.alloc(80); frame.write("EDR1", 0, "ascii"); frame[4] = op;
  frame.writeUInt32BE(sequence, 8); frame.writeUInt32BE(binding.pid, 12);
  Buffer.from(binding.nonce, "hex").copy(frame, 16); Buffer.from(binding.contextHash, "hex").copy(frame, 48);
  return frame;
}
export function createReaperClient(socket, binding) {
  const errors = []; let next = 1, pending = null, hello = false, finishing = false, closed = false, closeResolve;
  let shutdown, destroyed = false;
  const close = new Promise(resolve => { closeResolve = resolve; });
  const failed = error => { errors.push(error); if (pending) { const original = pending; pending = null; original.reject(error); } };
  const guard = fn => (...args) => { try { fn(...args); } catch (error) { failed(error); } };
  const onData = guard(data => {
    check(Buffer.isBuffer(data) && pending && !closed && pending.bytes.length + data.length <= 80, "reaper-unsolicited-or-overflow");
    pending.bytes = Buffer.concat([pending.bytes, data]);
    if (pending.bytes.length === 80) {
      check(pending.bytes.equals(reaperFrame(pending.op | 128, pending.sequence, binding)), "reaper-ack-identity");
      const original = pending; pending = null; if (original.op === 3) finishing = true; original.resolve();
    }
  });
  const onError = guard(error => failed(error));
  const onEnd = guard(() => { check(finishing && !pending, "reaper-premature-eof"); });
  const onClose = guard(() => { if (closed) return; closed = true; if (!finishing || pending) failed(new Error("edge-container: reaper-premature-close")); closeResolve(); });
  for (const [event, listener] of [["data",onData],["error",onError],["end",onEnd],["close",onClose]]) {
    try { socket.on(event, listener); } catch (error) { failed(error); }
  }
  const request = async op => {
    raiseContainerFailures(errors);
    check(!closed && !pending && !finishing && (hello ? op === 2 || op === 3 : op === 1), "reaper-request-order");
    const sequence = next++, frame = reaperFrame(op, sequence, binding);
    const completion = new Promise((resolve, reject) => { pending = {op, sequence, bytes: Buffer.alloc(0), resolve, reject}; });
    // Install the rejection observer before write: callbacks may be synchronous.
    void completion.catch(() => {});
    try { socket.write(frame, error => { if (error != null) failed(error); }); } catch (error) { failed(error); }
    await completion; raiseContainerFailures(errors); if (op === 1) hello = true;
  };
  // Allocate the shared promise before any user callback can reenter shutdown.
  // A destroy throw does not establish CLOSE. Late errors remain independent.
  const stop = finish => {
    if (!shutdown) shutdown = Promise.resolve().then(async () => {
      if (finish) {
        const prior = errors.length; let requested = false;
        try { await request(3); requested = true; }
        catch (error) { if (errors.length === prior && prior === 0) errors.push(error); }
        if (requested) try { socket.end(); } catch (error) { errors.push(error); }
      }
      if ((!finish || errors.length) && !closed && !destroyed) {
        destroyed = true; try { socket.destroy(); } catch (error) { errors.push(error); }
      }
      await close;
      raiseContainerFailures(errors);
    });
    return shutdown;
  };
  return { errors, start: () => request(1), drain: () => request(2), finish: () => stop(true), abort: () => stop(false) };
}
// EDT1 uses ONLY the original attach stderr channel: pinned PID1 redirects the
// coordinator's stderr to stdout before exec. No shared-text marker scan occurs.
// Authority is the admitted producer image/control pair and original CID attach,
// not possession of the nonce or an apparent line in workload stdout.
const reaperTerminalOutcomes = new WeakMap();
const terminalPoint = (recorder, stage) => { if (recorder) try { recorder.at(stage); } catch (error) { recorder.errors.push(error); } };
export function parseReaperTerminal(result, binding, recorder) {
  terminalPoint(recorder, 1);
  check(binding?.attached?.result === result && cidPattern.test(binding.cid) && hashPattern.test(binding.nonce) && hashPattern.test(binding.contextHash), "reaper-terminal-attach");
  check(binding.controls?.result?.reaper.pid === 1 && binding.controls.result.coordinator.pid > 1 && hashPattern.test(binding.sourceHash), "reaper-terminal-producer");
  check(result.closed && result.supervisor[4] && result.supervisor[5], "reaper-terminal-original-close");
  for (const name of ["stdout", "stderr"]) {
    const bytes = Buffer.from(result[name]), summary = result.outputSummary[name];
    check(summary?.complete === true && summary.truncated === false && summary.bytes === bytes.length && summary.retainedBytes === bytes.length && summary.sha256 === hash(bytes) && summary.retainedSha256 === hash(bytes), "reaper-terminal-capture");
  }
  terminalPoint(recorder, 2);
  const match = /^EDT1:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{8}):([a-f0-9]{8}):([012]):([a-f0-9]{8}):([a-f0-9]{8}):([01]):1\n$/.exec(result.stderr);
  check(match && match[1] === binding.nonce && match[2] === binding.contextHash, "reaper-terminal-frame");
  const pid = parseInt(match[3],16), sequence = parseInt(match[4],16), kind = Number(match[5]), value = parseInt(match[6],16), faults = parseInt(match[7],16), finished = match[8] === "1";
  check(pid === binding.controls.result.coordinator.pid && sequence < 0xffffffff && faults <= 511 && (kind === 0 ? value === 0 : kind === 1 ? value <= 255 : value > 0 && value <= 64) && (!finished || sequence >= 2) && (finished || (faults & 8)), "reaper-terminal-values");
  return Object.freeze({version:1, sequence, coordinator: {kind: ["unknown","exit","signal"][kind], value:kind ? value : null}, supervisorFaults:faults, finished, childrenDrained:true});
}
export function requireReaperTerminal(value) {
  check(value?.coordinator.kind === "exit" && value.coordinator.value === 0 && value.supervisorFaults === 0 && value.finished && value.childrenDrained, "reaper-terminal-failure");
}
export function createReaperTerminalRetention(attached, binding, retain, publish) {
  let task, outcome, decodedRejection = false;
  const retention = result => {
    if (!task) task = Promise.resolve().then(async () => {
      let value, failed = false, reason, owner, stage = 0, retentionState = 0, retentionDefined = null, receiptSha = null;
      const observer = {errors:[],at(value) { stage=value; }};
      try { owner={...binding(),attached}; value = parseReaperTerminal(result, owner, observer); } catch (error) { failed = true; reason = error; }
      const errors = failed ? [reason] : [], reporting = [];
      // Serialize once; the original exclusive write receives these same bytes.
      try {
        const bytes=Buffer.from(JSON.stringify({version:1, binding:binding(), terminal:value ?? null, unavailable:failed, failureDefined:failed ? reason !== undefined : null,
          originalAttach:{closed:result.closed, actualClose:result.supervisor[4], code:result.code, signal:result.signal, captures:result.outputSummary}}),"utf8");
        const digest=hash(bytes);await retain(bytes);retentionState=1;receiptSha=digest;
      } catch (error) { retentionState=2;retentionDefined=error!==undefined;errors.push(error); }
      if (!observer.errors.length) {
        const terminal=Object.freeze([failed ? stage===2?2:1 : 3,failed?reason!==undefined:null,
          value?.sequence??null,value?["unknown","exit","signal"].indexOf(value.coordinator.kind):null,value?.coordinator.value??null,value?.supervisorFaults??null,value?.finished??null,value?.childrenDrained??null,
          retentionState,retentionDefined,receiptSha]);
        outcome=Object.freeze({terminal});
        reaperTerminalOutcomes.set(outcome,{attached,result,owner,prerequisites:stage===2});
        if(publish)try { publish(outcome); } catch(error) { reporting.push(error); }
      }
      if(value)try { requireReaperTerminal(value); } catch(error) { errors.push(error); }
      decodedRejection=Boolean(value) && errors.length+observer.errors.length+reporting.length>0;
      raiseContainerFailures([...errors,...observer.errors,...reporting]);return value;
    });
    return task;
  };
  retention.outcome = () => outcome ?? null;
  retention.rejected = result => decodedRejection && reaperTerminalOutcomes.get(outcome)?.result === result;
  return retention;
}
const coordinatorPrefix = "EDGE_COORDINATOR_V1 ";
export function createCoordinatorWitness() {
  const errors=[];let point=0,first=0,failed=false,defined=null,finish=0,finishDefined=null,sealed=false;
  const note=operation=>{try{check(!sealed,"coordinator-witness-sealed");operation();}catch(error){errors.push(error);}};
  return {errors,
    point(value){note(()=>{check(Number.isInteger(value)&&value>=1&&value<=5,"coordinator-point");point=value;});},
    escape(reason){note(()=>{if(!failed&&point){first=point;failed=true;defined=reason!==undefined;}});},
    finish(value,reason){note(()=>{check(finish===0&&[1,2].includes(value),"coordinator-finish");finish=value;finishDefined=value===2?reason!==undefined:null;});},
    record(nonce,contextHash,coordinator){check(!sealed,"coordinator-witness-duplicate");sealed=true;if(errors.length)return null;
      check(hashPattern.test(nonce)&&hashPattern.test(contextHash)&&Number.isInteger(coordinator)&&coordinator>1&&coordinator<=0x7fffffff,"coordinator-witness-binding");
      validateCoordinatorRuntime([first,failed,defined,finish,finishDefined]);
      return {v:1,nonce,contextHash,coordinator,first,failed,defined,finish,finishDefined};},
  };
}
export async function writeCoordinatorWitness(witness, args, coordinator, writer) {
  const row=witness.record(args[0],args[1],coordinator);if(row===null)return;
  const text=coordinatorPrefix+JSON.stringify(row)+"\n";
  check(Buffer.byteLength(text)<=512 && /^[\x20-\x7e]+\n$/.test(text),"coordinator-witness-capacity");
  const errors=[];
  await new Promise(resolveWrite=>{
    let returned=false,completed=false;
    const complete=()=>{if(returned&&completed)resolveWrite();};
    try { writer(text,error=>{try{if(error!=null)errors.push(error);}catch(other){errors.push(other);}completed=true;complete();}); }
    catch(error){errors.push(error);completed=true;}
    returned=true;complete();
  });
  raiseContainerFailures(errors);
}
export function parseCoordinatorWitness(result, outcome, initSummary) {
  const custody=reaperTerminalOutcomes.get(outcome);
  if(!custody || custody.result!==result || custody.attached.result!==result || !custody.prerequisites || initSummary?.reason!=="complete" || initSummary.records!==9)return null;
  const allLines=result.stdout.split("\n"),lines=allLines.filter(line=>line.includes(coordinatorPrefix.trimEnd()));
  if(lines.length===0)return null;
  check(lines.length===1 && allLines.indexOf(lines[0])<allLines.length-1 && lines[0].startsWith(coordinatorPrefix) && Buffer.byteLength(lines[0])+1<=512 && /^[\x20-\x7e]+$/.test(lines[0]),"coordinator-witness-frame");
  const text=lines[0].slice(coordinatorPrefix.length),row=JSON.parse(text),keys="v,nonce,contextHash,coordinator,first,failed,defined,finish,finishDefined";
  check(row && Object.keys(row).join()===keys && JSON.stringify(row)===text,"coordinator-witness-canonical");
  const owner=custody.owner;
  check(row.v===1 && row.nonce===owner.nonce && row.contextHash===owner.contextHash && row.coordinator===owner.controls.result.coordinator.pid,"coordinator-witness-owner");
  return validateCoordinatorRuntime([row.first,row.failed,row.defined,row.finish,row.finishDefined]);
}

export function parseControlStat(raw, pid) {
  check(typeof raw === "string" && raw.length < 65536 && raw.startsWith(`${pid} (`), "control-stat");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(" ");
  check(["R","S","D","I"].includes(fields[0]) && /^\d+$/.test(fields[1]) && /^\d+$/.test(fields[19]), "control-stat-fields");
  return {pid, parent: number(fields[1]), start: fields[19]};
}
async function readControl(pid, read = readFile, link = readlink) {
  const prefix = `/proc/${pid}`;
  const first = parseControlStat(await read(`${prefix}/stat`, "utf8"), pid);
  const value = {...first, status: await read(`${prefix}/status`, "utf8"), exe: await link(`${prefix}/exe`), executableHash: hash(await read(`${prefix}/exe`)), command: await read(`${prefix}/cmdline`),
    namespaces: Object.fromEntries(await Promise.all(["pid","mnt","net","user","cgroup"].map(async name => [name, await link(`${prefix}/ns/${name}`)]))), cgroup: await read(`${prefix}/cgroup`, "utf8")};
  const closingNamespaces = Object.fromEntries(await Promise.all(["pid","mnt","net","user","cgroup"].map(async name=>[name,await link(`${prefix}/ns/${name}`)])));
  check(same(first, parseControlStat(await read(`${prefix}/stat`, "utf8"), pid)) && same(value.namespaces,closingNamespaces) && value.cgroup === await read(`${prefix}/cgroup`,"utf8") && value.exe === await link(`${prefix}/exe`), "control-read-drift"); return value;
}
export function validateControlPair(reaper, coordinator, {identity, nonce, contextHash, host = false}) {
  validateChildStatus(reaper.status, identity); validateChildStatus(coordinator.status, identity);
  const nspids = row => {
    const lines = row.status.split("\n").filter(line => line.startsWith("NSpid:")); check(lines.length === 1, "control-nspid");
    return lines[0].slice(6).trim().split(/\s+/).map(text => number(text));
  };
  const a = nspids(reaper), b = nspids(coordinator);
  check(a.length === (host ? 2 : 1) && b.length === a.length && a[0] === reaper.pid && b[0] === coordinator.pid && a.at(-1) === 1 && b.at(-1) > 1 && coordinator.parent === reaper.pid, "control-pid-correspondence");
  check(host || reaper.parent === 0, "control-init-parent");
  check(["pid","mnt","net","user","cgroup"].every(name=>new RegExp(`^${name}:\\[\\d+\\]$`).test(reaper.namespaces[name])), "control-namespace-format");
  check(reaper.exe === containerContract.reaper && coordinator.exe === containerContract.node && ["pid","mnt","net","user","cgroup"].every(name => reaper.namespaces[name] === coordinator.namespaces[name]) && reaper.cgroup === coordinator.cgroup, "control-custody");
  const command = [containerContract.node, "/opt/edge-input/scripts/edge-proof.mjs", "container-init", nonce, contextHash, String(identity.uid[0]), String(identity.gid[0])];
  check(Buffer.isBuffer(coordinator.command) && coordinator.command.equals(Buffer.from(command.join("\0") + "\0")) && Buffer.isBuffer(reaper.command) && reaper.command.equals(Buffer.from([containerContract.reaper, ...command].join("\0") + "\0")), "control-invocation");
  return {reaper: {pid:a.at(-1), parent:host ? 0 : reaper.parent, start:reaper.start}, coordinator: {pid:b.at(-1), parent:1, start:coordinator.start}};
}
async function qualifyControls(identity, nonce, contextHash, coordinatorPid = process.pid) {
  const reaper = await readControl(1), coordinator = await readControl(coordinatorPid);
  const qualified = await qualifyReaper(contextHash);
  check(reaper.executableHash === qualified.binary.sha256 && coordinator.executableHash === hash(await readFile(containerContract.node)), "control-executable-hash");
  return validateControlPair(reaper, coordinator, {identity, nonce, contextHash});
}
async function parentControls(initPid, expected, identity, nonce, contextHash, native) {
  const before = await cgroupStamp(readlink, "/proc/self");
  const children = (await readFile(`/proc/${initPid}/task/${initPid}/children`, "utf8")).trim().split(/\s+/);
  check(children.length === 1 && /^[1-9]\d*$/.test(children[0]), "control-single-coordinator");
  const reaper = await readControl(initPid), coordinator = await readControl(number(children[0]));
  check(reaper.start === expected.start && ["pid","mnt","net","user","cgroup"].every(name => reaper.namespaces[name] === expected.namespaces[name]) && reaper.cgroup === expected.cgroup, "control-target-binding");
  check(reaper.executableHash === native.reaper.binary.sha256 && coordinator.executableHash === native.native.node.sha256, "parent-control-executable");
  const result = validateControlPair(reaper, coordinator, {identity, nonce, contextHash, host:true});
  check(same(before, await cgroupStamp(readlink, "/proc/self")), "control-observer-drift");
  const snapshot = row => ({pid:row.pid, parent:row.parent, start:row.start, exe:row.exe, executableHash:row.executableHash, command:row.command.toString("hex"), namespaces:row.namespaces, cgroup:row.cgroup});
  return {reaper:snapshot(reaper), coordinator:snapshot(coordinator), result};
}

// This ledger belongs only to one parent admission callback; cleanup never receives it.
export function createParentAdmissionLedger() {
  const errors = [], stack = []; let source = 0, visit = 1, role = 0, predicate = 0, seen = 0, passed = 0, falseLeaf = 0, evaluating = false, sealed = false, broken = false, count = null, saturation = 0, mount;
  const note = fn => { if (sealed) return; try { fn(); } catch (error) { broken = true; errors.push(error); } };
  return { parent: true, errors,
    enter(value) { note(() => { source = parentAdmissionSources.indexOf(value) + 1; check(source > 0, "parent-source"); predicate = seen = passed = falseLeaf = 0; evaluating = false; stack.length = 0; role = 0; count = null; saturation = 0; mount = undefined; }); },
    visit(value) { note(() => { check([1,2].includes(value), "parent-visit"); visit = value; }); },
    role(value) { note(() => { role = parentAdmissionRoles.indexOf(value) + 1; check(role > 0, "parent-role"); }); },
    begin(id) { note(() => { check(Number.isInteger(id) && id > 0 && id <= parentAdmissionPredicates.length, "parent-predicate"); if (evaluating) stack.push({predicate,seen,passed,falseLeaf,count,saturation}); predicate = id; seen = passed = falseLeaf = 0; count = null; saturation = 0; evaluating = true; }); },
    leaf(id, value) { note(() => { const bit = 2 ** (id - 1); check(evaluating && id >= 1 && id <= parentAdmissionPredicates[predicate - 1][1], "parent-leaf"); seen |= bit; if (value) passed |= bit; else { passed &= ~bit; falseLeaf = id; } }); return value; },
    result(value) { note(() => { evaluating = false; if (value) { const previous = stack.pop(); if (previous) { ({predicate,seen,passed,falseLeaf,count,saturation} = previous); evaluating = true; } else { predicate = seen = passed = falseLeaf = 0; count = null; saturation = 0; } } }); return value; },
    count(value) { note(() => { if (Number.isSafeInteger(value) && value >= 0) { count = Math.min(value,4095); saturation = value > 4095 ? 1 : 0; } }); },
    guard() {}, mount(value) { note(() => { mount = validateMountDetail(value, value[1] >= 10 && value[1] <= 13 ? "mount_parse" : "mount_validate"); predicate = seen = passed = falseLeaf = 0; evaluating = false; count = null; saturation = 0; }); },
    seal() { sealed = true; },
    finish(original, reason) {
      if (sealed) return null; sealed = true;
      if (broken || !source) return null;
      const detail = [1, source, visit, original ? predicate ? evaluating ? 2 : 1 : mount ? 1 : 0 : 3, predicate, predicate && !evaluating ? falseLeaf : 0, role, seen, passed, count, saturation];
      return validateParentAdmission({ v: 8, phase: "admission", state: "rejected", defined: reason !== undefined, exit: null, signal: null, detail, ...(mount ? { m: mount } : {}) });
    },
  };
}
const parentRecord = (recorder, method, ...args) => { if (recorder?.parent) try { recorder[method](...args); } catch (error) { recorder.errors.push(error); } };
const parentSource = (recorder, source) => parentRecord(recorder, "enter", source);
const parentRole = (recorder, role) => parentRecord(recorder, "role", role);
const parentCount = (recorder, value) => { parentRecord(recorder, "count", value); return value; };
const parentLeaf = (recorder, id, value) => { parentRecord(recorder, "leaf", id, value); return value; };
const parentEvaluate = (recorder, id, operation) => {
  if (!recorder?.parent) return operation();
  parentRecord(recorder, "begin", id); const value = operation(); parentRecord(recorder, "result", value); return value;
};

const number = (text, recorder) => { check(parentEvaluate(recorder, 44, () => parentLeaf(recorder, 1, typeof text === "string") && parentLeaf(recorder, 2, /^(0|[1-9]\d*)$/.test(text)) && parentLeaf(recorder, 3, Number.isSafeInteger(Number(text)))), "canonical-number"); return Number(text); };
export function parseIdentity(status, recorder) {
  const check = (value, code) => initGuardCheck(value, code, recorder, "uid_gid_groups");
  check(parentEvaluate(recorder, 1, () => parentLeaf(recorder, 1, typeof status === "string") && parentLeaf(recorder, 2, parentCount(recorder, status.length) <= 65536)), "status-capacity");
  const field = name => { parentRole(recorder, name); const rows = status.split("\n").filter(line => line.startsWith(name + ":")); check(parentEvaluate(recorder, 2, () => parentLeaf(recorder, 1, parentCount(recorder, rows.length) === 1)), "status-field"); return rows[0].slice(name.length + 1).trim(); };
  const tuple = name => { const values = field(name).split(/\s+/).map(value => number(value, recorder)); check(parentEvaluate(recorder, 3, () => parentLeaf(recorder, 1, parentCount(recorder, values.length) === 4) && parentLeaf(recorder, 2, values[0] > 0) && parentLeaf(recorder, 3, values.every(value => value === values[0]))), "identity-tuple"); return values; };
  const groups = field("Groups").split(/\s+/).filter(Boolean).map(value => number(value, recorder)).sort((a, b) => a - b);
  check(parentEvaluate(recorder, 4, () => parentLeaf(recorder, 1, new Set(groups).size === groups.length)), "identity-groups");
  return { uid: tuple("Uid"), gid: tuple("Gid"), groups };
}
export function validateIdentity(actual, expected, child = false, recorder) {
  parentRole(recorder, "identity");
  const check = (value, code) => initGuardCheck(value, code, recorder, "uid_gid_groups");
  check(parentEvaluate(recorder, 5, () => parentLeaf(recorder, 1, same(actual.uid, expected.uid)) && parentLeaf(recorder, 2, same(actual.gid, expected.gid))), "identity-drift");
  check(parentEvaluate(recorder, 6, () => parentLeaf(recorder, 1,  child ? actual.groups.length <= 1 && actual.groups.every(group => group === expected.gid[0]) : same(actual.groups, expected.groups))), "groups-drift");
  return actual;
}
export function validateMapping(text, id, recorder) {
  const rows = text.trim().split("\n").map(line => line.trim().split(/\s+/).map(value => number(value, recorder)));
  check(parentEvaluate(recorder, 7, () => parentLeaf(recorder, 1, rows.length === 1) && parentLeaf(recorder, 2, rows[0].length === 3) && parentLeaf(recorder, 3, rows[0][0] === 0) && parentLeaf(recorder, 4, rows[0][1] === 0) && parentLeaf(recorder, 5, rows[0][2] > id)), "host-id-mapping");
  return rows;
}
export function validateImage(image, { derived = false, identity, id, contextHash } = {}) {
  check(image && imagePattern.test(image.Id) && (!id || image.Id === id) && image.Os === "linux" && image.Architecture === "amd64", "image-identity");
  const config = image.Config;
  check(config && (!config.OnBuild || config.OnBuild.length === 0) && (!config.Volumes || Object.keys(config.Volumes).length === 0), "image-implicit-input");
  const baseEnv = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "NODE_VERSION=24.22.1", "YARN_VERSION=1.22.22"];
  check(same(config.Env, derived ? [...baseEnv, "PNPM_HOME=/usr/local/share/pnpm"] : baseEnv), "image-environment");
  check(same(config.Entrypoint, derived ? [containerContract.reaper, containerContract.node, "/opt/edge-input/scripts/edge-proof.mjs", "container-init"] : ["docker-entrypoint.sh"]), "image-entrypoint");
  check(same(config.Cmd, derived ? [] : ["node"]) || derived && config.Cmd === null, "image-command");
  check(config.User === (derived ? `${identity.uid[0]}:${identity.gid[0]}` : "") && config.WorkingDir === (derived ? "/task" : ""), "image-user-cwd");
  if (derived) check(config.Labels?.["org.openclaw.edge.context"] === contextHash, "image-context-label");
  else {
    const digest = containerContract.base.slice(containerContract.base.indexOf("@"));
    check(image.RepoDigests?.some(value => ["node", "library/node", "docker.io/library/node"].some(name => value === name + digest)), "base-digest");
  }
  return image;
}
export function dockerEnvironment(root) {
  check(isAbsolute(root), "docker-config-root");
  return { PATH: "/usr/bin:/bin", HOME: join(root, "home"), DOCKER_CONFIG: join(root, "docker-config"), DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_BUILDKIT: "0", LANG: "C.UTF-8", NO_COLOR: "1" };
}
export function containerEnvironment(root = "/task") {
  check(["/task", "/task/child"].includes(root), "container-env-root");
  return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`, XDG_CACHE_HOME: `${root}/cache`, XDG_DATA_HOME: `${root}/data`, TMPDIR: `${root}/tmp`, WRANGLER_LOG_PATH: `${root}/logs`, WRANGLER_SEND_METRICS: "false", DO_NOT_TRACK: "1", NO_COLOR: "1", LANG: "C.UTF-8" };
}
export function createArguments(plan, cidFile) {
  check(imagePattern.test(plan.image) && hashPattern.test(plan.nonce) && hashPattern.test(plan.contextHash) && isAbsolute(cidFile), "create-plan");
  const uid = plan.identity.uid[0], gid = plan.identity.gid[0];
  check(uid > 0 && gid > 0 && Number.isSafeInteger(uid) && Number.isSafeInteger(gid), "create-identity");
  return ["create", "--cidfile", cidFile, "--platform=linux/amd64", "--network=none", "--ipc=private", "--cgroupns=private", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true", "--user", `${uid}:${gid}`, "--pids-limit=128", "--cpus=2", "--memory=4g", "--memory-swap=4g", "--stop-timeout=2", "--interactive", "--log-driver=none", "--tmpfs", `/task:rw,noexec,nosuid,nodev,size=2147483648,mode=0700,uid=${uid},gid=${gid}`, "--workdir=/task", "--label", `org.openclaw.edge.nonce=${plan.nonce}`, "--label", `org.openclaw.edge.context=${plan.contextHash}`, "--entrypoint", containerContract.reaper, plan.image, containerContract.node, "/opt/edge-input/scripts/edge-proof.mjs", "container-init", plan.nonce, plan.contextHash, String(uid), String(gid)];
}
export function validateContainerInspect(row, plan, cid, recorder) {
  check(parentEvaluate(recorder, 8, () => parentLeaf(recorder, 1, cidPattern.test(cid)) && parentLeaf(recorder, 2, row.Id === cid) && parentLeaf(recorder, 3, row.Image === plan.image) && parentLeaf(recorder, 4, row.Config?.Labels?.["org.openclaw.edge.nonce"] === plan.nonce) && parentLeaf(recorder, 5, row.Config.Labels["org.openclaw.edge.context"] === plan.contextHash)), "container-custody");
  const h = row.HostConfig, c = row.Config;
  check(parentEvaluate(recorder, 9, () => parentLeaf(recorder, 1, h.NetworkMode === "none") && parentLeaf(recorder, 2, h.PidMode === "") && parentLeaf(recorder, 3, h.IpcMode === "private") && parentLeaf(recorder, 4, h.CgroupnsMode === "private") && parentLeaf(recorder, 5, h.ReadonlyRootfs === true) && parentLeaf(recorder, 6, h.Privileged === false)), "container-isolation");
  check(parentEvaluate(recorder, 10, () => parentLeaf(recorder, 1, same(h.CapDrop, ["ALL"])) && parentLeaf(recorder, 2, (!h.CapAdd || !h.CapAdd.length)) && parentLeaf(recorder, 3, same(h.SecurityOpt, ["no-new-privileges=true"]))), "container-capabilities");
  check(parentEvaluate(recorder, 11, () => parentLeaf(recorder, 1, h.Memory === containerContract.memory) && parentLeaf(recorder, 2, h.MemorySwap === containerContract.memory) && parentLeaf(recorder, 3, h.NanoCpus === containerContract.cpus) && parentLeaf(recorder, 4, h.PidsLimit === containerContract.pids)), "container-limits");
  for (const key of ["Binds", "VolumesFrom", "Devices", "DeviceRequests", "GroupAdd"]) { parentRole(recorder, key); check(parentEvaluate(recorder, 12, () => parentLeaf(recorder, 1, !h[key]) || parentLeaf(recorder, 2, !h[key].length)), "container-extra-input"); }
  for (const key of ["PortBindings", "Sysctls"]) { parentRole(recorder, key); check(parentEvaluate(recorder, 13, () => parentLeaf(recorder, 1, !h[key]) || parentLeaf(recorder, 2, !Object.keys(h[key]).length)), "container-extra-input"); }
  check(parentEvaluate(recorder, 14, () => parentLeaf(recorder, 1, !c.ExposedPorts) || parentLeaf(recorder, 2, !Object.keys(c.ExposedPorts).length)), "container-port");
  // --tmpfs is stored separately from inspect.Mounts (Moby v28.5.2).
  check(parentEvaluate(recorder, 15, () => parentLeaf(recorder, 1, Array.isArray(row.Mounts)) && parentLeaf(recorder, 2, row.Mounts.length === 0)), "container-mounts");
  check(parentEvaluate(recorder, 16, () => parentLeaf(recorder, 1, same(h.Tmpfs, { "/task": `rw,noexec,nosuid,nodev,size=2147483648,mode=0700,uid=${plan.identity.uid[0]},gid=${plan.identity.gid[0]}` }))), "container-tmpfs");
  const expected = createArguments(plan, "/unused");
  check(parentEvaluate(recorder, 17, () => parentLeaf(recorder, 1, same(c.Entrypoint, [containerContract.reaper])) && parentLeaf(recorder, 2, same(c.Cmd, expected.slice(expected.indexOf(plan.image) + 1))) && parentLeaf(recorder, 3, c.User === `${plan.identity.uid[0]}:${plan.identity.gid[0]}`) && parentLeaf(recorder, 4, c.WorkingDir === "/task")), "container-command");
  check(parentEvaluate(recorder, 18, () => parentLeaf(recorder, 1, same(c.Env, plan.imageEnv)) && parentLeaf(recorder, 2, !c.Volumes) && parentLeaf(recorder, 3, !c.OnBuild?.length)), "container-env");
  return row;
}
export function parseControl(text, expectedKind, nonce, contextHash) {
  check(typeof text === "string" && Buffer.byteLength(text) <= 512 && text.endsWith("\n") && !text.slice(0, -1).includes("\n") && text.startsWith(protocol), "control-frame");
  const value = JSON.parse(text.slice(protocol.length)); exactKeys(value, ["v", "kind", "nonce", "contextHash"]);
  check(own(value, "v") === 2 && own(value, "kind") === expectedKind && own(value, "nonce") === nonce && own(value, "contextHash") === contextHash && hashPattern.test(nonce) && hashPattern.test(contextHash), "control-identity"); return value;
}
const control = (kind, nonce, contextHash) => protocol + JSON.stringify({ v: 2, kind, nonce, contextHash }) + "\n";
export function validateTerminal({ wait, attached, inspect, cgroup, receipt }) {
  requireProcessSuccess(wait); requireProcessSuccess(attached);
  check(/^0\n?$/.test(wait.stdout) && wait.stderr === "", "container-exit-not-cli-exit");
  check(inspect.State?.Running === false && inspect.State.Dead === false && inspect.State.ExitCode === 0 && inspect.State.OOMKilled === false && inspect.State.Pid === 0 && inspect.State.Error === "", "container-terminal");
  check(["empty", "removed"].includes(cgroup), "cgroup-not-retired");
  check(receipt?.version === 2 && receipt.isolation === "private-container-pid-net-mount" && receipt.cloud === "UNRUN" && receipt.sdk === "UNRUN", "container-receipt");
  return receipt;
}

const gitEnvironment = Object.freeze({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
async function fileIdentity(path) {
  check(isAbsolute(path) && await realpath(path) === path && (await lstat(path)).isFile(), "native-realpath");
  return { path, sha256: hash(await readFile(path)) };
}
const reaperBuildRoot = "/opt/edge-reaper";
const reaperSource = "/opt/edge-input/config/edge-proof/reaper.c";
const reaperCompileArguments = Object.freeze([
  ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fstack-protector-strong", "-fPIE", "-MD", "-MF", "/opt/edge-reaper/headers.d", "-MT", "reaper", "-c", reaperSource, "-o", "/opt/edge-reaper/reaper.o"],
  ["-pie", "-Wl,-z,relro,-z,now", "-Wl,-t", "/opt/edge-reaper/reaper.o", "-o", "/opt/edge-reaper/reaper"],
]);
export function validateReaperElf(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 64 && bytes.subarray(0,7).equals(Buffer.from([127,69,76,70,2,1,1])) && [0,3].includes(bytes[7]) && bytes[8] === 0 && bytes.readUInt16LE(16) === 3 && bytes.readUInt16LE(18) === 62 && bytes.readUInt32LE(20) === 1, "reaper-elf-linux-x64");
  const offset = bytes.readBigUInt64LE(32), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  check(offset <= BigInt(bytes.length) && size === 56 && count > 0 && count < 64 && offset + BigInt(size * count) <= BigInt(bytes.length), "reaper-elf-headers");
  const interpreters = [];
  for (let i = 0; i < count; i++) {
    const row = Number(offset) + i * size;
    if (bytes.readUInt32LE(row) !== 3) continue;
    const start = bytes.readBigUInt64LE(row + 8), length = bytes.readBigUInt64LE(row + 32);
    check(length > 1n && length < 256n && start + length <= BigInt(bytes.length), "reaper-elf-interpreter");
    const value = bytes.subarray(Number(start), Number(start + length));
    check(value.at(-1) === 0 && !value.subarray(0,-1).includes(0), "reaper-elf-interpreter-nul"); interpreters.push(value.subarray(0,-1).toString("ascii"));
  }
  check(same(interpreters, ["/lib64/ld-linux-x86-64.so.2"]), "reaper-elf-loader"); return interpreters[0];
}
function validateReaperBuild(value, contextHash) {
  exactKeys(value, ["version","contextHash","source","tools","headers","links","arguments","object","binary"]);
  check(value.version === 1 && value.contextHash === contextHash && same(value.arguments, reaperCompileArguments) && value.source.path === reaperSource && hashPattern.test(value.source.sha256) && value.binary.path === containerContract.reaper && hashPattern.test(value.binary.sha256), "reaper-build-binding");
  check(value.object.path === "/opt/edge-reaper/reaper.o" && hashPattern.test(value.object.sha256), "reaper-object-binding");
  for (const row of [value.source,value.object,value.binary,...value.headers,...value.links]) exactKeys(row,["path","sha256"]);
  check(Array.isArray(value.tools) && value.tools.length === 5 && value.tools.map(row => row.role).join() === "gcc,cc1,as,collect2,ld", "reaper-build-tools");
  for (const row of value.tools) {
    exactKeys(row, ["role","path","sha256","version"]); check(typeof row.version === "string" && row.version.length > 0 && row.version.length <= 512 && !/[\x00-\x1f\x7f]/.test(row.version), "reaper-tool-version");
  }
  for (const rows of [value.headers,value.links]) check(Array.isArray(rows) && rows.length > 0 && rows.length <= 512 && new Set(rows.map(row => row.path)).size === rows.length, "reaper-build-closure");
  for (const row of [...value.tools,...value.headers,...value.links]) check(typeof row.path === "string" && /^\/(?:usr|lib|lib64)\/[a-zA-Z0-9_./+-]+$/.test(row.path) && !row.path.split("/").includes("..") && hashPattern.test(row.sha256), "reaper-build-file");
  return value;
}
async function reaperFile(path, executable = false) {
  const canonical = await realpath(path), info = await stat(canonical);
  check([reaperSource,containerContract.reaper,"/opt/edge-reaper/reaper.o"].includes(canonical) || /^\/(?:usr|lib|lib64)\/[a-zA-Z0-9_./+-]+$/.test(canonical) && !canonical.split("/").includes(".."), "reaper-file-root");
  check(info.isFile() && (!executable || (info.mode & 0o111) !== 0), "reaper-build-regular-file");
  return {path:canonical, sha256:hash(await readFile(canonical))};
}
async function compileReaper(contextHash, point) {
  point?.(1);
  check(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1", "reaper-build-runtime");
  point?.(2);
  const inputPlan = JSON.parse(await readFile(join(containerContract.input,".edge-context.json"),"utf8"));
  point?.(3); validateContextPlan(inputPlan,contextHash);
  point?.(4);
  const source = await reaperFile(reaperSource);
  point?.(5);
  check(inputPlan.harness.find(row=>row.path==="config/edge-proof/reaper.c")?.sha256 === source.sha256 && source.path === reaperSource, "reaper-original-source");
  const options = {env:{PATH:"/usr/bin:/bin",LANG:"C",HOME:"/opt/build-home"}, encoding:"utf8", timeout:60000, maxBuffer:1024*1024};
  point?.(6,"gcc");
  const gcc = await reaperFile("/usr/bin/gcc", true);
  point?.(7,"gcc");
  check(execFileSync(gcc.path, ["-dumpmachine"], options).trim() === "x86_64-linux-gnu", "reaper-tool-target");
  const tools = [];
  for (const role of ["gcc","cc1","as","collect2","ld"]) {
    const selected = role === "gcc" ? gcc.path : (point?.(8,role), execFileSync(gcc.path, [`-print-prog-name=${role}`], options).trim());
    point?.(9,role);
    const file = await reaperFile(isAbsolute(selected) ? selected : join("/usr/bin", selected), true);
    point?.(10,role);
    let version;
    if (role === "cc1") {
      // GCC's -version prints to stderr; --version exits before compilation.
      const result = spawnSync(file.path, ["-version", "--version"], options);
      if (result.error) throw result.error;
      check(result.status === 0 && result.signal === null, "reaper-cc1-version-process");
      version = result.stderr.split("\n")[0];
    } else version = execFileSync(file.path, ["--version"], options).split("\n")[0];
    point?.(11,role); tools.push({role,...file,version});
  }
  point?.(12,"gcc");
  execFileSync(gcc.path, [...reaperCompileArguments[0]], options);
  point?.(13,"gcc");
  const trace = execFileSync(gcc.path, [...reaperCompileArguments[1]], options);
  point?.(14);
  const dependencyText = await readFile(join(reaperBuildRoot,"headers.d"),"utf8");
  point?.(15);
  check(dependencyText.startsWith("reaper:"), "reaper-header-format");
  point?.(16);
  const headerPaths = dependencyText.slice(7).replace(/\\\n/g," ").trim().split(/\s+/);
  point?.(17);
  check(headerPaths.includes(reaperSource) && headerPaths.every(path => /^\/[a-zA-Z0-9_./+-]+$/.test(path)), "reaper-header-paths");
  point?.(18);
  const links = trace.trim().split("\n").map(line => line.trim());
  point?.(19);
  check(links.filter(path => path === "/opt/edge-reaper/reaper.o").length === 1, "reaper-original-link-object");
  point?.(20);
  const linked = links.filter(path => path !== "/opt/edge-reaper/reaper.o");
  point?.(21);
  check(linked.every(path => /^\/(?:usr|lib|lib64)\/[a-zA-Z0-9_./+-]+$/.test(path)), "reaper-link-trace");
  point?.(22);
  const loader = validateReaperElf(await readFile(containerContract.reaper));
  const inventory = async paths => {
    const rows = await Promise.all([...new Set(paths)].sort().map(path => reaperFile(path)));
    return [...new Map(rows.map(row => [row.path,row])).values()].sort((a,b)=>a.path.localeCompare(b.path,"en"));
  };
  const value = validateReaperBuild({version:1, contextHash, source, tools,
    headers:await (point?.(23), inventory(headerPaths.filter(path=>path!==reaperSource))),
    links:await (point?.(24), inventory([...linked,loader])),
    arguments:(point?.(25), reaperCompileArguments.map(args=>[...args])),
    object:await (point?.(26), reaperFile("/opt/edge-reaper/reaper.o")),
    binary:await (point?.(27), reaperFile(containerContract.reaper,true))},(point?.(28),contextHash));
  point?.(29);
  let writeOptions;
  await writeFile(join(reaperBuildRoot,"build.json"), JSON.stringify(value), (writeOptions = {flag:"wx",mode:0o444}, point?.(30), writeOptions));
}
async function qualifyReaper(contextHash) {
  const text = await readFile(join(reaperBuildRoot,"build.json"),"utf8"); check(Buffer.byteLength(text) < 128*1024,"reaper-build-capacity");
  const value = validateReaperBuild(JSON.parse(text),contextHash);
  check(JSON.stringify(value) === text,"reaper-build-canonical");
  for (const row of [value.source,value.object,value.binary,...value.tools,...value.headers,...value.links]) check(same(await reaperFile(row.path, row === value.binary || value.tools.includes(row)), {path:row.path,sha256:row.sha256}), "reaper-build-drift");
  validateReaperElf(await readFile(containerContract.reaper));
  return {version:1, contextHash, source:value.source, buildSha256:hash(text), binary:value.binary};
}
function validateReaperIdentity(value, contextHash) {
  exactKeys(value,["version","contextHash","source","buildSha256","binary"]);
  exactKeys(value.source,["path","sha256"]); exactKeys(value.binary,["path","sha256"]);
  check(value.version === 1 && value.contextHash === contextHash && value.source.path === reaperSource && value.binary.path === containerContract.reaper && [value.source.sha256,value.buildSha256,value.binary.sha256].every(value=>hashPattern.test(value)), "reaper-image-identity");
}
export function validateNativeIdentity(receipt, plan) {
  exactKeys(receipt, ["version", "contextHash", "sourceSha", "sourceTree", "install", "runtime", "native", "containedLinks", "reaper"]);
  check(receipt.version === 3 && receipt.contextHash === plan.contextHash && receipt.sourceSha === edgeProof.sourceSha && receipt.sourceTree === edgeProof.sourceTree && same(receipt.install, installInputs), "native-inputs");
  validateReaperIdentity(receipt.reaper, plan.contextHash);
  check(same(receipt.runtime, { node: "v24.22.1", abi: "137", platform: "linux", arch: "x64", pnpm: "11.28.4" }), "native-runtime");
  exactKeys(receipt.native, ["node", "git", "typescript", "esbuild", "wrangler"]);
  for (const [key, value] of Object.entries(receipt.native)) {
    exactKeys(value, ["path", "sha256"]);
    check(typeof value.path === "string" && isAbsolute(value.path) && !value.path.split("/").includes("..") && hashPattern.test(value.sha256), "native-path");
    check(key === "node" ? value.path === containerContract.node : key === "git" ? value.path === containerContract.git : value.path.startsWith("/opt/edge-input/node_modules/.pnpm/"), "native-escape");
  }
  check(receipt.native.wrangler.sha256 === containerContract.cliHash && Number.isSafeInteger(receipt.containedLinks) && receipt.containedLinks > 0, "native-dependencies");
  return receipt;
}
async function qualifyImageInputs(contextHash, prepare) {
  prepare?.enter("runtime");
  check(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1" && process.versions.modules === "137", "image-runtime");
  const root = containerContract.input;
  prepare?.enter("context_read");
  const inputPlan = JSON.parse(await readFile(join(root, ".edge-context.json"), "utf8"));
  prepare?.enter("context_identity");
  validateContextPlan(inputPlan, contextHash);
  prepare?.enter("context_enumeration");
  prepare?.enumerationManifest(inputPlan.files);
  const actual = await contextFiles(root, new Set(["node_modules", "admin/node_modules", ".edge-context.json", ".edge-native.json"]), prepare);
  prepare?.enter("context_byte_closure");
  check(same(actual, inputPlan.files), "context-byte-closure");
  prepare?.enter("input_hashes");
  for (const [path, expected] of Object.entries(installInputs)) check(hash(await readFile(join(root, path))) === expected, "install-input-drift");
  prepare?.enter("link_containment");
  const { containedLinks } = await qualifyInstalledInputs(root);
  prepare?.enter("typescript_anchor");
  const tsRequire = createRequire(await realpath(join(root, "node_modules/typescript/package.json")));
  prepare?.enter("wrangler_anchor");
  const wranglerRequire = createRequire(await realpath(join(root, "node_modules/wrangler/package.json")));
  prepare?.enter("esbuild_resolver");
  const esbuildRequire = createRequire(wranglerRequire.resolve("esbuild/package.json"));
  prepare?.enter("native_node");
  const native = { node: await fileIdentity(containerContract.node) };
  prepare?.enter("native_git");
  native.git = await fileIdentity(containerContract.git);
  prepare?.enter("native_typescript");
  native.typescript = await fileIdentity(await realpath(join(dirname(tsRequire.resolve("@typescript/typescript-linux-x64/package.json")), "lib/tsc")));
  prepare?.enter("native_esbuild");
  native.esbuild = await fileIdentity(await realpath(esbuildRequire.resolve("@esbuild/linux-x64/bin/esbuild")));
  prepare?.enter("native_wrangler");
  native.wrangler = await fileIdentity(join(dirname(await realpath(wranglerRequire.resolve("wrangler/package.json"))), "wrangler-dist/cli.js"));
  const result = { version: 3, contextHash, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, install: { ...installInputs }, runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, pnpm: "11.28.4" }, native, containedLinks, reaper: await qualifyReaper(contextHash) };
  prepare?.enter("native_identity");
  validateNativeIdentity(result, { contextHash });
  // Only installed platform resolvers are allowed. No environment override or
  // downloaded esbuild fallback can satisfy these realpath/hash checks.
  prepare?.enter("typescript_resolver");
  const { default: getTsPath } = await import(new URL("./lib/getExePath.js", `file://${tsRequire.resolve("typescript/package.json")}`).href);
  check(await realpath(getTsPath()) === native.typescript.path, "typescript-resolver");
  prepare?.enter("esbuild_child");
  const esbuildVersion = execFileSync(native.esbuild.path, ["--version"], { env: { LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10000 }).trim();
  prepare?.enter("esbuild_version_check");
  check(esbuildVersion === JSON.parse(await readFile(esbuildRequire.resolve("esbuild/package.json"), "utf8")).version, "esbuild-platform");
  return result;
}
async function contextFiles(root, excluded = new Set(), prepare) {
  const files = []; let size = 0;
  const observation = prepare ? { depth: -1 } : null;
  async function walk(prefix = "") {
    const depth = observation ? ++observation.depth : null;
    try {
      prepare?.enumerationPoint("directory_read", "unknown", depth, files.length, size);
      const entries = await readdir(join(root, prefix), { withFileTypes: true });
      prepare?.enumerationPoint("directory_sort", "unknown", depth, files.length, size);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        prepare?.enumerationPoint("entry_path", "unknown", depth, files.length, size);
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        prepare?.enumerationPoint("exclusion", "unknown", depth, files.length, size);
        if (excluded.has(path)) continue;
        prepare?.enumerationPoint("path_check", "unknown", depth, files.length, size);
        check(/^[a-zA-Z0-9_./-]+$/.test(path) && !path.split("/").includes(".."), "context-path");
        prepare?.enumerationPoint("directory_type", "unknown", depth, files.length, size);
        const directory = entry.isDirectory();
        if (directory) {
          prepare?.enumerationPoint("recursion", "directory", depth, files.length, size);
          await walk(path);
        }
        else {
          prepare?.enumerationPoint("file_type", "not_directory", depth, files.length, size);
          const file = entry.isFile();
          prepare?.enumerationPoint("file_type_check", file ? "file" : "other", depth, files.length, size);
          check(file, "context-link-or-special");
          prepare?.enumerationPath(path);
          prepare?.enumerationPoint("file_read", "file", depth, files.length, size);
          const bytes = await readFile(join(root, path));
          prepare?.enumerationPoint("byte_count", "file", depth, files.length, size);
          size += bytes.length;
          prepare?.enumerationBytes(size);
          prepare?.enumerationPoint("capacity", "file", depth, files.length, size);
          check(files.length < 50000 && size <= 256 * 1024 * 1024, "context-capacity");
          prepare?.enumerationPoint("hash", "file", depth, files.length, size);
          const sha256 = hash(bytes);
          prepare?.enumerationPoint("file_record", "file", depth, files.length, size);
          files.push({ path, sha256, bytes: bytes.length });
        }
      }
    } finally { if (observation) observation.depth--; }
  }
  try {
    await walk();
    prepare?.enumerationPoint("final_sort", "unknown", 0, files.length, size);
    return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  } catch (error) {
    prepare?.enumerationFailure(error);
    throw error;
  }
}
async function writeExclusive(root, path, bytes) {
  const target = join(root, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}
// These owners are attested by the trusted setup parent and bound together by
// contextHash. Current bytes are never installed or copied over the checkout.
const gitObjectHash = (type, bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])).digest("hex");
function inventoryRow(path, bytes) { return { path, blob: gitObjectHash("blob", bytes), sha256: hash(bytes), bytes: bytes.length }; }
function validateInventory(rows, paths, withBlob = true) {
  check(Array.isArray(rows) && rows.length === paths.length, "owner-inventory-count");
  for (let i = 0; i < paths.length; i++) {
    const row = rows[i]; exactKeys(row, withBlob ? ["path", "blob", "sha256", "bytes"] : ["path", "sha256", "bytes"]);
    check(own(row, "path") === paths[i] && hashPattern.test(own(row, "sha256")) && Number.isSafeInteger(own(row, "bytes")) && row.bytes >= 0 && row.bytes <= 256 * 1024 * 1024, "owner-inventory-entry");
    if (withBlob) check(shaPattern.test(own(row, "blob")), "owner-inventory-blob");
  }
}
export function validateContextPlan(plan, contextHash) {
  exactKeys(plan, ["version", "current", "frozen", "harness", "files"]);
  check(own(plan, "version") === 3 && hash(JSON.stringify(plan)) === contextHash, "context-identity");
  const current = own(plan, "current"), frozen = own(plan, "frozen"), harness = own(plan, "harness"), files = own(plan, "files");
  exactKeys(current, ["scope", "commit", "tree", "workspaceMembers", "files"]);
  check(own(current, "scope") === "observed-not-installed-or-native-qualified" && shaPattern.test(own(current, "commit")) && shaPattern.test(own(current, "tree")) && same(own(current, "workspaceMembers"), currentWorkspaceMembers), "current-owner");
  validateInventory(own(current, "files"), currentInputInventory.map(row => row.path));
  check(same(current.files, currentInputInventory), "current-input-closure");
  exactKeys(frozen, ["scope", "commit", "tree", "files"]);
  check(own(frozen, "scope") === "frozen-worker-install" && own(frozen, "commit") === edgeProof.sourceSha && own(frozen, "tree") === edgeProof.sourceTree, "frozen-owner");
  validateInventory(own(frozen, "files"), Object.keys(installInputs).sort());
  for (const row of frozen.files) check(row.sha256 === installInputs[row.path] && row.blob === frozenInstallBlobs[row.path], "frozen-input-digest");
  validateInventory(harness, [...harnessInputs].sort());
  check(Array.isArray(files) && files.length > 0 && files.length <= 50000, "materialized-inventory");
  const paths = files.map(row => own(row, "path"));
  check(paths.every(path => typeof path === "string" && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith("/") && path.split("/").every(part => part && part !== "." && part !== "..")) && new Set(paths).size === paths.length && same(paths, [...paths].sort((a, b) => a.localeCompare(b, "en"))), "materialized-paths");
  validateInventory(files, paths, false);
  let size = 0; for (const row of files) size += row.bytes;
  check(size <= 256 * 1024 * 1024, "materialized-capacity");
  const expected = new Map([...harness, ...frozen.files].map(row => [row.path, row]));
  for (const row of files) {
    if (expected.has(row.path)) { const original = expected.get(row.path); check(row.sha256 === original.sha256 && row.bytes === original.bytes, "materialized-owner-bytes"); expected.delete(row.path); }
    else check(row.path === ".git/HEAD" || row.path === ".git/shallow" || /^\.git\/objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(row.path), "materialized-unowned-input");
  }
  check(expected.size === 0 && paths.includes(".git/HEAD") && paths.includes(".git/shallow"), "materialized-owner-closure");
  return plan;
}
async function observeCurrentInputs(cwd, original) {
  check(isAbsolute(cwd) && await realpath(cwd) === cwd, "current-root");
  const commit = original(cwd, ["rev-parse", "HEAD"]).toString().trim(); check(shaPattern.test(commit), "current-commit");
  const commitBytes = original(cwd, ["cat-file", "commit", commit]);
  const tree = original(cwd, ["rev-parse", `${commit}^{tree}`]).toString().trim();
  check(shaPattern.test(tree) && gitObjectHash("commit", commitBytes) === commit && commitBytes.toString().split("\n")[0] === `tree ${tree}` && gitObjectHash("tree", original(cwd, ["cat-file", "tree", tree])) === tree, "current-tree");
  const entries = new Map();
  for (const entry of original(cwd, ["ls-tree", "-rz", commit]).toString().split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), path = entry.slice(tab + 1), [mode, type, blob] = entry.slice(0, tab).split(" ");
    check(tab > 0 && !entries.has(path), "current-git-inventory"); entries.set(path, { mode, type, blob });
  }
  const packagePaths = currentInputInventory.map(row => row.path).filter(path => path.startsWith("packages/provider-plugin-contract/"));
  check(same([...entries.keys()].filter(path => path.startsWith("packages/provider-plugin-contract/")).sort(), packagePaths), "current-package-closure");
  const bytes = new Map(), inventory = new Map();
  for (const path of [...new Set([...harnessInputs, ...currentInputInventory.map(row => row.path)])].sort()) {
    const entry = entries.get(path); check(entry && ["100644", "100755"].includes(entry.mode) && entry.type === "blob" && shaPattern.test(entry.blob), "current-git-file");
    const candidate = join(cwd, path); check(await realpath(candidate) === candidate && (await lstat(candidate)).isFile(), "current-regular-file");
    const data = await readFile(candidate), gitBytes = original(cwd, ["cat-file", "blob", entry.blob]);
    check(gitObjectHash("blob", gitBytes) === entry.blob && data.equals(gitBytes), "current-git-bytes");
    bytes.set(path, data); inventory.set(path, inventoryRow(path, data));
  }
  const files = currentInputInventory.map(row => inventory.get(row.path));
  check(same(files, currentInputInventory) && original(cwd, ["rev-parse", "HEAD"]).toString().trim() === commit, "current-input-drift");
  return { current: { scope: "observed-not-installed-or-native-qualified", commit, tree, workspaceMembers: [...currentWorkspaceMembers], files }, harness: [...harnessInputs].sort().map(path => inventory.get(path)), bytes };
}
async function materializeOwnedInputs(cwd, input, observed, frozenBlobs) {
  const fromCheckout = relative(cwd, input);
  check(isAbsolute(input) && resolve(input) === input && fromCheckout.startsWith(".." + "/"), "exclusive-proof-root");
  const frozen = { scope: "frozen-worker-install", commit: edgeProof.sourceSha, tree: edgeProof.sourceTree, files: [] };
  for (const path of Object.keys(installInputs).sort()) {
    const row = frozenBlobs.get(path);
    check(row && Buffer.isBuffer(row.bytes) && gitObjectHash("blob", row.bytes) === row.blob && row.blob === frozenInstallBlobs[path] && hash(row.bytes) === installInputs[path], "frozen-install-input");
    frozen.files.push(inventoryRow(path, row.bytes));
  }
  for (const row of observed.harness) {
    const bytes = observed.bytes.get(row.path); check(bytes && same(inventoryRow(row.path, bytes), row), "harness-snapshot-drift");
    await writeExclusive(input, row.path, bytes);
  }
  for (const row of frozen.files) await writeExclusive(input, row.path, frozenBlobs.get(row.path).bytes);
  return frozen;
}
async function createBuildContext(cwd, root) {
  const git = (await fileIdentity(containerContract.git)).path;
  const original = (directory, args, input) => execFileSync(git, args, { cwd: directory, env: gitEnvironment, input, maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const observed = await observeCurrentInputs(cwd, original);
  const fetchRoot = join(root, "source-fetch"), context = join(root, "context"), input = join(context, "input");
  await mkdir(fetchRoot); await mkdir(input, { recursive: true });
  original(fetchRoot, ["init", "--bare", "--template="]);
  // Public, anonymous source setup only. No checkout config, URL rewrite,
  // inherited proxy, credential helper, remote, hook or unrelated history.
  original(fetchRoot, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.writeCommitGraph=false", "fetch", "--no-auto-maintenance", "--no-tags", "--no-prune", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--depth=1", "https://github.com/openclaw/clawrouter.git", edgeProof.sourceSha]);
  check(original(fetchRoot, ["rev-parse", `${edgeProof.sourceSha}^{tree}`]).toString().trim() === edgeProof.sourceTree, "source-tree");
  const entries = original(fetchRoot, ["ls-tree", "-rtz", edgeProof.sourceSha]).toString().split("\0").filter(Boolean);
  const objects = new Map([[edgeProof.sourceSha, "commit"], [edgeProof.sourceTree, "tree"]]), frozenPaths = new Map(), frozenBlobs = new Map();
  for (const entry of entries) {
    const [meta, path] = entry.split("\t"), [mode, type, oid] = meta.split(" ");
    check(["100644", "100755", "040000"].includes(mode) && ["blob", "tree"].includes(type) && shaPattern.test(oid) && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.split("/").includes(".."), "source-object-entry"); objects.set(oid, type);
    if (Object.hasOwn(installInputs, path)) { check(type === "blob" && mode === "100644", "frozen-input-mode"); frozenPaths.set(path, oid); }
  }
  check(objects.size < 25000, "source-object-capacity"); let sourceBytes = 0;
  for (const [oid, type] of [...objects].sort()) {
    const bytes = original(fetchRoot, ["cat-file", type, oid]); sourceBytes += bytes.length; check(sourceBytes <= 256 * 1024 * 1024, "source-byte-capacity");
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    check(createHash("sha1").update(raw).digest("hex") === oid, "source-object-hash");
    await writeExclusive(input, `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, deflateSync(raw));
    for (const [path, blob] of frozenPaths) if (blob === oid) frozenBlobs.set(path, { blob, bytes });
  }
  await writeExclusive(input, ".git/HEAD", edgeProof.sourceSha + "\n");
  await writeExclusive(input, ".git/shallow", edgeProof.sourceSha + "\n"); await mkdir(join(input, ".git/refs"));
  const frozen = await materializeOwnedInputs(cwd, input, observed, frozenBlobs);
  const files = await contextFiles(input);
  const inputPlan = { version: 3, current: observed.current, frozen, harness: observed.harness, files };
  const contextHash = hash(JSON.stringify(inputPlan)); validateContextPlan(inputPlan, contextHash);
  await writeExclusive(input, ".edge-context.json", JSON.stringify(inputPlan));
  await writeExclusive(context, "Dockerfile", observed.bytes.get("config/edge-proof/Dockerfile"));
  return { context, contextHash, files, dockerfileHash: hash(await readFile(join(context, "Dockerfile"))) };
}

export function createMountObservation(recorder, predicate, initialRole) {
  let seen = 0, passed = 0, leaf = null, role = null, fs = null, root = null, count = null, distinct = null, overflow = 0, broken = false, finished = false;
  const note = operation => { if (recorder) try { operation(); } catch (error) { broken = true; recorder.errors.push(error); } };
  const value = (kind, original) => { note(() => {
    if (finished) fail("mount-observation-finished");
    if (kind === "role") role = typeof original === "string" ? mountTargets.indexOf(original) + 2 : null;
    else if (kind === "fs") fs = typeof original === "string" ? mountFilesystems.indexOf(original) + 2 : null;
    else if (kind === "root") root = typeof original === "string" ? original === "/" ? 1 : original === "/null" ? 2 : 3 : null;
    else if (kind === "count" || kind === "distinct") {
      const valid = Number.isSafeInteger(original) && original >= 0, n = valid ? Math.min(original, 4095) : null, bit = kind === "count" ? 1 : 2;
      if (kind === "count") count = n; else distinct = n;
      overflow = (overflow & ~bit) | (valid && original > 4095 ? bit : 0);
    } else fail("mount-observation-kind");
  }); return original; };
  if (initialRole !== undefined) value("role", initialRole);
  return { value,
    leaf(id, original) { note(() => { if (finished || !Number.isInteger(id) || id < 1 || id > 8) fail("mount-observation-leaf"); const bit = 2 ** (id - 1); seen |= bit; if (original) passed |= bit; else { passed &= ~bit; leaf = id; } }); return original; },
    check(original, code) {
      if (recorder && !original && !broken) note(() => { if (finished) fail("mount-observation-finished"); recorder.mount([1, predicate, leaf, role, fs, root, seen, passed, count, distinct, overflow]); });
      finished = true;
      initGuardCheck(original, code, recorder, "mounts");
    },
  };
}
function canonicalMountPath(path, recorder, kind) {
  const m = createMountObservation(recorder, 1); if (kind) m.value(kind, path);
  m.check(m.leaf(1, typeof path === "string") && m.leaf(2, path.startsWith("/")) && m.leaf(3, !/[\x00-\x1f\x7f]/.test(path)) && m.leaf(4, path === "/" || path.slice(1).split("/").every(part => part && part !== "." && part !== "..")), "mount-path");
  return path;
}
function decodeMountPath(path, recorder, kind) {
  // Decode only the documented mountinfo escapes; original path checks remain.
  const m = createMountObservation(recorder, 2);
  m.check(m.leaf(1, !/\\(?!040|011|012|134)/.test(path)), "mount-escape");
  return canonicalMountPath(path.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))), recorder, kind);
}
function mountTable(rows, recorder) {
  { const m = createMountObservation(recorder, 3); m.check(m.leaf(1, Array.isArray(rows)) && m.leaf(2, m.value("count", rows.length) > 0) && m.leaf(3, m.value("count", rows.length) < 4096), "mount-capacity"); }
  for (const row of rows) {
    { const m = createMountObservation(recorder, 4); m.check(m.leaf(1, Number.isSafeInteger(row.id)) && m.leaf(2, row.id > 0) && m.leaf(3, Number.isSafeInteger(row.parentId)) && m.leaf(4, row.parentId >= 0) && m.leaf(5, /^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(row.device)), "mount-identity"); }
    const target = canonicalMountPath(row.target, recorder, "role"); canonicalMountPath(row.root, recorder, "root");
    { const m = createMountObservation(recorder, 5, target); m.check(m.leaf(1, typeof m.value("fs", row.fs) === "string") && m.leaf(2, /^[a-zA-Z0-9._-]+$/.test(m.value("fs", row.fs))), "mount-filesystem"); }
    let channel = 0;
    for (const options of [row.options, row.superOptions]) {
      const m = createMountObservation(recorder, 6 + channel++, target);
      m.check(m.leaf(1, Array.isArray(options)) && m.leaf(2, m.value("count", options.length) > 0) && m.leaf(3, options.every(value => typeof value === "string" && value.length > 0)) && m.leaf(4, m.value("distinct", new Set(options).size) === m.value("count", options.length)) && m.leaf(5, options.filter(value => value === "rw" || value === "ro").length === 1), "mount-options");
    }
    { const m = createMountObservation(recorder, 8, target); m.check(m.leaf(1, Array.isArray(row.optional)), "mount-optional"); }
  }
  { const m = createMountObservation(recorder, 9); m.check(m.leaf(1, m.value("distinct", new Set(rows.map(row => row.id)).size) === m.value("count", rows.length)) && m.leaf(2, m.value("distinct", new Set(rows.map(row => row.target)).size) === m.value("count", rows.length)), "mount-overmount"); }
  return rows;
}
// Linux e8f897f4 fs/namespace.c delegates show_path; fs/nsfs.c can emit
// nonabsolute filesystem roots. Only parent snapshots admit these as data;
// selected path authorities and every child/target root remain strict.
function parentMountRoot(root, recorder) {
  const m = createMountObservation(recorder, 30); m.value("root", root);
  m.check(m.leaf(1, typeof root === "string") && m.leaf(2, root.length > 0) && m.leaf(3, root.length < 128 * 1024) && m.leaf(4, !/[\x00-\x1f\x7f]/.test(root)), "parent-mount-root-field");
  return root;
}
function decodeParentMountRoot(field, recorder) {
  parentMountRoot(field, recorder);
  const m = createMountObservation(recorder, 2);
  m.check(m.leaf(1, !/\\(?!040|011|012|134)/.test(field)), "mount-escape");
  return parentMountRoot(field.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))), recorder);
}
function parentMountTable(rows, recorder) {
  { const m = createMountObservation(recorder, 3); m.check(m.leaf(1, Array.isArray(rows)) && m.leaf(2, m.value("count", rows.length) > 0) && m.leaf(3, m.value("count", rows.length) < 4096), "mount-capacity"); }
  for (const row of rows) {
    { const m = createMountObservation(recorder, 4); m.check(m.leaf(1, Number.isSafeInteger(row.id)) && m.leaf(2, row.id > 0) && m.leaf(3, Number.isSafeInteger(row.parentId)) && m.leaf(4, row.parentId >= 0) && m.leaf(5, /^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(row.device)), "mount-identity"); }
    const target = canonicalMountPath(row.target, recorder, "role"); parentMountRoot(row.root, recorder);
    { const m = createMountObservation(recorder, 5, target); m.check(m.leaf(1, typeof m.value("fs", row.fs) === "string") && m.leaf(2, /^[a-zA-Z0-9._-]+$/.test(m.value("fs", row.fs))), "mount-filesystem"); }
    let channel = 0;
    for (const options of [row.options, row.superOptions]) {
      const m = createMountObservation(recorder, 6 + channel++, target);
      m.check(m.leaf(1, Array.isArray(options)) && m.leaf(2, m.value("count", options.length) > 0) && m.leaf(3, options.every(value => typeof value === "string" && value.length > 0)) && m.leaf(4, m.value("distinct", new Set(options).size) === m.value("count", options.length)) && m.leaf(5, options.filter(value => value === "rw" || value === "ro").length === 1), "mount-options");
    }
    { const m = createMountObservation(recorder, 8, target); m.check(m.leaf(1, Array.isArray(row.optional)), "mount-optional"); }
  }
  { const m = createMountObservation(recorder, 9); m.check(m.leaf(1, m.value("distinct", new Set(rows.map(row => row.id)).size) === m.value("count", rows.length)), "mount-overmount"); }
  return rows;
}
const containsMountPath = (parent, path) => parent === "/" || path === parent || path.startsWith(parent + "/");
const mountTuple = row => ({ id: row.id, parentId: row.parentId, target: row.target, root: row.root, device: row.device, fs: row.fs, options: [...row.options].sort(), superOptions: [...row.superOptions].sort(), optional: [...row.optional].sort() });
// Linux e8f897f4 mount enumeration includes covered mount objects. Parent
// snapshots retain them; only an invocation's validated authorities may use rows.
const parentMountAuthorities = new WeakMap();
function createParentMountAuthority(inspect, daemonRoot, cid, recorder) {
  parentRole(recorder, "ParentAuthority");
  cgroupCheck(recorder, 59, cidPattern.test(cid) && typeof daemonRoot === "string" && Boolean(inspect));
  canonicalMountPath(daemonRoot, recorder);
  const sources = [];
  for (const [key, name] of [["ResolvConfPath", "resolv.conf"], ["HostnamePath", "hostname"], ["HostsPath", "hosts"]]) {
    parentRole(recorder, key);
    const source = inspect[key];
    cgroupCheck(recorder, 59, source === join(daemonRoot, "containers", cid, name));
    sources.push(Object.freeze({ role: key, path: source }));
  }
  const token = {};
  parentMountAuthorities.set(token, { cid, sources });
  return token;
}
function validateParentMountAuthorities(rows, token, recorder) {
  parentRole(recorder, "ParentAuthority");
  const authority = token && parentMountAuthorities.get(token);
  cgroupCheck(recorder, 59, Boolean(authority));
  const counts = new Map();
  for (const row of rows) counts.set(row.target, (counts.get(row.target) ?? 0) + 1);
  // The entire cgroup subtree protects the mapping, owned directory, its parent,
  // four limits and retirement files. No caller-supplied or empty path list.
  for (const { role, path } of [...authority.sources, { role: "CgroupMount", path: "/sys/fs/cgroup" }]) {
    parentRole(recorder, role);
    for (const row of rows) if (counts.get(row.target) > 1) {
      cgroupCheck(recorder, 55, !(row.target !== path && containsMountPath(row.target, path)));
      cgroupCheck(recorder, 56, row.target !== path);
      cgroupCheck(recorder, 57, !containsMountPath(path, row.target));
    }
    if (role !== "CgroupMount") cgroupCheck(recorder, 58, rows.every(row => !containsMountPath(path, row.target)));
  }
}
export function parseMounts(text, privateView = true, recorder) {
  { const m = createMountObservation(recorder, 10); m.check(m.leaf(1, typeof text === "string") && m.leaf(2, m.value("count", text.length) > 0) && m.leaf(3, m.value("count", text.length) < 128 * 1024), "mount-capacity"); }
  return mountTable(text.replace(/\n$/, "").split("\n").map(line => {
    const halves = line.split(" - ");
    { const m = createMountObservation(recorder, 11); m.check(m.leaf(1, m.value("count", halves.length) === 2), "mount-format"); }
    const a = halves[0].split(" "), b = halves[1].split(" ");
    { const m = createMountObservation(recorder, 12); m.check(m.leaf(1, a.length >= 6) && m.leaf(2, b.length === 3) && m.leaf(3, [...a, ...b].every(Boolean)) && m.leaf(4, /^[1-9]\d*$/.test(a[0])) && m.leaf(5, /^(0|[1-9]\d*)$/.test(a[1])), "mount-format"); }
    const optional = a.slice(6);
    { const m = createMountObservation(recorder, 13); m.check(m.leaf(1, optional.every(value => /^(?:(?:shared|master|propagate_from):[1-9]\d*|unbindable)$/.test(value))) && m.leaf(2, !privateView || !optional.some(value => /^(shared|master|propagate_from):/.test(value))), "shared-mount"); }
    return { id: Number(a[0]), parentId: Number(a[1]), target: decodeMountPath(a[4], recorder, "role"), root: decodeMountPath(a[3], recorder, "root"), device: a[2], options: a[5].split(","), fs: b[0], superOptions: b[2].split(","), optional };
  }), recorder);
}
function parseParentMounts(text, recorder) {
  { const m = createMountObservation(recorder, 10); m.check(m.leaf(1, typeof text === "string") && m.leaf(2, m.value("count", text.length) > 0) && m.leaf(3, m.value("count", text.length) < 128 * 1024), "mount-capacity"); }
  return parentMountTable(text.replace(/\n$/, "").split("\n").map(line => {
    const halves = line.split(" - ");
    { const m = createMountObservation(recorder, 11); m.check(m.leaf(1, m.value("count", halves.length) === 2), "mount-format"); }
    const a = halves[0].split(" "), b = halves[1].split(" ");
    { const m = createMountObservation(recorder, 12); m.check(m.leaf(1, a.length >= 6) && m.leaf(2, b.length === 3) && m.leaf(3, [...a, ...b].every(Boolean)) && m.leaf(4, /^[1-9]\d*$/.test(a[0])) && m.leaf(5, /^(0|[1-9]\d*)$/.test(a[1])), "mount-format"); }
    const optional = a.slice(6);
    { const m = createMountObservation(recorder, 13); m.check(m.leaf(1, optional.every(value => /^(?:(?:shared|master|propagate_from):[1-9]\d*|unbindable)$/.test(value))) && m.leaf(2, true), "shared-mount"); }
    return { id: Number(a[0]), parentId: Number(a[1]), target: decodeMountPath(a[4], recorder, "role"), root: decodeParentMountRoot(a[3], recorder), device: a[2], options: a[5].split(","), fs: b[0], superOptions: b[2].split(","), optional };
  }), recorder);
}
export function validateMountFreshness(before, after, recorder) {
  const snapshot = rows => mountTable(rows, recorder).map(mountTuple).sort((a, b) => a.id - b.id);
  // IDs are namespace-local and may be reused after unmount. This compares two
  // observations in ONE unchanged namespace, not continuous/ABA-free custody.
  check(parentEvaluate(recorder, 25, () => parentLeaf(recorder, 1, same(snapshot(before), snapshot(after)))), "mount-observation-drift");
}
// mountinfo identifies the filesystem and bind root independently of directory
// traversal permissions. Never stat Docker's root-owned private storage.
export function validateMetadataMounts(inspect, targetMounts, parentMounts, daemonRoot, cid, recorder) {
  check(parentEvaluate(recorder, 19, () => parentLeaf(recorder, 1, cidPattern.test(cid))), "daemon-root-identity"); canonicalMountPath(daemonRoot, recorder);
  parentMountTable(parentMounts, recorder); mountTable(targetMounts, recorder);
  const authority = createParentMountAuthority(inspect, daemonRoot, cid, recorder);
  validateParentMountAuthorities(parentMounts, authority, recorder);
  const result = [];
  for (const [key, name] of [["ResolvConfPath", "resolv.conf"], ["HostnamePath", "hostname"], ["HostsPath", "hosts"]]) {
    parentRole(recorder, key); const source = inspect[key];
    check(parentEvaluate(recorder, 20, () => parentLeaf(recorder, 1, source === join(daemonRoot, "containers", cid, name))), "daemon-metadata-custody");
    const candidates = parentMounts.filter(row => containsMountPath(row.target, source)).sort((a, b) => b.target.length - a.target.length);
    check(parentEvaluate(recorder, 21, () => parentLeaf(recorder, 1, parentCount(recorder, candidates.length) > 0) && parentLeaf(recorder, 2, (parentCount(recorder, candidates.length) === 1 || candidates[0].target.length > candidates[1].target.length))), "daemon-metadata-parent-ambiguous");
    const parent = candidates[0], matches = targetMounts.filter(row => row.target === `/etc/${name}`);
    check(parentEvaluate(recorder, 22, () => parentLeaf(recorder, 1, parentCount(recorder, matches.length) === 1)), "daemon-metadata-target");
    // ext4/xfs expose the same resolved filesystem-relative dentry root in both
    // namespaces. Overlay/unknown mappings stop here. A symlink alias whose
    // resolved root differs cannot be certified by lexical normalization.
    check(parentEvaluate(recorder, 23, () => parentLeaf(recorder, 1, ["ext4", "xfs"].includes(parent.fs))), "daemon-metadata-filesystem-unqualified");
    canonicalMountPath(parent.root, recorder, "root");
    const target = matches[0], root = join(parent.root, relative(parent.target, source));
    check(parentEvaluate(recorder, 24, () => parentLeaf(recorder, 1, target.root === root) && parentLeaf(recorder, 2, target.device === parent.device) && parentLeaf(recorder, 3, target.fs === parent.fs) && parentLeaf(recorder, 4, target.options.includes("ro"))), "daemon-metadata-mount-identity");
    // Keep each namespace's IDs separately, including selected parent ancestry.
    result.push({ name, parent: candidates.map(mountTuple), target: mountTuple(target) });
  }
  return result;
}
const directoryMaskTargets = Object.freeze(["/proc/asound", "/proc/acpi", "/proc/scsi", "/sys/firmware", "/sys/devices/virtual/powercap"]);
const thermalMaskTarget = path => /^\/sys\/devices\/system\/cpu\/cpu(0|[1-9]\d*)\/thermal_throttle$/.test(path);
const isDirectoryMask = target => directoryMaskTargets.includes(target) || thermalMaskTarget(target);
export function validateMounts(rows, recorder, cgroupView) {
  const parentView = cgroupView === undefined ? null : requireCgroupView(cgroupView, rows, recorder);
  mountTable(rows, recorder);
  // moby v28.5.2 oci/defaults.go: automatic mounts and conditional masks.
  const readonlyProc = ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"];
  const fileMasks = ["/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug"];
  const directoryMasks = directoryMaskTargets;
  const automatic = {
    "/task": ["tmpfs", "rw", "nosuid", "nodev", "noexec"], "/proc": ["proc", "rw", "nosuid", "nodev", "noexec"],
    "/dev": ["tmpfs", "rw", "nosuid"], "/dev/pts": ["devpts", "rw", "nosuid", "noexec"],
    "/dev/shm": ["tmpfs", "rw", "nosuid", "nodev", "noexec"], "/dev/mqueue": ["mqueue", "rw", "nosuid", "nodev", "noexec"],
    "/sys": ["sysfs", "ro", "nosuid", "nodev", "noexec"], "/sys/fs/cgroup": ["cgroup2", "ro", "nosuid", "nodev", "noexec"],
  };
  const metadata = ["/etc/resolv.conf", "/etc/hostname", "/etc/hosts"];
  const thermalMask = thermalMaskTarget;
  const permitted = new Set(["/", ...Object.keys(automatic), ...metadata, ...readonlyProc, ...fileMasks, ...directoryMasks]);
  {
    let failingRow;
    const allowed = rows.every(row => { const m = createMountObservation(recorder, 14); const value = m.leaf(1, permitted.has(m.value("role", row.target))) || m.leaf(2, thermalMask(m.value("role", row.target))); if (!value) failingRow = m; return value; });
    (failingRow ?? createMountObservation(recorder, 14)).check(allowed, "mount-topology");
  }
  for (const target of ["/", "/task", "/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts"]) {
    const m = createMountObservation(recorder, 15, target); m.check(m.leaf(1, rows.some(row => row.target === target)), "mount-missing");
  }
  const at = path => rows.find(row => row.target === path), root = at("/"), dev = at("/dev"), proc = at("/proc");
  { const m = createMountObservation(recorder, 16, "/"); m.check(m.leaf(1, root.options.includes("ro")) && m.leaf(2, m.value("root", root.root) === "/") && m.leaf(3, ["overlay", "ext4", "xfs"].includes(m.value("fs", root.fs))), "root-not-readonly"); }
  for (const row of rows.filter(row => row.target !== "/")) {
    const m = createMountObservation(recorder, 17);
    const parent = rows.filter(candidate => candidate.target !== m.value("role", row.target) && containsMountPath(candidate.target, row.target)).sort((a, b) => b.target.length - a.target.length)[0];
    m.check(m.leaf(1, parent) && m.leaf(2, row.parentId === parent.id), "mount-parent");
    let target; const targetValue = value => { target = value; return value; };
    if (automatic[targetValue(row.target)]) {
      const [fs, ...flags] = automatic[targetValue(row.target)], mapped = parentView && target === "/sys/fs/cgroup", m = createMountObservation(recorder, mapped ? 29 : 18, target);
      m.check(m.leaf(1, m.value("fs", row.fs) === fs) && m.leaf(2, m.value("root", row.root) === (mapped ? parentView.membership : "/")) && m.leaf(3, row.device.startsWith("0:")) && flags.every(flag => m.leaf({ rw: 4, ro: 5, nosuid: 6, nodev: 7, noexec: 8 }[flag], row.options.includes(flag))), "automatic-mount");
    } else if (metadata.includes(targetValue(row.target))) {
      const m = createMountObservation(recorder, 19, target); m.check(m.leaf(1, ["ext4", "xfs"].includes(m.value("fs", row.fs))) && m.leaf(2, row.options.includes("ro")), "metadata-mount");
    } else if (readonlyProc.includes(targetValue(row.target))) {
      const m = createMountObservation(recorder, 20, target);
      m.check(m.leaf(1, m.value("fs", row.fs) === "proc") && m.leaf(2, row.device === proc.device) && m.leaf(3, m.value("root", row.root) === row.target.slice(5)) && ["ro", "nosuid", "nodev", "noexec"].every(flag => m.leaf({ ro: 4, nosuid: 5, nodev: 6, noexec: 7 }[flag], row.options.includes(flag))), "proc-readonly-mount");
    } else if (fileMasks.includes(targetValue(row.target))) {
      // The original /dev/null identity and sorted-option comparisons remain.
      const m = createMountObservation(recorder, 21, target);
      m.check(m.leaf(1, m.value("fs", row.fs) === dev.fs) && m.leaf(2, row.device === dev.device) && m.leaf(3, m.value("root", row.root) === "/null") && m.leaf(4, same([...row.options].sort(), [...dev.options].sort())) && m.leaf(5, same([...row.superOptions].sort(), [...dev.superOptions].sort())), "null-mask-mount");
    } else {
      const m = createMountObservation(recorder, 27, target);
      m.check(m.leaf(1, m.value("fs", row.fs) === "tmpfs") && m.leaf(2, row.device.startsWith("0:")) && m.leaf(3, m.value("root", row.root) === "/") && m.leaf(4, row.options.includes("ro")) && m.leaf(5, row.superOptions.includes("ro")) && m.leaf(6, rows.every(other => other === row || other.device !== row.device || isDirectoryMask(other.target) && other.fs === "tmpfs" && other.device.startsWith("0:") && other.root === "/" && other.options.includes("ro") && other.superOptions.includes("ro"))), "directory-mask-mount");
    }
  }
  const devices = Object.keys(automatic).map(path => at(path).device);
  { const m = createMountObservation(recorder, 23); m.check(m.leaf(1, m.value("distinct", new Set(devices).size) === m.value("count", devices.length)), "automatic-mount-device-alias"); }
  { const m = createMountObservation(recorder, 24, "/task"); m.check(m.leaf(1, at("/task").superOptions.includes("size=2097152k")), "task-mount"); }
  { const m = createMountObservation(recorder, 25, "/dev"); m.check(m.leaf(1, dev.superOptions.includes("size=65536k")) && m.leaf(2, dev.superOptions.includes("mode=755")), "dev-mount"); }
  { const m = createMountObservation(recorder, 26, "/dev/shm"); m.check(m.leaf(1, at("/dev/shm").superOptions.includes("size=65536k")), "shm-mount"); }
  return true;
}
// Node v24.22.1 fs.Dir uses the held proc-FD path, bufferSize 1, and explicit
// read/close promises. Native closedir errno is not exposed by bundled libuv.
export function validateMaskCompletion(value, recorder) {
  check(receiptLeaf(recorder, 1, Array.isArray(value)) && receiptLeaf(recorder, 2, value.length === 6) && receiptLeaf(recorder, 3, value[0] === 1) && receiptLeaf(recorder, 4, Number.isInteger(value[1])) && receiptLeaf(recorder, 5, value[1] >= 0) && receiptLeaf(recorder, 6, value[1] < 4096) && receiptLeaf(recorder, 7, value.slice(2, 5).every(n => n === value[1])) && receiptLeaf(recorder, 8, value[5] === "UNOBSERVABLE"), "mask-completion");
  return value;
}
export async function validateEmptyMasks(rows, recorder, io = { open, opendir, realpath, lstat, readFile, readlink, constants: fsConstants }) {
  validateMounts(rows, recorder);
  const targets = rows.filter(row => isDirectoryMask(row.target)), errors = [];
  let completed = 0, role = null, readState = 0, dirClose = 0, anchorClose = 0;
  const phase = value => initRecord(recorder, "source", value);
  const expect = (value, code) => initGuardCheck(value, code, recorder, "mounts");
  const snapshot = async () => parseMounts(await io.readFile("/proc/self/mountinfo", "utf8"));
  const ns = async () => { const value = await io.readlink("/proc/self/ns/mnt"); expect(/^mnt:\[\d+\]$/.test(value), "mask-namespace"); return value; };
  try {
    phase("mask_namespace"); const namespace = await ns();
    phase("mask_snapshot"); validateMountFreshness(rows, await snapshot());
    for (const row of targets) {
      role = mountTargets.indexOf(row.target) + 2; readState = dirClose = anchorClose = 0;
      let anchor, directory;
      try {
        phase("mask_open");
        expect([io.constants.O_RDONLY, io.constants.O_DIRECTORY, io.constants.O_NOFOLLOW].every(Number.isInteger), "mask-open-flags");
        expect(await io.realpath(row.target) === row.target, "mask-canonical-target");
        anchor = await io.open(row.target, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);
        const fd = anchor.fd; expect(Number.isSafeInteger(fd) && fd >= 0, "mask-fd");
        const boundPath = `/proc/self/fd/${fd}`;
        const bind = async () => {
          phase("mask_identity");
          const held = await anchor.stat({ bigint: true }), named = await io.lstat(row.target, { bigint: true });
          expect(held.isDirectory() && named.isDirectory() && typeof held.dev === "bigint" && typeof held.ino === "bigint" && held.dev === named.dev && held.ino === named.ino, "mask-directory-identity");
          expect(await io.realpath(row.target) === row.target && await io.readlink(boundPath) === row.target, "mask-path-identity");
          const info = await io.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
          expect(typeof info === "string" && info.length <= 4096, "mask-fdinfo-capacity");
          const mounts = [...info.matchAll(/^mnt_id:[ \t]+([1-9]\d*)$/gm)], inodes = [...info.matchAll(/^ino:[ \t]+([1-9]\d*)$/gm)];
          expect(mounts.length === 1 && inodes.length === 1 && BigInt(mounts[0][1]) === BigInt(row.id) && BigInt(inodes[0][1]) === held.ino, "mask-mount-identity");
        };
        await bind();
        phase("mask_opendir"); directory = await io.opendir(boundPath, { bufferSize: 1, recursive: false });
        phase("mask_read"); let empty;
        try { empty = (await directory.read()) === null; readState = 1; } catch (error) { readState = 2; throw error; }
        const m = createMountObservation(recorder, 28, row.target); m.check(m.leaf(1, empty), "mask-nonempty");
        await bind();
      } catch (error) { errors.push(error); }
      // Attempt both owned closes once, even if either call throws synchronously.
      const pending = [];
      for (const [handle, kind] of [[directory, "mask_dir_close"], [anchor, "mask_anchor_close"]]) if (handle) {
        try { const original = handle.close(); pending.push({ original, kind }); }
        catch (error) { if (!errors.length) phase(kind); errors.push(error); if (kind === "mask_dir_close") dirClose = 2; else anchorClose = 2; }
      }
      const outcomes = await Promise.allSettled(pending.map(item => item.original));
      for (const [index, outcome] of outcomes.entries()) {
        const { kind } = pending[index];
        if (outcome.status === "rejected") { if (!errors.length) phase(kind); errors.push(outcome.reason); }
        if (kind === "mask_dir_close") dirClose = outcome.status === "fulfilled" ? 1 : 2; else anchorClose = outcome.status === "fulfilled" ? 1 : 2;
      }
      if (errors.length) break;
      completed++;
    }
    if (!errors.length) { role = null; readState = dirClose = anchorClose = 0; phase("mask_namespace"); expect(await ns() === namespace, "mask-namespace-drift"); phase("mask_snapshot"); validateMountFreshness(rows, await snapshot()); }
  } catch (error) { errors.push(error); }
  if (errors.length) initRecord(recorder, "mask", [1, role, targets.length, completed, readState, dirClose, anchorClose, "UNOBSERVABLE"]);
  raiseContainerFailures(errors);
  return validateMaskCompletion([1, targets.length, completed, completed, completed, "UNOBSERVABLE"]);
}

export function validateChildStatus(text, expected, recorder) {
  validateIdentity(parseIdentity(text, recorder), expected, true, recorder);
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) { parentRole(recorder, name); initGuardCheck(parentEvaluate(recorder, 35, () => parentLeaf(recorder, 1, new RegExp(`^${name}:\\s+0+$`, "m").test(text))), "child-capability", recorder, "capabilities"); }
  check(parentEvaluate(recorder, 36, () => parentLeaf(recorder, 1, initGuardLeaf(/^NoNewPrivs:\s+1$/m.test(text), recorder, "nnp")) && parentLeaf(recorder, 2, initGuardLeaf(/^Seccomp:\s+2$/m.test(text), recorder, "seccomp"))), "child-security");
}
async function readParentIdentity(recorder) { parentSource(recorder, "parent_status_read"); const status = await readFile("/proc/self/status", "utf8"); parentSource(recorder, "parent_identity"); return parseIdentity(status, recorder); }
export async function processEvidence(pid, { read = readFile, link = readlink, recorder, cgroup = false } = {}) {
  parentSource(recorder, "target_stat");
  check(parentEvaluate(recorder, 26, () => parentLeaf(recorder, 1, Number.isSafeInteger(pid)) && parentLeaf(recorder, 2, pid > 0)), "process-id");
  const prefix = `/proc/${pid}`, raw = await read(join(prefix, "stat"), "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  parentSource(recorder, "target_start"); check(parentEvaluate(recorder, 27, () => parentLeaf(recorder, 1, /^\d+$/.test(fields[19]))), "process-start");
  return { pid, start: fields[19], parent: (parentSource(recorder, "target_parent"), number(fields[1], recorder)), status: await (parentSource(recorder, "target_status"), read(join(prefix, "status"), "utf8")), uidMap: await (parentSource(recorder, "target_uid_map"), read(join(prefix, "uid_map"), "utf8")), gidMap: await (parentSource(recorder, "target_gid_map"), read(join(prefix, "gid_map"), "utf8")), namespaces: Object.fromEntries(await (parentSource(recorder, "target_namespace_group"), Promise.all(["pid", "net", "mnt", "user", ...(cgroup ? ["cgroup"] : [])].map(async name => [name, await link(join(prefix, "ns", name))])))), mounts: parseMounts(await (parentSource(recorder, "target_mount_read"), read(join(prefix, "mountinfo"), "utf8")), true, (parentSource(recorder, "target_mount_parse"), recorder)), cgroup: await (parentSource(recorder, "target_cgroup_read"), read(join(prefix, "cgroup"), "utf8")) };
}
export function validateTarget(target, parent, identity, recorder, cgroupView) {
  parentSource(recorder, "target_validate");
  validateChildStatus(target.status, identity, recorder); parentRole(recorder, "uid"); validateMapping(target.uidMap, identity.uid[0], recorder); parentRole(recorder, "gid"); validateMapping(target.gidMap, identity.gid[0], recorder);
  check(parentEvaluate(recorder, 28, () => parentLeaf(recorder, 1, target.namespaces.user === parent.user)), "user-mapping-unqualified");
  for (const name of ["pid", "net", "mnt"]) { parentRole(recorder, name); check(parentEvaluate(recorder, 29, () => parentLeaf(recorder, 1, new RegExp(`^${name}:\\[\\d+\\]$`).test(target.namespaces[name])) && parentLeaf(recorder, 2, target.namespaces[name] !== parent[name])), "private-namespace"); }
  validateMounts(target.mounts, recorder, cgroupView); return target;
}
export function cgroupPath(text, cid, recorder) {
  check(parentEvaluate(recorder, 30, () => parentLeaf(recorder, 1, cidPattern.test(cid))), "cgroup-cid"); const match = /^0::(\/[^\n]+)\n?$/.exec(text);
  check(parentEvaluate(recorder, 31, () => parentLeaf(recorder, 1, match) && parentLeaf(recorder, 2, !match[1].split("/").includes("..")) && parentLeaf(recorder, 3, match[1].split("/").some(part => part === cid || part === `docker-${cid}.scope`))), "cgroup-custody");
  return "/sys/fs/cgroup" + match[1];
}
export function validateLimits(values, recorder) {
  check(parentEvaluate(recorder, 32, () => parentLeaf(recorder, 1, values.memory.trim() === "4294967296") && parentLeaf(recorder, 2, values.swap.trim() === "0") && parentLeaf(recorder, 3, values.pids.trim() === "128")), "effective-cgroup-limit");
  const cpu = values.cpu.trim().split(" "); check(parentEvaluate(recorder, 33, () => parentLeaf(recorder, 1, cpu.length === 2) && parentLeaf(recorder, 2, number(cpu[0], recorder) === 2 * number(cpu[1], recorder)) && parentLeaf(recorder, 3, number(cpu[1], recorder) > 0)), "effective-cpu-limit");
}
// Linux e8f897f4: cgroup paths are relative to the current reader's cgroup
// namespace. Namespace-tagged kernfs superblocks need not share device IDs.
// Tokens are private authority for one invocation, visit and original row set.
const cgroupViews = new WeakMap(), cgroupBindings = new WeakMap();
const cgroupCheck = (recorder, id, value) => check(parentEvaluate(recorder, id, () => parentLeaf(recorder, 1, value)), "cgroup-relation");
function requireCgroupView(token, rows, recorder) {
  const view = token && cgroupViews.get(token);
  cgroupCheck(recorder, 50, Boolean(view && view.active && view.rows === rows && view.owner.active === token && same(rows.map(mountTuple), view.rowSnapshot)));
  return view;
}
function ownedMembership(text, cid, recorder) {
  const match = typeof text === "string" && /^0::(\/[^\n]+)\n?$/.exec(text);
  cgroupCheck(recorder, 47, Boolean(cidPattern.test(cid) && match && match[1] !== "/" && !/[\x00-\x1f\x7f]/.test(match[1]) && match[1].slice(1).split("/").every(part => part && part !== "." && part !== "..") && [cid, `docker-${cid}.scope`].includes(match[1].split("/").at(-1))));
  return match[1];
}
function cgroupMapping(rows, recorder, authority) {
  parentMountTable(rows);
  validateParentMountAuthorities(rows, authority, recorder);
  const found = rows.filter(row => row.target === "/sys/fs/cgroup");
  cgroupCheck(recorder, 48, found.length === 1 && found[0].fs === "cgroup2" && found[0].root === "/");
  const mapping = found[0];
  // No intervening or deeper mount may redirect the owned directory, its parent,
  // any controller file, or future descendant checks to another filesystem.
  cgroupCheck(recorder, 49, rows.every(row => row === mapping || !containsMountPath(mapping.target, row.target)));
  return mountTuple(mapping);
}
const cgroupStamp = async (link, prefix) => ({ mnt: await link(prefix + "/ns/mnt"), cgroup: await link(prefix + "/ns/cgroup") });
const validCgroupStamp = value => /^mnt:\[\d+\]$/.test(value.mnt) && /^cgroup:\[\d+\]$/.test(value.cgroup);
const physicalDirectory = value => value.isDirectory() && typeof value.dev === "bigint" && typeof value.ino === "bigint" && value.dev >= 0n && value.ino > 0n;
// glibc-2.36 c804cd1c, bits/sysmacros.h cd764724: GNU 64-bit dev_t
// major/minor encoding, compatible with Linux; not a runtime libc-version claim.
export function matchesLinuxDevice(dev, device) {
  if (typeof dev !== "bigint" || dev < 0n || dev > 0xffffffffffffffffn || typeof device !== "string" || device.length > 21) return false;
  const pair = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(device);
  if (!pair) return false;
  const major = BigInt(pair[1]), minor = BigInt(pair[2]);
  return major <= 0xffffffffn && minor <= 0xffffffffn && major === ((dev & 0xfff00n) >> 8n | (dev & 0xfffff00000000000n) >> 32n) && minor === ((dev & 0xffn) | (dev & 0xffffff00000n) >> 12n);
}
export function sameCgroupBinding(a, b) {
  return a.path === b.path && a.mountDev === b.mountDev && a.mountIno === b.mountIno && a.dev === b.dev && a.ino === b.ino && a.parentDev === b.parentDev && a.parentIno === b.parentIno;
}
async function bindCgroup(target, cid, recorder, token, io) {
  parentSource(recorder, "cgroup_binding");
  const view = requireCgroupView(token, target.mounts, recorder);
  cgroupCheck(recorder, 50, view.target === target && view.cid === cid);
  const path = view.mapping.target + view.membership;
  const resolved = await io.realpath(path); cgroupCheck(recorder, 51, resolved === path);
  const inode = await io.stat(path, { bigint: true }), parent = await io.stat(dirname(path), { bigint: true });
  const mount = await io.stat(view.mapping.target, { bigint: true });
  cgroupCheck(recorder, 51, physicalDirectory(inode) && physicalDirectory(parent) && physicalDirectory(mount) && inode.dev === parent.dev && inode.dev === mount.dev);
  cgroupCheck(recorder, 54, matchesLinuxDevice(mount.dev, view.mapping.device));
  parentSource(recorder, "cgroup_limits_group");
  validateLimits(Object.fromEntries(await Promise.all([["memory", "memory.max"], ["swap", "memory.swap.max"], ["pids", "pids.max"], ["cpu", "cpu.max"]].map(async ([key, name]) => [key, await io.read(join(path, name), "utf8")]))), (parentSource(recorder, "cgroup_limits"), recorder));
  return { path, dev: inode.dev, ino: inode.ino, parentDev: parent.dev, parentIno: parent.ino, mountDev: mount.dev, mountIno: mount.ino };
}
export function createParentCgroupAdmission(cid, parentNamespaces, identity, supplied = {}, metadata) {
  const io = { read: readFile, link: readlink, realpath, stat, evidence: processEvidence, ...supplied };
  const owner = { active: null, next: 1, complete: null, failed: false };
  let authority;
  return { async observe(pid, visit, recorder) {
    parentSource(recorder, "cgroup_observer");
    const eligible = !owner.failed && !owner.active && visit === owner.next && [1, 2].includes(visit);
    if (!eligible) { owner.failed = true; if (owner.complete) owner.complete.valid = false; }
    cgroupCheck(recorder, 50, eligible);
    const previous = owner.complete; if (previous) previous.valid = false;
    const token = {}; owner.active = token; let view;
    try {
      const before = await cgroupStamp(io.link, "/proc/self");
      cgroupCheck(recorder, 45, validCgroupStamp(before) && before.mnt === parentNamespaces.mnt);
      const target = await io.evidence(pid, { read: io.read, link: io.link, recorder, cgroup: true });
      parentSource(recorder, "parent_mount_read"); const parentMounts = parseParentMounts(await io.read("/proc/self/mountinfo", "utf8"), (parentSource(recorder, "parent_mount_parse"), recorder));
      parentSource(recorder, "cgroup_relation");
      const targetNs = { mnt: target.namespaces.mnt, cgroup: target.namespaces.cgroup };
      cgroupCheck(recorder, 46, validCgroupStamp(targetNs) && targetNs.cgroup !== before.cgroup && targetNs.mnt !== before.mnt && target.pid === pid);
      authority ??= createParentMountAuthority(metadata?.inspect, metadata?.daemonRoot, cid, recorder);
      const membership = ownedMembership(target.cgroup, cid, recorder), mapping = cgroupMapping(parentMounts, recorder, authority);
      view = { owner, active: true, valid: false, visit, cid, target, rows: target.mounts, rowSnapshot: target.mounts.map(mountTuple), stamp: { pid: target.pid, start: target.start }, membership, mapping, authority, before, targetNs };
      cgroupViews.set(token, view);
      validateTarget(target, parentNamespaces, identity, recorder, token);
      const bound = await bindCgroup(target, cid, recorder, token, io);
      parentSource(recorder, "cgroup_closing");
      const raw = await io.read(`/proc/${pid}/stat`, "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      const targetAfter = await cgroupStamp(io.link, `/proc/${pid}`), after = await cgroupStamp(io.link, "/proc/self");
      cgroupCheck(recorder, 52, fields[19] === target.start && same(targetAfter, targetNs) && same(after, before));
      if (previous) {
        parentSource(recorder, "cgroup_repeat");
        cgroupCheck(recorder, 53, previous.stamp.pid === pid && previous.stamp.start === target.start && previous.cid === cid && same(previous.before, before) && same(previous.targetNs, targetNs) && previous.membership === membership && same(previous.mapping, mapping));
      }
      view.active = false; view.valid = true; owner.active = null; owner.complete = view; owner.next++;
      cgroupBindings.set(bound, { view, original: Object.freeze({ ...bound }) });
      return { target, bound, parentMounts };
    } catch (error) { owner.failed = true; if (view) { view.active = false; view.valid = false; } owner.active = null; throw error; }
  } };
}
export async function retiredCgroup(bound, { read = readFile, link = readlink, statPath = stat, lstatPath = lstat } = {}) {
  const binding = bound && cgroupBindings.get(bound), view = binding?.view;
  check(view && sameCgroupBinding(bound, binding.original) && view.valid && !view.owner.failed && view.owner.complete === view, "retirement-cgroup-unqualified");
  const snapshot = async () => {
    check(same(await cgroupStamp(link, "/proc/self"), view.before), "retirement-observer-drift");
    check(same(cgroupMapping(parseParentMounts(await read("/proc/self/mountinfo", "utf8")), undefined, view.authority), view.mapping), "retirement-mapping-drift");
  };
  await snapshot();
  const mount = await statPath(view.mapping.target, { bigint: true }); check(physicalDirectory(mount) && matchesLinuxDevice(mount.dev, view.mapping.device) && mount.dev === bound.mountDev && mount.ino === bound.mountIno, "cgroup-mapping-replaced");
  const parent = await statPath(dirname(bound.path), { bigint: true }); check(physicalDirectory(parent) && matchesLinuxDevice(parent.dev, view.mapping.device) && parent.dev === bound.parentDev && parent.ino === bound.parentIno, "cgroup-parent-replaced");
  let disposition;
  try {
    const current = await statPath(bound.path, { bigint: true }); check(physicalDirectory(current) && matchesLinuxDevice(current.dev, view.mapping.device) && current.dev === bound.dev && current.ino === bound.ino, "cgroup-replaced");
    check((await read(join(bound.path, "cgroup.procs"), "utf8")).trim() === "" && /^populated 0$/m.test(await read(join(bound.path, "cgroup.events"), "utf8")), "cgroup-descendants-live"); disposition = "empty";
  } catch (error) { if (error?.code === "ENOENT") { try { await lstatPath(bound.path, { bigint: true }); } catch (missing) { if (missing?.code === "ENOENT") disposition = "removed"; else throw missing; } } if (!disposition) throw error; }
  await snapshot(); return disposition;
}

// Original attach close and stdin write outcomes remain separate from READY.
// This supervisor never treats killing a Docker client as container retirement.
export function attachContainer(command, args, { cwd, env, nonce, contextHash, spawnProcess = spawn, onStop, signalSource = process, killGroup = (pid, signal) => process.kill(-pid, signal), timeoutMs = 480000, readyMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const result = { code: null, signal: null, closed: false, timedOut: false, interrupted: false, errors: [], remaining: [], observed: new Map(), stdout: "", stderr: "",
    supervisor: [false, false, false, false, false, false], readyAccepted: false, firstBranch: null, branches: 0, outputSummary: {} };
  const diagnostic = operation => { try { operation(); } catch (error) { result.errors.push(error); } };
  const fact = index => diagnostic(() => { result.supervisor[index] = true; });
  const branch = name => diagnostic(() => { result.firstBranch ??= name; result.branches |= 2 ** attachFailureBranches.indexOf(name); });
  const capture = {};
  for (const key of ["stdout", "stderr"]) diagnostic(() => { capture[key] = { bytes: 0, hash: createHash("sha256"), truncated: false }; });
  const ready = Promise.withResolvers(), closed = Promise.withResolvers();
  void ready.promise.catch(() => {});
  let child, bytes = 0, frame = "", seen = false, stopTask, timer, readyTimer, spawnReturned = false;
  const stop = reason => {
    if (!stopTask) stopTask = Promise.resolve().then(() => onStop(reason)).catch(error => { result.errors.push(error); }).finally(() => {
      if (!result.closed && child?.pid) try { killGroup(child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") result.errors.push(error); }
    });
    return stopTask;
  };
  const onSignal = () => { branch("interrupt"); result.interrupted = true; void stop("interrupt"); };
  const finish = async (code, signal) => {
    result.code = code; result.signal = signal; result.closed = true;
    clearTimer(timer); clearTimer(readyTimer); signalSource.removeListener("SIGINT", onSignal); signalSource.removeListener("SIGTERM", onSignal);
    if (!seen) { branch(frame.startsWith(protocol) ? "incomplete_ready" : "close_before_ready"); ready.reject(new Error("edge-container: ready-missing")); }
    if (stopTask) await stopTask;
    for (const key of ["stdout", "stderr"]) diagnostic(() => {
      const original = capture[key], retained = Buffer.from(result[key]), sha256 = original.hash.digest("hex"), retainedSha256 = hash(retained);
      result.outputSummary[key] = { bytes: original.bytes, sha256, retainedBytes: retained.length, retainedSha256, truncated: original.truncated,
        complete: result.supervisor[4] && !original.truncated && original.bytes === retained.length && sha256 === retainedSha256 };
    });
    fact(5); closed.resolve(result);
  };
  try {
    fact(0); child = spawnProcess(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] }); spawnReturned = true; fact(1);
    child.on("error", error => { branch("child_error"); result.errors.push(error); ready.reject(error); void stop("attach-error"); });
    child.stdin.on("error", error => { branch("stdin_error"); result.errors.push(error); void stop("stdin-error"); });
    child.once("close", (code, signal) => { fact(4); void finish(code, signal); });
    for (const key of ["stdout", "stderr"]) child[key].on("data", data => {
      diagnostic(() => { capture[key].bytes += data.length; capture[key].hash.update(data); });
      bytes += data.length;
      if (bytes > 1024 * 1024) { branch("output_capacity"); diagnostic(() => { capture[key].truncated = true; }); result.errors.push(new Error("edge-container: attach-capacity")); void stop("output-capacity"); return; }
      result[key] += data.toString("utf8");
      if (key !== "stdout") return;
      frame += data.toString("utf8");
      while (frame.includes("\n")) {
        const end = frame.indexOf("\n") + 1, line = frame.slice(0, end); frame = frame.slice(end);
        if (!line.startsWith(protocol)) continue;
        try { check(!seen, "ready-replayed"); parseControl(line, "ready", nonce, contextHash); seen = true; diagnostic(() => { result.readyAccepted = true; }); clearTimer(readyTimer); ready.resolve(); }
        catch (error) { branch(seen ? "replayed_ready" : "invalid_ready"); result.errors.push(error); ready.reject(error); void stop("ready-invalid"); }
      }
    });
    timer = setTimer(() => { branch("deadline"); result.timedOut = true; ready.reject(new Error("edge-container: deadline")); void stop("deadline"); }, timeoutMs);
    readyTimer = setTimer(() => { branch("ready_deadline"); result.timedOut = true; ready.reject(new Error("edge-container: ready-deadline")); void stop("ready-deadline"); }, readyMs);
    signalSource.on("SIGINT", onSignal); signalSource.on("SIGTERM", onSignal);
  } catch (error) { fact(spawnReturned ? 3 : 2); branch(spawnReturned ? "setup_failure" : "spawn_throw"); result.errors.push(error); ready.reject(error); void finish(null, null); }
  return {
    ready: ready.promise, closed: closed.promise, result,
    async permit() {
      check(seen && !result.closed && !result.errors.length && !result.timedOut && !result.interrupted, "permit-without-ready");
      try { await new Promise((resolveWrite, rejectWrite) => child.stdin.end(control("permit", nonce, contextHash), error => error ? rejectWrite(error) : resolveWrite())); }
      catch (error) { branch("permit_write"); throw error; }
    },
  };
}
export function parseInitPrerequisites(result, binding) {
  const unknown = (reason, records = null) => ({ v: 7, phase: "init_prerequisite", state: "observed", stage: null, defined: null, records, reason, reportFailures: null, undefinedReportFailures: null });
  if (!binding || !cidPattern.test(binding.cid) || !hashPattern.test(binding.nonce) || !hashPattern.test(binding.contextHash) || binding.attached?.result !== result) return unknown("binding_unavailable");
  if (!result.supervisor?.[4] || !result.supervisor?.[5] || !result.closed) return unknown("capture_unavailable");
  for (const key of ["stdout", "stderr"]) {
    const summary = result.outputSummary?.[key];
    if (!summary || summary.complete !== true || summary.truncated !== false) return unknown("capture_unavailable");
    const retained = Buffer.from(result[key]);
    if (retained.length !== summary.bytes || retained.length !== summary.retainedBytes || hash(retained) !== summary.sha256 || summary.retainedSha256 !== summary.sha256) return unknown("capture_mismatch");
  }
  const prefix = "EDGE_INIT_" + "V1 ", rows = []; let terminal;
  try {
    const lines = result.stdout.split("\n");
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.startsWith("EDGE_INIT_")) continue;
      check(lineIndex < lines.length - 1, "init-private-incomplete-line");
      check(line.startsWith(prefix) && Buffer.byteLength(line + "\n") <= 512 && !line.includes("\x1b"), "init-private-frame");
      const row = JSON.parse(line.slice(prefix.length));
      const detailKeys = Object.hasOwn(row, "detail") ? ["detail"] : [];
      exactKeys(row, ["v", "nonce", "contextHash", "seq", "stage", "event", "reason", "defined", "reportFailures", "undefinedReportFailures", ...detailKeys]);
      check(Object.keys(row).join() === "v,nonce,contextHash,seq,stage,event,reason,defined,reportFailures,undefinedReportFailures" + (detailKeys.length ? ",detail" : "") && JSON.stringify(row) === line.slice(prefix.length) && row.v === 1 && row.nonce === binding.nonce && row.contextHash === binding.contextHash && row.seq === rows.length + 1 && !terminal && rows.length < 9, "init-private-identity");
      check(Number.isInteger(row.reportFailures) && row.reportFailures >= 0 && row.reportFailures <= 16 && Number.isInteger(row.undefinedReportFailures) && row.undefinedReportFailures >= 0 && row.undefinedReportFailures <= row.reportFailures, "init-private-reports");
      const previous = rows.at(-1);
      if (previous) check(row.reportFailures >= previous.reportFailures && row.undefinedReportFailures >= previous.undefinedReportFailures && row.undefinedReportFailures - previous.undefinedReportFailures <= row.reportFailures - previous.reportFailures, "init-private-report-order");
      if (detailKeys.length) { check(row.event === "terminal" && row.reason === "original_failure" && ["runtime", "native_receipt"].includes(row.stage), "init-private-detail"); validateInitDetail(row.detail); }
      if (row.event === "entered") check(row.stage === initPrerequisiteStages[rows.length] && row.reason === null && row.defined === null, "init-private-order");
      else { check(row.event === "terminal" && rows.length > 0 && row.stage === initPrerequisiteStages[rows.length - 1], "init-private-terminal"); terminal = row; }
      rows.push(row);
    }
    if (!rows.length) return unknown("no_records", 0);
    if (!terminal) return unknown("incomplete", rows.length);
    return validateContainerDiagnostic({ v: 7, phase: "init_prerequisite", state: terminal.reason === "complete" ? "observed" : "rejected", stage: terminal.reason === "original_failure" ? terminal.stage : null, defined: terminal.defined, records: rows.length, reason: terminal.reason, reportFailures: terminal.reportFailures, undefinedReportFailures: terminal.undefinedReportFailures, ...(Object.hasOwn(terminal, "detail") ? { detail: terminal.detail } : {}) });
  } catch { return unknown("invalid"); }
}
// This validates the source-defined record lifecycle, not native success or
// operation-vs-bookkeeping causality. Report errors can follow FINAL fulfilled.
export function projectBuilderCloseGroup(rows, childLifecycle, first, recordTrace, rejection = null) {
  // The rejection is the exact row admitted after the complete lifecycle checks.
  // Historical projector failures retain their original, separate association.
  if (!rows || !childLifecycle) return null;
  let role;
  if (rejection) {
    if (!rows.includes(rejection) || rejection.outcome !== "rejected") return null;
    if (["build_a","build_b"].includes(rejection.role)) role = rejection.role;
    else if (rejection.role === "child") {
      const owners = childLifecycle.accepts.filter(item => item.close === rejection || item.row === rejection || item.followup === rejection);
      if (owners.length === 1) role = owners[0].role;
    }
  } else if (first && [4,5].includes(first[2]) && first[1] >= 18 && first[1] <= 30) role = first[2] === 4 ? "build_a" : "build_b";
  if (!role) return null;
  return inspectBuilderCloseGroup(rows, childLifecycle, role, recordTrace, Boolean(rejection));
}
// Common complete source interval validation; callers choose a role only from
// their admitted source lifecycle, never from recency or a fabricated failure.
function inspectBuilderCloseGroup(rows, childLifecycle, role, recordTrace, allowEmpty) {
  // No canonical-but-unassociated builder frames may hide outside a wrapper's
  // original close/summary/report interval, including a different builder role.
  for (const candidate of ["build_a","build_b"]) {
    const members = rows.filter(row=>row.role===candidate), owners = childLifecycle.accepts.filter(item=>item.role===candidate);
    if (!members.length) continue;
    if (owners.length !== 1) return null;
    const begin = rows.indexOf(owners[0].close)+4, end = rows.indexOf(owners[0].row), forwarded = rows.slice(begin,end);
    if (begin < 4 || end < begin || members.length !== forwarded.length || members.some((row,i)=>row!==forwarded[i])) return null;
  }
  const accepted = childLifecycle.accepts.filter(item=>item.role===role);
  const launches = rows.filter(row=>row.role==="child"&&row.phase===role+"_launch");
  const closes = rows.filter(row=>row.role==="child"&&row.phase===role+"_close");
  if (accepted.length !== 1 || launches.length !== 1 || closes.length !== 1 || accepted[0].close !== closes[0]) return null;
  const start = rows.indexOf(launches[0]), end = rows.indexOf(accepted[0].row);
  if (rows[start+1] !== closes[0] || launches[0].outcome !== "enter" || end < start+5) return null;
  if (["defined","exit","signal","closed","timedOut","interrupted","errors","remaining"].some(key=>launches[0][key]!==null)) return null;
  const summaries = rows.slice(start+2,start+5);
  if (!summaries.every((row,i)=>row.role==="child"&&row.phase===["stdout_summary","stderr_summary","protocol_summary"][i]&&row.outcome==="observed")) return null;
  const members = rows.filter(row=>row.role===role), forwarded = rows.slice(start+5,end);
  if (members.length !== forwarded.length || members.some((row,i)=>row!==forwarded[i])) return null;
  if (!members.length) {
    const protocol = summaries[2];
    if (!allowEmpty || closes[0].outcome !== "rejected" || accepted[0].row.outcome !== "rejected" || protocol.complete !== true || ["valid","entry","final","rejected","foreign","malformed"].some(key => protocol[key] !== 0)) return null;
  }
  const close = closes[0].v === 4 ? unpackCensusCloseDiagnostic(closes[0]) : closes[0], [out,err] = summaries;
  if (!["fulfilled","rejected"].includes(close.outcome) || (close.outcome === "rejected" ? typeof close.defined !== "boolean" : close.defined !== null)) return null;
  if (![close.closed,close.timedOut,close.interrupted,out.esc,out.complete,err.esc,err.complete].every(value=>typeof value==="boolean")) return null;
  const flags = [close.closed,close.timedOut,close.interrupted,out.esc,out.complete,err.esc,err.complete].reduce((mask,value,i)=>mask+(value?2**i:0),0);
  try { const projected=validateReportedBuilderProcess([1,role === "build_a" ? 1 : 2,close.outcome==="fulfilled"?1:close.defined?3:2,close.exit,receiptBuilderSignals.indexOf(close.signal),flags,close.errors,close.remaining,out.bytes,out.sha256,err.bytes,err.sha256]); if(recordTrace)recordTrace(close.v===2||close.v===3?close.trace:null,close.v===3?close.code:null,closes[0].v===4?closes[0].detail[7]:null);return projected; } catch { return null; }
}
// V17 alone requires a source-consistent successful builder prefix. These
// counts describe the exact forwarded interval, not an inferred inner capture.
function reconcileSuccessfulBuilderSummary(rows, lifecycle, role) {
  const owners = lifecycle.accepts.filter(item=>item.role===role);
  if (owners.length !== 1) return false;
  const owner = owners[0], begin = rows.indexOf(owner.close), end = rows.indexOf(owner.row);
  if (begin < 0 || end < begin+4 || owner.row.outcome !== "fulfilled" || owner.followup?.outcome !== "fulfilled") return false;
  const summaries = rows.slice(begin+1,begin+4), forwarded = rows.slice(begin+4,end);
  if (!summaries.every((row,i)=>row.role === "child" && row.phase === ["stdout_summary","stderr_summary","protocol_summary"][i] && row.outcome === "observed" && row.complete === true)) return false;
  // Canonical field types were already validated for every captured frame.
  // Reconcile all authored counters, including classifications that successful
  // strict parsing + the subsequent built:true check necessarily rule out.
  const summary = summaries[2];
  const counts = {valid:forwarded.length,entry:0,final:0,rejected:0,foreign:0,malformed:0,receipts:1,unclassified:0};
  for (const row of forwarded) {
    if (row.role !== role) return false;
    if (row.phase === "entry") counts.entry++;
    if (row.phase === "final") counts.final++;
    if (row.outcome === "rejected") counts.rejected++;
  }
  if (!counts.valid || counts.entry !== 1 || counts.final !== 1 || counts.rejected !== 0 || counts.valid+1 > 256) return false;
  return Object.entries(counts).every(([key,count])=>summary[key] === count);
}
// Only the exact admitted close row and its source lifecycle launch can own
// this group. Global canonical/capture checks run before rejection is recorded.
export function projectWranglerCloseGroup(rows, lifecycle, rejection) {
  if (!rows || !lifecycle || !rejection || ![5,6].includes(rejection.v) || rejection.role !== "child" || rejection.outcome !== "rejected") return null;
  // Wrangler is reached only after BOTH exact builder acceptance intervals.
  // All forwarded rows must follow the three summaries, including foreign-role
  // insertions that role-local lifecycle checks alone cannot detect.
  for (const role of ["build_a","build_b"]) {
    try {
      const group = inspectBuilderCloseGroup(rows,lifecycle,role,undefined,false);
      if (!group || group[2] !== 1 || !reconcileSuccessfulBuilderSummary(rows,lifecycle,role)) return null;
    } catch { return null; }
  }
  const owners = lifecycle.wranglers.filter(item=>item.close===rejection);
  if (owners.length !== 1 || rows.filter(row=>row.phase===rejection.phase).length !== 1) return null;
  const {launch,close} = owners[0], start = rows.indexOf(launch);
  if (start < 0 || rows[start+1] !== close || launch.role !== "child" || launch.phase !== close.phase.replace("_close","_launch") || launch.outcome !== "enter" || rows.filter(row=>row.phase===launch.phase).length !== 1) return null;
  if (["defined","exit","signal","closed","timedOut","interrupted","errors","remaining"].some(key=>launch[key]!==null)) return null;
  try { return (close.v === 6 ? validateObservedWranglerCloseDiagnostic(close) : validateWranglerCloseDiagnostic(close)).detail; } catch { return null; }
}
export function createProjectionLedger() {
  const errors = [], stack = [], admitted = new WeakMap(); let first = null, firstLifecycle = null, canonicalRows = null, childLifecycle = null, firstOwnedTrace = null, firstOwnedCode = null, firstCensus = null, admittedRejection = null, broken = false;
  const note = operation => { try { return operation(); } catch (error) { broken = true; errors.push(error); } };
  return { errors,
    canonical(rows) { note(() => { canonicalRows = rows; }); },
    childLifecycle(value) { note(() => { childLifecycle = value; }); },
    rejection(value) { note(() => { admittedRejection = value; }); },
    builder() { firstOwnedTrace=null;firstOwnedCode=null;firstCensus=null;return broken || errors.length || stack.length ? null : projectBuilderCloseGroup(canonicalRows, childLifecycle, first,(trace,code,census)=>{firstOwnedTrace=trace;firstOwnedCode=code;firstCensus=census;},admittedRejection); },
    wrangler() { return broken || errors.length || stack.length ? null : projectWranglerCloseGroup(canonicalRows, childLifecycle, admittedRejection); },
    owned() { return broken || errors.length || stack.length ? null : firstOwnedTrace; },
    code() { return broken || errors.length || stack.length ? null : firstOwnedCode; },
    census() { return broken || errors.length || stack.length ? null : firstCensus; },
    start(boundary, context) { return note(() => { const frame = { boundary, context, seen: 0, passed: 0 }; stack.push(frame); return frame; }); },
    leaf(id, value, negative) { note(() => { const frame = stack.at(-1); if (!frame) return; const bit = 2 ** (id - 1); frame.seen |= bit; if (negative ? !value : value) frame.passed |= bit; }); },
    admit(rows, count, context) { note(() => admitted.set(rows, { count, context })); },
    stepInput(rows, index, phase, row) { note(() => {
      const frame = stack.at(-1), qualified = admitted.get(rows);
      if (frame?.boundary !== 30 || qualified?.context !== frame.context) return;
      frame.lifecycle = [1,index,qualified.count,receiptChildPhases.indexOf(phase)+1,0,row === undefined ? 2 : 1,0];
    }); },
    phase(value) { note(() => { const frame = stack.at(-1); if (frame?.lifecycle) frame.lifecycle[4] = receiptChildPhases.indexOf(value)+1; }); },
    outcome(value) { note(() => { const frame = stack.at(-1); if (frame?.lifecycle) frame.lifecycle[6] = ["enter","fulfilled","rejected","observed"].indexOf(value)+1; }); },
    finish(frame, rejected, threw, reason) { note(() => {
      check(stack.pop() === frame, "projection-ledger-order");
      if (!first && (rejected || threw)) {
        const failed = frame.seen & ~frame.passed;
        const leaf = threw ? 0 : Array.from({ length: projectionBoundaries[frame.boundary - 1][1] }, (_, i) => i + 1).find(id => failed & 2 ** (id - 1)) ?? 0;
        first = [1,frame.boundary,frame.context,threw ? 2 : 1,leaf,frame.seen,frame.passed,threw ? reason !== undefined : null];
        if (rejected && !threw && frame.boundary === 30) firstLifecycle = frame.lifecycle ?? null;
      }
    }); },
    detail() { return broken || errors.length || stack.length ? null : first; },
    lifecycle() { return broken || errors.length || stack.length ? null : firstLifecycle; },
  };
}
const projectionRecord = (recorder, method, ...args) => { if (recorder) try { return recorder[method](...args); } catch (error) { recorder.errors.push(error); } };
const projectionLeaf = (recorder, id, value, negative = false) => { projectionRecord(recorder, "leaf", id, value, negative); return value; };
const projectionValue = (recorder, method, value) => { projectionRecord(recorder, method, value); return value; };
function projectionRun(recorder, boundary, context, operation, negative = false) {
  if (!recorder) return operation();
  const frame = projectionRecord(recorder, "start", boundary, context);
  try { const value = operation(); projectionRecord(recorder, "finish", frame, projectionBoundaries[boundary - 1][1] > 0 && (negative ? !!value : !value), false); return value; }
  catch (error) { projectionRecord(recorder, "finish", frame, false, true, error); throw error; }
}
export function parseChildPackaging(result, binding, initSummary, recorder) {
  const unknown = (reason, records = null) => [1,reason,records,0,0,0,0,null,"UNKNOWN"];
  if (projectionRun(recorder, 1, 0, () => projectionLeaf(recorder, 1, !binding, true) || projectionLeaf(recorder, 2, !cidPattern.test(binding.cid), true) || projectionLeaf(recorder, 3, !hashPattern.test(binding.nonce), true) || projectionLeaf(recorder, 4, !hashPattern.test(binding.contextHash), true) || projectionLeaf(recorder, 5, binding.attached?.result !== result, true), true)) return unknown("binding_unavailable");
  if (projectionRun(recorder, 2, 0, () => projectionLeaf(recorder, 1, !result.supervisor?.[4], true) || projectionLeaf(recorder, 2, !result.supervisor?.[5], true) || projectionLeaf(recorder, 3, !result.closed, true), true)) return unknown("capture_unavailable");
  for (const key of ["stdout", "stderr"]) {
    const context = key === "stdout" ? 1 : 2;
    const summary = projectionRun(recorder, 3, context, () => result.outputSummary?.[key]);
    if (projectionRun(recorder, 4, context, () => projectionLeaf(recorder, 1, !summary, true) || projectionLeaf(recorder, 2, summary.complete !== true, true) || projectionLeaf(recorder, 3, summary.truncated !== false, true), true)) return unknown("capture_unavailable");
    const bytes = projectionRun(recorder, 5, context, () => Buffer.from(result[key]));
    if (projectionRun(recorder, 6, context, () => projectionLeaf(recorder, 1, bytes.length !== summary.bytes, true) || projectionLeaf(recorder, 2, bytes.length !== summary.retainedBytes, true) || projectionLeaf(recorder, 3, hash(bytes) !== summary.sha256, true) || projectionLeaf(recorder, 4, summary.retainedSha256 !== summary.sha256, true), true)) return unknown("capture_mismatch");
  }
  if (projectionRun(recorder, 7, 0, () => projectionLeaf(recorder, 1, initSummary?.reason !== "complete", true) || projectionLeaf(recorder, 2, initSummary.records !== 9, true), true)) return unknown("init_unqualified");
  const rows = [], prefix = "EDGE_PACKAGING_V1 ";
  try {
    const lines = projectionRun(recorder, 8, 0, () => result.stdout.split("\n"));
    for (const [index,line] of lines.entries()) {
      if (!projectionRun(recorder, 9, 0, () => line.includes("EDGE_PACKAGING"))) continue;
      check(projectionRun(recorder, 10, 0, () => projectionLeaf(recorder, 1, index < lines.length - 1) && projectionLeaf(recorder, 2, line.startsWith(prefix)) && projectionLeaf(recorder, 3, !line.includes("\x1b")) && projectionLeaf(recorder, 4, Buffer.byteLength(line + "\n") <= 768) && projectionLeaf(recorder, 5, rows.length < 256)), "child-frame");
      const value = projectionRun(recorder, 11, 0, () => JSON.parse(line.slice(prefix.length))), row = projectionRun(recorder, 12, 0, () => validatePackagingDiagnostic(value));
      check(projectionRun(recorder, 13, 0, () => projectionLeaf(recorder, 1, JSON.stringify(value) === line.slice(prefix.length)) && projectionLeaf(recorder, 2, JSON.stringify(row) === JSON.stringify(value)) && projectionLeaf(recorder, 3, ["child","build_a","build_b"].includes(row.role))), "child-frame-canonical");
      if (row.outcome === "rejected") check(projectionRun(recorder, 14, 0, () => projectionLeaf(recorder, 1, typeof row.defined === "boolean")), "child-rejection-presence");
      else if (row.outcome !== "observed") check(projectionRun(recorder, 15, 0, () => projectionLeaf(recorder, 1, row.defined === null)), "child-nonfailure-presence");
      projectionRun(recorder, 16, 0, () => rows.push(row));
    }
    if (projectionRun(recorder, 17, 0, () => projectionLeaf(recorder, 1, !rows.length, true), true)) return unknown("no_records",0);
    projectionRecord(recorder, "canonical", rows);
    const roles = ["child","build_a","build_b"], lifecycle = new Map();
    for (const role of roles) {
      const context = roles.indexOf(role) + 3;
      const records = projectionRun(recorder, 18, context, () => rows.filter(row => row.role === role)); const count = records.length; if (!count) continue;
      projectionRecord(recorder, "admit", records, count, context);
      const terminal = projectionRun(recorder, 19, context, () => validateChildLifecycle(records, role, recorder, context)); if (projectionRun(recorder, 20, context, () => projectionLeaf(recorder, 1, !terminal, true), true)) return unknown("incomplete",rows.length);
      if (role === "child") projectionRecord(recorder, "childLifecycle", terminal);
      projectionRun(recorder, 21, context, () => lifecycle.set(role,terminal));
    }
    if (projectionRun(recorder, 22, 0, () => projectionLeaf(recorder, 1, !lifecycle.has("child"), true), true)) return unknown("incomplete",rows.length);
    const child = lifecycle.get("child"), rejected = rows.find(row => row.outcome === "rejected");
    for (const role of ["build_a","build_b"]) {
      const context = roles.indexOf(role) + 3;
      const [members, accepted] = projectionRun(recorder, 23, context, () => [rows.filter(row => row.role === role), child.accepts.find(item => item.role === role)]);
      if (members.length) {
        check(projectionRun(recorder, 24, context, () => projectionLeaf(recorder, 1, accepted) && projectionLeaf(recorder, 2, rows.indexOf(members[0]) > rows.indexOf(accepted.close)) && projectionLeaf(recorder, 3, rows.indexOf(members.at(-1)) < rows.indexOf(accepted.row)) && projectionLeaf(recorder, 4, rows.indexOf(members.at(-1)) - rows.indexOf(members[0]) + 1 === members.length)), "child-forwarded-order");
      }
      if (accepted?.row.outcome === "fulfilled") check(projectionRun(recorder, 25, context, () => projectionLeaf(recorder, 1, lifecycle.get(role)?.terminal === "fulfilled") && projectionLeaf(recorder, 2, !members.some(row => row.outcome === "rejected"))), "child-accepted-role");
    }
    check(projectionRun(recorder, 26, 0, () => projectionLeaf(recorder, 1, child.terminal !== "fulfilled") || projectionLeaf(recorder, 2, !rejected) && projectionLeaf(recorder, 3, lifecycle.size === 3)), "child-final-conflict");
    const first = rejected ?? null, mask = roles.reduce((bits,role,index) => bits | (lifecycle.has(role) ? 2 ** index : 0),0);
    projectionRecord(recorder, "rejection", first);
    return projectionRun(recorder, 27, 0, () => [1,first ? "reported_rejection" : "reported_complete",rows.length,mask,child.terminal === "fulfilled" ? 1 : 2,first ? roles.indexOf(first.role)+1 : 0,first ? receiptChildPhases.indexOf(first.phase)+1 : 0,first ? first.defined : null,"UNKNOWN"]);
  } catch { return unknown("invalid"); }
}
function validateChildLifecycle(rows, role, recorder, context) {
  let index = 0, failed = false; const accepts = [], wranglers = [];
  const peek = (phase,outcome, observed) => projectionLeaf(observed, 1, rows[index]?.phase === phase) && (projectionLeaf(observed, 2, outcome === undefined) || projectionLeaf(observed, 3, rows[index]?.outcome === outcome));
  const take = (phase,outcome) => { check(projectionRun(recorder, 28, context, () => peek(phase,outcome,recorder)),"child-lifecycle-order"); return rows[index++]; };
  const final = complete => {
    if (!peek("final")) return null;
    const row = rows[index++]; check(projectionRun(recorder, 29, context, () => projectionLeaf(recorder, 1, index === rows.length) && projectionLeaf(recorder, 2, ["fulfilled","rejected"].includes(row.outcome)) && (projectionLeaf(recorder, 3, row.outcome !== "fulfilled") || projectionLeaf(recorder, 4, complete) && projectionLeaf(recorder, 5, !failed))),"child-lifecycle-final");
    return { terminal: row.outcome, accepts, wranglers };
  };
  const step = phase => {
    take(phase,"enter"); const rowIndex = index, row=rows[index++];
    check(projectionRun(recorder, 30, context, () => {
      projectionRecord(recorder, "stepInput", rows, rowIndex, phase, row);
      return projectionLeaf(recorder, 1, projectionValue(recorder, "phase", row?.phase)===phase) && projectionLeaf(recorder, 2, ["fulfilled","rejected"].includes(projectionValue(recorder, "outcome", row.outcome)));
    }),"child-lifecycle-step");
    failed ||= row.outcome === "rejected"; return row.outcome === "fulfilled";
  };
  take("entry","fulfilled");
  if (role !== "child") {
    if (!step("namespace_read")) return final(false);
    if (peek("final")) return final(false); // original nativeReceipt can throw
    if (!step("builder_import")) return final(false);
    if (peek("final")) return final(false); // original module acquisition can throw
    if (step("build")) step("receipt_write");
    step("build_service_stop");
    return final(!failed);
  }
  for (const phase of ["namespace_read","process_inventory","environment"]) if (!step(phase)) return final(false);
  for (const role of ["build_a","build_b"]) {
    take(role+"_launch","enter"); if (peek("final")) return final(false);
    const close = rows[index++]; check(projectionRun(recorder, 31, context, () => projectionLeaf(recorder, 1, close?.phase === role+"_close") && projectionLeaf(recorder, 2, ["fulfilled","rejected"].includes(close.outcome))),"child-lifecycle-close"); failed ||= close.outcome === "rejected";
    let summaries = 0;
    for (const phase of ["stdout_summary","stderr_summary","protocol_summary"]) { if (!peek(phase,"observed")) break; take(phase,"observed"); summaries++; }
    if (summaries !== 3) { take(role+"_report","rejected"); failed = true; }
    const accepted = rows[index++]; check(projectionRun(recorder, 32, context, () => projectionLeaf(recorder, 1, accepted?.phase === role+"_report") && projectionLeaf(recorder, 2, ["fulfilled","rejected"].includes(accepted.outcome))),"child-lifecycle-report"); failed ||= accepted.outcome === "rejected"; accepts.push({role,row:accepted,close});
    if (failed) return final(false);
    if (peek("final")) return final(false); // original JSON/result checks can throw
    const followupIndex = index;
    const followed = step(role+"_report"); // legitimate repeated phase
    accepts.at(-1).followup = rows[followupIndex + 1];
    if (!followed) return final(false);
  }
  for (const phase of ["two_roots","wrangler_input"]) if (!step(phase)) return final(false);
  for (const role of ["edge","upstream"]) {
    if (!step(role+"_config")) return final(false);
    const launch = take(role+"_launch","enter"); if (peek("final")) return final(false);
    const close = rows[index++]; check(projectionRun(recorder, 31, context, () => projectionLeaf(recorder, 1, close?.phase === role+"_close") && projectionLeaf(recorder, 2, ["fulfilled","rejected"].includes(close.outcome))),"child-lifecycle-close"); failed ||= close.outcome === "rejected";
    wranglers.push({launch,close});
    if (failed) return final(false);
    for (const suffix of ["output","marker","hash","privacy"]) if (!step(role+"_"+suffix)) return final(false);
  }
  for (const phase of ["final_namespace","final_descendants"]) if (!step(phase)) return final(false);
  return final(true);
}
export function createAttachProjection(attached, plan, report) {
  const binding = { attached, cid: plan.cid, nonce: plan.nonce, contextHash: plan.contextHash }; let projected = false, initSummary, attachSummary;
  const project = result => {
    if (projected) return; projected = true;
    const retain = operation => { try { operation(); } catch (error) { attached.result.errors.push(error); } };
    retain(() => {
      check(result === attached.result && result.supervisor[5], "attach-original-unsettled");
      attachSummary = validateContainerDiagnostic({ v: 6, phase: "attach_process", state: "observed", exit: result.code, signal: result.signal, closed: result.closed, timedOut: result.timedOut, interrupted: result.interrupted,
        errors: result.errors.length, undefinedErrors: result.errors.filter(error => error === undefined).length, supervisor: [...result.supervisor], ready: result.readyAccepted, first: result.firstBranch, branches: result.branches,
        capture: [result.outputSummary.stdout?.complete === true, result.outputSummary.stderr?.complete === true] });
      report.internal(attachSummary);
    });
    retain(() => { initSummary = parseInitPrerequisites(result, binding); report.internal(initSummary); });
  };
  project.child = (result, recorder) => parseChildPackaging(result, binding, initSummary, recorder);
  project.terminal = (result, outcome) => {
    const custody=reaperTerminalOutcomes.get(outcome);
    check(projected && attachSummary && result===attached.result && custody?.result===result && custody.attached===attached,"attach-terminal-original");
    let runtime=null,failed=false,reason;
    try { runtime=parseCoordinatorWitness(result,outcome,initSummary); } catch(error) { failed=true;reason=error; }
    const errors=failed?[reason]:[];
    try { report.replace(attachSummary,packAttachTerminalDiagnostic(attachSummary,outcome.terminal,runtime)); } catch(error) { errors.push(error); }
    raiseContainerFailures(errors);
  };
  return project;
}
export async function runInitPrerequisites(args, trace, operations, ledger) {
  const reporting = [], observe = operation => { try { operation(); } catch (error) { reporting.push(error); } };
  let failed = false, reason, identity, native, detailActive = false;
  try {
    observe(() => trace.enter("arguments")); operations.arguments(args);
    observe(() => trace.bind(args[0], args[1]));
    observe(() => trace.enter("identity")); identity = operations.identity(args);
    observe(() => trace.enter("environment_reset")); operations.reset();
    observe(() => trace.enter("environment_prepare")); await operations.prepare();
    observe(() => trace.enter("runtime")); detailActive = true; await operations.runtime(identity); detailActive = false;
    observe(() => trace.enter("native_receipt")); detailActive = true; native = await operations.native(args[1]); detailActive = false;
    const reportsFailed = () => trace.errors.length || reporting.length || ledger?.errors.length;
    if (!reportsFailed()) {
      observe(() => trace.enter("ready_write"));
      if (!reportsFailed()) { operations.ready(args[0], args[1]); observe(() => trace.enter("permit_receive")); await operations.permit(args[0], args[1]); }
    }
  } catch (error) { failed = true; reason = error; }
  let detail; if (failed && detailActive && ledger) observe(() => { detail = ledger.failure(); });
  observe(() => trace.finish(failed, reason, detail, [...(ledger ? ledger.errors : []), ...reporting]));
  raiseContainerFailures([...(failed ? [reason] : []), ...trace.errors, ...(ledger ? ledger.errors : []), ...reporting]);
  return native;
}

async function receivePermit(nonce, contextHash) {
  let text = "";
  const deadline = setTimeout(() => process.stdin.destroy(new Error("edge-container: permit-deadline")), 30000);
  try {
    for await (const chunk of process.stdin) { text += chunk.toString("utf8"); check(Buffer.byteLength(text) <= 512, "permit-capacity"); }
    return parseControl(text, "permit", nonce, contextHash);
  } finally { clearTimeout(deadline); }
}
async function validateContainerRuntime(identity, builder = false, recorder, inspectMasks = false) {
  initRecord(recorder, "source", "runtime");
  initGuardCheck(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1" && process.versions.modules === "137", "container-runtime", recorder, "runtime");
  initRecord(recorder, "source", "ancestry");
  initGuardCheck(builder ? process.pid > 1 && process.ppid > 1 : process.pid > 1 && process.ppid === 1, "container-init-ancestry", recorder, "ancestry");
  const coordinatorPid = builder ? process.ppid : process.pid;
  const command = (await readFile(`/proc/${coordinatorPid}/cmdline`)).toString("utf8").split("\0");
  const contextHash = process.argv[builder ? 5 : 4];
  check(hashPattern.test(command[3]) && command[4] === contextHash, "coordinator-context");
  await qualifyControls(identity, command[3], contextHash, coordinatorPid);
  initRecord(recorder, "source", "status_read"); const status = await readFile("/proc/self/status", "utf8");
  initRecord(recorder, "source", "status_validate"); validateChildStatus(status, identity, recorder);
  initRecord(recorder, "source", "mount_read"); const mounts = await readFile("/proc/self/mountinfo", "utf8");
  initRecord(recorder, "source", "mount_parse"); const parsed = parseMounts(mounts, true, recorder);
  initRecord(recorder, "source", "mount_validate"); validateMounts(parsed, recorder);
  initRecord(recorder, "source", "namespace_read"); const evidence = await namespaceEvidence();
  initRecord(recorder, "source", "network_validate");
  check(initGuardLeaf(same(evidence.interfaces, ["lo"]), recorder, "interfaces") && initGuardLeaf(evidence.routes4.length === 0, recorder, "routes4"), "container-external-network");
  for (const line of evidence.routes6) {
    const fields = line.trim().split(/\s+/);
    initGuardCheck(fields.length === 10 && fields[9] === "lo" && fields[4] === "0".repeat(32) && ((fields[0] === "0".repeat(31) + "1" && fields[1] === "80") || fields[0] === "0".repeat(32) && fields[1] === "00" && (Number.parseInt(fields[8], 16) & 0x200) !== 0), "container-external-ipv6", recorder, "routes6");
  }
  initRecord(recorder, "source", "environment_construct"); const expected = containerEnvironment(builder ? "/task/child" : "/task");
  initRecord(recorder, "source", "environment_validate"); initGuardCheck(same(Object.entries(process.env).sort(), Object.entries(expected).sort()), "container-effective-environment", recorder, "effective_env");
  if (inspectMasks) return validateEmptyMasks(parsed, recorder);
}
async function nativeReceipt(contextHash, recorder) {
  initRecord(recorder, "source", "native_read"); const bytes = await readFile(join(containerContract.input, ".edge-native.json"), "utf8");
  initRecord(recorder, "source", "native_parse"); const parsed = JSON.parse(bytes);
  initRecord(recorder, "source", "native_validate"); const receipt = validateNativeIdentity(parsed, { contextHash });
  initRecord(recorder, "source", "native_qualify"); const actual = await qualifyImageInputs(contextHash);
  initRecord(recorder, "source", "native_equality"); initGuardCheck(same(receipt, actual), "image-native-drift", recorder, "native_receipt_equality"); return receipt;
}
export function parseImageBuildReceipt(text, contextHash) {
  const lines = text.split("\n").filter(line => line.startsWith("EDGE_IMAGE_V2 "));
  check(lines.length === 1 && Buffer.byteLength(lines[0]) <= 8192, "image-attestation-count");
  return validateNativeIdentity(JSON.parse(lines[0].slice("EDGE_IMAGE_V2 ".length)), { contextHash });
}
export function parseImageBuildStages(result, identity) {
  const unknown = (reason, records = null) => ({ v: 4, phase: "image_build_internal", state: "observed", stage: null, status: null, records, reason });
  const field = (object, key) => object && typeof object === "object" && Object.hasOwn(object, key) ? own(object, key) : null;
  if (!identity || !hashPattern.test(identity.contextHash) || !hashPattern.test(identity.nonce) || field(result, "closed") !== true) return unknown("capture_unavailable");
  const summary = field(result, "outputSummary");
  let total = 0;
  for (const channel of ["stdout", "stderr"]) {
    const text = field(result, channel), captured = field(summary, channel);
    if (typeof text !== "string" || field(captured, "complete") !== true || !Number.isSafeInteger(field(captured, "bytes")) || field(captured, "bytes") < 0 || !hashPattern.test(field(captured, "sha256"))) return unknown("capture_unavailable");
    const bytes = Buffer.from(text, "utf8"); total += bytes.length;
    // close/complete alone does not prove that bounded capture retained its tail.
    if (bytes.length !== field(captured, "bytes") || hash(bytes) !== field(captured, "sha256") || total > 1024 * 1024) return unknown("capture_mismatch");
  }
  const prefix = "EDGE_BUILD_STAGE_V1 "; let count = 0, failed;
  for (const line of field(result, "stdout").split("\n")) {
    if (!line.includes("EDGE_BUILD_STAGE_V1")) continue;
    if (!line.startsWith(prefix) || Buffer.byteLength(line) > 512 || /[\x00-\x1f\x7f-\x9f]/.test(line) || count === 20 || failed) return unknown("invalid");
    let row;
    try { row = JSON.parse(line.slice(prefix.length)); } catch { return unknown("invalid"); }
    if (!row || Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).join() !== "v,context,nonce,seq,stage,event,status" || JSON.stringify(row) !== line.slice(prefix.length)) return unknown("invalid");
    const terminal = count % 2 === 1;
    if (row.v !== 1 || row.context !== identity.contextHash || row.nonce !== identity.nonce || row.seq !== count + 1 || row.stage !== imageBuildStages[Math.floor(count / 2)] || row.event !== (terminal ? "terminal" : "entered") || (terminal ? !Number.isInteger(row.status) || row.status < 0 || row.status > 255 : row.status !== null)) return unknown("invalid");
    count++;
    if (terminal && row.status !== 0) failed = row;
  }
  if (failed && field(result, "code") === 0) return unknown("invalid");
  if (failed) return { v: 4, phase: "image_build_internal", state: "rejected", stage: failed.stage, status: failed.status, records: count, reason: "validated_failure" };
  if (count === 20) return { v: 4, phase: "image_build_internal", state: "observed", stage: "native_prepare", status: 0, records: count, reason: "complete" };
  return unknown(count ? "incomplete" : "no_records", count);
}
export function parseNativePrepareStages(result, identity) {
  const unknown = (reason, records = null) => ({ v: 5, phase: "native_prepare_internal", state: "observed", stage: null, defined: null, records, reason, reportFailures: null, undefinedReportFailures: null });
  // Reuse the original BOTH-stream byte/hash prerequisite and outer grammar.
  const outer = parseImageBuildStages(result, identity);
  if (["capture_unavailable", "capture_mismatch"].includes(outer.reason)) return unknown(outer.reason);
  if (!["complete", "validated_failure"].includes(outer.reason) || outer.stage !== "native_prepare") return unknown("outer_inconsistent");
  const lines = own(result, "stdout").split("\n"), prefix = "EDGE_NATIVE_" + "PREPARE_V1 ";
  const outerRows = lines.flatMap((line, index) => line.startsWith("EDGE_BUILD_STAGE_V1 ") ? [{ index, row: JSON.parse(line.slice("EDGE_BUILD_STAGE_V1 ".length)) }] : []);
  const start = outerRows.find(item => item.row.seq === 19)?.index, end = outerRows.find(item => item.row.seq === 20)?.index;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) return unknown("outer_inconsistent");
  let count = 0, entered = 0, terminal;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.includes(prefix.trimEnd())) continue;
    if (index <= start || index >= end || !line.startsWith(prefix) || Buffer.byteLength(line) + 2 > 512 || /[\x00-\x1f\x7f-\x9f]/.test(line) || count >= 32 || terminal) return unknown("invalid");
    let row;
    try { row = JSON.parse(line.slice(prefix.length)); } catch { return unknown("invalid"); }
    const keys = "v,context,nonce,seq,stage,event,outcome,defined,reportFailures,undefinedReportFailures" + (row && Object.hasOwn(row, "enumeration") ? ",enumeration" : "") + (row && Object.hasOwn(row,"compile") ? ",compile" : "");
    if (!row || Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).join() !== keys || JSON.stringify(row) !== line.slice(prefix.length)) return unknown("invalid");
    if (row.v !== 1 || row.context !== identity.contextHash || row.nonce !== identity.nonce || row.seq !== count + 1) return unknown("invalid");
    count++;
    if (row.event === "entered") {
      if (Object.hasOwn(row, "enumeration") || Object.hasOwn(row,"compile") || entered >= nativePrepareStages.length || row.stage !== nativePrepareStages[entered++] || [row.outcome, row.defined, row.reportFailures, row.undefinedReportFailures].some(value => value !== null)) return unknown("invalid");
    } else if (row.event === "terminal") {
      if (!entered || row.stage !== nativePrepareStages[entered - 1] || !["original_failure", "reporter_failure", "complete"].includes(row.outcome) || !Number.isInteger(row.reportFailures) || row.reportFailures < 0 || row.reportFailures > 32 || !Number.isInteger(row.undefinedReportFailures) || row.undefinedReportFailures < 0 || row.undefinedReportFailures > row.reportFailures) return unknown("invalid");
      if (row.outcome === "original_failure" ? typeof row.defined !== "boolean" : row.defined !== null || entered !== nativePrepareStages.length || (row.outcome === "complete" ? row.reportFailures !== 0 : row.reportFailures < 1)) return unknown("invalid");
      if (Object.hasOwn(row, "enumeration")) {
        if (row.outcome !== "original_failure" || row.stage !== "context_enumeration") return unknown("invalid");
        if (!row.enumeration || typeof row.enumeration !== "object") return unknown("invalid");
        if (Object.hasOwn(row.enumeration, "m")) {
          if (Object.keys(row.enumeration).join() !== "op,type,depth,files,bytes,overflow,m") return unknown("invalid");
          const { m, ...detail } = row.enumeration;
          row.enumeration = { ...detail, failed: true, defined: row.defined, m };
        }
        try { row.enumeration = validateEnumerationDetail(row.enumeration); } catch { return unknown("invalid"); }
        if (row.enumeration.defined !== row.defined) return unknown("invalid");
      }
      if (Object.hasOwn(row,"compile")) {
        if (row.outcome !== "original_failure" || row.stage !== "prepare_arguments" || count !== 5 || row.reportFailures !== 0 || row.undefinedReportFailures !== 0 || Object.hasOwn(row,"enumeration")) return unknown("invalid");
        try { row.compile = validateCompileDetail(row.compile); } catch { return unknown("invalid"); }
      }
      terminal = row;
    } else return unknown("invalid");
  }
  if (!terminal) return unknown(count ? "incomplete" : "no_records", count);
  if (terminal.outcome === "complete" ? outer.reason !== "complete" || own(result, "code") !== 0 : outer.reason !== "validated_failure" || own(result, "code") === 0) return unknown("outer_inconsistent");
  return { v: 5, phase: "native_prepare_internal", state: terminal.outcome === "complete" ? "observed" : "rejected", stage: terminal.outcome === "original_failure" ? terminal.stage : null, defined: terminal.defined, records: count, reason: terminal.outcome, reportFailures: terminal.reportFailures, undefinedReportFailures: terminal.undefinedReportFailures, ...(Object.hasOwn(terminal, "enumeration") ? { enumeration: terminal.enumeration } : {}), ...(Object.hasOwn(terminal,"compile") ? {compile:terminal.compile} : {}) };
}
export async function observeImageBuild(operation, readImageId, parseReceipt, report, stageIdentity) {
  let built, available = false;
  const errors = [];
  try { built = await operation(); available = true; } catch (error) { errors.push(error); }
  try { report.process(built, available, errors[0]); } catch (error) { errors.push(error); }
  if (available) try { report.internal(parseImageBuildStages(built, stageIdentity)); } catch (error) { errors.push(error); }
  if (available) try { report.internal(parseNativePrepareStages(built, stageIdentity)); } catch (error) { errors.push(error); }
  if (available) try { requireProcessSuccess(built); } catch (error) { errors.unshift(error); }
  raiseContainerFailures(errors);
  const observe = async (phase, original) => {
    report.mark(phase, "entered");
    let value;
    try { value = await original(); }
    catch (error) {
      try { report.mark(phase, "rejected", error); }
      catch (reportError) { raiseContainerFailures([error, reportError]); }
      throw error;
    }
    report.mark(phase, "fulfilled"); return value;
  };
  const imageId = await observe("image_id", readImageId);
  const native = await observe("native_receipt", () => parseReceipt(built.stdout));
  return { imageId, native };
}
export function createReceiptLedger() {
  const errors = []; let operation = 0, ordinal = 0, seen = 0, passed = 0, falseLeaf = 0, broken = false, cardinality = "UNKNOWN";
  const note = fn => { try { fn(); } catch (error) { broken = true; errors.push(error); } };
  return { errors,
    count(value) { note(() => { cardinality = Number.isSafeInteger(value) && value >= 0 ? value === 0 ? "ZERO" : value === 1 ? "ONE" : "MULTIPLE" : "UNKNOWN"; }); },
    cardinality() { return broken || errors.length ? "UNKNOWN" : cardinality; },
    enter(name, role = 0) { note(() => { operation = receiptOperations.findIndex(row => row[0] === name) + 1; check(operation > 0 && [0,1,2].includes(role), "receipt-observation-operation"); ordinal = role; seen = passed = falseLeaf = 0; }); },
    leaf(id, value) { note(() => { check(operation > 0 && Number.isInteger(id) && id > 0 && id <= receiptOperations[operation - 1][1], "receipt-observation-leaf"); const bit = 2 ** (id - 1); seen |= bit; if (value) passed |= bit; else falseLeaf ||= id; }); },
    finish(outcome, reason) { return broken || errors.length ? null : [1,outcome,outcome === 2 ? reason !== undefined : null,outcome === 2 ? operation : 0,outcome === 2 ? falseLeaf ? 1 : seen ? 2 : 0 : 0,outcome === 2 ? falseLeaf : 0,outcome === 2 ? ordinal : 0,outcome === 2 ? seen : 0,outcome === 2 ? passed : 0]; },
  };
}
export function parseContainerReceipt(text, plan, recorder) {
  receiptRecord(recorder, "enter", "scan"); const split = text.split("\n");
  receiptRecord(recorder, "enter", "filter"); const lines = split.filter(line => line.startsWith("EDGE_CONTAINER_RECEIPT_V2 "));
  receiptRecord(recorder, "enter", "count_size");
  check(receiptLeaf(recorder, 1, receiptCount(recorder, lines.length) === 1) && receiptLeaf(recorder, 2, Buffer.byteLength(lines[0]) <= 8192), "container-receipt-count");
  receiptRecord(recorder, "enter", "json"); const receipt = JSON.parse(lines[0].slice("EDGE_CONTAINER_RECEIPT_V2 ".length));
  receiptRecord(recorder, "enter", "keys"); exactKeys(receipt, ["version", "isolation", "nonce", "contextHash", "nativeHash", "sourceSha", "sourceTree", "sourceFiles", "dependencyFiles", "exactErasures", "twoRoots", "cliSha256", "results", "cloud", "sdk", "masks"], recorder);
  receiptRecord(recorder, "enter", "identity");
  check(receiptLeaf(recorder, 1, receipt.version === 2) && receiptLeaf(recorder, 2, receipt.isolation === "private-container-pid-net-mount") && receiptLeaf(recorder, 3, receipt.nonce === plan.nonce) && receiptLeaf(recorder, 4, receipt.contextHash === plan.contextHash) && receiptLeaf(recorder, 5, receipt.nativeHash === plan.nativeHash) && receiptLeaf(recorder, 6, receipt.sourceSha === edgeProof.sourceSha) && receiptLeaf(recorder, 7, receipt.sourceTree === edgeProof.sourceTree) && receiptLeaf(recorder, 8, receipt.sourceFiles === 600) && receiptLeaf(recorder, 9, receipt.dependencyFiles === 268) && receiptLeaf(recorder, 10, receipt.exactErasures === 4) && receiptLeaf(recorder, 11, receipt.twoRoots === true) && receiptLeaf(recorder, 12, receipt.cliSha256 === containerContract.cliHash) && receiptLeaf(recorder, 13, receipt.sdk === "UNRUN") && receiptLeaf(recorder, 14, receipt.cloud === "UNRUN"), "container-receipt-identity");
  receiptRecord(recorder, "enter", "masks"); validateMaskCompletion(receipt.masks, recorder);
  receiptRecord(recorder, "enter", "results_keys"); exactKeys(receipt.results, ["edge", "upstream"], recorder);
  receiptRecord(recorder, "enter", "values"); let ordinal = 0;
  for (const result of Object.values(receipt.results)) {
    receiptRecord(recorder, "enter", "result_keys", ++ordinal); exactKeys(result, ["code", "signal", "closed", "sha256", "observedProcesses"], recorder);
    receiptRecord(recorder, "enter", "result", ordinal);
    check(receiptLeaf(recorder, 1, result.code === 0) && receiptLeaf(recorder, 2, result.signal === null) && receiptLeaf(recorder, 3, result.closed === true) && receiptLeaf(recorder, 4, hashPattern.test(result.sha256)) && receiptLeaf(recorder, 5, Number.isSafeInteger(result.observedProcesses)) && receiptLeaf(recorder, 6, result.observedProcesses >= 1), "container-wrangler-result");
  }
  return receipt;
}
export async function observeContainerReceipt(report, text, plan, childSummary, recorder = createReceiptLedger()) {
  const reporting = []; let outcome = 0, operationReason, stepFailed = false, stepReason, value;
  try { value = await report.step("receipt", () => {
    try { value = parseContainerReceipt(text, plan, recorder); outcome = 1; return value; }
    catch (error) { outcome = 2; operationReason = error; throw error; }
  }, reporting); } catch (error) { stepFailed = true; stepReason = error; }
  const failures = [...(outcome === 2 ? [operationReason] : []), ...reporting];
  if (stepFailed && !reporting.length && (outcome !== 2 || !Object.is(stepReason, operationReason))) failures.push(stepReason);
  failures.push(...recorder.errors);
  if (failures.length) {
    const projector = createProjectionLedger(); let child;
    try { child = childSummary(projector); } catch (error) { reporting.push(error); failures.push(error); child = [1,"invalid",null,0,0,0,0,null,"UNKNOWN"]; }
    failures.push(...projector.errors);
    const diagnostics = [...reporting, ...recorder.errors, ...projector.errors];
    try { const builder=projector.builder();report.internal(packReceiptObservedWranglerDiagnostic(packReceiptCensusDiagnostic({ v: 12, phase: "receipt", state: "rejected", defined: failures[0] !== undefined, exit: null, signal: null,
      parser: recorder.finish(outcome, operationReason), child, reports: [diagnostics.length, diagnostics.filter(error => error === undefined).length], count: recorder.cardinality(), projection: projector.detail(), lifecycle: projector.lifecycle(), builder },projector.owned(),projector.code(),projector.census()),projector.wrangler())); }
    catch (error) { failures.push(error); }
    raiseContainerFailures(failures);
  }
  return value;
}
async function containerInit(args, sharedReport) {
  let identity, masks, rpc, controls, native, built, postPermit=false; const failures = [];
  const witness=createCoordinatorWitness();
  const trace = createInitDiagnostics(), ledger = createInitGuardLedger(); if (sharedReport) sharedReport.init = trace;
  try {
  native = await runInitPrerequisites(args, trace, {
    arguments: values => check(values.length === 4 && hashPattern.test(values[0]) && hashPattern.test(values[1]), "init-arguments"),
    identity: ([nonce, contextHash, uid, gid]) => (identity = { uid: Array(4).fill(number(uid)), gid: Array(4).fill(number(gid)), groups: [] }),
    reset: () => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, containerEnvironment()); },
    prepare: async () => {
      rpc = createReaperClient(new Socket({fd:3, readable:true, writable:true}), {pid:process.pid, nonce:args[0], contextHash:args[1]});
      await rpc.start(); await prepareEnvironment("/task");
    }, runtime: async identity => {
      masks = await validateContainerRuntime(identity, false, ledger, true);
      const pair = await qualifyControls(identity, args[0], args[1]); controls = bindCensusControls(pair.reaper, pair.coordinator);
    }, native: contextHash => nativeReceipt(contextHash, ledger),
    ready: (nonce, contextHash) => process.stdout.write(control("ready", nonce, contextHash)), permit: (nonce, contextHash) => receivePermit(nonce, contextHash),
  }, ledger);
  postPermit=true;
  const [nonce, contextHash, uid, gid] = args;
  // Native fixtures run only in this admitted original container, after permit.
  await hostedReaperFixtures(args, rpc, controls, witness);
  witness.point(5);
  const report = createPackagingDiagnostics("child", line => process.stdout.write(line)), errors = [];
  report.mark("entry", "fulfilled");
  try {
    witness.point(4);
    built = await runPackagingPipeline(containerContract.input, "/task", report, {
      builderDiagnostics: true,
      controls, drain: () => rpc.drain(),
      checkBoundary: async () => { await validateContainerRuntime(identity); await nativeReceipt(contextHash); },
      buildArguments: (capsule, role) => ["/opt/edge-input/scripts/edge-proof.mjs", "container-build", capsule, role, contextHash, uid, gid],
    });
  } catch (error) { witness.escape(error);errors.push(error); }
  witness.point(5);
  report.mark("final", errors.length ? "rejected" : "fulfilled", errors[0]); errors.push(...report.errors); raiseContainerFailures(errors);
  } catch (error) { if(postPermit)witness.escape(error);failures.push(error); }
  // FINISH is acknowledged before Node closes FD3 and exits. Every independent
  // failure remains fatal; a shutdown error never overwrites the primary value.
  if (rpc) try { await rpc.finish();witness.finish(1); } catch (error) { witness.finish(2,error);failures.push(error); }
  if(postPermit)try { await writeCoordinatorWitness(witness,args,process.pid,(text,callback)=>process.stdout.write(text,callback)); } catch(error) { failures.push(error); }
  failures.push(...witness.errors);
  raiseContainerFailures(failures);
  const [nonce, contextHash] = args;
  const { version: _version, isolated: _isolated, ...packaging } = built;
  const receipt = { version: 2, isolation: "private-container-pid-net-mount", nonce, contextHash, nativeHash: hash(JSON.stringify(native)), masks, ...packaging };
  process.stdout.write("EDGE_CONTAINER_RECEIPT_V2 " + JSON.stringify(receipt) + "\n");
  return { container: "complete", version: 2 };
}
async function hostedReaperFixtures(args, rpc, controls, witness) {
  const sample = () => privateProcesses(undefined, controls), beforeFinal = () => rpc.drain();
  witness?.point(1);await hostedCensusMatrix(args, rpc, controls);
  // The C PID1 startup fixture already established a waitable adopted orphan and
  // reaped it with the production loop. This checks the ORIGINAL Node spawn's FD
  // inheritance, not a separately constructed descriptor model.
  witness?.point(2);
  const fd = await runOwnedProcess(containerContract.reaper, ["--check-fd"], {cwd:"/task",env:containerEnvironment(),sample,beforeFinal});
  requireProcessSuccess(fd);
  // Use the original supervisor's existing default deadline and escalation.
  // The fixture server authenticates HELLO but deliberately withholds DRAIN ACK.
  witness?.point(3);
  const held = await runOwnedProcess(containerContract.reaper, ["--fixture-hold",containerContract.node,"/opt/edge-input/scripts/edge-proof.mjs","container-reaper-probe",...args], {cwd:"/task",env:containerEnvironment(),sample,beforeFinal});
  try { check(held.closed && held.timedOut && !held.interrupted && held.errors.length === 0 && Array.isArray(held.remaining) && held.remaining.length === 0 && held.code !== 0, "reaper-held-ack-fixture"); }
  catch (error) { raiseContainerFailures([...held.errors, error]); }
  let rejected = false; try { requireProcessSuccess(held); } catch { rejected = true; } check(rejected, "reaper-held-ack-qualified");
}
export async function hostedCensusMatrix(args, rpc, controls, supplied = {}) {
  const ops = {readControl, validateControlPair, bindCensusControls, privateProcesses, createCensusComparisonWitness, runOwnedProcess, requireProcessSuccess, spawn, ...supplied};
  const identity = {uid:Array(4).fill(number(args[2])),gid:Array(4).fill(number(args[3])),groups:[]};
  const reaper = await ops.readControl(1), coordinator = await ops.readControl(controls.coordinator.pid);
  const expected = {identity,nonce:args[0],contextHash:args[1]};
  const pair = ops.validateControlPair(reaper,coordinator,expected);
  check(same(pair,controls), "fixture-control-original");
  for (const role of ["reaper","coordinator"]) {
    // Actual stable identities first, then distinct admission and original census
    // counterexamples. No substitute ever enters the product's control token.
    const changed = {...(role === "reaper" ? reaper : coordinator), exe:"/invalid-control"};
    let denied = false;
    try { ops.validateControlPair(role === "reaper" ? changed : reaper, role === "coordinator" ? changed : coordinator, expected); } catch { denied = true; }
    check(denied,"fixture-control-substitution");
    const wrong = {...pair,[role]:{...pair[role],start:String(BigInt(pair[role].start)+1n)}};
    const token = ops.bindCensusControls(wrong.reaper,wrong.coordinator), witness = ops.createCensusComparisonWitness(token,role);
    let rejected = false, reason;
    try { await ops.privateProcesses(undefined,token,witness.recorder); } catch (error) { rejected = true; reason = error; }
    witness.requireRejected(rejected,reason);
  }
  const failures = [], snapshots = []; let queued = Promise.resolve(), buffer = "", frames = 0, child;
  const result = await ops.runOwnedProcess(containerContract.reaper,["--fixture-census"],{
    cwd:"/task",env:containerEnvironment(),sample:()=>ops.privateProcesses(undefined,controls),beforeFinal:()=>rpc.drain(),
    spawnProcess(command,argv,options) {
      child = ops.spawn(command,argv,{...options,stdio:["pipe","pipe","pipe"]});
      child.stdin.on("error",error=>failures.push(error));
      child.stdout.on("data",bytes=>{
        queued = queued.then(async()=>{
          check(Buffer.isBuffer(bytes) && bytes.length + buffer.length <= 64 && bytes.every(byte=>byte===10 || byte>=32 && byte<=126),"fixture-census-frame-capacity");
          buffer += bytes.toString("ascii");
          if (!buffer.endsWith("\n")) return;
          const match = /^(LIVE|ZOMBIE):([1-9]\d{0,9})\n$/.exec(buffer); buffer = "";
          check(match && frames < 2 && match[1] === (frames === 0 ? "LIVE" : "ZOMBIE"),"fixture-census-order");
          const pid = number(match[2]); check(pid > 1 && pid <= 0x7fffffff,"fixture-census-pid");
          const rows = await ops.privateProcesses(undefined,controls), found = rows.filter(row=>row.pid===pid);
          check(found.length === 1 && found[0].parent === child.pid && (frames === 0 ? ["R","S","D","I"].includes(found[0].state) : found[0].state === "Z"),"fixture-census-real-state");
          if (frames) check(found[0].start === snapshots[0].find(row=>row.pid===pid)?.start,"fixture-census-start");
          snapshots.push(rows); frames++;
          await new Promise((resolveWrite,rejectWrite)=>child.stdin.write(frames===1?"L":"Z",error=>error?rejectWrite(error):resolveWrite()));
          if (frames === 2) child.stdin.end();
        }).catch(error=>{
          failures.push(error);
          try { child.stdin.destroy(); } catch (other) { failures.push(other); }
        });
      });
      return child;
    },
  });
  await queued;
  try { ops.requireProcessSuccess(result); } catch (error) { failures.push(error); }
  try {
    check(frames===2 && buffer==="" && snapshots.length===2,"fixture-census-incomplete");
    for (const rows of snapshots) {
      // Counterexample to the actual success predicate using actual held rows.
      // This is explicitly NOT a fresh product final-census/retirement claim.
      let denied=false; try { ops.requireProcessSuccess({...result,remaining:rows}); } catch { denied=true; }
      check(denied,"fixture-nonempty-qualified");
    }
  } catch (error) { failures.push(error); }
  raiseContainerFailures(failures);
}
async function reaperProbe(args) {
  check(args.length === 4 && hashPattern.test(args[0]) && hashPattern.test(args[1]), "reaper-probe-arguments");
  const rpc = createReaperClient(new Socket({fd:3,readable:true,writable:true}), {pid:process.pid,nonce:args[0],contextHash:args[1]});
  await rpc.start(); await rpc.drain();
  // This path is forbidden for the held-ACK fixture; no success receipt exists.
  throw new Error("edge-container: held-ack-returned");
}
// These are the same-thread async acquisition routes in the frozen packages.
// Hash before importing the builder; no private handles or spawn replacement.
async function qualifyNativeChildRoutes(native, capsule) {
  check(process.version === "v24.22.1" && process.versions.modules === "137" && process.platform === "linux" && process.arch === "x64", "native-child-runtime");
  const tsRoot = join(containerContract.input, "node_modules/typescript/dist/api");
  const esbuildEntry = createRequire(import.meta.resolve("wrangler/package.json")).resolve("esbuild");
  for (const [path, expected] of [
    [join(tsRoot, "sync/api.js"), "e27255574a3c1a3236c4083c769758de3327bba8d3cd19f015551b619ae783d2"],
    [join(tsRoot, "sync/client.js"), "4cca322e20fff9460d1843a62b2cac4ee963109b4d07e984bed9f54e7baa10b8"],
    [join(tsRoot, "syncChannel.js"), "132714a6e2dd7fd079f7f67bf9ed41d4123ab2ab4d94043a34ea3b1a8f1fb001"],
    [join(tsRoot, "options.js"), "b47b35b4b92d2ede9c72018859528eef2a1b57c4539cb7b58eaf1b5be193ea58"],
    [join(tsRoot, "../../lib/getExePath.js"), "96c10fd3a18e165d7323de8e314ac8d755ad96811f9fbc304a5b3ba4e05285cc"],
    [esbuildEntry, "61ec0ba144ff93f4bf0e96ad6fab6f430ede0aa13e27ace8063ed63ba416b3cd"],
  ]) {
    const canonical = await realpath(path);
    check(canonical.startsWith(containerContract.input + "/node_modules/"), "native-child-source-containment");
    check((await fileIdentity(canonical)).sha256 === expected, "native-child-source");
  }
  return [
    [native.native.typescript.path, "--api", "--cwd", capsule],
    [native.native.esbuild.path, "--service=0.28.2", "--ping"],
  ];
}

function createNativeChildOwner(routes) {
  const publication = channel("child_process"), rows = [], errors = [];
  let active = true, subscribed = false, draining = false, captureIncomplete = false;
  const unknownClose = new Promise(() => {});
  const fault = code => errors.push(new Error(code));
  const protect = operation => { try { return operation(); } catch (error) { errors.push(error); } };
  const classify = row => {
    const file = row.child.spawnfile, args = row.child.spawnargs;
    check(typeof file === "string" && Array.isArray(args), "native-child-spawn-metadata");
    const role = routes.findIndex(route => file === route[0] && args.length === route.length && route.every((part, i) => args[i] === part));
    check(role >= 0, "native-child-route");
    check(!rows.some(other => other !== row && other.role === role), "native-child-duplicate-route");
    if (row.role !== null) check(row.role === role, "native-child-route-drift");
    row.role = role;
  };
  const subscriber = message => {
    // A diagnostics-channel subscriber exception would be an uncaught exception.
    protect(() => {
      if (!active || rows.length >= 4) { captureIncomplete = true; fault("native-child-capture-capacity"); return; }
      let child;
      try { child = message.process; } catch (error) { captureIncomplete = true; throw error; }
      if (!child) { captureIncomplete = true; fault("native-child-missing-object"); return; }
      check(child && !rows.some(row => row.child === child), "native-child-duplicate-object");
      let closed;
      const row = { child, role: null, spawned: false, exited: false, closed: false, listeners: [], close: new Promise(resolve => { closed = resolve; }) };
      rows.push(row);
      const listen = (event, handler) => {
        const callback = (...args) => protect(() => handler(...args));
        row.listeners.push([event, callback]);
        protect(() => child.on(event, callback));
      };
      // Close never rejects on error. Only the original close event resolves it.
      listen("close", () => { if (row.closed) fault("native-child-duplicate-close"); row.closed = true; closed(); });
      listen(errorMonitor, error => { errors.push(error); });
      listen("exit", () => { if (row.exited) fault("native-child-duplicate-exit"); row.exited = true; });
      listen("spawn", () => {
        protect(() => { check(!row.spawned, "native-child-duplicate-spawn"); row.spawned = true; classify(row); });
        if (draining && !row.closed) child.ref();
      });
    });
  };
  try { publication.subscribe(subscriber); subscribed = true; }
  catch (error) { errors.push(error); protect(() => publication.unsubscribe(subscriber)); }
  return {
    start() { raiseContainerFailures(errors); },
    async drain(requireRoutes) {
      draining = true;
      try {
        // At most four constructed objects and five passes. Each close join is
        // bounded by the existing outer owned-builder deadline, not a new timer.
        let stable = false;
        for (let pass = 0; pass < 5; pass++) {
          const count = rows.length, joins = [];
          for (const row of rows) {
            if (row.closed) continue;
            // PID absence includes Node's queued async spawn-error/close route.
            // Listener installation can also throw after attaching. Neither
            // observation discharges this constructor's actual-close obligation.
            protect(() => row.child.ref());
            joins.push(row.close);
          }
          // Lost capture capacity cannot prove that every child has closed.
          // Keep custody until the existing outer deadline; never invent a join.
          if (captureIncomplete) joins.push(unknownClose);
          await Promise.all(joins);
          if (rows.length === count && !captureIncomplete) { stable = true; break; }
        }
        if (!stable) fault("native-child-drain-capacity");
        for (const row of rows) protect(() => {
          check(row.closed && row.spawned, "native-child-incomplete"); classify(row);
        });
        if (requireRoutes) protect(() => check(routes.every((_, role) => rows.filter(row => row.role === role).length === 1), "native-child-missing-route"));
      } finally {
        // Never remove another subscriber or library listener. All cleanup
        // attempts survive independent failures, including thrown undefined.
        if (subscribed) protect(() => check(publication.unsubscribe(subscriber) === true, "native-child-unsubscribe"));
        active = false;
        for (const row of rows) for (const [event, callback] of row.listeners) protect(() => row.child.removeListener(event, callback));
      }
      raiseContainerFailures(errors);
    },
  };
}

async function containerBuild(args) {
  check(args.length === 5 && ["/task/capsule-a", "/task/capsule-b"].includes(args[0]) && ["build_a", "build_b"].includes(args[1]) && hashPattern.test(args[2]), "builder-arguments");
  const [capsule, role, contextHash, uid, gid] = args, identity = { uid: Array(4).fill(number(uid)), gid: Array(4).fill(number(gid)), groups: [] };
  const report = createPackagingDiagnostics(role, line => process.stdout.write(line)), errors = [];
  report.mark("entry", "fulfilled"); let esbuild, children;
  try {
    await report.step("namespace_read", () => validateContainerRuntime(identity, true));
    const native = await nativeReceipt(contextHash);
    children = createNativeChildOwner(await qualifyNativeChildRoutes(native, capsule));
    children.start();
    const { buildCapsule } = await report.step("builder_import", () => import("./edge-proof-build.mjs"));
    esbuild = createRequire(import.meta.resolve("wrangler/package.json"))("esbuild");
    const receipt = await report.step("build", () => buildCapsule(containerContract.input, capsule, { executable: native.native.git.path, sha256: native.native.git.sha256, env: { ...gitEnvironment } }));
    await report.step("receipt_write", () => writeFile(join(capsule, "source-receipt.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 }));
  } catch (error) { errors.push(error); }
  if (esbuild) try {
    await report.step("build_service_stop", async () => {
      const shutdown = [];
      try { await esbuild.stop(); } catch (error) { shutdown.push(error); }
      if (children) try { await children.drain(errors.length === 0 && shutdown.length === 0); } catch (error) { shutdown.push(error); }
      raiseContainerFailures(shutdown);
    });
  } catch (error) { errors.push(error); }
  else if (children) try { await children.drain(false); } catch (error) { errors.push(error); }
  report.mark("final", errors.length ? "rejected" : "fulfilled", errors[0]); errors.push(...report.errors); raiseContainerFailures(errors);
  return { built: true };
}
async function containerPrepare(args, prepare) {
  prepare?.enter("prepare_arguments");
  check(args.length === 1 && hashPattern.test(args[0]), "prepare-arguments");
  const compilation = prepare?.compileBegin();
  try { await compileReaper(args[0], compilation?.point); }
  catch (error) { compilation?.finish(true,error); throw error; }
  compilation?.finish(false);
  const native = await qualifyImageInputs(args[0], prepare);
  prepare?.enter("pnpm_child");
  const pnpm = execFileSync("/usr/local/bin/pnpm", ["--version"], { env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/opt/build-home" }, encoding: "utf8", timeout: 10000 }).trim();
  prepare?.enter("pnpm_version_check");
  check(pnpm === "11.28.4", "pnpm-version");
  prepare?.enter("receipt_write");
  await writeFile(join(containerContract.input, ".edge-native.json"), JSON.stringify(native), { flag: "wx", mode: 0o444 });
  prepare?.enter("receipt_output");
  process.stdout.write("EDGE_IMAGE_V2 " + JSON.stringify(native) + "\n"); return { prepared: true };
}

async function containerCi(sharedReport) {
  const report = sharedReport ?? createContainerDiagnostics(), errors = []; let value;
  try { value = await hostContainerRun(report); } catch (error) { errors.push(error); }
  if (errors.length && !sharedReport) try { emitContainerFailure(report.records); } catch (error) { errors.push(error); }
  raiseContainerFailures(errors); return value;
}
async function hostContainerRun(report) {
  report.sync("host_runtime", () => check(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1" && process.versions.modules === "137", "host-runtime"));
  const identity = await report.step("identity", readParentIdentity), parentNamespaces = await report.step("parent_namespaces", namespaceIdentity);
  const cwd = await report.step("cwd", () => realpath(process.cwd())), root = await report.step("temp", () => mkdtemp(join(tmpdir(), "edge-container-")));
  const env = await report.step("environment", async () => { const value = dockerEnvironment(root); await mkdir(value.HOME, { mode: 0o700 }); await mkdir(value.DOCKER_CONFIG, { mode: 0o700 }); return value; });
  const docker = (await report.step("docker_executable", () => fileIdentity("/usr/bin/docker"))).path;
  await report.step("daemon_socket", async () => check((await stat("/var/run/docker.sock")).isSocket() && ["/run/docker.sock", "/var/run/docker.sock"].includes(await realpath("/var/run/docker.sock")), "local-daemon-socket"));
  const runOriginal = (args, timeoutMs = 30000) => runOwnedProcess(docker, ["--host=unix:///var/run/docker.sock", ...args], { cwd: root, env, timeoutMs });
  const run = async (args, timeoutMs = 30000, recorder) => { parentSource(recorder, "inspect_command"); const result = await runOriginal(args, timeoutMs); parentSource(recorder, "inspect_success"); requireProcessSuccess(result); return result; };
  const inspect = async (type, id, recorder) => { const result = await run([type, "inspect", id], 30000, recorder); parentSource(recorder, "inspect_json"); const rows = JSON.parse(result.stdout); parentSource(recorder, "inspect_count"); check(parentEvaluate(recorder, 43, () => parentLeaf(recorder, 1, Array.isArray(rows)) && parentLeaf(recorder, 2, parentCount(recorder, rows.length) === 1)), "inspect-count"); return rows[0]; };
  let daemonRoot;
  await report.step("daemon", async () => {
    check((await readdir(env.DOCKER_CONFIG)).length === 0, "docker-config-not-empty");
    const info = JSON.parse((await run(["info", "--format", "{{json .}}"])).stdout);
    check(info.OSType === "linux" && info.CgroupVersion === "2" && info.SecurityOptions?.every(option => typeof option === "string" && !/rootless|userns/.test(option)), "daemon-contract");
    daemonRoot = info.DockerRootDir; check(typeof daemonRoot === "string" && isAbsolute(daemonRoot) && resolve(daemonRoot) === daemonRoot, "daemon-root");
  });
  const context = await report.step("context", () => createBuildContext(cwd, root));
  await report.step("base", async () => { await run(["pull", "--platform=linux/amd64", containerContract.base], 120000); validateImage(await inspect("image", containerContract.base)); });
  const iidFile = join(root, "image-id"), nonce = randomBytes(32).toString("hex"); let imageId, native;
  await report.step("image_build", async () => {
    const args = ["build", "--platform=linux/amd64", "--pull=false", "--no-cache", "--iidfile", iidFile, "--build-arg", `HOST_UID=${identity.uid[0]}`, "--build-arg", `HOST_GID=${identity.gid[0]}`, "--build-arg", `CONTEXT_HASH=${context.contextHash}`, "--build-arg", `TASK_NONCE=${nonce}`, context.context];
    ({ imageId, native } = await observeImageBuild(() => runOriginal(args, 480000), async () => {
      const id = (await readFile(iidFile, "utf8")).trim(); check(imagePattern.test(id), "image-build-result"); return id;
    }, stdout => parseImageBuildReceipt(stdout, context.contextHash), report, { contextHash: context.contextHash, nonce }));
  });
  const image = await report.step("image", async () => validateImage(await inspect("image", imageId), { derived: true, identity, id: imageId, contextHash: context.contextHash }));
  check(image.Config.Labels?.["org.openclaw.edge.nonce"] === nonce, "image-invocation");
  const plan = { image: imageId, identity, imageEnv: image.Config.Env, nonce, contextHash: context.contextHash, nativeHash: hash(JSON.stringify(native)) };
  const cidFile = join(root, "container-id"), failures = [], admissionReporting = []; let cid, created, attached, projectAttach, terminalRetention, controlBinding, waiting, bound, target, receipt, disposition = "retained";
  const readOwned = async recorder => validateContainerInspect(await inspect("container", cid, recorder), plan, cid, (parentSource(recorder, "inspect_validate"), recorder));
  const recheckParent = async recorder => validateIdentity(await readParentIdentity(recorder), identity, false, recorder);
  const stopOwned = async () => {
    const stopErrors = [];
    try { const row = await readOwned(); if (row.State.Running) { try { await run(["stop", "--time=2", cid], 5000); } catch (error) { stopErrors.push(error); } } } catch (error) { stopErrors.push(error); }
    try { const row = await readOwned(); if (row.State.Running) await run(["kill", "--signal=KILL", cid], 5000); } catch (error) { stopErrors.push(error); }
    raiseContainerFailures(stopErrors);
  };
  try {
    await report.step("create", async () => {
      await recheckParent();
      // cidfile is absent and exclusive to this invocation. Never retry create.
      const result = await run([ ...createArguments(plan, cidFile) ]);
      const fromFile = (await readFile(cidFile, "utf8")).trim(), fromOutput = result.stdout.trim();
      check(cidPattern.test(fromFile) && fromOutput === fromFile, "ambiguous-create"); cid = fromFile; created = await readOwned();
      check(created.State.Status === "created" && !created.State.Running && created.State.Pid === 0, "unexpected-start");
    });
    await report.step("attach", async () => {
      await recheckParent(); attached = attachContainer(docker, ["--host=unix:///var/run/docker.sock", "start", "--attach", "--interactive", cid], { cwd: root, env, nonce: plan.nonce, contextHash: plan.contextHash, onStop: stopOwned });
      projectAttach = createAttachProjection(attached, { cid, nonce: plan.nonce, contextHash: plan.contextHash }, report);
      terminalRetention = createReaperTerminalRetention(attached, () => ({cid, nonce, contextHash:plan.contextHash, controls:controlBinding, sourceHash:native.reaper.source.sha256}),
        bytes => writeFile(join(root,"reaper-terminal.json"), bytes, {flag:"wx",mode:0o600}), outcome=>projectAttach.terminal(attached.result,outcome));
    });
    await report.step("ready", () => attached.ready);
    await report.step("admission", async () => {
      const recorder = createParentAdmissionLedger();
      const project = (original, reason) => { try { const detail = recorder.finish(original, reason); if (detail) report.internal(detail); } catch (error) { recorder.errors.push(error); } };
      try {
      await recheckParent(recorder); const row = await readOwned(recorder); parentSource(recorder, "live_init"); check(parentEvaluate(recorder, 37, () => parentLeaf(recorder, 1, row.State.Running) && parentLeaf(recorder, 2, row.State.Pid > 1)), "missing-live-init");
      const cgroups = createParentCgroupAdmission(cid, parentNamespaces, identity, {}, { inspect: row, daemonRoot });
      const first = await cgroups.observe(row.State.Pid, 1, recorder); target = first.target; bound = first.bound;
      const controls = await parentControls(row.State.Pid, target, identity, nonce, plan.contextHash, native);
      // Parent and target kernel mount tables correlate the daemon's exact
      // per-container metadata paths without privileged storage traversal.
      parentSource(recorder, "parent_namespace"); const currentNamespace = await readlink("/proc/self/ns/mnt"); check(parentEvaluate(recorder, 38, () => parentLeaf(recorder, 1, currentNamespace === parentNamespaces.mnt)), "parent-mount-namespace-drift");
      const parentMounts = first.parentMounts;
      parentSource(recorder, "metadata"); const metadata = validateMetadataMounts(row, target.mounts, parentMounts, daemonRoot, cid, recorder);
      parentRecord(recorder, "visit", 2); const second = await cgroups.observe(target.pid, 2, recorder), again = second.target; parentSource(recorder, "identity_freshness"); check(parentEvaluate(recorder, 39, () => parentLeaf(recorder, 1, again.start === target.start) && parentLeaf(recorder, 2, same(again.namespaces, target.namespaces)) && parentLeaf(recorder, 3, again.cgroup === target.cgroup)), "init-identity-drift");
      parentSource(recorder, "mount_freshness"); validateMountFreshness(target.mounts, again.mounts, recorder);
      const rebound = second.bound; parentSource(recorder, "cgroup_freshness"); check(parentEvaluate(recorder, 40, () => parentLeaf(recorder, 1, sameCgroupBinding(bound, rebound))), "init-cgroup-drift"); bound = rebound;
      const repeatedControls = await parentControls(row.State.Pid, again, identity, nonce, plan.contextHash, native);
      check(same(controls, repeatedControls), "parent-controls-drift");
      controlBinding = controls;
      const repeatedParent = second.parentMounts; parentSource(recorder, "metadata"); const repeatedMetadata = validateMetadataMounts(row, again.mounts, repeatedParent, daemonRoot, cid, recorder); parentSource(recorder, "metadata_freshness"); check(parentEvaluate(recorder, 41, () => parentLeaf(recorder, 1, same(metadata, repeatedMetadata))), "daemon-metadata-drift");
      parentSource(recorder, "parent_namespace"); const finalNamespace = await readlink("/proc/self/ns/mnt"); check(parentEvaluate(recorder, 42, () => parentLeaf(recorder, 1, finalNamespace === parentNamespaces.mnt)), "parent-mount-namespace-drift");
      } catch (error) { project(true, error); admissionReporting.push(...recorder.errors); throw error; }
      if (recorder.errors.length) { project(false, recorder.errors[0]); raiseContainerFailures(recorder.errors); }
      recorder.seal();
    });
    // READY keeps init alive before compilation. Starting wait only after the
    // running PID was admitted avoids observing an as-yet-unstarted container.
    waiting = runOwnedProcess(docker, ["--host=unix:///var/run/docker.sock", "wait", cid], { cwd: root, env, timeoutMs: 480000 });
    await report.step("permit", () => attached.permit());
    const outcomes = await report.step("wait", () => Promise.allSettled([attached.closed, waiting]));
    raiseContainerFailures(outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason));
    const attachResult = outcomes[0].value, waitResult = outcomes[1].value;
    projectAttach(attachResult);
    let terminalFailed=false,terminalReason;
    try { await terminalRetention(attachResult); } catch(error) { terminalFailed=true;terminalReason=error; }
    if(terminalFailed){
      const errors=[terminalReason];
      if(terminalRetention.rejected(attachResult))try { await observeContainerReceipt(report,attachResult.stdout,plan,recorder=>projectAttach.child(attachResult,recorder)); } catch(error) { errors.push(error); }
      raiseContainerFailures(errors);
    }
    receipt = await observeContainerReceipt(report, attachResult.stdout, plan, recorder => projectAttach.child(attachResult, recorder));
    await report.step("terminal", async () => {
      await recheckParent(); const terminal = await readOwned();
      const cgroup = await report.step("cgroup", () => retiredCgroup(bound));
      validateTerminal({ wait: waitResult, attached: attachResult, inspect: terminal, cgroup, receipt });
    });
  } catch (error) { failures.push(error, ...admissionReporting); }
  // Every acquired resource gets an independent cleanup attempt. A cleanup
  // outcome never supplies the passing terminal/cgroup proof above.
  if (cid && created) {
    const cleanupFailures = [];
    try { await report.step("retirement", async () => {
      try {
        await readOwned();
        if (attached) check(bound, "retirement-cgroup-unknown");
      } catch (error) { cleanupFailures.push(error); }
      try { await stopOwned(); } catch (error) { cleanupFailures.push(error); }
      const originals = await Promise.allSettled([...(attached ? [attached.closed] : []), ...(waiting ? [waiting] : [])]);
      for (const outcome of originals) if (outcome.status === "rejected") cleanupFailures.push(outcome.reason); else {
        if (attached && outcome.value === attached.result) {
          try { projectAttach(outcome.value); } catch (error) { cleanupFailures.push(error); }
          try { await terminalRetention(outcome.value); } catch (error) { cleanupFailures.push(error); }
        }
        try { requireProcessSuccess(outcome.value); } catch (error) { cleanupFailures.push(error); }
      }
      try {
        await recheckParent(); const row = await readOwned(); check(!row.State.Running && row.State.Pid === 0, "retirement-live");
        // A never-started container has no process/cgroup to retire. An attempted
        // start without observed custody remains unknown and is retained.
        if (attached) { check(bound, "retirement-cgroup-unknown"); await retiredCgroup(bound); }
        await report.step("remove", () => run(["rm", cid])); disposition = "removed-owned-stopped";
      } catch (error) { cleanupFailures.push(error); }
      raiseContainerFailures(cleanupFailures);
    }); } catch (error) { failures.push(error); }
  }
  raiseContainerFailures(failures);
  check(disposition === "removed-owned-stopped", "disposition-unknown");
  // No tag, shared base or global cache is removed. This exact newly built
  // derived image is removed only after its own stopped container is gone.
  await report.step("remove", () => run(["image", "rm", imageId]));
  return { ...receipt, image: imageId, base: containerContract.base, contextHash: context.contextHash, dockerfileHash: context.dockerfileHash, disposition, imageDisposition: "removed-owned-derived", runtime: "qualified-in-this-execution" };
}
export async function containerMain(action, args, report) {
  if (action === "container-ci" && args.length === 0) return containerCi(report);
  if (action === "container-prepare") return containerPrepare(args, report?.prepare);
  if (action === "container-init") return containerInit(args, report);
  if (action === "container-build") return containerBuild(args);
  if (action === "container-reaper-probe") return reaperProbe(args);
  fail("container-action");
}
