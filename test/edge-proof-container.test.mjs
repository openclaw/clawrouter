import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { containerContract, harnessInputs, installInputs, parseIdentity, validateIdentity, validateMapping, validateImage, dockerEnvironment, containerEnvironment, createArguments, validateContainerInspect, parseControl, validateTerminal, validateNativeIdentity, parseImageBuildReceipt, parseContainerReceipt, parseMounts, validateMountFreshness, validateMounts, validateMetadataMounts, validateChildStatus, validateTarget, cgroupPath, validateLimits, attachContainer, processEvidence, retiredCgroup, raiseContainerFailures, validateContainerDiagnostic, emitContainerFailure } from "../scripts/edge-proof-container.mjs";
import { frozenGitEnvironment, validateGitExecutable, frozenSource } from "../scripts/edge-proof-build.mjs";
import { edgeProof } from "../scripts/edge-proof-profile.mjs";
import { launchCli, createContainerDiagnostics } from "../scripts/edge-proof.mjs";

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
const receipt = () => ({ version: 2, isolation: "private-container-pid-net-mount", nonce: hex, contextHash: other, nativeHash: hex, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, sourceFiles: 600, dependencyFiles: 268, exactErasures: 4, twoRoots: true, cliSha256: containerContract.cliHash, results: Object.fromEntries(["edge", "upstream"].map(kind => [kind, { code: 0, signal: null, closed: true, sha256: hex, observedProcesses: 1 }])), cloud: "UNRUN", sdk: "UNRUN" });

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
  const pureHelpers = names.filter(name => !["createContainerDiagnostics", "emitContainerFailure"].includes(name)).map(name => `export const ${name} = undefined;`).join("\n");
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
