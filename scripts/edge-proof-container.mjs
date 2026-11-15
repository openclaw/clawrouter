import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, realpath, readlink, readdir, lstat, stat, open, opendir } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { edgeProof } from "./edge-proof-profile.mjs";
import { runOwnedProcess, requireProcessSuccess, qualifyInstalledInputs, namespaceEvidence, namespaceIdentity, prepareEnvironment, runPackagingPipeline, createPackagingDiagnostics, createContainerDiagnostics, emitContainerFailure, imageBuildStages, nativePrepareStages, validateEnumerationDetail, createInitDiagnostics, initPrerequisiteStages, attachFailureBranches, validateContainerDiagnostic, initGuardTags, initSourcePhases, validateInitDetail, mountTargets, mountFilesystems, validateMountDetail, validateMaskDetail, parentAdmissionSources, parentAdmissionPredicates, parentAdmissionRoles, validateParentAdmission } from "./edge-proof.mjs";
export { validateContainerDiagnostic, emitContainerFailure } from "./edge-proof.mjs";

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
const exactKeys = (value, keys) => check(same(Object.getOwnPropertyNames(value).sort(), [...keys].sort()), "data-keys");
export function raiseContainerFailures(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "edge-container: independent failures");
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
  check(parentEvaluate(recorder, 17, () => parentLeaf(recorder, 1, same(c.Entrypoint, [containerContract.node])) && parentLeaf(recorder, 2, same(c.Cmd, expected.slice(expected.indexOf(plan.image) + 1))) && parentLeaf(recorder, 3, c.User === `${plan.identity.uid[0]}:${plan.identity.gid[0]}`) && parentLeaf(recorder, 4, c.WorkingDir === "/task")), "container-command");
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
async function qualifyImageInputs(contextHash, prepare) {
  prepare?.enter("runtime");
  check(process.platform === "linux" && process.arch === "x64" && process.version === "v24.22.1" && process.versions.modules === "137", "image-runtime");
  const root = containerContract.input;
  prepare?.enter("context_read");
  const inputPlan = JSON.parse(await readFile(join(root, ".edge-context.json"), "utf8"));
  prepare?.enter("context_identity");
  check(hash(JSON.stringify(inputPlan.files)) === contextHash && inputPlan.sourceSha === edgeProof.sourceSha && inputPlan.sourceTree === edgeProof.sourceTree, "context-identity");
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
  const result = { version: 2, contextHash, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, install: { ...installInputs }, runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, pnpm: "11.28.4" }, native, containedLinks };
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
const containsMountPath = (parent, path) => parent === "/" || path === parent || path.startsWith(parent + "/");
const mountTuple = row => ({ id: row.id, parentId: row.parentId, target: row.target, root: row.root, device: row.device, fs: row.fs, options: [...row.options].sort(), superOptions: [...row.superOptions].sort(), optional: [...row.optional].sort() });
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
  mountTable(parentMounts, recorder); mountTable(targetMounts, recorder);
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
export function validateMaskCompletion(value) {
  check(Array.isArray(value) && value.length === 6 && value[0] === 1 && Number.isInteger(value[1]) && value[1] >= 0 && value[1] < 4096 && value.slice(2, 5).every(n => n === value[1]) && value[5] === "UNOBSERVABLE", "mask-completion");
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
function cgroupMapping(rows, recorder) {
  mountTable(rows);
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
  parentSource(recorder, "cgroup_limits_group");
  validateLimits(Object.fromEntries(await Promise.all([["memory", "memory.max"], ["swap", "memory.swap.max"], ["pids", "pids.max"], ["cpu", "cpu.max"]].map(async ([key, name]) => [key, await io.read(join(path, name), "utf8")]))), (parentSource(recorder, "cgroup_limits"), recorder));
  return { path, dev: inode.dev, ino: inode.ino, parentDev: parent.dev, parentIno: parent.ino, mountDev: mount.dev, mountIno: mount.ino };
}
export function createParentCgroupAdmission(cid, parentNamespaces, identity, supplied = {}) {
  const io = { read: readFile, link: readlink, realpath, stat, evidence: processEvidence, ...supplied };
  const owner = { active: null, next: 1, complete: null, failed: false };
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
      parentSource(recorder, "parent_mount_read"); const parentMounts = parseMounts(await io.read("/proc/self/mountinfo", "utf8"), false, (parentSource(recorder, "parent_mount_parse"), recorder));
      parentSource(recorder, "cgroup_relation");
      const targetNs = { mnt: target.namespaces.mnt, cgroup: target.namespaces.cgroup };
      cgroupCheck(recorder, 46, validCgroupStamp(targetNs) && targetNs.cgroup !== before.cgroup && targetNs.mnt !== before.mnt && target.pid === pid);
      const membership = ownedMembership(target.cgroup, cid, recorder), mapping = cgroupMapping(parentMounts, recorder);
      view = { owner, active: true, valid: false, visit, cid, target, rows: target.mounts, rowSnapshot: target.mounts.map(mountTuple), stamp: { pid: target.pid, start: target.start }, membership, mapping, before, targetNs };
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
    check(same(cgroupMapping(parseMounts(await read("/proc/self/mountinfo", "utf8"), false)), view.mapping), "retirement-mapping-drift");
  };
  await snapshot();
  const mount = await statPath(view.mapping.target, { bigint: true }); check(physicalDirectory(mount) && mount.dev === bound.mountDev && mount.ino === bound.mountIno, "cgroup-mapping-replaced");
  const parent = await statPath(dirname(bound.path), { bigint: true }); check(physicalDirectory(parent) && parent.dev === bound.parentDev && parent.ino === bound.parentIno, "cgroup-parent-replaced");
  let disposition;
  try {
    const current = await statPath(bound.path, { bigint: true }); check(physicalDirectory(current) && current.dev === bound.dev && current.ino === bound.ino, "cgroup-replaced");
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
export function createAttachProjection(attached, plan, report) {
  const binding = { attached, cid: plan.cid, nonce: plan.nonce, contextHash: plan.contextHash }; let projected = false;
  return result => {
    if (projected) return; projected = true;
    const retain = operation => { try { operation(); } catch (error) { attached.result.errors.push(error); } };
    retain(() => {
      check(result === attached.result && result.supervisor[5], "attach-original-unsettled");
      report.internal(validateContainerDiagnostic({ v: 6, phase: "attach_process", state: "observed", exit: result.code, signal: result.signal, closed: result.closed, timedOut: result.timedOut, interrupted: result.interrupted,
        errors: result.errors.length, undefinedErrors: result.errors.filter(error => error === undefined).length, supervisor: [...result.supervisor], ready: result.readyAccepted, first: result.firstBranch, branches: result.branches,
        capture: [result.outputSummary.stdout?.complete === true, result.outputSummary.stderr?.complete === true] }));
    });
    retain(() => report.internal(parseInitPrerequisites(result, binding)));
  };
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
  initGuardCheck(builder ? process.pid > 1 && process.ppid === 1 : process.pid === 1, "container-init-ancestry", recorder, "ancestry");
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
    const keys = "v,context,nonce,seq,stage,event,outcome,defined,reportFailures,undefinedReportFailures" + (row && Object.hasOwn(row, "enumeration") ? ",enumeration" : "");
    if (!row || Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).join() !== keys || JSON.stringify(row) !== line.slice(prefix.length)) return unknown("invalid");
    if (row.v !== 1 || row.context !== identity.contextHash || row.nonce !== identity.nonce || row.seq !== count + 1) return unknown("invalid");
    count++;
    if (row.event === "entered") {
      if (Object.hasOwn(row, "enumeration") || entered >= nativePrepareStages.length || row.stage !== nativePrepareStages[entered++] || [row.outcome, row.defined, row.reportFailures, row.undefinedReportFailures].some(value => value !== null)) return unknown("invalid");
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
      terminal = row;
    } else return unknown("invalid");
  }
  if (!terminal) return unknown(count ? "incomplete" : "no_records", count);
  if (terminal.outcome === "complete" ? outer.reason !== "complete" || own(result, "code") !== 0 : outer.reason !== "validated_failure" || own(result, "code") === 0) return unknown("outer_inconsistent");
  return { v: 5, phase: "native_prepare_internal", state: terminal.outcome === "complete" ? "observed" : "rejected", stage: terminal.outcome === "original_failure" ? terminal.stage : null, defined: terminal.defined, records: count, reason: terminal.outcome, reportFailures: terminal.reportFailures, undefinedReportFailures: terminal.undefinedReportFailures, ...(Object.hasOwn(terminal, "enumeration") ? { enumeration: terminal.enumeration } : {}) };
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
export function parseContainerReceipt(text, plan) {
  const lines = text.split("\n").filter(line => line.startsWith("EDGE_CONTAINER_RECEIPT_V2 "));
  check(lines.length === 1 && Buffer.byteLength(lines[0]) <= 8192, "container-receipt-count");
  const receipt = JSON.parse(lines[0].slice("EDGE_CONTAINER_RECEIPT_V2 ".length));
  exactKeys(receipt, ["version", "isolation", "nonce", "contextHash", "nativeHash", "sourceSha", "sourceTree", "sourceFiles", "dependencyFiles", "exactErasures", "twoRoots", "cliSha256", "results", "cloud", "sdk", "masks"]);
  check(receipt.version === 2 && receipt.isolation === "private-container-pid-net-mount" && receipt.nonce === plan.nonce && receipt.contextHash === plan.contextHash && receipt.nativeHash === plan.nativeHash && receipt.sourceSha === edgeProof.sourceSha && receipt.sourceTree === edgeProof.sourceTree && receipt.sourceFiles === 600 && receipt.dependencyFiles === 268 && receipt.exactErasures === 4 && receipt.twoRoots === true && receipt.cliSha256 === containerContract.cliHash && receipt.sdk === "UNRUN" && receipt.cloud === "UNRUN", "container-receipt-identity");
  validateMaskCompletion(receipt.masks);
  exactKeys(receipt.results, ["edge", "upstream"]);
  for (const result of Object.values(receipt.results)) { exactKeys(result, ["code", "signal", "closed", "sha256", "observedProcesses"]); check(result.code === 0 && result.signal === null && result.closed === true && hashPattern.test(result.sha256) && Number.isSafeInteger(result.observedProcesses) && result.observedProcesses >= 1, "container-wrangler-result"); }
  return receipt;
}
async function containerInit(args, sharedReport) {
  let identity, masks; const trace = createInitDiagnostics(), ledger = createInitGuardLedger(); if (sharedReport) sharedReport.init = trace;
  const native = await runInitPrerequisites(args, trace, {
    arguments: values => check(values.length === 4 && hashPattern.test(values[0]) && hashPattern.test(values[1]), "init-arguments"),
    identity: ([nonce, contextHash, uid, gid]) => (identity = { uid: Array(4).fill(number(uid)), gid: Array(4).fill(number(gid)), groups: [] }),
    reset: () => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, containerEnvironment()); },
    prepare: () => prepareEnvironment("/task"), runtime: async identity => { masks = await validateContainerRuntime(identity, false, ledger, true); }, native: contextHash => nativeReceipt(contextHash, ledger),
    ready: (nonce, contextHash) => process.stdout.write(control("ready", nonce, contextHash)), permit: (nonce, contextHash) => receivePermit(nonce, contextHash),
  }, ledger);
  const [nonce, contextHash, uid, gid] = args;
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
  const receipt = { version: 2, isolation: "private-container-pid-net-mount", nonce, contextHash, nativeHash: hash(JSON.stringify(native)), masks, ...packaging };
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
async function containerPrepare(args, prepare) {
  prepare?.enter("prepare_arguments");
  check(args.length === 1 && hashPattern.test(args[0]), "prepare-arguments");
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
  const cidFile = join(root, "container-id"), failures = [], admissionReporting = []; let cid, created, attached, projectAttach, waiting, bound, target, receipt, disposition = "retained";
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
    });
    await report.step("ready", () => attached.ready);
    await report.step("admission", async () => {
      const recorder = createParentAdmissionLedger(), cgroups = createParentCgroupAdmission(cid, parentNamespaces, identity);
      const project = (original, reason) => { try { const detail = recorder.finish(original, reason); if (detail) report.internal(detail); } catch (error) { recorder.errors.push(error); } };
      try {
      await recheckParent(recorder); const row = await readOwned(recorder); parentSource(recorder, "live_init"); check(parentEvaluate(recorder, 37, () => parentLeaf(recorder, 1, row.State.Running) && parentLeaf(recorder, 2, row.State.Pid > 1)), "missing-live-init");
      const first = await cgroups.observe(row.State.Pid, 1, recorder); target = first.target; bound = first.bound;
      // Parent and target kernel mount tables correlate the daemon's exact
      // per-container metadata paths without privileged storage traversal.
      parentSource(recorder, "parent_namespace"); const currentNamespace = await readlink("/proc/self/ns/mnt"); check(parentEvaluate(recorder, 38, () => parentLeaf(recorder, 1, currentNamespace === parentNamespaces.mnt)), "parent-mount-namespace-drift");
      const parentMounts = first.parentMounts;
      parentSource(recorder, "metadata"); const metadata = validateMetadataMounts(row, target.mounts, parentMounts, daemonRoot, cid, recorder);
      parentRecord(recorder, "visit", 2); const second = await cgroups.observe(target.pid, 2, recorder), again = second.target; parentSource(recorder, "identity_freshness"); check(parentEvaluate(recorder, 39, () => parentLeaf(recorder, 1, again.start === target.start) && parentLeaf(recorder, 2, same(again.namespaces, target.namespaces)) && parentLeaf(recorder, 3, again.cgroup === target.cgroup)), "init-identity-drift");
      parentSource(recorder, "mount_freshness"); validateMountFreshness(target.mounts, again.mounts, recorder);
      const rebound = second.bound; parentSource(recorder, "cgroup_freshness"); check(parentEvaluate(recorder, 40, () => parentLeaf(recorder, 1, sameCgroupBinding(bound, rebound))), "init-cgroup-drift"); bound = rebound;
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
    receipt = await report.step("receipt", () => parseContainerReceipt(attachResult.stdout, plan));
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
      for (const outcome of originals) if (outcome.status === "rejected") cleanupFailures.push(outcome.reason); else try { if (attached && outcome.value === attached.result) projectAttach(outcome.value); requireProcessSuccess(outcome.value); } catch (error) { cleanupFailures.push(error); }
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
  fail("container-action");
}
