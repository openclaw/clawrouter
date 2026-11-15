import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { containerContract, harnessInputs, installInputs, parseIdentity, validateIdentity, validateMapping, validateImage, dockerEnvironment, containerEnvironment, createArguments, validateContainerInspect, parseControl, validateTerminal, validateNativeIdentity, parseImageBuildReceipt, parseContainerReceipt, parseMounts, validateMounts, validateMetadataMounts, validateChildStatus, validateTarget, cgroupPath, validateLimits, attachContainer, processEvidence, retiredCgroup, raiseContainerFailures, validateContainerDiagnostic, emitContainerFailure } from "../scripts/edge-proof-container.mjs";
import { frozenGitEnvironment, validateGitExecutable, frozenSource } from "../scripts/edge-proof-build.mjs";
import { edgeProof } from "../scripts/edge-proof-profile.mjs";

const hex = "a".repeat(64), other = "b".repeat(64), imageId = "sha256:" + hex;
const identity = { uid: [501, 501, 501, 501], gid: [20, 20, 20, 20], groups: [20, 30] };
const status = (groups = "20") => `Uid:\t501\t501\t501\t501\nGid:\t20\t20\t20\t20\nGroups:\t${groups}\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n`;
const baseEnv = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "NODE_VERSION=24.22.1", "YARN_VERSION=1.22.22"];
const image = () => ({ Id: imageId, Os: "linux", Architecture: "amd64", RepoDigests: [containerContract.base], Config: { Env: baseEnv, OnBuild: null, Volumes: null, User: "", WorkingDir: "", Entrypoint: ["docker-entrypoint.sh"], Cmd: ["node"] } });
const plan = () => ({ image: imageId, identity: structuredClone(identity), imageEnv: [...baseEnv, "PNPM_HOME=/usr/local/share/pnpm"], nonce: hex, contextHash: other, nativeHash: hex });
const processResult = (stdout = "") => ({ code: 0, signal: null, closed: true, timedOut: false, interrupted: false, errors: [], remaining: [], observed: new Map(), stdout, stderr: "" });
const mounts = () => [
  { target: "/", options: ["ro"], superOptions: ["rw"], fs: "overlay" },
  { target: "/task", options: ["rw", "noexec", "nosuid", "nodev"], superOptions: ["size=2097152k"], fs: "tmpfs" },
  ...["/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts"].map(target => ({ target, options: [target.startsWith("/sys") ? "ro" : "rw"], superOptions: [], fs: target === "/proc" ? "proc" : target === "/sys/fs/cgroup" ? "cgroup2" : "tmpfs" })),
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

test("Docker metadata mounts bind exact CID, device and filesystem-root without private-storage stat", () => {
  const daemonRoot = "/var/lib/docker", source = {}, target = [];
  for (const [key, name] of [["ResolvConfPath", "resolv.conf"], ["HostnamePath", "hostname"], ["HostsPath", "hosts"]]) {
    source[key] = `${daemonRoot}/containers/${hex}/${name}`;
    target.push({ target: `/etc/${name}`, root: `/volume/containers/${hex}/${name}`, device: "8:1", fs: "ext4", options: ["ro"] });
  }
  const parent = [{ target: "/", root: "/", device: "8:0", fs: "ext4" }, { target: daemonRoot, root: "/volume", device: "8:1", fs: "ext4" }];
  assert.equal(validateMetadataMounts(source, target, parent, daemonRoot, hex).length, 3);
  for (const change of [r => r.source.HostsPath = `/var/lib/docker/containers/${other}/hosts`, r => r.target[0].device = "8:9", r => r.target[0].root = "/foreign", r => r.target[0].options = ["rw"], r => r.target.pop(), r => r.parent.push({ ...r.parent[1] }), r => r.parent[1].root = "/changed-volume"]) {
    const row = structuredClone({ source, target, parent }); change(row);
    assert.throws(() => validateMetadataMounts(row.source, row.target, row.parent, daemonRoot, hex));
  }
  const parsed = parseMounts("1 0 8:1 /volume /var/lib/docker rw shared:1 - ext4 /dev/source rw\n", false);
  assert.equal(parsed[0].root, "/volume"); assert.equal(parsed[0].device, "8:1");
  assert.throws(() => parseMounts("1 0 8:1 /volume /var/lib/docker rw shared:1 - ext4 /dev/source rw\n"));
});
