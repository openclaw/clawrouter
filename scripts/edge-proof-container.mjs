import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, realpath, readlink, readdir, lstat, stat } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { edgeProof } from "./edge-proof-profile.mjs";
import { runOwnedProcess, requireProcessSuccess, qualifyInstalledInputs, namespaceEvidence, namespaceIdentity, prepareEnvironment, runPackagingPipeline, createPackagingDiagnostics } from "./edge-proof.mjs";

export const containerContract = Object.freeze({
  version: 2,
  base: "docker.io/library/node@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02",
  input: "/opt/edge-input", node: "/usr/local/bin/node", git: "/usr/bin/git",
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
]);
export const installInputs = Object.freeze({
  "package.json": "07130060a46c69fe292aa5865b331cc6c06e3b215a402c362787db4c30443841",
  "pnpm-lock.yaml": "3e1b8b9e668ee40bea41b46001c2c75a2fbc8be88d9f26b512dafb09cf16e4b2",
  "pnpm-workspace.yaml": "4170373a544197669e91120a9584d12f0d1e26912919546b8992615f0cea9b26",
  "admin/package.json": "cb5fc9f00b77d9da35f5499968a94460717118e21062728cc3bacca48d90ac7c",
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw new Error(`edge-container: ${code}`); };
const check = (value, code) => { if (!value) fail(code); };
const hashPattern = /^[a-f0-9]{64}$/;
const cidPattern = /^[a-f0-9]{64}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const phases = ["identity", "context", "daemon", "base", "image_build", "image", "create", "attach", "ready", "admission", "permit", "wait", "receipt", "terminal", "cgroup", "retirement", "remove", "final", "overflow"];
const signalNames = [null, "SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGBUS", "SIGSYS"];
const protocol = "EDGE_CONTAINER_V2 ";
const own = (value, key) => {
  check(value && typeof value === "object", "data-object");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  check(descriptor && Object.hasOwn(descriptor, "value"), "own-data");
  return descriptor.value;
};
const exactKeys = (value, keys) => check(same(Object.getOwnPropertyNames(value).sort(), [...keys].sort()), "data-keys");
export function raiseContainerFailures(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "edge-container: independent failures");
}
export function validateContainerDiagnostic(value) {
  exactKeys(value, ["v", "phase", "state", "defined", "exit", "signal"]);
  const row = Object.fromEntries(["v", "phase", "state", "defined", "exit", "signal"].map(key => [key, own(value, key)]));
  check(row.v === 2 && phases.includes(row.phase) && ["entered", "fulfilled", "rejected"].includes(row.state), "diagnostic-enum");
  check([null, true, false].includes(row.defined) && signalNames.includes(row.signal) && (row.exit === null || Number.isInteger(row.exit) && row.exit >= 0 && row.exit <= 255), "diagnostic-outcome");
  return row;
}
export function emitContainerFailure(records, writer = line => process.stdout.write(line)) {
  const rows = records.map(validateContainerDiagnostic), unique = new Map();
  for (const row of [...rows.filter(row => row.state === "rejected"), ...rows.toReversed()]) if (!unique.has(row.phase)) unique.set(row.phase, row);
  const selected = [...unique.values()].slice(0, 9);
  if (unique.size > 9) selected.push({ v: 2, phase: "overflow", state: "rejected", defined: null, exit: Math.min(255, unique.size - 9), signal: null });
  let bytes = 0;
  for (const row of selected) {
    const command = `::error title=Edge container boundary::${JSON.stringify(row).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`;
    bytes += Buffer.byteLength(command); check(Buffer.byteLength(command) <= 768 && bytes <= 8192, "diagnostic-capacity"); writer(command);
  }
}
function reporter() {
  const records = [];
  return { records, async step(phase, fn) {
    records.push({ v: 2, phase, state: "entered", defined: null, exit: null, signal: null });
    try { const result = await fn(); records.push({ v: 2, phase, state: "fulfilled", defined: null, exit: null, signal: null }); return result; }
    catch (error) { records.push({ v: 2, phase, state: "rejected", defined: error !== undefined, exit: null, signal: null }); throw error; }
  } };
}

