import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { dirname, join, relative } from "node:path";
import { containerContract, harnessInputs, installInputs, parseIdentity, validateIdentity, validateMapping, validateImage, dockerEnvironment, containerEnvironment, createArguments, validateContainerInspect, parseControl, validateTerminal, validateNativeIdentity, parseImageBuildReceipt, parseImageBuildStages, parseNativePrepareStages, observeImageBuild, parseContainerReceipt, parseInitPrerequisites, createAttachProjection, runInitPrerequisites, createInitGuardLedger, initGuardLeaf, createMountObservation, validateEmptyMasks, validateMaskCompletion, parseMounts, validateMountFreshness, validateMounts, validateMetadataMounts, validateChildStatus, validateTarget, cgroupPath, validateLimits, attachContainer, processEvidence, retiredCgroup, raiseContainerFailures, validateContainerDiagnostic, emitContainerFailure } from "../scripts/edge-proof-container.mjs";
import { frozenGitEnvironment, validateGitExecutable, frozenSource } from "../scripts/edge-proof-build.mjs";
import { edgeProof } from "../scripts/edge-proof-profile.mjs";
import { launchCli, createContainerDiagnostics, containerProcessDiagnostic, imageBuildStages, runOwnedProcess, nativePrepareStages, createNativePrepareDiagnostics, enumerationOperations, validateEnumerationDetail, createInitDiagnostics, initPrerequisiteStages, attachFailureBranches, initGuardTags, initSourcePhases, validateInitDetail, mountPredicates, mountTargets, mountFilesystems, validateMountDetail, validateMaskDetail } from "../scripts/edge-proof.mjs";

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
const container = () => ({ Id: hex, Image: imageId, State: { Status: "created", Pid: 0, Running: false, Dead: false, ExitCode: 0, OOMKilled: false, Error: "" }, Config: { Labels: { "org.openclaw.edge.nonce": hex, "org.openclaw.edge.context": other }, Entrypoint: [containerContract.node], Cmd: createArguments(plan(), "/owned/cid").slice(createArguments(plan(), "/owned/cid").indexOf(imageId) + 1), User: "501:20", WorkingDir: "/task", Env: plan().imageEnv, Volumes: null }, HostConfig: { NetworkMode: "none", PidMode: "", Tmpfs: { "/task": "rw,noexec,nosuid,nodev,size=2147483648,mode=0700,uid=501,gid=20" }, IpcMode: "private", CgroupnsMode: "private", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges=true"], Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 2000000000, PidsLimit: 128 }, Mounts: [] });
const native = () => ({ version: 2, contextHash: other, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, install: { ...installInputs }, runtime: { node: "v24.22.1", abi: "137", platform: "linux", arch: "x64", pnpm: "11.28.4" }, containedLinks: 164, native: { node: { path: containerContract.node, sha256: hex }, git: { path: containerContract.git, sha256: hex }, typescript: { path: "/opt/edge-input/node_modules/.pnpm/ts/lib/tsc", sha256: hex }, esbuild: { path: "/opt/edge-input/node_modules/.pnpm/esbuild/bin/esbuild", sha256: hex }, wrangler: { path: "/opt/edge-input/node_modules/.pnpm/wrangler/wrangler-dist/cli.js", sha256: containerContract.cliHash } } });
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
  const derived = image(); Object.assign(derived.Config, { Env: plan().imageEnv, User: "501:20", WorkingDir: "/task", Entrypoint: [containerContract.node, "/opt/edge-input/scripts/edge-proof.mjs", "container-init"], Cmd: [], Labels: { "org.openclaw.edge.context": other } });
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
test("explicit context inventory is exactly the reviewed 22 paths plus frozen workspace closure", async () => {
  assert.equal(harnessInputs.length, 22); assert.equal(new Set(harnessInputs).size, 22);
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
test("actual cgroup retirement distinguishes removed from missing files, replacement and denied evidence", async () => {
  const bound = { path: "/synthetic/owned", dev: 1, ino: 2, parentDev: 1, parentIno: 1 };
  const missing = () => { throw Object.assign(new Error("fixture missing"), { code: "ENOENT" }); };
  const valid = { statPath: async path => ({ dev: 1, ino: path === "/synthetic" ? 1 : 2 }), read: async path => path.endsWith("cgroup.procs") ? "" : "populated 0\n", lstatPath: async () => ({}) };
  assert.equal(await retiredCgroup(bound, valid), "empty");
  assert.equal(await retiredCgroup(bound, { ...valid, statPath: async path => path === "/synthetic" ? { dev: 1, ino: 1 } : missing(), lstatPath: async () => missing() }), "removed");
  for (const change of [{ read: async () => "12345\n" }, { read: async () => { throw undefined; } }, { read: async () => missing() }, { statPath: async () => ({ dev: 1, ino: 9 }) }, { lstatPath: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, statPath: async path => path === "/synthetic" ? { dev: 1, ino: 1 } : missing() }]) await assert.rejects(retiredCgroup(bound, { ...valid, ...change }));
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
  assert.equal(fixture.output[0], '{"prepared":true}\n');
  const row = parseNativePrepareStages(nativePrepareCapture(fixture.diagnostics.join(""), { status: 0 }), stageIdentity);
  assert.equal(row.reason, "complete"); assert.equal(row.stage, null); validateContainerDiagnostic(row);
  const count = fixture.frames.length;
  const native = await fixture.functions.qualifyImageInputs(other);
  assert.equal(native.contextHash, other); assert.equal(fixture.frames.length, count);
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
  const helpers = source.slice(source.indexOf("export function createInitGuardLedger("), source.indexOf("const own =")).replaceAll("export ", "");
  const declarations = source.slice(source.indexOf("const same ="), source.indexOf("const hashPattern =")) + source.slice(source.indexOf("const number ="), source.indexOf("export function parseIdentity("));
  const goodStatus = "Groups:\t20\nUid:\t501 501 501 501\nGid:\t20 20 20 20\n" + ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(k => k + ":\t0000\n").join("") + "NoNewPrivs:\t1\nSeccomp:\t2\n";
  const calls = [], bindings = { initGuardTags, initSourcePhases, mountTargets, mountFilesystems, validateMountDetail, validateMaskDetail, raiseContainerFailures, process: { platform: "linux", arch: "x64", version: "v24.22.1", versions: { modules: "137" }, pid: 1, env: {} },
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
    // A failed OR has both operands false; the first false is not a terminal leaf.
    if (index + 1 === 22 || index + 1 === 28 || index + 1 === 14 && leaf === 1) continue;
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
// END attach diagnostic pure tests.
