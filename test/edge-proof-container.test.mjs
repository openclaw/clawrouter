import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, errorMonitor } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { containerContract, harnessInputs, installInputs, parseIdentity, validateIdentity, validateMapping, validateImage, dockerEnvironment, containerEnvironment, createArguments, validateContainerInspect, parseControl, validateTerminal, validateNativeIdentity, parseImageBuildReceipt, parseImageBuildStages, parseNativePrepareStages, observeImageBuild, parseContainerReceipt, parseChildPackaging, createProjectionLedger, parseInitPrerequisites, createAttachProjection, runInitPrerequisites, createInitGuardLedger, initGuardLeaf, createMountObservation, validateEmptyMasks, validateMaskCompletion, parseMounts, validateMountFreshness, validateMounts, validateMetadataMounts, validateChildStatus, validateTarget, cgroupPath, validateLimits, attachContainer, processEvidence, retiredCgroup, raiseContainerFailures, validateContainerDiagnostic, emitContainerFailure } from "../scripts/edge-proof-container.mjs";
import { frozenGitEnvironment, validateGitExecutable, frozenSource } from "../scripts/edge-proof-build.mjs";
import { edgeProof } from "../scripts/edge-proof-profile.mjs";
import { reaperFrame, createReaperClient, parseControlStat, validateControlPair, validateReaperElf, parseReaperTerminal, requireReaperTerminal, createReaperTerminalRetention, hostedCensusMatrix } from "../scripts/edge-proof-container.mjs";
import { bindCensusControls, classifyCensusControl, privateProcesses, createCensusComparisonWitness } from "../scripts/edge-proof.mjs";
import { launchCli, createPackagingDiagnostics, validatePackagingDiagnostic, receiptOperations, receiptChildPhases, validateReceiptDiagnostic, validateReceiptBoundaryDiagnostic, validateReceiptLifecycleDiagnostic, validateReceiptBuilderDiagnostic, validateReportedBuilderProcess, receiptBuilderSignals, packReceiptOwnedDiagnostic, packReceiptCodeDiagnostic, packReceiptAssociatedDiagnostic, validateReceiptAssociatedDiagnostic, packReceiptCensusDiagnostic, packReceiptObservedWranglerDiagnostic, unpackReceiptObservedWranglerDiagnostic, unpackReceiptWranglerDiagnostic, validateReceiptObservedWranglerDiagnostic, packObservedWranglerCloseDiagnostic, validateObservedWranglerCloseDiagnostic, validateObservedWranglerGroup, packReceiptWranglerDiagnostic, validateReceiptWranglerDiagnostic, packWranglerCloseDiagnostic, validateWranglerCloseDiagnostic, validateReportedWranglerProcess, unpackReceiptCensusDiagnostic, validateReceiptCensusDiagnostic, packCensusCloseDiagnostic, unpackCensusCloseDiagnostic, validateCensusCloseDiagnostic, validateFinalCensus, createFinalCensusLedger, censusStates, unpackReceiptOwnedDiagnostic, validateReceiptOwnedDiagnostic, validateOwnedTrace, validateOwnedCloseDiagnostic, validateOwnedCodeCloseDiagnostic, validateOwnedCode, validateReceiptCodeDiagnostic, ownedCodeClasses, classifyOwnedCode, createOwnedProcessLedger, projectionBoundaries, createContainerDiagnostics, containerProcessDiagnostic, imageBuildStages, runOwnedProcess, nativePrepareStages, createNativePrepareDiagnostics, enumerationOperations, validateEnumerationDetail, createInitDiagnostics, initPrerequisiteStages, attachFailureBranches, initGuardTags, initSourcePhases, validateInitDetail, mountPredicates, mountTargets, mountFilesystems, validateMountDetail, validateMaskDetail, parentAdmissionSources, parentAdmissionPredicates, parentAdmissionRoles, validateParentAdmission } from "../scripts/edge-proof.mjs";

const hex = "a".repeat(64), other = "b".repeat(64), imageId = "sha256:" + hex;
const identity = { uid: [501, 501, 501, 501], gid: [20, 20, 20, 20], groups: [20, 30] };
const status = (groups = "20") => `Uid:\t501\t501\t501\t501\nGid:\t20\t20\t20\t20\nGroups:\t${groups}\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n`;
const baseEnv = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "NODE_VERSION=24.22.1", "YARN_VERSION=1.22.22"];
const image = () => ({ Id: imageId, Os: "linux", Architecture: "amd64", RepoDigests: [containerContract.base], Config: { Env: baseEnv, OnBuild: null, Volumes: null, User: "", WorkingDir: "", Entrypoint: ["docker-entrypoint.sh"], Cmd: ["node"] } });
const plan = () => ({ image: imageId, identity: structuredClone(identity), imageEnv: [...baseEnv, "PNPM_HOME=/usr/local/share/pnpm"], nonce: hex, contextHash: other, nativeHash: hex });
const processResult = (stdout = "") => ({ code: 0, signal: null, closed: true, timedOut: false, interrupted: false, errors: [], remaining: [], observed: new Map(), stdout, stderr: "" });
const mount = (id, parentId, target, fs, device, options, root = "/", superOptions = ["rw"]) => ({ id, parentId, target, root, fs, device, options, superOptions, optional: [] });
const mounts = () => [
  mount(100, 99, "/", "overlay", "0:1", ["ro"]),
  mount(101, 100, "/task", "tmpfs", "0:2", ["rw", "noexec", "nosuid", "nodev"], "/", ["rw", "size=2097152k"]),
  mount(102, 100, "/proc", "proc", "0:3", ["rw", "nosuid", "nodev", "noexec"]),
  mount(103, 100, "/dev", "tmpfs", "0:4", ["rw", "nosuid"], "/", ["rw", "size=65536k", "mode=755"]),
  mount(104, 103, "/dev/pts", "devpts", "0:5", ["rw", "nosuid", "noexec"]),
  mount(105, 103, "/dev/shm", "tmpfs", "0:6", ["rw", "nosuid", "nodev", "noexec"], "/", ["rw", "size=65536k"]),
  mount(106, 103, "/dev/mqueue", "mqueue", "0:7", ["rw", "nosuid", "nodev", "noexec"]),
  mount(107, 100, "/sys", "sysfs", "0:8", ["ro", "nosuid", "nodev", "noexec"]),
  mount(108, 107, "/sys/fs/cgroup", "cgroup2", "0:9", ["ro", "nosuid", "nodev", "noexec"]),
  ...["resolv.conf", "hostname", "hosts"].map((name, i) => mount(109 + i, 100, `/etc/${name}`, "ext4", "8:1", ["ro"], `/volume/containers/${hex}/${name}`)),
  mount(112, 102, "/proc/bus", "proc", "0:3", ["ro", "nosuid", "nodev", "noexec"], "/bus"),
  mount(113, 102, "/proc/kcore", "tmpfs", "0:4", ["rw", "nosuid"], "/null", ["rw", "size=65536k", "mode=755"]),
  mount(114, 107, "/sys/firmware", "tmpfs", "0:10", ["ro"], "/", ["ro"]),
];
const container = () => ({ Id: hex, Image: imageId, State: { Status: "created", Pid: 0, Running: false, Dead: false, ExitCode: 0, OOMKilled: false, Error: "" }, Config: { Labels: { "org.openclaw.edge.nonce": hex, "org.openclaw.edge.context": other }, Entrypoint: [containerContract.reaper], Cmd: createArguments(plan(), "/owned/cid").slice(createArguments(plan(), "/owned/cid").indexOf(imageId) + 1), User: "501:20", WorkingDir: "/task", Env: plan().imageEnv, Volumes: null }, HostConfig: { NetworkMode: "none", PidMode: "", Tmpfs: { "/task": "rw,noexec,nosuid,nodev,size=2147483648,mode=0700,uid=501,gid=20" }, IpcMode: "private", CgroupnsMode: "private", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges=true"], Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 2000000000, PidsLimit: 128 }, Mounts: [] });
const native = () => ({ version: 3, reaper: {version:1,contextHash:other,source:{path:"/opt/edge-input/config/edge-proof/reaper.c",sha256:hex},buildSha256:hex,binary:{path:containerContract.reaper,sha256:hex}}, contextHash: other, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, install: { ...installInputs }, runtime: { node: "v24.22.1", abi: "137", platform: "linux", arch: "x64", pnpm: "11.28.4" }, containedLinks: 164, native: { node: { path: containerContract.node, sha256: hex }, git: { path: containerContract.git, sha256: hex }, typescript: { path: "/opt/edge-input/node_modules/.pnpm/ts/lib/tsc", sha256: hex }, esbuild: { path: "/opt/edge-input/node_modules/.pnpm/esbuild/bin/esbuild", sha256: hex }, wrangler: { path: "/opt/edge-input/node_modules/.pnpm/wrangler/wrangler-dist/cli.js", sha256: containerContract.cliHash } } });
const receipt = () => ({ version: 2, isolation: "private-container-pid-net-mount", nonce: hex, contextHash: other, nativeHash: hex, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, sourceFiles: 600, dependencyFiles: 268, exactErasures: 4, twoRoots: true, cliSha256: containerContract.cliHash, results: Object.fromEntries(["edge", "upstream"].map(kind => [kind, { code: 0, signal: null, closed: true, sha256: hex, observedProcesses: 1 }])), cloud: "UNRUN", sdk: "UNRUN", masks: [1, 1, 1, 1, 1, "UNOBSERVABLE"] });

test("parent identity includes real/effective/saved/filesystem columns with no arbitrary UID floor", () => {
  assert.deepEqual(parseIdentity(status("20 30")), identity);
  assert.equal(parseIdentity(status().replaceAll("501", "1").replaceAll("20", "2")).uid[0], 1);
  for (const text of [status().replace("501\t501\t501\t501", "501\t501\t501\t502"), status().replaceAll("501", "0"), status().replace("Groups:\t20", "Groups:\t20 20"), status().replace("501", "0501"), status() + "Uid:\t1 1 1 1\n"]) assert.throws(() => parseIdentity(text));
  assert.throws(() => validateIdentity(parseIdentity(status()), identity));
  assert.doesNotThrow(() => validateIdentity(parseIdentity(status()), identity, true));
  assert.throws(() => validateIdentity(parseIdentity(status("20 30")), identity, true));
  assert.throws(() => validateMapping("0 100000 65536\n", 501)); assert.throws(() => validateMapping("0 0 500\n", 501));
  assert.deepEqual(validateMapping("0 0 4294967295\n", 501), [[0, 0, 4294967295]]);
});
test("base and derived image validators reject inherited hooks, volumes, environment and identity drift", () => {
  validateImage(image());
  for (const change of [r => r.Id = "wrong", r => r.Architecture = "arm64", r => r.Config.OnBuild = ["RUN unsafe"], r => r.Config.Volumes = { "/host": {} }, r => r.Config.Env = [...baseEnv, "HTTP_PROXY=private"], r => r.Config.User = "10001", r => r.Config.Entrypoint = ["sh"], r => r.RepoDigests = []]) { const row = image(); change(row); assert.throws(() => validateImage(row)); }
  const derived = image(); Object.assign(derived.Config, { Env: plan().imageEnv, User: "501:20", WorkingDir: "/task", Entrypoint: [containerContract.reaper, containerContract.node, "/opt/edge-input/scripts/edge-proof.mjs", "container-init"], Cmd: [], Labels: { "org.openclaw.edge.context": other } });
  validateImage(derived, { derived: true, identity, id: imageId, contextHash: other });
  assert.throws(() => validateImage(derived, { derived: true, identity, id: "sha256:" + other, contextHash: other }));
  assert.throws(() => validateImage(derived, { derived: true, identity, id: imageId, contextHash: hex }));
});
test("native attestation is source, install, ABI and immutable absolute executable bound", () => {
  validateNativeIdentity(native(), plan());
  for (const change of [r => r.sourceSha = "0".repeat(40), r => r.contextHash = hex, r => r.install["package.json"] = hex, r => r.runtime.abi = "147", r => r.runtime.platform = "darwin", r => r.runtime.pnpm = "12", r => r.native.git.path = "git", r => r.native.git.path = "/opt/git", r => r.native.esbuild.path = "/task/esbuild", r => r.native.typescript.path = "/opt/edge-input/node_modules/.pnpm/../outside", r => r.native.wrangler.sha256 = hex, r => r.containedLinks = 0]) { const row = native(); change(row); assert.throws(() => validateNativeIdentity(row, plan())); }
  assert.deepEqual(parseImageBuildReceipt("EDGE_IMAGE_V2 " + JSON.stringify(native()) + "\n", other), native());
  assert.throws(() => parseImageBuildReceipt("", other));
  assert.throws(() => parseImageBuildReceipt(("EDGE_IMAGE_V2 " + JSON.stringify(native()) + "\n").repeat(2), other));
});
test("actual Git seam rejects relative, missing, unattested binary and environment overrides", async () => {
  const path = await realpath("/usr/bin/git");
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const valid = { executable: path, sha256, env: { ...frozenGitEnvironment } };
  assert.equal(validateGitExecutable(valid).executable, path);
  for (const options of [{ ...valid, executable: "git" }, { ...valid, executable: "/missing-edge-git" }, { ...valid, sha256: "0".repeat(64) }, { ...valid, env: { ...valid.env, PATH: "/untrusted" } }, { ...valid, env: { ...valid.env, GIT_CONFIG_GLOBAL: "/untrusted" } }, { ...valid, extra: true }]) assert.throws(() => validateGitExecutable(options));
  let accessed = false; const hostile = { ...valid }; Object.defineProperty(hostile, "env", { get() { accessed = true; return valid.env; } });
  assert.throws(() => validateGitExecutable(hostile)); assert.equal(accessed, false);
  const files = frozenSource(process.cwd(), edgeProof.sourceSha, valid);
  assert.equal(files.length, 600); assert.ok(files.every(row => row.sha256 === createHash("sha256").update(row.bytes).digest("hex")));
  assert.throws(() => frozenSource(process.cwd(), edgeProof.sourceSha, { ...valid, sha256: "0".repeat(64) }));
});
test("create argument arrays use only exact owned identity and private resource limits", () => {
  const args = createArguments(plan(), "/owned/cid");
  assert.ok(args.includes("501:20") && args.includes("--network=none") && args.includes("--cap-drop=ALL"));
  assert.equal(args.some(arg => arg.startsWith("--pid=")), false);
  assert.ok(args.includes("/task:rw,noexec,nosuid,nodev,size=2147483648,mode=0700,uid=501,gid=20"));
  assert.ok(!args.some(arg => /privileged|hostnetwork|userns|docker.sock|10001/.test(arg)));
  for (const extra of ["TOKEN", "HTTPS_PROXY", "GITHUB_TOKEN", "NODE_OPTIONS"]) assert.ok(!Object.hasOwn(dockerEnvironment("/owned"), extra) && !Object.hasOwn(containerEnvironment(), extra));
  assert.throws(() => containerEnvironment("/host")); assert.throws(() => createArguments({ ...plan(), image: "tag:latest" }, "/owned/cid"));
});
test("actual create inspection rejects foreign CID, image, command, mounts, groups, capabilities and env", () => {
  validateContainerInspect(container(), plan(), hex);
  for (const change of [r => r.Id = other, r => r.Image = "sha256:" + other, r => r.Config.Labels["org.openclaw.edge.nonce"] = other, r => r.Config.Cmd.push("extra"), r => r.HostConfig.NetworkMode = "host", r => r.HostConfig.PidMode = "host", r => r.HostConfig.PidMode = "private", r => r.HostConfig.Tmpfs = {}, r => r.HostConfig.Tmpfs["/task"] = "rw,exec", r => r.HostConfig.Tmpfs["/extra"] = "rw", r => r.HostConfig.MemorySwap = -1, r => r.HostConfig.ReadonlyRootfs = false, r => r.HostConfig.CapAdd = ["SYS_ADMIN"], r => r.HostConfig.GroupAdd = ["30"], r => r.HostConfig.Binds = ["/host:/host"], r => r.Mounts.push({ Type: "bind", Destination: "/secret" }), r => r.Config.Env.push("TOKEN=private"), r => r.Config.User = "0:0"]) { const row = container(); change(row); assert.throws(() => validateContainerInspect(row, plan(), hex)); }
});
test("host-observed process evidence requires fs IDs, mapping, namespace separation and strict mounts", () => {
  const parent = { pid: "pid:[1]", net: "net:[2]", mnt: "mnt:[3]", user: "user:[4]" };
  const target = { status: status(), uidMap: "0 0 4294967295\n", gidMap: "0 0 4294967295\n", namespaces: { pid: "pid:[5]", net: "net:[6]", mnt: "mnt:[7]", user: "user:[4]" }, mounts: mounts() };
  validateTarget(target, parent, identity);
  for (const change of [r => r.status = r.status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001"), r => r.status = r.status.replace("Seccomp:\t2", "Seccomp:\t0"), r => r.status = undefined, r => r.uidMap = "0 100000 65536", r => r.namespaces.user = "user:[9]", r => r.namespaces.net = parent.net, r => r.mounts[0].options = ["rw"], r => r.mounts[1].options = ["rw"], r => r.mounts.push({ target: "/host", options: ["ro"] })]) { const row = structuredClone(target); change(row); assert.throws(() => validateTarget(row, parent, identity)); }
  validateChildStatus(status(), identity);
  assert.throws(() => parseMounts("1 0 1:1 / / rw shared:2 - overlay overlay rw\n"));
  assert.throws(() => validateMounts(mounts().slice(1)));
});
test("owned cgroup path and effective limits cannot be inferred from a name or Docker label", () => {
  assert.equal(cgroupPath(`0::/system.slice/docker-${hex}.scope\n`, hex), `/sys/fs/cgroup/system.slice/docker-${hex}.scope`);
  for (const text of [`0::/other/${other}`, `0::/../${hex}`, `1:cpu:/${hex}`, `0::/${hex}\n0::/other`]) assert.throws(() => cgroupPath(text, hex));
  const valid = { memory: "4294967296", swap: "0", pids: "128", cpu: "200000 100000" }; validateLimits(valid);
  for (const key of Object.keys(valid)) assert.throws(() => validateLimits({ ...valid, [key]: "max" }));
});
test("nonce-bound READY rejects replay, malformed, foreign and getter protocols", () => {
  const line = "EDGE_CONTAINER_V2 " + JSON.stringify({ v: 2, kind: "ready", nonce: hex, contextHash: other }) + "\n";
  parseControl(line, "ready", hex, other);
  for (const text of [line.repeat(2), line.replace(hex, other), line.replace("ready", "permit"), line.slice(0, -1), "private\n", line.replace('"v":2', '"v":2,"extra":true')]) assert.throws(() => parseControl(text, "ready", hex, other));
});
test("terminal proof distinguishes Docker wait CLI zero from container failure and preserves cgroup unknown", () => {
  const valid = { wait: processResult("0\n"), attached: processResult(), inspect: container(), cgroup: "removed", receipt: receipt() }; validateTerminal(valid);
  for (const change of [r => r.wait.stdout = "1\n", r => r.wait.code = 1, r => r.attached.signal = "SIGTERM", r => r.attached.timedOut = true, r => r.attached.errors = [undefined], r => r.inspect.State.OOMKilled = true, r => r.inspect.State.Running = true, r => r.inspect.State.ExitCode = 1, r => r.cgroup = "unknown", r => r.cgroup = "populated", r => r.receipt = undefined]) { const row = structuredClone(valid); change(row); assert.throws(() => validateTerminal(row)); }
  const text = "EDGE_CONTAINER_RECEIPT_V2 " + JSON.stringify(receipt()) + "\n"; parseContainerReceipt(text, plan());
  for (const text of ["", "EDGE_CONTAINER_RECEIPT_V2 " + JSON.stringify({ ...receipt(), nonce: other }), "EDGE_CONTAINER_RECEIPT_V2 " + JSON.stringify({ ...receipt(), exactErasures: 3 })]) assert.throws(() => parseContainerReceipt(text, plan()));
});
function fakeChild(onEnd = () => {}) {
  const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, callback) { onEnd(chunk.toString()); callback(); } }); return child;
}
test("actual attach helper waits for original close and rejects repeated READY without hiding undefined cleanup", async () => {
  const child = fakeChild(), signals = new EventEmitter(); let stop = 0;
  const attached = attachContainer("synthetic", [], { nonce: hex, contextHash: other, spawnProcess: () => child, signalSource: signals, onStop: async () => { stop++; throw undefined; }, killGroup: () => child.emit("close", null, "SIGKILL") });
  const frame = "EDGE_CONTAINER_V2 " + JSON.stringify({ v: 2, kind: "ready", nonce: hex, contextHash: other }) + "\n";
  child.stdout.write(frame); await attached.ready; await attached.permit(); assert.equal(attached.result.closed, false);
  child.stdout.write(frame); const result = await attached.closed;
  assert.equal(stop, 1); assert.ok(result.errors.includes(undefined)); assert.equal(result.signal, "SIGKILL");
  assert.throws(() => validateTerminal({ wait: processResult("0"), attached: result, inspect: container(), cgroup: "empty", receipt: receipt() }));
});
test("original attach failure, missing entry, timeout and interrupts always stop the owned resource", async () => {
  for (const kind of ["launch", "missing", "timeout", "signal"]) {
    const child = fakeChild(), signals = new EventEmitter(); let stops = 0;
    const attached = attachContainer("synthetic", [], { nonce: hex, contextHash: other, spawnProcess: () => { if (kind === "launch") throw undefined; return child; }, signalSource: signals, timeoutMs: 50, readyMs: 10, onStop: async () => { stops++; child.emit("close", 1, null); }, killGroup: () => {} });
    if (kind === "missing") child.emit("close", 1, null);
    if (kind === "signal") signals.emit("SIGTERM");
    await assert.rejects(attached.ready); const result = await attached.closed;
    assert.ok(!result.closed || result.code !== 0 || result.errors.length || result.timedOut || result.interrupted);
    if (["timeout", "signal"].includes(kind)) assert.equal(stops, 1);
  }
});
test("one actual nonSDK Node child exercises READY, original stdin write and original close", async () => {
  const ready = "EDGE_CONTAINER_V2 " + JSON.stringify({ v: 2, kind: "ready", nonce: hex, contextHash: other }) + "\n";
  const code = `process.stdout.write(${JSON.stringify(ready)});let s='';for await(const c of process.stdin)s+=c;process.exitCode=s.includes('"kind":"permit"')?0:1;`;
  const attached = attachContainer(process.execPath, ["--input-type=module", "-e", code], { env: { PATH: "/usr/bin:/bin" }, nonce: hex, contextHash: other, onStop: async () => { throw new Error("unexpected local child stop"); }, timeoutMs: 5000, readyMs: 3000 });
  await attached.ready; await attached.permit(); const result = await attached.closed;
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.closed, true); assert.deepEqual(result.errors, []);
});
test("bounded diagnostics never read getters or print private data and retain all original failures", () => {
  const row = { v: 2, phase: "admission", state: "rejected", defined: false, exit: null, signal: null }; validateContainerDiagnostic(row);
  let accessed = false; const bad = { ...row }; Object.defineProperty(bad, "phase", { get() { accessed = true; return "private"; } }); assert.throws(() => validateContainerDiagnostic(bad)); assert.equal(accessed, false);
  assert.throws(() => validateContainerDiagnostic({ ...row, message: "private" })); assert.throws(() => validateContainerDiagnostic(new Proxy({}, { ownKeys() { throw undefined; } })));
  const output = []; emitContainerFailure(["identity", "context", "daemon", "base", "image_build", "image", "create", "attach", "ready", "admission", "permit", "wait"].map(phase => ({ ...row, phase })), line => output.push(line));
  assert.equal(output.length, 10); assert.ok(output.every(line => line.startsWith("::error") && Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192); assert.match(output.at(-1), /"phase":"overflow"/);
  assert.throws(() => emitContainerFailure([row], () => { throw undefined; }));
  let caught = false; try { raiseContainerFailures([undefined]); } catch (error) { caught = true; assert.equal(error, undefined); } assert.equal(caught, true);
  assert.throws(() => raiseContainerFailures([undefined, null]), error => error instanceof AggregateError && error.errors[0] === undefined && error.errors[1] === null);
});
test("explicit context inventory is exactly the reviewed 23 paths plus frozen workspace closure", async () => {
  assert.equal(harnessInputs.length, 23); assert.equal(new Set(harnessInputs).size, 23);
  assert.deepEqual(Object.keys(installInputs), ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "admin/package.json"]);
  const dockerfile = await readFile(new URL("../config/edge-proof/Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes(containerContract.base)); assert.match(dockerfile, /USER \$\{HOST_UID\}:\$\{HOST_GID\}/); assert.match(dockerfile, /COPY --chown=\$\{HOST_UID\}:\$\{HOST_GID\} input\//);
  assert.doesNotMatch(dockerfile, /10001|FROM.*:latest|VOLUME|--mount=type=secret|safe.directory/);
});

test("parent proc denial preserves the original error and never substitutes child assertions", async () => {
  for (const reason of [undefined, Object.assign(new Error("fixture refusal"), { code: "EACCES" })]) {
    let caught = false;
    try { await processEvidence(12345, { read: async () => { throw reason; } }); } catch (error) { caught = true; assert.equal(error, reason); }
    assert.equal(caught, true);
  }
});
test("actual cgroup retirement refuses unqualified synthetic bindings", async () => {
  await assert.rejects(retiredCgroup({ path: "/synthetic/owned", dev: 1n, ino: 2n, parentDev: 1n, parentIno: 1n }));
});

function metadataMounts() {
  const daemonRoot = "/var/lib/docker", source = {}, target = [];
  for (const [i, [key, name]] of [["ResolvConfPath", "resolv.conf"], ["HostnamePath", "hostname"], ["HostsPath", "hosts"]].entries()) {
    source[key] = `${daemonRoot}/containers/${hex}/${name}`;
    target.push(mount(100 + i, 99, `/etc/${name}`, "ext4", "8:1", ["ro"], `/volume/containers/${hex}/${name}`));
  }
  const parent = [mount(1, 0, "/", "ext4", "8:0", ["rw"]), mount(2, 1, daemonRoot, "ext4", "8:1", ["rw"], "/volume")];
  return { daemonRoot, source, target, parent };
}
const validateMetadata = row => validateMetadataMounts(row.source, row.target, row.parent, row.daemonRoot, hex);
test("Docker metadata mounts bind exact CID and resolved kernel roots without private-storage stat", () => {
  const valid = metadataMounts(), frozen = validateMetadata(valid);
  assert.equal(frozen.length, 3); assert.equal(frozen[0].parent[0].id, 2); assert.equal(frozen[0].target.id, 100);
  for (const change of [r => r.source.HostsPath = `/var/lib/docker/containers/${other}/hosts`, r => r.source.HostsPath += "/../hosts", r => r.target[0].device = "8:9", r => r.target[0].root = "/resolved-symlink/foreign", r => r.target[0].fs = "xfs", r => r.target[0].options = ["rw"], r => r.target.pop(), r => r.parent.push({ ...r.parent[1], id: 3 }), r => r.parent[1].root = "/changed-volume", r => r.parent = [], r => r.parent[1].target += "-foreign", r => r.parent[1].fs = "overlay", r => { r.parent[1].fs = "overlay"; r.target.forEach(m => m.fs = "overlay"); }, r => r.daemonRoot += "/..", r => r.target[0].root += "/../resolv.conf", r => r.parent[1].root = "/volume//", r => r.target.push({ ...r.target[0], id: 103 })]) {
    const row = structuredClone(valid); change(row); assert.throws(() => validateMetadata(row));
  }
  // Exact component boundaries: the longer foreign prefix is not selected.
  const collision = structuredClone(valid); collision.parent.push(mount(3, 1, "/var/lib/docker-extra", "xfs", "8:8", ["rw"]));
  assert.deepEqual(validateMetadata(collision), frozen);
  const mapped = structuredClone(valid); mapped.parent[1].fs = "xfs"; mapped.target.forEach(row => row.fs = "xfs"); assert.equal(validateMetadata(mapped).length, 3);
});
test("mountinfo decodes only kernel escapes and rejects ambiguous or noncanonical paths and IDs", () => {
  const line = "1 0 8:1 /volume /var/lib/docker rw shared:1 - ext4 /dev/source rw\n";
  const parsed = parseMounts(line, false); assert.equal(parsed[0].id, 1); assert.equal(parsed[0].parentId, 0); assert.equal(parsed[0].root, "/volume");
  assert.throws(() => parseMounts(line));
  assert.equal(parseMounts(line.replace("/volume", String.raw`/a\040b\134c`), false)[0].root, "/a b\\c");
  for (const path of [String.raw`/a\000b`, String.raw`/a\041b`, String.raw`/a\1340\999`, "/a\\", String.raw`/a\011b`, String.raw`/a\012b`, "/a/../b", "/a/./b", "/a//b", "/a/", "/a\0b", "relative"]) assert.throws(() => parseMounts(line.replace("/volume", path), false));
  for (const invalid of [line.replace("1 0", "01 0"), line.replace("1 0", "1 -1"), line.replace("8:1", "08:1"), line.replace(" rw shared", " ro,rw shared"), line.replace("ext4 /dev/source rw", "ext4 /dev/source"), line + line.replace("1 0", "2 0"), line + line.replace("/var/lib/docker", "/other")]) assert.throws(() => parseMounts(invalid, false));
});
test("mount observations freeze separate namespace IDs, parent IDs and complete selected tuples", () => {
  const valid = metadataMounts(), frozen = validateMetadata(valid);
  for (const change of [r => r.parent[1].id++, r => r.parent[1].parentId++, r => r.parent[0].id = 9, r => r.target[0].id += 10, r => r.target[0].parentId++, r => r.parent[1].optional.push("shared:2"), r => r.target[0].options.push("noexec")]) {
    const row = structuredClone(valid); change(row); assert.notDeepEqual(validateMetadata(row), frozen);
  }
  const initial = mounts(); validateMountFreshness(initial, [...structuredClone(initial)].reverse());
  for (const change of [r => r[1].id += 100, r => r[1].parentId++, r => r[1].device = "0:99", r => r[1].root = "/replacement", r => r[1].fs = "ext4", r => r[1].options.push("relatime"), r => r[1].superOptions.push("mode=700")]) {
    const row = structuredClone(initial); change(row); assert.throws(() => validateMountFreshness(initial, row));
  }
});
test("automatic mount admission rejects foreign writable filesystems, roots, devices and masks", () => {
  validateMounts(mounts());
  for (const [path, mutate] of [
    ["/dev/shm", r => r.fs = "ext4"], ["/dev/shm", r => r.device = "8:1"], ["/dev/shm", r => r.superOptions = ["rw", "size=2097152k"]],
    ["/dev", r => r.fs = "ext4"], ["/dev", r => r.options = ["rw"]], ["/dev/pts", r => r.fs = "tmpfs"], ["/dev/pts", r => r.root = "/foreign"], ["/dev/pts", r => r.parentId = 100],
    ["/dev/mqueue", r => r.fs = "ext4"], ["/dev/mqueue", r => r.options = ["rw", "nosuid", "nodev"]],
    ["/sys", r => r.fs = "tmpfs"], ["/sys/fs/cgroup", r => r.options = ["rw", "nosuid", "noexec", "nodev"]],
    ["/proc/bus", r => r.root = "/sys"], ["/proc/bus", r => r.device = "0:99"], ["/proc/bus", r => r.options = ["rw", "nosuid", "nodev", "noexec"]],
    ["/proc/kcore", r => r.fs = "ext4"], ["/proc/kcore", r => r.root = "/foreign"], ["/proc/kcore", r => r.device = "0:99"], ["/proc/kcore", r => r.options = ["rw"]],
    ["/sys/firmware", r => r.options = ["rw"]], ["/sys/firmware", r => r.fs = "ext4"], ["/sys/firmware", r => r.device = "0:4"],
    ["/task", r => r.root = "/foreign"], ["/task", r => r.device = "0:4"], ["/task", r => r.superOptions = ["rw", "size=1024k"]],
  ]) { const rows = mounts(); mutate(rows.find(row => row.target === path)); assert.throws(() => validateMounts(rows), path); }
  for (const row of [mount(120, 100, "/extra", "tmpfs", "0:20", ["rw"]), mount(120, 103, "/dev/shm", "tmpfs", "0:20", ["rw"])]) assert.throws(() => validateMounts([...mounts(), row]));
  const thermal = mount(120, 107, "/sys/devices/system/cpu/cpu0/thermal_throttle", "tmpfs", "0:20", ["ro"], "/", ["ro"]);
  validateMounts([...mounts(), thermal]); assert.throws(() => validateMounts([...mounts(), { ...thermal, options: ["rw"] }]));
  // Docker /dev is executable and permits devices; readonly directory masks
  // need not inherit /dev's flags. Neither exception admits an arbitrary fs.
  assert.equal(mounts().find(row => row.target === "/dev").options.includes("noexec"), false);
});

function cliOptions(run, extra = {}) {
  const output = [], stderr = [], exits = [], events = new EventEmitter();
  return { output, stderr, exits, events, run, writer: line => output.push(line), errorWriter: line => stderr.push(line), setExit: code => exits.push(code), ...extra };
}
test("CLI original execution, serialization and error ownership preserve undefined and independent reporting failures", async () => {
  let calls = 0;
  const ok = cliOptions(async () => { calls++; return { ok: true }; });
  const success = launchCli(["container-ci"], ok); await success.completion;
  assert.equal(calls, 1); assert.deepEqual(ok.output, ['{"ok":true}\n']); assert.deepEqual(ok.exits, []); assert.equal(ok.events.listenerCount("beforeExit"), 0);
  for (const reason of [new Error("private fixture error"), undefined]) {
    const options = cliOptions(async () => { throw reason; }), state = launchCli(["container-ci"], options);
    await assert.rejects(state.completion, error => error === reason);
    assert.deepEqual(state.errors, [reason]); assert.deepEqual(options.exits, [1]); assert.equal(options.events.listenerCount("beforeExit"), 0);
    assert.ok(state.records.some(row => row.phase === "entry" && row.state === "rejected" && row.defined === (reason !== undefined)));
    assert.ok(options.output.every(line => line.startsWith("::error title=Edge container boundary::") && !line.includes("private fixture error")));
  }
  const serializationReason = new Error("private serialization");
  const serial = cliOptions(async () => ({ toJSON() { throw serializationReason; } }));
  const serialized = launchCli(["container-ci"], serial); await assert.rejects(serialized.completion, error => error === serializationReason);
  assert.ok(serialized.records.some(row => row.phase === "serialization" && row.state === "rejected")); assert.ok(!serial.output.join("").includes("private serialization"));
  const reportingReason = new Error("private stderr refusal");
  const failed = cliOptions(async () => { throw undefined; }, { writer() { throw undefined; }, errorWriter() { throw reportingReason; } });
  const state = launchCli(["container-ci"], failed);
  await assert.rejects(state.completion, error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === undefined && error.errors[1] === undefined && error.errors[2] === reportingReason);
  assert.equal(state.errors.length, 3); assert.equal(state.records.filter(row => row.phase === "reporting" && row.state === "rejected").length, 2);
  const old = cliOptions(async () => { throw undefined; }); const legacy = launchCli(["offline-ci"], old);
  await assert.rejects(legacy.completion, error => error === undefined); assert.deepEqual(old.output, []); assert.equal(old.stderr.length, 1);
});
test("CLI pending sentinel owns one listener, cannot emit success later, and never resolves original work", async () => {
  let resolveOriginal, calls = 0;
  const original = new Promise(resolve => { resolveOriginal = resolve; });
  const options = cliOptions(() => { calls++; return original; }), state = launchCli(["container-ci"], options);
  options.events.emit("beforeExit"); options.events.emit("beforeExit");
  assert.deepEqual(options.exits, [13]); assert.equal(calls, 1); assert.equal(options.events.listenerCount("beforeExit"), 0);
  assert.ok(state.records.some(row => row.phase === "pending" && row.state === "rejected"));
  const count = options.output.length; resolveOriginal({ forbiddenSuccess: true });
  await assert.rejects(state.completion); assert.equal(options.output.length, count); assert.ok(!options.output.join("").includes("forbiddenSuccess"));
});
test("CLI shared startup diagnostics reject unknown phases before operations and share one annotation budget", async () => {
  const report = createContainerDiagnostics(); let invoked = false;
  assert.throws(() => report.sync("foreign", () => { invoked = true; }));
  await assert.rejects(report.step("foreign", () => { invoked = true; })); assert.equal(invoked, false);
  const options = cliOptions(async (args, shared) => {
    for (const phase of ["module_import", "dispatch", "host_runtime", "identity", "parent_namespaces", "cwd", "temp", "environment", "docker_executable"]) shared.sync(phase, () => {});
    return shared.step("daemon_socket", () => { throw undefined; });
  });
  const state = launchCli(["container-ci"], options); await assert.rejects(state.completion, error => error === undefined);
  assert.equal(options.output.length, 10); assert.ok(options.output.every(line => line.startsWith("::error") && Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(options.output.join("")) <= 8192);
  assert.match(options.output[0], /"phase":"daemon_socket","state":"rejected","defined":false/); assert.match(options.output.at(-1), /"phase":"overflow"/);
});
async function pureCliModuleSources() {
  const entry = await readFile(new URL("../scripts/edge-proof.mjs", import.meta.url), "utf8"), container = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const backImport = container.split("\n").find(line => line.startsWith("import { runOwnedProcess,"));
  const names = backImport.split("{", 2)[1].split("}", 1)[0].trim().split(", ");
  const tail = entry.slice(entry.indexOf("const containerDiagnosticPhases ="));
  assert.ok(tail.includes('launchCli(process.argv.slice(2));'));
  const pureHelpers = names.filter(name => !["createContainerDiagnostics", "emitContainerFailure", "imageBuildStages", "nativePrepareStages", "validateEnumerationDetail"].includes(name)).map(name => `export const ${name} = undefined;`).join("\n");
  // Actual dispatch and CLI functions, including their back-import. Only the
  // container operation is replaced by a closed, inert return value.
  const prefix = 'import { pathToFileURL } from "node:url"; import { resolve } from "node:path";\n' + pureHelpers + '\nconst refuse = code => { throw new Error(code); };\n' + entry.slice(entry.indexOf("function ownData("), entry.indexOf("export function validatePackagingDiagnostic("));
  const operation = 'let calls = 0; const harmless = () => ({ dispatchCalls: ++calls }); const containerCi = harmless, containerInit = harmless, containerBuild = harmless, containerPrepare = harmless; const fail = () => { throw undefined; };\n';
  return { entry: prefix + tail, container: backImport + "\n" + operation + container.slice(container.indexOf("export async function containerMain(")) };
}
function runPureCli(sources, { old = false, imported = false, pending = false, moduleFailure = false } = {}) {
  let entry = sources.entry;
  if (old) entry = entry.replace('launchCli(process.argv.slice(2));', 'try { console.log(JSON.stringify(await main(process.argv.slice(2)))); } catch { process.exitCode = 1; }');
  const container = pending ? sources.container.replace('let calls = 0; const harmless = () => ({ dispatchCalls: ++calls });', 'const harmless = () => new Promise(() => {});') : sources.container;
  const modules = { 'file:///__edge_cli__/edge-proof.mjs': entry, 'file:///__edge_cli__/edge-proof-container.mjs': moduleFailure ? 'throw undefined;' : container };
  if (imported) modules['file:///__edge_cli__/importer.mjs'] = 'import "./edge-proof.mjs"; process.stdout.write("imported-only\\n");';
  const hook = 'import { registerHooks } from "node:module"; const modules=' + JSON.stringify(modules) + '; registerHooks({resolve(s,c,n){const u=s.startsWith("/")?"file://"+s:s.startsWith("./")&&c.parentURL?.startsWith("file:///__edge_cli__/")?new URL(s,c.parentURL).href:s;return Object.hasOwn(modules,u)?{url:u,shortCircuit:true}:n(s,c);},load(u,c,n){return Object.hasOwn(modules,u)?{format:"module",source:modules[u],shortCircuit:true}:n(u,c);}});';
  return spawnSync(process.execPath, ['--import', 'data:text/javascript;base64,' + Buffer.from(hook).toString('base64'), imported ? '/__edge_cli__/importer.mjs' : '/__edge_cli__/edge-proof.mjs', 'container-ci'], { env: { PATH: '/usr/bin:/bin', NO_COLOR: '1' }, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
}
test("CLI actual extracted module-loader cycle fails old TLA and dispatches exactly once after repair", async () => {
  const sources = await pureCliModuleSources();
  const old = runPureCli(sources, { old: true }); assert.equal(old.error, undefined); assert.equal(old.status, 13); assert.equal(old.stdout, "");
  const current = runPureCli(sources); assert.equal(current.error, undefined); assert.equal(current.status, 0); assert.equal(current.signal, null); assert.deepEqual(JSON.parse(current.stdout), { dispatchCalls: 1 }); assert.equal(current.stderr, "");
  const imported = runPureCli(sources, { imported: true }); assert.equal(imported.error, undefined); assert.equal(imported.status, 0); assert.equal(imported.stdout, "imported-only\n"); assert.equal(imported.stderr, "");
  const pending = runPureCli(sources, { pending: true }); assert.equal(pending.error, undefined); assert.equal(pending.status, 13); assert.match(pending.stdout, /"phase":"pending","state":"rejected"/); assert.doesNotMatch(pending.stdout, /dispatchCalls/);
  const failedImport = runPureCli(sources, { moduleFailure: true }); assert.equal(failedImport.error, undefined); assert.equal(failedImport.status, 1); assert.match(failedImport.stdout, /"phase":"module_import","state":"rejected","defined":false/);
});

test("CLI actual extracted host startup records each boundary before the original operation", async () => {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const prefix = source.slice(source.indexOf("async function hostContainerRun(report) {"), source.indexOf("  const run = async (args, timeoutMs = 30000) => {", source.indexOf("async function hostContainerRun(report) {")));
  const names = ["process", "check", "readParentIdentity", "namespaceIdentity", "realpath", "mkdtemp", "join", "tmpdir", "dockerEnvironment", "mkdir", "fileIdentity", "stat"];
  const create = new Function(...names, `return ${prefix}return { identity, parentNamespaces, cwd, root, env, docker }; };`);
  for (const failedPhase of [null, "parent_namespaces", "temp", "environment", "docker_executable", "daemon_socket"]) {
    const report = createContainerDiagnostics(), seen = [];
    const original = (phase, value) => (...args) => { assert.equal(report.records.at(-1).phase, phase); assert.equal(report.records.at(-1).state, "entered"); seen.push(phase); if (phase === failedPhase) throw undefined; return typeof value === "function" ? value(...args) : value; };
    const startup = create({ platform: "linux", arch: "x64", version: "v24.22.1", versions: { modules: "137" }, cwd: () => "/synthetic" }, (value) => assert.ok(value), original("identity", identity), original("parent_namespaces", {}), path => original(path === "/synthetic" ? "cwd" : "daemon_socket", path)(), original("temp", "/synthetic/task"), (...parts) => parts.join("/"), () => "/synthetic", original("environment", { HOME: "/synthetic/home", DOCKER_CONFIG: "/synthetic/config" }), original("environment", undefined), original("docker_executable", { path: "/usr/bin/docker" }), original("daemon_socket", { isSocket: () => true }));
    if (failedPhase) {
      await assert.rejects(startup(report), error => error === undefined);
      assert.equal(report.records.at(-1).phase, failedPhase); assert.equal(report.records.at(-1).state, "rejected"); assert.equal(report.records.at(-1).defined, false);
      assert.equal(seen.at(-1), failedPhase);
    } else {
      const result = await startup(report); assert.equal(result.docker, "/usr/bin/docker");
      assert.deepEqual(report.records.filter(row => row.state === "entered").map(row => row.phase), ["host_runtime", "identity", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket"]);
    }
  }
});

test("image build diagnostics preserve original Node exits, signals, timeout and capture closure", async () => {
  const env = { PATH: "/usr/bin:/bin", NO_COLOR: "1" };
  for (const [code, expected] of [
    ['process.stdout.write("owned-child\\n");process.stderr.write("owned-stderr\\n");', { exit: 0, signal: null, timedOut: false }],
    ['process.exitCode=23;', { exit: 23, signal: null, timedOut: false }],
    ['process.kill(process.pid,"SIGTERM");', { exit: null, signal: "SIGTERM", timedOut: false }],
    ['setInterval(()=>{},1000);', { exit: null, signal: "SIGTERM", timedOut: true }],
  ]) {
    const original = await runOwnedProcess(process.execPath, ["-e", code], { env, timeoutMs: expected.timedOut ? 1000 : 5000 });
    const report = createContainerDiagnostics(); let reads = 0;
    const operation = observeImageBuild(() => original, () => { reads++; return imageId; }, () => native(), report);
    if (expected.exit === 0) assert.equal((await operation).imageId, imageId); else await assert.rejects(operation);
    const row = report.records[0]; validateContainerDiagnostic(row);
    assert.equal(row.exit, original.code); assert.equal(row.signal, original.signal); assert.equal(row.timedOut, original.timedOut);
    assert.equal(row.exit, expected.exit); assert.equal(row.signal, expected.signal); assert.equal(row.timedOut, expected.timedOut);
    assert.equal(row.closed, true); assert.equal(row.interrupted, false); assert.equal(row.stdoutComplete, true); assert.equal(row.stderrComplete, true);
    assert.equal(row.errors, 0); assert.equal(row.spawnErrors, 0); assert.equal(reads, expected.exit === 0 ? 1 : 0);
    assert.deepEqual(original.remaining, []); assert.equal(original.errors.length, 0);
  }
});
test("image build diagnostics distinguish all three original suboperations without changing their outcomes", async () => {
  const reason = new Error("private fixture failure");
  for (const phase of ["image_build", "image_id", "native_receipt", "success"]) {
    const report = createContainerDiagnostics(), calls = [], original = { ...processResult("receipt"), spawnErrors: [] };
    if (phase === "image_build") original.code = 19;
    const work = report.step("image_build", () => observeImageBuild(() => { calls.push("process"); return original; }, () => {
      calls.push("id"); if (phase === "image_id") throw undefined; return imageId;
    }, stdout => { calls.push("receipt"); assert.equal(stdout, original.stdout); if (phase === "native_receipt") throw reason; return native(); }, report));
    if (phase === "success") assert.deepEqual(await work, { imageId, native: native() });
    else await assert.rejects(work, error => phase === "image_build" ? error instanceof AggregateError : error === (phase === "image_id" ? undefined : reason));
    assert.deepEqual(calls, phase === "image_build" ? ["process"] : phase === "image_id" ? ["process", "id"] : ["process", "id", "receipt"]);
    const rejected = report.records.filter(row => row.state === "rejected");
    assert.equal(rejected[0]?.phase, phase === "success" ? undefined : phase);
    assert.equal(report.records.find(row => row.v === 3).exit, original.code);
    if (phase === "image_id") assert.equal(rejected[0].defined, false);
  }
});
test("image build diagnostics retain undefined spawn and operation failures plus independent reporting failures", async () => {
  const original = await runOwnedProcess("unused", [], { spawnProcess() { throw undefined; } });
  const row = containerProcessDiagnostic(original);
  assert.equal(row.errors, 1); assert.equal(row.undefinedErrors, 1); assert.equal(row.spawnErrors, 1); assert.equal(row.undefinedSpawnErrors, 1); assert.equal(row.closed, false);
  assert.deepEqual(original.errors, [undefined]); assert.deepEqual(original.spawnErrors, [undefined]);
  const observerError = new Error("private observer failure");
  const report = { process() { throw observerError; }, internal() {}, mark() { throw new Error("must not reach ID"); } };
  await assert.rejects(observeImageBuild(() => { throw undefined; }, () => {}, () => {}, report), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === undefined && error.errors[1] === observerError);
  await assert.rejects(observeImageBuild(() => original, () => {}, () => {}, report), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] instanceof AggregateError && error.errors[0].errors.includes(undefined) && error.errors[1] === observerError);
  await assert.rejects(observeImageBuild(() => processResult(), () => {}, () => {}, report), error => error === observerError);
  const failed = createContainerDiagnostics();
  await assert.rejects(observeImageBuild(() => { throw undefined; }, () => {}, () => {}, failed), error => error === undefined);
  assert.equal(failed.records[0].available, false); assert.equal(failed.records[0].defined, false); assert.equal(failed.records[0].exit, null);
  for (const phase of ["image_id", "native_receipt"]) {
    const recording = createContainerDiagnostics(), mark = recording.mark;
    recording.mark = (name, state, reason) => { if (state === "rejected") throw observerError; mark(name, state, reason); };
    await assert.rejects(observeImageBuild(() => processResult(), () => { if (phase === "image_id") throw undefined; return imageId; }, () => { throw undefined; }, recording), error => error instanceof AggregateError && error.errors[0] === undefined && error.errors[1] === observerError);
  }
});
test("image build process schema preserves unknowns and rejects getters, counts and extra payload", () => {
  const row = containerProcessDiagnostic(processResult());
  assert.equal(row.spawnErrors, null); assert.equal(row.stdoutComplete, null); assert.equal(row.stderrComplete, null);
  assert.equal(containerProcessDiagnostic({ ...processResult(), code: -2 }).exit, -2);
  for (const change of [r => r.phase = "image", r => r.available = false, r => r.exit = 2147483648, r => r.errors = -1, r => r.undefinedErrors = 1, r => r.closed = "unknown", r => r.signal = "foreign", r => r.stdout = "private"]) {
    const invalid = { ...row }; change(invalid); assert.throws(() => validateContainerDiagnostic(invalid));
  }
  let accessed = false; const hostile = { ...processResult() }; Object.defineProperty(hostile, "code", { get() { accessed = true; return 0; } });
  assert.throws(() => containerProcessDiagnostic(hostile)); assert.equal(accessed, false);
  const absent = containerProcessDiagnostic(undefined, false, undefined); assert.equal(absent.defined, false);
  assert.throws(() => validateContainerDiagnostic({ ...absent, closed: false }));
});
test("image build failure packet reserves terminal and original process facts before overflow", () => {
  const phases = ["entry", "module_import", "dispatch", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket", "identity", "context", "daemon", "base"];
  const rows = phases.map(phase => ({ v: 2, phase, state: "fulfilled", defined: null, exit: null, signal: null }));
  const process = containerProcessDiagnostic({ ...processResult(), code: 23, spawnErrors: [] });
  const terminal = { v: 2, phase: "image_build", state: "rejected", defined: true, exit: null, signal: null };
  const output = []; emitContainerFailure([...rows, process, terminal, { ...terminal, phase: "entry" }, ...rows], line => output.push(line));
  const packet = output.map(line => validateContainerDiagnostic(JSON.parse(line.slice(line.indexOf("::", 2) + 2))));
  assert.deepEqual(packet.slice(0, 2), [terminal, process]); assert.equal(packet.length, 10); assert.equal(packet.at(-1).exit, new Set([...phases, "image_build_process", "image_build"]).size - 9);
  assert.ok(output.every(line => line.startsWith("::error") && Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192);
  assert.equal(packet[1].exit, 23); assert.notEqual(packet.at(-1).phase, "image_build_process");
  assert.throws(() => emitContainerFailure([terminal, process], () => { throw undefined; }), error => error === undefined);
  const maximum = { ...process, exit: 2147483647, errors: Number.MAX_SAFE_INTEGER, undefinedErrors: Number.MAX_SAFE_INTEGER, spawnErrors: Number.MAX_SAFE_INTEGER, undefinedSpawnErrors: Number.MAX_SAFE_INTEGER };
  const capped = []; emitContainerFailure([terminal, maximum], line => capped.push(line)); assert.ok(capped.every(line => Buffer.byteLength(line) <= 768));
});

async function actualStageShells() {
  const file = await readFile(new URL("../config/edge-proof/Dockerfile", import.meta.url), "utf8");
  const runs = file.replace(/\\\n\s*/g, " ").split("\n").filter(line => line.startsWith("RUN "));
  assert.equal(runs.length, 2); assert.ok(!file.includes("EDGE_BUILD_STAGE_V1 "));
  const first = runs[0].slice(4, runs[0].indexOf("node_version()"));
  const second = runs[1].slice(4, runs[1].indexOf("frozen_install()"));
  assert.equal(first.replace("edge_seq=0", "edge_seq=16"), second);
  assert.match(runs[0], /node_version\(\) \{ test "\$\(\/usr\/local\/bin\/node --version\)" = v24\.22\.1; \}/);
  assert.match(runs[0], /pnpm_bootstrap\(\) \{ \/usr\/local\/bin\/npm install --global --ignore-scripts pnpm@11\.28\.4; \}/);
  assert.match(runs[1], /frozen_install\(\) \{ HOME=\/opt\/build-home \/usr\/local\/bin\/pnpm install --frozen-lockfile --store-dir \/opt\/build-home\/pnpm-store; \}/);
  assert.match(runs[1], /native_prepare\(\) \{ HOME=\/opt\/build-home \/usr\/local\/bin\/node scripts\/edge-proof\.mjs container-prepare "\$CONTEXT_HASH"; \}/);
  assert.deepEqual(runs.flatMap(run => [...run.matchAll(/(?:;|&&)\s*edge_stage (\w+) (\w+)/g)].map(match => { assert.equal(match[1], match[2]); return match[1]; })), imageBuildStages);
  return [first, second];
}
test("image install keeps one absolute store outside the source input", async () => {
  await actualStageShells(); // Source assertions only; never execute either RUN.
  const file = await readFile(new URL("../config/edge-proof/Dockerfile", import.meta.url), "utf8");
  assert.equal((file.match(/--store-dir\b/g) ?? []).length, 1);
  assert.equal((file.match(/\/usr\/local\/bin\/pnpm install\b/g) ?? []).length, 1);
  assert.deepEqual(file.split("\n").filter(line => line.startsWith("ENV ")), ["ENV PNPM_HOME=/usr/local/share/pnpm"]);
  assert.deepEqual(file.split("\n").filter(line => line.startsWith("USER ")), ["USER ${HOST_UID}:${HOST_GID}"]);
  assert.ok(file.indexOf("edge_stage input_ownership input_ownership") < file.indexOf("USER ${HOST_UID}:${HOST_GID}"));
  assert.ok(file.indexOf("USER ${HOST_UID}:${HOST_GID}") < file.indexOf("RUN edge_seq=16;"));
  assert.ok(file.includes("WORKDIR /opt/edge-input\nRUN edge_seq=16;"));
  assert.ok(!file.includes("--virtual-store-dir") && !file.includes("--ignore-scripts pnpm install"));
});
function harmlessShell(script) {
  const result = spawnSync("/bin/sh", ["-c", script], { env: { PATH: "/usr/bin:/bin", HOME: "/owned-fixture-home", CONTEXT_HASH: other, TASK_NONCE: hex }, encoding: "utf8", timeout: 3000, maxBuffer: 65536 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
}
async function actualStageCapture(failedStage = null, status = 23) {
  const shells = await actualStageShells(); let stdout = "", stderr = "", code = 0;
  for (const [index, shell] of shells.entries()) {
    const stages = index ? imageBuildStages.slice(8) : imageBuildStages.slice(0, 8);
    const commands = stages.map(stage => `edge_stage ${stage} proof_op ${stage}`).join(" && ");
    const result = harmlessShell(shell + `proof_op() { [ "$1" != "${failedStage ?? "none"}" ] || return ${status}; }; ` + commands);
    stdout += result.stdout; stderr += result.stderr; code = result.status; if (code) break;
  }
  return capturedStageResult(stdout, stderr, code);
}
function capturedStageResult(stdout, stderr = "", code = 1) {
  return { ...processResult(stdout), stderr, code, spawnErrors: [], outputSummary: Object.fromEntries(Object.entries({ stdout, stderr }).map(([key, text]) => [key, { bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), complete: true }])) };
}
const stageIdentity = { contextHash: other, nonce: hex };
test("internal build actual shell markers preserve both RUN sequences and all original command statuses", async () => {
  const complete = await actualStageCapture(); assert.equal(complete.code, 0);
  assert.deepEqual(parseImageBuildStages(complete, stageIdentity), { v: 4, phase: "image_build_internal", state: "observed", stage: "native_prepare", status: 0, records: 20, reason: "complete" });
  for (const stage of imageBuildStages) {
    const result = await actualStageCapture(stage, 23), row = parseImageBuildStages(result, stageIdentity);
    assert.equal(result.code, 23); assert.equal(row.stage, stage); assert.equal(row.status, 23); assert.equal(row.reason, "validated_failure"); assert.equal(row.records, 2 * (imageBuildStages.indexOf(stage) + 1)); validateContainerDiagnostic(row);
  }
});
test("internal build shell entry precedes command substitution and keeps argv HOME and failure priority", async () => {
  const [shell] = await actualStageShells();
  const substitution = harmlessShell(shell + 'proof_op() { test "$(printf "SUBSTITUTION\\n" >&3; printf expected)" = expected; }; edge_stage node_version proof_op 3>&1');
  assert.equal(substitution.status, 0); const lines = substitution.stdout.trimEnd().split("\n").filter(Boolean); assert.match(lines[0], /"event":"entered"/); assert.equal(lines[1], "SUBSTITUTION"); assert.match(lines[2], /"event":"terminal","status":0/);
  for (const [subcommand, expectedStatus] of [["printf expected; exit 29", 0], ["printf different; exit 0", 1]]) {
    const result = harmlessShell(shell + `proof_op() { test "$( ${subcommand} )" = expected; }; edge_stage node_version proof_op`);
    assert.equal(result.status, expectedStatus); assert.equal(JSON.parse(result.stdout.trimEnd().split("\n").at(-1).slice("EDGE_BUILD_STAGE_V1 ".length)).status, expectedStatus);
  }
  const operands = harmlessShell(shell + 'proof_op() { [ "$#" -eq 2 ] && [ "$1" = "space argument" ] && [ "$2" = "literal*$" ] && [ "$HOME" = /owned-command-home ]; }; HOME=/owned-command-home edge_stage node_version proof_op "space argument" \'literal*$\'');
  assert.equal(operands.status, 0);
  for (const commandStatus of [0, 23, 127]) {
    const inject = shell.replace('edge_emit() {', 'edge_original_emit() {') + `edge_emit() { if [ "$2" = terminal ]; then return 71; fi; edge_original_emit "$@"; }; proof_op() { return ${commandStatus}; }; edge_stage node_version proof_op`;
    const result = harmlessShell(inject); assert.equal(result.status, commandStatus || 70); assert.equal(parseImageBuildStages(capturedStageResult(result.stdout, result.stderr, result.status), stageIdentity).reason, "incomplete");
  }
  const before = harmlessShell(shell + 'edge_emit() { return 71; }; proof_op() { printf FORBIDDEN; }; edge_stage node_version proof_op'); assert.equal(before.status, 70); assert.equal(before.stdout, "");
});
test("internal build parser refuses discarded tails despite complete flags and verifies BOTH original hashes", async () => {
  const original = await actualStageCapture("frozen_install");
  const valid = parseImageBuildStages(original, stageIdentity); assert.equal(valid.reason, "validated_failure");
  assert.deepEqual(parseImageBuildStages(capturedStageResult(original.stdout, "unclassified private output", original.code), stageIdentity), valid);
  const changes = [r => r.stdout = r.stdout.split("\n").slice(0, 2).join("\n") + "\n", r => r.outputSummary.stdout.sha256 = hex, r => r.outputSummary.stdout.bytes++, r => { r.stderr = "stored prefix"; r.outputSummary.stderr = { bytes: 22, sha256: createHash("sha256").update("stored prefix plus tail").digest("hex"), complete: true }; }, r => r.outputSummary.stderr.sha256 = hex];
  for (const change of changes) { const result = structuredClone(original); change(result); const row = parseImageBuildStages(result, stageIdentity); assert.equal(row.reason, "capture_mismatch"); assert.equal(row.records, null); assert.equal(row.stage, null); validateContainerDiagnostic(row); }
  for (const change of [r => r.closed = false, r => delete r.outputSummary, r => r.outputSummary.stderr.complete = false]) { const result = structuredClone(original); change(result); assert.equal(parseImageBuildStages(result, stageIdentity).reason, "capture_unavailable"); }
  const splitUtf8 = structuredClone(original); splitUtf8.stderr = "\ufffd\ufffd"; splitUtf8.outputSummary.stderr = { bytes: 2, sha256: createHash("sha256").update(Buffer.from([0xc3, 0xa9])).digest("hex"), complete: true }; assert.equal(parseImageBuildStages(splitUtf8, stageIdentity).reason, "capture_mismatch");
});
test("internal build parser rejects echoed source foreign duplicate reordered ANSI and malformed frames", async () => {
  const original = await actualStageCapture("node_version"), lines = original.stdout.trimEnd().split("\n").filter(Boolean);
  const invalid = ["Step 1 : RUN printf '" + lines[0] + "'\n", lines.concat(lines[1]).join("\n") + "\n", [...lines].reverse().join("\n") + "\n", original.stdout.replace(other, hex), original.stdout.replace(hex, other), original.stdout.replace('"stage":"node_version"', '"stage":"foreign"'), original.stdout.replace("EDGE_BUILD", "\x1b[31mEDGE_BUILD"), original.stdout.replace('"v":1', '"v":1,"v":1'), original.stdout.replace('"seq":1', '"seq":99'), original.stdout.replace('"event":"entered"', '"event":"foreign"')];
  for (const stdout of invalid) { const row = parseImageBuildStages(capturedStageResult(stdout), stageIdentity); assert.equal(row.reason, "invalid"); assert.equal(row.stage, null); assert.equal(row.status, null); validateContainerDiagnostic(row); }
  assert.equal(parseImageBuildStages(capturedStageResult("", original.stdout), stageIdentity).reason, "no_records");
  assert.equal(parseImageBuildStages(capturedStageResult(lines[0] + "\n"), stageIdentity).reason, "incomplete");
  assert.equal(parseImageBuildStages({ ...original, code: 0 }, stageIdentity).reason, "invalid");
  const all = await actualStageCapture(); assert.equal(parseImageBuildStages(capturedStageResult(all.stdout + lines[0] + "\n"), stageIdentity).reason, "invalid");
});
test("internal build observations cannot override original failure and reserve terminal stage plus CLI outcome", async () => {
  const original = await actualStageCapture("pnpm_bootstrap", 23), report = createContainerDiagnostics(); let later = false;
  const work = report.step("image_build", () => observeImageBuild(() => original, () => { later = true; }, () => { later = true; }, report, stageIdentity));
  await assert.rejects(work); assert.equal(later, false); assert.equal(original.code, 23);
  const context = ["entry", "module_import", "dispatch", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket", "identity", "context", "daemon", "base"].map(phase => ({ v: 2, phase, state: "fulfilled", defined: null, exit: null, signal: null }));
  const output = []; emitContainerFailure([...context, ...report.records], line => output.push(line));
  const packet = output.map(line => validateContainerDiagnostic(JSON.parse(line.slice(line.indexOf("::", 2) + 2))));
  assert.equal(packet[0].reason, "validated_failure"); assert.equal(packet[0].stage, "pnpm_bootstrap"); assert.equal(packet[1].phase, "image_build_process"); assert.equal(packet[1].exit, 23); assert.equal(packet.length, 10);
  assert.ok(output.every(line => Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192); assert.ok(!output.join("").includes(other)); assert.ok(!output.join("").includes(hex));
  const failedReport = createContainerDiagnostics(); failedReport.internal = () => { throw undefined; };
  await assert.rejects(observeImageBuild(() => original, () => {}, () => {}, failedReport, stageIdentity), error => error instanceof AggregateError && error.errors[0] instanceof AggregateError && error.errors[1] === undefined);
  const unknown = parseImageBuildStages({}, stageIdentity); for (const change of [r => r.stage = "pnpm_bootstrap", r => r.status = 1, r => r.records = 0, r => r.message = "private", r => r.reason = "foreign"]) { const invalid = { ...unknown }; change(invalid); assert.throws(() => validateContainerDiagnostic(invalid)); }
});

async function actualMarkerFormatter() {
  const source = await readFile(new URL("../config/edge-proof/Dockerfile", import.meta.url), "utf8");
  const formats = [...source.matchAll(/printf '([^']+)' 'EDGE_BUILD_' 'STAGE_V1'/g)].map(match => match[1]);
  assert.equal(formats.length, 2); assert.equal(formats[0], formats[1]);
  const format = formats[0]; assert.ok(format.startsWith("\\n%s%s ") && format.endsWith("\\n"));
  assert.ok(!source.includes("EDGE_BUILD_STAGE_V1"));
  assert.ok(!format.replaceAll("%s", "").replaceAll("\\n", "").includes("%"));
  // Evaluate only the frozen printf format's %s and newline conversions. No
  // shell, build command, Docker renderer or process marker runs in these tests.
  return (seq, stage, event, status, legacy = false) => {
    const values = ["EDGE_BUILD_", "STAGE_V1", other, hex, String(seq), stage, event, String(status)]; let index = 0;
    const text = (legacy ? format.slice(2) : format).replaceAll("\\n", "\n").replace(/%s/g, () => values[index++]);
    assert.equal(index, values.length); return text;
  };
}
test("marker delimiter actual formats separate prior output without changing candidate bytes", async () => {
  const format = await actualMarkerFormatter();
  for (const [prior, legacyReason] of [["", "validated_failure"], ["no-final-newline", "invalid"], ["prior-CR\r", "invalid"], ["first\nlast", "invalid"], ["first\nlast\n", "validated_failure"]]) {
    const current = format(1, "node_version", "entered", null) + prior + format(2, "node_version", "terminal", 23);
    const old = format(1, "node_version", "entered", null, true) + prior + format(2, "node_version", "terminal", 23, true);
    assert.equal(parseImageBuildStages(capturedStageResult(old), stageIdentity).reason, legacyReason);
    const result = parseImageBuildStages(capturedStageResult(current), stageIdentity);
    assert.equal(result.reason, "validated_failure"); assert.equal(result.status, 23); assert.equal(result.records, 2);
  }
  for (const status of [0, 1, 23, 127, 255]) {
    const current = format(2, "node_version", "terminal", status), old = format(2, "node_version", "terminal", status, true);
    assert.equal(current, "\n" + old); assert.ok(current.endsWith("\n") && !current.startsWith("\n\n"));
  }
});
test("marker delimiter keeps inter-RUN order and strict malformed foreign control and capture rejection", async () => {
  const format = await actualMarkerFormatter();
  const rows = imageBuildStages.map((stage, i) => format(i * 2 + 1, stage, "entered", null) + format(i * 2 + 2, stage, "terminal", 0));
  const text = rows.slice(0, 8).join("") + "synthetic inter-RUN metadata without final LF" + rows.slice(8).join("");
  assert.equal(parseImageBuildStages(capturedStageResult(text, "", 0), stageIdentity).reason, "complete");
  const entry = format(1, "node_version", "entered", null), terminal = format(2, "node_version", "terminal", 23), valid = entry + terminal;
  for (const invalid of [valid.replace(other, hex), valid.replace('"stage":"node_version"', '"stage":"foreign"'), valid.replace('"seq":1', '"seq":2'), valid.replace('"v":1', '"v":1,"v":1'), valid.replace('"status":23', '"status":'), entry + terminal.replace("EDGE_BUILD", "\x1b[31mEDGE_BUILD"), valid + terminal]) {
    assert.equal(parseImageBuildStages(capturedStageResult(invalid), stageIdentity).reason, "invalid");
  }
  const truncated = capturedStageResult(valid); truncated.stdout = entry;
  assert.equal(parseImageBuildStages(truncated, stageIdentity).reason, "capture_mismatch");
  const stderrTail = capturedStageResult(valid, "complete tail"); stderrTail.stderr = "complete";
  assert.equal(parseImageBuildStages(stderrTail, stageIdentity).reason, "capture_mismatch");
});
test("marker delimiter missing reporter output stays unknown and independent report failure preserves original status", async () => {
  const format = await actualMarkerFormatter(), entry = format(1, "node_version", "entered", null);
  for (const status of [23, 70, 127]) {
    const original = capturedStageResult(entry, "", status), report = createContainerDiagnostics(); let reached = false;
    const parsed = parseImageBuildStages(original, stageIdentity); assert.equal(parsed.reason, "incomplete"); assert.equal(parsed.stage, null); assert.equal(parsed.status, null);
    report.internal = () => { throw undefined; };
    await assert.rejects(observeImageBuild(() => original, () => { reached = true; }, () => { reached = true; }, report, stageIdentity), error => error instanceof AggregateError && error.errors[0] instanceof AggregateError && error.errors[1] === undefined);
    assert.equal(reached, false); assert.equal(original.code, status); assert.equal(report.records[0].exit, status);
  }
});

async function actualPackageFactories() {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8"), cli = await readFile(new URL("../scripts/edge-proof.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const { containedLinks } = await qualifyInstalledInputs(root);"), end = source.indexOf("  const esbuildRequire =", start);
  assert.ok(start > 0 && end > start);
  const current = source.slice(start, end), pattern = /createRequire\(await realpath\((join\([^;\n]+?\))\)\)/g;
  assert.equal([...current.matchAll(pattern)].length, 2);
  const legacy = current.replace(pattern, "createRequire($1)");
  const qualifier = cli.slice(cli.indexOf("export async function qualifyInstalledInputs("), cli.indexOf("async function offlineChild(")).replace("export ", "");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const factory = text => new AsyncFunction("root", "createRequire", "realpath", "lstat", "readdir", "join", "relative", "refuse", "const prepare = undefined;" + qualifier + text + "return { containedLinks, tsRequire, wranglerRequire };");
  assert.ok(source.includes('const esbuildRequire = createRequire(wranglerRequire.resolve("esbuild/package.json"));'));
  const lock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  for (const version of ["typescript@7.0.2:", "wrangler@4.156.0:", "'@typescript/typescript-linux-x64@7.0.2':", "esbuild@0.28.2:"]) assert.ok(lock.includes(version));
  return { current: factory(current), legacy: factory(legacy) };
}
function packageLookupFixture({ missing, reason, escaped } = {}) {
  const root = "/opt/edge-input", anchors = [], canonicalCalls = [];
  const packages = {
    typescript: join(root, "node_modules/.pnpm/typescript@7.0.2/node_modules/typescript"),
    wrangler: join(root, "node_modules/.pnpm/wrangler@4.156.0_@cloudflare+workers-types@5.20261101.1/node_modules/wrangler"),
  };
  const canonical = async path => {
    canonicalCalls.push(path); if (path === root) return root;
    for (const [name, target] of Object.entries(packages)) {
      if (path === join(root, "node_modules", name)) return escaped && name === "typescript" ? escaped : target;
      if (path === join(root, "node_modules", name, "package.json")) { if (missing === name) throw reason; return join(target, "package.json"); }
    }
    throw new Error("unexpected fixture path");
  };
  const lstat = async path => { assert.ok([join(root, "node_modules"), join(root, "admin/node_modules")].includes(path)); return { isDirectory: () => true }; };
  const readdir = async path => {
    assert.ok([join(root, "node_modules"), join(root, "admin/node_modules")].includes(path));
    return path === join(root, "admin/node_modules") ? [] : Object.keys(packages).map(name => ({ name, isSymbolicLink: () => true }));
  };
  // Filesystem observations are controlled data; Node's actual createRequire
  // and lookup construction run without resolving/importing any dependency.
  return { root, packages, anchors, canonicalCalls, args: [root, path => { anchors.push(path); return createRequire(path); }, canonical, lstat, readdir, join, relative, code => { throw new Error(code); }] };
}
test("canonical package factories include frozen private dependency lookup directories without importing them", async () => {
  const factories = await actualPackageFactories(), oldFixture = packageLookupFixture(), fixedFixture = packageLookupFixture();
  const old = await factories.legacy(...oldFixture.args), fixed = await factories.current(...fixedFixture.args);
  assert.equal(fixed.containedLinks, 2);
  for (const [name, key, dependency] of [["typescript", "tsRequire", "@typescript/typescript-linux-x64"], ["wrangler", "wranglerRequire", "esbuild"]]) {
    const directory = dirname(fixedFixture.packages[name]);
    assert.equal(old[key].resolve.paths(dependency).includes(directory), false);
    assert.equal(fixed[key].resolve.paths(dependency).includes(directory), true);
    assert.ok(fixedFixture.anchors.includes(join(fixedFixture.packages[name], "package.json")));
  }
  assert.ok(oldFixture.anchors.every(path => !path.includes("/.pnpm/"))); assert.equal(fixedFixture.anchors.length, 2);
});
test("canonical package factories propagate missing anchor errors including undefined without fallback", async () => {
  const { current } = await actualPackageFactories();
  for (const missing of ["typescript", "wrangler"]) for (const reason of [new Error("missing fixture anchor"), undefined]) {
    const fixture = packageLookupFixture({ missing, reason });
    await assert.rejects(current(...fixture.args), error => error === reason);
    assert.equal(fixture.anchors.length, missing === "typescript" ? 0 : 1);
    assert.equal(fixture.canonicalCalls.filter(path => path === join(fixture.root, "node_modules", missing, "package.json")).length, 1);
  }
});
test("canonical package factories retain original install containment before any resolver construction", async () => {
  const { current } = await actualPackageFactories();
  for (const escaped of ["/foreign/typescript", "/opt/edge-input-other/typescript"]) {
    const fixture = packageLookupFixture({ escaped });
    await assert.rejects(current(...fixture.args), { message: "installation-link-escape" });
    assert.equal(fixture.anchors.length, 0); assert.ok(!fixture.canonicalCalls.some(path => path.endsWith("package.json")));
  }
});

// BEGIN actual preparation helper tests. Every helper I/O binding below is inert.
let preparationInputSeed;
async function reaperCompileFixture() {
  preparationInputSeed ??= (async () => {
    const owner = await ownershipFixture(), value = await owner.run();
    return { owner, value, source: await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8") };
  })();
  const { owner, value, source } = await preparationInputSeed;
  const select = (from, to) => {
    const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, from); return source.slice(a, b).replaceAll("export ", "");
  };
  const paths = { source: "/opt/edge-input/config/edge-proof/reaper.c", object: "/opt/edge-reaper/reaper.o", binary: "/opt/edge-reaper/reaper", headers: "/opt/edge-reaper/headers.d", manifest: "/opt/edge-reaper/build.json", context: "/opt/edge-input/.edge-context.json", loader: "/lib64/ld-linux-x86-64.so.2" };
  const tools = { gcc: "/usr/bin/gcc-inert", cc1: "/usr/lib/gcc/inert/cc1", as: "/usr/bin/as", collect2: "/usr/lib/gcc/inert/collect2", ld: "/usr/bin/ld" };
  const disk = new Map(owner.writes.map(row => [join(containerContract.input, row.path), Buffer.from(row.bytes)]));
  disk.set(paths.context, Buffer.from(JSON.stringify(value.plan)));
  for (const path of [...Object.values(tools), "/usr/include/inert.h", "/usr/include/inert2.h", "/usr/lib/inert/start.o", "/usr/lib/inert/libc.so", paths.loader]) disk.set(path, Buffer.from("inert file: " + path));
  const elf = Buffer.alloc(256), interpreter = Buffer.from(paths.loader + "\0");
  Buffer.from([127,69,76,70,2,1,1]).copy(elf); elf.writeUInt16LE(3,16); elf.writeUInt16LE(62,18); elf.writeUInt32LE(1,20);
  elf.writeBigUInt64LE(64n,32); elf.writeUInt16LE(56,54); elf.writeUInt16LE(1,56); elf.writeUInt32LE(3,64);
  elf.writeBigUInt64LE(128n,72); elf.writeBigUInt64LE(BigInt(interpreter.length),96); interpreter.copy(elf,128);
  const calls = [], state = { failAt: null, reason: undefined, failures: 0, transform: null, contextHash: value.contextHash };
  const invoke = (name, args, operation) => {
    const index = calls.length; calls.push({ name, args });
    if (index === state.failAt) { state.failures++; throw state.reason; }
    const result = operation(); return state.transform ? state.transform(name, args, result) : result;
  };
  const runtime = { platform: "linux", arch: "x64", version: "v24.22.1" };
  const bindings = {
    Buffer, containerContract, process: runtime, join, isAbsolute,
    hash: owner.sha, hashPattern: /^[a-f0-9]{64}$/,
    check: (ok, code) => { if (!ok) throw new Error(code); },
    same: (a,b) => JSON.stringify(a) === JSON.stringify(b),
    validateContextPlan: owner.api.validateContextPlan,
    realpath: async (...args) => invoke("realpath", args, () => args[0] === "/usr/bin/gcc" ? tools.gcc : args[0]),
    stat: async (...args) => invoke("stat", args, () => { assert.ok(disk.has(args[0]), "missing inert stat: " + args[0]); return { mode: 0o755, isFile: () => invoke("isFile", args, () => true) }; }),
    readFile: async (...args) => invoke("readFile", args, () => { assert.ok(disk.has(args[0]), "missing inert read: " + args[0]); const bytes = Buffer.from(disk.get(args[0])); return args[1] ? bytes.toString(args[1]) : bytes; }),
    writeFile: async (...args) => invoke("writeFile", args, () => { assert.equal(args[0], paths.manifest); assert.deepEqual(args[2], { flag: "wx", mode: 0o444 }); assert.ok(!disk.has(args[0]), "exclusive inert manifest"); disk.set(args[0], Buffer.from(args[1])); }),
    execFileSync: (...args) => invoke("execFileSync", args, () => {
      const [command, argv, options] = args;
      assert.deepEqual(options, { env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/opt/build-home" }, encoding: "utf8", timeout: 60000, maxBuffer: 1024*1024 });
      if (argv[0] === "--version") { const role = Object.keys(tools).find(role => tools[role] === command); assert.ok(role); return role + " inert-version\n"; }
      assert.equal(command, tools.gcc);
      if (argv[0] === "-dumpmachine") return "x86_64-linux-gnu\n";
      if (argv[0].startsWith("-print-prog-name=")) { const role = argv[0].split("=")[1]; assert.ok(Object.hasOwn(tools, role)); return tools[role] + "\n"; }
      if (argv.includes("-c")) {
        disk.set(paths.object, Buffer.from("inert object"));
        disk.set(paths.headers, Buffer.from("reaper: " + paths.source + " \\\n /usr/include/inert.h /usr/include/inert2.h\n")); return "";
      }
      assert.equal(argv[0], "-pie"); disk.set(paths.binary, Buffer.from(elf));
      return "/usr/lib/inert/start.o\n" + paths.object + "\n/usr/lib/inert/libc.so\n";
    }),
  };
  const helpers = select("const own =", "export function raiseContainerFailures(") + select("const reaperBuildRoot =", "export function validateNativeIdentity(");
  const api = new Function(...Object.keys(bindings), helpers + "return { compileReaper, qualifyReaper, validateReaperBuild, reaperCompileArguments };")(...Object.values(bindings));
  const setPlan = change => { const plan = JSON.parse(disk.get(paths.context)); change(plan); const text = JSON.stringify(plan); disk.set(paths.context, Buffer.from(text)); state.contextHash = owner.sha(text); };
  return { api, paths, tools, disk, calls, state, runtime, elf, setPlan, sha: owner.sha,
    compile: () => api.compileReaper(state.contextHash), qualify: () => api.qualifyReaper(state.contextHash) };
}
test("actual preparation helpers compile and qualify one closed inert context without native calls", async () => {
  const f = await reaperCompileFixture(); await f.compile();
  const commands = f.calls.filter(row => row.name === "execFileSync").map(row => row.args.slice(0,2));
  const expected = [[f.tools.gcc, ["-dumpmachine"]]];
  for (const role of ["gcc","cc1","as","collect2","ld"]) {
    if (role !== "gcc") expected.push([f.tools.gcc, ["-print-prog-name=" + role]]);
    expected.push([f.tools[role], ["--version"]]);
  }
  expected.push([f.tools.gcc, ["-std=c11","-O2","-Wall","-Wextra","-Werror","-fstack-protector-strong","-fPIE","-MD","-MF",f.paths.headers,"-MT","reaper","-c",f.paths.source,"-o",f.paths.object]], [f.tools.gcc, ["-pie","-Wl,-z,relro,-z,now","-Wl,-t",f.paths.object,"-o",f.paths.binary]]);
  assert.deepEqual(commands, expected); assert.equal(commands.length, 12);
  const manifestText = f.disk.get(f.paths.manifest).toString(), manifest = JSON.parse(manifestText);
  assert.equal(JSON.stringify(manifest), manifestText); assert.equal(manifest.contextHash, f.state.contextHash);
  assert.equal(manifest.source.sha256, f.sha(f.disk.get(f.paths.source)));
  assert.deepEqual(manifest.headers.map(row => row.path), ["/usr/include/inert.h", "/usr/include/inert2.h"]);
  assert.deepEqual(manifest.tools.map(row => row.path), Object.values(f.tools));
  for (const row of [manifest.source,manifest.object,manifest.binary,...manifest.tools,...manifest.headers,...manifest.links]) assert.equal(row.sha256, f.sha(f.disk.get(row.path)));
  const before = f.calls.length, qualified = await f.qualify();
  assert.deepEqual(qualified, { version:1, contextHash:f.state.contextHash, source:manifest.source, buildSha256:f.sha(manifestText), binary:manifest.binary });
  assert.ok(f.calls.slice(before).every(row => row.name !== "execFileSync" && row.name !== "writeFile"));
  assert.equal(f.calls.filter(row => row.name === "writeFile").length, 1);
  assert.ok(f.calls.filter(row => row.name === "writeFile").every(row => !row.args[0].startsWith(containerContract.input + "/")));
});
test("actual preparation helpers retain Error and undefined at every original I/O occurrence", async () => {
  const operations = {};
  for (const phase of ["compile","qualify"]) {
    const good = await reaperCompileFixture(); if (phase === "qualify") await good.compile(); good.calls.length = 0; await good[phase]();
    operations[phase] = good.calls.length;
    for (let index = 0; index < good.calls.length; index++) for (const reason of [new Error("inert original operation"), undefined]) {
      const f = await reaperCompileFixture(); if (phase === "qualify") await f.compile(); f.calls.length = 0;
      f.state.failAt = index; f.state.reason = reason;
      await assert.rejects(f[phase](), error => error === reason);
      assert.equal(f.state.failures, 1); assert.deepEqual(f.calls[index], good.calls[index]);
      assert.ok(!f.calls.slice(index + 1).some(row => row.name === "writeFile"));
    }
  }
  return { operations, rejectionCases: 2 * (operations.compile + operations.qualify) };
});
test("actual preparation helpers reject context, source inventory and materialized byte drift", async () => {
  for (const [change, failure] of [
    [f => { f.state.contextHash = "0".repeat(64); }, /context-identity/],
    [f => f.setPlan(plan => { plan.version = 2; }), /context-identity/],
    [f => f.setPlan(plan => { plan.harness.pop(); }), /owner-inventory-count/],
    [f => f.setPlan(plan => { plan.current.files.pop(); }), /owner-inventory-count/],
    [f => f.setPlan(plan => { plan.frozen.files[0].sha256 = "0".repeat(64); }), /frozen-input-digest/],
    [f => { f.disk.set(f.paths.source, Buffer.from("changed materialized source")); }, /reaper-original-source/],
    [f => { f.disk.delete(f.paths.source); }, /missing inert stat/],
    [f => f.setPlan(plan => { for (const list of [plan.harness,plan.files]) list.find(row => row.path === "config/edge-proof/reaper.c").sha256 = "0".repeat(64); }), /reaper-original-source/],
  ]) {
    const f = await reaperCompileFixture(); change(f); await assert.rejects(f.compile(), failure);
    assert.equal(f.calls.filter(row => row.name === "execFileSync").length, 0); assert.ok(!f.disk.has(f.paths.manifest));
  }
});
test("actual preparation helpers reject unqualified tools, output inventories and ELF bytes", async () => {
  for (const [field,value] of [["platform","foreign"],["arch","arm64"],["version","v26.0.0"]]) {
    const f = await reaperCompileFixture(); f.runtime[field] = value; await assert.rejects(f.compile(), /reaper-build-runtime/); assert.equal(f.calls.length, 0);
  }
  const transforms = [
    (name,args,value) => name === "realpath" && args[0] === "/usr/bin/gcc" ? "/task/gcc" : value,
    (name,args,value) => name === "stat" && args[0].endsWith("gcc-inert") ? { mode:0o644,isFile:()=>true } : value,
    (name,args,value) => name === "execFileSync" && args[1][0] === "-dumpmachine" ? "foreign-target" : value,
    (name,args,value) => name === "execFileSync" && args[1][0] === "--version" ? "" : value,
    (name,args,value) => name === "execFileSync" && args[1][0] === "--version" ? "bad\tversion" : value,
    (name,args,value) => name === "readFile" && args[0].endsWith("headers.d") ? "wrong: /usr/include/inert.h" : value,
    (name,args,value) => name === "readFile" && args[0].endsWith("headers.d") ? "reaper: /usr/include/inert.h" : value,
    (name,args,value) => name === "execFileSync" && args[1][0] === "-pie" ? "/usr/lib/inert/libc.so\n" : value,
    (name,args,value) => name === "execFileSync" && args[1][0] === "-pie" ? value + "/task/foreign.so\n" : value,
    (name,args,value) => name === "readFile" && args[0] === "/opt/edge-reaper/reaper" ? Buffer.alloc(64) : value,
  ];
  for (const transform of transforms) {
    const f = await reaperCompileFixture(); f.state.transform = transform; await assert.rejects(f.compile()); assert.ok(!f.disk.has(f.paths.manifest));
  }
  for (const path of ["object","binary","headers"]) {
    const f = await reaperCompileFixture(); f.state.transform = (name,args,value) => { if (name === "execFileSync" && args[1][0] === "-pie") f.disk.delete(f.paths[path]); return value; };
    await assert.rejects(f.compile()); assert.ok(!f.disk.has(f.paths.manifest));
  }
  const f = await reaperCompileFixture(); f.disk.set(f.paths.manifest, Buffer.from("already owned"));
  await assert.rejects(f.compile(), /exclusive inert manifest/); assert.equal(f.disk.get(f.paths.manifest).toString(), "already owned");
});
test("actual preparation qualification rejects manifest and every attested file drift without rebuilding", async () => {
  const seed = await reaperCompileFixture(); await seed.compile(); const original = JSON.parse(seed.disk.get(seed.paths.manifest));
  for (const row of [original.source,original.object,original.binary,...original.tools,...original.headers,...original.links]) {
    const f = await reaperCompileFixture(); await f.compile(); f.calls.length = 0; f.disk.set(row.path, Buffer.from("changed input"));
    await assert.rejects(f.qualify(), /reaper-build-drift/); assert.ok(f.calls.every(row => row.name !== "execFileSync" && row.name !== "writeFile"));
  }
  for (const change of [
    value => { value.contextHash = "0".repeat(64); }, value => { value.arguments[0].push("-extra"); },
    value => { value.source.path = "/task/source.c"; }, value => { value.tools[0].sha256 = "bad"; },
    value => { value.tools[0].version = "bad\tversion"; }, value => { value.tools.pop(); },
    value => { value.headers.push(value.headers[0]); }, value => { value.links = []; },
    value => { value.binary.path = "/task/reaper"; }, value => { value.extra = true; },
  ]) {
    const f = await reaperCompileFixture(); await f.compile(); const value = JSON.parse(f.disk.get(f.paths.manifest)); change(value); f.disk.set(f.paths.manifest, Buffer.from(JSON.stringify(value)));
    await assert.rejects(f.qualify());
  }
  for (const text of ["{}", "not JSON", " ".repeat(128*1024), JSON.stringify(original) + "\n"]) {
    const f = await reaperCompileFixture(); await f.compile(); f.disk.set(f.paths.manifest, Buffer.from(text)); await assert.rejects(f.qualify());
  }
});
test("actual preparation helper extraction retains committed imports and helper bindings", async () => {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  for (const name of ["compileReaper","qualifyReaper","reaperFile","validateReaperBuild","validateReaperElf","validateContextPlan"]) {
    assert.equal((source.match(new RegExp("^(?:export )?(?:async )?function " + name + "\\(", "gm")) ?? []).length, 1, name);
  }
  for (const [module,names] of [["node:child_process",["execFileSync"]],["node:fs/promises",["realpath","stat","readFile","writeFile"]],["node:path",["join","isAbsolute"]],["node:crypto",["createHash"]]]) {
    const imported = source.match(new RegExp('import \\{([^}]+)\\} from "' + module + '";'))[1].split(",").map(name => name.trim());
    for (const name of names) assert.ok(imported.includes(name), name);
  }
  const compile = source.slice(source.indexOf("async function compileReaper("), source.indexOf("async function qualifyReaper("));
  assert.ok(!compile.includes("import(")); assert.ok(!compile.includes("spawn("));
});
// END actual preparation helper tests.

async function nativePrepareFixture(failAt, ...failureArgs) {
  const failure = failureArgs.length ? failureArgs[0] : new Error("inert operation failure");
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const cli = await readFile(new URL("../scripts/edge-proof.mjs", import.meta.url), "utf8");
  const qualify = source.slice(source.indexOf("async function qualifyImageInputs("), source.indexOf("async function contextFiles(")).replace("await import(", "await importModule(");
  const prepare = source.slice(source.indexOf("async function containerPrepare("), source.indexOf("async function containerCi("));
  const dispatch = source.slice(source.indexOf("export async function containerMain(")).replace("export ", "");
  const main = cli.slice(cli.indexOf("export async function main("), cli.indexOf('  if (action === "offline-ci"')).replace("export ", "").replace('import("./edge-proof-container.mjs")', "loadContainer()") + 'throw new Error("noncontainer test route"); }';
  const frames = [], calls = []; let thrown = false;
  const active = () => frames.at(-1)?.stage;
  const touch = (name, ...args) => {
    calls.push({ stage: active(), name, args });
    if (!thrown && active() === failAt) { thrown = true; throw failure; }
  };
  const paths = {
    "typescript/package.json": "/opt/edge-input/node_modules/.pnpm/ts/node_modules/typescript/package.json",
    "@typescript/typescript-linux-x64/package.json": "/opt/edge-input/node_modules/.pnpm/ts/node_modules/@typescript/typescript-linux-x64/package.json",
    "wrangler/package.json": "/opt/edge-input/node_modules/.pnpm/wrangler/node_modules/wrangler/package.json",
    "esbuild/package.json": "/opt/edge-input/node_modules/.pnpm/esbuild/node_modules/esbuild/package.json",
    "@esbuild/linux-x64/bin/esbuild": "/opt/edge-input/node_modules/.pnpm/esbuild/node_modules/@esbuild/linux-x64/bin/esbuild",
  };
  const tsPath = join(dirname(paths["@typescript/typescript-linux-x64/package.json"]), "lib/tsc");
  const modules = Object.fromEntries(Object.entries(paths).map(([key, path]) => [join(containerContract.input, "node_modules", key), path]));
  let functions;
  const dependencies = {
    containerContract, installInputs, edgeProof, hashPattern: /^[a-f0-9]{64}$/, join, dirname,
    validateContextPlan(value, expected) { touch("validateContextPlan", value, expected); assert.equal(expected, other); },
    hash: value => value === "[]" ? other : installInputs[value], same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    process: { platform: "linux", arch: "x64", version: "v24.22.1", versions: { modules: "137" }, stdout: { write(text) { touch("receipt_output", text); return true; } } },
    check(value, code) { touch("check", code); assert.ok(value, code); },
    readFile: async (path, encoding) => {
      touch("readFile", path, encoding);
      if (path.endsWith(".edge-context.json")) return JSON.stringify({ files: [], sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree });
      if (path === paths["esbuild/package.json"]) return JSON.stringify({ version: "0.28.2" });
      const input = path.slice(containerContract.input.length + 1); assert.ok(Object.hasOwn(installInputs, input)); return input;
    },
    contextFiles: async (...args) => { touch("contextFiles", ...args); return []; },
    qualifyInstalledInputs: async (...args) => { touch("qualifyInstalledInputs", ...args); return { containedLinks: 164 }; },
    realpath: async path => { touch("realpath", path); return modules[path] ?? path; },
    createRequire(path) { touch("createRequire", path); return { resolve(name) { touch("resolve", name); assert.ok(Object.hasOwn(paths, name)); return paths[name]; } }; },
    fileIdentity: async path => { touch("fileIdentity", path); return { path, sha256: path.endsWith("wrangler-dist/cli.js") ? containerContract.cliHash : hex }; },
    validateNativeIdentity(...args) { touch("validateNativeIdentity", ...args); return validateNativeIdentity(...args); },
    compileReaper: async (...args) => { touch("compileReaper", ...args); },
    qualifyReaper: async (...args) => { touch("qualifyReaper", ...args); return native().reaper; },
    importModule: async url => { touch("importModule", url); return { default: () => { touch("getTsPath"); return tsPath; } }; },
    execFileSync(command, args, options) { touch("execFileSync", command, args, options); return command === "/usr/local/bin/pnpm" ? "11.28.4\n" : "0.28.2\n"; },
    writeFile: async (...args) => { touch("writeFile", ...args); },
    loadContainer: async () => { touch("loadContainer"); return { containerMain: (...args) => { touch("containerMain"); return functions.containerMain(...args); } }; },
    fail: () => assert.fail("unexpected container action"),
  };
  functions = new Function(...Object.keys(dependencies), qualify + prepare + dispatch + main + "return { main, containerMain, qualifyImageInputs };")(...Object.values(dependencies));
  const output = [], diagnostics = [], exits = [], events = new EventEmitter();
  const launched = () => launchCli(["container-prepare", other], {
    run: (...args) => { touch("run"); return functions.main(...args); },
    prepareIdentity: stageIdentity, prepareWriter(bytes, offset, length) { const text = bytes.subarray(offset, offset + length).toString(); frames.push(JSON.parse(text.slice(text.indexOf(" {") + 1))); diagnostics.push(text); return length; },
    writer(text) { if (!text.startsWith("::error ")) touch("cli_writer", text); output.push(text); }, errorWriter() {}, events, setExit: code => exits.push(code),
  });
  return { launched, functions, frames, diagnostics, output, exits, events, calls, failure };
}
function nativePrepareCapture(frames, { status = 1, before = "", after = "" } = {}) {
  const outer = imageBuildStages.flatMap((stage, index) => ["entered", "terminal"].map((event, offset) => "\nEDGE_BUILD_STAGE_V1 " + JSON.stringify({ v: 1, context: other, nonce: hex, seq: index * 2 + offset + 1, stage, event, status: offset ? index === 9 ? status : 0 : null }) + "\n"));
  return capturedStageResult(before + outer.slice(0, 19).join("") + frames + outer[19] + after, "", status);
}
test("native preparation actual stages preserve each original call and isolate runtime requalification", async () => {
  assert.equal(nativePrepareStages.length, 28);
  const fixture = await nativePrepareFixture(); const call = fixture.launched(); await call.completion;
  assert.deepEqual(fixture.frames.slice(0, -1).map(row => row.stage), nativePrepareStages);
  assert.equal(fixture.frames.length, 29); assert.deepEqual(call.errors, []); assert.deepEqual(fixture.exits, []);
  const children = fixture.calls.filter(row => row.name === "execFileSync");
  assert.equal(children.length, 2);
  assert.deepEqual(children[0].args.slice(1), [["--version"], { env: { LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10000 }]);
  assert.deepEqual(children[1].args, ["/usr/local/bin/pnpm", ["--version"], { env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/opt/build-home" }, encoding: "utf8", timeout: 10000 }]);
  assert.equal(fixture.calls.filter(row => row.name === "writeFile").length, 1);
  assert.deepEqual(fixture.calls.find(row => row.name === "writeFile").args[2], { flag: "wx", mode: 0o444 });
  assert.equal(fixture.calls.filter(row => row.name === "loadContainer").length, 1);
  assert.equal(fixture.calls.filter(row => row.name === "containerMain").length, 1);
  assert.deepEqual(fixture.calls.filter(row => row.name === "compileReaper").map(row => row.args), [[other]]);
  assert.deepEqual(fixture.calls.filter(row => row.name === "qualifyReaper").map(row => row.args), [[other]]);
  assert.equal(fixture.output[0], '{"prepared":true}\n');
  const row = parseNativePrepareStages(nativePrepareCapture(fixture.diagnostics.join(""), { status: 0 }), stageIdentity);
  assert.equal(row.reason, "complete"); assert.equal(row.stage, null); validateContainerDiagnostic(row);
  const count = fixture.frames.length;
  const native = await fixture.functions.qualifyImageInputs(other);
  assert.equal(native.contextHash, other); assert.equal(fixture.frames.length, count);
  assert.equal(fixture.calls.filter(row => row.name === "compileReaper").length, 1);
  assert.equal(fixture.calls.filter(row => row.name === "qualifyReaper").length, 2);
});
test("native preparation actual flow locates every original failure including undefined without retry", async () => {
  for (const stage of nativePrepareStages) for (const reason of [new Error("owned failure"), undefined]) {
    const fixture = await nativePrepareFixture(stage, reason), call = fixture.launched();
    // Pass undefined explicitly: it is a rejection, not absence of failure.
    const expected = reason === undefined ? fixture.failure : reason;
    await assert.rejects(call.completion, error => error === expected);
    const row = parseNativePrepareStages(nativePrepareCapture(fixture.diagnostics.join("")), stageIdentity);
    assert.equal(row.reason, "original_failure", stage); assert.equal(row.stage, stage);
    assert.equal(row.defined, expected !== undefined); validateContainerDiagnostic(row);
    assert.equal(fixture.calls.filter(item => item.stage === stage).length, 1);
    assert.ok(fixture.calls.every(item => nativePrepareStages.indexOf(item.stage) <= nativePrepareStages.indexOf(stage)));
  }
});
test("native preparation full-frame writer preserves primary and independent reporting failures", async () => {
  const chunks = [], recorder = createNativePrepareDiagnostics(stageIdentity, (bytes, offset, length) => { const size = Math.min(7, length); chunks.push(bytes.subarray(offset, offset + size)); return size; });
  nativePrepareStages.forEach(stage => recorder.enter(stage)); recorder.finish(false);
  const valid = Buffer.concat(chunks).toString(); assert.equal(parseNativePrepareStages(nativePrepareCapture(valid, { status: 0 }), stageIdentity).reason, "complete");
  for (const written of [0, -1, NaN, Infinity, 513, undefined, Promise.resolve(1)]) {
    const failed = createNativePrepareDiagnostics(stageIdentity, () => written); failed.enter("app_entry"); failed.finish(true, undefined); assert.ok(failed.errors.length);
  }
  for (const primary of [false, true]) {
    let writes = 0; const output = [], exit = [];
    const call = launchCli(["container-prepare", other], { prepareIdentity: stageIdentity, prepareWriter() { writes++; throw undefined; },
      run(_args, report) { nativePrepareStages.slice(1, -1).forEach(stage => report.prepare.enter(stage)); if (primary) throw undefined; return { prepared: true }; },
      writer: line => output.push(line), errorWriter() {}, events: new EventEmitter(), setExit: value => exit.push(value),
    });
    await assert.rejects(call.completion, error => error instanceof AggregateError && error.errors.every(reason => reason === undefined));
    assert.equal(call.errors.length, writes + Number(primary)); assert.equal(exit.at(-1), 1);
  }
  const missing = createNativePrepareDiagnostics({ contextHash: other, nonce: undefined }, () => assert.fail("must not emit unbound frame"));
  missing.enter("app_entry"); missing.finish(true, undefined); assert.ok(missing.errors.length);
});
test("native preparation incomplete foreign malformed or outer-inconsistent evidence stays unknown", async () => {
  const fixture = await nativePrepareFixture("esbuild_child"); await assert.rejects(fixture.launched().completion);
  const text = fixture.diagnostics.join(""), lines = fixture.diagnostics;
  const mutate = change => lines.map((line, index) => { const row = JSON.parse(line.slice(line.indexOf(" {") + 1)); change(row, index); return "\nEDGE_NATIVE_PREPARE_V1 " + JSON.stringify(row) + "\n"; }).join("");
  const bad = [text.replace(other, hex), text.replace(hex, other), lines.toReversed().join(""), text + lines[0], text.replace('"v":1', '"v":1,"v":1'), text.replace("EDGE_NATIVE_", "\x1bEDGE_NATIVE_"), "RUN printf '" + lines[0].trim() + "'\n", mutate((row, i) => { if (!i) row.seq = 2; }), mutate((row, i) => { if (!i) row.stage = "foreign"; }), mutate(row => { row.private = "never emitted"; })];
  for (const frames of bad) { const row = parseNativePrepareStages(nativePrepareCapture(frames), stageIdentity); assert.equal(row.reason, "invalid"); assert.equal(row.stage, null); validateContainerDiagnostic(row); }
  for (const frames of ["", lines.slice(0, -1).join("")]) { const row = parseNativePrepareStages(nativePrepareCapture(frames), stageIdentity); assert.ok(["no_records", "incomplete"].includes(row.reason)); assert.equal(row.stage, null); }
  for (const options of [{ before: lines[0] }, { after: lines[0] }, { status: 0 }]) assert.ok(["invalid", "outer_inconsistent"].includes(parseNativePrepareStages(nativePrepareCapture(text, options), stageIdentity).reason));
  const final = mutate((row, index) => { if (index === lines.length - 1) { row.outcome = "reporter_failure"; row.defined = null; row.reportFailures = 1; row.undefinedReportFailures = 1; } });
  assert.equal(parseNativePrepareStages(nativePrepareCapture(final), stageIdentity).reason, "invalid");
  for (const prefix of ["untrusted output without LF", "prior\r", "one\ntwo", ""]) assert.equal(parseNativePrepareStages(nativePrepareCapture(prefix + text), stageIdentity).reason, "original_failure");
});
test("native preparation capture integrity never trusts complete flags or a surviving prefix", async () => {
  const fixture = await nativePrepareFixture("receipt_write"); await assert.rejects(fixture.launched().completion);
  const original = nativePrepareCapture(fixture.diagnostics.join(""));
  const changes = [r => r.stdout = r.stdout.slice(0, -1), r => r.outputSummary.stdout.sha256 = hex, r => r.outputSummary.stdout.bytes++, r => { r.stderr = "prefix"; r.outputSummary.stderr = { bytes: 11, sha256: createHash("sha256").update("prefix tail").digest("hex"), complete: true }; }, r => r.outputSummary.stderr.sha256 = hex];
  for (const change of changes) { const result = structuredClone(original); change(result); const row = parseNativePrepareStages(result, stageIdentity); assert.equal(row.reason, "capture_mismatch"); assert.equal(row.stage, null); }
  for (const change of [r => r.closed = false, r => delete r.outputSummary, r => r.outputSummary.stderr.complete = false]) { const result = structuredClone(original); change(result); assert.equal(parseNativePrepareStages(result, stageIdentity).reason, "capture_unavailable"); }
});
test("native preparation summaries reserve original process outer inner and terminal failures without private fields", async () => {
  const fixture = await nativePrepareFixture("pnpm_child"); await assert.rejects(fixture.launched().completion);
  const result = nativePrepareCapture(fixture.diagnostics.join("")), report = createContainerDiagnostics();
  await assert.rejects(report.step("image_build", () => observeImageBuild(() => result, () => assert.fail("image id after failure"), () => assert.fail("native receipt after failure"), report, stageIdentity)));
  const context = ["entry", "module_import", "dispatch", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket", "identity", "context", "daemon", "base"].map(phase => ({ v: 2, phase, state: "fulfilled", defined: null, exit: null, signal: null }));
  const output = []; emitContainerFailure([...context, ...report.records], line => output.push(line));
  const decoded = output.map(line => validateContainerDiagnostic(JSON.parse(line.slice(line.indexOf("::", 2) + 2))));
  assert.ok(decoded.find(row => row.v === 3 && row.exit === 1)); assert.ok(decoded.find(row => row.v === 4 && row.stage === "native_prepare")); assert.ok(decoded.find(row => row.v === 5 && row.stage === "pnpm_child"));
  assert.equal(decoded.length, 10); assert.equal(decoded.at(-1).phase, "overflow");
  assert.ok(output.every(line => line.startsWith("::error ") && Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192);
  for (const privateText of [hex, other, "/opt/", "owned failure", "pnpm --version"]) assert.ok(!output.join("").includes(privateText));
  for (const change of [r => r.stage = "foreign", r => r.message = "private", r => r.reportFailures = -1, r => r.defined = null]) { const row = { ...decoded.find(row => row.v === 5) }; change(row); assert.throws(() => validateContainerDiagnostic(row)); }
});
test("native preparation reporter-only terminal never blames the successful original operation", async () => {
  for (const originalFailed of [false, true]) {
    const frames = [], original = new Error("original private value"); let writes = 0;
    const prepare = createNativePrepareDiagnostics(stageIdentity, (bytes, offset, length) => {
      frames.push(bytes.subarray(offset, offset + length).toString());
      if (++writes === 2) throw undefined;
      return length;
    });
    nativePrepareStages.forEach(stage => prepare.enter(stage)); prepare.finish(originalFailed, original);
    assert.deepEqual(prepare.errors, [undefined]);
    const row = parseNativePrepareStages(nativePrepareCapture(frames.join("")), stageIdentity);
    assert.equal(row.reason, originalFailed ? "original_failure" : "reporter_failure");
    assert.equal(row.stage, originalFailed ? "cli_serialization" : null);
    assert.equal(row.defined, originalFailed ? true : null);
    assert.equal(row.reportFailures, 1); assert.equal(row.undefinedReportFailures, 1); validateContainerDiagnostic(row);
  }
  let getters = 0;
  const hostile = Object.defineProperty({ contextHash: other }, "nonce", { get() { getters++; throw undefined; } });
  const prepare = createNativePrepareDiagnostics(hostile, () => assert.fail("foreign identity emitted"));
  prepare.enter("app_entry"); prepare.finish(true, undefined); assert.equal(getters, 0); assert.ok(prepare.errors.length);
});
test("native preparation ordinary entry guard remains nondispatching and missing entry stays unknown", async () => {
  const source = await readFile(new URL("../scripts/edge-proof.mjs", import.meta.url), "utf8");
  const guard = source.slice(source.indexOf('if (process.argv[1]')).replace("import.meta.url", "moduleUrl");
  const invoke = new Function("process", "moduleUrl", "pathToFileURL", "resolve", "launchCli", guard);
  let calls = 0;
  const url = path => ({ href: "file://" + path }), process = { argv: ["node", "/owned/entry.mjs", "container-prepare", other] };
  invoke(process, "file:///owned/imported.mjs", url, path => path, () => calls++); assert.equal(calls, 0);
  invoke(process, "file:///owned/entry.mjs", url, path => path, args => { calls++; assert.deepEqual(args, ["container-prepare", other]); }); assert.equal(calls, 1);
  assert.equal(parseNativePrepareStages(nativePrepareCapture(""), stageIdentity).reason, "no_records");
});

async function extractedContextTraversal() {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function contextFiles("), source.indexOf("async function writeExclusive("));
  assert.ok(body.includes('files.length < 50000 && size <= 256 * 1024 * 1024'));
  // Only the recursive call binding is fault-injected, in this private realm.
  // The original walk body, arguments and receiver still execute unchanged.
  const anchor = "  try {\n    await walk();";
  assert.equal(body.split(anchor).length, 2);
  const faultable = body.replace(anchor, "  const originalWalk = walk; walk = function (...args) { hooks.recursion(args); return originalWalk.apply(this, args); };\n" + anchor);
  return bindings => runInNewContext(`const originalSort = Array.prototype.sort;
    Array.prototype.sort = function (...args) { hooks.finalSort(this, args); return originalSort.apply(this, args); };
    const originalPush = Array.prototype.push;
    Array.prototype.push = function (...args) { hooks.fileRecord(this, args); return originalPush.apply(this, args); };
    ${faultable}\ncontextFiles;`, bindings);
}
function traversalBindings(options = {}) {
  const { fault, nodes, excluded = [], hugeBytes, sizes, manifest, noObservation = false, reporterFailure = false, traceLimit = 10000 } = options;
  const reason = Object.hasOwn(options, "reason") ? options.reason : new Error("inert traversal failure");
  const tree = nodes ?? { "": ["z", "dir", "a", "node_modules", ".edge-context.json"], dir: ["nested", "b"], "dir/nested": ["c"], node_modules: ["ignored"] };
  const trace = [], frames = []; let traceCount = 0, active, failed = false, writes = 0;
  const record = (...args) => { traceCount++; if (trace.length < traceLimit) trace.push(JSON.parse(JSON.stringify(args))); };
  const reject = op => { if (!failed && fault === op) { failed = true; throw reason; } };
  const diagnostics = createNativePrepareDiagnostics(stageIdentity, (bytes, offset, length) => {
    frames.push(bytes.subarray(offset, offset + length).toString()); writes++;
    if (reporterFailure && frames.at(-1).includes('"event":"terminal"')) throw undefined;
    return length;
  });
  if (!noObservation) {
    nativePrepareStages.slice(0, 8).forEach(stage => diagnostics.enter(stage));
    if (Object.hasOwn(options, "manifest")) diagnostics.enumerationManifest(manifest);
    const point = diagnostics.enumerationPoint;
    diagnostics.enumerationPoint = (...args) => { active = args[0]; point(...args); };
  }
  const controls = new Set(excluded), has = controls.has;
  controls.has = function (path) { record("has", path); reject("exclusion"); return has.call(this, path); };
  const bindings = {
    hooks: {
      recursion(args) { if (args.length) { record("walk", ...args); reject("recursion"); } },
      finalSort(receiver, args) { record("final_sort", receiver.length, args.length); reject("final_sort"); },
      fileRecord(receiver, args) { record("file_record", receiver.length, args[0]); reject("file_record"); },
    },
    join(...args) { record("join", ...args); return join(...args); },
    check(value, code) { record("check", value, code); reject(({ "context-path": "path_check", "context-link-or-special": "file_type_check", "context-capacity": "capacity" })[code]); if (!value) throw reason; },
    async readdir(path, options) {
      record("readdir", path, options); reject("directory_read");
      const prefix = path === "/fixture" ? "" : path.slice("/fixture/".length); assert.ok(Object.hasOwn(tree, prefix));
      const entries = tree[prefix].map(name => {
        const full = prefix ? prefix + "/" + name : name;
        return { get name() { record("name", full); if (active === "entry_path") reject("entry_path"); return name; },
          isDirectory() { record("isDirectory", full); reject("directory_type"); return Object.hasOwn(tree, full); },
          isFile() { record("isFile", full); reject("file_type"); return name !== "special"; },
        };
      });
      entries.sort = function (...args) { record("directory_sort", prefix, args.length); reject("directory_sort"); return Array.prototype.sort.apply(this, args); };
      return entries;
    },
    async readFile(path) {
      record("readFile", path); reject("file_read");
      if (sizes && Object.hasOwn(sizes, path)) return { get length() { record("length", path); reject("byte_count"); return sizes[path]; } };
      if (fault === "byte_count" || hugeBytes !== undefined) return { get length() { record("length", path); reject("byte_count"); return hugeBytes ?? 1; } };
      return Buffer.from(path.endsWith("/a") ? "unicode-音" : path);
    },
    hash(bytes) { record("hash", Buffer.isBuffer(bytes) ? bytes.toString() : "synthetic-sized-input"); reject("hash"); return createHash("sha256").update(Buffer.isBuffer(bytes) ? bytes : "synthetic-sized-input").digest("hex"); },
  };
  return { bindings, diagnostics, observation: noObservation ? undefined : diagnostics, controls, frames, trace, get traceCount() { return traceCount; }, get writes() { return writes; }, reason };
}
test("enumeration diagnostics actual traversal preserves manifest bytes access order exclusions and observer-off callers", async () => {
  const factory = await extractedContextTraversal(), excluded = ["node_modules", ".edge-context.json"];
  const on = traversalBindings({ excluded }), off = traversalBindings({ excluded, noObservation: true });
  const observed = await factory(on.bindings)("/fixture", on.controls, on.observation), silent = await factory(off.bindings)("/fixture", off.controls);
  assert.equal(JSON.stringify(observed), JSON.stringify(silent)); assert.deepEqual(on.trace, off.trace);
  assert.deepEqual(Array.from(observed, row => row.path), ["a", "dir/b", "dir/nested/c", "z"]);
  assert.equal(observed[0].sha256, createHash("sha256").update("unicode-音").digest("hex"));
  assert.ok(!on.trace.some(row => row[0] === "readFile" && /ignored|edge-context/.test(row[1])));
  assert.equal(off.frames.length, 0); assert.deepEqual(on.diagnostics.errors, []);
  // Producer and receiver styles see identical source inputs despite excluded
  // installation/receipt entries. All traversal runs use inert filesystem data.
  const producer = traversalBindings({ nodes: { "": ["a", "dir", "z"], dir: ["b", "nested"], "dir/nested": ["c"] }, noObservation: true });
  const manifest = await factory(producer.bindings)("/fixture"); assert.equal(JSON.stringify(manifest), JSON.stringify(observed));
});
test("enumeration diagnostics actual traversal locates every operation failure and preserves undefined", async () => {
  const factory = await extractedContextTraversal();
  for (const op of enumerationOperations) for (const reason of [new Error("inert original failure"), undefined]) {
    const fixture = traversalBindings({ fault: op, reason });
    let caught = false, error;
    try { await factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation); } catch (reason) { caught = true; error = reason; }
    assert.equal(caught, true, op);
    assert.equal(error, reason, op);
    fixture.diagnostics.finish(true, error);
    const row = parseNativePrepareStages(nativePrepareCapture(fixture.frames.join("")), stageIdentity);
    assert.equal(row.reason, "original_failure", op); assert.equal(row.stage, "context_enumeration"); assert.equal(row.records, 9);
    assert.equal(row.enumeration.op, op); assert.equal(row.enumeration.failed, true); assert.equal(row.enumeration.defined, reason !== undefined); validateContainerDiagnostic(row);
    assert.equal(fixture.frames.length, 9); assert.equal(fixture.frames.filter(frame => frame.includes('"enumeration"')).length, 1);
  }
});
test("enumeration diagnostics actual path type depth and capacity predicates remain independent", async () => {
  const factory = await extractedContextTraversal();
  const cases = [
    [{ nodes: { "": ["../bad"] } }, "path_check", "unknown", 0, 0, 0, false],
    [{ nodes: { "": ["special"] } }, "file_type_check", "other", 0, 0, 0, false],
    [{ nodes: { "": ["one"], one: ["two"], "one/two": ["leaf"] }, fault: "file_read" }, "file_read", "file", 2, 0, 0, false],
    [{ nodes: { "": ["large"] }, hugeBytes: 268435457 }, "capacity", "file", 0, 0, 268435456, true],
    [{ nodes: { "": Array.from({ length: 50001 }, (_, i) => String(i).padStart(5, "0")) }, traceLimit: 0 }, "capacity", "file", 0, 50000, 50001 * Buffer.byteLength("/fixture/00000"), false],
  ];
  for (const [options, op, type, depth, files, bytes, overflow] of cases) {
    const fixture = traversalBindings(options); let failed = false, error;
    try { await factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation); } catch (reason) { failed = true; error = reason; }
    assert.equal(failed, true); assert.equal(error, fixture.reason); fixture.diagnostics.finish(true, error);
    const row = parseNativePrepareStages(nativePrepareCapture(fixture.frames.join("")), stageIdentity);
    assert.deepEqual(row.enumeration, { op, type, depth, files, bytes, overflow, failed: true, defined: true });
  }
  const exact = traversalBindings({ nodes: { "": ["large"] }, hugeBytes: 268435456 });
  const result = await factory(exact.bindings)("/fixture", exact.controls, exact.observation);
  assert.equal(result.length, 1); assert.equal(result[0].bytes, 268435456); assert.equal(exact.frames.length, 8);
});
test("enumeration diagnostics original and reporter failures retain identity without exposing errors", async () => {
  const factory = await extractedContextTraversal();
  for (const reason of [Object.defineProperty({}, "message", { get() { assert.fail("error property inspected"); } }), undefined]) {
    const fixture = traversalBindings({ fault: "file_read", reason, reporterFailure: true }); let originalFailed = false, original;
    try { await factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation); } catch (error) { originalFailed = true; original = error; }
    assert.equal(originalFailed, true); assert.equal(original, reason);
    fixture.diagnostics.finish(originalFailed, original); assert.deepEqual(fixture.diagnostics.errors, [undefined]);
    const failures = [original, ...fixture.diagnostics.errors]; assert.equal(failures.length, 2); assert.equal(failures[0], reason); assert.equal(failures[1], undefined);
    const row = parseNativePrepareStages(nativePrepareCapture(fixture.frames.join("")), stageIdentity);
    assert.equal(row.enumeration.op, "file_read"); assert.equal(row.enumeration.defined, reason !== undefined);
  }
  const invalid = createNativePrepareDiagnostics(stageIdentity, (_bytes, _offset, length) => length);
  nativePrepareStages.slice(0, 8).forEach(stage => invalid.enter(stage));
  invalid.enumerationPoint("foreign", "unknown", 0, 0, 0); invalid.enumerationFailure(undefined); assert.equal(invalid.errors.length, 2);
});
test("enumeration diagnostics terminal schema quotas capture binding and private projections stay strict", async () => {
  const factory = await extractedContextTraversal(), fixture = traversalBindings({ fault: "file_read" });
  await assert.rejects(factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation), error => error === fixture.reason);
  fixture.diagnostics.finish(true, fixture.reason);
  const text = fixture.frames.join(""), original = nativePrepareCapture(text), summary = parseNativePrepareStages(original, stageIdentity);
  const corrupt = change => {
    const rows = fixture.frames.map(frame => JSON.parse(frame.slice(frame.indexOf(" {") + 1)));
    change(rows);
    return nativePrepareCapture(rows.map(row => "\nEDGE_NATIVE_PREPARE_V1 " + JSON.stringify(row) + "\n").join(""));
  };
  for (const change of [rows => rows[0].enumeration = rows.at(-1).enumeration, rows => rows.at(-1).enumeration.op = "foreign", rows => rows.at(-1).enumeration.type = "symlink", rows => rows.at(-1).enumeration.path = "private", rows => rows.at(-1).enumeration.defined = false, rows => rows.at(-1).enumeration.files = 50001, rows => rows.at(-1).enumeration.bytes = 268435457, rows => rows.at(-1).enumeration.depth = -1, rows => rows.at(-1).enumeration.overflow = 1, rows => rows.at(-1).enumeration.failed = false]) {
    const row = parseNativePrepareStages(corrupt(change), stageIdentity); assert.equal(row.reason, "invalid"); assert.equal(row.stage, null); assert.equal(Object.hasOwn(row, "enumeration"), false);
  }
  const missing = parseNativePrepareStages(nativePrepareCapture(fixture.frames.slice(0, -1).join("")), stageIdentity); assert.equal(missing.reason, "incomplete"); assert.equal(Object.hasOwn(missing, "enumeration"), false);
  const truncated = structuredClone(original); truncated.stdout = truncated.stdout.slice(0, -1); assert.equal(parseNativePrepareStages(truncated, stageIdentity).reason, "capture_mismatch");
  const context = ["entry", "module_import", "dispatch", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket", "identity", "context", "daemon", "base"].map(phase => ({ v: 2, phase, state: "fulfilled", defined: null, exit: null, signal: null }));
  const output = []; emitContainerFailure([...context, containerProcessDiagnostic(original), parseImageBuildStages(original, stageIdentity), summary, { v: 2, phase: "entry", state: "rejected", defined: true, exit: null, signal: null }], line => output.push(line));
  assert.equal(output.length, 10); assert.ok(output.every(line => line.startsWith("::error ") && Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192);
  for (const secret of [hex, other, "/fixture", "inert traversal", "sha256"]) assert.ok(!output.join("").includes(secret));
  const oversized = [], bounds = createNativePrepareDiagnostics(stageIdentity, (bytes, offset, length) => { oversized.push(bytes.subarray(offset, offset + length).toString()); return length; });
  nativePrepareStages.slice(0, 8).forEach(stage => bounds.enter(stage)); bounds.enumerationPoint("file_type_check", "other", 65536, 50001, 268435457); bounds.enumerationFailure(undefined); bounds.finish(true, undefined);
  assert.deepEqual(bounds.errors, []); assert.equal(oversized.length, 9); assert.ok(oversized.every(frame => Buffer.byteLength(frame) <= 512));
  const maximum = parseNativePrepareStages(nativePrepareCapture(oversized.join("")), stageIdentity); assert.equal(maximum.enumeration.overflow, true); validateContainerDiagnostic(maximum);
  let touched = false; const hostile = { ...summary.enumeration }; Object.defineProperty(hostile, "op", { get() { touched = true; throw undefined; } }); assert.throws(() => validateEnumerationDetail(hostile)); assert.equal(touched, false);
});
test("enumeration membership actual depth-four introduced files retain capacity rejection in each closed class", async () => {
  const factory = await extractedContextTraversal(), limit = 268435456, admitted = 200 * 1024 * 1024, added = 80 * 1024 * 1024;
  for (const [area, kind] of [[".git", 2], ["scripts", 3], ["extra", 4]]) {
    const path = `${area}/x/y/z/added`, nodes = { "": ["a", area], [area]: ["x"], [`${area}/x`]: ["y"], [`${area}/x/y`]: ["z"], [`${area}/x/y/z`]: ["added"] };
    // .git sorts before a, so put the admitted bytes in the first .git member.
    const member = area === ".git" ? ".git/a" : "a";
    if (area === ".git") { nodes[""] = [area]; nodes[area].push("a"); }
    const fixture = traversalBindings({ nodes, manifest: [{ path: member }, { path: "scripts/start.mjs" }], sizes: { ["/fixture/" + member]: admitted, ["/fixture/" + path]: added } });
    let failed = false, reason;
    try { await factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation); } catch (error) { failed = true; reason = error; }
    assert.equal(failed, true); assert.equal(reason, fixture.reason); fixture.diagnostics.finish(true, reason);
    const row = parseNativePrepareStages(nativePrepareCapture(fixture.frames.join("")), stageIdentity);
    const totals = [admitted, 0, 0, 0]; totals[kind - 1] = added;
    assert.deepEqual(row.enumeration, { op: "capacity", type: "file", depth: 4, files: 1, bytes: limit, overflow: true, failed: true, defined: true, m: [kind, ...totals, 0] });
    assert.equal(fixture.trace.filter(r => r[0] === "readFile").length, 2);
    assert.equal(fixture.trace.filter(r => r[0] === "hash").length, 1); assert.equal(fixture.trace.filter(r => r[0] === "file_record").length, 1);
    assert.deepEqual(fixture.diagnostics.errors, []);
  }
});
test("enumeration membership exact member and component boundaries do not infer cache producers", async () => {
  const factory = await extractedContextTraversal(), limit = 268435456;
  for (const [path, manifest, kind] of [[".git/x/y/z/leaf", [{ path: ".git/x/y/z/leaf" }], 1], [".gitx/leaf", [{ path: ".git/old" }], 4], ["scriptsevil/leaf", [{ path: "scripts/old" }], 4], ["newfile", [{ path: "existing" }], 4]]) {
    const parts = path.split("/"), nodes = {}; let prefix = "";
    for (const part of parts) { nodes[prefix] = [part]; prefix = prefix ? prefix + "/" + part : part; }
    const fixture = traversalBindings({ nodes, manifest, sizes: { ["/fixture/" + path]: limit + 1 }, reason: undefined });
    let failed = false;
    try { await factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation); } catch (error) { failed = true; assert.equal(error, undefined); }
    assert.equal(failed, true); fixture.diagnostics.finish(true, undefined);
    const row = parseNativePrepareStages(nativePrepareCapture(fixture.frames.join("")), stageIdentity), counts = [0, 0, 0, 0]; counts[kind - 1] = limit;
    assert.deepEqual(row.enumeration.m, [kind, ...counts, 1 << (kind - 1)]); assert.equal(row.enumeration.defined, false);
    assert.equal(row.enumeration.depth, parts.length - 1); assert.equal(row.enumeration.overflow, true);
  }
});
test("enumeration membership observer-off bytes and original member byte-closure remain unchanged", async () => {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8"), factory = await extractedContextTraversal();
  const same = source.match(/^const same = .*;$/m)[0], check = source.match(/  check\(same\(actual, inputPlan\.files\), "context-byte-closure"\);/)[0];
  const closure = new Function("actual", "inputPlan", "check", same + check);
  const options = { nodes: { "": ["a", "dir"], dir: ["b"] }, manifest: [{ path: "a" }, { path: "dir/b" }] };
  const on = traversalBindings(options), off = traversalBindings({ ...options, noObservation: true });
  const actual = await factory(on.bindings)("/fixture", on.controls, on.observation), original = await factory(off.bindings)("/fixture", off.controls);
  assert.equal(JSON.stringify(actual), JSON.stringify(original)); assert.deepEqual(on.trace, off.trace); assert.equal(off.frames.length, 0);
  const require = (ok, code) => { assert.equal(code, "context-byte-closure"); assert.ok(ok); };
  closure(actual, { files: original }, require);
  const changed = JSON.parse(JSON.stringify(original)); changed[0].bytes++;
  assert.throws(() => closure(actual, { files: changed }, require));
  assert.ok(on.frames.every(frame => !frame.includes('"enumeration"')));
});
test("enumeration membership unavailable manifest and independent reporter errors never invent zero totals", async () => {
  const factory = await extractedContextTraversal(); let getters = 0;
  const hostile = Object.defineProperty({}, "path", { get() { getters++; throw undefined; } });
  for (const manifest of [[hostile], [{ path: "../foreign" }], [{ path: "a" }, { path: "a" }], undefined]) {
    const fixture = traversalBindings({ nodes: { "": ["a"] }, manifest, fault: "file_read", reason: undefined, reporterFailure: true });
    let failed = false;
    try { await factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation); } catch (error) { failed = true; assert.equal(error, undefined); }
    assert.equal(failed, true); fixture.diagnostics.finish(true, undefined);
    const row = parseNativePrepareStages(nativePrepareCapture(fixture.frames.join("")), stageIdentity);
    assert.equal(row.reason, "original_failure"); assert.equal(row.enumeration.m, null); assert.equal(row.enumeration.defined, false);
    assert.equal(fixture.diagnostics.errors.length, 2); assert.equal(fixture.diagnostics.errors.at(-1), undefined);
  }
  assert.equal(getters, 0);
});
test("enumeration membership strict counters private framing and public budgets reject inconsistent evidence", async () => {
  const factory = await extractedContextTraversal(), fixture = traversalBindings({ nodes: { "": ["a"] }, manifest: [{ path: "a" }], sizes: { "/fixture/a": 268435457 } });
  await assert.rejects(factory(fixture.bindings)("/fixture", fixture.controls, fixture.observation), error => error === fixture.reason); fixture.diagnostics.finish(true, fixture.reason);
  const rows = fixture.frames.map(frame => JSON.parse(frame.slice(frame.indexOf(" {") + 1))), summary = parseNativePrepareStages(nativePrepareCapture(fixture.frames.join("")), stageIdentity);
  assert.deepEqual(summary.enumeration.m, [1, 268435456, 0, 0, 0, 1]);
  for (const enumeration of [null, true, 17, "private", []]) {
    const copy = structuredClone(rows); copy.at(-1).enumeration = enumeration;
    const parsed = parseNativePrepareStages(nativePrepareCapture(copy.map(row => "\nEDGE_NATIVE_PREPARE_V1 " + JSON.stringify(row) + "\n").join("")), stageIdentity);
    assert.equal(parsed.reason, "invalid"); assert.equal(Object.hasOwn(parsed, "enumeration"), false);
  }
  for (const change of [m => m[0] = 0, m => m[0] = 5, m => m[1]--, m => m[2] = -1, m => m[3] = 268435457, m => m[5] = 16, m => m[5] = 2, m => m[5] = 0, m => m.push(0), m => m[1] = null]) {
    const copy = structuredClone(rows); change(copy.at(-1).enumeration.m);
    const parsed = parseNativePrepareStages(nativePrepareCapture(copy.map(row => "\nEDGE_NATIVE_PREPARE_V1 " + JSON.stringify(row) + "\n").join("")), stageIdentity);
    assert.equal(parsed.reason, "invalid"); assert.equal(Object.hasOwn(parsed, "enumeration"), false);
  }
  let getters = 0; const hostile = [...summary.enumeration.m]; Object.defineProperty(hostile, "1", { get() { getters++; throw undefined; } });
  assert.throws(() => validateEnumerationDetail({ ...summary.enumeration, m: hostile })); assert.equal(getters, 0);
  const maximum = { ...summary, enumeration: { ...summary.enumeration, depth: 65535, files: 50000, m: [1, 268435456, 268435456, 268435456, 268435456, 15] } };
  validateContainerDiagnostic(maximum);
  const output = [], phases = ["entry", "module_import", "dispatch", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket"].map(phase => ({ v: 2, phase, state: "rejected", defined: true, exit: null, signal: null }));
  emitContainerFailure([...phases, maximum], line => output.push(line));
  assert.equal(output.length, 10); assert.ok(output.every(line => Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192);
  assert.ok(fixture.frames.every(frame => Buffer.byteLength(frame) <= 512));
  const worstFrames = [], worst = createNativePrepareDiagnostics(stageIdentity, (bytes, offset, length) => { worstFrames.push(bytes.subarray(offset, offset + length).toString()); return length; });
  nativePrepareStages.slice(0, 8).forEach(stage => worst.enter(stage)); worst.enumerationManifest([{ path: "member" }, { path: "dir/member" }]);
  ["member", ".git/added", "dir/added", "other/added"].forEach((path, i) => { worst.enumerationPath(path); worst.enumerationBytes((i + 1) * 268435457); });
  worst.enumerationPoint("file_type", "not_directory", 65536, 50001, 4 * 268435457); worst.enumerationFailure(undefined);
  worst.errors.push(...Array(32).fill(undefined)); worst.finish(true, undefined);
  assert.equal(worst.errors.length, 32); assert.equal(worstFrames.length, 9); assert.ok(worstFrames.every(frame => Buffer.byteLength(frame) <= 512));
  const worstSummary = parseNativePrepareStages(nativePrepareCapture(worstFrames.join("")), stageIdentity); assert.equal(worstSummary.reason, "original_failure"); assert.deepEqual(worstSummary.enumeration.m, [0, 268435456, 268435456, 268435456, 268435456, 15]);
  const wrongDepth = createNativePrepareDiagnostics(stageIdentity, (_bytes, _offset, length) => length);
  nativePrepareStages.slice(0, 8).forEach(stage => wrongDepth.enter(stage)); wrongDepth.enumerationManifest([{ path: "a/b" }]); wrongDepth.enumerationPath("a/b"); wrongDepth.enumerationPoint("file_read", "file", 0, 0, 0);
  assert.equal(wrongDepth.errors.length, 1);
  for (const text of [hex, other, "/fixture", "sha256", "pnpm", "a/b", "inert traversal"]) assert.ok(!output.join("").includes(text));
  const incomplete = parseNativePrepareStages(nativePrepareCapture(fixture.frames.slice(0, -1).join("")), stageIdentity); assert.equal(incomplete.reason, "incomplete");
});

// BEGIN attach diagnostic pure tests.
function inertAttach(spawnMode = "normal") {
  const child = new EventEmitter(), signals = new EventEmitter(), timers = new Map(); let next = 0, stops = 0, writes = 0;
  child.pid = 12345; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = (text, done) => { writes++; done(); };
  const attached = attachContainer("inert", [], { nonce: hex, contextHash: other, signalSource: signals,
    spawnProcess: () => { if (spawnMode === "throw") throw undefined; if (spawnMode === "setup") child.stdin = null; return child; },
    onStop: async () => { stops++; child.emit("close", 1, null); }, killGroup: () => {},
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; }, clearTimer: id => timers.delete(id),
  });
  return { child, signals, timers, attached, stops: () => stops, writes: () => writes, data: text => child.stdout.emit("data", Buffer.from(text)) };
}
const initReady = () => "EDGE_CONTAINER_V2 " + JSON.stringify({ v: 2, kind: "ready", nonce: hex, contextHash: other }) + "\n";
function inertInitOperations(failAt, calls) {
  return Object.fromEntries(["arguments", "identity", "reset", "prepare", "runtime", "native", "ready", "permit"].map(name => [name, (...args) => { calls.push({ name, args }); if (name === failAt) throw undefined; return name === "identity" ? identity : name === "native" ? imageId : undefined; }]));
}
async function initCapture(failAt, failWrite = false) {
  const frames = [], calls = [], trace = createInitDiagnostics(line => { if (failWrite) throw undefined; frames.push(line); });
  let failed = false, reason, value;
  try { value = await runInitPrerequisites([hex, other, "501", "20"], trace, inertInitOperations(failAt, calls)); } catch (error) { failed = true; reason = error; }
  return { frames, calls, trace, failed, reason, value };
}
async function attachWithFrames(text) {
  const h = inertAttach(); h.data(text); h.child.emit("close", 1, null); await h.attached.closed;
  return { h, binding: { attached: h.attached, cid: hex, nonce: hex, contextHash: other } };
}
test("attach diagnostic distinguishes spawn throw setup failure and synthetic settlement from child close", async () => {
  for (const mode of ["throw", "setup", "normal"]) {
    const h = inertAttach(mode); if (mode === "normal") h.child.emit("close", 2, null);
    await assert.rejects(h.attached.ready); const result = await h.attached.closed;
    assert.deepEqual(result.supervisor, mode === "throw" ? [true, false, true, false, false, true] : mode === "setup" ? [true, true, false, true, false, true] : [true, true, false, false, true, true]);
    assert.equal(result.closed, true); assert.equal(result.outputSummary.stdout.complete, mode === "normal");
    const rows = [], project = createAttachProjection(h.attached, { cid: hex, nonce: hex, contextHash: other }, { internal: row => rows.push(validateContainerDiagnostic(row)) });
    project(result); project(result); assert.equal(rows.length, 2); assert.equal(rows[0].supervisor[4], mode === "normal"); assert.equal(rows[1].reason, mode === "normal" ? "no_records" : "capture_unavailable");
  }
});
test("attach diagnostic original branch failures stop and settle without a real child or timer", async () => {
  for (const mode of ["child_error", "stdin_error", "partial", "invalid_ready", "foreign", "ready_deadline", "deadline", "interrupt", "output_capacity"]) {
    const h = inertAttach();
    if (mode === "child_error") h.child.emit("error", undefined);
    else if (mode === "stdin_error") h.child.stdin.emit("error", undefined);
    else if (mode === "partial") { h.data(initReady().slice(0, -1)); h.child.emit("close", 0, null); }
    else if (mode === "invalid_ready") h.data("EDGE_CONTAINER_V2 {bad}\n");
    else if (mode === "foreign") h.data(initReady().replace(hex, other));
    else if (mode === "interrupt") h.signals.emit("SIGTERM");
    else if (mode === "output_capacity") h.data("x".repeat(1024 * 1024 + 1));
    else [...h.timers.values()].find(timer => timer.delay === (mode === "deadline" ? 480000 : 30000)).callback();
    await assert.rejects(h.attached.ready); const result = await h.attached.closed;
    assert.equal(result.supervisor[4], true); assert.equal(result.supervisor[5], true); assert.equal(h.timers.size, 0);
    assert.equal(result.firstBranch, mode === "partial" ? "incomplete_ready" : mode === "foreign" ? "invalid_ready" : mode);
    if (mode !== "partial") assert.equal(h.stops(), 1);
    if (["child_error", "stdin_error"].includes(mode)) assert.ok(result.errors.includes(undefined));
    if (mode === "output_capacity") assert.equal(result.outputSummary.stdout.complete, false);
    await assert.rejects(h.attached.permit()); assert.equal(h.writes(), 0);
  }
});
test("attach diagnostic accepted READY replay and reporting failures cannot erase cleanup or earlier permit", async () => {
  const h = inertAttach(); h.data(initReady()); await h.attached.ready; await h.attached.permit(); assert.equal(h.writes(), 1);
  h.data(initReady()); const result = await h.attached.closed; assert.equal(result.readyAccepted, true); assert.equal(result.firstBranch, "replayed_ready"); assert.equal(h.stops(), 1);
  await assert.rejects(h.attached.permit()); assert.equal(h.writes(), 1);
  let attempts = 0; const project = createAttachProjection(h.attached, { cid: hex, nonce: hex, contextHash: other }, { internal() { attempts++; throw undefined; } });
  project(result); project(result); assert.equal(attempts, 2); assert.ok(result.errors.includes(undefined)); assert.equal(result.supervisor[5], true);
  const writeFailure = inertAttach(); writeFailure.data(initReady()); await writeFailure.attached.ready;
  writeFailure.child.stdin.end = () => { throw undefined; }; await assert.rejects(writeFailure.attached.permit());
  assert.equal(writeFailure.attached.result.firstBranch, "permit_write"); writeFailure.child.emit("close", 1, null); await writeFailure.attached.closed;
  assert.throws(() => raiseContainerFailures([undefined, new Error("independent retirement")]), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === undefined);
  const broken = inertAttach(); broken.attached.result.supervisor = new Proxy([], { set() { throw undefined; } });
  broken.child.emit("error", undefined); await assert.rejects(broken.attached.ready); const settled = await broken.attached.closed;
  assert.equal(broken.stops(), 1); assert.equal(broken.timers.size, 0); assert.ok(settled.errors.includes(undefined));
});
test("init prerequisite actual operations preserve order operands original undefined and reporter failures", async () => {
  const success = await initCapture(); assert.equal(success.failed, false); assert.equal(success.value, imageId); assert.equal(success.frames.length, 9);
  assert.deepEqual(success.calls.map(call => call.name), ["arguments", "identity", "reset", "prepare", "runtime", "native", "ready", "permit"]);
  assert.deepEqual(success.calls[0].args, [[hex, other, "501", "20"]]); assert.equal(success.calls[4].args[0], identity); assert.deepEqual(success.calls[6].args, [hex, other]);
  for (const [index, op] of success.calls.entries()) {
    const failed = await initCapture(op.name); assert.equal(failed.failed, true); assert.equal(failed.reason, undefined); assert.equal(failed.calls.length, index + 1);
    if (index) { const both = await initCapture(op.name, true); assert.ok(both.reason instanceof AggregateError); assert.equal(both.reason.errors[0], undefined); assert.equal(both.calls.length, Math.min(index + 1, 6)); }
    const { h, binding } = await attachWithFrames(failed.frames.join("")); const row = parseInitPrerequisites(h.attached.result, binding);
    assert.equal(row.reason, index === 0 ? "no_records" : "original_failure"); if (index) { assert.equal(row.stage, initPrerequisiteStages[index]); assert.equal(row.defined, false); }
  }
  const brokenTrace = createInitDiagnostics(() => {}); brokenTrace.enter = () => { throw undefined; };
  await assert.rejects(runInitPrerequisites([hex, other, "501", "20"], brokenTrace, inertInitOperations("arguments", [])), error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === undefined && error.errors[2] === undefined);
  const reports = await initCapture("runtime", true); assert.ok(reports.reason instanceof AggregateError); assert.equal(reports.reason.errors[0], undefined); assert.ok(reports.reason.errors.length > 1); assert.equal(reports.calls.length, 5);
  const onlyReports = await initCapture(undefined, true); assert.equal(onlyReports.failed, true); assert.equal(onlyReports.calls.length, 6);
});
test("init private parser rejects capture loss foreign identity incomplete duplicate and malformed frames", async () => {
  const captured = await initCapture(); const text = captured.frames.join("");
  const { h, binding } = await attachWithFrames(text); const result = h.attached.result;
  assert.equal(parseInitPrerequisites(result, binding).reason, "complete");
  assert.equal(parseInitPrerequisites(result, { ...binding, attached: {} }).reason, "binding_unavailable");
  for (const change of [r => r.supervisor[4] = false, r => r.outputSummary.stdout.complete = false, r => r.outputSummary.stderr.truncated = true]) {
    const row = structuredClone(result); change(row); assert.equal(parseInitPrerequisites(row, { ...binding, attached: { result: row } }).reason, "capture_unavailable");
  }
  for (const key of ["stdout", "stderr"]) { const saved = result[key]; result[key] += "lost"; assert.equal(parseInitPrerequisites(result, binding).reason, "capture_mismatch"); result[key] = saved; }
  for (const [mutate, expected] of [[s => s.replace(hex, other), "invalid"], [s => s + captured.frames[0], "invalid"], [s => s.replace('"seq":1', '"seq":2'), "invalid"], [s => s.replace('"event":"entered"', '"event":"foreign"'), "invalid"], [s => s.replace('"v":1', '"v":1,"secret":"private"'), "invalid"], [s => s.replace("EDGE_INIT_V1 ", "EDGE_INIT_V1 \x1b"), "invalid"], [s => s.slice(0, -1), "invalid"], [s => s.slice(0, s.lastIndexOf("\nEDGE_INIT_")), "incomplete"]]) {
    const v = await attachWithFrames(mutate(text)); assert.equal(parseInitPrerequisites(v.h.attached.result, v.binding).reason, expected);
  }
  const utf8 = inertAttach(); utf8.child.stdout.emit("data", Buffer.from([0xc3])); utf8.child.stdout.emit("data", Buffer.from([0xa9])); utf8.data(text); utf8.child.emit("close", 1, null); await utf8.attached.closed;
  assert.equal(parseInitPrerequisites(utf8.attached.result, { ...binding, attached: utf8.attached }).reason, "capture_unavailable");
  const decreasing = text.replace('"reportFailures":0,"undefinedReportFailures":0', '"reportFailures":1,"undefinedReportFailures":0');
  const nonmonotonic = await attachWithFrames(decreasing); assert.equal(parseInitPrerequisites(nonmonotonic.h.attached.result, nonmonotonic.binding).reason, "invalid");
  assert.ok(captured.frames.every(frame => Buffer.byteLength(frame) <= 512));
});
test("attach and init failure records retain priority privacy and independent retirement within quota", async () => {
  const captured = await initCapture("runtime"), { h, binding } = await attachWithFrames(captured.frames.join(""));
  const report = createContainerDiagnostics(); createAttachProjection(h.attached, binding, report)(h.attached.result);
  for (const phase of ["entry", "module_import", "dispatch", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "daemon", "base", "image", "create", "attach"]) report.mark(phase, "fulfilled");
  report.mark("ready", "entered"); report.mark("retirement", "entered"); report.mark("ready", "rejected", undefined); report.mark("retirement", "rejected", undefined);
  const lines = []; emitContainerFailure(report.records, line => lines.push(line)); const rows = lines.map(line => validateContainerDiagnostic(JSON.parse(line.slice(line.indexOf("::", 2) + 2))));
  for (const phase of ["ready", "attach_process", "init_prerequisite", "retirement"]) assert.ok(rows.some(row => row.phase === phase));
  assert.equal(rows.find(row => row.phase === "ready").state, "rejected"); assert.equal(rows.find(row => row.phase === "retirement").state, "rejected");
  assert.equal(lines.length, 10); assert.ok(lines.every(line => Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(lines.join("")) <= 8192); assert.ok(!lines.join("").includes(hex) && !lines.join("").includes(other));
  const complete = await initCapture(), positive = inertAttach(); positive.data(complete.frames.join("") + initReady()); await positive.attached.ready; await positive.attached.permit(); positive.child.emit("close", 0, null);
  const final = await positive.attached.closed, positiveRecords = []; const project = createAttachProjection(positive.attached, { cid: hex, nonce: hex, contextHash: other }, { internal: row => positiveRecords.push(validateContainerDiagnostic(row)) });
  project(final); project(final); assert.equal(positiveRecords.length, 2); assert.equal(positiveRecords[0].exit, 0); assert.deepEqual(positiveRecords[0].capture, [true, true]); assert.equal(positiveRecords[1].reason, "complete");
  const row = rows.find(row => row.v === 6); for (const change of [r => r.first = "private", r => r.supervisor = [], r => r.branches = 99999, r => r.stdout = "private"]) { const bad = structuredClone(row); change(bad); assert.throws(() => validateContainerDiagnostic(bad)); }
  let accessed = false; const bad = { ...row }; Object.defineProperty(bad, "errors", { get() { accessed = true; throw undefined; } }); assert.throws(() => validateContainerDiagnostic(bad)); assert.equal(accessed, false);
});
async function initGuardFactory(overrides = {}) {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const runtime = source.slice(source.indexOf("async function validateContainerRuntime("), source.indexOf("export function parseImageBuildReceipt("));
  const status = source.slice(source.indexOf("export function parseIdentity("), source.indexOf("export function validateMapping(")).replaceAll("export ", "") + source.slice(source.indexOf("export function validateChildStatus("), source.indexOf("async function readParentIdentity(")).replaceAll("export ", "");
  const mounts = source.slice(source.indexOf("export function createMountObservation("), source.indexOf("export function validateChildStatus(")).replaceAll("export ", "");
  const helpers = (source.slice(source.indexOf("export function createInitGuardLedger("), source.indexOf("const own =")) + source.slice(source.indexOf("export function createParentAdmissionLedger("), source.indexOf("const number ="))).replaceAll("export ", "");
  const declarations = source.slice(source.indexOf("const receiptRecord ="), source.indexOf("const exactKeys =")) + source.slice(source.indexOf("const same ="), source.indexOf("const hashPattern =")) + source.slice(source.indexOf("const number ="), source.indexOf("export function parseIdentity("));
  const goodStatus = "Groups:\t20\nUid:\t501 501 501 501\nGid:\t20 20 20 20\n" + ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(k => k + ":\t0000\n").join("") + "NoNewPrivs:\t1\nSeccomp:\t2\n";
  const calls = [], bindings = { parentAdmissionSources, parentAdmissionPredicates, parentAdmissionRoles, validateParentAdmission, initGuardTags, initSourcePhases, mountTargets, mountFilesystems, validateMountDetail, validateMaskDetail, raiseContainerFailures, process: { platform: "linux", arch: "x64", version: "v24.22.1", versions: { modules: "137" }, pid: 1, env: {} },
    readFile: async path => { calls.push(path); if (path.endsWith("status")) return goodStatus; if (path.endsWith("mountinfo")) return ""; return "{}"; }, namespaceEvidence: async () => ({ interfaces: ["lo"], routes4: [], routes6: [] }), containerEnvironment: () => ({}),
    validateNativeIdentity: value => value, qualifyImageInputs: async () => ({}), containerContract: { input: "/input" }, join: (...parts) => parts.join("/"), ...overrides };
  const api = new Function(...Object.keys(bindings), declarations + helpers + status + mounts + runtime + "return { validateContainerRuntime, nativeReceipt, validateChildStatus, parseIdentity, validateIdentity, parseMounts, validateMounts, mountTable, canonicalMountPath, decodeMountPath, createMountObservation, validateEmptyMasks, validateMaskCompletion, createInitGuardLedger, initGuardLeaf }; ")(...Object.values(bindings));
  const runtimeBindings = { ...bindings, validateChildStatus: api.validateChildStatus, parseMounts: api.parseMounts, validateMounts: api.validateMounts, ...overrides };
  const runtimeApi = new Function(...Object.keys(runtimeBindings), declarations + helpers.replace(/export /g, "") + runtime + "return { validateContainerRuntime, nativeReceipt }; ")(...Object.values(runtimeBindings));
  return { ...api, ...runtimeApi, calls, goodStatus };
}
test("init guard actual validators retain short circuit and default outcomes", async () => {
  const api = await initGuardFactory();
  for (const [mutate, guard] of [[s => s.replace("501 501 501 501", "0 0 0 0"), "uid_gid_groups"], [s => s.replace("CapEff:\t0000", "CapEff:\t0001"), "capabilities"], [s => s.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"), "nnp"], [s => s.replace("Seccomp:\t2", "Seccomp:\t0"), "seccomp"]]) {
    const ledger = api.createInitGuardLedger(); ledger.source("status_validate");
    assert.throws(() => api.validateChildStatus(mutate(api.goodStatus), identity, ledger)); assert.equal(ledger.failure().guard, guard);
    assert.throws(() => api.validateChildStatus(mutate(api.goodStatus), identity));
  }
  const status = api.goodStatus.replace("Groups:\t20", "Groups:\t20 20").replace("Uid:\t501", "Uid:\tinvalid");
  assert.throws(() => api.parseIdentity(status), error => error.message === "edge-container: identity-groups");
  let touched = false; const ledger = api.createInitGuardLedger(); ledger.source("status_validate");
  assert.throws(() => api.validateIdentity({ uid: [], get gid() { touched = true; throw undefined; } }, identity, true, ledger)); assert.equal(touched, false);
  const mounts = api.createInitGuardLedger(); mounts.source("mount_parse"); assert.throws(() => api.parseMounts("", true, mounts)); assert.equal(mounts.failure().guard, "mounts");
  const valid = api.createInitGuardLedger(); valid.source("status_validate"); assert.equal(api.validateChildStatus(api.goodStatus, identity, valid), undefined); assert.equal(api.validateChildStatus(api.goodStatus, identity), undefined); assert.equal(valid.failure().guard, null);
});
test("init guard invocation ledger separates prerequisites false predicates and original undefined", async () => {
  const original = undefined;
  for (const phase of ["status_read", "native_read", "native_qualify"]) {
    const api = await initGuardFactory({ readFile: async () => { if (phase !== "native_qualify") throw original; return "{}"; }, qualifyImageInputs: async () => { throw original; } });
    const ledger = api.createInitGuardLedger();
    await assert.rejects(phase === "status_read" ? api.validateContainerRuntime(identity, false, ledger) : api.nativeReceipt(other, ledger), error => error === original);
    assert.deepEqual(ledger.failure(), { guard: null, source: phase });
  }
  for (const [overrides, expected] of [[{ process: { platform: "other" } }, "runtime"], [{ process: { platform: "linux", arch: "x64", version: "v24.22.1", versions: { modules: "137" }, pid: 2 } }, "ancestry"], [{ qualifyImageInputs: async () => ({ changed: true }) }, "native_receipt_equality"]]) {
    const api = await initGuardFactory(overrides), ledger = api.createInitGuardLedger();
    await assert.rejects(expected.startsWith("native") ? api.nativeReceipt(other, ledger) : api.validateContainerRuntime(identity, false, ledger)); assert.equal(ledger.failure().guard, expected);
  }
  for (const tag of initGuardTags) { const ledger = createInitGuardLedger(); ledger.source(tag === "native_receipt_equality" ? "native_equality" : "runtime"); initGuardLeaf(false, ledger, tag); initGuardLeaf(false, ledger, "ancestry"); assert.equal(ledger.failure().guard, tag); }
  const a = createInitGuardLedger(), b = createInitGuardLedger(); a.source("runtime"); b.source("ancestry"); initGuardLeaf(false, a, "runtime"); assert.equal(a.failure().guard, "runtime"); assert.equal(b.failure().guard, null); a.source("ancestry"); assert.equal(a.errors.length, 1); assert.equal(a.failure().source, "runtime");
  const trace = createInitDiagnostics(() => {}), ledger = createInitGuardLedger(); ledger.source = () => { throw undefined; };
  const api = await initGuardFactory({ readFile: async () => { throw undefined; } }); const ops = inertInitOperations(undefined, []); ops.runtime = () => api.validateContainerRuntime(identity, false, ledger);
  await assert.rejects(runInitPrerequisites([hex, other, "501", "20"], trace, ops, ledger), error => error instanceof AggregateError && error.errors[0] === undefined && error.errors.slice(1).includes(undefined));
});
test("init guard actual runtime network leaves and native receipt phases preserve short circuit", async () => {
  for (const tag of ["interfaces", "routes4", "routes6", "effective_env"]) {
    const evidence = { interfaces: tag === "interfaces" ? ["foreign"] : ["lo"], routes4: tag === "routes4" ? ["foreign"] : [], routes6: tag === "routes6" ? ["invalid"] : [] };
    let touched = false; if (tag === "interfaces") Object.defineProperty(evidence, "routes4", { get() { touched = true; throw undefined; } });
    const api = await initGuardFactory({ parseMounts: value => value, validateMounts: () => true, namespaceEvidence: async () => evidence, containerEnvironment: () => tag === "effective_env" ? { X: "closed" } : {} }), ledger = api.createInitGuardLedger();
    await assert.rejects(api.validateContainerRuntime(identity, false, ledger)); assert.equal(ledger.failure().guard, tag); assert.equal(touched, false);
  }
  for (const [source, overrides] of [["native_parse", { readFile: async () => "{" }], ["native_validate", { validateNativeIdentity: () => { throw undefined; } }], ["namespace_read", { namespaceEvidence: async () => { throw undefined; }, parseMounts: value => value, validateMounts: () => true }]]) {
    const api = await initGuardFactory(overrides), ledger = api.createInitGuardLedger();
    await assert.rejects(source === "namespace_read" ? api.validateContainerRuntime(identity, false, ledger) : api.nativeReceipt(other, ledger)); assert.deepEqual(ledger.failure(), { guard: null, source });
  }
});
test("init guard private terminal detail is bounded identity bound and absent after unrelated later failure", async () => {
  const frames = [], trace = createInitDiagnostics(line => frames.push(line)), ledger = createInitGuardLedger(), ops = inertInitOperations(undefined, []);
  ops.runtime = () => { ledger.source("network_validate"); initGuardLeaf(false, ledger, "interfaces"); throw undefined; };
  await assert.rejects(runInitPrerequisites([hex, other, "501", "20"], trace, ops, ledger), error => error === undefined);
  const v = await attachWithFrames(frames.join("")), row = parseInitPrerequisites(v.h.attached.result, v.binding);
  assert.deepEqual(row.detail, { guard: "interfaces", source: "network_validate" }); assert.equal(row.defined, false); assert.ok(frames.every(line => Buffer.byteLength(line) <= 512));
  for (const detail of [{ guard: "foreign", source: "runtime" }, { guard: "seccomp", source: "native_read" }, { guard: null, source: "private" }]) assert.throws(() => validateInitDetail(detail));
  const broken = structuredClone(row); broken.detail.source = "native_equality"; broken.detail.guard = "native_receipt_equality"; assert.throws(() => validateContainerDiagnostic(broken));
  const sharedError = new Error("owned synthetic");
  const concurrent = await Promise.all(["runtime", "ancestry"].map(async tag => {
    const records = [], trace = createInitDiagnostics(line => records.push(line)), ledger = createInitGuardLedger(), operations = inertInitOperations(undefined, []);
    operations.runtime = () => { ledger.source(tag); initGuardLeaf(false, ledger, tag); throw sharedError; };
    await assert.rejects(runInitPrerequisites([hex, other, "501", "20"], trace, operations, ledger), error => error === sharedError);
    const captured = await attachWithFrames(records.join("")); return parseInitPrerequisites(captured.h.attached.result, captured.binding).detail;
  }));
  assert.deepEqual(concurrent, [{ guard: "runtime", source: "runtime" }, { guard: "ancestry", source: "ancestry" }]);
  const maximum = createInitDiagnostics(line => assert.ok(Buffer.byteLength(line) <= 512)); maximum.enter("arguments"); maximum.bind(hex, other);
  for (const stage of initPrerequisiteStages.slice(1, 6)) maximum.enter(stage);
  maximum.finish(true, undefined, { guard: "native_receipt_equality", source: "native_equality" }, Array(16).fill(undefined)); assert.equal(maximum.errors.length, 0);
  const later = [], laterTrace = createInitDiagnostics(line => later.push(line)), fresh = createInitGuardLedger(), laterOps = inertInitOperations("ready", []); laterOps.runtime = () => fresh.source("environment_validate");
  await assert.rejects(runInitPrerequisites([hex, other, "501", "20"], laterTrace, laterOps, fresh)); assert.equal(Object.hasOwn(JSON.parse(later.at(-1).trim().slice("EDGE_INIT_V1 ".length)), "detail"), false);
});
const mountDiagnosticCases = [];
function observedMountFailure(operation, predicate, leaf, source = "mount_validate") {
  const ledger = createInitGuardLedger(); ledger.source(source); let failed = false, reason;
  try { operation(ledger); } catch (error) { failed = true; reason = error; }
  assert.equal(failed, true); assert.deepEqual(ledger.errors, []);
  const detail = ledger.failure(); assert.equal(detail.guard, "mounts"); assert.equal(detail.m[1], predicate); assert.equal(detail.m[2], leaf); validateInitDetail(detail);
  mountDiagnosticCases.push(detail); return { detail, reason };
}
test("mount diagnostics actual path parser and table predicates identify original false leaves", async () => {
  const api = await initGuardFactory();
  for (const [value, leaf] of [[null, 1], ["relative", 2], ["/a\0", 3], ["/a/../b", 4]]) observedMountFailure(r => api.canonicalMountPath(value, r, "root"), 1, leaf);
  observedMountFailure(r => api.decodeMountPath(String.raw`/a\999`, r, "root"), 2, 1, "mount_parse");
  for (const [value, leaf] of [[null, 1], [[], 2], [Array(4096), 3]]) observedMountFailure(r => api.mountTable(value, r), 3, leaf);
  for (const [key, value, leaf] of [["id", 1.5, 1], ["id", 0, 2], ["parentId", 0.5, 3], ["parentId", -1, 4], ["device", "bad", 5]]) { const rows = mounts(); rows[0][key] = value; observedMountFailure(r => api.mountTable(rows, r), 4, leaf); }
  for (const [value, leaf] of [[null, 1], ["bad space", 2]]) { const rows = mounts(); rows[0].fs = value; observedMountFailure(r => api.mountTable(rows, r), 5, leaf); }
  for (const [field, predicate] of [["options", 6], ["superOptions", 7]]) for (const [value, leaf] of [[null, 1], [[], 2], [[null], 3], [["rw", "rw"], 4], [["nosuid"], 5]]) { const rows = mounts(); rows[0][field] = value; observedMountFailure(r => api.mountTable(rows, r), predicate, leaf); }
  { const rows = mounts(); rows[0].optional = null; observedMountFailure(r => api.mountTable(rows, r), 8, 1); }
  for (const [field, leaf] of [["id", 1], ["target", 2]]) { const rows = mounts(); rows[1][field] = rows[0][field]; observedMountFailure(r => api.mountTable(rows, r), 9, leaf); }
  for (const [value, leaf] of [[null, 1], ["", 2], ["x".repeat(128 * 1024), 3]]) observedMountFailure(r => api.parseMounts(value, true, r), 10, leaf, "mount_parse");
  const line = "1 0 0:1 / / ro - overlay none rw\n";
  observedMountFailure(r => api.parseMounts("invalid", true, r), 11, 1, "mount_parse");
  for (const [value, leaf] of [["1 0 / ro - overlay none rw\n", 1], [line.replace("overlay none rw", "overlay none"), 2], [line.replace(" ro -", " ro  -"), 3], [line.replace("1 0", "01 0"), 4], [line.replace("1 0", "1 -1"), 5]]) observedMountFailure(r => api.parseMounts(value, true, r), 12, leaf, "mount_parse");
  for (const [option, leaf] of [["invalid", 1], ["shared:1", 2]]) observedMountFailure(r => api.parseMounts(line.replace(" ro -", ` ro ${option} -`), true, r), 13, leaf, "mount_parse");
});
test("mount diagnostics actual topology and branch checks preserve row and aggregate attribution", async () => {
  const api = await initGuardFactory();
  const fail = (target, change, predicate, leaf) => { const rows = mounts(); change(rows.find(row => row.target === target), rows); return observedMountFailure(r => api.validateMounts(rows, r), predicate, leaf); };
  const unexpected = [...mounts(), mount(500, 100, "/unlisted", "tmpfs", "0:88", ["ro"], "/", ["ro"])];
  const topology = observedMountFailure(r => api.validateMounts(unexpected, r), 14, 2); assert.equal(topology.detail.m[3], 1); assert.deepEqual(topology.detail.m.slice(6, 8), [3, 0]);
  const missing = mounts().filter(row => row.target !== "/dev/pts"), absent = observedMountFailure(r => api.validateMounts(missing, r), 15, 1); assert.equal(absent.detail.m[3], mountTargets.indexOf("/dev/pts") + 2);
  fail("/", r => r.options = ["rw"], 16, 1); fail("/", r => r.root = "/other", 16, 2); fail("/", r => r.fs = "tmpfs", 16, 3);
  { const rows = mounts(); let calls = 0; rows.filter = function(callback) { calls++; return calls === 2 ? [] : Array.prototype.filter.call(this, callback); }; const noParent = observedMountFailure(r => api.validateMounts(rows, r), 17, 1); assert.equal(noParent.detail.m[3], null); assert.equal(calls, 2); }
  fail("/task", r => r.parentId = 99, 17, 2);
  for (const [change, leaf] of [[r => r.fs = "ext4", 1], [r => r.root = "/other", 2], [r => r.device = "8:1", 3], [r => r.options = ["ro", "nosuid", "nodev", "noexec"], 4], [r => r.options = ["rw", "nodev", "noexec"], 6], [r => r.options = ["rw", "nosuid", "noexec"], 7], [r => r.options = ["rw", "nosuid", "nodev"], 8]]) fail("/task", change, 18, leaf);
  fail("/sys", r => r.options = ["rw", "nosuid", "nodev", "noexec"], 18, 5);
  fail("/etc/hosts", r => r.fs = "tmpfs", 19, 1); fail("/etc/hosts", r => r.options = ["rw"], 19, 2);
  for (const [change, leaf] of [[r => r.fs = "ext4", 1], [r => r.device = "0:99", 2], [r => r.root = "/other", 3], [r => r.options = ["rw", "nosuid", "nodev", "noexec"], 4], [r => r.options = ["ro", "nodev", "noexec"], 5], [r => r.options = ["ro", "nosuid", "noexec"], 6], [r => r.options = ["ro", "nosuid", "nodev"], 7]]) fail("/proc/bus", change, 20, leaf);
  for (const [change, leaf] of [[r => r.fs = "ext4", 1], [r => r.device = "0:99", 2], [r => r.root = "/other", 3], [r => r.options.push("noexec"), 4], [r => r.superOptions.push("extra"), 5]]) fail("/proc/kcore", change, 21, leaf);
  for (const [change, leaf] of [[r => r.fs = "ext4", 1], [r => r.device = "8:1", 2], [r => r.root = "/other", 3], [r => r.options = ["rw"], 4], [r => r.superOptions = ["rw"], 5], [r => r.device = "0:2", 6]]) fail("/sys/firmware", change, 27, leaf);
  const alias = fail("/task", r => r.device = "0:3", 23, 1); assert.equal(alias.detail.m[3], null); assert.deepEqual(alias.detail.m.slice(8, 10), [8, 7]);
  fail("/task", r => r.superOptions = ["rw", "size=1k"], 24, 1); fail("/dev", (r, rows) => { r.superOptions = ["rw", "size=1k", "mode=755"]; rows.find(row => row.target === "/proc/kcore").superOptions = [...r.superOptions]; }, 25, 1); fail("/dev", (r, rows) => { r.superOptions = ["rw", "size=65536k", "mode=700"]; rows.find(row => row.target === "/proc/kcore").superOptions = [...r.superOptions]; }, 25, 2);
  fail("/dev/shm", r => r.superOptions = ["rw", "size=1k"], 26, 1);
});
test("mount diagnostics getters retain exact read order no coercion and operand undefined", async () => {
  const api = await initGuardFactory(), expected = ["id", "id", "parentId", "parentId", "device", "target", "root", "fs"];
  for (const observed of [false, true]) {
    const reads = [], values = { id: 1, parentId: 0, device: "0:1", target: "/", root: "/", fs: { toString() { assert.fail("observer coercion"); } } }, row = {};
    for (const key of Object.keys(values)) Object.defineProperty(row, key, { get() { reads.push(key); return values[key]; } });
    const ledger = observed ? createInitGuardLedger() : undefined; ledger?.source("mount_validate"); assert.throws(() => api.mountTable([row], ledger)); assert.deepEqual(reads, expected);
    if (observed) assert.equal(ledger.failure().m[1], 5);
  }
  const row = mounts()[0], ledger = createInitGuardLedger(); ledger.source("mount_validate"); Object.defineProperty(row, "fs", { get() { throw undefined; } });
  assert.throws(() => api.mountTable([row], ledger), error => error === undefined); assert.equal(ledger.failure().guard, null); assert.equal(Object.hasOwn(ledger.failure(), "m"), false);
  const thermal = mount(500, 107, "/sys/devices/system/cpu/cpu0/thermal_throttle", "tmpfs", "0:88", ["ro"], "/", ["ro"]), success = createInitGuardLedger(); success.source("mount_validate"); assert.equal(api.validateMounts([...mounts(), thermal], success), true); assert.equal(success.failure().guard, null); assert.equal(Object.hasOwn(success.failure(), "m"), false);
  const later = mounts(); later.find(row => row.target === "/task").superOptions = ["rw"]; observedMountFailure(r => api.validateMounts([...later, thermal], r), 24, 1);
});
test("mount diagnostics saturation and recorder faults cannot change original comparisons", async () => {
  const api = await initGuardFactory(), ledger = createInitGuardLedger(); ledger.source("mount_validate");
  const observation = api.createMountObservation(ledger, 23); assert.throws(() => observation.check(observation.leaf(1, observation.value("distinct", 5000) === observation.value("count", 5001)), "original-inequality"));
  const tuple = ledger.failure().m; assert.deepEqual(tuple.slice(6), [1, 0, 4095, 4095, 3]); validateMountDetail(tuple, "mount_validate");
  const unsaturated = [...tuple]; unsaturated[10] = 0; assert.throws(() => validateMountDetail(unsaturated, "mount_validate"));
  const broken = createInitGuardLedger(); broken.source("mount_validate"); broken.mount = () => { throw undefined; };
  const rows = mounts(); rows[0].options = ["rw"]; assert.throws(() => api.validateMounts(rows, broken)); assert.deepEqual(broken.errors, [undefined]); assert.equal(Object.hasOwn(broken.failure(), "m"), false);
  const stale = api.createMountObservation(ledger, 23); assert.throws(() => stale.check(stale.leaf(1, false), "still-original")); assert.equal(ledger.errors.length, 2); assert.deepEqual(ledger.failure().m, tuple);
});
test("mount diagnostics strict tuple relationships and maximum frames preserve closed binding", async () => {
  assert.equal(new Set(mountDiagnosticCases.map(detail => detail.m[1])).size, 26);
  let maximumPrivate = 0, maximumPublic = 0;
  for (const detail of mountDiagnosticCases) {
    const frames = [], trace = createInitDiagnostics(line => frames.push(line));
    trace.enter("arguments"); trace.bind(hex, other); for (const stage of initPrerequisiteStages.slice(1, 5)) trace.enter(stage);
    trace.finish(true, undefined, detail, Array(16).fill(undefined)); assert.deepEqual(trace.errors, []);
    maximumPrivate = Math.max(maximumPrivate, ...frames.map(line => Buffer.byteLength(line)));
    const captured = await attachWithFrames(frames.join("")), parsed = parseInitPrerequisites(captured.h.attached.result, captured.binding);
    assert.deepEqual(parsed.detail, detail); assert.equal(parsed.defined, false); assert.equal(parsed.reportFailures, 16);
    const report = createContainerDiagnostics(); createAttachProjection(captured.h.attached, captured.binding, report)(captured.h.attached.result);
    for (const phase of ["entry", "dispatch", "ready", "retirement"]) report.mark(phase, "rejected", undefined);
    for (const phase of ["module_import", "host_runtime", "cwd", "temp", "environment", "image", "base", "create"]) report.mark(phase, "fulfilled");
    const lines = []; emitContainerFailure(report.records, line => lines.push(line)); maximumPublic = Math.max(maximumPublic, ...lines.map(line => Buffer.byteLength(line)));
    assert.equal(lines.length, 10); assert.ok(Buffer.byteLength(lines.join("")) <= 8192); assert.ok(!lines.join("").includes(hex) && !lines.join("").includes(other));
    const altered = frames.join("").replace('"m":[1,', '"m":[2,'); const invalid = await attachWithFrames(altered); assert.equal(parseInitPrerequisites(invalid.h.attached.result, invalid.binding).reason, "invalid");
  }
  assert.ok(maximumPrivate <= 512); assert.ok(maximumPublic <= 768);
  const sample = mountDiagnosticCases.find(detail => detail.m[1] === 18).m;
  for (const change of [r => r[0] = 2, r => r[1] = 99, r => r[2] = 9, r => r[3] = 1, r => r[4] = 99, r => r[5] = 99, r => r[6] = 512, r => r[7] = 255, r => r[8] = 9000, r => r[9] = 1, r => r[10] = 1, r => r.push(0)]) { const invalid = [...sample]; change(invalid); assert.throws(() => validateMountDetail(invalid, "mount_validate")); }
  assert.throws(() => validateMountDetail(sample, "mount_parse"));
  let getter = false; const hostile = [...sample]; Object.defineProperty(hostile, "3", { get() { getter = true; throw undefined; } }); assert.throws(() => validateMountDetail(hostile, "mount_validate")); assert.equal(getter, false);
});
test("mount diagnostics each structural leaf and original unobserved operand relation is exercised", () => {
  const covered = new Set(mountDiagnosticCases.map(detail => `${detail.m[1]}:${detail.m[2]}`));
  for (const [index, [, width]] of mountPredicates.entries()) for (let leaf = 1; leaf <= width; leaf++) {
    // Parent-only predicates 29 and 30 are exercised through actual parent helpers below.
    // A failed OR has both operands false; the first false is not a terminal leaf.
    if (index + 1 === 22 || index + 1 === 28 || index + 1 === 29 || index + 1 === 30 || index + 1 === 14 && leaf === 1) continue;
    assert.ok(covered.has(`${index + 1}:${leaf}`), `missing original predicate ${index + 1} leaf ${leaf}`);
  }
  const firstFs = mountDiagnosticCases.find(detail => detail.m[1] === 18 && detail.m[2] === 1).m;
  assert.equal(firstFs[5], null); assert.equal(firstFs[6], 1); assert.equal(firstFs[7], 0);
});
const contradictoryMountEnums = [];
test("mount diagnostics reject valid-range enum contradictions without inventing uncaptured operands", async () => {
  const fs = name => mountFilesystems.indexOf(name) + 2;
  contradictoryMountEnums.push([1, 16, 2, 2, null, 1, 3, 1, null, null, 0]);
  const api = await initGuardFactory();
  for (const target of ["/task", "/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup"]) {
    const rows = mounts(); rows.find(row => row.target === target).fs = "ext4";
    observedMountFailure(r => api.validateMounts(rows, r), 18, 1);
  }
  for (const detail of mountDiagnosticCases) {
    const m = detail.m, predicate = m[1]; validateMountDetail(m, detail.source);
    const opposite = (index, bit, yes, no) => { if (m[index] === null) return; const copy = [...m]; copy[index] = m[7] & 2 ** (bit - 1) ? no : yes; contradictoryMountEnums.push(copy); };
    if (predicate === 16) { opposite(5, 2, 1, 3); opposite(4, 3, fs("overlay"), fs("tmpfs")); }
    if (predicate === 18) {
      const expected = { "/task": "tmpfs", "/proc": "proc", "/dev": "tmpfs", "/dev/pts": "devpts", "/dev/shm": "tmpfs", "/dev/mqueue": "mqueue", "/sys": "sysfs", "/sys/fs/cgroup": "cgroup2" }[mountTargets[m[3] - 2]];
      opposite(4, 1, fs(expected), 1); opposite(5, 2, 1, 3);
    }
    if (predicate === 19) opposite(4, 1, fs("ext4"), fs("tmpfs"));
    if (predicate === 20) opposite(4, 1, fs("proc"), fs("tmpfs"));
    if (predicate === 21) opposite(5, 3, 2, 1);
    if (predicate === 27) { opposite(4, 1, fs("tmpfs"), fs("proc")); opposite(5, 3, 1, 2); }
  }
  for (const m of contradictoryMountEnums) assert.throws(() => validateMountDetail(m, "mount_validate"));
  for (const predicate of [16, 18, 19, 20, 21, 27]) assert.ok(contradictoryMountEnums.some(m => m[1] === predicate));
  for (const detail of mountDiagnosticCases.filter(d => [1, 5].includes(d.m[1]))) {
    const invalid = [...detail.m]; invalid[invalid[1] === 1 ? 5 : 4] = invalid[1] === 1 ? 1 : fs("proc");
    assert.throws(() => validateMountDetail(invalid, detail.source));
  }
  // These RHS values were not captured; their result cannot be inferred from a role or earlier row.
  for (const detail of mountDiagnosticCases.filter(d => d.m[1] === 20 && d.m[5] !== null || d.m[1] === 21 && d.m[4] !== null)) {
    for (const value of detail.m[1] === 20 ? [1, 2, 3, null] : [1, fs("proc"), fs("tmpfs"), null]) {
      const unknown = [...detail.m]; unknown[unknown[1] === 20 ? 5 : 4] = value; validateMountDetail(unknown, detail.source);
    }
  }
});
test("mount diagnostics framed parser refuses contradictory enums with complete bound capture", async () => {
  const detail = mountDiagnosticCases.find(d => d.m[1] === 16 && d.m[2] === 2), frames = [], trace = createInitDiagnostics(line => frames.push(line));
  trace.enter("arguments"); trace.bind(hex, other); for (const stage of initPrerequisiteStages.slice(1, 5)) trace.enter(stage);
  trace.finish(true, undefined, detail); assert.deepEqual(trace.errors, []);
  const records = frames.map(frame => JSON.parse(frame.trim().slice("EDGE_INIT_V1 ".length)));
  for (const m of contradictoryMountEnums) {
    const altered = structuredClone(records); altered.at(-1).detail.m = m;
    const captured = await attachWithFrames(altered.map(row => "\nEDGE_INIT_V1 " + JSON.stringify(row) + "\n").join(""));
    const result = captured.h.attached.result; assert.equal(result.supervisor[4], true);
    assert.equal(result.outputSummary.stdout.complete, true); assert.equal(result.outputSummary.stderr.complete, true);
    const parsed = parseInitPrerequisites(result, captured.binding); assert.equal(parsed.reason, "invalid"); assert.equal(Object.hasOwn(parsed, "detail"), false);
  }
});
function inertMasks(options = {}) {
  const rows = options.rows ?? [...mounts(), mount(121, 102, "/proc/acpi", "tmpfs", "0:10", ["ro"], "/", ["ro"]), mount(122, 102, "/proc/scsi", "tmpfs", "0:10", ["ro"], "/", ["ro"])];
  const calls = [], state = { ready: false, readEntered: false, dirClosed: 0, anchorClosed: 0 }; let active, fd = 40, snapshots = 0, namespaces = 0;
  const fault = name => { calls.push(name); if (options.fail === name) throw undefined; };
  const stats = kind => ({ dev: 1n, ino: BigInt(active.id + 1000 + (options.mismatch && kind === "named" ? 1 : 0)), isDirectory: () => options.notDirectory !== kind });
  const io = {
    constants: { O_RDONLY: 0, O_DIRECTORY: 65536, O_NOFOLLOW: 131072 },
    realpath: async path => { fault("realpath"); return options.symlink ? "/unadmitted" : path; },
    lstat: async () => { fault("lstat"); return stats("named"); },
    readlink: async path => {
      fault("readlink");
      if (path === "/proc/self/ns/mnt") return `mnt:[${++namespaces > 1 && options.namespaceDrift ? 2 : 1}]`;
      assert.equal(path, `/proc/self/fd/${fd}`); return options.linkMismatch ? "/unadmitted" : active.target;
    },
    readFile: async path => {
      fault("readFile");
      if (path === "/proc/self/mountinfo") {
        snapshots++; return rows.map((r, i) => `${r.id + (options.mountDrift && snapshots > 1 && i === 0 ? 999 : 0)} ${r.parentId} ${r.device} ${r.root} ${r.target} ${r.options.join(",")} - ${r.fs} none ${r.superOptions.join(",")}`).join("\n") + "\n";
      }
      assert.equal(path, `/proc/self/fdinfo/${fd}`); return `mnt_id:\t${active.id + (options.mountMismatch ? 1 : 0)}\nino:\t${active.id + 1000}\n`.replaceAll("\\t", "\t").replaceAll("\\n", "\n");
    },
    open: async (path, flags) => {
      fault("open"); assert.equal(flags, 196608); active = rows.find(r => r.target === path); assert.ok(active); fd++;
      return { get fd() { fault("fd"); return fd; }, stat: async opts => { fault("stat"); assert.deepEqual(opts, { bigint: true }); return stats("held"); }, close() { state.anchorClosed++; fault("anchorClose"); return options.anchorPending ?? Promise.resolve(); } };
    },
    opendir: async (path, opts) => {
      fault("opendir"); assert.equal(path, `/proc/self/fd/${fd}`); assert.deepEqual(opts, { bufferSize: 1, recursive: false });
      return { read() { state.readEntered = true; fault("read"); if (options.readPending) return options.readPending; return Promise.resolve(options.nonempty ? Object.defineProperty({}, "name", { get() { assert.fail("entry name inspected"); } }) : null); }, close() { state.dirClosed++; fault("dirClose"); return options.dirPending ?? Promise.resolve(); } };
    },
  };
  return { rows, io, calls, state };
}
test("closed directory alias profile checks every member and excludes every other mount class", async () => {
  const api = await initGuardFactory(), valid = inertMasks(); assert.equal(api.validateMounts(valid.rows), true);
  const thermal = mount(123, 107, "/sys/devices/system/cpu/cpu0/thermal_throttle", "tmpfs", "0:10", ["ro"], "/", ["ro"]);
  for (const rows of [[...valid.rows, thermal], [...valid.rows, thermal].reverse()]) assert.equal(api.validateMounts(rows), true);
  for (const mutate of [r => r.fs = "ext4", r => r.root = "/other", r => r.options = ["rw"], r => r.superOptions = ["rw"], r => r.device = "8:1", r => r.target = "/extra"]) {
    const rows = structuredClone(valid.rows); mutate(rows.at(-1)); assert.throws(() => api.validateMounts(rows));
  }
  for (const target of ["/", "/task", "/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup", "/etc/hosts", "/proc/bus", "/proc/kcore"]) {
    const rows = structuredClone(valid.rows), device = rows.find(r => r.target === target).device;
    for (const row of rows.filter(r => ["/sys/firmware", "/proc/acpi", "/proc/scsi"].includes(r.target))) row.device = device;
    assert.throws(() => api.validateMounts(rows));
  }
  for (const mutate of [rows => rows.at(-1).id = rows[0].id, rows => rows.at(-1).target = rows.at(-2).target, rows => rows.at(-1).parentId = 999]) { const rows = structuredClone(valid.rows); mutate(rows); assert.throws(() => api.validateMounts(rows)); }
  const legacy = mountDiagnosticCases.find(d => d.m[1] === 27).m; validateMountDetail([legacy[0], 22, ...legacy.slice(2)], "mount_validate");
});
test("empty gate binds held descriptors checks every singleton and alias root and closes before return", async () => {
  const api = await initGuardFactory();
  for (const rows of [mounts(), inertMasks().rows]) {
    const f = inertMasks({ rows }), ledger = createInitGuardLedger(); ledger.source("mount_validate");
    const result = await api.validateEmptyMasks(f.rows, ledger, f.io), count = rows.length === mounts().length ? 1 : 3;
    assert.deepEqual(result, [1, count, count, count, count, "UNOBSERVABLE"]); assert.equal(f.state.dirClosed, count); assert.equal(f.state.anchorClosed, count);
    assert.equal(f.calls.filter(n => n === "read").length, count); assert.deepEqual(ledger.errors, []); api.validateMaskCompletion(result);
  }
});
test("empty gate rejects content binding ambiguity drift and original undefined while closing independently", async () => {
  const api = await initGuardFactory();
  for (const options of [{ nonempty: true }, { symlink: true }, { notDirectory: "named" }, { notDirectory: "held" }, { mismatch: true }, { mountMismatch: true }, { linkMismatch: true }, { namespaceDrift: true }, { mountDrift: true }, ...["open", "fd", "stat", "lstat", "readFile", "readlink", "opendir", "read", "dirClose", "anchorClose"].map(fail => ({ fail }))]) {
    const f = inertMasks(options), ledger = createInitGuardLedger(); ledger.source("mount_validate");
    await assert.rejects(api.validateEmptyMasks(f.rows, ledger, f.io), error => options.fail ? error === undefined : error instanceof Error);
    const detail = ledger.failure(); validateInitDetail(detail); assert.ok(detail.e); assert.equal(detail.e[7], "UNOBSERVABLE");
    if (f.calls.includes("opendir") && options.fail !== "opendir") assert.equal(f.state.dirClosed, options.namespaceDrift || options.mountDrift ? 3 : 1);
    if (f.calls.includes("open") && options.fail !== "open") assert.equal(f.state.anchorClosed, options.namespaceDrift || options.mountDrift ? 3 : 1);
  }
  const f = inertMasks({ fail: "read" }); f.io.opendir = async () => ({ read() { throw undefined; }, close() { f.state.dirClosed++; throw undefined; } }); f.io.open = async () => ({ fd: 41, stat: async () => ({ dev: 1n, ino: 1114n, isDirectory: () => true }), close() { f.state.anchorClosed++; throw undefined; } });
  // Independent close preservation is exercised without relying on error messages.
  f.io.lstat = async () => ({ dev: 1n, ino: 1114n, isDirectory: () => true }); f.io.realpath = async p => p;
  f.io.readlink = async p => p.endsWith("/mnt") ? "mnt:[1]" : "/sys/firmware";
  const originalRead = f.io.readFile; f.io.readFile = async p => p.includes("fdinfo") ? "mnt_id:\t114\nino:\t1114\n" : originalRead(p);
  await assert.rejects(api.validateEmptyMasks(f.rows, undefined, f.io), e => e instanceof AggregateError && e.errors.length === 3 && e.errors.every(x => x === undefined)); assert.equal(f.state.dirClosed, 1); assert.equal(f.state.anchorClosed, 1);
});
test("empty gate holds original pending operations and denies READY on content close or reporter failure", async () => {
  const api = await initGuardFactory();
  for (const key of ["readPending", "dirPending"]) {
    const held = Promise.withResolvers(), f = inertMasks({ rows: mounts(), [key]: held.promise }); let settled = false;
    const original = api.validateEmptyMasks(f.rows, undefined, f.io); void original.then(() => settled = true);
    for (let i = 0; i < 100; i++) await Promise.resolve(); assert.equal(settled, false);
    if (key === "readPending") assert.equal(f.state.dirClosed, 0); else { assert.equal(f.state.dirClosed, 1); assert.equal(f.state.anchorClosed, 1); }
    held.resolve(key === "readPending" ? null : undefined); await original; assert.equal(settled, true);
  }
  for (const mode of ["nonempty", "close", "recorder", "writer"]) {
    const f = inertMasks(mode === "nonempty" ? { nonempty: true } : mode === "close" ? { fail: "dirClose" } : {}), frames = [], ledger = createInitGuardLedger(), calls = [];
    if (mode === "recorder") ledger.source = () => { throw undefined; };
    const trace = createInitDiagnostics(line => { if (mode === "writer") throw undefined; frames.push(line); }), ops = inertInitOperations(undefined, calls);
    ops.runtime = () => api.validateEmptyMasks(f.rows, ledger, f.io);
    await assert.rejects(runInitPrerequisites([hex, other, "501", "20"], trace, ops, ledger)); assert.ok(!calls.some(c => c.name === "ready" || c.name === "permit"));
    if (frames.length && mode !== "recorder") { const c = await attachWithFrames(frames.join("")); const report = parseInitPrerequisites(c.h.attached.result, c.binding); assert.equal(report.reason, "original_failure"); assert.equal(report.detail.e[7], "UNOBSERVABLE"); assert.ok(frames.every(line => Buffer.byteLength(line) <= 512)); }
  }
});
test("empty gate closed evidence rejects inconsistent states and fits worst-case bound frames", async () => {
  const detail = { guard: "mounts", source: "mask_read", m: [1,28,1,30,null,null,1,0,null,null,0], e: [1,30,4095,4094,1,2,2,"UNOBSERVABLE"] };
  validateInitDetail(detail);
  const frames = [], trace = createInitDiagnostics(line => frames.push(line)); trace.enter("arguments"); trace.bind(hex, other); for (const stage of initPrerequisiteStages.slice(1,5)) trace.enter(stage);
  trace.finish(true, undefined, detail, Array(16).fill(undefined)); assert.deepEqual(trace.errors, []); assert.ok(frames.every(frame => Buffer.byteLength(frame) <= 512));
  const captured = await attachWithFrames(frames.join("")), row = parseInitPrerequisites(captured.h.attached.result, captured.binding); assert.deepEqual(row.detail, detail);
  for (const mutate of [d => d.e[0] = 2, d => d.e[1] = 2, d => d.e[2] = 4096, d => d.e[3] = 4095, d => d.e[4] = 0, d => d.e[5] = 0, d => d.e[6] = 0, d => d.e[7] = "ZERO", d => d.source = "mask_anchor_close", d => delete d.e]) {
    const invalid = structuredClone(detail); mutate(invalid); assert.throws(() => validateInitDetail(invalid));
  }
  let getter = false; const hostile = [...detail.e]; Object.defineProperty(hostile, "4", { get() { getter = true; throw undefined; } }); assert.throws(() => validateMaskDetail(hostile)); assert.equal(getter, false);
  const report = createContainerDiagnostics(); createAttachProjection(captured.h.attached, captured.binding, report)(captured.h.attached.result);
  for (const phase of ["entry", "dispatch", "ready", "retirement"]) report.mark(phase, "rejected", undefined);
  for (const phase of ["module_import", "host_runtime", "cwd", "temp", "environment", "image", "base", "create"]) report.mark(phase, "fulfilled");
  const output = []; emitContainerFailure(report.records, line => output.push(line)); assert.equal(output.length, 10); assert.ok(output.every(line => Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192);
  assert.ok(!output.join("").includes(hex) && !output.join("").includes(other));
});
const mixedClosePackets = [];
test("empty gate retains asynchronous directory rejection and synchronous anchor failure through closed frames", async () => {
  const api = await initGuardFactory();
  for (const [directoryReason, anchorReason] of [[undefined, undefined], [{}, undefined], [undefined, {}]]) {
    const read = Promise.withResolvers(), close = Promise.withResolvers();
    const f = inertMasks({ rows: mounts(), readPending: read.promise, dirPending: close.promise, fail: "anchorClose" });
    const originalOpen = f.io.open;
    f.io.open = async (...args) => {
      const handle = await originalOpen(...args);
      handle.close = () => { f.state.anchorClosed++; throw anchorReason; };
      return handle;
    };
    const frames = [], ledger = createInitGuardLedger(), calls = [], trace = createInitDiagnostics(line => frames.push(line));
    const ops = inertInitOperations(undefined, calls); ops.runtime = () => api.validateEmptyMasks(f.rows, ledger, f.io);
    let settled = false, failure;
    const original = runInitPrerequisites([hex, other, "501", "20"], trace, ops, ledger);
    const observed = original.then(() => { settled = true; assert.fail("mixed close accepted"); }, error => { settled = true; failure = error; });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(f.state.readEntered, true); assert.equal(f.state.dirClosed, 0); assert.equal(f.state.anchorClosed, 0); assert.equal(settled, false);
    read.resolve(null);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(f.state.dirClosed, 1); assert.equal(f.state.anchorClosed, 1); assert.equal(settled, false);
    assert.ok(!calls.some(c => c.name === "ready" || c.name === "permit"));
    close.reject(directoryReason); await observed;
    assert.ok(failure instanceof AggregateError); assert.equal(failure.errors.length, 2);
    assert.equal(failure.errors[0], anchorReason); assert.equal(failure.errors[1], directoryReason);
    assert.equal(f.state.dirClosed, 1); assert.equal(f.state.anchorClosed, 1);
    assert.ok(!calls.some(c => c.name === "ready" || c.name === "permit")); assert.deepEqual(trace.errors, []); assert.deepEqual(ledger.errors, []);
    const captured = await attachWithFrames(frames.join("")), parsed = parseInitPrerequisites(captured.h.attached.result, captured.binding);
    const detail = { guard: null, source: "mask_anchor_close", e: [1,29,1,0,1,2,2,"UNOBSERVABLE"] };
    assert.equal(parsed.reason, "original_failure"); assert.equal(parsed.defined, true); assert.deepEqual(parsed.detail, detail);
    assert.throws(() => validateContainerDiagnostic({ ...parsed, defined: false }));
    assert.throws(() => validateContainerDiagnostic({ ...parsed, state: "observed", reason: "complete" }));
    for (const mutate of [d => d.e[4] = 0, d => d.e[4] = 2, d => d.e[5] = 0, d => d.e[6] = 1, d => d.guard = "mounts", d => d.source = "mask_open"]) {
      const invalid = structuredClone(detail); mutate(invalid); assert.throws(() => validateInitDetail(invalid));
    }
    assert.ok(frames.every(frame => Buffer.byteLength(frame) <= 512));
    const report = createContainerDiagnostics(); createAttachProjection(captured.h.attached, captured.binding, report)(captured.h.attached.result);
    for (const phase of ["entry", "dispatch", "ready", "retirement"]) report.mark(phase, "rejected", undefined);
    for (const phase of ["module_import", "host_runtime", "cwd", "temp", "environment", "image", "base", "create"]) report.mark(phase, "fulfilled");
    const output = []; emitContainerFailure(report.records, line => output.push(line));
    assert.equal(output.length, 10); assert.ok(output.every(line => Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(output.join("")) <= 8192);
    const packet = output.map(line => JSON.parse(line.slice(line.indexOf("::", 2) + 2).trimEnd()));
    assert.deepEqual(packet.find(row => row.phase === "init_prerequisite").detail, detail); mixedClosePackets.push(packet);
  }
});
async function parentAdmissionFactory(overrides = {}) {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const cut = (a,b) => source.slice(source.indexOf(a),source.indexOf(b)).replaceAll("export ", "");
  const code = cut("const hash =", "export function parseIdentity(") + cut("export function createInitGuardLedger(", "const own =") + cut("export function parseIdentity(", "export function validateImage(") + cut("export function createArguments(", "export function parseControl(") + cut("export function createMountObservation(", "// Original attach close");
  const contractSource = cut("export const containerContract =", "export const harnessInputs =");
  const bindings = { createHash, join, dirname, relative, parentAdmissionSources, parentAdmissionPredicates, parentAdmissionRoles, validateParentAdmission, validateMountDetail, validateMaskDetail, initGuardTags, initSourcePhases, mountTargets, mountFilesystems,
    readFile: async () => { throw undefined; }, readlink: async () => { throw undefined; }, realpath: async () => { throw undefined; }, stat: async () => { throw undefined; }, lstat: async () => { throw undefined; }, ...overrides };
  return new Function(...Object.keys(bindings), contractSource + code + ";return {createParentAdmissionLedger,parentSource,parentRole,parentEvaluate,parentLeaf,parentCount,parseIdentity,validateIdentity,validateMapping,validateContainerInspect,validateTarget,processEvidence,validateLimits,bindCgroup,validateMetadataMounts,validateMountFreshness,createParentCgroupAdmission,sameCgroupBinding,matchesLinuxDevice,retiredCgroup,parseMounts,parseParentMounts,parentMountTable,parentMountRoot};")(...Object.values(bindings));
}
const parentAdmissionPackets = [];
test("parent admission actual predicates preserve short circuit getters original throws and fixed first evidence", async () => {
  const api = await parentAdmissionFactory();
  const ledger = api.createParentAdmissionLedger(); ledger.enter("cgroup_limits"); const reads=[];
  const values = { get memory(){reads.push("memory");return "bad";}, get swap(){throw new Error("unreached");}, get pids(){throw new Error("unreached");} };
  assert.throws(()=>api.validateLimits(values,ledger)); assert.deepEqual(reads,["memory"]);
  const detail=ledger.finish(true,undefined); assert.equal(detail.defined,false); assert.deepEqual(detail.detail.slice(3,9),[1,32,1,0,1,0]);
  ledger.enter("metadata"); ledger.begin(1); assert.equal(ledger.finish(true,{}),null); assert.equal(detail.detail[1],parentAdmissionSources.indexOf("cgroup_limits")+1);
  const broken=api.createParentAdmissionLedger();broken.enter("cgroup_limits");let caught=false;
  try{api.validateLimits({get memory(){throw undefined;}},broken);}catch(e){caught=true;assert.equal(e,undefined);}assert.equal(caught,true);
  assert.deepEqual(broken.finish(true,undefined).detail.slice(3,9),[2,32,0,0,0,0]);
  const mapping=api.createParentAdmissionLedger();mapping.enter("target_validate");mapping.role("uid");assert.throws(()=>api.validateMapping("1 0 4294967295",501,mapping));assert.equal(mapping.finish(true,{}).detail[4],7);
  const groups=api.createParentAdmissionLedger();groups.enter("parent_identity");assert.throws(()=>api.parseIdentity("Groups:\t20 20\nUid:\t501 501 501 501\nGid:\t20 20 20 20\n",groups));assert.equal(groups.finish(true,{}).detail[4],4);
  const reportFailure=api.createParentAdmissionLedger();reportFailure.enter("cgroup_limits");reportFailure.leaf=()=>{throw undefined;};api.validateLimits({memory:"4294967296",swap:"0",pids:"128",cpu:"200000 100000"},reportFailure);assert.ok(reportFailure.errors.length);assert.ok(reportFailure.errors.every(e=>e===undefined));
});
test("parent admission actual metadata ambiguity captures bounded counts and original comparison result", async () => {
  const api=await parentAdmissionFactory(), target=mounts(), root="/var/lib/docker";
  const inspect={ResolvConfPath:`${root}/containers/${hex}/resolv.conf`,HostnamePath:`${root}/containers/${hex}/hostname`,HostsPath:`${root}/containers/${hex}/hosts`};
  const parent=[mount(1,0,"/","ext4","8:1",["rw"])];
  for(const r of target.filter(r=>r.target.startsWith("/etc/")))r.root=`${root}/containers/${hex}/${r.target.slice(5)}`;
  const ledger=api.createParentAdmissionLedger();ledger.enter("metadata");const valid=api.validateMetadataMounts(inspect,target,parent,root,hex,ledger);assert.equal(valid.length,3);assert.deepEqual(ledger.errors,[]);
  const wrong=api.createParentAdmissionLedger();wrong.enter("metadata");wrong.visit(2);assert.throws(()=>api.validateMetadataMounts({...inspect,HostsPath:"/foreign"},target,parent,root,hex,wrong));const row=wrong.finish(true,{});assert.equal(row.detail[2],2);assert.equal(row.detail[4],59);assert.equal(row.detail[6],parentAdmissionRoles.indexOf("HostsPath")+1);
  const ambiguous=api.createParentAdmissionLedger();ambiguous.enter("metadata");assert.throws(()=>api.validateMetadataMounts(inspect,target,[...parent,{...parent[0],id:2}],root,hex,ambiguous));const duplicate=ambiguous.finish(true,{});assert.equal(duplicate.detail[4],55);assert.equal(duplicate.detail[6],parentAdmissionRoles.indexOf("ResolvConfPath")+1);
  const saturation=api.createParentAdmissionLedger();saturation.enter("metadata");saturation.begin(22);saturation.count(5000);saturation.leaf(1,false);saturation.result(false);const saturated=saturation.finish(true,{});assert.deepEqual(saturated.detail.slice(9),[4095,1]);assert.throws(()=>validateParentAdmission({...saturated,detail:[...saturated.detail.slice(0,9),4094,1]}));
});
test("parent admission original process evidence preserves sequential reads and parallel group ambiguity", async () => {
  const api=await parentAdmissionFactory();
  for(const failAt of ["stat","status","uid_map","gid_map","ns","mountinfo","cgroup"]) {
    const ledger=api.createParentAdmissionLedger(), calls=[];ledger.enter("target_stat");let caught=false;
    const fields=Array(20).fill("0");fields[1]="1";fields[19]="123";
    const read=async path=>{const key=path.split("/").at(-1);calls.push(key);if(key===failAt)throw undefined;if(key==="stat")return "123 (init) "+fields.join(" ");if(key==="mountinfo")return mounts().map(r=>`${r.id} ${r.parentId} ${r.device} ${r.root} ${r.target} ${r.options.join(",")} - ${r.fs} none ${r.superOptions.join(",")}`).join("\n")+"\n";return "0";};
    const link=async path=>{calls.push("ns:"+path.split("/").at(-1));if(failAt==="ns")throw undefined;return "ns:[1]";};
    try{await api.processEvidence(123,{read,link,recorder:ledger});}catch(e){caught=true;assert.equal(e,undefined);}assert.equal(caught,true);
    const row=ledger.finish(true,undefined);assert.equal(row.defined,false);assert.equal(row.detail[3],0);
    if(failAt==="ns"){assert.deepEqual(calls.slice(-4),["ns:pid","ns:net","ns:mnt","ns:user"]);assert.equal(parentAdmissionSources[row.detail[1]-1],"target_namespace_group");}
    assert.equal(calls[0],"stat");
  }
});
test("parent admission closed tuple formatter reserves originals and refuses foreign contradictory evidence", async () => {
  const api=await parentAdmissionFactory(), ledger=api.createParentAdmissionLedger();ledger.enter("cgroup_limits");assert.throws(()=>api.validateLimits({memory:"bad"},ledger));const detail=ledger.finish(true,undefined);
  const report=createContainerDiagnostics();report.mark("admission","rejected",undefined);report.internal(detail);report.mark("entry","rejected",undefined);
  const captured=await attachWithFrames(initReady());createAttachProjection(captured.h.attached,captured.binding,report)(captured.h.attached.result);
  report.mark("retirement","rejected",undefined);
  for(const phase of ["dispatch","image","base","create","attach","ready","cwd","temp","environment"])report.mark(phase,"fulfilled");
  const lines=[];emitContainerFailure(report.records,line=>lines.push(line));assert.equal(lines.length,10);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
  const packet=lines.map(line=>JSON.parse(line.slice(line.indexOf("::",2)+2).trimEnd()));assert.deepEqual(packet.find(r=>r.phase==="admission"),detail);parentAdmissionPackets.push(packet);
  for(const mutate of [r=>r.detail[0]=2,r=>r.detail[1]=1,r=>r.detail[2]=3,r=>r.detail[3]=0,r=>r.detail[4]=999,r=>r.detail[5]=0,r=>r.detail[7]=255,r=>r.detail[8]=1,r=>r.detail[9]=99999,r=>r.state="fulfilled",r=>r.defined=null]){const bad=structuredClone(detail);mutate(bad);assert.throws(()=>validateParentAdmission(bad));}
  assert.throws(()=>emitContainerFailure([...report.records,detail],()=>{}));
  const hostile=[...detail.detail];let touched=false;Object.defineProperty(hostile,"7",{get(){touched=true;throw undefined;}});assert.throws(()=>validateParentAdmission({...detail,detail:hostile}));assert.equal(touched,false);
});
test("parent admission actual callback rejects each original boundary and reporter failure before permit", async () => {
  const api=await parentAdmissionFactory(), source=await readFile(new URL("../scripts/edge-proof-container.mjs",import.meta.url),"utf8");
  const start=source.indexOf('    await report.step("admission", async () => {'), end=source.indexOf("\n    // READY keeps init",start), callback=source.slice(start,end);
  const parentNamespaces={pid:"pid:[1]",net:"net:[1]",mnt:"mnt:[1]",user:"user:[1]"}, root="/var/lib/docker", targetMounts=mounts();
  for(const r of targetMounts.filter(r=>r.target.startsWith("/etc/")))r.root=`${root}/containers/${hex}/${r.target.slice(5)}`;
  const metadata={ResolvConfPath:`${root}/containers/${hex}/resolv.conf`,HostnamePath:`${root}/containers/${hex}/hostname`,HostsPath:`${root}/containers/${hex}/hosts`};
  const parentRows=[mount(1,0,"/","ext4","8:1",["rw"])], parentText=parentRows.map(r=>`${r.id} ${r.parentId} ${r.device} ${r.root} ${r.target} ${r.options.join(",")} - ${r.fs} none ${r.superOptions.join(",")}`).join("\n")+"\n";
  const goodStatus="Groups:\t20\nUid:\t501 501 501 501\nGid:\t20 20 20 20\n"+["CapInh","CapPrm","CapEff","CapBnd","CapAmb"].map(n=>n+":\t0000\n").join("")+"NoNewPrivs:\t1\nSeccomp:\t2\n";
  const target={pid:123,start:"123",status:goodStatus,uidMap:"0 0 4294967295",gidMap:"0 0 4294967295",namespaces:{pid:"pid:[2]",net:"net:[2]",mnt:"mnt:[2]",user:"user:[1]"},mounts:targetMounts,cgroup:`0::/docker/${hex}\n`};
  let baseline;
  for(const stop of [0,...Array.from({length:6},(_,i)=>i+1),"binding","report"]) {
    const calls=[], reporting=[], report=createContainerDiagnostics();let permits=0, caught=false, reason;
    const record=(name,args,value)=>{calls.push({name,args});if(calls.length===stop)throw undefined;return value;};
    const ledgerFactory=()=>{const l=api.createParentAdmissionLedger();if(stop==="report")l.enter=()=>{throw undefined;};return l;};
    const bindings={raiseContainerFailures,createParentAdmissionLedger:ledgerFactory,createParentCgroupAdmission:()=>({observe:async(pid,visit,l)=>{api.parentSource(l,"cgroup_observer");return record("cgroup-view",[pid,visit],{target,bound:{path:"/owned",dev:1n,ino:stop==="binding"&&visit===2?3n:2n,parentDev:1n,parentIno:1n},parentMounts:parentRows});}}),sameCgroupBinding:api.sameCgroupBinding,parentSource:api.parentSource,parentRecord:(l,m,...a)=>{try{l[m](...a);}catch(e){l.errors.push(e);}},parentEvaluate:api.parentEvaluate,parentLeaf:api.parentLeaf,check:(v)=>{if(!v)throw undefined;},report,admissionReporting:reporting,identity,parentNamespaces,cid:hex,daemonRoot:root,
      recheckParent:async l=>{api.parentSource(l,"parent_identity");return record("parent",[],identity);},readOwned:async l=>{api.parentSource(l,"inspect_validate");return record("inspect",[],{...metadata,State:{Running:true,Pid:123}});},
      processEvidence:async(pid,{recorder})=>{api.parentSource(recorder,"target_stat");return record("process",[pid],target);},validateTarget:api.validateTarget,
      bindCgroup:async(t,cid,l)=>{api.parentSource(l,"cgroup_path");return record("cgroup",[t,cid],{dev:1,ino:2});},
      readlink:async path=>record("namespace",[path],parentNamespaces.mnt),readFile:async(...args)=>record("mounts",args,parentText),
      parseMounts:(...args)=>record("parse",args.slice(1,2),mountTableForParent(args[0])),validateMetadataMounts:api.validateMetadataMounts,validateMountFreshness:api.validateMountFreshness,same:(a,b)=>JSON.stringify(a)===JSON.stringify(b)};
    function mountTableForParent(){return structuredClone(parentRows);}
    const run=new Function(...Object.keys(bindings),'return async () => { let target,bound; '+callback+'; return {target,bound}; };')(...Object.values(bindings));
    try{await run();permits++;}catch(e){caught=true;reason=e;}
    if(stop===0){assert.equal(caught,false);assert.equal(permits,1);baseline=calls;assert.equal(calls.length,6);}
    else{assert.equal(caught,true);assert.equal(permits,0);if(stop!=="report"){assert.equal(reason,undefined);assert.deepEqual(calls,baseline.slice(0,stop==="binding"?5:stop));}else assert.ok(reason===undefined||reason instanceof AggregateError);}
    assert.ok(report.records.some(r=>r.phase==="admission"));
    if(stop!==0&&stop!=="report"){const detailed=report.records.find(r=>r.v===8);assert.ok(detailed);assert.equal(detailed.defined,false);validateParentAdmission(detailed);}
  }
});

async function cgroupFixture(change = () => {}) {
  const api = await parentAdmissionFactory(), membership = `/docker/${hex}`, parentNamespaces = { pid:"pid:[1]",net:"net:[1]",mnt:"mnt:[1]",user:"user:[1]" };
  const targetRows = mounts(); targetRows.find(r => r.target === "/sys/fs/cgroup").root = membership;
  const parentRows = [mount(1,0,"/","ext4","8:1",["rw"]),mount(2,1,"/sys/fs/cgroup","cgroup2","0:99",["rw"])];
  const text = rows => rows.map(r=>`${r.id} ${r.parentId} ${r.device} ${r.root} ${r.target} ${r.options.join(",")} - ${r.fs} none ${r.superOptions.join(",")}`).join("\n")+"\n";
  const fields=Array(20).fill("0");fields[1]="1";fields[19]="123";
  const status="Groups:\t20\nUid:\t501 501 501 501\nGid:\t20 20 20 20\n"+["CapInh","CapPrm","CapEff","CapBnd","CapAmb"].map(n=>n+":\t0000\n").join("")+"NoNewPrivs:\t1\nSeccomp:\t2\n";
  const state={membership,targetRows,parentRows,fields,calls:[],ino:9007199254740993n,removed:false};
  const missing=()=>{throw Object.assign(new Error("inert"),{code:"ENOENT"});};
  const io={
    read:async path=>{state.calls.push(["read",path]);if(path==="/proc/self/mountinfo")return text(state.parentRows);if(path.endsWith("/stat"))return "123 (init) "+state.fields.join(" ");if(path.endsWith("/status"))return status;if(path.endsWith("/uid_map")||path.endsWith("/gid_map"))return "0 0 4294967295";if(path.endsWith("/mountinfo"))return text(state.targetRows);if(path.endsWith("/cgroup"))return `0::${state.membership}\n`;const key=path.split("/").at(-1);return ({"memory.max":"4294967296","memory.swap.max":"0","pids.max":"128","cpu.max":"200000 100000","cgroup.procs":"","cgroup.events":"populated 0\n"})[key];},
    link:async path=>{state.calls.push(["link",path]);const name=path.split("/").at(-1);return `${name}:[${path.startsWith("/proc/self/")||name==="user"?1:2}]`;},
    realpath:async path=>{state.calls.push(["realpath",path]);return path;},
    stat:async(path,options)=>{state.calls.push(["stat",path,options.bigint]);assert.equal(options.bigint,true);if(state.removed&&path.endsWith(hex))return missing();return {dev:99n,ino:path.endsWith(hex)?state.ino:path==="/sys/fs/cgroup"?10n:1n,isDirectory:()=>true};},
  };
  change({state,io,api});
  const metadata={daemonRoot:"/var/lib/docker",inspect:Object.fromEntries([["ResolvConfPath","resolv.conf"],["HostnamePath","hostname"],["HostsPath","hosts"]].map(([key,name])=>[key,`/var/lib/docker/containers/${hex}/${name}`]))};
  const admission=api.createParentCgroupAdmission(hex,parentNamespaces,identity,io,metadata);
  return {api,state,io,metadata,admission,retire:bound=>api.retiredCgroup(bound,{read:io.read,link:io.link,statPath:io.stat,lstatPath:async()=>missing()})};
}
test("same observer cgroup actual qualified visits allow different devices and retain exact BigInt retirement", async()=>{
  const f=await cgroupFixture(), ledger=f.api.createParentAdmissionLedger();
  const first=await f.admission.observe(123,1,ledger);assert.equal(first.bound.ino,9007199254740993n);assert.deepEqual(ledger.errors,[]);
  assert.throws(()=>f.api.validateTarget(first.target,{pid:"pid:[1]",net:"net:[1]",mnt:"mnt:[1]",user:"user:[1]"},identity));
  assert.throws(()=>f.api.validateTarget(first.target,{},identity,undefined,{}));
  const second=await f.admission.observe(123,2,ledger);assert.equal(f.api.sameCgroupBinding(first.bound,second.bound),true);await assert.rejects(f.retire(first.bound));assert.equal(await f.retire(second.bound),"empty");
  f.state.ino=9007199254740992n;await assert.rejects(f.retire(second.bound));f.state.ino=9007199254740993n;f.state.removed=true;assert.equal(await f.retire(second.bound),"removed");
  assert.equal(f.state.calls.filter(([k,p])=>k==="read"&&p.endsWith("memory.max")).length,2);
});
test("same observer cgroup actual mapping rejects all directory parent controller and deeper overmounts",async()=>{
  for(const suffix of ["",`/docker`, `/docker/${hex}`,`/docker/${hex}/deep`,`/docker/${hex}/memory.max`,`/docker/${hex}/memory.swap.max`,`/docker/${hex}/pids.max`,`/docker/${hex}/cpu.max`]){
    const f=await cgroupFixture(({state})=>state.parentRows.push(mount(3,2,"/sys/fs/cgroup"+suffix,"tmpfs","0:999",["rw"])));
    await assert.rejects(f.admission.observe(123,1));assert.equal(f.state.calls.some(([k])=>k==="stat"),false);
  }
});
test("same observer cgroup actual membership and namespace counterexamples never qualify equal strings alone",async()=>{
  for(const member of ["/",`/docker/${hex}/child`,`/docker/${hex}x`,`/docker/../${hex}`,`/docker//${hex}`,`/docker/./${hex}`,`/docker/\u0000${hex}`,`/docker/${other}`]){
    const f=await cgroupFixture(({state})=>{state.membership=member;state.targetRows.find(r=>r.target==="/sys/fs/cgroup").root=member;});await assert.rejects(f.admission.observe(123,1));
  }
  for(const mutate of [({state})=>state.parentRows[1].root="/foreign",({state})=>state.parentRows[1].fs="tmpfs",({state})=>state.targetRows.find(r=>r.target==="/sys/fs/cgroup").root="/sibling",({state})=>state.targetRows.find(r=>r.target==="/sys/fs/cgroup").options=["rw"],({io})=>{const original=io.link;io.link=async p=>p.endsWith("/ns/cgroup")?"cgroup:[1]":original(p);},({io})=>{io.realpath=async()=>"/foreign";},({io})=>{io.stat=async()=>({dev:99,ino:9007199254740992,isDirectory:()=>true});}]){const f=await cgroupFixture(mutate);await assert.rejects(f.admission.observe(123,1));}
});
test("same observer cgroup actual original read order failures brackets and stale visits deny permit",async()=>{
  const baseline=await cgroupFixture();await baseline.admission.observe(123,1);const original=baseline.state.calls;
  for(let stop=1;stop<=original.length;stop++){
    let calls=0;const seen=[];const f=await cgroupFixture(({io})=>{for(const key of ["read","link","realpath","stat"]){const fn=io[key];io[key]=async(...args)=>{seen.push(key==="stat"?[key,args[0],args[1].bigint]:[key,args[0]]);if(++calls===stop)throw undefined;return fn(...args);};}});
    let caught=false;try{await f.admission.observe(123,1);}catch(e){caught=true;assert.equal(e,undefined);}assert.equal(caught,true);let end=stop;for(const suffixes of [["/ns/pid","/ns/cgroup"],["/memory.max","/cpu.max"]]){const first=original.findIndex(([,p])=>p.endsWith(suffixes[0])&&(!suffixes[0].startsWith("/ns/")||p.startsWith("/proc/123/")))+1,last=original.findIndex(([,p])=>p.endsWith(suffixes[1])&&(!suffixes[1].startsWith("/ns/")||p.startsWith("/proc/123/")))+1;if(stop>=first&&stop<=last)end=last;}assert.equal(calls,end);assert.deepEqual(seen,original.slice(0,end));await assert.rejects(f.admission.observe(123,2));
  }
  for(const field of ["observer","target","start"]){let n=0;const f=await cgroupFixture(({io,state})=>{if(field==="start"){const fn=io.read;io.read=async p=>{if(p.endsWith("/stat")&&++n===2)state.fields[19]="124";return fn(p);};}else{const fn=io.link;io.link=async p=>{const selected=field==="observer"?p==="/proc/self/ns/cgroup":p==="/proc/123/ns/cgroup";return selected&&++n===2?"cgroup:[9]":fn(p);};}});await assert.rejects(f.admission.observe(123,1));}
  const f=await cgroupFixture(), first=await f.admission.observe(123,1);await assert.rejects(f.admission.observe(999,2));await assert.rejects(f.retire(first.bound));
});
test("same observer cgroup actual parent automatic leaves preserve strict historical and private schemas",async()=>{
  const changes=[[1,r=>r.fs="ext4"],[2,r=>r.root="/foreign"],[3,r=>r.device="8:99"],[5,r=>r.options=r.options.map(x=>x==="ro"?"rw":x)],[6,r=>r.options=r.options.filter(x=>x!=="nosuid")],[7,r=>r.options=r.options.filter(x=>x!=="nodev")],[8,r=>r.options=r.options.filter(x=>x!=="noexec")]];
  for(const [leaf,change] of changes){const f=await cgroupFixture(({state})=>change(state.targetRows.find(r=>r.target==="/sys/fs/cgroup"))), ledger=f.api.createParentAdmissionLedger();let reason;try{await f.admission.observe(123,1,ledger);}catch(e){reason=e;}const row=ledger.finish(true,reason);assert.ok(row.m);assert.equal(row.m[1],29);assert.equal(row.m[2],leaf);validateParentAdmission(row);if(leaf>2)for(const root of [1,2]){const bad=structuredClone(row);bad.m[5]=root;assert.throws(()=>validateParentAdmission(bad));}assert.throws(()=>validateInitDetail({source:"mount_validate",guard:"mounts",m:row.m}));const report=createContainerDiagnostics();report.mark("entry","rejected",reason);report.internal(row);const captured=await attachWithFrames(initReady());createAttachProjection(captured.h.attached,captured.binding,report)(captured.h.attached.result);const lines=[];emitContainerFailure(report.records,x=>lines.push(x));parentAdmissionPackets.push(lines.map(x=>JSON.parse(x.slice(x.indexOf("::",2)+2).trimEnd())));}
});
test("same observer cgroup appended evidence retains actual failures reporter undefined and command quotas",async()=>{
  const f=await cgroupFixture(({state})=>state.parentRows[1].root="/foreign"), ledger=f.api.createParentAdmissionLedger();let reason;try{await f.admission.observe(123,1,ledger);}catch(e){reason=e;}const detail=ledger.finish(true,reason);assert.equal(detail.detail[4],48);validateParentAdmission(detail);
  const report=createContainerDiagnostics();report.mark("entry","rejected",reason);report.internal(detail);const captured=await attachWithFrames(initReady());createAttachProjection(captured.h.attached,captured.binding,report)(captured.h.attached.result);report.mark("retirement","rejected",undefined);for(const p of ["dispatch","image","base","create","attach","ready","cwd","temp","environment"])report.mark(p,"fulfilled");const lines=[];emitContainerFailure(report.records,x=>lines.push(x));assert.equal(lines.length,10);assert.ok(lines.every(x=>Buffer.byteLength(x)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);parentAdmissionPackets.push(lines.map(x=>JSON.parse(x.slice(x.indexOf("::",2)+2).trimEnd())));
  const broken=await cgroupFixture(), l=broken.api.createParentAdmissionLedger();l.enter=()=>{throw undefined;};await broken.admission.observe(123,1,l);assert.ok(l.errors.length);assert.ok(l.errors.every(e=>e===undefined));
});

test("same observer cgroup held original limits deny completion and all repeat identity substitutions fail",async()=>{
  const held=Promise.withResolvers();let limitCalls=0,completed=false;
  const f=await cgroupFixture(({io})=>{const read=io.read;io.read=path=>{if(path.endsWith("memory.max")){limitCalls++;return held.promise;}return read(path);};});
  const pending=f.admission.observe(123,1).then(x=>{completed=true;return x;});await Promise.resolve();await Promise.resolve();for(let i=0;i<30;i++)await Promise.resolve();assert.equal(completed,false);assert.equal(limitCalls,1);held.resolve("4294967296");await pending;
  for(const mutate of [f=>f.state.parentRows[1].id=77,f=>f.state.ino=9007199254740992n,f=>{f.state.membership=`/different/${hex}`;f.state.targetRows.find(r=>r.target==="/sys/fs/cgroup").root=f.state.membership;}]){
    const x=await cgroupFixture(),one=await x.admission.observe(123,1);mutate(x);
    try{const two=await x.admission.observe(123,2);assert.equal(x.api.sameCgroupBinding(one.bound,two.bound),false);}catch(e){assert.ok(e!==undefined);await assert.rejects(x.retire(one.bound));}
  }
  const x=await cgroupFixture(), namespaces={pid:"pid:[1]",net:"net:[1]",mnt:"mnt:[1]",user:"user:[1]"};await assert.rejects(x.api.createParentCgroupAdmission(other,namespaces,identity,x.io).observe(123,1));
  const y=await cgroupFixture(({io})=>{const original=io.stat;io.stat=async(...args)=>{const row=await original(...args);if(args[0]==="/sys/fs/cgroup")row.dev=100n;return row;};});await assert.rejects(y.admission.observe(123,1));
});
test("same observer cgroup actual failure cleanup still stops and joins without unqualified retirement fallback",async()=>{
  const source=await readFile(new URL("../scripts/edge-proof-container.mjs",import.meta.url),"utf8"),start=source.indexOf("  if (cid && created) {"),end=source.indexOf("  raiseContainerFailures(failures);",start),code=source.slice(start,end);
  for(const stopFailure of [false,true]){
    const original=Promise.withResolvers(),result={closed:true},failures=[];let stops=0,joins=0,removes=0,finished=false;
    const bindings={cid:hex,created:{},attached:{closed:original.promise,result},waiting:undefined,bound:undefined,failures,report:{step:async(p,f)=>f()},readOwned:async()=>({State:{Running:false,Pid:0}}),check:(v)=>{if(!v)throw new Error("inert");},stopOwned:async()=>{stops++;if(stopFailure)throw undefined;},projectAttach:()=>{joins++;},requireProcessSuccess:()=>{},recheckParent:async()=>{},retiredCgroup:async()=>{throw new Error("must not qualify");},run:async()=>{removes++;},raiseContainerFailures};
    const execute=new Function(...Object.keys(bindings),'return async()=>{let disposition="retained";'+code+';return disposition;}')(...Object.values(bindings));
    const pending=execute().then(x=>{finished=true;return x;});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(stops,1);assert.equal(finished,false);original.resolve(result);assert.equal(await pending,"retained");assert.equal(joins,1);assert.equal(removes,0);assert.ok(failures.length);if(stopFailure)assert.ok(failures[0].errors.includes(undefined));
  }
});
test("same observer cgroup Linux device encoding rejects consistent stat mismatch on both visits and retirement",async()=>{
  const api=await parentAdmissionFactory();
  const vectors=[[0n,"0:0"],[99n,"0:99"],[0xfff00n,"4095:0"],[0xfffff00000000000n,"4294963200:0"],[0xffffff00000n,"0:4294967040"],[0xffffffffffffffffn,"4294967295:4294967295"]];
  // Fixed vectors exercise both low and high fields; no Number conversion.
  for(const [dev,device] of vectors)assert.equal(api.matchesLinuxDevice(dev,device),true);
  for(const [dev,device] of [[-1n,"0:0"],[1n<<64n,"0:0"],[99,"0:99"],[null,"0:99"],[99n,"00:99"],[99n,"0:099"],[99n,"0:99\n"],[99n,"-1:99"],[99n,"0:4294967296"],[99n,"4294967296:0"],[99n,"0/99"],[99n,{}],[100n,"0:99"]])assert.equal(api.matchesLinuxDevice(dev,device),false);
  for(const visit of [1,2]){
    let dev=99n;const f=await cgroupFixture(({io})=>{const stat=io.stat;io.stat=async(...a)=>({...await stat(...a),dev});});
    let first;if(visit===2)first=await f.admission.observe(123,1);dev=100n;
    const ledger=f.api.createParentAdmissionLedger();ledger.visit(visit);let reason;
    try{await f.admission.observe(123,visit,ledger);assert.fail("must reject");}catch(error){reason=error;}
    const detail=ledger.finish(true,reason);assert.equal(detail.detail[4],54);assert.equal(detail.detail[1],36);assert.doesNotThrow(()=>validateContainerDiagnostic(detail));
    const report=createContainerDiagnostics();report.mark("entry","rejected",reason);report.internal(detail);const captured=await attachWithFrames(initReady());createAttachProjection(captured.h.attached,captured.binding,report)(captured.h.attached.result);const commands=[];emitContainerFailure(report.records,x=>commands.push(x));assert.ok(commands.every(x=>Buffer.byteLength(x)<=768));assert.ok(Buffer.byteLength(commands.join(""))<=8192);parentAdmissionPackets.push(commands.map(x=>JSON.parse(x.slice(x.indexOf("::",2)+2).trimEnd())));
    if(first)await assert.rejects(f.retire(first.bound));
  }
  for(const dev of [0n,99n,0xfff00n,0xfffff00000000000n,0xffffff00000n,0xffffffffffffffffn]){
    const device=vectors.find(x=>x[0]===dev)[1],f=await cgroupFixture(({state,io})=>{state.parentRows[1].device=device;const stat=io.stat;io.stat=async(...a)=>({...await stat(...a),dev});});
    const one=await f.admission.observe(123,1),two=await f.admission.observe(123,2);assert.equal(await f.retire(two.bound),"empty");
    const stat=f.io.stat;f.io.stat=async(...a)=>({...await stat(...a),dev:dev^1n});await assert.rejects(f.retire(two.bound));f.state.removed=true;await assert.rejects(f.retire(two.bound));
  }
  for(const device of ["00:99","0:099","0:4294967296","4294967296:0","0/99"]){const f=await cgroupFixture(({state})=>state.parentRows[1].device=device);await assert.rejects(f.admission.observe(123,1));}
  for(const role of ["owned","parent","mapping"]){const f=await cgroupFixture(({io})=>{const stat=io.stat;io.stat=async(...a)=>{const row=await stat(...a),which=a[0].endsWith(hex)?"owned":a[0]==="/sys/fs/cgroup"?"mapping":"parent";return which===role?{...row,dev:100n}:row;};});await assert.rejects(f.admission.observe(123,1));}
});

const parentMountText = rows => rows.map(r=>`${r.id} ${r.parentId} ${r.device} ${r.root} ${r.target} ${r.options.join(",")} - ${r.fs} none ${r.superOptions.join(",")}`).join("\n")+"\n";
test("same observer cgroup parent snapshot keeps opaque roots without changing child paths or original IO",async()=>{
  const api=await parentAdmissionFactory(), rows=[mount(1,0,"/","ext4","8:1",["rw"]),mount(2,1,"/run/held-ns","nsfs","0:101",["rw"],"net:[123]"),mount(3,1,"/run/other","otherfs","0:102",["ro"],"name\\040with\\134slash")];
  const parsed=api.parseParentMounts(parentMountText(rows));assert.equal(parsed.length,3);assert.equal(parsed[1].root,"net:[123]");assert.equal(parsed[2].root,"name with\\slash");assert.throws(()=>api.parseMounts(parentMountText(rows),false));assert.deepEqual(rows[1].root,"net:[123]");
  const baseline=await cgroupFixture(),one=await baseline.admission.observe(123,1),two=await baseline.admission.observe(123,2);assert.equal(await baseline.retire(two.bound),"empty");
  const f=await cgroupFixture(({state})=>state.parentRows.push(mount(3,1,"/run/held-ns","nsfs","0:101",["rw"],"net:[123]"))), first=await f.admission.observe(123,1),second=await f.admission.observe(123,2);
  assert.equal(first.parentMounts.length,3);assert.equal(first.parentMounts[2].root,"net:[123]");assert.equal(second.parentMounts[2].root,"net:[123]");assert.equal(await f.retire(second.bound),"empty");assert.deepEqual(f.state.calls,baseline.state.calls);
  f.state.removed=true;assert.equal(await f.retire(second.bound),"removed");
  f.state.parentRows[1].root="net:[123]";await assert.rejects(f.retire(second.bound));
});
test("same observer cgroup selected opaque and noncanonical roots fail before metadata path arithmetic",async()=>{
  for(const bad of ["net:[123]",".","..","relative/root","/a/../b","/a//b","/a/."]){
    const f=await cgroupFixture(({state})=>state.parentRows[1].root=bad);await assert.rejects(f.admission.observe(123,1));
    let badJoins=0;const api=await parentAdmissionFactory({join:(...args)=>{if(args[0]===bad){badJoins++;throw new Error("must not join opaque root");}return join(...args);}}), target=mounts(),root="/var/lib/docker";
    const inspect={ResolvConfPath:`${root}/containers/${hex}/resolv.conf`,HostnamePath:`${root}/containers/${hex}/hostname`,HostsPath:`${root}/containers/${hex}/hosts`};
    for(const row of target.filter(r=>r.target.startsWith("/etc/")))row.root=`${root}/containers/${hex}/${row.target.slice(5)}`;
    assert.throws(()=>api.validateMetadataMounts(inspect,target,[mount(1,0,"/","ext4","8:1",["rw"],bad)],root,hex));assert.equal(badJoins,0);
  }
  const api=await parentAdmissionFactory(), target=mounts(),root="/var/lib/docker",inspect={ResolvConfPath:`${root}/containers/${hex}/resolv.conf`,HostnamePath:`${root}/containers/${hex}/hostname`,HostsPath:`${root}/containers/${hex}/hosts`};
  for(const row of target.filter(r=>r.target.startsWith("/etc/")))row.root=`${root}/containers/${hex}/${row.target.slice(5)}`;
  const parent=[mount(1,0,"/","ext4","8:1",["rw"]),mount(2,1,"/var/lib/docker-shadow","nsfs","0:101",["rw"],"net:[123]")];
  assert.equal(api.validateMetadataMounts(inspect,target,parent,root,hex).length,3);assert.ok(api.validateMetadataMounts(inspect,target,parent,root,hex).every(r=>r.parent.length===1));
  parent[1].target=`${root}/containers`;assert.throws(()=>api.validateMetadataMounts(inspect,target,parent,root,hex));
});
test("same observer cgroup opaque rows retain every mountpoint overmount and parser rejection",async()=>{
  for(const suffix of ["", "/docker", `/docker/${hex}`, `/docker/${hex}/deep`,...['memory.max','memory.swap.max','pids.max','cpu.max'].map(x=>`/docker/${hex}/${x}`)]){
    const f=await cgroupFixture(({state})=>state.parentRows.push(mount(3,2,"/sys/fs/cgroup"+suffix,"nsfs","0:101",["rw"],"net:[123]")));await assert.rejects(f.admission.observe(123,1));
  }
  const missing=await cgroupFixture(({state})=>state.parentRows[1].target="/sys/fs/cgroup-shadow");await assert.rejects(missing.admission.observe(123,1));
  const api=await parentAdmissionFactory(),row=()=>mount(1,0,"/","ext4","8:1",["rw"],"net:[123]");
  for(const value of [undefined,null,"","\0","a\tb","a\nb","a\rb","a\x7fb","x".repeat(128*1024)])assert.throws(()=>api.parentMountTable([{...row(),root:value}]));
  for(const value of ["\\000","\\777","\\x20","\\","a\\011b","a\\012b"]){const r=row();r.root=value;assert.throws(()=>api.parseParentMounts(parentMountText([r])));}
  for(const value of ["relative","/a/../b","/a//b","/a/.","/a/","/a\tb"]){const r=row();r.target=value;assert.throws(()=>api.parentMountTable([r]));}
  for(const mutate of [r=>r.id=0,r=>r.parentId=-1,r=>r.device="0:01",r=>r.fs="bad fs",r=>r.options=["rw","ro"],r=>r.superOptions=[],r=>r.optional=null]){const r=row();mutate(r);assert.throws(()=>api.parentMountTable([r]));}
  assert.equal(api.parentMountTable([row(),{...row(),id:2}]).length,2);assert.throws(()=>api.parentMountTable([row(),{...row(),target:"/other"}]));
});
test("same observer cgroup opaque root evidence stays parent only bounded and preserves undefined failures",async()=>{
  for(const [bad,leaf] of [[undefined,1],["",2],["x".repeat(128*1024),3],["a\tb",4]]){
    const api=await parentAdmissionFactory(),ledger=api.createParentAdmissionLedger();ledger.enter("parent_mount_parse");let reason;try{api.parentMountRoot(bad,ledger);}catch(e){reason=e;}
    const detail=ledger.finish(true,reason);assert.equal(detail.m[1],30);assert.equal(detail.m[2],leaf);validateParentAdmission(detail);assert.throws(()=>validateInitDetail({source:"mount_parse",guard:"mounts",m:detail.m}));
    for(const mutate of [r=>r.m[5]=1,r=>r.m[5]=2,r=>r.detail[1]=19,r=>r.m[3]=2,r=>r.m[4]=2]){const r=structuredClone(detail);mutate(r);assert.throws(()=>validateParentAdmission(r));}
    const report=createContainerDiagnostics();report.mark("entry","rejected",reason);report.internal(detail);const captured=await attachWithFrames(initReady());createAttachProjection(captured.h.attached,captured.binding,report)(captured.h.attached.result);report.mark("retirement","rejected",undefined);for(const phase of ["dispatch","image","base","create","attach","ready","cwd","temp","environment"])report.mark(phase,"fulfilled");
    const lines=[];emitContainerFailure(report.records,x=>lines.push(x));assert.equal(lines.length,10);assert.ok(lines.every(x=>Buffer.byteLength(x)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);parentAdmissionPackets.push(lines.map(x=>JSON.parse(x.slice(x.indexOf("::",2)+2).trimEnd())));
  }
  const f=await cgroupFixture(({state})=>state.parentRows.push(mount(3,1,"/run/held-ns","nsfs","0:101",["rw"],"bad\\011root"))),ledger=f.api.createParentAdmissionLedger();let reason;try{await f.admission.observe(123,1,ledger);}catch(e){reason=e;}const detail=ledger.finish(true,reason);assert.equal(detail.detail[1],28);assert.equal(detail.m[1],30);assert.equal(detail.m[2],4);
  const fail=await cgroupFixture(({io})=>{const read=io.read;io.read=path=>path==="/proc/self/mountinfo"?Promise.reject(undefined):read(path);});let caught=false;try{await fail.admission.observe(123,1);}catch(e){caught=true;assert.equal(e,undefined);}assert.ok(caught);
  const api=await parentAdmissionFactory(),broken=api.createParentAdmissionLedger();broken.enter("parent_mount_parse");broken.mount=()=>{throw undefined;};assert.throws(()=>api.parentMountRoot("",broken));assert.ok(broken.errors.includes(undefined));
});
test("parent target ambiguity retains unrelated covered rows but never weakens child or ID uniqueness", async()=>{
  const f=await cgroupFixture(({state})=>state.parentRows.push(mount(3,1,"/unrelated","tmpfs","0:111",["rw"]),mount(4,3,"/unrelated","tmpfs","0:112",["ro"])));
  const parsed=f.api.parseParentMounts(parentMountText(f.state.parentRows));assert.deepEqual(parsed,f.state.parentRows);assert.throws(()=>f.api.parseMounts(parentMountText(f.state.parentRows),false));
  const first=await f.admission.observe(123,1),second=await f.admission.observe(123,2);assert.equal(first.parentMounts.length,4);assert.equal(second.parentMounts.length,4);assert.equal(await f.retire(second.bound),"empty");
  f.state.parentRows[3].id=3;await assert.rejects(f.retire(second.bound));assert.throws(()=>f.api.parseParentMounts(parentMountText(f.state.parentRows)));
});
test("parent target ambiguity rejects every metadata relation before cgroup physical binding", async()=>{
  for(const name of ["resolv.conf","hostname","hosts"])for(const relation of ["ancestor","equal","descendant","unique_equal","unique_descendant","covered_ancestor"]){
    const source=`/var/lib/docker/containers/${hex}/${name}`,target=relation.includes("ancestor")?"/var":relation.endsWith("descendant")?source+"/deep":source;
    const f=await cgroupFixture(({state})=>{state.parentRows.push(mount(3,1,target,"ext4","8:1",["rw"]));if(!relation.startsWith("unique"))state.parentRows.push(mount(4,3,target,"ext4","8:1",["rw"]));if(relation==="covered_ancestor")state.parentRows.push(mount(5,4,"/var/lib/docker","ext4","8:1",["rw"]));});
    const ledger=f.api.createParentAdmissionLedger();let reason;try{await f.admission.observe(123,1,ledger);}catch(e){reason=e;}assert.ok(reason);assert.ok(!f.state.calls.some(([kind])=>kind==="stat"||kind==="realpath"));
    const detail=ledger.finish(true,reason);assert.equal(detail.detail[4],relation.startsWith("unique")?58:relation.includes("ancestor")?55:relation==="equal"?56:57);validateParentAdmission(detail);
    const targetRows=mounts();for(const r of targetRows.filter(r=>r.target.startsWith("/etc/")))r.root=`/var/lib/docker/containers/${hex}/${r.target.slice(5)}`;
    let composed=0;const api=await parentAdmissionFactory({relative:(...a)=>{composed++;return relative(...a);}});assert.throws(()=>api.validateMetadataMounts(f.metadata.inspect,targetRows,f.state.parentRows,f.metadata.daemonRoot,hex));assert.equal(composed,0);
  }
});
test("parent target ambiguity covers cgroup ancestors every owned descendant both visits and retirement", async()=>{
  const protectedTargets=["/","/sys","/sys/fs","/sys/fs/cgroup","/sys/fs/cgroup/docker",`/sys/fs/cgroup/docker/${hex}`,...["deep","memory.max","memory.swap.max","pids.max","cpu.max","cgroup.procs","cgroup.events"].map(x=>`/sys/fs/cgroup/docker/${hex}/${x}`),`/var/lib/docker/containers/${hex}/hosts`];
  for(const target of protectedTargets)for(const stage of ["first","repeat","retire"]){
    const f=await cgroupFixture();let bound;if(stage!=="first")bound=(await f.admission.observe(123,1)).bound;if(stage==="retire")bound=(await f.admission.observe(123,2)).bound;
    f.state.parentRows.push(mount(3,1,target,"tmpfs","0:111",["rw"]),mount(4,3,target,"tmpfs","0:112",["ro"]));
    const before=f.state.calls.length;await assert.rejects(stage==="retire"?f.retire(bound):f.admission.observe(123,stage==="first"?1:2));assert.ok(!f.state.calls.slice(before).some(([kind])=>kind==="stat"||kind==="realpath"));
  }
});
test("parent target ambiguity is order independent and component bounded without resolving stack tops", async()=>{
  for(const order of [false,true])for(const offset of [0,100])for(const accepted of [false,true]){
    const f=await cgroupFixture(({state})=>{const target=accepted?"/sys/fs/cgroup-shadow":"/sys";state.parentRows.push(mount(3,1,target,"tmpfs","0:111",["rw"]),mount(4,3,target,"tmpfs","0:112",["ro"]));if(!accepted)state.parentRows.push(mount(5,4,"/sys/fs","tmpfs","0:113",["rw"]));for(const r of state.parentRows){r.id+=offset;r.parentId+=offset;}if(order)state.parentRows.reverse();});
    if(accepted){const first=await f.admission.observe(123,1),second=await f.admission.observe(123,2);assert.equal(first.parentMounts.length,4);assert.equal(await f.retire(second.bound),"empty");}else await assert.rejects(f.admission.observe(123,1));
  }
  const f=await cgroupFixture(({state})=>state.parentRows.push(mount(3,1,`/var/lib/docker/containers/${hex}/hosts-shadow`,"tmpfs","0:111",["rw"]),mount(4,3,`/var/lib/docker/containers/${hex}/hosts-shadow`,"tmpfs","0:112",["rw"])));await f.admission.observe(123,1);const second=await f.admission.observe(123,2);assert.equal(await f.retire(second.bound),"empty");
});
test("parent target authority cannot be missing empty foreign or replaced by a caller path list", async()=>{
  for(const metadata of [undefined,{}, {paths:[]}, {daemonRoot:"/var/lib/docker",inspect:{}}, {daemonRoot:"/var/lib/docker",inspect:{ResolvConfPath:`/var/lib/docker/containers/${other}/resolv.conf`}}]){
    const f=await cgroupFixture(),ledger=f.api.createParentAdmissionLedger();const admission=f.api.createParentCgroupAdmission(hex,{mnt:"mnt:[1]"},identity,f.io,metadata);let reason;try{await admission.observe(123,1,ledger);}catch(e){reason=e;}assert.ok(reason);assert.equal(ledger.finish(true,reason).detail[4],59);assert.ok(!f.state.calls.some(([k])=>k==="realpath"||k==="stat"));
  }
  const f=await cgroupFixture(), reason=undefined;Object.defineProperty(f.metadata.inspect,"ResolvConfPath",{get(){throw reason;}});let caught=false;try{await f.admission.observe(123,1);}catch(e){caught=true;assert.equal(e,reason);}assert.ok(caught);
});
test("parent target ambiguity actual diagnostics retain first failure undefined reporting and bounded packets",async()=>{
  for(const [target,predicate,role] of [["/sys",55,25],["/sys/fs/cgroup",56,25],["/sys/fs/cgroup/deep",57,25],[`/var/lib/docker/containers/${hex}/hosts`,56,16],[`/var/lib/docker/containers/${hex}/hostname`,58,15],[null,59,14]]){
    const f=await cgroupFixture(({state})=>{if(target){state.parentRows.push(mount(3,1,target,"tmpfs","0:111",["rw"]));if(predicate!==58)state.parentRows.push(mount(4,3,target,"tmpfs","0:112",["ro"]));}}),ledger=f.api.createParentAdmissionLedger();if(predicate===59)f.metadata.inspect.ResolvConfPath="/foreign";let reason;try{await f.admission.observe(123,1,ledger);}catch(e){reason=e;}const detail=ledger.finish(true,reason);assert.equal(detail.detail[4],predicate);assert.equal(detail.detail[6],role);validateParentAdmission(detail);
    for(const mutate of [r=>r.detail[1]=19,r=>r.detail[6]=1,r=>r.detail[7]=0,r=>r.detail[8]=1,r=>r.detail[9]=4095,r=>r.detail[10]=1]){const bad=structuredClone(detail);mutate(bad);assert.throws(()=>validateParentAdmission(bad));}
    const report=createContainerDiagnostics();report.mark("entry","rejected",reason);report.internal(detail);const captured=await attachWithFrames(initReady());createAttachProjection(captured.h.attached,captured.binding,report)(captured.h.attached.result);report.mark("retirement","rejected",undefined);for(const phase of ["dispatch","image","base","create","attach","ready","cwd","temp","environment"])report.mark(phase,"fulfilled");
    const lines=[];emitContainerFailure(report.records,x=>lines.push(x));assert.equal(lines.length,10);assert.ok(lines.every(x=>Buffer.byteLength(x)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);parentAdmissionPackets.push(lines.map(x=>JSON.parse(x.slice(x.indexOf("::",2)+2).trimEnd())));
  }
  const f=await cgroupFixture(({state})=>state.parentRows.push(mount(3,1,"/sys","tmpfs","0:111",["rw"]),mount(4,3,"/sys","tmpfs","0:112",["rw"]))),ledger=f.api.createParentAdmissionLedger();ledger.leaf=()=>{throw undefined;};await assert.rejects(f.admission.observe(123,1,ledger));assert.ok(ledger.errors.includes(undefined));assert.ok(!f.state.calls.some(([k])=>k==="realpath"||k==="stat"));
});
// Receipt diagnostics exercise extracted production helpers with inert values.
const receiptPackets = [];
const receiptView = row=>row.v===18?receiptView(unpackReceiptObservedWranglerDiagnostic(row)):row.v===17?receiptView(unpackReceiptWranglerDiagnostic(row)):row.v===16?receiptView(unpackReceiptCensusDiagnostic(row)):[14,15].includes(row.v)?unpackReceiptOwnedDiagnostic({...row,v:13,detail:row.detail.slice(0,8)}):row.v===13?unpackReceiptOwnedDiagnostic(row):row;
async function receiptParserFactory(overrides = {}) {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("const receiptRecord ="), source.indexOf("export function raiseContainerFailures("));
  const parser = source.slice(source.indexOf("export function createReceiptLedger("), source.indexOf("async function containerInit(")).replaceAll("export ", "");
  const masks = source.slice(source.indexOf("export function validateMaskCompletion("), source.indexOf("export async function validateEmptyMasks(")).replaceAll("export ", "");
  const bindings = { check: (value, code) => { if (!value) throw new Error(code); }, same: (a,b) => JSON.stringify(a) === JSON.stringify(b), Buffer, JSON, Object, hashPattern: /^[a-f0-9]{64}$/, receiptOperations, validateReceiptDiagnostic, validateReceiptBoundaryDiagnostic, validateReceiptLifecycleDiagnostic, validateReceiptBuilderDiagnostic, validateReportedBuilderProcess, receiptBuilderSignals, packReceiptOwnedDiagnostic, packReceiptCodeDiagnostic, packReceiptAssociatedDiagnostic, validateReceiptAssociatedDiagnostic, packReceiptCensusDiagnostic, packReceiptObservedWranglerDiagnostic, unpackReceiptObservedWranglerDiagnostic, validateReceiptObservedWranglerDiagnostic, packObservedWranglerCloseDiagnostic, validateObservedWranglerCloseDiagnostic, validateObservedWranglerGroup, packReceiptWranglerDiagnostic, unpackReceiptObservedWranglerDiagnostic, unpackReceiptObservedWranglerDiagnostic, validateReceiptObservedWranglerDiagnostic, packObservedWranglerCloseDiagnostic, validateObservedWranglerCloseDiagnostic, validateObservedWranglerGroup, packReceiptWranglerDiagnostic, validateReceiptWranglerDiagnostic, packWranglerCloseDiagnostic, validateWranglerCloseDiagnostic, validateReportedWranglerProcess, unpackReceiptCensusDiagnostic, validateReceiptCensusDiagnostic, packCensusCloseDiagnostic, unpackCensusCloseDiagnostic, validateCensusCloseDiagnostic, validateFinalCensus, createFinalCensusLedger, censusStates, unpackReceiptOwnedDiagnostic, validateReceiptOwnedDiagnostic, validateOwnedTrace, validateOwnedCloseDiagnostic, createOwnedProcessLedger, createProjectionLedger, raiseContainerFailures,
    edgeProof: { sourceSha: "c".repeat(40), sourceTree: "d".repeat(40) }, containerContract, ...overrides };
  const api = new Function(...Object.keys(bindings), helpers + masks + parser + "return {parseContainerReceipt,createReceiptLedger,observeContainerReceipt};")(...Object.values(bindings));
  const plan = { nonce: hex, contextHash: other, nativeHash: imageId.slice(7) };
  const result = { code: 0, signal: null, closed: true, sha256: hex, observedProcesses: 1 };
  const value = { version: 2, isolation: "private-container-pid-net-mount", ...plan, ...bindings.edgeProof, sourceFiles: 600, dependencyFiles: 268, exactErasures: 4, twoRoots: true, cliSha256: containerContract.cliHash, results: { edge: {...result}, upstream: {...result} }, cloud: "UNRUN", sdk: "UNRUN", masks: [1,2,2,2,2,"UNOBSERVABLE"] };
  return { ...api, plan, value, text: value => "EDGE_CONTAINER_RECEIPT_V2 " + JSON.stringify(value) + "\n" };
}
function receiptWrapperFrames(failAt, failReason = undefined) {
  const frames = [], report = createPackagingDiagnostics("child", line => frames.push(line));
  let failed = false;
  const step = phase => { try { report.sync(phase, () => { if (phase === failAt) throw failReason; }); } catch { failed = true; } return !failed; };
  report.mark("entry", "fulfilled");
  for (const phase of ["namespace_read", "process_inventory", "environment"]) if (!step(phase)) break;
  for (const role of ["build_a", "build_b"]) {
    if (failed) break;
    report.mark(role + "_launch", "enter"); report.mark(role + "_close", "fulfilled");
    for (const phase of ["stdout_summary", "stderr_summary"]) report.accept({v:1,role:"child",phase,outcome:"observed",bytes:0,sha256:hex,esc:false,complete:true});
    report.accept({v:1,role:"child",phase:"protocol_summary",outcome:"observed",valid:12,entry:1,final:1,rejected:0,foreign:0,malformed:0,receipts:1,unclassified:0,complete:true});
    const builder = createPackagingDiagnostics(role, line => frames.push(line)); builder.mark("entry","fulfilled");
    for (const phase of ["namespace_read","builder_import","build","receipt_write","build_service_stop"]) builder.sync(phase,()=>{});
    builder.mark("final","fulfilled"); report.mark(role+"_report","fulfilled");
    step(role+"_report");
  }
  for (const phase of ["two_roots","wrangler_input"]) if (!failed) step(phase);
  for (const role of ["edge","upstream"]) {
    if (failed || !step(role+"_config")) break;
    report.mark(role+"_launch","enter"); report.mark(role+"_close","fulfilled");
    for (const suffix of ["output","marker","hash","privacy"]) if (!failed) step(role+"_"+suffix);
  }
  for (const phase of ["final_namespace","final_descendants"]) if (!failed) step(phase);
  report.mark("final",failed?"rejected":"fulfilled",failReason);
  return {frames,report};
}
async function receiptCapture(frames) {
  const init = await initCapture(); const {h,binding} = await attachWithFrames(init.frames.slice(0,7).join("") + initReady() + init.frames.slice(7).join("") + frames.join(""));
  const initSummary = parseInitPrerequisites(h.attached.result,binding);
  return {h,binding,initSummary,summary:recorder=>parseChildPackaging(h.attached.result,binding,initSummary,recorder)};
}
test("receipt child actual producer repeated reports and complete role failures remain wrapper-only", async () => {
  for (const phase of [undefined,"namespace_read","process_inventory","environment","build_a_report","build_b_report","two_roots","wrangler_input","edge_config","edge_output","edge_marker","edge_hash","edge_privacy","upstream_config","upstream_output","upstream_marker","upstream_hash","upstream_privacy","final_namespace","final_descendants"]) {
    const {frames,report}=receiptWrapperFrames(phase), capture=await receiptCapture(frames), summary=capture.summary();
    assert.equal(summary[1],phase?"reported_rejection":"reported_complete"); assert.equal(summary[8],"UNKNOWN");
    if(phase) {assert.equal(summary[6],receiptChildPhases.indexOf(phase)+1);assert.equal(summary[7],false);} else {report.errors.push(undefined);assert.equal(capture.summary()[8],"UNKNOWN");}
    const api=await receiptParserFactory(), diagnostics=createContainerDiagnostics();
    await assert.rejects(api.observeContainerReceipt(diagnostics,"",api.plan,capture.summary));
    const detail=receiptView(diagnostics.records.find(row=>row.phase==="receipt"&&row.v>=9));assert.equal(detail.parser[3],3);assert.deepEqual(detail.child,summary);
    const full=[{v:2,phase:"entry",state:"rejected",defined:true,exit:null,signal:null},...diagnostics.records];
    const project=createAttachProjection(capture.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:row=>full.push(row)});project(capture.h.attached.result);
    full.push({v:2,phase:"retirement",state:"rejected",defined:false,exit:null,signal:null});
    const lines=[];emitContainerFailure(full,line=>lines.push(line)); receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
    assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
  }
});
test("receipt child lifecycle canonical frames reject malformed foreign duplicates tails and null rejection", async () => {
  const original=receiptWrapperFrames("build_b_report").frames;
  const row=line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));
  const mutations=[
    frames=>frames.slice(0,-1), frames=>[...frames,frames.at(-1)], frames=>[...frames.slice(0,-1),frames.at(-1).trimEnd()],
    frames=>frames.map((line,i)=>i===0?line.replace('"v":1','"v":1,"v":1'):line),
    frames=>frames.map((line,i)=>i===0?line.replace('"child"','"parent"'):line),
    frames=>frames.map(line=>line.includes('"rejected"')?line.replace('"defined":false','"defined":null'):line),
    frames=>frames.map((line,i)=>i===0?"private-tail"+line:line),
    frames=>frames.map((line,i)=>i===0?line.replace('"entry"','"entry\\u001b"'):line),
    frames=>{const copy=[...frames];[copy[1],copy[2]]=[copy[2],copy[1]];return copy;},
    frames=>frames.filter(line=>!(row(line).role==="build_a"&&row(line).phase==="final")),
  ];
  for(const mutate of mutations){const c=await receiptCapture(mutate([...original]));assert.ok(["invalid","incomplete"].includes(c.summary()[1]));}
  for(const field of ["stdout","stderr"]){const c=await receiptCapture(original);c.h.attached.result.outputSummary[field].sha256=other;assert.equal(c.summary()[1],"capture_mismatch");}
  const c=await receiptCapture(original);c.binding.cid="invalid";assert.equal(c.summary()[1],"binding_unavailable");
  const d=await receiptCapture(original);d.h.attached.result.supervisor[4]=false;assert.equal(d.summary()[1],"capture_unavailable");
  const e=await receiptCapture(original);e.h.attached.result.outputSummary.stdout.truncated=true;assert.equal(e.summary()[1],"capture_unavailable");
  const f=await receiptCapture(original);f.initSummary.reason="incomplete";assert.equal(f.summary()[1],"init_unqualified");
});
test("receipt child actual parser original false leaves operation throws and getters preserve evaluation", async () => {
  const base=await receiptParserFactory();assert.deepEqual(base.parseContainerReceipt(base.text(base.value),base.plan),base.value);
  for(const [mutate,op,leaf] of [
    [v=>v.version=3,6,1],[v=>v.nonce=other,6,3],[v=>v.cloud="RUN",6,14],
    [v=>v.masks[5]="known",7,8],[v=>v.results.edge.code=1,11,1],[v=>v.results.upstream.observedProcesses=0,11,6],
    [v=>v.extra=true,5,1],[v=>v.results.extra={},8,1],[v=>v.results.edge.extra=true,10,1],
  ]){const value=structuredClone(base.value);mutate(value);const ledger=base.createReceiptLedger();let reason;try{base.parseContainerReceipt(base.text(value),base.plan,ledger);}catch(error){reason=error;}assert.ok(reason);const tuple=ledger.finish(2,reason);assert.equal(tuple[3],op);assert.equal(tuple[5],leaf);validateReceiptDiagnostic({v:9,phase:"receipt",state:"rejected",defined:true,exit:null,signal:null,parser:tuple,child:[1,"no_records",0,0,0,0,0,null,"UNKNOWN"],reports:[0,0]});}
  for(const [text,op] of [[{split(){throw undefined;}},1],[{split(){return{filter(){throw undefined;}};}},2],["EDGE_CONTAINER_RECEIPT_V2 {\n",4]]){const ledger=base.createReceiptLedger();let failed=false,reason;try{base.parseContainerReceipt(text,base.plan,ledger);}catch(error){failed=true;reason=error;}assert.equal(failed,true);assert.equal(ledger.finish(2,reason)[3],op);}
  for(const fail of [false,true]){
    const reads=[],value=structuredClone(base.value);Object.defineProperty(value,"version",{enumerable:true,get(){reads.push("version");return fail?3:2;}});Object.defineProperty(value,"isolation",{enumerable:true,get(){reads.push("isolation");throw undefined;}});
    const api=await receiptParserFactory({JSON:{parse:()=>value,stringify:JSON.stringify}}),ledger=api.createReceiptLedger();let reason;try{api.parseContainerReceipt(base.text(base.value),base.plan,ledger);}catch(error){reason=error;}
    assert.deepEqual(reads,fail?["version"]:["version","isolation"]);const tuple=ledger.finish(2,reason);assert.equal(tuple[4],fail?1:2);assert.equal(tuple[7],1);assert.equal(tuple[8],fail?0:1);assert.equal(tuple[2],fail);
  }
});
test("receipt child original undefined and reporter failures remain independent from retirement", async () => {
  const api=await receiptParserFactory(), unknown=()=>[1,"no_records",0,0,0,0,0,null,"UNKNOWN"];
  for(const phase of ["entered","rejected","fulfilled"]){const report=createContainerDiagnostics(),push=report.records.push.bind(report.records);report.records.push=(row)=>{if(row.phase==="receipt"&&row.state===phase&&row.v===2)throw undefined;return push(row);};
    let reason,failed=false;try{await api.observeContainerReceipt(report,phase==="fulfilled"?api.text(api.value):{split(){throw undefined;}},api.plan,unknown);}catch(error){reason=error;failed=true;}assert.equal(failed,true);
    if(phase==="rejected"){assert.ok(reason instanceof AggregateError);assert.deepEqual(reason.errors,[undefined,undefined]);}else assert.equal(reason,undefined);
    const detail=receiptView(report.records.find(row=>row.phase==="receipt"&&row.v>=9));assert.ok(detail);assert.equal(detail.parser[1],phase==="entered"?0:phase==="fulfilled"?1:2);assert.deepEqual(detail.reports,[1,1]);
    assert.throws(()=>raiseContainerFailures([reason,undefined]),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors[1]===undefined);
  }
  const ledger=api.createReceiptLedger();ledger.enter=()=>{throw undefined;};const report=createContainerDiagnostics();await assert.rejects(api.observeContainerReceipt(report,api.text(api.value),api.plan,unknown,ledger));assert.equal(receiptView(report.records.find(row=>row.phase==="receipt"&&row.v>=9)).parser,null);
});
test("receipt child schema closed relationships priority and quotas reject invalid tuples", async () => {
  const api=await receiptParserFactory(),report=createContainerDiagnostics();await assert.rejects(api.observeContainerReceipt(report,"",api.plan,()=>[1,"reported_rejection",256,7,2,3,33,false,"UNKNOWN"]));
  const detail=receiptView(report.records.find(row=>row.phase==="receipt"&&row.v>=9));validateContainerDiagnostic(detail);
  for(const mutate of [v=>v.child[7]=null,v=>v.child[8]="CLEAN",v=>v.child[3]=0,v=>v.parser[7]=3,v=>v.parser[8]=1,v=>v.parser[2]=false,v=>v.reports=[0,1]]){const bad=structuredClone(detail);mutate(bad);assert.throws(()=>validateContainerDiagnostic(bad));}
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8"), containerDiagnosticPhases=JSON.parse(/const containerDiagnosticPhases = (\[[^\n]+\]);/.exec(source)[1]);
  const many=[...Array.from({length:30},(_,i)=>({v:2,phase:containerDiagnosticPhases.filter(phase=>!["image_build_process","image_build_internal","native_prepare_internal","attach_process","init_prerequisite","overflow"].includes(phase))[i],state:"fulfilled",defined:null,exit:null,signal:null})),detail,{v:2,phase:"entry",state:"rejected",defined:true,exit:null,signal:null}];const lines=[];emitContainerFailure(many,line=>lines.push(line));assert.equal(lines.length,10);assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf("::{")+2)).v,12);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
});
test("receipt child parser every original boundary retains undefined without later operand reads", async () => {
  const base=await receiptParserFactory();
  for(const [operation,overrides,text] of [
    [3,{}, {split(){return{filter(){return new Proxy([],{get(target,key){if(key==="length")throw undefined;return Reflect.get(target,key);}});}};}}],
    [4,{JSON:{parse(){throw undefined;},stringify:JSON.stringify}},base.text(base.value)],
    [5,{Object:{...Object,getOwnPropertyNames(){throw undefined;}}},base.text(base.value)],
    [9,{Object:{getOwnPropertyNames:Object.getOwnPropertyNames,values(){throw undefined;},is:Object.is}},base.text(base.value)],
  ]) {const api=await receiptParserFactory(overrides),ledger=api.createReceiptLedger();let failed=false,reason;try{api.parseContainerReceipt(text,api.plan,ledger);}catch(error){failed=true;reason=error;}assert.equal(failed,true);assert.equal(reason,undefined);assert.equal(ledger.finish(2,reason)[3],operation);}
  const big=base.text({...base.value,padding:"x".repeat(8192)}),ledger=base.createReceiptLedger();assert.throws(()=>base.parseContainerReceipt(big,base.plan,ledger));assert.deepEqual(ledger.finish(2,new Error()).slice(3),[3,1,2,0,3,1]);
  for(const key of ["masks","results"]){const value=structuredClone(base.value);Object.defineProperty(value,key,{enumerable:true,get(){throw undefined;}});const api=await receiptParserFactory({JSON:{parse:()=>value,stringify:JSON.stringify}}),ledger=api.createReceiptLedger();let reason,failed=false;try{api.parseContainerReceipt(base.text(base.value),api.plan,ledger);}catch(error){reason=error;failed=true;}assert.equal(failed,true);assert.equal(reason,undefined);assert.equal(ledger.finish(2,reason)[3],key==="masks"?7:8);}
});
test("receipt child original capture tail integrity and reporting failure never become accepted evidence", async () => {
  const frames=receiptWrapperFrames("namespace_read").frames;
  for(const key of ["stdout","stderr"])for(const field of ["bytes","retainedBytes","retainedSha256","complete"]){const c=await receiptCapture(frames),summary=c.h.attached.result.outputSummary[key];summary[field]=field.endsWith("Sha256")?other:field==="complete"?false:summary[field]+1;assert.ok(["capture_mismatch","capture_unavailable"].includes(c.summary()[1]));}
  const api=await receiptParserFactory(),report=createContainerDiagnostics();report.internal=()=>{throw undefined;};let reason;try{await api.observeContainerReceipt(report,{split(){throw undefined;}},api.plan,()=>[1,"no_records",0,0,0,0,0,null,"UNKNOWN"]);}catch(error){reason=error;}assert.ok(reason instanceof AggregateError);assert.deepEqual(reason.errors,[undefined,undefined]);
  const original=receiptWrapperFrames("namespace_read").frames, c=await receiptCapture(original);const otherBinding={...c.binding,attached:{result:{...c.h.attached.result}}};assert.equal(parseChildPackaging(c.h.attached.result,otherBinding,c.initSummary)[1],"binding_unavailable");
});
// Native-child tests use only inert event objects and ordinary promises. No
// library, process, native stream or actual diagnostics subscriber is acquired.
async function nativeOwnerFixture(options = {}) {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function createNativeChildOwner("), source.indexOf("async function containerBuild("));
  const subscribers = new Set(), foreign = () => {}, calls = [], routes = [["/immutable/tsc", "--api", "--cwd", "/task/capsule-a"], ["/immutable/esbuild", "--service=0.28.2", "--ping"]];
  subscribers.add(foreign);
  const publication = {
    subscribe(fn) { calls.push("subscribe"); subscribers.add(fn); if (options.subscribeFailure) throw options.reason; },
    unsubscribe(fn) { calls.push("unsubscribe"); const removed = subscribers.delete(fn); if (options.unsubscribeFailure) throw options.reason; return removed; },
  };
  const factory = new Function("channel", "errorMonitor", "check", "raiseContainerFailures", body + "return createNativeChildOwner;")(
    name => { assert.equal(name, "child_process"); return publication; }, errorMonitor,
    (ok, label) => { if (!ok) throw new Error(label); }, raiseContainerFailures,
  );
  const owner = factory(routes);
  const publish = child => { for (const fn of [...subscribers]) fn({ process: child }); };
  let nextPid = 10;
  const construct = (role = 0, configuration = {}) => {
    const child = new EventEmitter(); child.references = 0;
    child.ref = function() { assert.equal(this, child); calls.push("ref"); this.references++; if (configuration.refFailure) throw configuration.reason; return this; };
    const originalOn = child.on, originalRemove = child.removeListener;
    child.on = function(event, listener) { assert.equal(this, child); if (event === configuration.listenerBeforeFailure) throw configuration.reason; originalOn.call(this, event, listener); if (event === configuration.listenerFailure) throw configuration.reason; return this; };
    child.removeListener = function(event, listener) { assert.equal(this, child); originalRemove.call(this, event, listener); if (configuration.removeFailure) throw configuration.reason; return this; };
    publish(child); // Constructor has neither PID nor spawn metadata yet.
    child.launch = () => {
      child.pid = nextPid++; child.spawnfile = routes[role]?.[0] ?? "/foreign"; child.spawnargs = [...(routes[role] ?? ["/foreign"])]; child.emit("spawn");
    };
    return child;
  };
  return { owner, construct, publish, calls, subscribers, foreign, routes };
}
async function nativeOwnerFailure(promise) { let failed = false, reason; try { await promise; } catch (error) { failed = true; reason = error; } assert.equal(failed, true); return reason; }
function nativeOwnerErrors(reason) { return reason instanceof AggregateError ? reason.errors.flatMap(nativeOwnerErrors) : [reason]; }
test("native child owner original close stays pending after stop and exit and survives later unref", async () => {
  const f = await nativeOwnerFixture(); f.owner.start(); const a = f.construct(), b = f.construct(1);
  a.launch(); b.launch(); a.references = b.references = 0; // library's final unref
  let done = false; const drain = f.owner.drain(true).then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); assert.equal(a.references, 1); assert.equal(b.references, 1);
  a.emit("exit", 0, null); b.emit("exit", 0, null); await Promise.resolve(); assert.equal(done, false);
  a.emit("close", 0, null); await Promise.resolve(); assert.equal(done, false);
  b.emit("close", 0, null); await drain; assert.equal(done, true);
  assert.deepEqual([...f.subscribers], [f.foreign]); assert.equal(a.listenerCount(errorMonitor), 0); assert.equal(a.listenerCount("error"), 0);
});
async function nativeOwnerPending(promise, fixture) {
  let settled = false; promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(settled, false); assert.equal(fixture.subscribers.size, 2);
  assert.equal(fixture.calls.includes("unsubscribe"), false);
}
test("native child owner missing PID async spawn error remains pending until original close", async () => {
  for (const reason of [undefined, Object.freeze({ original: true })]) for (const timing of ["before-drain", "after-drain"]) {
    const f = await nativeOwnerFixture(), child = f.construct(); let seen = 0;
    child.on("error", value => { assert.equal(value, reason); seen++; });
    if (timing === "before-drain") child.emit("error", reason);
    const pending = f.owner.drain(false); await nativeOwnerPending(pending, f);
    assert.equal(child.pid, undefined); assert.equal(child.references, 1);
    if (timing === "after-drain") child.emit("error", reason);
    await nativeOwnerPending(pending, f); assert.equal(seen, 1);
    child.emit("close", -1, null);
    const failure = await nativeOwnerFailure(pending); assert.equal(nativeOwnerErrors(failure).filter(error => error === reason).length, 1);
    assert.deepEqual([...f.subscribers], [f.foreign]); assert.equal(child.listenerCount(errorMonitor), 0);
  }
  const g = await nativeOwnerFixture(), early = g.construct(), reason = new Error("inert original");
  assert.throws(() => early.emit("error", reason), error => error === reason); // No error listener added.
  early.emit("close"); assert.ok(nativeOwnerErrors(await nativeOwnerFailure(g.owner.drain(false))).includes(reason));
  assert.equal(early.references, 0); // Already observed close needs no ref.
});
test("native child owner constructor-only and error-without-close have unresolved obligations", async () => {
  for (const variant of ["unconfirmed", "known-fixture-sync-throw", "error-without-close"]) {
    const f = await nativeOwnerFixture(), child = f.construct();
    // The fixture knows its synchronous call threw. The constructor channel does
    // not carry that operation/reason association, so the owner cannot use it.
    if (variant === "known-fixture-sync-throw") { let failed = false; try { throw undefined; } catch { failed = true; } assert.equal(failed, true); }
    if (variant === "error-without-close") { child.on("error", () => {}); child.emit("error", undefined); }
    const pending = f.owner.drain(false); await nativeOwnerPending(pending, f);
    assert.equal(child.listenerCount("close"), 1); assert.equal(child.listenerCount(errorMonitor), 1); assert.equal(child.references, 1);
    // No invented close/cleanup and no timeout fixture. The production owner is
    // still bounded by the unchanged outer supervisor, not this pure promise.
  }
});
test("native child owner unknown duplicate missing and changed routes deny success without skipping joins", async () => {
  for (const variant of ["foreign", "duplicate-role", "duplicate-object", "missing", "changed"]) {
    const f = await nativeOwnerFixture(), a = f.construct(variant === "foreign" ? 2 : 0); a.launch();
    const b = variant === "missing" ? null : f.construct(variant === "duplicate-role" ? 0 : 1); b?.launch();
    if (variant === "duplicate-object") f.publish(a);
    if (variant === "changed") a.spawnargs[1] = "--foreign";
    const drain = f.owner.drain(true); a.emit("close"); b?.emit("close"); await nativeOwnerFailure(drain);
    assert.deepEqual([...f.subscribers], [f.foreign]);
  }
});
test("native child owner fixed point includes late acquisitions and independent listener ref unsubscribe faults", async () => {
  const f = await nativeOwnerFixture(), a = f.construct(); a.launch();
  let b, done = false; a.on("close", () => { b = f.construct(1); b.launch(); });
  const drain = f.owner.drain(true).then(() => { done = true; }); a.emit("close"); await Promise.resolve(); await Promise.resolve();
  assert.equal(done, false); assert.ok(b.references > 0); b.emit("close"); await drain;
  for (const variant of ["listenerFailure", "refFailure", "removeFailure", "unsubscribeFailure", "subscribeFailure"]) {
    const options = { reason: undefined, [variant]: true }, g = await nativeOwnerFixture(options);
    if (variant === "subscribeFailure") { assert.throws(() => g.owner.start()); await nativeOwnerFailure(g.owner.drain(false)); continue; }
    const c = g.construct(0, { ...options, listenerFailure: variant === "listenerFailure" ? "spawn" : undefined }); c.launch();
    const pending = g.owner.drain(false); c.emit("close"); const failure = await nativeOwnerFailure(pending);
    assert.ok(nativeOwnerErrors(failure).includes(undefined)); assert.deepEqual([...g.subscribers], [g.foreign]);
    assert.equal(c.listenerCount("close"), 0); assert.equal(c.listenerCount(errorMonitor), 0);
  }
});
test("native child owner close listener attach then throw retains ref join and original undefined", async () => {
  for (const reason of [undefined, Object.freeze({ attachment: true })]) {
    const f = await nativeOwnerFixture(), child = f.construct(0, { listenerFailure: "close", reason }); child.launch();
    const pending = f.owner.drain(false); await nativeOwnerPending(pending, f);
    assert.equal(child.references, 1); assert.equal(child.listenerCount("close"), 1);
    child.emit("close"); const failure = await nativeOwnerFailure(pending);
    assert.equal(nativeOwnerErrors(failure).filter(error => error === reason).length, 1);
    assert.equal(child.listenerCount("close"), 0); assert.deepEqual([...f.subscribers], [f.foreign]);
  }
});
test("native child owner missing close listener and lost capture never retire uncertain obligations", async () => {
  const f = await nativeOwnerFixture(), child = f.construct(0, { listenerBeforeFailure: "close", reason: undefined }); child.launch();
  const pending = f.owner.drain(false); await nativeOwnerPending(pending, f); assert.equal(child.references, 1);
  child.emit("close"); await nativeOwnerPending(pending, f); // Unobserved close is not completion.
  assert.equal(child.listenerCount(errorMonitor), 1);
  const g = await nativeOwnerFixture(), known = [];
  for (let i = 0; i < 4; i++) { const c = g.construct(i % 2); c.launch(); known.push(c); }
  const drain = g.owner.drain(false);
  known[0].on("close", () => g.construct()); // Overflow after the first join list was made.
  for (const c of known) c.emit("close");
  await nativeOwnerPending(drain, g); assert.equal(known[0].listenerCount(errorMonitor), 1);
});
test("native child owner late conflicting spawn still refs and joins original close", async () => {
  const f = await nativeOwnerFixture(), first = f.construct(); first.launch(); let late;
  first.on("close", () => { late = f.construct(2); late.launch(); });
  const pending = f.owner.drain(false); first.emit("close"); await nativeOwnerPending(pending, f);
  assert.ok(late.references >= 1); late.emit("close"); await nativeOwnerFailure(pending);
  assert.deepEqual([...f.subscribers], [f.foreign]);
});
test("native child owner missing foreign conflicting early metadata and callback faults keep close custody", async () => {
  for (const variant of ["missing-spawn", "early-metadata", "metadata-throw", "duplicate-spawn", "late-error"]) {
    const f = await nativeOwnerFixture(), child = f.construct();
    if (variant === "early-metadata") child.emit("spawn");
    if (variant === "metadata-throw") Object.defineProperty(child, "spawnfile", { configurable: true, get() { throw undefined; } });
    if (variant !== "metadata-throw" && variant !== "missing-spawn") child.launch();
    if (variant === "metadata-throw") child.emit("spawn");
    if (variant === "duplicate-spawn") child.emit("spawn");
    const pending = f.owner.drain(false); await nativeOwnerPending(pending, f); assert.equal(child.references, 1);
    child.emit("close");
    if (variant === "late-error") { child.on("error", () => {}); child.emit("error", undefined); }
    const reason = await nativeOwnerFailure(pending);
    if (variant === "late-error") assert.equal(nativeOwnerErrors(reason).filter(value => value === undefined).length, 1);
    if (variant === "metadata-throw") assert.ok(nativeOwnerErrors(reason).includes(undefined));
    assert.deepEqual([...f.subscribers], [f.foreign]);
  }
});

// The hash pins the complete function and these two manually audited AST
// expression spans. No search/replace can redirect another import or callee.
async function receiptActualBuilder(args, failure, options = {}) {
  const source=await readFile(new URL("../scripts/edge-proof-container.mjs",import.meta.url),"utf8");
  const from=source.indexOf("async function containerBuild("),to=source.indexOf("async function containerPrepare(",from);
  let body=source.slice(from,to);
  assert.equal(createHash("sha256").update(body).digest("hex"),"3bf9da32f9defefe60248bf2ebe3d73f029226ff9cb81c0b06060a43f91d1fab");
  for(const [start,end,original,replacement] of [[922,966,'import.meta.resolve("wrangler/package.json")','resolveWrangler("wrangler/package.json")'],[859,891,'import("./edge-proof-build.mjs")','importBuilder()']]){
    assert.equal(body.slice(start,end),original);body=body.slice(0,start)+replacement+body.slice(end);
  }
  const frames=[],calls=[],reason=Object.hasOwn(options,"reason")?options.reason:undefined;
  const capsule={sourceSha:"c".repeat(40),sourceTree:"d".repeat(40),sourceFiles:Array(600).fill(0),dependencyInputs:Array(268).fill(0),instrumentation:Array(4).fill({erasureExact:true}),observerSha256:hex,harnessInputs:[],bundles:{edge:hex,upstream:hex},runtime:{}};
  const git={path:"/immutable/git",sha256:hex}, environment=Object.freeze({GIT_CONFIG_NOSYSTEM:"1"});
  const visit=(name,...values)=>{calls.push([name,...values]);options.onVisit?.(name,...values);if(failure===name)throw reason;};
  let report,writeFailed=false;const ownerCalls=[];
  const esbuild={stop(){assert.equal(this,esbuild);visit("build_service_stop");if(options.stopFailure)throw options.stopReason;return options.stopPromise;}};
  const requireInert=function(name){visit("require",name);assert.equal(name,"esbuild");return esbuild;};
  const bindings={Array,Object,JSON,join,hashPattern:/^[a-f0-9]{64}$/,containerContract:{input:"/opt/edge-input"},gitEnvironment:environment,
    check:(value,code)=>{if(!value)throw new Error(code);},number:value=>{assert.equal(value,"501");return 501;},raiseContainerFailures,
    process:{stdout:{write(line){
      const row=JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));
      if(options.writeFailure&&row.phase===options.writeFailure[0]&&row.outcome===options.writeFailure[1]){writeFailed=true;throw options.writeReason;}
      frames.push(line);return true;
    }}},
    createPackagingDiagnostics:(...values)=>{report=createPackagingDiagnostics(...values);return report;},
    qualifyNativeChildRoutes:async(n,c)=>{ownerCalls.push(["qualify",n,c]);if(options.qualifyFailure)throw options.qualifyReason;return [["inert"]];},
    createNativeChildOwner:routes=>options.owner ?? {start(){ownerCalls.push(["start",routes]);if(options.startFailure)throw options.startReason;},async drain(complete){ownerCalls.push(["drain",complete]);if(options.drainFailure)throw options.drainReason;}},
    validateContainerRuntime:async(identity,builder)=>{visit("namespace_read",identity,builder);assert.equal(builder,true);assert.deepEqual(identity,{uid:Array(4).fill(501),gid:Array(4).fill(501),groups:[]});},
    nativeReceipt:async context=>{visit("native_receipt",context);assert.equal(context,hex);return{native:{git}};},
    importBuilder:async()=>{visit("builder_import");return{buildCapsule:async(...values)=>{
      visit("build",...values);assert.equal(values[0],"/opt/edge-input");assert.equal(values[1],args[0]);assert.deepEqual(values[2],{executable:git.path,sha256:git.sha256,env:{...environment}});return capsule;
    }};},
    resolveWrangler:specifier=>{visit("resolve",specifier);assert.equal(specifier,"wrangler/package.json");return"/immutable/wrangler/package.json";},
    createRequire:anchor=>{visit("createRequire",anchor);assert.equal(anchor,"/immutable/wrangler/package.json");return requireInert;},
    writeFile:async(...values)=>{visit("receipt_write",...values);assert.deepEqual(values,[join(args[0],"source-receipt.json"),JSON.stringify(capsule),{flag:"wx",mode:0o600}]);},
  };
  for(const name of ["check","number","raiseContainerFailures","createPackagingDiagnostics","qualifyNativeChildRoutes","createNativeChildOwner","validateContainerRuntime","nativeReceipt","importBuilder","resolveWrangler","createRequire","writeFile","join"])assert.equal(typeof bindings[name],"function",name);
  const run=new Function(...Object.keys(bindings),body+"return containerBuild;")(...Object.values(bindings));
  let failed=false,error,value;try{value=await run(args);}catch(thrown){failed=true;error=thrown;}
  return{frames,calls,report,failed,reason:error,value,writeFailed,ownerCalls};
}
async function receiptActualProducer(failure = "wrangler_input", writerFailure = false, builderOptions = {}) {
  const source = await readFile(new URL("../scripts/edge-proof.mjs", import.meta.url), "utf8");
  const cut = (a,b) => { assert.ok(source.includes(a) && source.includes(b)); return source.slice(source.indexOf(a),source.indexOf(b)).replaceAll("export ",""); };
  const diagnostics = cut("const diagnosticPrefix =","export function decodeLinuxPolicy(");
  const acceptance = cut("export function validatePackagingReceipt(","export function emitPackagingFailure(") + cut("export function requireProcessSuccess(","export function verifyDryRun(") + cut("export function compareCapsules(","function offlineProjection(");
  let pipeline = cut("export async function runPackagingPipeline(","async function offlineCi(");
  assert.equal(pipeline.split('import.meta.resolve("wrangler/package.json")').length,2);
  pipeline = pipeline.replace('import.meta.resolve("wrangler/package.json")','resolveModule("wrangler/package.json")');
  const frames=[], calls=[], rejections=[], builderFailures=[], builders=[], processResults=[], denied=Object.freeze({inert:"unreached-binding"}), fixed={sourceSha:"c".repeat(40),sourceTree:"d".repeat(40)}, digest=value=>createHash("sha256").update(value).digest("hex");
  const capsule={...fixed,sourceFiles:Array(600).fill(0),dependencyInputs:Array(268).fill(0),instrumentation:Array(4).fill({erasureExact:true}),observerSha256:hex,harnessInputs:[],bundles:{edge:hex,upstream:hex},runtime:{}};
  const unreachable=name=>(..._args)=>{calls.push(["unreached",name]);throw denied;};
  const bindings={Buffer,JSON,createHash,join,relative,dirname,createOwnedProcessLedger,packObservedWranglerCloseDiagnostic,validateObservedWranglerCloseDiagnostic,packWranglerCloseDiagnostic,validateWranglerCloseDiagnostic,validateOwnedCloseDiagnostic,validateOwnedCodeCloseDiagnostic,packCensusCloseDiagnostic,validateCensusCloseDiagnostic,edgeProof:fixed,digest:value=>builderOptions.wrangler&&value==="inert-cli"?containerContract.cliHash:digest(value),refuse:code=>{throw new Error(code);},process:{execPath:"/immutable/node"},
    privateProcesses:async(...args)=>{if(args.length)assert.ok(args[0]?.censusBegin);calls.push(["inventory"]);return [];},prepareEnvironment:async path=>{calls.push(["environment",path]);return {};},
    createRequire:(...args)=>{calls.push(["require",...args]);throw denied;},resolveModule:specifier=>{calls.push(["resolve",specifier]);throw undefined;},
    realpath:unreachable("realpath"),lstat:unreachable("lstat"),writeFile:unreachable("writeFile"),renderEdgeConfig:unreachable("renderEdgeConfig"),offlineProjection:unreachable("offlineProjection"),verifyDryRun:unreachable("verifyDryRun"),
    readFile:async path=>{calls.push(["read",path]);if(failure==="receipt_read" || failure==="receipt_read_b" && path.includes("capsule-b"))throw undefined;return JSON.stringify(capsule);},
    runOwnedProcess:async (command,args,options)=>{
      calls.push(["build",command,args,options.cwd]);
      assert.equal(args[0],"/opt/edge-input/scripts/edge-proof.mjs");assert.equal(args[1],"container-build");
      const role=args[3], requested=failure.startsWith(role+":")?failure.slice(role.length+1):undefined;
      const built=await receiptActualBuilder(args.slice(2),requested,builderOptions);builders.push(built);
      for(const [phase] of built.calls)calls.push(["builder",role,phase]);
      if(built.failed)builderFailures.push({role,reason:built.reason});
      const stdout=built.frames.join("")+(built.failed?"":JSON.stringify(built.value)+"\n");
      const result = builderOptions.ownedProcess ? await builderOptions.ownedProcess(command,args,options,stdout) : {code:built.failed?1:0,signal:null,closed:true,timedOut:false,interrupted:false,errors:[],remaining:[],stdout,stderr:"",outputSummary:{stdout:{bytes:Buffer.byteLength(stdout),sha256:digest(stdout),esc:false,complete:true},stderr:{bytes:0,sha256:digest(""),esc:false,complete:true}}};
      if (builderOptions.processResult) builderOptions.processResult(result,role); processResults.push(result); return result;
    }};
  if (builderOptions.wrangler) {
    const requested = builderOptions.wrangler, originalRun = bindings.runOwnedProcess, originalRead = bindings.readFile;
    bindings.resolveModule = specifier => { calls.push(["resolve",specifier]); return "/opt/edge-input/node_modules/wrangler/package.json"; };
    bindings.createRequire = anchor => { calls.push(["require",anchor]); return {resolve:specifier=>{calls.push(["require.resolve",specifier]);return anchor;}}; };
    bindings.realpath = async path => { calls.push(["realpath",path]);return path; };
    bindings.lstat = async path => { calls.push(["lstat",path]);return {isFile:()=>true}; };
    bindings.readFile = async path => {
      if (path.endsWith("source-receipt.json")) return originalRead(path);
      calls.push(["read",path]);
      if (path.endsWith("package.json")) return JSON.stringify({version:"4.156.0"});
      if (path.endsWith("cli.js")) return "inert-cli";
      return Buffer.from("inert-bundle");
    };
    capsule.bundles = {edge:digest(Buffer.from("inert-bundle")),upstream:digest(Buffer.from("inert-bundle"))};
    bindings.offlineProjection = () => ({inert:true});
    bindings.renderEdgeConfig = (plan,kind,file) => { calls.push(["config",kind,file]);assert.deepEqual(plan,{inert:true});return "inert-config"; };
    bindings.writeFile = async (...args) => {calls.push(["write",...args]);};
    delete bindings.verifyDryRun;
    bindings.runOwnedProcess = async (command,args,options) => {
      if (args[0] !== "--no-warnings") return originalRun(command,args,options);
      const kind = args.at(-1).endsWith("edge") ? "edge" : "upstream";
      calls.push(["wrangler",kind,command,args,options]);
      assert.equal(command,"/immutable/node");
      assert.deepEqual(args,["--no-warnings","/opt/edge-input/node_modules/wrangler/wrangler-dist/cli.js","deploy","--dry-run","--config","/task/capsule-a/"+kind+".toml","--outdir","/task/dry-"+kind]);
      assert.equal(options.cwd,"/task/capsule-a");
      if(builderOptions.diagnostics){assert.ok(options.recorder);const before=calls.length;await options.sample();assert.deepEqual(calls.slice(before),[["inventory"]]);}else{assert.equal(options.sample,bindings.privateProcesses);assert.equal(Object.hasOwn(options,"recorder"),false);}
      const result = requested.ownedProcess ? await requested.ownedProcess(command,args,options,kind) : await receiptOwnedResult(command,args,options,"--dry-run: exiting now.\n",kind===requested.role?requested.scenario:"normal",true);
      if (kind===requested.role && requested.mutate) requested.mutate(result);
      processResults.push(result); return result;
    };
  }
  // These are the external callable bindings of the extracted pipeline. The
  // later filesystem/rendering branches remain explicit inert refusals.
  for(const name of ["validateOwnedCodeCloseDiagnostic","createRequire","resolveModule","realpath","lstat","writeFile","renderEdgeConfig","offlineProjection","readFile","runOwnedProcess","privateProcesses","prepareEnvironment","join","dirname","relative","digest","refuse"]) assert.equal(typeof bindings[name],"function",name);
  const api=new Function(...Object.keys(bindings),diagnostics+acceptance+(builderOptions.wrangler?cut("export function verifyDryRun(","export function compareCapsules("):"")+pipeline+"return {createPackagingDiagnostics,runPackagingPipeline,acceptPackagingProcess,validatePackagingReceipt,summarizePackagingOutput};")(...Object.values(bindings));
  const report=api.createPackagingDiagnostics("child",line=>{if(writerFailure)throw undefined;frames.push(line);}), mark=report.mark;
  report.mark=(...args)=>{
    if(args[1]==="rejected")rejections.push({phase:args[0],reason:args[2]});
    if(builderOptions.wrangler?.reportFailure && args[0]===builderOptions.wrangler.role+"_close" && args[1]==="fulfilled") throw builderOptions.wrangler.reportReason;
    return Reflect.apply(mark,report,args);
  };
  report.mark("entry","fulfilled");let failed=false,reason;
  try{await api.runPackagingPipeline("/opt/edge-input","/task",report,{builderDiagnostics:builderOptions.diagnostics===true,checkBoundary:async()=>{calls.push(["boundary"]);if(failure==="namespace_read")throw undefined;},buildArguments:(capsule,role)=>["/opt/edge-input/scripts/edge-proof.mjs","container-build",capsule,role,hex,"501","501"]});}catch(error){failed=true;reason=error;}
  report.mark("final",failed?"rejected":"fulfilled",reason);
  return {frames,calls,report,failed,reason,rejections,builderFailures,builders,processResults,summarizePackagingOutput:api.summarizePackagingOutput};
}
async function receiptProjectionFactory(overrides={}) {
  const source=await readFile(new URL("../scripts/edge-proof-container.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("export function projectBuilderCloseGroup("),source.indexOf("export function createAttachProjection(")).replaceAll("export ","");
  const bindings={Buffer,JSON,Map,hash:bytes=>createHash("sha256").update(bytes).digest("hex"),cidPattern:/^[a-f0-9]{64}$/,hashPattern:/^[a-f0-9]{64}$/,check:(value,code)=>{if(!value)throw new Error(code);},projectionBoundaries,validatePackagingDiagnostic,receiptChildPhases,validateReportedBuilderProcess,receiptBuilderSignals,unpackCensusCloseDiagnostic,validateObservedWranglerCloseDiagnostic,validateWranglerCloseDiagnostic,...overrides};
  return new Function(...Object.keys(bindings),body+"return {createProjectionLedger,parseChildPackaging,validateChildLifecycle,projectionRun,projectionLeaf,inspectBuilderCloseGroup};")(...Object.values(bindings));
}
function receiptBoundaryRecord(child,projection,count="ZERO") {return {v:10,phase:"receipt",state:"rejected",defined:true,exit:null,signal:null,parser:[1,2,true,3,1,1,0,1,0],child,reports:[0,0],count,projection};}
test("receipt boundary actual pipeline forwarding admits repeated reports and preserves original failures", async()=>{
  for(const failure of ["namespace_read","receipt_read","build_a:namespace_read","build_a:builder_import","build_a:build","build_a:receipt_write","build_b:build","wrangler_input"]){
    const produced=await receiptActualProducer(failure);assert.equal(produced.failed,true);
    const resolves=produced.calls.filter(row=>row[0]==="resolve"),requires=produced.calls.filter(row=>row[0]==="require");
    assert.deepEqual(resolves,failure==="wrangler_input"?[["resolve","wrangler/package.json"]]:[]);assert.equal(requires.length,0);assert.equal(produced.calls.filter(row=>row[0]==="unreached").length,0);
    assert.equal(produced.calls.filter(row=>row[0]==="boundary").length,1);
    assert.equal(produced.calls.filter(row=>row[0]==="inventory").length,failure==="namespace_read"?0:1);assert.deepEqual(produced.calls.filter(row=>row[0]==="environment"),failure==="namespace_read"?[]:[["environment","/task/child"]]);
    if(["namespace_read","receipt_read","wrangler_input"].includes(failure)){
      assert.equal(produced.reason,undefined);const phase=failure==="receipt_read"?"build_a_report":failure;
      assert.deepEqual(produced.rejections,[{phase:"final",reason:undefined}]);
      assert.equal(produced.report.records.find(row=>row.phase===phase&&row.outcome==="rejected").defined,false);
    }else{
      const role=failure.split(":")[0];assert.ok(produced.reason instanceof AggregateError);assert.deepEqual(produced.builderFailures,[{role,reason:undefined}]);
      assert.equal(produced.reason.errors.length,2);assert.equal(produced.reason.errors[0],produced.rejections.find(row=>row.phase===role+"_close").reason);assert.equal(produced.reason.errors[1],produced.rejections.find(row=>row.phase===role+"_report").reason);assert.equal(produced.rejections.at(-1).reason,produced.reason);
      const phase=failure.split(":")[1];assert.equal(produced.calls.filter(row=>row[0]==="builder"&&row[1]===role&&row[2]===phase).length,1);
    }
    assert.equal(produced.calls.filter(row=>row[0]==="read").length,failure==="wrangler_input"?2:failure==="receipt_read"||failure.startsWith("build_b:")?1:0);
    const capture=await receiptCapture(produced.frames),ledger=createProjectionLedger(),child=capture.summary(ledger);
    assert.equal(child[1],"reported_rejection",failure);assert.equal(ledger.detail(),null);assert.equal(child[8],"UNKNOWN");
    const api=await receiptParserFactory(),report=createContainerDiagnostics();await assert.rejects(api.observeContainerReceipt(report,"",api.plan,capture.summary));const detail=receiptView(report.records.find(r=>r.phase==="receipt"&&r.v>=9));assert.equal(detail.count,"ZERO");assert.equal(detail.projection,null);
    const full=[{v:2,phase:"entry",state:"rejected",defined:true,exit:null,signal:null},...report.records,{v:2,phase:"retirement",state:"rejected",defined:false,exit:null,signal:null}];createAttachProjection(capture.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:r=>full.push(r)})(capture.h.attached.result);
    const lines=[];emitContainerFailure(full,line=>lines.push(line));receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
    const builds=produced.calls.filter(row=>row[0]==="build");assert.equal(new Set(builds.map(row=>row[2][3])).size,builds.length);assert.ok(builds.every(row=>row[1]==="/immutable/node"&&row[3]==="/task"));
  }
  const reportFault=await receiptActualProducer("wrangler_input",true);assert.equal(reportFault.failed,true);assert.equal(reportFault.reason,undefined);assert.deepEqual(reportFault.calls.filter(row=>row[0]==="resolve"),[["resolve","wrangler/package.json"]]);assert.equal(reportFault.calls.filter(row=>row[0]==="require").length,0);assert.ok(reportFault.report.errors.includes(undefined));const capture=await receiptCapture(reportFault.frames);assert.equal(capture.summary()[1],"no_records");
});
test("receipt boundary extracted receipt summarizer resolves its actual validator", async()=>{
  const produced=await receiptActualProducer(), result={code:0,signal:null,closed:true,sha256:hex,observedProcesses:0};
  const value={version:1,isolated:true,sourceSha:"c".repeat(40),sourceTree:"d".repeat(40),sourceFiles:600,dependencyFiles:268,exactErasures:4,twoRoots:true,cliSha256:hex,results:{edge:result,upstream:result},cloud:"UNRUN",sdk:"UNRUN"};
  const summary=produced.summarizePackagingOutput(JSON.stringify(value)+"\n","child");assert.equal(summary.receipts,1);assert.equal(summary.unclassified,0);
  value.sourceSha="e".repeat(40);const foreign=produced.summarizePackagingOutput(JSON.stringify(value)+"\n","child");assert.equal(foreign.receipts,0);assert.equal(foreign.unclassified,1);
});
test("receipt boundary count reads once preserves order and never inspects an unreached size", async()=>{
  const api=await receiptParserFactory();
  for(const length of [0,1,2,1000,undefined]){
    const order=[],line=api.text(api.value).trimEnd(),lines={get length(){order.push("length");return length;},get 0(){order.push("line");return line;}};
    const input={split(separator){order.push("split:"+separator);return{filter(callback){order.push("filter");assert.equal(typeof callback,"function");return lines;}};}},ledger=api.createReceiptLedger();let failed=false,reason;
    try{api.parseContainerReceipt(input,api.plan,ledger);}catch(error){failed=true;reason=error;}
    assert.equal(failed,length!==1);assert.equal(order.filter(x=>x==="length").length,1);assert.deepEqual(order.slice(0,3),["split:\n","filter","length"]);assert.equal(order.filter(x=>x==="line").length,length===1?2:0);
    assert.equal(ledger.cardinality(),length===0?"ZERO":length===1?"ONE":length>1?"MULTIPLE":"UNKNOWN");
    if(failed)validateReceiptBoundaryDiagnostic({...receiptBoundaryRecord([1,"no_records",0,0,0,0,0,null,"UNKNOWN"],null),parser:ledger.finish(2,reason),count:ledger.cardinality()});
  }
});
test("receipt boundary original frame predicates and operation throws expose only projector evidence",async()=>{
  const api=await receiptProjectionFactory(),original=(await receiptActualProducer()).frames;
  const vectors=[
    [frames=>["tail"+frames[0],...frames.slice(1)],10,2],
    [frames=>[frames[0].replace("{","{\x1b"),...frames.slice(1)],10,3],
    [frames=>["EDGE_PACKAGING_V1 "+"x".repeat(769)+"\n"],10,4],
    [frames=>Array(257).fill(frames[0]),10,5],
    [frames=>["EDGE_PACKAGING_V1 {\n"],11,0],
    [frames=>[frames[0].replace('"role":"child"','"role":"foreign"')],12,0],
    [frames=>[frames[0].replace('"v":1','"v":1,"v":1')],13,1],
    [frames=>frames.map(line=>line.includes('"rejected"')?line.replace(/"defined":(?:true|false)/,'"defined":null'):line),14,1],
    [frames=>[frames[0].replace('"defined":null','"defined":true')],15,1],
    [frames=>[frames[0].trimEnd()],10,1],
    [frames=>[frames[1],frames[0],...frames.slice(2)],28,1],
    [frames=>[...frames,frames.at(-1)],29,1],
  ];
  for(const [mutate,boundary,leaf] of vectors){const c=await receiptCapture(mutate(original)),ledger=api.createProjectionLedger(),child=api.parseChildPackaging(c.h.attached.result,c.binding,c.initSummary,ledger),detail=ledger.detail();assert.equal(child[1],"invalid");assert.equal(detail[1],boundary);assert.equal(detail[4],leaf);validateReceiptBoundaryDiagnostic(receiptBoundaryRecord(child,detail));}
  for(const [mutate,boundary,reason] of [
    [c=>c.binding.cid="bad",1,"binding_unavailable"],[c=>c.h.attached.result.closed=false,2,"capture_unavailable"],
    [c=>c.h.attached.result.outputSummary.stderr.complete=false,4,"capture_unavailable"],[c=>c.h.attached.result.outputSummary.stdout.bytes++,6,"capture_mismatch"],
    [c=>c.initSummary.records=8,7,"init_unqualified"],
  ]){const c=await receiptCapture(original);mutate(c);const ledger=api.createProjectionLedger(),child=api.parseChildPackaging(c.h.attached.result,c.binding,c.initSummary,ledger);assert.equal(child[1],reason);assert.equal(ledger.detail()[1],boundary);validateReceiptBoundaryDiagnostic(receiptBoundaryRecord(child,ledger.detail()));}
  const c=await receiptCapture(original),ledger=api.createProjectionLedger();Object.defineProperty(c.h.attached.result,"outputSummary",{get(){throw undefined;}});let reason,failed=false;try{api.parseChildPackaging(c.h.attached.result,c.binding,c.initSummary,ledger);}catch(error){failed=true;reason=error;}assert.equal(failed,true);assert.equal(reason,undefined);assert.deepEqual(ledger.detail(),[1,3,1,2,0,0,0,false]);
});
test("receipt boundary ledger covers every fixed source boundary and preserves OR fallback throws and isolation",async()=>{
  const api=await receiptProjectionFactory();
  for(const [index,[name,width,contexts]]of projectionBoundaries.entries())for(const context of contexts){
    const ledger=api.createProjectionLedger();let thrown=false,reason;try{api.projectionRun(ledger,index+1,context,()=>{throw undefined;});}catch(error){thrown=true;reason=error;}assert.equal(thrown,true);assert.equal(reason,undefined);assert.deepEqual(ledger.detail(),[1,index+1,context,2,0,0,0,false]);validateReceiptBoundaryDiagnostic(receiptBoundaryRecord([1,"invalid",null,0,0,0,0,null,"UNKNOWN"],ledger.detail()));
    api.projectionRun(ledger,index+1,context,()=>true);assert.equal(ledger.detail()[1],index+1,name);
  }
  const ledger=api.createProjectionLedger(),calls=[];assert.equal(api.projectionRun(ledger,26,0,()=>api.projectionLeaf(ledger,1,false)||api.projectionLeaf(ledger,2,true)&&api.projectionLeaf(ledger,3,true)),true);assert.equal(ledger.detail(),null);
  const value={get first(){calls.push(1);return false;},get second(){calls.push(2);throw undefined;}};assert.throws(()=>api.projectionRun(ledger,26,0,()=>api.projectionLeaf(ledger,1,value.first)||api.projectionLeaf(ledger,2,value.second)));assert.deepEqual(calls,[1,2]);assert.deepEqual(ledger.detail(),[1,26,0,2,0,1,0,false]);
  const other=api.createProjectionLedger();assert.equal(other.detail(),null);other.start=()=>{throw undefined;};assert.throws(()=>api.projectionRun(other,11,0,()=>{throw undefined;}));assert.ok(other.errors.includes(undefined));assert.equal(other.detail(),null);
});
test("receipt boundary schema rejects contradictory count masks contexts and preserves v9 decoding",async()=>{
  const child=[1,"invalid",null,0,0,0,0,null,"UNKNOWN"],base=receiptBoundaryRecord(child,[1,10,0,1,2,3,1,null]);validateReceiptBoundaryDiagnostic(base);
  const historical={...base,v:9};delete historical.count;delete historical.projection;assert.deepEqual(validateContainerDiagnostic(historical),historical);
  for(const mutate of [r=>r.count="ONE",r=>r.projection[0]=2,r=>r.projection[1]=99,r=>r.projection[2]=5,r=>r.projection[3]=0,r=>r.projection[4]=1,r=>r.projection[5]=7,r=>r.projection[6]=3,r=>r.projection[7]=false,r=>r.child=[1,"reported_complete",100,7,1,0,0,null,"UNKNOWN"],r=>r.child[1]="capture_mismatch"]){const bad=structuredClone(base);mutate(bad);assert.throws(()=>validateReceiptBoundaryDiagnostic(bad));}
  const parser=await receiptParserFactory(),report=createContainerDiagnostics(),ledger=createProjectionLedger();ledger.start=()=>{throw undefined;};await assert.rejects(parser.observeContainerReceipt(report,"",parser.plan,()=>{throw undefined;}));assert.ok(receiptView(report.records.find(r=>r.phase==="receipt"&&r.v>=9)).reports[0]>0);
  const lines=[];emitContainerFailure([{v:2,phase:"entry",state:"rejected",defined:true,exit:null,signal:null},base],line=>lines.push(line));assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
});
test("receipt boundary actual parser getter order is identical with optional observation",async()=>{
  const frames=(await receiptActualProducer()).frames,observed=[];
  for(const enabled of [false,true]){
    const c=await receiptCapture(frames),calls=[],result=c.h.attached.result,supervisor=result.supervisor,closed=result.closed,ledger=enabled?createProjectionLedger():undefined;
    Object.defineProperty(result,"supervisor",{get(){calls.push("supervisor");return supervisor;}});Object.defineProperty(result,"closed",{get(){calls.push("closed");return closed;}});
    let cidReads=0;Object.defineProperty(c.binding,"cid",{get(){calls.push("cid");cidReads++;return hex;}});
    const value=parseChildPackaging(result,c.binding,c.initSummary,ledger);assert.equal(value[1],"reported_rejection");assert.equal(cidReads,1);assert.deepEqual(calls,["cid","supervisor","supervisor","closed"]);observed.push(value);
  }
  assert.deepEqual(observed[0],observed[1]);
});
test("receipt lifecycle actual builder preserves every original failure and operation count", async()=>{
  const args=["/task/capsule-a","build_a",hex,"501","501"], order=["namespace_read","native_receipt","builder_import","resolve","createRequire","require","build","receipt_write","build_service_stop"];
  for(const failure of [undefined,...order])for(const reason of [undefined,Object.freeze({original:"inert-failure"})]){
    const built=await receiptActualBuilder(args,failure,{reason}), at=order.indexOf(failure), expected=at<0?[...order]:order.slice(0,at+1);
    if(["build","receipt_write"].includes(failure))expected.push("build_service_stop");
    assert.deepEqual(built.calls.map(row=>row[0]),expected);assert.equal(new Set(expected).size,built.calls.length);
    assert.equal(built.failed,failure!==undefined);assert.deepEqual(args,["/task/capsule-a","build_a",hex,"501","501"]);
    if(failure){assert.equal(built.reason,reason);assert.equal(built.report.records.at(-1).outcome,"rejected");assert.equal(built.report.records.at(-1).defined,reason!==undefined);}
    else {assert.deepEqual(built.value,{built:true});assert.equal(built.report.records.at(-1).outcome,"fulfilled");}
    assert.equal(built.report.errors.length,0);
  }
  const both=await receiptActualBuilder(args,"build",{stopFailure:true,stopReason:undefined});assert.equal(both.failed,true);assert.ok(both.reason instanceof AggregateError);assert.deepEqual(both.reason.errors,[undefined,undefined]);assert.equal(both.calls.filter(r=>r[0]==="build_service_stop").length,1);
  const report=await receiptActualBuilder(args,"build",{writeFailure:["build","rejected"]});assert.ok(report.reason instanceof AggregateError);assert.deepEqual(report.reason.errors,[undefined,undefined]);assert.deepEqual(report.report.errors,[undefined]);
  const onlyReport=await receiptActualBuilder(args,undefined,{writeFailure:["final","fulfilled"]});assert.equal(onlyReport.failed,true);assert.equal(onlyReport.reason,undefined);assert.equal(onlyReport.report.records.at(-1).outcome,"fulfilled");assert.deepEqual(onlyReport.report.errors,[undefined]);
});
test("native child owner actual builder denies early success and joins despite original stop and report failures", async () => {
  const args = ["/task/capsule-a", "build_a", hex, "501", "501"];
  for (const variant of ["success", "primary-stop-undefined", "async-stop-undefined", "report-undefined"]) {
    const f = await nativeOwnerFixture(); let a, b, stopReached = false, finished = false, rejectStop, reachedStop;
    const reached = new Promise(resolve => { reachedStop = resolve; });
    const stopPromise = variant === "async-stop-undefined" ? new Promise((_, reject) => { rejectStop = reject; }) : undefined;
    const result = receiptActualBuilder(args, variant === "primary-stop-undefined" ? "build" : undefined, {
      owner: f.owner, stopPromise, stopFailure: variant === "primary-stop-undefined", stopReason: undefined,
      writeFailure: variant === "report-undefined" ? ["build_service_stop", "enter"] : undefined,
      onVisit(name) {
        if (name === "build") { a = f.construct(); b = f.construct(1); a.launch(); b.launch(); a.references = b.references = 0; }
        if (name === "build_service_stop") { stopReached = true; reachedStop(); }
      },
    }).then(value => { finished = true; return value; });
    await Promise.race([reached, result.then(value => { throw new Error("unexpected early builder return", { cause: value.reason }); })]);
    assert.equal(stopReached, true); assert.equal(finished, false);
    rejectStop?.(undefined); await Promise.resolve(); await Promise.resolve();
    assert.equal(finished, false); a.emit("close"); await Promise.resolve(); assert.equal(finished, false); b.emit("close");
    const built = await result; assert.equal(built.failed, variant !== "success");
    assert.equal(built.calls.filter(row => row[0] === "build_service_stop").length, 1);
    if (variant === "primary-stop-undefined") assert.deepEqual(nativeOwnerErrors(built.reason), [undefined, undefined]);
    if (variant === "async-stop-undefined" || variant === "report-undefined") assert.equal(built.reason, undefined);
    assert.deepEqual([...f.subscribers], [f.foreign]);
  }
  for (const phase of ["qualify", "start", "drain"]) {
    const built = await receiptActualBuilder(args, undefined, { [phase + "Failure"]: true, [phase + "Reason"]: undefined });
    assert.equal(built.failed, true); assert.equal(built.reason, undefined);
    assert.equal(built.calls.some(row => row[0] === "builder_import"), phase === "drain");
  }
});
test("native child owner source routes are version bound and qualified before actual builder import", async () => {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  let body = source.slice(source.indexOf("async function qualifyNativeChildRoutes("), source.indexOf("function createNativeChildOwner("));
  const expression = 'import.meta.resolve("wrangler/package.json")'; assert.equal(body.split(expression).length, 2);
  body = body.replace(expression, '"/immutable/wrangler/package.json"');
  const expected = [...body.matchAll(/"([0-9a-f]{64})"/g)].map(match => match[1]); assert.equal(expected.length, 6);
  for (const variant of ["valid", "runtime", "escape", "hash", "undefined"]) {
    const calls = []; let index = 0;
    const bindings = { join, containerContract: { input: "/opt/edge-input" }, process: { version: variant === "runtime" ? "v26.0.0" : "v24.22.1", versions: { modules: "137" }, platform: "linux", arch: "x64" },
      check: (ok, code) => { if (!ok) throw new Error(code); },
      createRequire: anchor => { assert.equal(anchor, "/immutable/wrangler/package.json"); return { resolve(name) { assert.equal(name, "esbuild"); return "/opt/edge-input/node_modules/esbuild/lib/main.js"; } }; },
      realpath: async path => { calls.push(["realpath", path]); if (variant === "undefined") throw undefined; return variant === "escape" ? "/outside/input" : path; },
      fileIdentity: async path => { calls.push(["identity", path]); return { sha256: variant === "hash" ? other : expected[index++] }; },
    };
    const qualify = new Function(...Object.keys(bindings), body + "return qualifyNativeChildRoutes;")(...Object.values(bindings));
    const n = { native: { typescript: { path: "/immutable/tsc" }, esbuild: { path: "/immutable/esbuild" } } };
    if (variant === "valid") { assert.deepEqual(await qualify(n, "/task/capsule-a"), [["/immutable/tsc", "--api", "--cwd", "/task/capsule-a"], ["/immutable/esbuild", "--service=0.28.2", "--ping"]]); assert.equal(calls.length, 12); }
    else { const error = await nativeOwnerFailure(qualify(n, "/task/capsule-a")); if (variant === "undefined") assert.equal(error, undefined); }
  }
  const build = source.slice(source.indexOf("async function containerBuild("), source.indexOf("async function containerPrepare("));
  assert.ok(build.indexOf("qualifyNativeChildRoutes") < build.indexOf('import("./edge-proof-build.mjs")'));
  assert.ok(build.indexOf("children.start()") < build.indexOf('import("./edge-proof-build.mjs")'));
  assert.equal(build.split("esbuild.stop()").length, 2); assert.equal(build.includes('report.sync("build_service_stop"'), false);
});
async function lifecyclePacket(produced, mutate=frames=>frames,wire=false) {
  const capture=await receiptCapture(mutate(produced.frames)),api=await receiptParserFactory(),report=createContainerDiagnostics();
  let failed=false,reason;try{await api.observeContainerReceipt(report,"",api.plan,capture.summary);}catch(error){failed=true;reason=error;}
  assert.equal(failed,true);assert.ok(reason instanceof Error);
  const raw=report.records.find(r=>r.phase==="receipt"&&r.v>=9),row=receiptView(raw);assert.ok(row);validateContainerDiagnostic(raw);
  const full=[{v:2,phase:"entry",state:"rejected",defined:true,exit:null,signal:null},...report.records,{v:2,phase:"retirement",state:"rejected",defined:false,exit:null,signal:null}];
  createAttachProjection(capture.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:r=>full.push(r)})(capture.h.attached.result);
  const lines=[];emitContainerFailure(full,line=>lines.push(line));receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
  assert.ok(Buffer.byteLength(JSON.stringify(raw))<=512);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
  return wire==="census"?raw:wire?(raw.v===16?unpackReceiptCensusDiagnostic(raw):raw):row;
}
test("receipt lifecycle actual builder output reaches acceptor projector and closed formatter",async()=>{
  for(const phase of ["namespace_read","native_receipt","builder_import","resolve","createRequire","require","build","receipt_write","build_service_stop"]){
    const produced=await receiptActualProducer("build_a:"+phase);assert.equal(produced.builders.length,1);assert.equal(produced.builders[0].failed,true);assert.equal(produced.builders[0].reason,undefined);assert.equal(produced.builders[0].calls.filter(r=>r[0]===phase).length,1);
    const row=await lifecyclePacket(produced);assert.equal(row.child[1],"reported_rejection",phase);assert.equal(row.lifecycle,null);assert.equal(row.projection,null);assert.equal(row.child[8],"UNKNOWN");
  }
  const both=await receiptActualProducer("build_a:build",false,{stopFailure:true,stopReason:undefined});assert.deepEqual(both.builders[0].reason.errors,[undefined,undefined]);assert.equal((await lifecyclePacket(both)).child[1],"reported_rejection");
});
test("receipt lifecycle missing actual builder terminal captures only rejected projector input",async()=>{
  const produced=await receiptActualProducer("wrangler_input",false,{writeFailure:["namespace_read","fulfilled"]});
  assert.equal(produced.builders.length,1);assert.equal(produced.builders[0].failed,true);assert.equal(produced.builders[0].reason,undefined);assert.equal(produced.builders[0].writeFailed,true);
  const row=await lifecyclePacket(produced),phase=name=>receiptChildPhases.indexOf(name)+1;
  assert.deepEqual(row.projection,[1,30,4,1,1,1,0,null]);assert.deepEqual(row.lifecycle,[1,2,11,phase("namespace_read"),phase("builder_import"),1,0]);assert.equal(row.child[1],"invalid");assert.equal(row.child[6],0);assert.equal(row.child[8],"UNKNOWN");
  for(const mutate of [
    frames=>frames.map(line=>line.replace('"role":"build_a"','"role":"foreign"')),
    frames=>frames.map(line=>line.replace('"v":1','"v":1,"v":1')),
    frames=>[...frames.slice(0,-1),frames.at(-1).trimEnd()],
  ]){const bad=await lifecyclePacket(produced,mutate);assert.equal(bad.child[1],"invalid");assert.equal(bad.lifecycle,null);}
  const final=await receiptActualProducer("wrangler_input",false,{writeFailure:["final","fulfilled"]});assert.equal(final.builders[0].report.records.at(-1).outcome,"fulfilled");const incomplete=await lifecyclePacket(final);assert.equal(incomplete.child[1],"incomplete");assert.equal(incomplete.lifecycle,null);
  const capture=await receiptCapture(produced.frames);capture.h.attached.result.outputSummary.stderr.sha256=other;const ledger=createProjectionLedger();assert.equal(capture.summary(ledger)[1],"capture_mismatch");assert.equal(ledger.lifecycle(),null);
});
test("receipt lifecycle original getters short circuit and diagnostic errors cannot replace failures",async()=>{
  const api=await receiptProjectionFactory();
  for(const failure of ["phase_false","phase_throw","outcome_false","outcome_throw"]){
    const traces=[];
    for(const enabled of [false,true]){
      const calls=[],rows=[{phase:"entry",outcome:"fulfilled"},{phase:"namespace_read",outcome:"enter"},{get phase(){calls.push("phase");if(failure==="phase_throw")throw undefined;return failure==="phase_false"?"build":"namespace_read";},get outcome(){calls.push("outcome");if(failure==="outcome_throw")throw undefined;return "enter";}}],ledger=enabled?api.createProjectionLedger():undefined;
      let failed=false,reason;try{api.validateChildLifecycle(rows,"build_a",ledger,4);}catch(error){failed=true;reason=error;}
      assert.equal(failed,true);if(failure.endsWith("throw"))assert.equal(reason,undefined);else assert.ok(reason instanceof Error);
      assert.deepEqual(calls,failure.startsWith("phase")?["phase"]:["phase","outcome"]);traces.push(calls);if(ledger)assert.equal(ledger.lifecycle(),null);
    }
    assert.deepEqual(traces[0],traces[1]);
  }
  const rows=[{phase:"entry",outcome:"fulfilled"},{phase:"namespace_read",outcome:"enter"},{phase:"build",outcome:"fulfilled"}],ledger=api.createProjectionLedger();ledger.phase=()=>{throw undefined;};assert.throws(()=>api.validateChildLifecycle(rows,"build_a",ledger,4));assert.deepEqual(ledger.errors,[undefined]);assert.equal(ledger.detail(),null);assert.equal(ledger.lifecycle(),null);
  const fresh=api.createProjectionLedger();assert.equal(fresh.lifecycle(),null);api.projectionRun(fresh,26,0,()=>api.projectionLeaf(fresh,1,false)||api.projectionLeaf(fresh,2,true)&&api.projectionLeaf(fresh,3,true));assert.equal(fresh.detail(),null);assert.equal(fresh.lifecycle(),null);
});
test("receipt lifecycle closed context relations legacy versions and maximum packet stay strict",async()=>{
  const produced=await receiptActualProducer("wrangler_input",false,{writeFailure:["namespace_read","fulfilled"]}),base=await lifecyclePacket(produced);
  const prior={...base,v:10};delete prior.lifecycle;delete prior.builder;assert.deepEqual(validateReceiptBoundaryDiagnostic(prior),prior);const old={...prior,v:9};delete old.count;delete old.projection;assert.deepEqual(validateReceiptDiagnostic(old),old);
  for(const mutate of [r=>r.lifecycle[0]=2,r=>r.lifecycle[1]=1,r=>r.lifecycle[1]=12,r=>r.lifecycle[2]=257,r=>r.lifecycle[3]=0,r=>r.lifecycle[4]=r.lifecycle[3],r=>r.lifecycle[5]=2,r=>r.lifecycle[6]=2,r=>r.projection[1]=28,r=>{r.projection[2]=3;r.lifecycle[3]=14;},r=>r.projection[3]=2]){
    const bad=structuredClone(base);mutate(bad);assert.throws(()=>validateReceiptBuilderDiagnostic(bad));
  }
  const absent=structuredClone(base);absent.lifecycle=[1,2,2,receiptChildPhases.indexOf("namespace_read")+1,0,2,0];validateReceiptBuilderDiagnostic(absent);
  const outcome=structuredClone(base);outcome.projection=[1,30,4,1,2,3,1,null];outcome.lifecycle[4]=outcome.lifecycle[3];outcome.lifecycle[6]=1;validateReceiptBuilderDiagnostic(outcome);outcome.lifecycle[6]=4;validateReceiptBuilderDiagnostic(outcome);for(const n of [0,2,3,5]){outcome.lifecycle[6]=n;assert.throws(()=>validateReceiptBuilderDiagnostic(outcome));}
  const wide=structuredClone(base);wide.lifecycle=[1,255,256,14,33,1,0];wide.reports=[65535,65535];validateReceiptBuilderDiagnostic(wide);
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8"),phases=JSON.parse(/const containerDiagnosticPhases = (\[[^\n]+\]);/.exec(source)[1]);
  const rows=[...phases.filter(p=>!["receipt","overflow","image_build_process","image_build_internal","native_prepare_internal","attach_process","init_prerequisite"].includes(p)).map(phase=>({v:2,phase,state:"fulfilled",defined:null,exit:null,signal:null})),wide,{v:2,phase:"entry",state:"rejected",defined:true,exit:null,signal:null}];
  const lines=[];emitContainerFailure(rows,line=>lines.push(line));assert.equal(lines.length,10);assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf("::{")+2)).v,12);assert.ok(Buffer.byteLength(JSON.stringify(wide))<=512);assert.ok(lines.every(l=>Buffer.byteLength(l)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
});
function truncateActualBuilder(result) {
  const lines=result.stdout.split("\n").filter(Boolean);
  result.stdout=lines.slice(0,6).join("\n")+"\n";
  result.outputSummary.stdout={bytes:Buffer.byteLength(result.stdout),sha256:createHash("sha256").update(result.stdout).digest("hex"),esc:false,complete:result.closed};
}
async function receiptOwnedResult(command,args,options,stdout,scenario,complete = false) {
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("// Optional, invocation-local observations."),source.indexOf("export async function privateProcesses(")).replaceAll("export ","")+source.slice(source.indexOf("export async function runOwnedProcess("),source.indexOf("export function requireProcessSuccess(")).replace("export ","");
  const child=new EventEmitter(),signals=new EventEmitter(),timers=[],cleared=[],kills=[];child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  let spawns=0,samples=0;
  const bindings={createHash,Map,Promise,Object,Error,receiptBuilderSignals,process:{kill:(...values)=>kills.push(values)},refuse:code=>{throw new Error(code);},
    spawn:()=>{throw new Error("native spawn forbidden");},
    setTimeout:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},setInterval:(fn,ms)=>({fn,ms}),clearTimeout:t=>cleared.push(t),clearInterval:t=>cleared.push(t)};
  const run=new Function(...Object.keys(bindings),body+"return runOwnedProcess;")(...Object.values(bindings));
  const promise=run(command,args,{...options,signalSource:signals,sample:async()=>{samples++;if(scenario==="sample_undefined")throw undefined;return scenario==="remaining"?[{pid:123,start:1}]:[];},spawnProcess:(...values)=>{
    spawns++;assert.deepEqual(values,[command,args,{cwd:options.cwd,env:options.env,detached:true,stdio:["ignore","pipe","pipe"]}]);
    if(scenario==="spawn_undefined")throw undefined;return child;
  }});
  if(scenario!=="spawn_undefined"){
    child.stdout.emit("data",Buffer.from(complete ? stdout : stdout.split("\n").slice(0,6).join("\n")+"\n"));
    child.stderr.emit("data",Buffer.from("private-inert-stderr"));
    if(scenario==="timeout")timers[0].fn();
    if(scenario==="interrupt")signals.emit("SIGINT");
    if(scenario==="error_undefined")child.emit("error",undefined);
    child.emit("close",scenario==="signal"?null:scenario==="nonzero"?9:0,scenario==="signal"?"SIGKILL":null);
  }
  const result=await promise;
  assert.equal(spawns,1);assert.equal(samples,1);assert.equal(signals.listenerCount("SIGINT"),0);assert.equal(signals.listenerCount("SIGTERM"),0);assert.equal(cleared.length,3);
  assert.equal(kills.length,["timeout","interrupt"].includes(scenario)?1:0);
  if(scenario.endsWith("undefined"))assert.equal(result.errors[0],undefined);
  return result;
}
test("receipt builder actual owned-process original result reaches acceptor capture and projection",async()=>{
  for(const scenario of ["normal","nonzero","signal","timeout","interrupt","error_undefined","sample_undefined","spawn_undefined"]){
    const produced=await receiptActualProducer("wrangler_input",false,{ownedProcess:(...values)=>receiptOwnedResult(...values,scenario)});
    const result=produced.processResults[0],row=await lifecyclePacket(produced);
    assert.equal(produced.processResults.length,1);assert.equal(produced.builders[0].calls.filter(r=>r[0]==="build").length,1);
    if(scenario==="spawn_undefined"){assert.equal(row.builder,null);assert.equal(result.closed,false);assert.equal(result.spawnErrors[0],undefined);continue;}
    assert.ok(row.builder);assert.equal(row.builder[3],result.code);assert.equal(row.builder[4],receiptBuilderSignals.indexOf(result.signal));
    assert.equal(row.builder[6],result.errors.length);assert.equal(row.builder[7],result.remaining?.length??null);
    assert.deepEqual(row.builder.slice(8),[result.outputSummary.stdout.bytes,result.outputSummary.stdout.sha256,result.outputSummary.stderr.bytes,result.outputSummary.stderr.sha256]);
    assert.equal(row.child[1],"invalid");assert.equal(row.child[8],"UNKNOWN");
  }
});
test("receipt builder original close group projects actual acceptor fields without lifecycle credit",async()=>{
  for(const change of [
    r=>{},r=>{r.code=7;},r=>{r.code=null;r.signal="SIGTERM";},
    r=>{r.timedOut=true;},r=>{r.interrupted=true;},r=>{r.errors=[undefined];},
    r=>{r.remaining=null;},r=>{r.remaining=[{inert:true}];},
    r=>{r.closed=false;r.code=null;r.outputSummary.stderr.complete=false;},
  ]){
    let observed=0;
    const produced=await receiptActualProducer("wrangler_input",false,{processResult(result){observed++;change(result);truncateActualBuilder(result);}});
    assert.equal(observed,1);assert.equal(produced.builders.length,1);assert.equal(produced.builders[0].failed,false);
    assert.equal(produced.builders[0].calls.filter(r=>r[0]==="build").length,1);
    assert.equal(produced.builders[0].calls.filter(r=>r[0]==="build_service_stop").length,1);
    const result=produced.processResults[0],row=await lifecyclePacket(produced),group=row.builder;
    assert.equal(row.child[1],"invalid");assert.deepEqual(row.lifecycle,[1,6,6,12,0,2,0]);assert.ok(group);
    const close=produced.report.records.find(r=>r.phase==="build_a_close");
    assert.deepEqual(group,[1,1,close.outcome==="fulfilled"?1:close.defined?3:2,result.code,receiptBuilderSignals.indexOf(result.signal),
      (result.closed?1:0)+(result.timedOut?2:0)+(result.interrupted?4:0)+(result.outputSummary.stdout.complete?16:0)+(result.outputSummary.stderr.complete?64:0),
      result.errors.length,result.remaining?.length??null,result.outputSummary.stdout.bytes,result.outputSummary.stdout.sha256,0,result.outputSummary.stderr.sha256]);
    if(result.errors.length){assert.equal(result.errors[0],undefined);assert.ok(produced.reason.errors[0].errors.includes(undefined));}
    assert.equal(row.child[8],"UNKNOWN");assert.equal(row.child[6],0);assert.equal(row.reports[0],0);
  }
});
test("receipt builder source-selected second builder remains separate from the first role",async()=>{
  const produced=await receiptActualProducer("wrangler_input",false,{processResult(result,role){if(role==="build_b")truncateActualBuilder(result);}});
  assert.equal(produced.builders.length,2);assert.equal(produced.processResults.length,2);
  const row=await lifecyclePacket(produced);assert.equal(row.projection[2],5);assert.equal(row.builder[1],2);
  assert.deepEqual(row.builder.slice(8,10),[produced.processResults[1].outputSummary.stdout.bytes,produced.processResults[1].outputSummary.stdout.sha256]);
});
test("receipt builder capture reports retain byte fingerprints without retaining-text or OS claims",async()=>{
  const produced=await receiptActualProducer("build_a:build",false,{processResult(result){
    truncateActualBuilder(result);result.stderr="private-not-forwarded";
    result.outputSummary.stderr={bytes:result.stderr.length,sha256:createHash("sha256").update(result.stderr).digest("hex"),esc:true,complete:true};
    // Complete is the producer's original close flag, not a retained-text claim.
    result.outputSummary.stdout.bytes+=100;result.outputSummary.stdout.sha256=other;
  }});
  assert.equal(produced.builders[0].reason,undefined);assert.equal(produced.builders[0].calls.filter(r=>r[0]==="build").length,1);
  const row=await lifecyclePacket(produced);assert.ok(row.builder);assert.equal(row.builder[9],other);assert.equal(row.builder[10],21);assert.ok(row.builder[5]&32);
  assert.ok(!JSON.stringify(row).includes("private-not-forwarded"));assert.equal(row.child[1],"invalid");
  const incomplete=await receiptActualProducer("wrangler_input",false,{processResult(result){truncateActualBuilder(result);result.outputSummary.stderr.complete=false;}});
  assert.equal((await lifecyclePacket(incomplete)).builder,null);
});
test("receipt builder group rejects duplicate foreign conflicting and ambiguous frames before projection",async()=>{
  const produced=await receiptActualProducer("wrangler_input",false,{processResult:truncateActualBuilder});
  const original=produced.frames, change=(frames,phase,fn)=>frames.map(line=>{const row=JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));if(row.phase===phase)fn(row);return"EDGE_PACKAGING_V1 "+JSON.stringify(row)+"\n";});
  const find=phase=>original.find(line=>line.includes('"phase":"'+phase+'"'));
  for(const mutate of [
    frames=>[...frames,find("build_a_launch")],frames=>[...frames,find("build_a_close")],
    frames=>[...frames,find("stdout_summary")],frames=>[...frames,find("entry").replace('"role":"child"','"role":"build_b"')],frames=>change(frames,"build_a_close",r=>r.role="build_b"),
    frames=>change(frames,"stderr_summary",r=>r.role="build_a"),frames=>change(frames,"stdout_summary",r=>r.bytes=null),
    frames=>change(frames,"build_a_close",r=>r.errors=null),frames=>change(frames,"build_a_close",r=>r.closed=null),
    frames=>[...frames,"EDGE_PACKAGING_V1 {}\n"],frames=>[...frames,find("entry").trimEnd()],
    frames=>[...frames,"EDGE_PACKAGING_V1 \x1b{}\n"],frames=>[...frames,find("entry").replace('"v":1','"v":1,"v":1')],
    frames=>Array(257).fill(frames[0]),frames=>change(frames,"build_a_close",r=>r.role="foreign"),
  ]){const row=await lifecyclePacket(produced,mutate);assert.equal(row.builder,null);assert.notEqual(row.child[1],"reported_complete");}
  for(const stream of ["stdout","stderr"]){
    const capture=await receiptCapture(original);capture.h.attached.result.outputSummary[stream].sha256=other;
    const ledger=createProjectionLedger();assert.equal(capture.summary(ledger)[1],"capture_mismatch");assert.equal(ledger.builder(),null);
  }
  const missing=await receiptActualProducer("wrangler_input",true,{processResult:truncateActualBuilder});assert.ok(missing.report.errors.includes(undefined));assert.equal((await lifecyclePacket(missing)).builder,null);
});
test("receipt builder schema preserves historical decoders exact fields and maximum atomic budget",async()=>{
  const produced=await receiptActualProducer("wrangler_input",false,{processResult:truncateActualBuilder}),base=await lifecyclePacket(produced);
  const prior={...base,v:11};delete prior.builder;assert.deepEqual(validateReceiptLifecycleDiagnostic(prior),prior);
  for(const mutate of [
    r=>r.builder[0]=2,r=>r.builder[1]=2,r=>r.builder[2]=0,r=>r.builder[3]=65536,r=>r.builder[4]=15,
    r=>r.builder[5]=128,r=>r.builder[6]=null,r=>r.builder[7]=-1,r=>r.builder[8]=-1,r=>r.builder[9]="x".repeat(64),
    r=>r.builder[10]=Number.MAX_SAFE_INTEGER+1,r=>r.builder[11]=null,r=>r.projection=null,r=>r.child[1]="reported_complete",
    r=>{r.builder[2]=1;r.builder[3]=1;},r=>r.builder[5]=0,
  ]){const bad=structuredClone(base);mutate(bad);assert.throws(()=>validateReceiptBuilderDiagnostic(bad));}
  const wide=structuredClone(base);wide.reports=[65535,65535];wide.lifecycle=[1,256,256,14,0,2,0];
  wide.builder=[1,1,3,-65535,14,127,65535,65535,Number.MAX_SAFE_INTEGER,hex,Number.MAX_SAFE_INTEGER,other];
  validateReceiptBuilderDiagnostic(wide);
  const lines=[],records=[wide,{v:2,phase:"entry",state:"rejected",defined:false,exit:null,signal:null},...Array.from({length:20},(_,i)=>({v:2,phase:["dispatch","image","base","create","attach","ready","cwd","temp","environment","retirement"][i%10],state:"rejected",defined:false,exit:null,signal:null}))];
  // Maximum-width evidence still needs its actual outer attach/init witnesses.
  for (const row of records) if (["ready","admission","permit"].includes(row.phase)) { row.state="fulfilled";row.defined=null; }
  const capture=await receiptCapture(produced.frames);
  createAttachProjection(capture.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:row=>records.push(row)})(capture.h.attached.result);
  emitContainerFailure(records,line=>lines.push(line));assert.equal(lines.length,10);assert.ok(Buffer.byteLength(JSON.stringify(wide))<=512);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
  receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
});
async function ownedLedgerFactory(overrides={},supplied) {
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("// Optional, invocation-local observations."),source.indexOf("export function verifyDryRun(")).replaceAll("export ","");
  const fields=Array(20).fill("0");fields[0]="S";fields[1]="1";fields[2]="12";fields[19]="123";
  const calls=[],timers=[],intervals=[],signals=new EventEmitter(),child=new EventEmitter();child.pid=12;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const environment=supplied?.options.env??Object.freeze({inert:true}),command=supplied?.command??"/immutable/node",args=supplied?.args??Object.freeze(["inert"]);
  const processInert={platform:"linux",pid:1,kill(...values){assert.equal(this,processInert);calls.push(["kill",...values]);}};
  const bindings={receiptBuilderSignals,createHash,Buffer,Map,Promise,Object,Array,Number,Error,
    process:processInert,refuse:code=>{throw new Error(code);},
    readdir:async path=>{calls.push(["directory",path]);assert.equal(path,"/proc");return["1","self","12"];},
    readFile:async(...values)=>{calls.push(["stat",...values]);assert.deepEqual(values,["/proc/12/stat","utf8"]);return"12 (synthetic) "+fields.join(" ");},
    spawn:(...values)=>{calls.push(["spawn",...values]);assert.deepEqual(values,[command,args,{cwd:"/task",env:environment,detached:true,stdio:["ignore","pipe","pipe"]}]);return child;},
    setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},setInterval:(fn,ms)=>{const t={fn,ms};intervals.push(t);return t;},
    clearTimeout:t=>calls.push(["clearTimeout",t]),clearInterval:t=>calls.push(["clearInterval",t]),...overrides};
  for(const name of ["readdir","readFile","spawn","setTimeout","setInterval","clearTimeout","clearInterval","refuse","createHash"])assert.equal(typeof bindings[name],"function",name);
  const api=new Function(...Object.keys(bindings),body+"return {privateProcesses,runOwnedProcess,createOwnedProcessLedger,requireProcessSuccess};")(...Object.values(bindings));
  return {...api,bindings,fields,calls,timers,intervals,signals,child,environment,command,args};
}
test("owned ledger actual sampler preserves each original phase predicate and undefined failure",async()=>{
  const vectors=[
    [{process:{platform:"darwin",get pid(){throw new Error("unreached");}}},1,1,1,0],
    [{process:{platform:"linux",pid:2}},1,2,3,1],
    [{readdir:async()=>{throw undefined;}},2,0,0,0],
    [{readdir:async()=>({[Symbol.iterator](){throw undefined;}})},2,0,0,0],
    [{readdir:async()=>[{toString(){throw undefined;}}]},3,0,0,0],
    [{readFile:async()=>{throw undefined;}},4,0,0,0],
    [{readFile:async()=>({lastIndexOf(){throw undefined;}})},5,0,0,0],
    [{Number:()=>{throw undefined;}},7,0,0,0],
    [{readFile:async()=>{throw{get code(){throw undefined;}};}},8,0,0,0],
  ];
  for(const [overrides,stage,leaf,seen,passed] of vectors){
    const f=await ownedLedgerFactory(overrides),rec=f.createOwnedProcessLedger();let failure,failed=false;
    try{await f.privateProcesses(rec);}catch(error){failed=true;failure=error;}
    assert.equal(failed,true);if(!leaf)assert.equal(failure,undefined);else assert.ok(failure instanceof Error);
    rec.error(2,failure);const trace=rec.finish();assert.deepEqual(trace[1],[2,stage,leaf?1:0,leaf,seen,passed,failure!==undefined]);assert.throws(()=>validateOwnedTrace(trace,1));
  }
  for(const [index,value,leaf,seen,passed] of [[0,"?",1,1,0],[19,"?",2,3,1],[1,"?",3,7,3],[2,"?",3,7,3]]){
    const f=await ownedLedgerFactory();f.fields[index]=value;const rec=f.createOwnedProcessLedger();let failure;try{await f.privateProcesses(rec);}catch(e){failure=e;}assert.ok(failure instanceof Error);rec.error(2,failure);assert.deepEqual(rec.finish()[1],[2,6,1,leaf,seen,passed,true]);
  }
  let reads=0;const gone={get code(){reads++;return"ENOENT";}};const f=await ownedLedgerFactory({readFile:async()=>{throw gone;}}),rec=f.createOwnedProcessLedger();assert.deepEqual(await f.privateProcesses(rec),[]);assert.equal(reads,1);assert.equal(rec.finish()[1],null);
  const original={get code(){reads++;return"OTHER";}};const g=await ownedLedgerFactory({readFile:async()=>{throw original;}});let reason;try{await g.privateProcesses();}catch(e){reason=e;}assert.equal(reason,original);assert.equal(reads,2);
});
test("owned ledger actual sampler getter order and observer faults do not change original reads",async()=>{
  const orders=[];
  for(const enabled of [false,true]){
    const order=[],fields=Array(20).fill("0");fields[0]="S";fields[1]="1";fields[2]="12";fields[19]="123";
    const observed=new Proxy(fields,{get(target,key){if(["0","1","2","19"].includes(key))order.push(key);return Reflect.get(target,key);}});
    const f=await ownedLedgerFactory({readFile:async()=>({lastIndexOf(){order.push("last");return 0;},slice(n){assert.equal(n,2);order.push("slice");return{split(value){assert.equal(value," ");order.push("split");return observed;}};}})});
    const rec=enabled?f.createOwnedProcessLedger():undefined;assert.equal((await f.privateProcesses(rec)).length,1);orders.push(order);if(rec)validateOwnedTrace(rec.finish(),0);
  }
  assert.deepEqual(orders[0],orders[1]);assert.deepEqual(orders[0],["last","slice","split","0","19","1","2","1","2","19","0"]);
  const f=await ownedLedgerFactory(),rec=f.createOwnedProcessLedger();rec.sampleLeaf=()=>{throw undefined;};assert.equal((await f.privateProcesses(rec)).length,1);const trace=rec.finish();assert.equal(trace[1],null);assert.equal(trace[2],null);assert.ok(trace[3][0]>0);assert.equal(trace[3][0],trace[3][1]);
});
async function ownedProcessScenario(scenario,stdout="",override={},supplied) {
  const f=await ownedLedgerFactory(override,supplied),rec=supplied?.options.recorder??f.createOwnedProcessLedger(),samples=[];let heldResolve,heldReject;
  const held=new Promise((resolve,reject)=>{heldResolve=resolve;heldReject=reject;});
  const sample=()=>{const ordinal=samples.length;let p;
    if(scenario==="held"&&ordinal===0)p=held;
    else if(scenario==="monitor_undefined"&&ordinal===0)p=Promise.reject(undefined);
    else if(scenario==="iterator"&&ordinal===0)p=Promise.resolve({[Symbol.iterator](){throw undefined;}});
    else if(scenario==="row_key"&&ordinal===0)p=Promise.resolve([{get pid(){throw undefined;}}]);
    else if(scenario==="capacity"&&ordinal===0)p=Promise.resolve(Array.from({length:513},(_,pid)=>({pid,start:1})));
    else if(scenario==="final_undefined")p=Promise.reject(undefined);
    else p=f.privateProcesses(rec);
    samples.push(p);return p;
  };
  if(scenario==="report_fault")rec.request=()=>{throw undefined;};
  const promise=f.runOwnedProcess(f.command,f.args,{cwd:"/task",env:f.environment,recorder:rec,signalSource:f.signals,sample,...(supplied?{timeoutMs:supplied.options.timeoutMs}:{})});
  let settled=false;promise.then(()=>{settled=true;});
  if(f.intervals.length){
    if(["monitor_undefined","iterator","row_key","capacity","held","monitor_proc"].includes(scenario)){f.intervals[0].fn();if(scenario!=="held")await samples[0].catch(()=>{});}
    if(["timeout","report_fault","escalation"].includes(scenario))f.timers[0].fn();
    if(scenario==="escalation")f.timers[1].fn();
    if(scenario==="interrupt")f.signals.emit("SIGINT");
    if(scenario==="interrupt_term")f.signals.emit("SIGTERM");
    if(scenario==="child_error")f.child.emit("error",undefined);
    if(stdout)f.child.stdout.emit("data",Buffer.from(stdout));
    if(scenario==="capture")f.child.stdout.emit("data",Buffer.alloc(1024*1024+1));
    f.child.emit("close",null,"SIGTERM");
    if(scenario==="held"){
      await Promise.resolve();assert.equal(settled,false);heldReject(undefined);await samples[0].catch(()=>{});
      const join=f.timers.find(t=>t.ms===1);assert.ok(join);join.fn();
    }
  }
  const result=await promise;return{...f,result,rec,samples};
}
test("owned ledger actual process monitor external-compatible close and dispatch remain distinct",async()=>{
  for(const [scenario,site,stage] of [["child_error",8,0],["monitor_undefined",2,0],["iterator",3,1],["row_key",3,2],["capacity",4,1],["capture",5,1],["final_undefined",9,0],["timeout",0,0],["interrupt",0,0]]){
    const f=await ownedProcessScenario(scenario),trace=f.result.ownedTrace;validateOwnedTrace(trace,f.result.errors.length);
    assert.equal(f.result.closed,true);assert.equal(f.result.signal,"SIGTERM");assert.equal(trace[1]?.[0]??0,site);assert.equal(trace[1]?.[1]??0,stage);
    const own=["monitor_undefined","iterator","row_key","capacity","capture","timeout","interrupt"].includes(scenario);
    assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),own?[["kill",-12,scenario==="interrupt"?"SIGINT":"SIGTERM"]]:[]);
    assert.equal(trace[2][1],own?1:0);assert.equal(trace[2][2],own?1:0);assert.equal(trace[2][3],0);
    assert.equal(f.calls.filter(r=>r[0]==="clearTimeout").length,2);assert.equal(f.calls.filter(r=>r[0]==="clearInterval").length,1);assert.equal(f.signals.listenerCount("SIGINT"),0);
    if(["child_error","monitor_undefined","iterator","row_key","final_undefined"].includes(scenario))assert.equal(f.result.errors[0],undefined);
  }
  const held=await ownedProcessScenario("held");assert.equal(held.samples.length,2);assert.equal(held.result.errors[0],undefined);assert.deepEqual(held.calls.filter(r=>r[0]==="kill"),[]);assert.equal(held.result.ownedTrace[2][4],1);validateOwnedTrace(held.result.ownedTrace,1);
});
test("owned ledger ignored ESRCH recorded kill throws and report faults preserve cleanup",async()=>{
  for(const [code,recorded] of [["ESRCH",false],["OTHER",true],[undefined,true]]){
    let reads=0,kills=0;const reason=code===undefined?undefined:{get code(){reads++;return code;}};
    const process={platform:"linux",pid:1,kill(pid,signal){assert.equal(this,process);assert.equal(pid,-12);assert.equal(signal,"SIGTERM");kills++;throw reason;}};
    const f=await ownedProcessScenario("timeout","",{process});assert.equal(kills,1);assert.equal(reads,code===undefined?0:1);assert.equal(f.result.errors.length,recorded?1:0);if(recorded)assert.equal(f.result.errors[0],reason);
    const trace=f.result.ownedTrace;validateOwnedTrace(trace,f.result.errors.length);assert.equal(trace[2][12],recorded?0:1);assert.equal(trace[2][3],1);assert.equal(trace[2][9],reason===undefined?2:3);assert.equal(trace[2][10],reason===undefined?1:2);
  }
  for(const first of [undefined,new Error("synthetic")]){
    let index=0,reads=0;const ignored={get code(){reads++;return"ESRCH";}},values=[first,ignored];
    const inertProcess={platform:"linux",pid:1,kill(pid,signal){assert.equal(this,inertProcess);assert.equal(pid,-12);assert.equal(signal,index?"SIGKILL":"SIGTERM");throw values[index++];}};
    const f=await ownedLedgerFactory({process:inertProcess}),rec=f.createOwnedProcessLedger();const pending=f.runOwnedProcess(f.command,f.args,{cwd:"/task",env:f.environment,signalSource:f.signals,sample:async()=>[],recorder:rec});
    f.timers[0].fn();f.timers[1].fn();f.child.emit("close",null,"SIGKILL");const result=await pending;
    assert.equal(index,2);assert.equal(reads,1);assert.deepEqual(result.errors,[first]);validateOwnedTrace(result.ownedTrace,1);assert.equal(result.ownedTrace[1][6],first!==undefined);
    if(first===undefined){const bad=structuredClone(result.ownedTrace);bad[1][6]=true;assert.throws(()=>validateOwnedTrace(bad,1));}
  }
  const failed=await ownedProcessScenario("report_fault");assert.deepEqual(failed.result.observerErrors,[undefined]);assert.deepEqual(failed.calls.filter(r=>r[0]==="kill"),[["kill",-12,"SIGTERM"]]);assert.equal(failed.result.ownedTrace[1],null);assert.equal(failed.result.ownedTrace[2],null);validateOwnedTrace(failed.result.ownedTrace,0);
});
test("owned ledger startup and monitor operands retain original failures without false predicate claims",async()=>{
  for(const stage of [1,2,3,4,5,6]){
    const f=await ownedLedgerFactory(),rec=f.createOwnedProcessLedger();let spawn=f.bindings.spawn;
    if(stage===1)spawn=()=>{throw undefined;};
    if(stage===2)f.child.stdout.on=()=>{throw undefined;};
    if(stage===3)f.signals.on=()=>{throw undefined;};
    if(stage===6)f.child.on=()=>{throw undefined;};
    const g=stage===4?await ownedLedgerFactory({setTimeout:()=>{throw undefined;}}):stage===5?await ownedLedgerFactory({setInterval:()=>{throw undefined;}}):f;
    const result=await g.runOwnedProcess(g.command,g.args,{cwd:"/task",env:g.environment,recorder:rec,signalSource:g.signals,spawnProcess:stage===4||stage===5?g.bindings.spawn:spawn,sample:async()=>[]});
    assert.equal(result.errors[0],undefined);assert.equal(result.closed,false);assert.deepEqual(result.ownedTrace[1],[stage===1?6:7,stage,0,0,0,0,false]);validateOwnedTrace(result.ownedTrace,1);
  }
  for(const operation of ["set","size"]){
    let calls=0;class ObservedMap extends Map{set(...args){if(operation==="set"){calls++;throw undefined;}return super.set(...args);}get size(){calls++;throw undefined;}}
    const f=await ownedProcessScenario("monitor_proc","",{Map:ObservedMap});assert.equal(calls,1);assert.equal(f.result.errors[0],undefined);assert.equal(f.result.ownedTrace[1][0],operation==="set"?3:4);assert.equal(f.result.ownedTrace[1][2],0);validateOwnedTrace(f.result.ownedTrace,1);
  }
  const f=await ownedLedgerFactory({readFile:async()=>({lastIndexOf:()=>0,slice:()=>({split:()=>({0:"S",get 19(){throw undefined;}})})})}),rec=f.createOwnedProcessLedger();let error;try{await f.privateProcesses(rec);}catch(e){error=e;}assert.equal(error,undefined);rec.error(2,error);assert.deepEqual(rec.finish()[1],[2,6,2,0,1,1,false]);
});
test("owned ledger original sampler errors still dispatch and settle when the recorder fails",async()=>{
  const f=await ownedLedgerFactory(),rec=f.createOwnedProcessLedger();rec.error=()=>{throw undefined;};let count=0;
  const resultPromise=f.runOwnedProcess(f.command,f.args,{cwd:"/task",env:f.environment,recorder:rec,signalSource:f.signals,sample:()=>{count++;return count===1?Promise.reject(undefined):Promise.resolve([]);}});
  f.intervals[0].fn();await Promise.resolve();await Promise.resolve();assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),[["kill",-12,"SIGTERM"]]);
  f.child.emit("close",null,"SIGTERM");const result=await resultPromise;
  assert.equal(count,2);assert.deepEqual(result.errors,[undefined]);assert.deepEqual(result.observerErrors,[undefined]);assert.equal(result.closed,true);assert.equal(result.ownedTrace[1],null);validateOwnedTrace(result.ownedTrace,1);
  assert.equal(f.calls.filter(r=>r[0]==="clearTimeout").length,2);
});
test("owned ledger actual original pipeline keeps source-bound trace and lossless capture hashes",async()=>{
  for(const scenario of ["child_error","monitor_undefined","iterator","row_key","capacity","capture","timeout","interrupt","interrupt_term","escalation","report_fault","held","final_undefined"]){
    let original;
    const produced=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>{
      assert.ok(options.recorder);assert.equal(options.timeoutMs,120000);
      const f=await ownedProcessScenario(scenario,stdout.split("\n").slice(0,6).join("\n")+"\n",{}, {command,args,options});original=f.result;return original;
    }});
    assert.equal(produced.processResults.length,1);assert.equal(produced.processResults[0],original);
    assert.equal(produced.builders[0].calls.filter(r=>r[0]==="build").length,1);
    const wire=await lifecyclePacket(produced,frames=>frames,true);assert.equal(wire.v,15);const prior=receiptView(wire);validateReceiptBuilderDiagnostic(prior);
    assert.equal(prior.child[1],"invalid");assert.deepEqual(wire.detail[7],original.ownedTrace);assert.deepEqual(prior.builder.slice(8),[original.outputSummary.stdout.bytes,original.outputSummary.stdout.sha256,original.outputSummary.stderr.bytes,original.outputSummary.stderr.sha256]);
    assert.equal(wire.detail[6][9].length,43);assert.equal(wire.detail[6][11].length,43);
    if(scenario==="child_error"){assert.equal(wire.detail[7][1][0],8);assert.equal(wire.detail[7][2][1],0);assert.equal(prior.builder[4],2);}
    if(scenario==="monitor_undefined"){assert.equal(wire.detail[7][1][0],2);assert.equal(wire.detail[7][2][1],1);}
    if(scenario==="report_fault"){assert.ok(original.observerErrors.includes(undefined));assert.ok(produced.reason.errors.includes(undefined));}
  }
});
test("owned ledger source-required reasons and original flags reject contradictory close and receipt frames",async()=>{
  for(const scenario of ["monitor_undefined","timeout"]){
    let original;
    const produced=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>{
      const f=await ownedProcessScenario(scenario,stdout.split("\n").slice(0,6).join("\n")+"\n",{}, {command,args,options});original=f.result;return original;
    }});
    const wire=await lifecyclePacket(produced,frames=>frames,true),trace=wire.detail[7];assert.ok(trace);validateContainerDiagnostic(wire);
    const frame=produced.frames.map(line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length))).find(row=>row.role==="child"&&row.phase==="build_a_close");
    const close=frame.v===4?unpackCensusCloseDiagnostic(frame):frame;
    assert.ok(close);assert.equal(close.timedOut,original.timedOut);assert.equal(close.interrupted,original.interrupted);validateOwnedCodeCloseDiagnostic(close);
    const bad=structuredClone(wire),badClose=structuredClone(close);
    if(scenario==="monitor_undefined"){
      assert.deepEqual(trace[1],[2,0,0,0,0,0,false]);assert.equal(bad.detail[6][6],1);
      bad.detail[7][2]=Array(13).fill(0);badClose.trace[2]=Array(13).fill(0);
    }else{
      assert.deepEqual(trace[2],[1,1,1,0,0,4,2,3,2,1,0,0,0]);assert.equal(bad.detail[6][5],83);
      bad.detail[6][5]=81;badClose.timedOut=false;
    }
    assert.throws(()=>validateOwnedCodeCloseDiagnostic(badClose));assert.throws(()=>validateContainerDiagnostic(bad));assert.throws(()=>emitContainerFailure([bad],()=>assert.fail("invalid diagnostic emitted")));
    const rejected=await lifecyclePacket(produced,frames=>frames.map(line=>{const row=JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));return row.role==="child"&&row.phase==="build_a_close"?"EDGE_PACKAGING_V1 "+JSON.stringify(badClose)+"\n":line;}));
    assert.equal(rejected.child[1],"invalid");assert.equal(rejected.builder,null);
  }
  for(const scenario of ["interrupt","interrupt_term"]){
    const f=await ownedProcessScenario(scenario);assert.equal(f.result.interrupted,true);
    validateOwnedTrace(f.result.ownedTrace,f.result.errors.length,[false,true]);
    assert.throws(()=>validateOwnedTrace(f.result.ownedTrace,f.result.errors.length,[false,false]));
  }
  const clean=await ownedProcessScenario("child_error");
  validateOwnedTrace(clean.result.ownedTrace,1,[false,false]);
  for(const flags of [[true,false],[false,true]])assert.throws(()=>validateOwnedTrace(clean.result.ownedTrace,1,flags));
  const broken=await ownedProcessScenario("report_fault");assert.deepEqual(broken.result.ownedTrace,[1,null,null,[1,1,0]]);
  validateOwnedTrace(broken.result.ownedTrace,0,[true,false]);
});
test("owned ledger original escalation and default-off process preserve arguments reads and settlement",async()=>{
  for(const enabled of [false,true])for(const observerFault of enabled?[false,true]:[false]){
    const f=await ownedLedgerFactory();let pidReads=0;Object.defineProperty(f.child,"pid",{get(){pidReads++;return 12;}});
    const rec=enabled?f.createOwnedProcessLedger():undefined;if(observerFault)rec.returned=()=>{throw undefined;};
    const resultPromise=f.runOwnedProcess(f.command,f.args,{cwd:"/task",env:f.environment,signalSource:f.signals,sample:async()=>[],...(rec?{recorder:rec}:{})});
    f.timers[0].fn();assert.equal(f.timers[1].ms,1000);f.timers[1].fn();
    assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),[["kill",-12,"SIGTERM"],["kill",-12,"SIGKILL"]]);assert.equal(pidReads,4);
    f.child.emit("close",null,"SIGKILL");const result=await resultPromise;assert.equal(result.closed,true);assert.equal(result.timedOut,true);assert.deepEqual(result.errors,[]);assert.equal(f.signals.listenerCount("SIGTERM"),0);
    if(!enabled){assert.equal(Object.hasOwn(result,"ownedTrace"),false);assert.equal(Object.hasOwn(result,"observerErrors"),false);}
    else if(observerFault){assert.deepEqual(result.observerErrors,[undefined,undefined]);assert.deepEqual(result.ownedTrace,[1,null,null,[2,2,0]]);}
    else {assert.deepEqual(result.ownedTrace[2],[2,2,2,0,0,36,6,3,2,1,0,0,0]);validateOwnedTrace(result.ownedTrace,0);}
  }
});
test("owned ledger rejects undisposed requests and contradictory saturated or ignored outcomes",()=>{
  const zero=[0,0,0,0,0,0,0,0,0,0,0,0,0];
  assert.throws(()=>validateOwnedTrace([1,null,[1,0,0,0,0,4,2,0,0,0,0,0,0],[0,0,0]],0));
  const valid=[255,255,255,0,0,1,2,1,2,1,0,7,0];validateOwnedTrace([1,[2,0,0,0,0,0,false],valid,[0,0,0]],1);
  for(const bad of [[...valid.slice(0,11),6,0],[...valid.slice(0,11),1,0],[1,1,0,1,0,4,2,3,2,2,1,0,1],[1,1,1,0,1,4,2,3,2,1,0,0,0]])assert.throws(()=>validateOwnedTrace([1,null,bad,[0,0,0]],0));
  assert.throws(()=>validateOwnedTrace([1,[2,6,1,3,7,3,false],zero,[0,0,0]],1));
  assert.throws(()=>validateOwnedTrace([1,[2,6,2,0,3,3,false],zero,[0,0,0]],1));
  for(const trace of [[1,null,[1,1,1,0,0,63,7,1,2,1,0,0,0],[0,0,0]],[1,null,[255,255,0,255,0,1,2,1,2,3,2,32,255],[0,0,0]],[1,null,null,[65535,65535,2]],[1,[1,0,0,0,0,0,true],[1,1,0,1,0,4,2,3,2,3,2,0,1],[0,0,0]]])assert.throws(()=>validateOwnedTrace(trace,trace[1]?1:0));
  assert.throws(()=>validateOwnedTrace([1,null,zero,[0,0,0]],null));
  for(const defined of [false,true]){
    const stop=[1,1,0,1,0,4,2,3,2,defined?3:2,defined?2:1,0,0];
    assert.throws(()=>validateOwnedTrace([1,null,stop,[0,0,0]],0));
    validateOwnedTrace([1,[1,0,0,0,0,0,defined],stop,[0,0,0]],1);
    assert.throws(()=>validateOwnedTrace([1,[1,0,0,0,0,0,!defined],stop,[0,0,0]],1));
    assert.throws(()=>validateOwnedTrace([1,[8,0,0,0,0,0,false],stop,[0,0,0]],1));
    validateOwnedTrace([1,[8,0,0,0,0,0,false],stop,[0,0,0]],2);
  }
  assert.throws(()=>validateOwnedTrace([1,null,[1,1,1,0,0,1,2,1,2,1,0,0,0],[0,0,0]],0));
});
test("owned ledger saturation first error isolation and maximum lossless versioned schema",async()=>{
  const rec=createOwnedProcessLedger();for(let i=0;i<300;i++){rec.request(1,"SIGTERM");rec.attempt(1,"SIGTERM");rec.returned();}
  rec.sampleStage(4);rec.error(2,undefined);rec.error(8,new Error("later"));const trace=rec.finish();assert.deepEqual(trace[1],[2,4,0,0,0,0,false]);assert.equal(trace[2][11],7);validateOwnedTrace(trace,2);
  rec.error(8,new Error("late"));assert.deepEqual(rec.finish(),trace);const independent=createOwnedProcessLedger();independent.error(8,undefined);assert.equal(independent.finish()[1][0],8);
  for(const change of [t=>t[1][0]=10,t=>t[1][1]=10,t=>t[1][2]=1,t=>t[1][6]=null,t=>t[2][1]=254,t=>t[2][11]=64,t=>t[2][6]=0,t=>t[2][7]=6,t=>t[2][8]=3,t=>t[2][9]=2,t=>t[3][1]=1]){const bad=structuredClone(trace);change(bad);assert.throws(()=>validateOwnedTrace(bad,2));}
  const produced=await receiptActualProducer("wrangler_input",false,{processResult:truncateActualBuilder}),prior=await lifecyclePacket(produced);prior.defined=false;prior.parser=[1,2,false,6,1,14,0,16383,8191];prior.count="ONE";prior.lifecycle=[1,256,256,14,0,2,0];prior.reports=[65535,65535];prior.builder=[1,1,3,-65535,14,127,65535,65535,Number.MAX_SAFE_INTEGER,hex,Number.MAX_SAFE_INTEGER,other];
  const wideTrace=[1,[2,6,1,3,7,3,true],[255,255,255,255,255,63,7,5,2,3,2,63,255],[0,0,0]];
  const wire=packReceiptOwnedDiagnostic(prior,wideTrace);assert.deepEqual(unpackReceiptOwnedDiagnostic(wire),prior);assert.ok(Buffer.byteLength(JSON.stringify(wire))<=512);
  for(const change of [r=>r.detail[6][9]+="=",r=>r.detail[6][11]="A".repeat(42),r=>r.detail[6][9]=r.detail[6][9].slice(0,-1)+"B",r=>r.detail[7][1][6]=null,r=>r.detail[7][2][9]=4,r=>r.detail[7][3][2]=4,r=>r.detail.push(0)]){const bad=structuredClone(wire);change(bad);assert.throws(()=>validateReceiptOwnedDiagnostic(bad));}
  const capture=await receiptCapture(produced.frames),rows=[wire,{v:2,phase:"entry",state:"rejected",defined:false,exit:null,signal:null},{v:2,phase:"retirement",state:"rejected",defined:false,exit:null,signal:null}];createAttachProjection(capture.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:r=>rows.push(r)})(capture.h.attached.result);
  const lines=[];emitContainerFailure(rows,line=>lines.push(line));assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
});

test("owned code actual sampler classifies only the original operand once and retains error identity",async()=>{
  const values=[...ownedCodeClasses.slice(0,12),"private-unclassified",undefined,null,0,{},Symbol("private"),()=>{}];
  for(const value of values)for(const inherited of [false,true]){
    let reads=0;const holder={get code(){reads++;return value;}},reason=inherited?Object.create(holder):holder;
    const f=await ownedLedgerFactory({readFile:async()=>{throw reason;}}),rec=f.createOwnedProcessLedger();let failed=false,caught;
    try{await f.privateProcesses(rec);}catch(error){failed=true;caught=error;rec.error(2,error);rec.request(1,"SIGTERM");rec.skipped();}
    assert.equal(reads,1);assert.equal(failed,!["ENOENT","ESRCH"].includes(value));if(failed)assert.equal(caught,reason);
    const trace=rec.finish(),code=rec.code();validateOwnedTrace(trace,failed?1:0,[false,false]);validateOwnedCode(code,trace);
    assert.deepEqual(code,["ENOENT","ESRCH"].includes(value)?[1,0,0]:[1,1,classifyOwnedCode(value)]);
  }
  for(const reason of [undefined,null]){
    const f=await ownedLedgerFactory({readFile:async()=>{throw reason;}}),rec=f.createOwnedProcessLedger();let caught=false;
    try{await f.privateProcesses(rec);}catch(error){caught=true;assert.equal(error,reason);rec.error(2,error);}
    assert.ok(caught);assert.deepEqual(rec.code(),[1,1,14]);assert.equal(rec.finish()[1][6],reason!==undefined);
  }
});
test("owned code getter throws remain stage eight with the exact escaping reason",async()=>{
  for(const thrown of [new Error("inert"),undefined])for(const enabled of [false,true]){
    let reads=0;const reason={get code(){reads++;throw thrown;}},f=await ownedLedgerFactory({readFile:async()=>{throw reason;}}),rec=enabled?f.createOwnedProcessLedger():undefined;let failed=false;
    try{await f.privateProcesses(rec);}catch(error){failed=true;assert.equal(error,thrown);if(rec){rec.error(2,error);rec.request(1,"SIGTERM");rec.skipped();}}
    assert.ok(failed);assert.equal(reads,1);if(rec){const trace=rec.finish();assert.deepEqual(trace[1],[2,8,0,0,0,0,thrown!==undefined]);assert.deepEqual(rec.code(),[1,2,0]);validateOwnedCode(rec.code(),trace);}
  }
});
test("owned code ignored ENOENT and overlapping invocations cannot supply stale code evidence",async()=>{
  let ordinal=0;const original={code:"EPERM"},f=await ownedLedgerFactory({readdir:async()=>["12","13"],readFile:async()=>{throw ordinal++===0?{code:"ENOENT"}:original;}}),rec=f.createOwnedProcessLedger();
  try{await f.privateProcesses(rec);assert.fail("escape required");}catch(error){assert.equal(error,original);rec.error(2,error);}
  assert.equal(ordinal,2);assert.deepEqual(rec.code(),[1,1,4]);
  const pending=[];const g=await ownedLedgerFactory({readFile:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))}),shared=g.createOwnedProcessLedger();
  const a=g.privateProcesses(shared),b=g.privateProcesses(shared);const settled=Promise.allSettled([a,b]);await Promise.resolve();assert.equal(pending.length,2);
  pending[1].reject({code:"EIO"});pending[0].reject(original);const outcomes=await settled;assert.equal(outcomes[0].reason,original);shared.error(2,original);assert.ok(shared.errors.length);assert.equal(shared.code(),null);assert.equal(shared.finish()[1],null);
  const separate=[g.createOwnedProcessLedger(),g.createOwnedProcessLedger()],c=g.privateProcesses(separate[0]),d=g.privateProcesses(separate[1]),done=Promise.allSettled([c,d]);await Promise.resolve();
  pending[3].reject({code:"EIO"});pending[2].reject(original);const distinct=await done;
  for(let i=0;i<2;i++)separate[i].error(2,distinct[i].reason);
  assert.deepEqual(separate.map(r=>r.code()),[[1,1,4],[1,1,5]]);
});
test("owned code recorder failure does not become getter failure or suppress original stop and cleanup",async()=>{
  const original={code:"EPERM"};let reads=0;
  const f=await ownedLedgerFactory({readFile:async()=>{reads++;throw original;}}),rec=f.createOwnedProcessLedger();rec.sampleCode=()=>{throw undefined;};let samples=0;
  const work=f.runOwnedProcess(f.command,f.args,{cwd:"/task",env:f.environment,recorder:rec,signalSource:f.signals,sample:()=>++samples===1?f.privateProcesses(rec):Promise.resolve([])});
  f.intervals[0].fn();for(let i=0;i<8;i++)await Promise.resolve();assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),[["kill",-12,"SIGTERM"]]);
  f.child.emit("close",null,"SIGTERM");const result=await work;
  assert.equal(reads,1);assert.equal(samples,2);assert.equal(result.errors[0],original);assert.deepEqual(result.observerErrors,[undefined]);assert.equal(result.ownedCode,null);assert.equal(result.ownedTrace[1],null);assert.equal(f.signals.listenerCount("SIGTERM"),0);assert.equal(f.calls.filter(r=>r[0]==="clearTimeout").length,2);
});
test("owned code actual process acceptor projector pipeline preserves each display class and both hashes",async()=>{
  for(const value of [...ownedCodeClasses.slice(1,12),"private-other",undefined,null,{},"THROW_UNDEFINED"]){
    let original,reads=0;const reason={get code(){reads++;if(value==="THROW_UNDEFINED")throw undefined;return value;}};
    const produced=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>{
      let calls=0;const f=await ownedProcessScenario("monitor_proc",stdout.split("\n").slice(0,6).join("\n")+"\n",{readFile:async()=>{if(calls++===0){if(value==="ESRCH")return{lastIndexOf(){throw reason;}};throw reason;}return"12 (inert) S 1 12 "+Array(16).fill("0").join(" ")+" 123";}},{command,args,options});original=f.result;assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),[["kill",-12,"SIGTERM"]]);return original;
    }});
    assert.equal(reads,1);assert.equal(original.errors[0],value==="THROW_UNDEFINED"?undefined:reason);if(value==="ESRCH")assert.equal(original.ownedTrace[1][1],5);
    const wire=await lifecyclePacket(produced,frames=>frames,true);assert.equal(wire.v,15);assert.deepEqual(wire.detail[8],value==="THROW_UNDEFINED"?[1,2,0]:[1,1,classifyOwnedCode(value)]);assert.deepEqual(wire.detail[7],original.ownedTrace);assert.equal(receiptView(wire).builder[9],original.outputSummary.stdout.sha256);assert.equal(receiptView(wire).child[1],"invalid");
  }
});
test("owned code closed schemas reject contradictions missing fields and malformed frames without lifecycle credit",async()=>{
  const trace=[1,[2,4,0,0,0,0,true],[1,0,0,0,1,1,2,0,0,0,0,0,0],[0,0,0]];
  for(const bad of [[1,1,1],[1,1,0],[1,2,14],[1,0,14],[1,3,0],[1,1,17],[2,1,4],undefined,[1,1,4,0]])assert.throws(()=>validateOwnedCode(bad,trace));
  assert.throws(()=>validateOwnedCode([1,2,0],trace));const undef=structuredClone(trace);undef[1][6]=false;assert.throws(()=>validateOwnedCode([1,1,4],undef));
  for(const stage of [0,1,2,3,8,9]){const wrong=structuredClone(trace);wrong[1][1]=stage;assert.throws(()=>validateOwnedCode([1,1,4],wrong));}
  const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>(await ownedProcessScenario("monitor_proc",stdout.split("\n").slice(0,6).join("\n")+"\n",{readFile:async()=>{throw{code:"EPERM"};}},{command,args,options})).result});
  const wire=await lifecyclePacket(made,frames=>frames,true);validateContainerDiagnostic(wire);
  for(const mutate of [r=>r.detail.pop(),r=>r.detail[8]=[1,1,1],r=>r.detail[8][2]=17,r=>r.detail[8]=[1,2,0]]){const bad=structuredClone(wire);mutate(bad);assert.throws(()=>validateContainerDiagnostic(bad));}
  for(const mutate of [r=>delete r.code,r=>r.code=[1,1,1],r=>r.code=[1,2,0]]){
    const rejected=await lifecyclePacket(made,frames=>frames.map(line=>{let row=JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));if(row.phase==="build_a_close"){if(row.v===4)row=unpackCensusCloseDiagnostic(row);mutate(row);}return"EDGE_PACKAGING_V1 "+JSON.stringify(row)+"\n";}));assert.equal(rejected.child[1],"invalid");assert.equal(rejected.builder,null);
  }
});
test("owned code widest receipt retains historical codecs all process fields and strict packet budgets",async()=>{
  const made=await receiptActualProducer("wrangler_input",false,{processResult:truncateActualBuilder}),prior=await lifecyclePacket(made);prior.defined=false;prior.parser=[1,2,false,6,1,14,0,16383,8191];prior.count="ONE";prior.lifecycle=[1,255,256,14,33,1,0];prior.reports=[65535,65535];prior.builder=[1,1,3,-65535,14,127,65535,65535,Number.MAX_SAFE_INTEGER,hex,Number.MAX_SAFE_INTEGER,other];
  const trace=[1,[2,6,2,0,3,3,false],[255,255,255,255,255,63,7,5,2,3,2,63,255],[0,0,0]],wire=packReceiptCodeDiagnostic(prior,trace,[1,1,14]);
  assert.deepEqual(receiptView(wire),prior);assert.deepEqual(validateReceiptOwnedDiagnostic({...wire,v:13,detail:wire.detail.slice(0,8)}),packReceiptOwnedDiagnostic(prior,trace));
  assert.ok(Buffer.byteLength(JSON.stringify(wire))<=512);const rows=[wire,...["entry","dispatch","retirement","host_runtime","cwd","context","environment","image"].map(phase=>({v:2,phase,state:"rejected",defined:false,exit:null,signal:null}))],lines=[];
  const captured=await receiptCapture(made.frames);createAttachProjection(captured.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:r=>rows.push(r)})(captured.h.attached.result);
  emitContainerFailure(rows,line=>lines.push(line));assert.equal(lines.length,10);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
});

const esrchStat = (start="123",parent="1",group="12") => {
  const fields=Array(20).fill("0");fields[0]="S";fields[1]=parent;fields[2]=group;fields[19]=start;return"12 (inert) "+fields.join(" ");
};
test("stat ESRCH read-only omission keeps valid neighbors and original property reads",async()=>{
  for(const code of ["ENOENT","ESRCH"])for(const enabled of [false,true]){
    const calls=[];let getters=0;const reason={get code(){getters++;return code;}};
    const f=await ownedLedgerFactory({readdir:async path=>{calls.push(["directory",path]);return["1","self","12","13","14"];},readFile:async(...args)=>{calls.push(["stat",...args]);if(args[0]==="/proc/13/stat")throw reason;return esrchStat(args[0]==="/proc/12/stat"?"123":"456","99","88");}}),rec=enabled?f.createOwnedProcessLedger():undefined;
    const rows=await f.privateProcesses(rec);assert.deepEqual(rows.map(r=>[r.pid,r.start,r.parent,r.group]),[[12,"123",99,88],[14,"456",99,88]]);assert.equal(getters,1);
    assert.deepEqual(calls,[["directory","/proc"],["stat","/proc/12/stat","utf8"],["stat","/proc/13/stat","utf8"],["stat","/proc/14/stat","utf8"]]);if(rec){assert.equal(rec.finish()[1],null);assert.deepEqual(rec.code(),[1,0,0]);}
  }
});
test("stat ESRCH outside the original read stays fatal with the same reason and stage",async()=>{
  for(const phase of ["directory","path","parse","shape","row"]){
    let getters=0,reads=0;const reason={get code(){getters++;return"ESRCH";}};
    const override={readFile:async()=>{reads++;if(phase==="parse")return{lastIndexOf(){throw reason;}};return phase==="shape"?"12 (inert) ?":esrchStat();}};
    if(phase==="directory")override.readdir=async()=>{throw reason;};
    if(phase==="path"){let conversions=0;override.readdir=async()=>[{toString(){if(++conversions===1)return"12";throw reason;}}];}
    if(phase==="shape")override.refuse=()=>{throw reason;};
    if(phase==="row")override.Number=()=>{throw reason;};
    const f=await ownedLedgerFactory(override),rec=f.createOwnedProcessLedger();let failed=false;
    try{await f.privateProcesses(rec);}catch(error){failed=true;assert.equal(error,reason);rec.error(2,error);}
    assert.ok(failed);assert.equal(rec.finish()[1][1],{directory:2,path:4,parse:5,shape:6,row:7}[phase]);assert.equal(getters,phase==="directory"?0:1);assert.equal(reads,["directory","path"].includes(phase)?0:1);
  }
});
test("stat ESRCH ignored entry cannot contaminate a later failure or an observation failure",async()=>{
  for(const later of [undefined,{code:"EPERM"}]){
    let reads=0;const f=await ownedLedgerFactory({readdir:async()=>["12","13"],readFile:async()=>{throw reads++===0?{code:"ESRCH"}:later;}}),rec=f.createOwnedProcessLedger();let failed=false;
    try{await f.privateProcesses(rec);}catch(error){failed=true;assert.equal(error,later);rec.error(2,error);}
    assert.ok(failed);assert.equal(reads,2);assert.deepEqual(rec.code(),[1,1,later===undefined?14:4]);assert.equal(rec.finish()[1][6],later!==undefined);
  }
  const original={code:"ESRCH"};let reads=0;const f=await ownedLedgerFactory({readFile:async()=>{reads++;return{lastIndexOf(){throw original;}};}}),rec=f.createOwnedProcessLedger();rec.sampleState=()=>{throw undefined;};let failed=false;
  try{await f.privateProcesses(rec);}catch(error){failed=true;assert.equal(error,original);rec.error(2,error);}
  assert.ok(failed);assert.equal(reads,1);assert.ok(rec.errors.includes(undefined));assert.equal(rec.code(),null);
});
async function esrchMonitorResult({final="empty",exit=0,observerFault=false}={}) {
  let sampleIndex=0;const pending=[],finalReason={code:"ESRCH"};
  const f=await ownedLedgerFactory({readdir:async()=>final==="parse"&&sampleIndex===4?["12"]:sampleIndex===4&&final==="empty"?[]:["12"],readFile:async()=>{if(sampleIndex===2)throw{code:"ESRCH"};if(sampleIndex===4&&final==="parse")return{lastIndexOf(){throw finalReason;}};return esrchStat(sampleIndex===1?"123":"124",sampleIndex===4?"99":"1");}}),rec=f.createOwnedProcessLedger();
  if(observerFault)rec.sampleState=()=>{throw undefined;};
  const work=f.runOwnedProcess(f.command,f.args,{cwd:"/task",env:f.environment,recorder:rec,signalSource:f.signals,sample:()=>{sampleIndex++;const p=f.privateProcesses(rec);pending.push(p);return p;}});
  for(let i=0;i<3;i++){f.intervals[0].fn();await pending[i].catch(()=>{});await Promise.resolve();}
  f.child.emit("close",exit,null);const result=await work;assert.equal(sampleIndex,4);assert.deepEqual([...result.observed.keys()],["12:123","12:124"]);assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),[]);assert.equal(f.signals.listenerCount("SIGTERM"),0);
  return{...f,result,finalReason};
}
test("stat ESRCH sampling retains prior starts and cannot waive original success or final census",async()=>{
  const success=await esrchMonitorResult();success.requireProcessSuccess(success.result);assert.equal(success.result.errors.length,0);assert.deepEqual(success.result.ownedCode,[1,0,0]);
  for(const options of [{final:"live"},{final:"parse"},{exit:1}]){
    const f=await esrchMonitorResult(options);assert.throws(()=>f.requireProcessSuccess(f.result));if(options.final==="live")assert.equal(f.result.remaining[0].parent,99);if(options.final==="parse"){assert.equal(f.result.errors[0],f.finalReason);assert.equal(f.result.ownedTrace[1][0],9);assert.equal(f.result.ownedTrace[1][1],5);}
  }
  const fault=await esrchMonitorResult({observerFault:true});assert.ok(fault.result.observerErrors.includes(undefined));assert.equal(fault.result.ownedTrace[1],null);assert.equal(fault.result.ownedCode,null);
});
test("stat ESRCH actual producer keeps missing terminal invalid after a tolerated read",async()=>{
  let original;
  const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>{
    let n=0;const f=await ownedProcessScenario("monitor_proc",stdout.split("\n").slice(0,6).join("\n")+"\n",{readFile:async()=>{if(n++===0)throw{code:"ESRCH"};return esrchStat();}},{command,args,options});original=f.result;assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),[]);return original;
  }});
  assert.equal(original.errors.length,0);assert.equal(original.ownedTrace[1],null);assert.deepEqual(original.ownedCode,[1,0,0]);
  const wire=await lifecyclePacket(made,frames=>frames,true);assert.equal(wire.detail[1][1],"invalid");assert.deepEqual(wire.detail[5],[1,6,6,12,0,2,0]);assert.equal(wire.detail[7][1],null);assert.deepEqual(wire.detail[8],[1,0,0]);
});
test("receipt associated actual builder failures select the exact A or B close and forwarded role",async()=>{
  for(const role of ["build_a","build_b"])for(const phase of ["namespace_read","native_receipt","builder_import","resolve","createRequire","require","build","receipt_write","build_service_stop"])for(const exitZero of [false,true]) {
    const reason = new Error("inert original");
    const made=await receiptActualProducer(role+":"+phase,false,{reason,processResult(result,current){if(current===role&&exitZero)result.code=0;}});
    const target=made.builders.at(-1);assert.equal(target.failed,true);assert.equal(target.reason,reason);assert.equal(target.calls.filter(r=>r[0]===phase).length,1);
    assert.equal(made.builders.length,role==="build_a"?1:2);
    const wire=await lifecyclePacket(made,frames=>frames,true),view=receiptView(wire),original=made.processResults.at(-1);
    assert.equal(wire.v,15);assert.equal(view.child[1],"reported_rejection");assert.equal(view.projection,null);assert.equal(view.lifecycle,null);
    assert.equal(view.builder[1],role==="build_a"?1:2);assert.equal(view.builder[3],original.code);assert.equal(view.builder[2],exitZero?1:3);
    assert.deepEqual(view.builder.slice(8),[original.outputSummary.stdout.bytes,original.outputSummary.stdout.sha256,original.outputSummary.stderr.bytes,original.outputSummary.stderr.sha256]);
    assert.equal(view.child[8],"UNKNOWN");assert.throws(()=>validateReceiptCodeDiagnostic({...wire,v:14}));
  }
  for(const failure of ["receipt_read","receipt_read_b"]) {
    const made=await receiptActualProducer(failure),wire=await lifecyclePacket(made,frames=>frames,true),view=receiptView(wire);
    assert.equal(made.reason,undefined);assert.equal(made.rejections.at(-1).reason,undefined);
    assert.equal(view.builder[1],failure==="receipt_read"?1:2);assert.equal(view.builder[2],1);
    assert.equal(view.child[6],receiptChildPhases.indexOf(failure==="receipt_read"?"build_a_report":"build_b_report")+1);
  }
  for(const failure of ["namespace_read","wrangler_input"]) {
    const made=await receiptActualProducer(failure);assert.equal(made.reason,undefined);
    assert.equal((await lifecyclePacket(made)).builder,null);
  }
});
test("receipt associated original owned-process complete captures preserve close trace code and unknowns atomically",async()=>{
  for(const scenario of ["nonzero","signal","timeout","interrupt","error_undefined","sample_undefined","remaining"])for(const role of ["build_a","build_b"]) {
    const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:(command,args,options,stdout)=>receiptOwnedResult(command,args,options,stdout,args[3]===role?scenario:"normal",true)});
    const original=made.processResults.at(-1),wire=await lifecyclePacket(made,frames=>frames,true),view=receiptView(wire);
    assert.equal(view.child[1],"reported_rejection");assert.equal(view.child[6],receiptChildPhases.indexOf(role+"_close")+1);
    assert.equal(view.builder[3],original.code);assert.equal(view.builder[4],receiptBuilderSignals.indexOf(original.signal));
    assert.equal(view.builder[6],original.errors.length);assert.equal(view.builder[7],original.remaining?.length??null);
    assert.deepEqual(wire.detail[7],original.ownedTrace);assert.deepEqual(wire.detail[8],original.ownedCode);
    assert.ok(made.reason instanceof AggregateError);assert.equal(made.rejections.find(r=>r.phase===role+"_close").reason,made.reason);
    if(scenario.endsWith("undefined"))assert.equal(original.errors[0],undefined);
  }
  for(const scenario of ["monitor_undefined","report_fault","monitor_proc"]) {
    const reason={code:"EIO"};
    const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>(await ownedProcessScenario(scenario,stdout,scenario==="monitor_proc"?{readFile:async()=>{throw reason;}}:{},{command,args,options})).result});
    const original=made.processResults[0],wire=await lifecyclePacket(made,frames=>frames,true);
    assert.deepEqual(wire.detail[7],original.ownedTrace);assert.deepEqual(wire.detail[8],original.ownedCode);
    if(scenario==="monitor_proc"){assert.equal(original.errors[0],reason);assert.deepEqual(wire.detail[8],[1,1,5]);}
    if(scenario==="report_fault"){assert.ok(original.observerErrors.includes(undefined));assert.equal(wire.detail[7][1],null);}
  }
});
test("receipt associated complete zero-record startup interval and repeated report occurrences stay distinct",async()=>{
  const made=await receiptActualProducer("wrangler_input",false,{processResult(result){result.code=1;result.stdout="";result.outputSummary.stdout={bytes:0,sha256:createHash("sha256").update("").digest("hex"),esc:false,complete:true};}});
  const wire=await lifecyclePacket(made,frames=>frames,true);assert.equal(wire.detail[1][1],"reported_rejection");assert.equal(wire.detail[1][3],1);assert.equal(wire.detail[6][3],1);
  const reject=await receiptActualProducer("build_a:build",false,{reason:undefined,stopFailure:true,stopReason:undefined});
  assert.deepEqual(reject.builders[0].reason.errors,[undefined,undefined]);assert.ok((await lifecyclePacket(reject)).builder);
  const reported=await receiptActualProducer("build_a:build",false,{writeFailure:["build","rejected"]});
  assert.deepEqual(reported.builders[0].reason.errors,[undefined,undefined]);const row=await lifecyclePacket(reported);assert.notEqual(row.child[1],"reported_complete");
  const output=await receiptActualProducer("wrangler_input",false,{processResult(result){result.stdout=result.stdout.slice(0,result.stdout.lastIndexOf('{"built":true}'));result.outputSummary.stdout.bytes=Buffer.byteLength(result.stdout);result.outputSummary.stdout.sha256=createHash("sha256").update(result.stdout).digest("hex");}});
  const reportView=await lifecyclePacket(output);assert.equal(reportView.child[6],receiptChildPhases.indexOf("build_a_report")+1);assert.equal(reportView.builder[2],1);
});
test("receipt associated global framing ownership and capture failures cannot promote a group",async()=>{
  const made=await receiptActualProducer("build_b:build"),row=line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));
  const mutations=[
    frames=>[...frames,frames.at(-1)],frames=>[...frames.slice(0,-1),frames.at(-1).trimEnd()],
    frames=>frames.filter(line=>row(line).phase!=="stderr_summary"),
    frames=>frames.map(line=>line.replace('"role":"build_b"','"role":"foreign"')),
    frames=>frames.map(line=>line.replace('"v":1','"v":1,"v":1')),
    frames=>frames.map(line=>line.includes('"build_b_close"')?line.replace('"defined":true','"defined":null'):line),
    frames=>{const copy=[...frames],i=copy.findIndex(line=>row(line).phase==="build_b_close");[copy[i],copy[i+1]]=[copy[i+1],copy[i]];return copy;},
    frames=>{const copy=[...frames],i=copy.findIndex(line=>row(line).phase==="build_b_launch");copy.splice(i,0,copy[i]);return copy;},
  ];
  for(const [index,mutate] of mutations.entries()){const bad=await lifecyclePacket(made,mutate);assert.equal(bad.builder,null,"mutation "+index);}
  for(const channel of ["stdout","stderr"]) {
    const capture=await receiptCapture(made.frames);capture.h.attached.result.outputSummary[channel].retainedBytes++;
    const ledger=createProjectionLedger();assert.equal(capture.summary(ledger)[1],"capture_mismatch");assert.equal(ledger.builder(),null);assert.equal(ledger.owned(),null);assert.equal(ledger.code(),null);
  }
});
test("receipt associated schemas preserve all legacy branches and reject contradictory association and trace",async()=>{
  const made=await receiptActualProducer("build_a:build"),wire=await lifecyclePacket(made,frames=>frames,true);
  for(const mutate of [r=>r.detail[6][1]=2,r=>r.detail[1][6]=33,r=>r.detail[6][2]=2,r=>r.detail[1][5]=2,r=>r.detail[4]=[1,30,4,1,1,1,0,null],r=>r.detail[7]=[1,null,null,[0,0,0]],r=>r.detail[8]=[1,1,5],r=>r.detail[6]=null,r=>r.detail.push(null)]){
    const bad=structuredClone(wire);mutate(bad);if(bad.detail[6]===null)validateContainerDiagnostic(bad);else assert.throws(()=>validateContainerDiagnostic(bad));
  }
  const historical=await lifecyclePacket(await receiptActualProducer("wrangler_input",false,{processResult:truncateActualBuilder}),frames=>frames,true);
  assert.deepEqual(validateReceiptCodeDiagnostic({...historical,v:14}),{...historical,v:14});
  const wide=receiptView(wire);wide.defined=false;wide.parser=[1,2,false,6,1,14,0,16383,8191];wide.count="UNKNOWN";wide.reports=[65535,65535];wide.child[2]=256;
  wide.builder=[1,1,3,-65535,14,127,65535,65535,Number.MAX_SAFE_INTEGER,hex,Number.MAX_SAFE_INTEGER,other];
  const trace=[1,[2,6,2,0,3,3,false],[255,255,255,255,255,63,7,5,2,3,2,63,255],[0,0,0]],packed=packReceiptAssociatedDiagnostic(wide,trace,[1,1,14]);
  assert.deepEqual(receiptView(packed),wide);assert.ok(Buffer.byteLength(JSON.stringify(packed))<=512);
  const capture=await receiptCapture(made.frames),records=[packed,...["entry","dispatch","retirement","host_runtime","cwd","context","environment","image"].map(phase=>({v:2,phase,state:"rejected",defined:false,exit:null,signal:null}))];
  createAttachProjection(capture.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:r=>records.push(r)})(capture.h.attached.result);
  const lines=[];emitContainerFailure(records,line=>lines.push(line));assert.equal(lines.length,10);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
});
async function censusActualProcess(monitorRows,finalRows,{stdout="",reason,failFinal=false,held=false,fault=false,expectedStops=0,hasChildError=false,childError,failMonitor=false,monitorReason,supplied}={}) {
  let phase=0,release;const gate=new Promise(resolve=>{release=resolve;}),reads=[],samples=[];
  const f=await ownedLedgerFactory({readdir:async path=>{assert.equal(path,"/proc");const rows=phase?finalRows:monitorRows;return["1","self",...rows.map(r=>String(r.pid))];},readFile:async(path,encoding)=>{
    assert.equal(encoding,"utf8");const at=phase,rows=at?finalRows:monitorRows;reads.push([at,path]);if(at&&failFinal)throw reason;if(!at&&failMonitor)throw monitorReason;
    const row=rows.find(r=>path===`/proc/${r.pid}/stat`);assert.ok(row);const fields=Array(20).fill("0");fields[0]=row.state;fields[1]=String(row.parent);fields[2]=String(row.group);fields[19]=row.start;
    const text=row.pid+" (inert) "+fields.join(" ");if(!at&&held)await gate;return text;
  }},supplied),rec=supplied?.options.recorder??f.createOwnedProcessLedger();
  if(fault)rec.censusRow=()=>{throw undefined;};
  const sample=()=>{const p=f.privateProcesses(rec);samples.push(p);return p;};
  const promise=f.runOwnedProcess(f.command,f.args,{cwd:"/task",env:f.environment,signalSource:f.signals,recorder:rec,sample});let settled=false;promise.then(()=>{settled=true;});
  if(hasChildError)f.child.emit("error",childError);
  f.intervals[0].fn();
  if(!held)await samples[0].catch(()=>{});
  f.child.stdout.emit("data",Buffer.from(stdout));f.child.emit("close",0,null);phase=1;
  if(held){await Promise.resolve();assert.equal(samples.length,1);assert.equal(settled,false);release();await samples[0];const join=f.timers.find(t=>t.ms===1);assert.ok(join);join.fn();}
  const result=await promise;assert.equal(samples.length,2);assert.equal(f.calls.filter(r=>r[0]==="spawn").length,1);assert.equal(f.calls.filter(r=>r[0]==="kill").length,expectedStops);
  assert.equal(f.calls.filter(r=>r[0]==="clearTimeout").length,2);assert.equal(f.calls.filter(r=>r[0]==="clearInterval").length,1);assert.equal(f.signals.listenerCount("SIGINT"),0);
  return{...f,result,rec,reads,samples};
}
const censusRow = (pid=12,start="123",state="S",parent=1,group=pid)=>({pid,start,state,parent,group});
const censusDecode = n=>[n%16,(n>>4)&3,(n>>6)&3,(n>>8)&7,(n>>11)&3,(n>>13)&3,(n>>15)&3];
test("final census actual sampler and process preserve every state and complete relation group",async()=>{
  for(const state of censusStates){const row=censusRow(12,"123",state),f=await censusActualProcess([row],[row]),t=f.result.ownedCensus;
    assert.equal(f.result.code,0);assert.equal(f.result.closed,true);assert.equal(f.result.errors.length,0);assert.equal(f.result.remaining.length,1);assert.throws(()=>f.requireProcessSuccess(f.result));
    assert.deepEqual(t.slice(0,7),[1,1,7,1,1,0,0]);assert.deepEqual(censusDecode(t[8][0]),[censusStates.indexOf(state)+1,1,1,1,1,1,1]);
    assert.equal(t[7].reduce((a,b)=>a+b,0),1);validateFinalCensus(t,1,true,0,f.result.ownedTrace);assert.equal(f.reads.length,2);
  }
  const empty=await censusActualProcess([],[]);assert.doesNotThrow(()=>empty.requireProcessSuccess(empty.result));assert.deepEqual(empty.result.ownedCensus,[1,1,7,0,0,0,0,Array(10).fill(0),[],1]);
});
test("final census sampled history distinguishes reused unseen and changed identities without ownership",async()=>{
  for(const [prior,next,expected] of [
    [[censusRow()],[censusRow(12,"124")],[2,1,1,0,0,0]],
    [[censusRow()],[censusRow(13)],[3,1,1,0,0,0]],
    [[censusRow()],[censusRow(12,"123","Z",3,4)],[1,3,4,2,2,2]],
  ]){const f=await censusActualProcess(prior,next),t=f.result.ownedCensus;assert.deepEqual(censusDecode(t[8][0]).slice(1),expected);assert.equal(f.result.observed.size,prior.length);assert.throws(()=>f.requireProcessSuccess(f.result));}
  const rows=[censusRow(12,"1","S",13,13),censusRow(13,"2","R",1,1),censusRow(14,"3","Z")],f=await censusActualProcess([],rows),t=f.result.ownedCensus;
  assert.deepEqual(t.slice(3,6),[3,2,1]);assert.deepEqual(censusDecode(t[8][0]).slice(1,4),[3,2,3]);assert.deepEqual(censusDecode(t[8][1]).slice(1,4),[3,1,2]);assert.equal(t[7][3],1);
});
test("final census original held sample close ordering undefined read and observer faults remain independent",async()=>{
  const held=await censusActualProcess([censusRow()],[censusRow()],{held:true});assert.equal(held.result.ownedCensus[2],7);assert.equal(held.reads.length,2);
  for(const reason of [undefined,new Error("inert original")]){const failed=await censusActualProcess([],[censusRow()],{failFinal:true,reason});assert.equal(failed.result.errors.length,1);assert.equal(failed.result.errors[0],reason);assert.equal(failed.result.remaining,null);assert.equal(failed.result.ownedCensus[1],reason===undefined?2:3);validateFinalCensus(failed.result.ownedCensus,null,true,1,failed.result.ownedTrace);assert.throws(()=>failed.requireProcessSuccess(failed.result));}
  const broken=await censusActualProcess([censusRow()],[censusRow()],{fault:true});assert.equal(broken.result.remaining.length,1);assert.equal(broken.result.errors.length,0);assert.ok(broken.result.observerErrors.includes(undefined));assert.equal(broken.result.ownedCensus[9],3);assert.equal(broken.result.ownedCensus[3],null);assert.throws(()=>broken.requireProcessSuccess(broken.result));
  const foreign=await ownedProcessScenario("iterator");assert.equal(foreign.result.ownedCensus[1],1);assert.equal(foreign.result.ownedTrace[1][0],3);
});
test("final census bounds duplicate ambiguity foreign references and invocation isolation stay closed",async()=>{
  const many=Array.from({length:513},(_,i)=>censusRow(i+2,String(i))),f=await censusActualProcess([],many),t=f.result.ownedCensus;
  assert.deepEqual(t.slice(3,6),[513,2,511]);assert.equal(t[9],2);assert.equal(t[7][1],513);validateFinalCensus(t,513,true,0,f.result.ownedTrace);
  const partial=await censusActualProcess(many,[many[0]],{expectedStops:1});assert.equal(partial.result.errors.length,1);assert.equal(partial.result.ownedTrace[1][0],4);assert.equal(partial.result.observed.size,513);
  assert.deepEqual(censusDecode(partial.result.ownedCensus[8][0]).slice(1),[0,1,1,0,0,0]);assert.throws(()=>partial.requireProcessSuccess(partial.result));
  const dup=await censusActualProcess([],[censusRow(),censusRow()]);assert.equal(dup.result.ownedCensus[9],0);assert.equal(censusDecode(dup.result.ownedCensus[8][0])[1],0);
  const a=createOwnedProcessLedger(),b=createOwnedProcessLedger(),factory=await ownedLedgerFactory();const rows=await factory.privateProcesses(a);b.censusClose();b.censusFinal();b.censusResult(rows);assert.deepEqual(b.censusFinish(),[1,1,7,null,0,null,0,null,[],0]);
  a.censusObserved(rows);a.censusClose();a.censusFinal();a.censusResult(rows);assert.equal(a.censusFinish()[3],null);
});
test("final census failed monitor history cannot contradict its original trace in either frame",async()=>{
  const many=Array.from({length:513},(_,i)=>censusRow(i+2,String(i)));
  const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>(await censusActualProcess(many,[many[0]],{stdout,expectedStops:1,supplied:{command,args,options}})).result});
  const wire=await lifecyclePacket(made,frames=>frames,"census"),close=JSON.parse(made.frames.find(line=>line.includes('"v":4')&&line.includes('"phase":"build_a_close"')).slice("EDGE_PACKAGING_V1 ".length));
  assert.equal(wire.detail[8][1][0],4);assert.equal(censusDecode(wire.detail[10][8][0])[1],0);
  for(const history of [1,2,3]){
    const bits=history*16+(history===1?2048+8192+32768:0);
    const bad=structuredClone(wire);bad.detail[10][8][0]+=bits;assert.throws(()=>validateContainerDiagnostic(bad));
    const frame=structuredClone(close);frame.detail[7][8][0]+=bits;assert.throws(()=>validatePackagingDiagnostic(frame));
  }
});
async function censusTraceCase(monitorRows,finalRows,options={}) {
  let actual,calls=0;
  const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,provided,stdout)=>{
    calls++;actual=await censusActualProcess(monitorRows,finalRows,{...options,stdout,supplied:{command,args,options:provided}});return actual.result;
  }});
  assert.equal(calls,1);assert.equal(made.failed,true);
  const wire=await lifecyclePacket(made,frames=>frames,"census");
  const frames=made.frames.map(line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length))).filter(r=>r.v===4&&r.phase==="build_a_close");
  assert.equal(frames.length,1);assert.deepEqual(wire.detail[10],actual.result.ownedCensus);assert.deepEqual(wire.detail[8],actual.result.ownedTrace);
  return{...actual,wire,frame:frames[0]};
}
const rejectCensusTrace = (original,mutate) => {
  const wire=structuredClone(original.wire),frame=structuredClone(original.frame);mutate(wire.detail[10]);mutate(frame.detail[7]);
  assert.throws(()=>validatePackagingDiagnostic(frame));assert.throws(()=>validateContainerDiagnostic(wire));
  assert.throws(()=>emitContainerFailure([wire],()=>assert.fail("contradictory census emitted")));
};
test("final census trace class observes child error before later monitor stop without trusted history",async()=>{
  for(const childError of [undefined,new Error("inert child")]){
    const f=await censusTraceCase([censusRow()],[censusRow()],{hasChildError:true,childError,failMonitor:true,monitorReason:undefined,expectedStops:1});
    assert.equal(f.result.errors.length,2);assert.equal(f.result.errors[0],childError);assert.equal(f.result.errors[1],undefined);
    assert.deepEqual(f.result.ownedTrace[1],[8,0,0,0,0,0,childError!==undefined]);assert.equal(f.result.ownedTrace[2][5]&1,1);
    assert.deepEqual(f.calls.filter(r=>r[0]==="kill"),[["kill",-12,"SIGTERM"]]);assert.equal(f.reads.length,2);assert.equal(f.samples.length,2);
    assert.deepEqual(censusDecode(f.result.ownedCensus[8][0]).slice(1),[0,1,1,0,0,0]);assert.throws(()=>f.requireProcessSuccess(f.result));
    for(const history of [1,2,3])rejectCensusTrace(f,t=>{t[8][0]+=history*16+(history===1?2048+8192+32768:0);});
  }
});
test("final census trace class observer faults exclude even ambiguous known counts and rows",async()=>{
  const rows=[censusRow(),censusRow()],f=await censusTraceCase([],rows,{fault:true});
  assert.equal(f.result.errors.length,0);assert.equal(f.result.remaining.length,2);assert.equal(f.result.observerErrors.length,2);assert.ok(f.result.observerErrors.every(e=>e===undefined));
  assert.equal(f.result.ownedCensus[3],null);assert.equal(f.result.ownedCensus[9],3);assert.equal(f.result.ownedTrace[3][0],2);
  const forged=[1,1,7,2,2,0,0,[0,2,0,0,0,0,0,0,0,0],[322,322],0];
  rejectCensusTrace(f,t=>{t.splice(0,t.length,...structuredClone(forged));});
  for(const availability of [0,3]){
    const wire=structuredClone(f.wire),frame=structuredClone(f.frame);wire.detail[10][9]=availability;frame.detail[7][9]=availability;
    validateContainerDiagnostic(wire);validatePackagingDiagnostic(frame);
    for(const faults of [[65535,65535,3],[65535,0,1]]){wire.detail[8][3]=faults;frame.detail[5][3]=faults;validateContainerDiagnostic(wire);validatePackagingDiagnostic(frame);}
  }
  const ambiguous=await censusTraceCase([],rows);assert.equal(ambiguous.result.ownedCensus[9],0);assert.equal(ambiguous.result.ownedCensus[3],2);assert.equal(ambiguous.result.ownedTrace[3][0],0);
});
test("final census trace class final rejection preserves exact definedness before unavailable return",async()=>{
  for(const reason of [undefined,new Error("inert final")]){
    const f=await censusTraceCase([],[censusRow()],{failFinal:true,reason});
    assert.equal(f.result.errors.length,1);assert.equal(f.result.errors[0],reason);assert.equal(f.result.remaining,null);
    assert.deepEqual(f.result.ownedTrace[1],[9,4,0,0,0,0,reason!==undefined]);assert.equal(f.result.ownedCensus[1],reason===undefined?2:3);
    assert.equal(f.reads.length,1);assert.equal(f.samples.length,2);assert.equal(f.calls.filter(r=>r[0]==="kill").length,0);
    rejectCensusTrace(f,t=>{t[1]=reason===undefined?3:2;});rejectCensusTrace(f,t=>{t[1]=1;});
    rejectCensusTrace(f,t=>{t[9]=3;});
    const wire=structuredClone(f.wire),frame=structuredClone(f.frame);wire.detail[10][1]=0;frame.detail[7][1]=0;
    validateContainerDiagnostic(wire);validatePackagingDiagnostic(frame);wire.detail[10]=null;validateContainerDiagnostic(wire);
    assert.throws(()=>f.requireProcessSuccess(f.result));
  }
});
test("final census trace class earlier failures and unavailable observations do not invent final error identity",async()=>{
  for(const reason of [undefined,new Error("inert final")]){
    const childError=reason===undefined?new Error("inert earlier"):undefined;
    const f=await censusTraceCase([],[censusRow()],{hasChildError:true,childError,failFinal:true,reason});
    assert.deepEqual(f.result.errors,[childError,reason]);assert.equal(f.result.ownedTrace[1][0],8);assert.equal(f.result.ownedTrace[1][6],childError!==undefined);
    assert.equal(f.result.ownedCensus[1],reason===undefined?2:3);assert.equal(f.result.ownedTrace[2][5],0);assert.throws(()=>f.requireProcessSuccess(f.result));
    const wire=structuredClone(f.wire),frame=structuredClone(f.frame);wire.detail[7][6]=1;frame.detail[3]=1;
    assert.throws(()=>validateContainerDiagnostic(wire));assert.throws(()=>validatePackagingDiagnostic(frame));assert.throws(()=>emitContainerFailure([wire],()=>assert.fail("missing final failure emitted")));
  }
  const f=await censusTraceCase([],[censusRow()],{hasChildError:true,childError:undefined});
  assert.equal(censusDecode(f.result.ownedCensus[8][0])[1],3);assert.equal(f.result.ownedTrace[2][5],0);
  const absent=structuredClone(f.wire);absent.detail[8]=null;absent.detail[9]=null;absent.detail[10]=[1,0,7,null,0,null,0,null,[],0];validateContainerDiagnostic(absent);
});
test("final census actual producer carries V16 atomic group and original nonempty failure in both builders",async()=>{
  for(const role of ["build_a","build_b"])for(const scenario of ["live","zombie","reused","undefined","observer"]){
    let original;const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>{
      const target=args[3]===role,prior=target?[censusRow()]:[],next=target?[censusRow(12,scenario==="reused"?"124":"123",scenario==="zombie"?"Z":"S")]:[];
      const f=await censusActualProcess(prior,next,{stdout,failFinal:target&&scenario==="undefined",reason:undefined,fault:target&&scenario==="observer",supplied:{command,args,options}});if(target)original=f.result;return f.result;
    }});
    assert.ok(original);assert.equal(made.failed,true);const wire=await lifecyclePacket(made,frames=>frames,"census");assert.equal(wire.v,16);
    const prior=unpackReceiptCensusDiagnostic(wire);assert.deepEqual(prior.detail[7],original.ownedTrace);assert.deepEqual(prior.detail[8],original.ownedCode);assert.deepEqual(wire.detail[10],original.ownedCensus);
    assert.equal(prior.detail[6][1],role==="build_a"?1:2);assert.equal(prior.detail[6][7],original.remaining?.length??null);assert.equal(prior.detail[1][1],"reported_rejection");
    if(scenario==="undefined")assert.equal(original.errors[0],undefined);assert.equal(prior.detail[6][3],0);
  }
});
test("final census canonical source frames reject conflicting groups and tuples without weakening older schemas",async()=>{
  const made=await receiptActualProducer("wrangler_input",false,{diagnostics:true,ownedProcess:async(command,args,options,stdout)=>(await censusActualProcess([censusRow()],[censusRow()],{stdout,supplied:{command,args,options}})).result});
  const wire=await lifecyclePacket(made,frames=>frames,"census"),prior=unpackReceiptCensusDiagnostic(wire);validateReceiptAssociatedDiagnostic(prior);
  for(const mutate of [r=>r.detail[10][3]=0,r=>r.detail[10][2]=6,r=>r.detail[10][4]=0,r=>r.detail[10][5]=1,r=>r.detail[10][7][1]=2,r=>r.detail[10][8][0]=0,r=>r.detail[10][9]=3,r=>r.detail[10][1]=2,r=>r.detail[8]=[1,null,null,[0,0,0]],r=>r.detail[3]=4294967296]){const bad=structuredClone(wire);mutate(bad);assert.throws(()=>validateContainerDiagnostic(bad));}
  for(const mutate of [
    frames=>[...frames,frames.at(-1)],frames=>frames.map(line=>line.replace('"role":"build_a"','"role":"build_b"')),
    frames=>frames.map(line=>line.includes('"v":4')?line.replace('"v":4','"v":4,"v":4'):line),
    frames=>frames.map(line=>{if(!line.includes('"v":4'))return line;const row=JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));row.detail[7][3]=0;return"EDGE_PACKAGING_V1 "+JSON.stringify(row)+"\n";}),
  ]){const bad=await lifecyclePacket(made,mutate,"census");assert.equal(bad.detail[7],null);assert.equal(bad.detail[10],null);}
});
test("final census widest canonical packets retain every historical field and all bounded state counts",async()=>{
  const rec=createOwnedProcessLedger(), priorRows=[],priorToken=rec.censusBegin();
  for(let i=0;i<2;i++)rec.censusRow(priorToken,i+2,9,9,String(i),"S");
  rec.censusSample(priorToken,priorRows);rec.censusObserved(priorRows);rec.censusClose();rec.censusFinal();
  const finalRows=[],token=rec.censusBegin();
  for(let i=0;i<65535;i++)rec.censusRow(token,i+2,1,i+2,String(i),censusStates[i%10]);
  rec.censusSample(token,finalRows);rec.censusResult(finalRows);const census=rec.censusFinish();
  assert.equal(census[3],65535);assert.equal(census[5],65533);assert.equal(census[9],2);assert.equal(census[7].reduce((a,b)=>a+b,0),65535);
  const made=await receiptActualProducer("wrangler_input",false,{processResult:truncateActualBuilder}),base=await lifecyclePacket(made);
  base.defined=false;base.parser=[1,2,false,6,1,14,0,16383,8191];base.count="UNKNOWN";base.lifecycle=[1,255,256,14,33,1,0];base.reports=[65535,65535];
  base.builder=[1,1,3,-65535,14,127,65535,65535,Number.MAX_SAFE_INTEGER,hex,Number.MAX_SAFE_INTEGER,other];
  const trace=[1,[8,0,0,0,0,0,false],[255,255,255,255,255,62,7,5,2,3,2,63,255],[0,0,0]],code=[1,0,0];
  const historical=packReceiptAssociatedDiagnostic(base,trace,code),wire=packReceiptCensusDiagnostic(base,trace,code,census);
  assert.deepEqual(unpackReceiptCensusDiagnostic(wire),historical);assert.deepEqual(receiptView(wire),base);
  const close=packCensusCloseDiagnostic({v:3,role:"child",phase:"build_a_close",outcome:"rejected",defined:true,exit:-65535,signal:receiptBuilderSignals[14],closed:true,timedOut:true,interrupted:true,errors:65535,remaining:65535,trace,code},census);
  assert.deepEqual(validatePackagingDiagnostic(close),close);assert.ok(Buffer.byteLength(JSON.stringify(close))<=512);assert.ok(Buffer.byteLength(JSON.stringify(wire))<=512);
  const capture=await receiptCapture(made.frames),rows=[wire,...["entry","dispatch","retirement","host_runtime","cwd","context","environment","image"].map(phase=>({v:2,phase,state:"rejected",defined:false,exit:null,signal:null}))];
  createAttachProjection(capture.h.attached,{cid:hex,nonce:hex,contextHash:other},{internal:r=>rows.push(r)})(capture.h.attached.result);
  const lines=[];emitContainerFailure(rows,line=>lines.push(line));assert.equal(lines.length,10);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);
  receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
  // Beyond the original close protocol's exact count range, no saturated
  // diagnostic may substitute for that original count or grant qualification.
  rec.censusRow(token,70000,1,70000,"70000","S");const next=[];rec.censusSample(token,next);rec.censusResult(next);const saturated=rec.censusFinish();
  assert.equal(saturated[6]&1,1);assert.throws(()=>validateFinalCensus(saturated,65536,true,0,trace));
});
// Wrangler V17 exercises the original pipeline and original owned-process body;
// all filesystem/library/process bindings are inert, including both builders.
test("wrangler result actual original edge and upstream failure groups are atomic",async()=>{
  for(const role of ["edge","upstream"])for(const scenario of ["nonzero","signal","timeout","interrupt","error_undefined","sample_undefined","spawn_undefined","remaining"]){
    const made=await receiptActualProducer("wrangler",false,{wrangler:{role,scenario}});
    assert.equal(made.failed,true);assert.ok(made.reason instanceof AggregateError);assert.notEqual(made.reason.name,"ReferenceError");
    assert.equal(made.calls.filter(r=>r[0]==="wrangler").length,role==="edge"?1:2);
    const original=made.processResults.at(-1), rejected=made.rejections.find(r=>r.phase===role+"_close");
    assert.equal(rejected.reason,made.reason);assert.equal(made.builders.length,2);assert.ok(made.builders.every(b=>!b.failed));
    assert.equal(made.report.errors.length,0);
    const wire=await lifecyclePacket(made,frames=>frames,"census");assert.equal(wire.v,17,role+":"+scenario);
    const group=wire.detail[11],base=receiptView(wire);
    assert.equal(base.child[1],"reported_rejection");assert.equal(base.child[6],receiptChildPhases.indexOf(role+"_close")+1);assert.equal(base.child[8],"UNKNOWN");
    assert.equal(group[1],role==="edge"?1:2);assert.equal(group[2],3);assert.equal(group[12],3);
    assert.equal(group[3],original.code);assert.equal(receiptBuilderSignals[group[4]],original.signal);
    assert.equal(group[5]&1,Number(original.closed));assert.equal(Boolean(group[5]&2),original.timedOut);assert.equal(Boolean(group[5]&4),original.interrupted);
    assert.equal(group[6],original.errors.length);assert.equal(group[7],original.remaining?.length??null);
    for(const [key,index] of [["stdout",8],["stderr",10]]){assert.equal(group[index],original.outputSummary[key].bytes);assert.equal(Buffer.from(group[index+1],"base64url").toString("hex"),original.outputSummary[key].sha256);}
    assert.deepEqual(wire.detail.slice(7,11),[null,null,null,null]);
  }
});
test("wrangler result original success and reporting throws retain distinct qualification and undefined",async()=>{
  for(const role of ["edge","upstream"])for(const reason of [undefined,new Error("inert report")]){
    const made=await receiptActualProducer("wrangler",false,{wrangler:{role,scenario:"normal",reportFailure:true,reportReason:reason}});
    assert.equal(made.failed,true);assert.equal(made.reason,reason);assert.equal(made.rejections.find(r=>r.phase===role+"_close").reason,reason);
    const wire=await lifecyclePacket(made,frames=>frames,"census");assert.equal(wire.v,17);
    assert.equal(wire.detail[11][12],1);assert.equal(wire.detail[11][2],reason===undefined?2:3);assert.equal(wire.detail[11][3],0);assert.equal(wire.detail[11][7],0);
  }
  const success=await receiptActualProducer("wrangler",false,{wrangler:{role:"upstream",scenario:"normal"}});
  assert.equal(success.failed,false);assert.equal(success.calls.filter(r=>r[0]==="wrangler").length,2);assert.equal(success.report.errors.length,0);
  const c=await receiptCapture(success.frames),ledger=createProjectionLedger();assert.equal(c.summary(ledger)[1],"reported_complete");assert.equal(ledger.wrangler(),null);
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("export function reportWranglerProcess("),source.indexOf("export function verifyDryRun(")).replace("export ","");
  for(const primary of [undefined,new Error("inert primary")]){
    let checks=0,marks=0;const result={},report={mark(...args){marks++;assert.equal(args[0],"edge_close");assert.equal(args[1],"rejected");assert.equal(args[2],primary);assert.equal(args[3],result);assert.equal(args[4],primary===undefined?2:3);throw undefined;}};
    const run=new Function("requireProcessSuccess",body+"return reportWranglerProcess;")(value=>{checks++;assert.equal(value,result);throw primary;});
    assert.throws(()=>run(result,report,"edge_close"),error=>error instanceof AggregateError&&error.errors.length===2&&Object.is(error.errors[0],primary)&&error.errors[1]===undefined);assert.equal(checks,1);assert.equal(marks,1);
  }
});
test("wrangler result full canonical framing binding and pair ambiguity fail closed",async()=>{
  const made=await receiptActualProducer("wrangler",false,{wrangler:{role:"upstream",scenario:"remaining"}});
  const mutateRow=(frames,change)=>frames.map(line=>{const row=JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));if(row.phase==="upstream_close")change(row);return "EDGE_PACKAGING_V1 "+JSON.stringify(row)+"\n";});
  for(const mutate of [
    ...["build_a","build_b"].map(role=>f=>{
      const members=f.filter(line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length)).role===role),rest=f.filter(line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length)).role!==role);
      const close=rest.findIndex(line=>line.includes('"phase":"'+role+'_close"'));rest.splice(close+1,0,...members);return rest;
    }),
    f=>f.filter(line=>!line.includes('"phase":"upstream_close"')),
    f=>f.flatMap(line=>line.includes('"phase":"upstream_close"')?[line,line]:[line]),
    f=>f.flatMap(line=>line.includes('"phase":"upstream_launch"')?[line,line]:[line]),
    f=>mutateRow(f,r=>r.role="build_a"),f=>mutateRow(f,r=>r.detail[1]=1),f=>mutateRow(f,r=>r.detail.pop()),
    f=>mutateRow(f,r=>r.detail[9]="not-a-hash"),f=>mutateRow(f,r=>r.detail[12]=1),f=>mutateRow(f,r=>r.defined=null),
    f=>[...f,f.at(-1)],f=>[...f,"EDGE_PACKAGING_V1 {"],f=>f.map(line=>line.replace('"v":5','"v":5,"v":5')),
    f=>f.map(line=>line.replace('"v":5','"v":5\u001b')),f=>Array(257).fill(f[0]),
    f=>{const next=[...f],i=next.findIndex(x=>x.includes('"phase":"upstream_close"'));[next[i],next[i-1]]=[next[i-1],next[i]];return next;},
    f=>{const edge=f.find(x=>x.includes('"phase":"edge_close"'));return f.map(x=>x.includes('"phase":"upstream_close"')?edge:x);},
  ]){const wire=await lifecyclePacket(made,mutate,"census");assert.equal(wire.v,16);assert.equal(wire.detail[7],null);}
  for(const key of ["stdout","stderr"])for(const field of ["bytes","retainedBytes","sha256","retainedSha256","complete","truncated"]){
    const c=await receiptCapture(made.frames),s=c.h.attached.result.outputSummary[key];s[field]=field.endsWith("256")?other:field==="complete"?false:field==="truncated"?true:s[field]+1;
    const ledger=createProjectionLedger();assert.ok(["capture_mismatch","capture_unavailable"].includes(c.summary(ledger)[1]));assert.equal(ledger.wrangler(),null);
  }
  const c=await receiptCapture(made.frames);
  for(const change of [b=>b.cid="foreign",b=>b.nonce="foreign",b=>b.contextHash="foreign",b=>b.attached={result:{...c.h.attached.result}}]){const binding={...c.binding};change(binding);const ledger=createProjectionLedger();assert.equal(parseChildPackaging(c.h.attached.result,binding,c.initSummary,ledger)[1],"binding_unavailable");assert.equal(ledger.wrangler(),null);}
});
test("wrangler result preceding builder interval counterexamples close the review finding",async()=>{
  const made=await receiptActualProducer("wrangler",false,{wrangler:{role:"edge",scenario:"remaining"}});
  const source=await readFile(new URL("../scripts/edge-proof-container.mjs",import.meta.url),"utf8");
  let before=source.slice(source.indexOf("export function projectWranglerCloseGroup("),source.indexOf("export function createProjectionLedger("));
  const start=before.indexOf("  // Wrangler is reached only"),end=before.indexOf("  const owners = lifecycle.wranglers",start);assert.ok(start>0&&end>start);
  before=before.slice(0,start)+before.slice(end); // Exact reviewed pre-fix association predicate.
  const prior=new Function("validateWranglerCloseDiagnostic",before.replace("export ","")+"return projectWranglerCloseGroup;")(validateWranglerCloseDiagnostic);
  for(const role of ["build_a","build_b"]){
    const members=made.frames.filter(line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length)).role===role),frames=made.frames.filter(line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length)).role!==role);
    frames.splice(frames.findIndex(line=>line.includes('"phase":"'+role+'_close"'))+1,0,...members);
    const c=await receiptCapture(frames),ledger=createProjectionLedger(),seen={};
    for(const name of ["canonical","childLifecycle","rejection"]){const original=ledger[name];ledger[name]=value=>{seen[name]=value;return original(value);};}
    assert.equal(c.summary(ledger)[1],"reported_rejection");assert.ok(prior(seen.canonical,seen.childLifecycle,seen.rejection));assert.equal(ledger.wrangler(),null);
    const wire=await lifecyclePacket(made,()=>frames,"census");assert.equal(wire.v,16);assert.equal(wire.detail[7],null);
  }
});
test("wrangler result inconsistent original summaries and independent write failures yield unknown",async()=>{
  for(const mutate of [r=>r.outputSummary.stdout.complete=false,r=>r.outputSummary.stderr.sha256="invalid",r=>r.outputSummary.stdout.bytes=-1]){
    const made=await receiptActualProducer("wrangler",false,{wrangler:{role:"edge",scenario:"nonzero",mutate}});
    assert.equal(made.failed,true);assert.ok(made.report.errors.length);assert.ok(made.reason instanceof AggregateError);assert.equal(made.reason.errors[0].message,"edge-proof: child-not-qualified");
    const wire=await lifecyclePacket(made,frames=>frames,"census");assert.equal(wire.v,16);assert.equal(wire.detail[7],null);
  }
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("export function reportWranglerProcess("),source.indexOf("export function verifyDryRun(")).replace("export ","");
  const result=await receiptOwnedResult("/immutable/node",[],{cwd:"/task",env:{}},"inert", "nonzero",true),report=createPackagingDiagnostics("child",()=>{throw undefined;});
  const run=new Function("requireProcessSuccess",body+"return reportWranglerProcess;")(value=>{assert.equal(value,result);throw undefined;});
  let failed=false,reason;try{run(result,report,"edge_close");}catch(error){failed=true;reason=error;}
  assert.equal(failed,true);assert.equal(reason,undefined);assert.deepEqual(report.errors,[undefined]);assert.equal(report.records.length,1);assert.equal(report.records[0].defined,false);
});
test("wrangler result widest lossless packet reserves one row with no borrowed native observations",async()=>{
  const made=await receiptActualProducer("wrangler",false,{wrangler:{role:"upstream",scenario:"nonzero"}}),original=await lifecyclePacket(made,frames=>frames,"census");
  const wide=structuredClone(original);wide.detail[0]=false;wide.detail[1]=[1,2,false,3,1,1,0,1,0];wide.detail[2][1]=256;wide.detail[3]=4294967295;
  wide.detail[11]=[1,2,3,-65535,14,127,65535,65535,Number.MAX_SAFE_INTEGER,"_".repeat(42)+"8",Number.MAX_SAFE_INTEGER,"_".repeat(42)+"8",3];
  validateReceiptWranglerDiagnostic(wide);assert.ok(Buffer.byteLength(JSON.stringify(wide))<=512);
  for(const mutate of [r=>r.detail[11][12]=1,r=>r.detail[11][9]="_".repeat(43),r=>r.detail[11][1]=1,r=>r.detail[8]=[1,null,null,[1,0,0]],r=>r.detail[9]=[1,0,0],r=>r.detail[10]=[1,0,0,null,0,null,0,null,[],0],r=>r.detail[2][5]=18,r=>r.detail[2][6]=false]){const bad=structuredClone(wide);mutate(bad);assert.throws(()=>validateContainerDiagnostic(bad));}
  const packet=structuredClone(receiptPackets.at(-1));packet[packet.findIndex(r=>r.phase==="receipt")]=wide;
  for(const phase of ["dispatch","image","base","create","attach","ready","cwd","temp","environment","permit"])packet.push({v:2,phase,state:"fulfilled",defined:null,exit:null,signal:null});
  const lines=[];emitContainerFailure(packet,line=>lines.push(line));assert.equal(lines.length,10);assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf("::{")+2)).v,17);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
});
function wranglerBuilderFrames(frames, role, mutate) {
  const rows = frames.map(line=>JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length)));
  const close = rows.findIndex(row=>row.role === "child" && row.phase === role+"_close");
  assert.ok(close >= 0); assert.equal(rows[close+3].phase,"protocol_summary");
  mutate(rows,close);
  return rows.map(row=>"EDGE_PACKAGING_V1 "+JSON.stringify(row)+"\n");
}
test("wrangler result six prior summary contradictions now remain unknown",async()=>{
  const made=await receiptActualProducer("wrangler",false,{wrangler:{role:"edge",scenario:"remaining"}});
  assert.equal(made.failed,true);assert.equal(made.report.errors.length,0);assert.equal(made.builders.length,2);assert.ok(made.builders.every(b=>!b.failed));
  const source=await readFile(new URL("../scripts/edge-proof-container.mjs",import.meta.url),"utf8"),api=await receiptProjectionFactory();
  let before=source.slice(source.indexOf("export function projectWranglerCloseGroup("),source.indexOf("export function createProjectionLedger("));
  const gate=" || !reconcileSuccessfulBuilderSummary(rows,lifecycle,role)";assert.equal(before.split(gate).length,2);before=before.replace(gate,"");
  const prior=new Function("inspectBuilderCloseGroup","validateWranglerCloseDiagnostic",before.replace("export ","")+"return projectWranglerCloseGroup;")(api.inspectBuilderCloseGroup,validateWranglerCloseDiagnostic);
  let cases=0;
  for(const role of ["build_a","build_b"])for(const [key,value] of [["valid",0],["rejected",1],["complete",false]]){
    const frames=wranglerBuilderFrames(made.frames,role,(rows,close)=>{rows[close+3][key]=value;}),c=await receiptCapture(frames),ledger=createProjectionLedger(),seen={};
    for(const name of ["canonical","childLifecycle","rejection"]){const original=ledger[name];ledger[name]=value=>{seen[name]=value;return original(value);};}
    assert.equal(c.summary(ledger)[1],"reported_rejection");assert.equal(ledger.errors.length,0);assert.ok(prior(seen.canonical,seen.childLifecycle,seen.rejection));assert.equal(ledger.wrangler(),null);
    const wire=await lifecyclePacket(made,()=>frames,"census");assert.equal(wire.v,16);assert.equal(receiptView(wire).child[1],"reported_rejection");assert.equal(wire.detail[7],null);cases++;
  }
  assert.equal(cases,6);
});
test("wrangler result complete builder summary reconciliation rejects the whole contradiction class",async()=>{
  const made=await receiptActualProducer("wrangler",false,{wrangler:{role:"upstream",scenario:"nonzero"}});
  for(const role of ["build_a","build_b"]){
    const changes=[
      ...["valid","entry","final","rejected","foreign","malformed","receipts","unclassified"].flatMap(key=>[
        (rows,c)=>{rows[c+3][key]++;},
        (rows,c)=>{rows[c+3][key] = rows[c+3][key] ? rows[c+3][key]-1 : 65535;},
        (rows,c)=>{rows[c+3][key] = "1";},
      ]),
      (rows,c)=>{rows[c+3].complete=false;},(rows,c)=>{rows[c+3].complete=null;},
      (rows,c)=>{delete rows[c+3].valid;},(rows,c)=>{rows[c+3].extra=0;},
      (rows,c)=>{rows[c+3].role=role;},(rows,c)=>{rows.splice(c+3,1);},(rows,c)=>{rows.splice(c+3,0,structuredClone(rows[c+3]));},
      (rows,c)=>{[rows[c+2],rows[c+3]]=[rows[c+3],rows[c+2]];},
      (rows,c)=>{rows[c+1].complete=false;},(rows,c)=>{rows[c+2].complete=false;},
      (rows,c)=>{rows[c+1].bytes=-1;},(rows,c)=>{rows[c+2].sha256="invalid";},
      (rows,c)=>{rows[c].v===4?rows[c].detail[0]=1:rows[c].exit=1;},
      (rows,c)=>{rows[c].v===4?rows[c].detail[3]=1:rows[c].errors=1;},
      (rows,c)=>{rows[c].v===4?rows[c].detail[4]=1:rows[c].remaining=1;},
      (rows,c)=>{rows.splice(c+4,1);rows[c+3].valid--;rows[c+3].entry--;},
      (rows,c)=>{const end=rows.findIndex((r,i)=>i>c+3&&r.role==="child"&&r.phase===role+"_report");rows.splice(end-1,1);rows[c+3].valid--;rows[c+3].final--;},
      (rows,c)=>{rows[c+4].role=role==="build_a"?"build_b":"build_a";},
      (rows,c)=>{rows[c+5].outcome="rejected";rows[c+5].defined=true;rows[c+3].rejected++;},
      (rows,c)=>{const end=rows.findIndex((r,i)=>i>c+3&&r.role==="child"&&r.phase===role+"_report");rows[end].outcome="rejected";rows[end].defined=false;},
      (rows,c)=>{const end=rows.findIndex((r,i)=>i>c+3&&r.role==="child"&&r.phase===role+"_report");rows[end+2].outcome="rejected";rows[end+2].defined=true;},
    ];
    for(const mutate of changes){
      const frames=wranglerBuilderFrames(made.frames,role,mutate),capture=await receiptCapture(frames),ledger=createProjectionLedger();capture.summary(ledger);assert.equal(ledger.wrangler(),null);
      const wire=await lifecyclePacket(made,()=>frames,"census");assert.equal(wire.v,16);
      // Historical V16 may still explain its own rejected builder interval.
      // This repair withholds Wrangler facts without weakening that decoder.
    }
  }
  const foreign=wranglerBuilderFrames(made.frames,"build_a",(rows,c)=>{rows[c+3].role="foreign";});assert.equal((await lifecyclePacket(made,()=>foreign,"census")).v,16);
  const tail=[...made.frames,'EDGE_PACKAGING_V1 {'];assert.equal((await lifecyclePacket(made,()=>tail,"census")).v,16);
  const duplicateKey=made.frames.map(line=>line.includes('"phase":"protocol_summary"')?line.replace('"complete":true','"complete":true,"complete":true'):line);
  assert.equal((await lifecyclePacket(made,()=>duplicateKey,"census")).v,16);
});
// V18 uses the same original sampler/process bodies with inert dependencies.
async function wranglerObservedCase(role, prior, final, options = {}) {
  const originals=[];
  const made=await receiptActualProducer("wrangler",false,{diagnostics:true,wrangler:{role,scenario:"normal",...options.reporting,ownedProcess:async(command,args,provided,kind)=>{
    const target=kind===role;
    const f=await censusActualProcess(target?prior:[],target?final:[],{...target?options:{},stdout:"--dry-run: exiting now.\n",supplied:{command,args,options:provided}});
    originals.push({kind,...f});return f.result;
  }}});
  const original=originals.find(f=>f.kind===role);if(!original)throw made.reason;assert.ok(original);assert.equal(made.calls.filter(r=>r[0]==="wrangler").length,role==="edge"?1:2);
  return {made,original,originals};
}
test("wrangler census both original roles carry complete state history and stop groups",async()=>{
  for(const role of ["edge","upstream"])for(const [prior,next,expected] of [
    [[censusRow()],[censusRow()],[2,1,1,1,1,1,1]],
    [[censusRow()],[censusRow(12,"123","Z",3,4)],[4,1,3,4,2,2,2]],
    [[censusRow()],[censusRow(12,"124")],[2,2,1,1,0,0,0]],
    [[censusRow()],[censusRow(13,"999","R",99,98)],[1,3,3,4,0,0,0]],
  ]){
    const {made,original}=await wranglerObservedCase(role,prior,next);assert.equal(made.failed,true);
    assert.equal(original.result.code,0);assert.equal(original.result.remaining.length,1);assert.equal(original.result.observed.size,1);
    assert.equal(original.reads.length,2);assert.equal(original.samples.length,2);
    const wire=await lifecyclePacket(made,frames=>frames,"census");assert.equal(wire.v,18);
    assert.deepEqual(wire.detail.slice(8),[original.result.ownedTrace,original.result.ownedCode,original.result.ownedCensus]);
    assert.deepEqual(censusDecode(wire.detail[10][8][0]),expected);
    assert.equal(wire.detail[7][1],role==="edge"?1:2);assert.equal(wire.detail[7][12],3);
    const old=unpackReceiptObservedWranglerDiagnostic(wire);validateReceiptWranglerDiagnostic(old);assert.deepEqual(old.detail.slice(7,11),[null,null,null,null]);
    assert.throws(()=>original.requireProcessSuccess(original.result)); // live AND Z
    assert.equal(JSON.stringify(wire).includes('"pid"'),false);
  }
});
test("wrangler census held monitor final read undefined and later failure preserve original identities",async()=>{
  for(const role of ["edge","upstream"]){
    const held=await wranglerObservedCase(role,[censusRow()],[censusRow()],{held:true});
    assert.equal((await lifecyclePacket(held.made,f=>f,"census")).detail[10][2],7);
    for(const reason of [undefined,new Error("inert final")]){
      const f=await wranglerObservedCase(role,[],[censusRow()],{failFinal:true,reason});
      assert.equal(f.original.result.errors.length,1);assert.equal(f.original.result.errors[0],reason);
      assert.ok(f.made.reason instanceof AggregateError);assert.ok(f.made.reason.errors.includes(reason));
      const wire=await lifecyclePacket(f.made,r=>r,"census");assert.equal(wire.v,18);assert.equal(wire.detail[10][1],reason===undefined?2:3);assert.equal(wire.detail[8][1][0],9);
      assert.equal(wire.detail[9][1],1);assert.equal(wire.detail[9][2],14);
    }
    const later=await wranglerObservedCase(role,[censusRow()],[censusRow()],{hasChildError:true,childError:undefined,failMonitor:true,monitorReason:undefined,expectedStops:1});
    assert.deepEqual(later.original.result.errors,[undefined,undefined]);assert.deepEqual(later.original.calls.filter(r=>r[0]==="kill"),[["kill",-12,"SIGTERM"]]);
    const wire=await lifecyclePacket(later.made,r=>r,"census");assert.equal(wire.detail[8][1][0],8);assert.equal(wire.detail[8][2][5]&1,1);assert.equal(censusDecode(wire.detail[10][8][0])[1],0);
  }
});
test("wrangler census observer and reporting failures deny success independently including undefined",async()=>{
  for(const role of ["edge","upstream"]){
    // Only a monitor observation faults; the original final census is empty.
    const f=await wranglerObservedCase(role,[censusRow()],[],{fault:true});
    assert.equal(f.original.result.errors.length,0);assert.equal(f.original.result.remaining.length,0);assert.deepEqual(f.original.result.observerErrors,[undefined]);
    assert.equal(f.made.failed,true);assert.equal(f.made.reason,undefined);assert.equal(f.made.rejections.find(r=>r.phase===role+"_close").reason,undefined);
    const wire=await lifecyclePacket(f.made,r=>r,"census");assert.equal(wire.v,18);assert.equal(wire.detail[7][12],1);assert.equal(wire.detail[7][2],2);assert.deepEqual(wire.detail[8],[1,null,null,[1,1,0]]);assert.equal(wire.detail[9],null);assert.equal(wire.detail[10][3],null);
    const both=await wranglerObservedCase(role,[censusRow()],[censusRow()],{fault:true});assert.ok(both.made.reason instanceof AggregateError);assert.ok(both.made.reason.errors[0] instanceof AggregateError);assert.deepEqual(both.made.reason.errors.slice(1),[undefined,undefined]);
    await lifecyclePacket(both.made,r=>r,"census");
    const reporting=await wranglerObservedCase(role,[],[],{reporting:{reportFailure:true,reportReason:undefined}});assert.equal(reporting.made.reason,undefined);
    const reported=await lifecyclePacket(reporting.made,r=>r,"census");assert.equal(reported.detail[7][12],1);assert.equal(reported.detail[7][2],2);assert.equal(reported.detail[10][3],0);
  }
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("export function reportObservedWranglerProcess("),source.indexOf("// The qualification result is captured")).replace("export ","");
  for(const reason of [undefined,new Error("inert primary")]){
    let calls=0;const faults=[undefined,new Error("inert recorder")],result={observerErrors:faults};
    const run=new Function("requireProcessSuccess",body+"return reportObservedWranglerProcess;")(value=>{assert.equal(value,result);calls++;throw reason;});
    let failed=false,caught;try{run(result,{mark(phase,outcome,primary,value,qualification){assert.equal(phase,"edge_close");assert.equal(outcome,"rejected");assert.equal(primary,reason);assert.equal(value,result);assert.equal(qualification,reason===undefined?2:3);throw undefined;}},"edge_close");}catch(e){failed=true;caught=e;}
    assert.equal(failed,true);assert.equal(calls,1);assert.deepEqual(caught.errors,[reason,...faults,undefined]);
  }
});
test("wrangler census every original process failure stays strict without borrowing missing observations",async()=>{
  for(const role of ["edge","upstream"])for(const scenario of ["nonzero","signal","timeout","interrupt","error_undefined","sample_undefined","spawn_undefined","remaining"]){
    const made=await receiptActualProducer("wrangler",false,{diagnostics:true,wrangler:{role,scenario}});assert.equal(made.failed,true);
    const result=made.processResults.at(-1),wire=await lifecyclePacket(made,r=>r,"census");assert.equal(wire.v,18,role+scenario);
    assert.deepEqual(wire.detail.slice(8),[result.ownedTrace,result.ownedCode,result.ownedCensus]);assert.equal(wire.detail[10][3],null);
    assert.equal(wire.detail[7][12],3);assert.equal(made.calls.filter(r=>r[0]==="wrangler").length,role==="edge"?1:2);
  }
});
test("wrangler census source relationships and full canonical group reject contradictory evidence",async()=>{
  const {made}=await wranglerObservedCase("upstream",[censusRow()],[censusRow()]);
  const wire=await lifecyclePacket(made,r=>r,"census");
  for(const mutate of [r=>r.detail[8][1]=[2,4,0,0,0,0,true],r=>r.detail[9]=[1,1,2],r=>r.detail[10][2]=6,r=>r.detail[10][3]=0,r=>r.detail[10][4]=0,r=>r.detail[10][5]=1,r=>r.detail[10][7][1]=2,r=>r.detail[10][8][0]=0,r=>r.detail[7][1]=1,r=>r.detail[7][9]="_".repeat(43),r=>r.detail[7][12]=1]){
    const bad=structuredClone(wire);mutate(bad);assert.throws(()=>validateContainerDiagnostic(bad));assert.throws(()=>emitContainerFailure([bad],()=>assert.fail("contradiction emitted")));
  }
  const change=(frames,fn)=>frames.map(line=>{const r=JSON.parse(line.slice("EDGE_PACKAGING_V1 ".length));if(r.v===6&&r.phase==="upstream_close")fn(r);return"EDGE_PACKAGING_V1 "+JSON.stringify(r)+"\n";});
  for(const mutate of [
    frames=>[...frames,frames.at(-1)],frames=>[...frames,"EDGE_PACKAGING_V1 {"],
    frames=>change(frames,r=>r.detail[0][1]=1),frames=>change(frames,r=>r.detail[3][3]=0),frames=>change(frames,r=>r.detail[1][3]=[1,1,0]),
    frames=>frames.map(line=>line.includes('"v":6')?line.replace('"v":6','"v":6,"v":6'):line),
    frames=>wranglerBuilderFrames(frames,"build_a",(rows,c)=>{rows[c+3].valid=0;}),
    frames=>wranglerBuilderFrames(frames,"build_b",(rows,c)=>{rows[c+3].complete=false;}),
  ]){const bad=await lifecyclePacket(made,mutate,"census");assert.equal(bad.v,16);}
  for(const field of ["stdout","stderr"]){const capture=await receiptCapture(made.frames);capture.h.attached.result.outputSummary[field].sha256=other;const ledger=createProjectionLedger();assert.equal(capture.summary(ledger)[1],"capture_mismatch");assert.equal(ledger.wrangler(),null);}
});
test("wrangler census bounded omitted and ambiguous histories retain counts without ownership",async()=>{
  for(const rows of [[censusRow(),censusRow()],Array.from({length:513},(_,i)=>censusRow(i+2,String(i)))]){
    const {made,original}=await wranglerObservedCase("edge",[],rows);const wire=await lifecyclePacket(made,r=>r,"census");assert.equal(wire.detail[7][7],rows.length);assert.equal(wire.detail[10][5],rows.length-2);assert.equal(wire.detail[10][9],rows.length===2?0:2);assert.deepEqual(wire.detail[10],original.result.ownedCensus);
  }
});
test("wrangler census widest complete lossless envelopes keep historical decoding and atomic quotas",async()=>{
  const {made}=await wranglerObservedCase("upstream",[],[censusRow()]),wire=await lifecyclePacket(made,r=>r,"census");
  const wide=structuredClone(wire);wide.detail[0]=false;wide.detail[1]=[1,2,false,6,1,14,0,16383,8191];wide.detail[2][1]=256;wide.detail[3]=4294967295;wide.detail[4]=0;
  wide.detail[7]=[1,2,3,-65535,14,127,65535,65535,Number.MAX_SAFE_INTEGER,"_".repeat(42)+"8",Number.MAX_SAFE_INTEGER,"_".repeat(42)+"8",3];
  wide.detail[8]=[1,[8,0,0,0,0,0,false],[255,255,255,255,255,62,7,5,2,3,2,63,255],[0,0,0]];wide.detail[9]=[1,0,0];
  const rec=createOwnedProcessLedger(),prior=[],a=rec.censusBegin();for(let i=2;i<4;i++)rec.censusRow(a,i,9,9,String(i),"S");rec.censusSample(a,prior);rec.censusObserved(prior);rec.censusClose();rec.censusFinal();const rows=[],b=rec.censusBegin();for(let i=0;i<65535;i++)rec.censusRow(b,i+2,1,i+2,String(i+2),censusStates[i<60000?Math.floor(i/10000):6+Math.min(3,Math.floor((i-60000)/1383))]);rec.censusSample(b,rows);rec.censusResult(rows);wide.detail[10]=rec.censusFinish();
  validateContainerDiagnostic(wide);const priorWire=unpackReceiptObservedWranglerDiagnostic(wide);validateReceiptWranglerDiagnostic(priorWire);assert.deepEqual(priorWire.detail[11],wide.detail[7]);
  const close=validateObservedWranglerCloseDiagnostic({v:6,role:"child",phase:"upstream_close",outcome:"rejected",defined:true,detail:wide.detail.slice(7)});assert.ok(Buffer.byteLength(JSON.stringify(close))<=512);assert.ok(Buffer.byteLength(JSON.stringify(wide))<=512);
  const packet=structuredClone(receiptPackets.at(-1));packet[packet.findIndex(r=>r.phase==="receipt")]=wide;for(const phase of ["dispatch","image","base","create","attach","ready","cwd","temp","environment","permit"])packet.push({v:2,phase,state:"fulfilled",defined:null,exit:null,signal:null});const lines=[];emitContainerFailure(packet,line=>lines.push(line));assert.equal(lines.length,10);assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf("::{")+2)).v,18);assert.ok(lines.every(line=>Buffer.byteLength(line)<=768));assert.ok(Buffer.byteLength(lines.join(""))<=8192);receiptPackets.push(lines.map(line=>JSON.parse(line.slice(line.indexOf("::{")+2))));
  for(const faults of [[65535,65535,3],[65535,0,1]]){const unknown=structuredClone(wide);unknown.detail[8]=[1,null,null,faults];unknown.detail[9]=null;unknown.detail[10]=[1,1,7,null,0,null,0,null,[],3];validateContainerDiagnostic(unknown);assert.ok(Buffer.byteLength(JSON.stringify(unknown))<=512);}
});
test("wrangler census actual module imports and recorder wiring are explicit",async()=>{
  const proof=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8"),container=await readFile(new URL("../scripts/edge-proof-container.mjs",import.meta.url),"utf8");
  const tests=await readFile(new URL("./edge-proof-container.test.mjs",import.meta.url),"utf8"),testImports=/import \{([^}]+)\} from "\.\.\/scripts\/edge-proof\.mjs";/.exec(tests)[1].split(",").map(n=>n.trim());
  for(const name of ["unpackReceiptObservedWranglerDiagnostic","unpackReceiptWranglerDiagnostic","unpackReceiptCensusDiagnostic","unpackReceiptOwnedDiagnostic","validateObservedWranglerCloseDiagnostic","validateReceiptObservedWranglerDiagnostic"])assert.ok(testImports.includes(name),name);
  const imported=/import \{([^}]+)\} from "\.\/edge-proof\.mjs";/.exec(container)[1].split(",").map(n=>n.trim());
  for(const name of ["packReceiptObservedWranglerDiagnostic","validateObservedWranglerCloseDiagnostic"]){assert.ok(imported.includes(name));assert.ok(proof.includes("export function "+name+"("));}
  const pipeline=proof.slice(proof.indexOf("export async function runPackagingPipeline("),proof.indexOf("async function offlineCi("));
  assert.ok(pipeline.includes("sample: recorder ? () => privateProcesses(recorder) : privateProcesses"));
  assert.ok(pipeline.includes("(recorder ? reportObservedWranglerProcess : reportWranglerProcess)(result, report, close)"));
  assert.equal(pipeline.split("createOwnedProcessLedger()").length,3);
  assert.ok(container.includes("builderDiagnostics: true"));
});
// END attach diagnostic pure tests.

// BEGIN current/frozen ownership pure tests. No container/installer/native calls.
async function ownershipFixture(overrides = {}) {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const select = (from, to) => { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a); return source.slice(a, b).replaceAll("export ", ""); };
  const constants = select("export const harnessInputs =", "export function createInitGuardLedger(");
  const helpers = select("const own =", "export function raiseContainerFailures(") + select("// These owners are attested", "async function createBuildContext(");
  const reads = [], writes = [], calls = [], disk = new Map(), objects = new Map(), entries = new Map();
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  const oid = (type, bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])).digest("hex");
  const bindings = { Buffer, createHash, edgeProof, join, relative, resolve, isAbsolute,
    realpath: async path => overrides.realpath ? overrides.realpath(path) : path,
    lstat: async path => ({ isFile: () => overrides.special !== path }),
    readFile: async path => { reads.push(path); if (overrides.readFailure === path) throw overrides.reason; assert.ok(disk.has(path), "inert file missing"); return disk.get(path); },
    writeExclusive: async (root, path, bytes) => { assert.equal(root, "/proof/input"); assert.ok(!writes.some(row => row.path === path)); writes.push({ path, bytes }); },
  };
  const api = new Function(...Object.keys(bindings), constants + helpers + "return { harnessInputs, currentInputInventory, currentWorkspaceMembers, installInputs, observeCurrentInputs, materializeOwnedInputs, validateContextPlan };")(...Object.values(bindings));
  for (const path of new Set([...api.harnessInputs, ...api.currentInputInventory.map(row => row.path)])) {
    const bytes = await readFile(new URL("../" + path, import.meta.url));
    disk.set("/checkout/" + path, bytes); const blob = oid("blob", bytes); objects.set(blob, bytes); entries.set(path, { mode: "100644", blob });
  }
  const treeBytes = Buffer.from("inert current tree"), tree = oid("tree", treeBytes);
  const commitBytes = Buffer.from(`tree ${tree}\n\ninert current candidate\n`), commit = oid("commit", commitBytes);
  const original = (cwd, args) => {
    assert.equal(cwd, "/checkout"); calls.push(args);
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return Buffer.from(commit + "\n");
    if (key === `rev-parse ${commit}^{tree}`) return Buffer.from((overrides.wrongTree ? "0".repeat(40) : tree) + "\n");
    if (key === `cat-file commit ${commit}`) return commitBytes;
    if (key === `cat-file tree ${tree}`) return treeBytes;
    if (key === `ls-tree -rz ${commit}`) return Buffer.from([...entries].map(([path, row]) => `${row.mode} blob ${row.blob}\t${path}\0`).join(""));
    if (args[0] === "cat-file" && args[1] === "blob") { assert.ok(objects.has(args[2])); return objects.get(args[2]); }
    assert.fail("unexpected inert git call");
  };
  const frozenBlobs = new Map();
  for (const path of Object.keys(api.installInputs)) {
    let bytes = disk.get("/checkout/" + path);
    // Source-bound fixture removes exactly main143's sole workspace/importer delta.
    if (path === "pnpm-workspace.yaml") bytes = Buffer.from(bytes.toString().replace("  - packages/provider-plugin-contract\n", ""));
    if (path === "pnpm-lock.yaml") bytes = Buffer.from(bytes.toString().replace("  packages/provider-plugin-contract:\n    devDependencies:\n      typescript:\n        specifier: ^7.0.2\n        version: 7.0.2\n\n", ""));
    assert.equal(sha(bytes), api.installInputs[path]); frozenBlobs.set(path, { bytes, blob: oid("blob", bytes) });
  }
  const run = async () => {
    const observed = await api.observeCurrentInputs("/checkout", original);
    const frozen = await api.materializeOwnedInputs("/checkout", "/proof/input", observed, frozenBlobs);
    const files = [...writes.map(row => ({ path: row.path, sha256: sha(row.bytes), bytes: row.bytes.length })), ...[".git/HEAD", ".git/shallow"].map(path => ({ path, sha256: sha(edgeProof.sourceSha + "\n"), bytes: 41 }))].sort((a, b) => a.path.localeCompare(b.path, "en"));
    const plan = { version: 3, current: observed.current, frozen, harness: observed.harness, files }, contextHash = sha(JSON.stringify(plan));
    assert.equal(api.validateContextPlan(plan, contextHash), plan); return { observed, plan, contextHash };
  };
  return { api, original, reads, writes, calls, disk, objects, entries, frozenBlobs, run, sha, commit, tree };
}
test("ownership actual helpers separate current143 observations from frozen materialization", async () => {
  const f = await ownershipFixture(), { plan, contextHash } = await f.run();
  assert.equal(plan.version, 3); assert.equal(plan.current.commit, f.commit); assert.equal(plan.current.tree, f.tree);
  assert.equal(plan.current.files.length, 12); assert.equal(plan.current.files.filter(row => row.path.startsWith("packages/")).length, 8);
  assert.equal(plan.current.scope, "observed-not-installed-or-native-qualified");
  assert.equal(plan.frozen.commit, edgeProof.sourceSha); assert.equal(plan.frozen.files.length, 4);
  for (const path of ["pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    assert.notEqual(plan.current.files.find(row => row.path === path).sha256, plan.frozen.files.find(row => row.path === path).sha256);
    assert.ok(f.writes.find(row => row.path === path).bytes.equals(f.frozenBlobs.get(path).bytes));
  }
  assert.equal(new Set(f.reads).size, f.reads.length); assert.equal(f.writes.length, f.api.harnessInputs.length + 4);
  assert.ok(f.writes.every(row => !row.path.startsWith("packages/") && !row.path.includes("node_modules")));
  assert.equal(contextHash, f.sha(JSON.stringify(plan)));
});
test("ownership rejects incomplete current workspace/package inventory and Git byte drift", async () => {
  for (const path of ["packages/provider-plugin-contract/package.json", "packages/provider-plugin-contract/src/index.ts", "pnpm-workspace.yaml", "admin/package.json"]) {
    const f = await ownershipFixture(); f.entries.delete(path); await assert.rejects(f.run()); assert.equal(f.writes.length, 0);
  }
  for (const change of [f => f.entries.set("packages/provider-plugin-contract/extra.ts", f.entries.get("package.json")), f => f.disk.set("/checkout/pnpm-lock.yaml", f.frozenBlobs.get("pnpm-lock.yaml").bytes), f => f.entries.get("package.json").blob = "0".repeat(40), f => f.entries.get("package.json").mode = "120000"]) {
    const f = await ownershipFixture(); change(f); await assert.rejects(f.run()); assert.equal(f.writes.length, 0);
  }
  const f = await ownershipFixture({ wrongTree: true }); await assert.rejects(f.run(), /current-tree/); assert.equal(f.writes.length, 0);
});
test("ownership rejects filesystem substitution, checkout writes and preserves undefined reads", async () => {
  for (const options of [{ realpath: path => path === "/checkout/package.json" ? "/foreign/package.json" : path }, { special: "/checkout/package.json" }]) {
    const f = await ownershipFixture(options); await assert.rejects(f.run(), /current-regular-file/); assert.equal(f.writes.length, 0);
  }
  const f = await ownershipFixture(), observed = await f.api.observeCurrentInputs("/checkout", f.original);
  for (const target of ["/checkout", "/checkout/proof", "/proof/../checkout", "relative"]) await assert.rejects(f.api.materializeOwnedInputs("/checkout", target, observed, f.frozenBlobs), /exclusive-proof-root/);
  assert.equal(f.writes.length, 0);
  for (const reason of [undefined, new Error("inert original read")]) {
    const failed = await ownershipFixture({ readFailure: "/checkout/package.json", reason }); let rejected = false;
    try { await failed.run(); } catch (actual) { rejected = true; assert.equal(actual, reason); }
    assert.equal(rejected, true); assert.equal(failed.writes.length, 0);
  }
});
test("ownership frozen Git blobs and manifest owners cannot be swapped or forged", async () => {
  for (const mutate of [f => f.frozenBlobs.delete("package.json"), f => f.frozenBlobs.get("package.json").blob = "a".repeat(40), f => f.frozenBlobs.get("pnpm-lock.yaml").bytes = f.disk.get("/checkout/pnpm-lock.yaml")]) {
    const f = await ownershipFixture(); mutate(f); await assert.rejects(f.run(), /frozen-install-input/); assert.equal(f.writes.length, 0);
  }
  const f = await ownershipFixture(), { plan, contextHash } = await f.run();
  for (const mutate of [p => p.version = 2, p => [p.current, p.frozen] = [p.frozen, p.current], p => p.current.files.pop(), p => p.current.workspaceMembers.pop(), p => p.current.scope = "qualified", p => p.frozen.files[0].blob = "a".repeat(40), p => p.frozen.files[0].sha256 = "a".repeat(64), p => p.frozen.tree = "a".repeat(40), p => p.files.pop(), p => p.files.push({ path: "node_modules/borrowed", sha256: "a".repeat(64), bytes: 1 }), p => p.files[0].path = "../escape", p => p.harness.pop()]) {
    const forged = structuredClone(plan); mutate(forged);
    assert.throws(() => f.api.validateContextPlan(forged, f.sha(JSON.stringify(forged))));
  }
  for (const key of ["commit", "tree"]) { const forged = structuredClone(plan); forged.current[key] = "b".repeat(40); assert.throws(() => f.api.validateContextPlan(forged, contextHash), /context-identity/); }
});
test("ownership consumer uses whole schema hash and original builder frozen equality remains strict", async () => {
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("validateContextPlan(inputPlan, contextHash);"));
  assert.ok(source.includes("const contextHash = hash(JSON.stringify(inputPlan)); validateContextPlan(inputPlan, contextHash);"));
  assert.ok(source.includes('writeExclusive(context, "Dockerfile", observed.bytes.get("config/edge-proof/Dockerfile"))'));
  const builder = await readFile(new URL("../scripts/edge-proof-build.mjs", import.meta.url), "utf8");
  const loop = builder.slice(builder.indexOf('  for (const name of ["package.json"'), builder.indexOf('  for (const entry of files)', builder.indexOf('  for (const name of ["package.json"')));
  assert.ok(loop.includes(".equals("));
  const f = await ownershipFixture();
  // Execute the original input-equality loop only; all reads and Git rows are inert.
  const paths = Object.keys(f.api.installInputs), files = paths.map(path => ({ path, bytes: f.frozenBlobs.get(path).bytes }));
  const run = new Function("files", "cwd", "readFile", "join", "check", `return (async()=>{${loop}})();`);
  const check = (value, message) => assert.ok(value, message);
  await assert.rejects(run(files, "/checkout", async path => f.disk.get(path), join, check));
  await run(files, "/frozen", async path => f.frozenBlobs.get(path.slice(8)).bytes, join, check);
});
test("ownership actual image consumer rejects altered context before enumeration or native work", async () => {
  const f = await ownershipFixture(), { plan, contextHash } = await f.run();
  const source = await readFile(new URL("../scripts/edge-proof-container.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function qualifyImageInputs("), end = source.indexOf('  prepare?.enter("context_enumeration");', start);
  assert.ok(start >= 0 && end > start);
  let reads = 0; const stages = [], process = { platform: "linux", arch: "x64", version: "v24.22.1", versions: { modules: "137" } };
  const make = input => new Function("process", "containerContract", "readFile", "join", "check", "validateContextPlan", source.slice(start, end) + "return inputPlan; } return qualifyImageInputs;")(process, { input: "/image-input" }, async path => { assert.equal(path, "/image-input/.edge-context.json"); reads++; return JSON.stringify(input); }, join, (ok, code) => assert.ok(ok, code), f.api.validateContextPlan);
  assert.deepEqual(await make(plan)(contextHash, { enter: stage => stages.push(stage) }), plan);
  assert.deepEqual(stages, ["runtime", "context_read", "context_identity"]); assert.equal(reads, 1);
  const forged = structuredClone(plan); forged.version = 2;
  await assert.rejects(make(forged)(f.sha(JSON.stringify(forged))), /context-identity/);
});
// END current/frozen ownership pure tests.

// BEGIN explicit reaper inert tests. Only these callbacks are selected locally.
function reaperSocket() {
  const socket = new EventEmitter(); socket.writes = []; socket.destroyed = false;
  socket.write = (bytes, callback) => { socket.writes.push(Buffer.from(bytes)); callback(); return true; };
  socket.end = () => { socket.emit("end"); socket.emit("close"); };
  socket.destroy = () => { socket.destroyed = true; socket.emit("close"); };
  return socket;
}
const reaperBinding = {pid:2, nonce:"a".repeat(64),contextHash:"b".repeat(64)};
const originalOutcome = promise => promise.then(value=>({failed:false,value}),reason=>({failed:true,reason}));
async function censusWitnessFixture(ErrorConstructor = Error) {
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("const censusControls ="),source.indexOf("// Original operations remain authoritative;"));
  const declarations=["refuse","ownedNote","ownedLeaf"].map(name=>{const match=source.match(new RegExp("^const "+name+" ?=.*$","m"));assert.ok(match,name);return match[0];}).join("\n");
  const f={extra:[],names:null,readFailure:null,reads:[],lists:0};
  const base=[{pid:1,parent:0,start:"10",state:"S"},{pid:2,parent:1,start:"20",state:"S"}];
  const text=row=>`${row.pid} (inert) ${[row.state,String(row.parent),String(row.pid),...Array(16).fill("0"),row.start].join(" ")}`;
  const read=async path=>{
    f.reads.push(path);const pid=Number(path.split("/")[2]);
    if(f.readFailure&&f.readFailure.pid===pid){const failure=f.readFailure;f.readFailure=null;throw failure.reason;}
    return text([...base,...f.extra].find(row=>row.pid===pid));
  };
  const list=async path=>{assert.equal(path,"/proc");f.lists++;return f.names??[...base,...f.extra].map(row=>String(row.pid));};
  f.api=new Function("process","readdir","readFile","Error",declarations+"\n"+body.replaceAll("export ","")+"\nreturn {bindCensusControls,classifyCensusControl,privateProcesses,createCensusComparisonWitness};")({platform:"linux",pid:2,ppid:1},list,read,ErrorConstructor);
  f.controls=f.api.bindCensusControls({pid:1,parent:0,start:"10"},{pid:2,parent:1,start:"20"});return f;
}
const reaperTick = async () => { for(let i=0;i<8;i++)await Promise.resolve(); };
function reaperReply(socket, index = socket.writes.length - 1, split = 80) {
  const reply=Buffer.from(socket.writes[index]);reply[4]|=128;
  socket.emit("data",reply.subarray(0,split));if(split<80)socket.emit("data",reply.subarray(split));
}
test("reaper inert actual RPC joins exact partial ACK and FINISH before close", async () => {
  const socket=reaperSocket(), rpc=createReaperClient(socket,reaperBinding);
  let done=false;const start=rpc.start().then(()=>{done=true;});await reaperTick();assert.equal(done,false);
  assert.equal(socket.writes[0].length,80);reaperReply(socket,0,3);await start;
  const drain=rpc.drain();await reaperTick();assert.equal(socket.writes[1][4],2);assert.equal(socket.writes[1].readUInt32BE(8),2);
  reaperReply(socket,1,79);await drain;
  const finish=rpc.finish();await reaperTick();assert.equal(socket.writes[2][4],3);reaperReply(socket,2);await finish;
  assert.deepEqual(rpc.errors,[]);
});
test("reaper inert actual RPC denies foreign replay malformed overflow and held ACK", async () => {
  for(const mutate of [b=>b[4]=130,b=>b[5]=1,b=>b[8]^=1,b=>b[15]^=1,b=>b[16]^=1,b=>b[48]^=1]){
    const socket=reaperSocket(),rpc=createReaperClient(socket,reaperBinding),outcome=originalOutcome(rpc.start());
    const reply=reaperFrame(129,1,reaperBinding);mutate(reply);socket.emit("data",reply);assert.equal((await outcome).failed,true);await originalOutcome(rpc.abort());
  }
  const socket=reaperSocket(),rpc=createReaperClient(socket,reaperBinding);const start=rpc.start();reaperReply(socket);await start;
  let settled=false;const held=originalOutcome(rpc.drain()).then(value=>{settled=true;return value;});await reaperTick();assert.equal(settled,false);
  socket.emit("data",Buffer.alloc(81));assert.equal((await held).failed,true);
  const ignored=originalOutcome(rpc.drain());assert.equal((await ignored).failed,true);await originalOutcome(rpc.abort());
});
test("reaper inert actual RPC retains undefined write event install and close failures", async () => {
  for(const kind of ["write","event","install"]){
    const socket=reaperSocket();if(kind==="write")socket.write=()=>{throw undefined;};
    if(kind==="install"){const on=socket.on;socket.on=function(event,fn){on.call(this,event,fn);if(event==="data")throw undefined;return this;};}
    const rpc=createReaperClient(socket,reaperBinding),outcome=originalOutcome(rpc.start());if(kind==="event")socket.emit("error",undefined);
    const value=await outcome;assert.equal(value.failed,true);assert.equal(value.reason,undefined);assert.equal(rpc.errors[0],undefined);await originalOutcome(rpc.abort());
  }
  const socket=reaperSocket(),rpc=createReaperClient(socket,reaperBinding),pending=originalOutcome(rpc.start());socket.emit("close");assert.equal((await pending).failed,true);
});
test("reaper inert control exclusion rejects PID reuse missing authority live lookalikes and Z", () => {
  const controls=bindCensusControls({pid:1,parent:0,start:"10"},{pid:2,parent:1,start:"20"});
  assert.equal(classifyCensusControl({pid:1,parent:0,start:"10",state:"S"},controls),"reaper");
  assert.equal(classifyCensusControl({pid:2,parent:1,start:"20",state:"S"},controls),"coordinator");
  for(const state of ["R","S","Z"])assert.equal(classifyCensusControl({pid:3,parent:1,start:"20",state},controls),null);
  for(const row of [{pid:2,parent:1,start:"21",state:"S"},{pid:2,parent:3,start:"20",state:"S"},{pid:1,parent:0,start:"10",state:"Z"}])assert.throws(()=>classifyCensusControl(row,controls));
  assert.throws(()=>classifyCensusControl({pid:1,parent:0,start:"10",state:"S"},{...controls}));
});
test("reaper inert actual pair validator binds both namespace views and exact invocation", () => {
  const identity={uid:[501,501,501,501],gid:[20,20,20,20],groups:[]};
  const status=pid=>`Uid:\t501\t501\t501\t501\nGid:\t20\t20\t20\t20\nGroups:\t\nNSpid:\t${pid}\nCapInh:\t0\nCapPrm:\t0\nCapEff:\t0\nCapBnd:\t0\nCapAmb:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\n`;
  const command=[containerContract.node,"/opt/edge-input/scripts/edge-proof.mjs","container-init",reaperBinding.nonce,reaperBinding.contextHash,"501","20"];
  const namespaces=Object.fromEntries(["pid","mnt","net","user","cgroup"].map((name,i)=>[name,`${name}:[${i+1}]`]));
  const reaper={pid:1,parent:0,start:"10",status:status(1),exe:containerContract.reaper,namespaces,cgroup:"0::/\n",command:Buffer.from([containerContract.reaper,...command].join("\0")+"\0")};
  const coordinator={pid:2,parent:1,start:"20",status:status(2),exe:containerContract.node,namespaces,cgroup:"0::/\n",command:Buffer.from(command.join("\0")+"\0")};
  const expected={identity,...reaperBinding};assert.equal(validateControlPair(reaper,coordinator,expected).coordinator.pid,2);
  for(const change of [row=>row.parent=3,row=>row.exe="/wrong",row=>row.status=status(3),row=>row.namespaces={...namespaces,pid:"pid:[99]"},row=>row.cgroup="0::/foreign\n",row=>row.command=Buffer.from("foreign")]){
    const bad={...coordinator};change(bad);assert.throws(()=>validateControlPair(reaper,bad,expected));
  }
  const hostReaper={...reaper,pid:100,parent:90,status:status("100\t1")},hostCoordinator={...coordinator,pid:101,parent:100,status:status("101\t2")};
  assert.equal(validateControlPair(hostReaper,hostCoordinator,{...expected,host:true}).coordinator.pid,2);
  assert.throws(()=>validateControlPair(hostReaper,hostCoordinator,expected));
});
async function reaperOwnedFactory(sample, beforeFinal) {
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("export async function runOwnedProcess("),source.indexOf("export function requireProcessSuccess("));
  assert.ok(body.includes("await beforeFinal()"));
  const child=new EventEmitter();child.pid=42;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const signals=new EventEmitter(),ticks=[],calls=[];
  const bindings={createHash,process:{kill:(...args)=>calls.push(args)},spawn:()=>child,setTimeout:fn=>{ticks.push(fn);return fn;},setInterval:fn=>{calls.monitor=fn;return fn;},clearTimeout:()=>{},clearInterval:()=>{},ownedNote:()=>{},ownedArgument:(_r,_why,_sig,value)=>value,ownedValue:(_r,_m,_v,value)=>value,ownedCondition:(_r,value)=>value,refuse:code=>{throw new Error(code);}};
  const run=new Function(...Object.keys(bindings),body.replace("export ","")+"return runOwnedProcess;")(...Object.values(bindings));
  const result=run("inert",[],{sample,beforeFinal,signalSource:signals});return{child,result,ticks,calls};
}
test("reaper inert original close monitor drain census ordering and undefined failure progress", async () => {
  const order=[];let release;
  const f=await reaperOwnedFactory(async()=>{order.push("sample");return[];},()=>new Promise(resolve=>{order.push("drain");release=resolve;}));
  f.child.emit("close",0,null);await reaperTick();assert.deepEqual(order,["drain"]);release();const value=await f.result;assert.deepEqual(order,["drain","sample"]);assert.equal(value.closed,true);
  const g=await reaperOwnedFactory(async()=>{order.push("failure-census");return[];},()=>{throw undefined;});g.child.emit("close",0,null);const failed=await g.result;assert.equal(failed.errors.length,1);assert.equal(failed.errors[0],undefined);assert.equal(order.at(-1),"failure-census");
  let releaseMonitor, samples=0, drained=false;
  const h=await reaperOwnedFactory(()=>++samples===1?new Promise(resolve=>{releaseMonitor=resolve;}):Promise.resolve([]),()=>{drained=true;});
  h.calls.monitor();h.child.emit("close",0,null);await reaperTick();assert.equal(drained,false);releaseMonitor([]);await reaperTick();h.ticks.at(-1)();await h.result;assert.equal(drained,true);assert.equal(samples,2);
});
test("reaper inert actual census requires both exact controls and retains every workload state", async () => {
  const source=await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("const censusControls ="),source.indexOf("// Original operations remain authoritative;"));
  const text=(pid,parent,start,state)=>`${pid} (inert) ${[state,String(parent),String(pid),...Array(16).fill("0"),start].join(" ")}`;
  let rows={"1":text(1,0,"10","S"),"2":text(2,1,"20","S"),"3":text(3,1,"30","Z")};
  const bindings={process:{platform:"linux",pid:2,ppid:1},readdir:async()=>Object.keys(rows),readFile:async path=>rows[path.split("/")[2]],ownedNote:()=>{},ownedLeaf:(_r,_id,value)=>value,refuse:code=>{throw new Error(code);}};
  const api=new Function(...Object.keys(bindings),body.replaceAll("export ","")+"return{bindCensusControls,privateProcesses};")(...Object.values(bindings));
  const controls=api.bindCensusControls({pid:1,parent:0,start:"10"},{pid:2,parent:1,start:"20"});
  const found=await api.privateProcesses(undefined,controls);assert.equal(found.length,1);assert.equal(found[0].state,"Z");
  delete rows["1"];await assert.rejects(api.privateProcesses(undefined,controls),/missing-census-control/);
  rows["1"]=text(1,0,"11","S");await assert.rejects(api.privateProcesses(undefined,controls),/census-control-drift/);
});
test("reaper inert ELF admission rejects foreign ABI and malformed interpreter", () => {
  const elf=Buffer.alloc(256);Buffer.from([127,69,76,70,2,1,1]).copy(elf);elf.writeUInt16LE(3,16);elf.writeUInt16LE(62,18);elf.writeUInt32LE(1,20);elf.writeBigUInt64LE(64n,32);elf.writeUInt16LE(56,54);elf.writeUInt16LE(1,56);elf.writeUInt32LE(3,64);elf.writeBigUInt64LE(128n,72);
  const path=Buffer.from("/lib64/ld-linux-x86-64.so.2\0");elf.writeBigUInt64LE(BigInt(path.length),96);path.copy(elf,128);assert.equal(validateReaperElf(elf),"/lib64/ld-linux-x86-64.so.2");
  for(const change of [b=>b[4]=1,b=>b[18]=183,b=>b.writeBigUInt64LE(9999n,32),b=>b[128]=0]){const bad=Buffer.from(elf);change(bad);assert.throws(()=>validateReaperElf(bad));}
});
test("reaper inert source binds real hosted fixtures and original module imports", async () => {
  const [container,proof,c,docker]=await Promise.all(["scripts/edge-proof-container.mjs","scripts/edge-proof.mjs","config/edge-proof/reaper.c","config/edge-proof/Dockerfile"].map(path=>readFile(new URL("../"+path,import.meta.url),"utf8")));
  assert.ok(container.includes('import { Socket } from "node:net"'));
  assert.ok(container.includes('import { bindCensusControls, privateProcesses, createCensusComparisonWitness } from "./edge-proof.mjs"'));
  assert.ok(proof.includes('"container-reaper-probe"'));
  assert.ok(container.includes('await hostedReaperFixtures(args, rpc, controls)'));
  for(const literal of ['waitpid(-1, &value, WNOHANG)','SCM_CREDENTIALS','MSG_CTRUNC | MSG_TRUNC','SO_PASSCRED','pselect(','orphan_fixture() || credential_fixture()','--fixture-hold','--check-fd'])assert.ok(c.includes(literal),literal);
  assert.ok(c.includes('drain(intermediate, &exited, &status) != 0'));
  assert.ok(docker.includes('ENTRYPOINT ["/opt/edge-reaper/reaper", "/usr/local/bin/node"'));
  assert.ok(!c.includes('sleep('));assert.ok(!c.includes('SIG_IGN'));assert.ok(!c.includes('SA_NOCLDWAIT'));
});
test("reaper inert shutdown joins delayed original CLOSE and retains late independent undefined", async () => {
  for (const destroyThrows of [false,true]) {
    const socket=reaperSocket(), first=new Error("original"), late=undefined; let destroys=0;
    socket.destroy=()=>{destroys++;if(destroyThrows)throw undefined;};
    const rpc=createReaperClient(socket,reaperBinding), start=originalOutcome(rpc.start()); socket.emit("error",first);assert.equal((await start).reason,first);
    const finish=rpc.finish();assert.equal(rpc.finish(),finish);assert.equal(rpc.abort(),finish);
    let settled=false;const observed=originalOutcome(finish).then(value=>{settled=true;return value;});await reaperTick();assert.equal(settled,false);assert.equal(destroys,1);
    socket.emit("error",late);await reaperTick();assert.equal(settled,false);socket.emit("close");
    const outcome=await observed;assert.equal(outcome.failed,true);assert.equal(outcome.reason.errors[0],first);
    assert.equal(outcome.reason.errors.filter(value=>value===undefined).length,destroyThrows?2:1);
    const count=rpc.errors.length;socket.emit("close");assert.equal(rpc.errors.length,count);assert.equal(destroys,1);
  }
});
test("reaper inert abort and successful FINISH share one original delayed close obligation", async () => {
  const socket=reaperSocket();let end=0,destroy=0;socket.end=()=>{end++;};socket.destroy=()=>{destroy++;};
  const rpc=createReaperClient(socket,reaperBinding),start=rpc.start();reaperReply(socket);await start;
  const finish=rpc.finish();await reaperTick();reaperReply(socket);await reaperTick();assert.equal(end,1);
  let settled=false;void finish.then(()=>{settled=true;});await reaperTick();assert.equal(settled,false);assert.equal(rpc.abort(),finish);
  socket.emit("end");socket.emit("close");await finish;assert.equal(destroy,0);
  const other=reaperSocket();other.destroy=()=>{throw undefined;};const failed=createReaperClient(other,reaperBinding);
  const abort=originalOutcome(failed.abort());let done=false;void abort.then(()=>{done=true;});await reaperTick();assert.equal(done,false);
  other.emit("error",undefined);other.emit("close");const outcome=await abort;assert.equal(outcome.reason.errors[0],undefined);assert.equal(outcome.reason.errors[1],undefined);
});
test("reaper inert shutdown preserves undefined primary and nested error identity without flattening", async () => {
  const socket=reaperSocket();socket.destroy=()=>{};
  const rpc=createReaperClient(socket,reaperBinding),start=originalOutcome(rpc.start());socket.emit("error",undefined);
  const original=await start;assert.equal(original.failed,true);assert.equal(original.reason,undefined);
  const result=originalOutcome(rpc.finish());await reaperTick();const late=new AggregateError([undefined],"independent");socket.emit("error",late);socket.emit("close");
  const outcome=await result;assert.equal(outcome.reason.errors[0],undefined);assert.equal(outcome.reason.errors[1],late);assert.equal(outcome.reason.errors[1].errors[0],undefined);
});
function terminalFixture({kind=1,value=0,faults=0,finished=1,sequence=2}={}) {
  const hex32=value=>value.toString(16).padStart(8,"0");
  const frame=`EDT1:${reaperBinding.nonce}:${reaperBinding.contextHash}:00000002:${hex32(sequence)}:${kind}:${hex32(value)}:${hex32(faults)}:${finished}:1\n`;
  const result={...processResult(),stdout:"original stdout",stderr:frame,supervisor:[true,true,false,false,true,true],outputSummary:{}};
  const digest=text=>createHash("sha256").update(text).digest("hex");
  for(const name of ["stdout","stderr"])result.outputSummary[name]={complete:true,truncated:false,bytes:Buffer.byteLength(result[name]),retainedBytes:Buffer.byteLength(result[name]),sha256:digest(result[name]),retainedSha256:digest(result[name])};
  const attached={result};const binding={attached,cid:"c".repeat(64),...reaperBinding,sourceHash:"d".repeat(64),controls:{result:{reaper:{pid:1},coordinator:{pid:2}}}};
  return{result,attached,binding};
}
test("reaper inert private terminal independently retains early42 signal FINISH42 and protocol fault", async () => {
  for(const values of [{value:42,faults:8,finished:0,sequence:0},{kind:2,value:15,faults:8,finished:0,sequence:1},{value:42},{value:42,faults:128}]) {
    const f=terminalFixture(values),retained=[];const retain=createReaperTerminalRetention(f.attached,()=>f.binding,async value=>retained.push(value));
    const first=retain(f.result);assert.equal(retain(f.result),first);assert.equal((await originalOutcome(first)).failed,true);
    assert.equal(retained.length,1);assert.equal(retained[0].terminal.coordinator.value,values.value);assert.equal(retained[0].terminal.supervisorFaults,values.faults??0);
    assert.equal(retained[0].terminal.coordinator.kind,values.kind===2?"signal":"exit");
    assert.ok(Buffer.byteLength(f.result.stderr)<256);
  }
  const f=terminalFixture(),retained=[];const value=await createReaperTerminalRetention(f.attached,()=>f.binding,async row=>retained.push(row))(f.result);
  requireReaperTerminal(value);assert.equal(retained.length,1);
});
test("reaper inert terminal rejects shared stdout foreign truncated conflicting or unbound channel", async () => {
  for(const mutate of [f=>f.result.stderr+="extra",f=>f.result.stderr="",f=>f.result.stderr=f.result.stderr.repeat(2),f=>f.binding.cid="wrong",f=>f.binding.attached={result:{}},f=>f.binding.controls.result.coordinator.pid=3,f=>f.result.supervisor[4]=false,f=>f.result.outputSummary.stdout.sha256="a".repeat(64),f=>f.result.outputSummary.stderr.truncated=true,f=>f.result.outputSummary.stderr.bytes++,f=>f.binding.contextHash="e".repeat(64)]){
    const f=terminalFixture();mutate(f);assert.throws(()=>parseReaperTerminal(f.result,f.binding));
  }
  const f=terminalFixture(),sent=[];f.result.stderr="";
  const outcome=await originalOutcome(createReaperTerminalRetention(f.attached,()=>f.binding,async row=>{sent.push(row);throw undefined;})(f.result));
  assert.equal(outcome.failed,true);assert.equal(outcome.reason.errors.length,2);assert.equal(outcome.reason.errors[1],undefined);assert.equal(sent[0].terminal,null);
  const g=terminalFixture();const failed=await originalOutcome(createReaperTerminalRetention(g.attached,()=>g.binding,()=>{throw undefined;})(g.result));assert.equal(failed.failed,true);assert.equal(failed.reason,undefined);
});
test("reaper inert actual hosted matrix uses real-bound operations in order and rejects both controls", async () => {
  const census=await censusWitnessFixture(), pair=census.controls, args=[reaperBinding.nonce,reaperBinding.contextHash,"501","20"];
  const seen=[],snapshots=[];let spawned,rows=[],closeOriginal;
  const actualRequire= new Function((await readFile(new URL("../scripts/edge-proof.mjs",import.meta.url),"utf8")).match(/export function requireProcessSuccess\(result\) \{[\s\S]*?\n}/)[0].replace("export ","")+"return requireProcessSuccess;")();
  const ops={
    readControl:async pid=>{seen.push(["read",pid]);return{...pair[pid===1?"reaper":"coordinator"],exe:pid===1?containerContract.reaper:containerContract.node};},
    validateControlPair:(a,b)=>{seen.push(["pair",a.exe,b.exe]);assert.notEqual(a.exe,"/invalid-control");assert.notEqual(b.exe,"/invalid-control");return pair;},
    bindCensusControls:census.api.bindCensusControls, createCensusComparisonWitness:census.api.createCensusComparisonWitness,
    privateProcesses:async(recorder,token,witness)=>{seen.push(["sample",token.reaper.start,token.coordinator.start]);census.extra=rows;return census.api.privateProcesses(recorder,token,witness);},
    requireProcessSuccess:result=>{snapshots.push(result.remaining);return actualRequire(result);},
    spawn:(command,argv,options)=>{
      seen.push(["spawn",command,argv]);assert.deepEqual(options.stdio,["pipe","pipe","pipe"]);
      const child=new EventEmitter();child.pid=3;child.stdout=new EventEmitter();child.stdin=new EventEmitter();
      child.stdin.write=(byte,callback)=>{seen.push(["write",byte]);callback();if(byte==="L"){rows[0].state="Z";queueMicrotask(()=>child.stdout.emit("data",Buffer.from("ZOMBIE:4\n")));}else{rows=[];closeOriginal(processResult());}};
      child.stdin.end=()=>{};child.stdin.destroy=()=>{};spawned=child;return child;
    },
    runOwnedProcess:async(command,argv,options)=>{
      assert.deepEqual(argv,["--fixture-census"]);const complete=new Promise(resolve=>{closeOriginal=resolve;});options.spawnProcess(command,argv,{});
      rows=[{pid:4,parent:3,start:"40",state:"S"}];queueMicrotask(()=>spawned.stdout.emit("data",Buffer.from("LIVE:4\n")));
      const result=await complete;await options.beforeFinal();result.remaining=await options.sample();return result;
    },
  };
  await hostedCensusMatrix(args,{drain:async()=>seen.push(["drain"])},pair,ops);
  assert.equal(seen.filter(row=>row[0]==="spawn").length,1);assert.equal(seen.filter(row=>row[0]==="pair").length,3);
  assert.equal(seen.filter(row=>row[0]==="sample"&&(row[1]!=="10"||row[2]!=="20")).length,2);
  assert.deepEqual(snapshots.map(value=>value.map(row=>row.state)),[[],["S"],["Z"]]);
  assert.ok(seen.findIndex(row=>row[0]==="drain")>seen.findIndex(row=>row[0]==="write"&&row[1]==="Z"));
});
test("reaper inert terminal source custody and real native fixture entry cannot share product RPC", async () => {
  const [c,container]=await Promise.all(["config/edge-proof/reaper.c","scripts/edge-proof-container.mjs"].map(path=>readFile(new URL("../"+path,import.meta.url),"utf8")));
  const child=c.slice(c.indexOf("if (coordinator == 0)"),c.indexOf("close(pair[1]); int fd"));
  assert.ok(child.indexOf("dup2(STDOUT_FILENO, STDERR_FILENO)")<child.indexOf("execv("));
  const exit=c.slice(c.indexOf("if (exited && empty == 1"),c.indexOf("if (fault) {",c.indexOf("if (exited && empty == 1")));
  assert.ok(exit.indexOf("terminal(argv[4]")<exit.indexOf("return WEXITSTATUS(status)"));assert.ok(exit.includes("next - 1, status, (unsigned)fault"));
  assert.ok(c.includes('argc == 2 && !strcmp(argv[1], "--fixture-census")'));
  const fixture=c.slice(c.indexOf("static int census_fixture"),c.indexOf("static int orphan_fixture"));
  assert.ok(fixture.includes("getpid() == 1"));assert.ok(fixture.includes("WEXITED | WNOWAIT"));assert.ok(fixture.includes("waitpid(child, &status, 0)"));assert.ok(!fixture.includes("HELLO"));
  assert.ok(container.includes('await terminalRetention(attachResult)'));assert.ok(container.includes('await terminalRetention(outcome.value)'));
  assert.ok(!container.includes('failures.push(error); rpc.abort()'));
  assert.ok(container.includes('flag:"wx",mode:0o600'));
});
test("reaper inert hosted matrix cannot accept bypassed control negatives or hide undefined reads", async () => {
  const census=await censusWitnessFixture(), pair=census.controls,args=[reaperBinding.nonce,reaperBinding.contextHash,"501","20"];
  for(const bypass of ["admission","census","read"]){
    let spawns=0;
    const ops={readControl:async pid=>{if(bypass==="read")throw undefined;return{...pair[pid===1?"reaper":"coordinator"],exe:pid===1?containerContract.reaper:containerContract.node};},
      validateControlPair:(a,b)=>{if(bypass!=="admission"&&(a.exe==="/invalid-control"||b.exe==="/invalid-control"))throw undefined;return pair;},
      bindCensusControls:census.api.bindCensusControls,createCensusComparisonWitness:census.api.createCensusComparisonWitness,privateProcesses:async()=>[],runOwnedProcess:()=>{spawns++;throw new Error("must not launch");}};
    const outcome=await originalOutcome(hostedCensusMatrix(args,{},pair,ops));assert.equal(outcome.failed,true);assert.equal(spawns,0);
    if(bypass==="read")assert.equal(outcome.reason,undefined);
  }
});
test("reaper inert END event plus independent throw is retained through delayed CLOSE", async () => {
  for(const eventUndefined of [false,true])for(const throwUndefined of [false,true])for(const destroyThrows of [false,true]){
    const socket=reaperSocket(),event=eventUndefined?undefined:new Error("event"),thrown=throwUndefined?undefined:new AggregateError([undefined],"end");
    let ends=0,destroys=0;socket.end=()=>{ends++;socket.emit("error",event);throw thrown;};socket.destroy=()=>{destroys++;if(destroyThrows)throw undefined;};
    const rpc=createReaperClient(socket,reaperBinding),start=rpc.start();reaperReply(socket);await start;
    const finish=rpc.finish();assert.equal(rpc.finish(),finish);const outcome=originalOutcome(finish);await reaperTick();reaperReply(socket);await reaperTick();
    let settled=false;void outcome.then(()=>{settled=true;});await reaperTick();assert.equal(settled,false);assert.equal(ends,1);assert.equal(destroys,1);
    socket.emit("close");const result=await outcome;assert.equal(result.failed,true);assert.equal(result.reason.errors[0],event);assert.equal(result.reason.errors[1],thrown);
    assert.equal(result.reason.errors.length,destroyThrows?3:2);if(destroyThrows)assert.equal(result.reason.errors[2],undefined);
  }
});
test("reaper inert census witness accepts only the actual intended start comparison and original failure", async () => {
  for(const role of ["reaper","coordinator"]){
    const f=await censusWitnessFixture(),wrong={...f.controls,[role]:{...f.controls[role],start:"99"}},token=f.api.bindCensusControls(wrong.reaper,wrong.coordinator);
    let observed=0;const witness=f.api.createCensusComparisonWitness(token,role,()=>{observed++;});
    const result=await originalOutcome(f.api.privateProcesses(undefined,token,witness.recorder));assert.equal(result.failed,true);assert.equal(observed,1);
    witness.requireRejected(result.failed,result.reason);assert.equal(f.lists,1);assert.deepEqual(f.reads,role==="reaper"?["/proc/1/stat"]:["/proc/1/stat","/proc/2/stat"]);
    const repeated=await originalOutcome(Promise.resolve().then(()=>witness.requireRejected(true,result.reason)));assert.equal(repeated.failed,true);assert.equal(repeated.reason,result.reason);
  }
  const f=await censusWitnessFixture(function(){throw undefined;}),token=f.api.bindCensusControls({...f.controls.reaper,start:"99"},f.controls.coordinator),witness=f.api.createCensusComparisonWitness(token,"reaper");
  const result=await originalOutcome(f.api.privateProcesses(undefined,token,witness.recorder));assert.equal(result.failed,true);assert.equal(result.reason,undefined);witness.requireRejected(true,undefined);
  const absent=f.api.createCensusComparisonWitness(token,"reaper"),unreached=await originalOutcome(Promise.resolve().then(()=>absent.requireRejected(true,undefined)));assert.equal(unreached.failed,true);assert.equal(unreached.reason,undefined);
});
test("reaper inert census witness propagates read undefined and missing-control faults despite later success", async () => {
  for(const role of ["reaper","coordinator"])for(const kind of ["read","undefined","missing"]){
    const f=await censusWitnessFixture(),wrong={...f.controls,[role]:{...f.controls[role],start:"99"}},token=f.api.bindCensusControls(wrong.reaper,wrong.coordinator),witness=f.api.createCensusComparisonWitness(token,role);
    const original=kind==="undefined"?undefined:new Error("read");
    if(kind==="missing")f.names=role==="reaper"?["2"]:["1"];else f.readFailure={pid:1,reason:original};
    const result=await originalOutcome(f.api.privateProcesses(undefined,token,witness.recorder));assert.equal(result.failed,true);if(kind!=="missing")assert.equal(result.reason,original);
    const rejected=await originalOutcome(Promise.resolve().then(()=>witness.requireRejected(true,result.reason)));assert.equal(rejected.failed,true);assert.equal(rejected.reason,result.reason);
    f.names=null;assert.deepEqual(await f.api.privateProcesses(undefined,f.controls),[]);
  }
});
test("reaper inert census witness rejects foreign invocation role source snapshot and forged presence", async () => {
  for(const fault of ["role","control","direct","fake","parent","reason","reuse"]){
    const f=await censusWitnessFixture(),token=f.api.bindCensusControls({...f.controls.reaper,start:"99"},f.controls.coordinator);
    const selected=fault==="parent"?f.controls:token,witness=f.api.createCensusComparisonWitness(selected,fault==="role"?"coordinator":"reaper");
    let result;
    if(fault==="direct")result=await originalOutcome(Promise.resolve().then(()=>f.api.classifyCensusControl({pid:1,parent:0,start:"10",state:"S"},token,witness.recorder)));
    else if(fault==="parent")result=await originalOutcome(Promise.resolve().then(()=>f.api.classifyCensusControl({pid:1,parent:99,start:"10",state:"S"},selected,witness.recorder)));
    else result=await originalOutcome(f.api.privateProcesses(undefined,fault==="control"?f.api.bindCensusControls(token.reaper,token.coordinator):token,fault==="fake"?{present:true,failed:true,source:42}:witness.recorder));
    assert.equal(result.failed,true);
    if(fault==="reuse"){witness.requireRejected(true,result.reason);result=await originalOutcome(f.api.privateProcesses(undefined,token,witness.recorder));assert.equal(result.failed,true);}
    const reason=fault==="reason"?new Error("foreign identity"):result.reason;
    const denied=await originalOutcome(Promise.resolve().then(()=>witness.requireRejected(true,reason)));assert.equal(denied.failed,true);
    if(!["control","reuse"].includes(fault))assert.equal(denied.reason,reason);
  }
});
test("reaper inert comparison observer faults preserve the original failure and deny the negative", async () => {
  for(const fault of [undefined,new Error("observer")]){
    const f=await censusWitnessFixture(),token=f.api.bindCensusControls({...f.controls.reaper,start:"99"},f.controls.coordinator),witness=f.api.createCensusComparisonWitness(token,"reaper",()=>{throw fault;});
    const original=await originalOutcome(f.api.privateProcesses(undefined,token,witness.recorder));assert.equal(original.failed,true);
    const denied=await originalOutcome(Promise.resolve().then(()=>witness.requireRejected(true,original.reason)));assert.equal(denied.failed,true);assert.deepEqual(denied.reason.errors,[original.reason,fault]);
  }
  const f=await censusWitnessFixture(),calls=[],token=f.api.bindCensusControls({...f.controls.reaper,start:"99"},f.controls.coordinator);
  const row={get pid(){calls.push("pid");return 1;},get start(){calls.push("start");return "10";},get parent(){throw new Error("unreached parent");},get state(){throw new Error("unreached state");}};
  assert.throws(()=>f.api.classifyCensusControl(row,token));assert.deepEqual(calls,["pid","start"]);
  const thrown=undefined,early={pid:1,get start(){throw thrown;}};const result=await originalOutcome(Promise.resolve().then(()=>f.api.classifyCensusControl(early,token)));assert.equal(result.failed,true);assert.equal(result.reason,thrown);
  let reads=0;const original={get code(){reads++;throw undefined;}},g=await censusWitnessFixture(function(){return original;});
  const other=g.api.bindCensusControls({...g.controls.reaper,start:"99"},g.controls.coordinator),witness=g.api.createCensusComparisonWitness(other,"reaper");
  const access=await originalOutcome(g.api.privateProcesses(undefined,other,witness.recorder));assert.equal(access.failed,true);assert.equal(access.reason,undefined);assert.equal(reads,1);
  const denied=await originalOutcome(Promise.resolve().then(()=>witness.requireRejected(true,access.reason)));assert.equal(denied.failed,true);assert.equal(denied.reason,undefined);
});
test("reaper inert actual hosted substitution aborts on unrelated census failures before any later launch", async () => {
  const args=[reaperBinding.nonce,reaperBinding.contextHash,"501","20"];
  for(const role of ["reaper","coordinator"])for(const kind of ["read","undefined","missing"]){
    const f=await censusWitnessFixture(),pair=f.controls;let original,launches=0,failedCall=0;
    const ops={readControl:async pid=>({...pair[pid===1?"reaper":"coordinator"],exe:pid===1?containerContract.reaper:containerContract.node}),
      validateControlPair:(a,b)=>{if(a.exe==="/invalid-control"||b.exe==="/invalid-control")throw undefined;return pair;},
      bindCensusControls:f.api.bindCensusControls,createCensusComparisonWitness:f.api.createCensusComparisonWitness,
      privateProcesses:async(recorder,token,witness)=>{
        const active=token[role].start!==pair[role].start;
        if(active){failedCall++;if(kind==="missing")f.names=role==="reaper"?["2"]:["1"];else f.readFailure={pid:1,reason:kind==="undefined"?undefined:new Error("read")};}
        try{return await f.api.privateProcesses(recorder,token,witness);}catch(error){if(active)original=error;throw error;}finally{f.names=null;}
      },runOwnedProcess:()=>{launches++;throw new Error("unexpected launch");}};
    const result=await originalOutcome(hostedCensusMatrix(args,{},pair,ops));assert.equal(result.failed,true);assert.equal(result.reason,original);assert.equal(failedCall,1);assert.equal(launches,0);
    assert.deepEqual(await f.api.privateProcesses(undefined,pair),[]);
  }
});
// END explicit reaper inert tests.