const number = text => { check(typeof text === "string" && /^(0|[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text)), "canonical-number"); return Number(text); };
export function parseIdentity(status) {
  check(typeof status === "string" && status.length <= 65536, "status-capacity");
  const field = name => { const rows = status.split("\n").filter(line => line.startsWith(name + ":")); check(rows.length === 1, "status-field"); return rows[0].slice(name.length + 1).trim(); };
  const tuple = name => { const values = field(name).split(/\s+/).map(number); check(values.length === 4 && values[0] > 0 && values.every(value => value === values[0]), "identity-tuple"); return values; };
  const groups = field("Groups").split(/\s+/).filter(Boolean).map(number).sort((a, b) => a - b);
  check(new Set(groups).size === groups.length, "identity-groups");
  return { uid: tuple("Uid"), gid: tuple("Gid"), groups };
}
export function validateIdentity(actual, expected, child = false) {
  check(same(actual.uid, expected.uid) && same(actual.gid, expected.gid), "identity-drift");
  check(child ? actual.groups.length <= 1 && actual.groups.every(group => group === expected.gid[0]) : same(actual.groups, expected.groups), "groups-drift");
  return actual;
}
export function validateMapping(text, id) {
  const rows = text.trim().split("\n").map(line => line.trim().split(/\s+/).map(number));
  check(rows.length === 1 && rows[0].length === 3 && rows[0][0] === 0 && rows[0][1] === 0 && rows[0][2] > id, "host-id-mapping");
  return rows;
}
export function validateImage(image, { derived = false, identity, id, contextHash } = {}) {
  check(image && imagePattern.test(image.Id) && (!id || image.Id === id) && image.Os === "linux" && image.Architecture === "amd64", "image-identity");
  const config = image.Config;
  check(config && (!config.OnBuild || config.OnBuild.length === 0) && (!config.Volumes || Object.keys(config.Volumes).length === 0), "image-implicit-input");
  const baseEnv = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "NODE_VERSION=24.22.1", "YARN_VERSION=1.22.22"];
  check(same(config.Env, derived ? [...baseEnv, "PNPM_HOME=/usr/local/share/pnpm"] : baseEnv), "image-environment");
  check(same(config.Entrypoint, derived ? [containerContract.node, "/opt/edge-input/scripts/edge-proof.mjs", "container-init"] : ["docker-entrypoint.sh"]), "image-entrypoint");
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
  return ["create", "--cidfile", cidFile, "--platform=linux/amd64", "--network=none", "--ipc=private", "--cgroupns=private", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true", "--user", `${uid}:${gid}`, "--pids-limit=128", "--cpus=2", "--memory=4g", "--memory-swap=4g", "--stop-timeout=2", "--interactive", "--log-driver=none", "--tmpfs", `/task:rw,noexec,nosuid,nodev,size=2147483648,mode=0700,uid=${uid},gid=${gid}`, "--workdir=/task", "--label", `org.openclaw.edge.nonce=${plan.nonce}`, "--label", `org.openclaw.edge.context=${plan.contextHash}`, "--entrypoint", containerContract.node, plan.image, "/opt/edge-input/scripts/edge-proof.mjs", "container-init", plan.nonce, plan.contextHash, String(uid), String(gid)];
}
export function validateContainerInspect(row, plan, cid) {
  check(cidPattern.test(cid) && row.Id === cid && row.Image === plan.image && row.Config?.Labels?.["org.openclaw.edge.nonce"] === plan.nonce && row.Config.Labels["org.openclaw.edge.context"] === plan.contextHash, "container-custody");
  const h = row.HostConfig, c = row.Config;
  check(h.NetworkMode === "none" && h.PidMode === "" && h.IpcMode === "private" && h.CgroupnsMode === "private" && h.ReadonlyRootfs === true && h.Privileged === false, "container-isolation");
  check(same(h.CapDrop, ["ALL"]) && (!h.CapAdd || !h.CapAdd.length) && same(h.SecurityOpt, ["no-new-privileges=true"]), "container-capabilities");
  check(h.Memory === containerContract.memory && h.MemorySwap === containerContract.memory && h.NanoCpus === containerContract.cpus && h.PidsLimit === containerContract.pids, "container-limits");
  for (const key of ["Binds", "VolumesFrom", "Devices", "DeviceRequests", "GroupAdd"]) check(!h[key] || !h[key].length, "container-extra-input");
  for (const key of ["PortBindings", "Sysctls"]) check(!h[key] || !Object.keys(h[key]).length, "container-extra-input");
  check(!c.ExposedPorts || !Object.keys(c.ExposedPorts).length, "container-port");
  // --tmpfs is stored separately from inspect.Mounts (Moby v28.5.2).
  check(Array.isArray(row.Mounts) && row.Mounts.length === 0, "container-mounts");
  check(same(h.Tmpfs, { "/task": `rw,noexec,nosuid,nodev,size=2147483648,mode=0700,uid=${plan.identity.uid[0]},gid=${plan.identity.gid[0]}` }), "container-tmpfs");
  const expected = createArguments(plan, "/unused");
  check(same(c.Entrypoint, [containerContract.node]) && same(c.Cmd, expected.slice(expected.indexOf(plan.image) + 1)) && c.User === `${plan.identity.uid[0]}:${plan.identity.gid[0]}` && c.WorkingDir === "/task", "container-command");
  check(same(c.Env, plan.imageEnv) && !c.Volumes && !c.OnBuild?.length, "container-env");
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
export function validateNativeIdentity(receipt, plan) {
  exactKeys(receipt, ["version", "contextHash", "sourceSha", "sourceTree", "install", "runtime", "native", "containedLinks"]);
  check(receipt.version === 2 && receipt.contextHash === plan.contextHash && receipt.sourceSha === edgeProof.sourceSha && receipt.sourceTree === edgeProof.sourceTree && same(receipt.install, installInputs), "native-inputs");
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
async function qualifyImageInputs(contextHash) {
  check(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1" && process.versions.modules === "137", "image-runtime");
  const root = containerContract.input;
  const inputPlan = JSON.parse(await readFile(join(root, ".edge-context.json"), "utf8"));
  check(hash(JSON.stringify(inputPlan.files)) === contextHash && inputPlan.sourceSha === edgeProof.sourceSha && inputPlan.sourceTree === edgeProof.sourceTree, "context-identity");
  const actual = await contextFiles(root, new Set(["node_modules", "admin/node_modules", ".edge-context.json", ".edge-native.json"]));
  check(same(actual, inputPlan.files), "context-byte-closure");
  for (const [path, expected] of Object.entries(installInputs)) check(hash(await readFile(join(root, path))) === expected, "install-input-drift");
  const { containedLinks } = await qualifyInstalledInputs(root);
  const tsRequire = createRequire(join(root, "node_modules/typescript/package.json"));
  const wranglerRequire = createRequire(join(root, "node_modules/wrangler/package.json"));
  const esbuildRequire = createRequire(wranglerRequire.resolve("esbuild/package.json"));
  const native = {
    node: await fileIdentity(containerContract.node), git: await fileIdentity(containerContract.git),
    typescript: await fileIdentity(await realpath(join(dirname(tsRequire.resolve("@typescript/typescript-linux-x64/package.json")), "lib/tsc"))),
    esbuild: await fileIdentity(await realpath(esbuildRequire.resolve("@esbuild/linux-x64/bin/esbuild"))),
    wrangler: await fileIdentity(join(dirname(await realpath(wranglerRequire.resolve("wrangler/package.json"))), "wrangler-dist/cli.js")),
  };
  const result = { version: 2, contextHash, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, install: { ...installInputs }, runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, pnpm: "11.28.4" }, native, containedLinks };
  validateNativeIdentity(result, { contextHash });
  // Only installed platform resolvers are allowed. No environment override or
  // downloaded esbuild fallback can satisfy these realpath/hash checks.
  const { default: getTsPath } = await import(new URL("./lib/getExePath.js", `file://${tsRequire.resolve("typescript/package.json")}`).href);
  check(await realpath(getTsPath()) === native.typescript.path, "typescript-resolver");
  check(execFileSync(native.esbuild.path, ["--version"], { env: { LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10000 }).trim() === JSON.parse(await readFile(esbuildRequire.resolve("esbuild/package.json"), "utf8")).version, "esbuild-platform");
  return result;
}
async function contextFiles(root, excluded = new Set()) {
  const files = []; let size = 0;
  async function walk(prefix = "") {
    for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded.has(path)) continue;
      check(/^[a-zA-Z0-9_./-]+$/.test(path) && !path.split("/").includes(".."), "context-path");
      if (entry.isDirectory()) await walk(path);
      else {
        check(entry.isFile(), "context-link-or-special"); const bytes = await readFile(join(root, path)); size += bytes.length;
        check(files.length < 50000 && size <= 256 * 1024 * 1024, "context-capacity"); files.push({ path, sha256: hash(bytes), bytes: bytes.length });
      }
    }
  }
  await walk(); return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
async function writeExclusive(root, path, bytes) {
  const target = join(root, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}
async function createBuildContext(cwd, root) {
  const git = (await fileIdentity(containerContract.git)).path;
  const original = (directory, args, input) => execFileSync(git, args, { cwd: directory, env: gitEnvironment, input, maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const fetchRoot = join(root, "source-fetch"), context = join(root, "context"), input = join(context, "input");
  await mkdir(fetchRoot); await mkdir(input, { recursive: true });
  original(fetchRoot, ["init", "--bare", "--template="]);
  // Public, anonymous source setup only. No checkout config, URL rewrite,
  // inherited proxy, credential helper, remote, hook or unrelated history.
  original(fetchRoot, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.writeCommitGraph=false", "fetch", "--no-auto-maintenance", "--no-tags", "--no-prune", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--depth=1", "https://github.com/openclaw/clawrouter.git", edgeProof.sourceSha]);
  check(original(fetchRoot, ["rev-parse", `${edgeProof.sourceSha}^{tree}`]).toString().trim() === edgeProof.sourceTree, "source-tree");
  const entries = original(fetchRoot, ["ls-tree", "-rtz", edgeProof.sourceSha]).toString().split("\0").filter(Boolean);
  const objects = new Map([[edgeProof.sourceSha, "commit"], [edgeProof.sourceTree, "tree"]]);
  for (const entry of entries) {
    const [meta, path] = entry.split("\t"), [mode, type, oid] = meta.split(" ");
    check(["100644", "100755", "040000"].includes(mode) && ["blob", "tree"].includes(type) && shaPattern.test(oid) && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.split("/").includes(".."), "source-object-entry"); objects.set(oid, type);
  }
  check(objects.size < 25000, "source-object-capacity"); let sourceBytes = 0;
  for (const [oid, type] of [...objects].sort()) {
    const bytes = original(fetchRoot, ["cat-file", type, oid]); sourceBytes += bytes.length; check(sourceBytes <= 256 * 1024 * 1024, "source-byte-capacity");
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    check(createHash("sha1").update(raw).digest("hex") === oid, "source-object-hash");
    await writeExclusive(input, `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, deflateSync(raw));
  }
  await writeExclusive(input, ".git/HEAD", edgeProof.sourceSha + "\n");
  await writeExclusive(input, ".git/shallow", edgeProof.sourceSha + "\n"); await mkdir(join(input, ".git/refs"));
  for (const path of [...harnessInputs, ...Object.keys(installInputs)]) {
    const candidate = join(cwd, path); check(await realpath(candidate) === candidate && (await lstat(candidate)).isFile(), "harness-file");
    const bytes = await readFile(candidate);
    if (Object.hasOwn(installInputs, path)) check(hash(bytes) === installInputs[path] && original(fetchRoot, ["show", `${edgeProof.sourceSha}:${path}`]).equals(bytes), "frozen-install-input");
    await writeExclusive(input, path, bytes);
  }
  const files = await contextFiles(input), contextHash = hash(JSON.stringify(files));
  await writeExclusive(input, ".edge-context.json", JSON.stringify({ version: 2, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, files }));
  await writeExclusive(context, "Dockerfile", await readFile(join(cwd, "config/edge-proof/Dockerfile")));
  return { context, contextHash, files, dockerfileHash: hash(await readFile(join(context, "Dockerfile"))) };
}

export function parseMounts(text, privateView = true) {
  check(typeof text === "string" && text.length < 128 * 1024, "mount-capacity");
  return text.trim().split("\n").map(line => {
    const halves = line.split(" - "); check(halves.length === 2, "mount-format");
    const a = halves[0].split(" "), b = halves[1].split(" "); check(a.length >= 6 && b.length >= 3 && (!privateView || !a.slice(6).some(value => /^(shared|master|propagate_from):/.test(value))), "shared-mount");
    check(/^\d+:\d+$/.test(a[2]) && isAbsolute(a[3]) && isAbsolute(a[4]), "mount-identity");
    return { target: a[4], root: a[3], device: a[2], options: a[5].split(","), fs: b[0], superOptions: b[2].split(",") };
  });
}
// mountinfo identifies the filesystem and bind root independently of directory
// traversal permissions. Never stat Docker's root-owned private storage.
export function validateMetadataMounts(inspect, targetMounts, parentMounts, daemonRoot, cid) {
  check(cidPattern.test(cid) && typeof daemonRoot === "string" && isAbsolute(daemonRoot) && resolve(daemonRoot) === daemonRoot, "daemon-root-identity");
  const result = [];
  for (const [key, name] of [["ResolvConfPath", "resolv.conf"], ["HostnamePath", "hostname"], ["HostsPath", "hosts"]]) {
    const source = inspect[key];
    check(source === join(daemonRoot, "containers", cid, name), "daemon-metadata-custody");
    const candidates = parentMounts.filter(row => source === row.target || source.startsWith(row.target === "/" ? "/" : row.target + "/")).sort((a, b) => b.target.length - a.target.length);
    check(candidates.length > 0 && (candidates.length === 1 || candidates[0].target.length > candidates[1].target.length), "daemon-metadata-parent-ambiguous");
    const parent = candidates[0], matches = targetMounts.filter(row => row.target === `/etc/${name}`);
    check(matches.length === 1, "daemon-metadata-target");
    const target = matches[0], root = resolve(parent.root, relative(parent.target, source));
    check(target.root === root && target.device === parent.device && target.fs === parent.fs && target.options.includes("ro"), "daemon-metadata-mount-identity");
    result.push({ name, root, device: target.device, fs: target.fs });
  }
  return result;
}
export function validateMounts(rows) {
  const permitted = new Set(["/", "/task", "/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger", "/proc/acpi", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/scsi", "/sys/firmware", "/sys/devices/virtual/powercap"]);
  check(new Set(rows.map(row => row.target)).size === rows.length && rows.every(row => permitted.has(row.target)), "mount-topology");
  for (const target of ["/", "/task", "/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts"]) check(rows.some(row => row.target === target), "mount-missing");
  check(rows.find(row => row.target === "/").options.includes("ro"), "root-not-readonly");
  const task = rows.find(row => row.target === "/task");
  check(task.fs === "tmpfs" && ["rw", "noexec", "nosuid", "nodev"].every(flag => task.options.includes(flag)) && task.superOptions.includes("size=2097152k"), "task-mount");
  check(rows.find(row => row.target === "/proc").fs === "proc" && rows.find(row => row.target === "/sys/fs/cgroup").fs === "cgroup2", "proc-cgroup-mount");
  for (const row of rows.filter(row => row.target.startsWith("/sys"))) check(row.options.includes("ro"), "sys-write");
  return true;
}
export function validateChildStatus(text, expected) {
  validateIdentity(parseIdentity(text), expected, true);
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) check(new RegExp(`^${name}:\\s+0+$`, "m").test(text), "child-capability");
  check(/^NoNewPrivs:\s+1$/m.test(text) && /^Seccomp:\s+2$/m.test(text), "child-security");
}
async function readParentIdentity() { return parseIdentity(await readFile("/proc/self/status", "utf8")); }
export async function processEvidence(pid, { read = readFile, link = readlink } = {}) {
  check(Number.isSafeInteger(pid) && pid > 0, "process-id");
  const prefix = `/proc/${pid}`, raw = await read(join(prefix, "stat"), "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  check(/^\d+$/.test(fields[19]), "process-start");
  return { pid, start: fields[19], parent: number(fields[1]), status: await read(join(prefix, "status"), "utf8"), uidMap: await read(join(prefix, "uid_map"), "utf8"), gidMap: await read(join(prefix, "gid_map"), "utf8"), namespaces: Object.fromEntries(await Promise.all(["pid", "net", "mnt", "user"].map(async name => [name, await link(join(prefix, "ns", name))]))), mounts: parseMounts(await read(join(prefix, "mountinfo"), "utf8")), cgroup: await read(join(prefix, "cgroup"), "utf8") };
}
export function validateTarget(target, parent, identity) {
  validateChildStatus(target.status, identity); validateMapping(target.uidMap, identity.uid[0]); validateMapping(target.gidMap, identity.gid[0]);
  check(target.namespaces.user === parent.user, "user-mapping-unqualified");
  for (const name of ["pid", "net", "mnt"]) check(new RegExp(`^${name}:\\[\\d+\\]$`).test(target.namespaces[name]) && target.namespaces[name] !== parent[name], "private-namespace");
  validateMounts(target.mounts); return target;
}
export function cgroupPath(text, cid) {
  check(cidPattern.test(cid), "cgroup-cid"); const match = /^0::(\/[^\n]+)\n?$/.exec(text);
  check(match && !match[1].split("/").includes("..") && match[1].split("/").some(part => part === cid || part === `docker-${cid}.scope`), "cgroup-custody");
  return "/sys/fs/cgroup" + match[1];
}
export function validateLimits(values) {
  check(values.memory.trim() === "4294967296" && values.swap.trim() === "0" && values.pids.trim() === "128", "effective-cgroup-limit");
  const cpu = values.cpu.trim().split(" "); check(cpu.length === 2 && number(cpu[0]) === 2 * number(cpu[1]) && number(cpu[1]) > 0, "effective-cpu-limit");
}
async function bindCgroup(target, cid) {
  const path = cgroupPath(target.cgroup, cid); check(await realpath(path) === path, "cgroup-realpath");
  const inode = await stat(path), parent = await stat(dirname(path));
  validateLimits(Object.fromEntries(await Promise.all([["memory", "memory.max"], ["swap", "memory.swap.max"], ["pids", "pids.max"], ["cpu", "cpu.max"]].map(async ([key, name]) => [key, await readFile(join(path, name), "utf8")]))));
  return { path, dev: inode.dev, ino: inode.ino, parentDev: parent.dev, parentIno: parent.ino };
}
export async function retiredCgroup(bound, { read = readFile, statPath = stat, lstatPath = lstat } = {}) {
  const parent = await statPath(dirname(bound.path)); check(parent.dev === bound.parentDev && parent.ino === bound.parentIno, "cgroup-parent-replaced");
  try {
    const current = await statPath(bound.path); check(current.dev === bound.dev && current.ino === bound.ino, "cgroup-replaced");
    check((await read(join(bound.path, "cgroup.procs"), "utf8")).trim() === "" && /^populated 0$/m.test(await read(join(bound.path, "cgroup.events"), "utf8")), "cgroup-descendants-live"); return "empty";
  } catch (error) { if (error?.code === "ENOENT") { try { await lstatPath(bound.path); } catch (missing) { if (missing?.code === "ENOENT") return "removed"; throw missing; } } throw error; }
}

// Original attach close and stdin write outcomes remain separate from READY.
// This supervisor never treats killing a Docker client as container retirement.
export function attachContainer(command, args, { cwd, env, nonce, contextHash, spawnProcess = spawn, onStop, signalSource = process, killGroup = (pid, signal) => process.kill(-pid, signal), timeoutMs = 480000, readyMs = 30000 }) {
  const result = { code: null, signal: null, closed: false, timedOut: false, interrupted: false, errors: [], remaining: [], observed: new Map(), stdout: "", stderr: "" };
  const ready = Promise.withResolvers(), closed = Promise.withResolvers();
  // A failed launch can close before its owner begins awaiting the handshake.
  void ready.promise.catch(() => {});
  let child, bytes = 0, frame = "", seen = false, stopTask, timer, readyTimer;
  const stop = reason => {
    if (!stopTask) stopTask = Promise.resolve().then(() => onStop(reason)).catch(error => { result.errors.push(error); }).finally(() => {
      // If the daemon could not retire the owned container, close this task's
      // own CLI too. That outcome stays failed; it is never cgroup evidence.
      if (!result.closed && child?.pid) try { killGroup(child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") result.errors.push(error); }
    });
    return stopTask;
  };
  const onSignal = () => { result.interrupted = true; void stop("interrupt"); };
  const finish = async (code, signal) => {
    result.code = code; result.signal = signal; result.closed = true;
    clearTimeout(timer); clearTimeout(readyTimer); signalSource.removeListener("SIGINT", onSignal); signalSource.removeListener("SIGTERM", onSignal);
    if (!seen) ready.reject(new Error("edge-container: ready-missing"));
    if (stopTask) await stopTask;
    closed.resolve(result);
  };
  try {
    child = spawnProcess(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", error => { result.errors.push(error); ready.reject(error); void stop("attach-error"); });
    child.stdin.on("error", error => { result.errors.push(error); void stop("stdin-error"); });
    child.once("close", (code, signal) => { void finish(code, signal); });
    for (const key of ["stdout", "stderr"]) child[key].on("data", data => {
      bytes += data.length;
      if (bytes > 1024 * 1024) { result.errors.push(new Error("edge-container: attach-capacity")); void stop("output-capacity"); return; }
      result[key] += data.toString("utf8");
      if (key !== "stdout") return;
      frame += data.toString("utf8");
      while (frame.includes("\n")) {
        const end = frame.indexOf("\n") + 1, line = frame.slice(0, end); frame = frame.slice(end);
        if (!line.startsWith(protocol)) continue;
        try { check(!seen, "ready-replayed"); parseControl(line, "ready", nonce, contextHash); seen = true; clearTimeout(readyTimer); ready.resolve(); }
        catch (error) { result.errors.push(error); ready.reject(error); void stop("ready-invalid"); }
      }
    });
    timer = setTimeout(() => { result.timedOut = true; ready.reject(new Error("edge-container: deadline")); void stop("deadline"); }, timeoutMs);
    readyTimer = setTimeout(() => { result.timedOut = true; ready.reject(new Error("edge-container: ready-deadline")); void stop("ready-deadline"); }, readyMs);
    signalSource.on("SIGINT", onSignal); signalSource.on("SIGTERM", onSignal);
  } catch (error) { result.errors.push(error); ready.reject(error); void finish(null, null); }
  return {
    ready: ready.promise, closed: closed.promise, result,
    async permit() {
      check(seen && !result.closed && !result.errors.length && !result.timedOut && !result.interrupted, "permit-without-ready");
      await new Promise((resolveWrite, rejectWrite) => child.stdin.end(control("permit", nonce, contextHash), error => error ? rejectWrite(error) : resolveWrite()));
    },
  };
}
async function receivePermit(nonce, contextHash) {
  let text = "";
  const deadline = setTimeout(() => process.stdin.destroy(new Error("edge-container: permit-deadline")), 30000);
  try {
    for await (const chunk of process.stdin) { text += chunk.toString("utf8"); check(Buffer.byteLength(text) <= 512, "permit-capacity"); }
    return parseControl(text, "permit", nonce, contextHash);
  } finally { clearTimeout(deadline); }
}
async function validateContainerRuntime(identity, builder = false) {
  check(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1" && process.versions.modules === "137", "container-runtime");
  check(builder ? process.pid > 1 && process.ppid === 1 : process.pid === 1, "container-init-ancestry");
  validateChildStatus(await readFile("/proc/self/status", "utf8"), identity);
  validateMounts(parseMounts(await readFile("/proc/self/mountinfo", "utf8")));
  const evidence = await namespaceEvidence();
  check(same(evidence.interfaces, ["lo"]) && evidence.routes4.length === 0, "container-external-network");
  for (const line of evidence.routes6) {
    const fields = line.trim().split(/\s+/);
    check(fields.length === 10 && fields[9] === "lo" && fields[4] === "0".repeat(32) && ((fields[0] === "0".repeat(31) + "1" && fields[1] === "80") || fields[0] === "0".repeat(32) && fields[1] === "00" && (Number.parseInt(fields[8], 16) & 0x200) !== 0), "container-external-ipv6");
  }
  const expected = containerEnvironment(builder ? "/task/child" : "/task"); check(same(Object.entries(process.env).sort(), Object.entries(expected).sort()), "container-effective-environment");
}
async function nativeReceipt(contextHash) {
  const receipt = validateNativeIdentity(JSON.parse(await readFile(join(containerContract.input, ".edge-native.json"), "utf8")), { contextHash });
  const actual = await qualifyImageInputs(contextHash); check(same(receipt, actual), "image-native-drift"); return receipt;
}
export function parseImageBuildReceipt(text, contextHash) {
  const lines = text.split("\n").filter(line => line.startsWith("EDGE_IMAGE_V2 "));
  check(lines.length === 1 && Buffer.byteLength(lines[0]) <= 8192, "image-attestation-count");
  return validateNativeIdentity(JSON.parse(lines[0].slice("EDGE_IMAGE_V2 ".length)), { contextHash });
}
export function parseContainerReceipt(text, plan) {
  const lines = text.split("\n").filter(line => line.startsWith("EDGE_CONTAINER_RECEIPT_V2 "));
  check(lines.length === 1 && Buffer.byteLength(lines[0]) <= 8192, "container-receipt-count");
  const receipt = JSON.parse(lines[0].slice("EDGE_CONTAINER_RECEIPT_V2 ".length));
  exactKeys(receipt, ["version", "isolation", "nonce", "contextHash", "nativeHash", "sourceSha", "sourceTree", "sourceFiles", "dependencyFiles", "exactErasures", "twoRoots", "cliSha256", "results", "cloud", "sdk"]);
  check(receipt.version === 2 && receipt.isolation === "private-container-pid-net-mount" && receipt.nonce === plan.nonce && receipt.contextHash === plan.contextHash && receipt.nativeHash === plan.nativeHash && receipt.sourceSha === edgeProof.sourceSha && receipt.sourceTree === edgeProof.sourceTree && receipt.sourceFiles === 600 && receipt.dependencyFiles === 268 && receipt.exactErasures === 4 && receipt.twoRoots === true && receipt.cliSha256 === containerContract.cliHash && receipt.sdk === "UNRUN" && receipt.cloud === "UNRUN", "container-receipt-identity");
  exactKeys(receipt.results, ["edge", "upstream"]);
  for (const result of Object.values(receipt.results)) { exactKeys(result, ["code", "signal", "closed", "sha256", "observedProcesses"]); check(result.code === 0 && result.signal === null && result.closed === true && hashPattern.test(result.sha256) && Number.isSafeInteger(result.observedProcesses) && result.observedProcesses >= 1, "container-wrangler-result"); }
  return receipt;
}
async function containerInit(args) {
  check(args.length === 4 && hashPattern.test(args[0]) && hashPattern.test(args[1]), "init-arguments");
  const [nonce, contextHash, uid, gid] = args, identity = { uid: Array(4).fill(number(uid)), gid: Array(4).fill(number(gid)), groups: [] };
  // Docker supplies only admitted image environment. No inherited host env is
  // merged into builder/CLI execution, including NODE_OPTIONS or binary overrides.
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, containerEnvironment());
  await prepareEnvironment("/task");
  await validateContainerRuntime(identity);
  const native = await nativeReceipt(contextHash);
  process.stdout.write(control("ready", nonce, contextHash));
  await receivePermit(nonce, contextHash);
  const report = createPackagingDiagnostics("child", line => process.stdout.write(line)), errors = []; let built;
  report.mark("entry", "fulfilled");
  try {
    built = await runPackagingPipeline(containerContract.input, "/task", report, {
      checkBoundary: async () => { await validateContainerRuntime(identity); await nativeReceipt(contextHash); },
      buildArguments: (capsule, role) => ["/opt/edge-input/scripts/edge-proof.mjs", "container-build", capsule, role, contextHash, uid, gid],
    });
  } catch (error) { errors.push(error); }
  report.mark("final", errors.length ? "rejected" : "fulfilled", errors[0]); errors.push(...report.errors); raiseContainerFailures(errors);
  const { version: _version, isolated: _isolated, ...packaging } = built;
  const receipt = { version: 2, isolation: "private-container-pid-net-mount", nonce, contextHash, nativeHash: hash(JSON.stringify(native)), ...packaging };
  process.stdout.write("EDGE_CONTAINER_RECEIPT_V2 " + JSON.stringify(receipt) + "\n");
  return { container: "complete", version: 2 };
}
async function containerBuild(args) {
  check(args.length === 5 && ["/task/capsule-a", "/task/capsule-b"].includes(args[0]) && ["build_a", "build_b"].includes(args[1]) && hashPattern.test(args[2]), "builder-arguments");
  const [capsule, role, contextHash, uid, gid] = args, identity = { uid: Array(4).fill(number(uid)), gid: Array(4).fill(number(gid)), groups: [] };
  const report = createPackagingDiagnostics(role, line => process.stdout.write(line)), errors = [];
  report.mark("entry", "fulfilled"); let esbuild;
  try {
    await report.step("namespace_read", () => validateContainerRuntime(identity, true));
    const native = await nativeReceipt(contextHash);
    const { buildCapsule } = await report.step("builder_import", () => import("./edge-proof-build.mjs"));
    esbuild = createRequire(import.meta.resolve("wrangler/package.json"))("esbuild");
    const receipt = await report.step("build", () => buildCapsule(containerContract.input, capsule, { executable: native.native.git.path, sha256: native.native.git.sha256, env: { ...gitEnvironment } }));
    await report.step("receipt_write", () => writeFile(join(capsule, "source-receipt.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 }));
  } catch (error) { errors.push(error); }
  if (esbuild) try { report.sync("build_service_stop", () => esbuild.stop()); } catch (error) { errors.push(error); }
  report.mark("final", errors.length ? "rejected" : "fulfilled", errors[0]); errors.push(...report.errors); raiseContainerFailures(errors);
  return { built: true };
}
async function containerPrepare(args) {
  check(args.length === 1 && hashPattern.test(args[0]), "prepare-arguments");
  const native = await qualifyImageInputs(args[0]);
  const pnpm = execFileSync("/usr/local/bin/pnpm", ["--version"], { env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/opt/build-home" }, encoding: "utf8", timeout: 10000 }).trim(); check(pnpm === "11.28.4", "pnpm-version");
  await writeFile(join(containerContract.input, ".edge-native.json"), JSON.stringify(native), { flag: "wx", mode: 0o444 });
  process.stdout.write("EDGE_IMAGE_V2 " + JSON.stringify(native) + "\n"); return { prepared: true };
}

async function containerCi() {
  const report = reporter(), errors = []; let value;
  try { value = await hostContainerRun(report); } catch (error) { errors.push(error); }
  if (errors.length) try { emitContainerFailure(report.records); } catch (error) { errors.push(error); }
  raiseContainerFailures(errors); return value;
}
async function hostContainerRun(report) {
  check(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1" && process.versions.modules === "137", "host-runtime");
  const identity = await report.step("identity", readParentIdentity), parentNamespaces = await namespaceIdentity();
  const cwd = await realpath(process.cwd()), root = await mkdtemp(join(tmpdir(), "edge-container-"));
  const env = dockerEnvironment(root); await mkdir(env.HOME, { mode: 0o700 }); await mkdir(env.DOCKER_CONFIG, { mode: 0o700 });
  const docker = (await fileIdentity("/usr/bin/docker")).path;
  check((await stat("/var/run/docker.sock")).isSocket() && ["/run/docker.sock", "/var/run/docker.sock"].includes(await realpath("/var/run/docker.sock")), "local-daemon-socket");
  const run = async (args, timeoutMs = 30000) => {
    const result = await runOwnedProcess(docker, ["--host=unix:///var/run/docker.sock", ...args], { cwd: root, env, timeoutMs }); requireProcessSuccess(result); return result;
  };
  const inspect = async (type, id) => { const result = await run([type, "inspect", id]); const rows = JSON.parse(result.stdout); check(Array.isArray(rows) && rows.length === 1, "inspect-count"); return rows[0]; };
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
    const built = await run(args, 480000);
    imageId = (await readFile(iidFile, "utf8")).trim(); check(imagePattern.test(imageId), "image-build-result");
    native = parseImageBuildReceipt(built.stdout, context.contextHash);
  });
  const image = await report.step("image", async () => validateImage(await inspect("image", imageId), { derived: true, identity, id: imageId, contextHash: context.contextHash }));
  check(image.Config.Labels?.["org.openclaw.edge.nonce"] === nonce, "image-invocation");
  const plan = { image: imageId, identity, imageEnv: image.Config.Env, nonce, contextHash: context.contextHash, nativeHash: hash(JSON.stringify(native)) };
  const cidFile = join(root, "container-id"), failures = []; let cid, created, attached, waiting, bound, target, receipt, disposition = "retained";
  const readOwned = async () => validateContainerInspect(await inspect("container", cid), plan, cid);
  const recheckParent = async () => validateIdentity(await readParentIdentity(), identity);
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
    });
    await report.step("ready", () => attached.ready);
    await report.step("admission", async () => {
      await recheckParent(); const row = await readOwned(); check(row.State.Running && row.State.Pid > 1, "missing-live-init");
      target = validateTarget(await processEvidence(row.State.Pid), parentNamespaces, identity);
      bound = await bindCgroup(target, cid);
      // Parent and target kernel mount tables correlate the daemon's exact
      // per-container metadata paths without privileged storage traversal.
      const parentMounts = parseMounts(await readFile("/proc/self/mountinfo", "utf8"), false);
      const metadata = validateMetadataMounts(row, target.mounts, parentMounts, daemonRoot, cid);
      const again = await processEvidence(target.pid); check(again.start === target.start && same(again.namespaces, target.namespaces) && again.cgroup === target.cgroup, "init-identity-drift"); validateTarget(again, parentNamespaces, identity);
      check(same(metadata, validateMetadataMounts(row, again.mounts, parseMounts(await readFile("/proc/self/mountinfo", "utf8"), false), daemonRoot, cid)), "daemon-metadata-drift");
    });
    // READY keeps init alive before compilation. Starting wait only after the
    // running PID was admitted avoids observing an as-yet-unstarted container.
    waiting = runOwnedProcess(docker, ["--host=unix:///var/run/docker.sock", "wait", cid], { cwd: root, env, timeoutMs: 480000 });
    await report.step("permit", () => attached.permit());
    const outcomes = await report.step("wait", () => Promise.allSettled([attached.closed, waiting]));
    raiseContainerFailures(outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason));
    const attachResult = outcomes[0].value, waitResult = outcomes[1].value;
    receipt = await report.step("receipt", () => parseContainerReceipt(attachResult.stdout, plan));
    await report.step("terminal", async () => {
      await recheckParent(); const terminal = await readOwned();
      const cgroup = await report.step("cgroup", () => retiredCgroup(bound));
      validateTerminal({ wait: waitResult, attached: attachResult, inspect: terminal, cgroup, receipt });
    });
  } catch (error) { failures.push(error); }
  // Every acquired resource gets an independent cleanup attempt. A cleanup
  // outcome never supplies the passing terminal/cgroup proof above.
  if (cid && created) {
    const cleanupFailures = [];
    try { await report.step("retirement", async () => {
      try {
        const row = await readOwned();
        if (!bound && row.State.Running && row.State.Pid > 1) bound = await bindCgroup(await processEvidence(row.State.Pid), cid);
      } catch (error) { cleanupFailures.push(error); }
      try { await stopOwned(); } catch (error) { cleanupFailures.push(error); }
      const originals = await Promise.allSettled([...(attached ? [attached.closed] : []), ...(waiting ? [waiting] : [])]);
      for (const outcome of originals) if (outcome.status === "rejected") cleanupFailures.push(outcome.reason); else try { requireProcessSuccess(outcome.value); } catch (error) { cleanupFailures.push(error); }
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
export async function containerMain(action, args) {
  if (action === "container-ci" && args.length === 0) return containerCi();
  if (action === "container-prepare") return containerPrepare(args);
  if (action === "container-init") return containerInit(args);
  if (action === "container-build") return containerBuild(args);
  fail("container-action");
}
