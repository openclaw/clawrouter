import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { API } from "typescript/unstable/sync";
import { isCallExpression, isPropertyAccessExpression, isNewExpression, isFunctionDeclaration } from "typescript/unstable/ast/is";
import { edgeProof } from "./edge-proof-profile.mjs";

const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { build } = require("esbuild");
const sha256 = value => createHash("sha256").update(value).digest("hex");
export const anchors = {
  "worker/proxy.ts": "d0d50156e1325bdd1ec52f4c6a52b07e22f8e64d",
  "worker/proxy-response.ts": "80175af44a0b1845c6120d7c1a17a38e5aa765d5",
  "worker/input-retirement.ts": "6705ceb06309b5c7231e7b78d313c0410e46599e",
  "worker/model-discovery.ts": "779313fd25291d0e6c7f8db4dee703b196258693",
};
export const occurrenceCounts = {
  "worker/proxy.ts": { reader: 2, factory: 2, read: 1, response: 1, fetch: 3 },
  "worker/proxy-response.ts": { reader: 4, factory: 1, read: 5, response: 3, cancel: 4, releaseLock: 7 },
  "worker/input-retirement.ts": { cancel: 1, releaseLock: 1 },
  "worker/model-discovery.ts": { reader: 2, factory: 2, read: 2, cancel: 1, releaseLock: 1, response: 1 },
};
export const frozenGitEnvironment = Object.freeze({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
export function validateGitExecutable(options) {
  if (!options || Object.getOwnPropertyNames(options).sort().join() !== "env,executable,sha256") throw new Error("edge-proof: Git attestation required");
  const data = key => { const d = Object.getOwnPropertyDescriptor(options, key); if (!d || !("value" in d)) throw new Error("edge-proof: Git data required"); return d.value; };
  const executable = data("executable"), expected = data("sha256"), env = data("env");
  if (typeof executable !== "string" || !isAbsolute(executable) || realpathSync(executable) !== executable || !lstatSync(executable).isFile() || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || sha256(readFileSync(executable)) !== expected) throw new Error("edge-proof: immutable Git identity mismatch");
  if (!env || Object.getOwnPropertyNames(env).sort().join() !== Object.keys(frozenGitEnvironment).sort().join() || Object.entries(frozenGitEnvironment).some(([key, value]) => Object.getOwnPropertyDescriptor(env, key)?.value !== value)) throw new Error("edge-proof: Git environment mismatch");
  return { executable, env: { ...frozenGitEnvironment } };
}
function git(cwd, options, ...args) {
  if (options === undefined) return execFileSync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  const admitted = validateGitExecutable(options);
  return execFileSync(admitted.executable, args, { cwd, env: admitted.env, maxBuffer: 32 * 1024 * 1024 });
}
export function frozenSource(cwd, sha = edgeProof.sourceSha, gitOptions) {
  if (sha !== edgeProof.sourceSha || git(cwd, gitOptions, "rev-parse", sha + "^{tree}").toString().trim() !== edgeProof.sourceTree) throw new Error("edge-proof: immutable source identity mismatch");
  const entries = git(cwd, gitOptions, "ls-tree", "-rz", sha, "--", "worker", "shared", "providers", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "admin/package.json").toString().split("\0").filter(Boolean).map(line => {
    const [meta, path] = line.split("\t"), [mode, kind, oid] = meta.split(" ");
    if (!["100644", "100755"].includes(mode) || kind !== "blob" || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes("..")) throw new Error("edge-proof: unsupported source entry");
    return { path, mode, oid };
  }).filter(entry => !entry.path.startsWith("worker/test/") && !entry.path.startsWith("worker/fixtures/"));
  let size = 0;
  return entries.map(entry => { const bytes = git(cwd, gitOptions, "cat-file", "blob", entry.oid); size += bytes.length; if (size > 32 * 1024 * 1024) throw new Error("edge-proof: capsule capacity exceeded"); return { ...entry, bytes, sha256: sha256(bytes) }; });
}
export function instrumentAst(file, source, expectedBlob) {
  const actual = createHash("sha1").update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest("hex");
  if (actual !== expectedBlob || source.includes("edgeObserve") || source.includes("/*edge:")) throw new Error("edge-proof: source anchor mismatch");
  const patches = [], counts = {};
  function add(node, prefix, suffix, kind) {
    const start = node.getStart(file), end = node.end;
    patches.push({ start, end, prefix, suffix, original: source.slice(start, end), kind });
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  function visit(node, responseOwner = false) {
    if (isFunctionDeclaration(node)) responseOwner = node.parameters.some(param => param.name.getText(file) === "response");
    if (isCallExpression(node)) {
      const expression = node.expression;
      if (isPropertyAccessExpression(expression)) {
        const method = expression.name.getText(file), receiver = expression.expression.getText(file);
        if (method === "getReader" && receiver.startsWith("response.body")) add(node, `edgeObserve("reader", ${receiver}, () => (`, "))", "reader");
        else if (receiver === "reader" && ["read", "cancel", "releaseLock"].includes(method)) add(node, `edgeObserve("${method === "releaseLock" ? "unlock" : method}", reader, () => (`, "))", method);
      }
      if (expression.getText(file) === "fetch" && node.arguments[0]?.getText(file) === "prepared.url") add(expression, "edgeFetch(", ", request)", "fetch");
      if (expression.getText(file) === "inputRetirement") add(expression, "edgeFactory(", ")", "factory");
    }
    if (responseOwner && isNewExpression(node) && node.expression.getText(file) === "Response") add(node, "edgeTransfer((", "), response)", "response");
    node.forEachChild(child => visit(child, responseOwner));
  }
  visit(file);
  patches.sort((a, b) => a.start - b.start);
  let text = source;
  const insertions = patches.flatMap((patch, index) => [
    { at: patch.start, text: `/*edge:${index}:start*/${patch.prefix}` },
    { at: patch.end, text: `${patch.suffix}/*edge:${index}:end*/` },
  ]).sort((a, b) => b.at - a.at);
  for (const insertion of insertions) text = text.slice(0, insertion.at) + insertion.text + text.slice(insertion.at);
  const prelude = 'import { edgeObserve, edgeTransfer, edgeFactory, edgeFetch } from "./edge-proof-observer.ts";\n';
  text = prelude + text;
  if (eraseInstrumentation(text, patches) !== source) throw new Error("edge-proof: erasure mismatch");
  return { text, patches, counts, sha256: sha256(text) };
}
export function eraseInstrumentation(text, patches) {
  let erased = text.replace(/^import \{ edgeObserve, edgeTransfer, edgeFactory, edgeFetch \} from "\.\/edge-proof-observer.ts";\n/, "");
  for (const [index, patch] of patches.entries()) {
    for (const marked of [`/*edge:${index}:start*/${patch.prefix}`, `${patch.suffix}/*edge:${index}:end*/`]) {
      if (erased.split(marked).length !== 2) throw new Error("edge-proof: changed or duplicate instrumentation marker");
      erased = erased.replace(marked, "");
    }
  }
  return erased;
}
export async function materializeRuntimeDependencies(cwd, root) {
  const ownedModules = await realpath(join(cwd, "node_modules")), inputs = [];
  let bytesTotal = 0;
  await mkdir(join(root, "node_modules"));
  for (const name of ["stream-chain", "stream-json"]) {
    const packageRoot = await realpath(join(ownedModules, name));
    const contained = relative(ownedModules, packageRoot);
    if (contained.startsWith("../") || isAbsolute(contained)) throw new Error("edge-proof: dependency escapes owned installation");
    async function copy(directory, prefix = "") {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const suffix = prefix + entry.name, path = `node_modules/${name}/${suffix}`, target = join(root, path);
        if (entry.isDirectory()) { await mkdir(target, { recursive: true }); await copy(join(directory, entry.name), suffix + "/"); }
        else if (entry.isFile()) {
          const bytes = await readFile(join(directory, entry.name)); bytesTotal += bytes.length;
          if (inputs.length >= 512 || bytesTotal > 4 * 1024 * 1024) throw new Error("edge-proof: runtime dependency capacity exceeded");
          await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
          if (!(await readFile(target)).equals(bytes)) throw new Error("edge-proof: dependency byte mismatch");
          inputs.push({ path, sha256: sha256(bytes) });
        } else throw new Error("edge-proof: unsupported runtime dependency entry");
      }
    }
    await copy(packageRoot);
  }
  return inputs;
}
export async function bundleCapsule(root) {
  const bundles = {}, base = await realpath(root);
  for (const [kind, name] of [["edge", "edge-native-cancellation"], ["upstream", "edge-native-upstream"]]) {
    // Keep the native resolver and original input bytes. Both source and exact
    // dependency packages are inside the capsule, so emitted module IDs are
    // stable relative paths rather than private home/temporary locations.
    const result = await build({ absWorkingDir: base, entryPoints: [join(base, `worker/fixtures/${name}.ts`)], outfile: join(base, `${kind}.mjs`), bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"], metafile: true, logLevel: "silent" });
    for (const input of Object.keys(result.metafile.inputs)) {
      const path = relative(base, await realpath(resolve(base, input)));
      if (path.startsWith("../") || isAbsolute(path)) throw new Error("edge-proof: bundle input escapes capsule");
    }
    const bytes = await readFile(join(base, `${kind}.mjs`));
    if (bytes.includes(base) || bytes.includes("/Users/") || bytes.includes("/home/")) throw new Error("edge-proof: private bundle path");
    bundles[kind] = sha256(bytes);
  }
  return bundles;
}
export async function buildCapsule(cwd, output, gitOptions) {
  if (process.version !== "v24.22.1" || process.versions.modules !== "137") throw new Error("edge-proof: unqualified build runtime");
  const root = resolve(output);
  await mkdir(root, { recursive: false });
  const files = frozenSource(cwd, edgeProof.sourceSha, gitOptions);
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "admin/package.json"]) {
    if (!files.find(row => row.path === name)?.bytes.equals(await readFile(join(cwd, name)))) throw new Error("edge-proof: dependency input mismatch");
  }
  for (const entry of files) { const target = join(root, entry.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, entry.bytes, { flag: "wx", mode: 0o600 }); }
  const observerSource = await readFile(join(cwd, "worker/fixtures/edge-native-cancellation.ts"), "utf8");
  const begin = "// BEGIN EDGE OBSERVER\n", end = "// END EDGE OBSERVER";
  if (observerSource.split(begin).length !== 2 || observerSource.split(end).length !== 2) throw new Error("edge-proof: observer source boundary mismatch");
  const observer = observerSource.split(begin)[1].split(end)[0];
  await writeFile(join(root, "worker/edge-proof-observer.ts"), observer, { flag: "wx", mode: 0o600 });
  const imports = 'import { edgeIngress, edgeTask, edgeJoin } from "../edge-proof-observer.ts";\n';
  const currentUsage = 'import { usageSnapshot } from "../usage-ledger-client.ts";\n';
  const currentEntry = imports + observerSource.split(end)[1];
  // The current harness runs against the frozen Worker, whose ledger owns this read.
  if (currentEntry.split(currentUsage).length !== 2) throw new Error("edge-proof: frozen usage import mismatch");
  const entry = currentEntry.replace(currentUsage, 'import { usageSnapshot } from "../ledgers.ts";\n');
  await mkdir(join(root, "worker/fixtures"));
  await writeFile(join(root, "worker/fixtures/edge-native-cancellation.ts"), entry, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "worker/fixtures/edge-native-upstream.ts"), await readFile(join(cwd, "worker/fixtures/edge-native-upstream.ts")), { flag: "wx", mode: 0o600 });
  const config = join(root, "edge-parse.json");
  await writeFile(config, JSON.stringify({ compilerOptions: { noResolve: true, noLib: true }, files: Object.keys(anchors) }), { flag: "wx", mode: 0o600 });
  const api = new API({ cwd: root });
  const receipt = [];
  try {
    using snapshot = api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    if (!project) throw new Error("edge-proof: source parser unavailable");
    for (const [path, anchor] of Object.entries(anchors)) {
      const frozen = files.find(entry => entry.path === path);
      if (!anchor || frozen?.oid !== anchor) throw new Error("edge-proof: missing frozen AST anchor");
      const tree = project.program.getSourceFile(join(root, path));
      if (!tree) throw new Error("edge-proof: source AST missing");
      const transformed = instrumentAst(tree, frozen.bytes.toString(), anchor);
      if (JSON.stringify(Object.entries(transformed.counts).sort()) !== JSON.stringify(Object.entries(occurrenceCounts[path]).sort())) throw new Error("edge-proof: AST occurrence census changed");
      await writeFile(join(root, path), transformed.text, { mode: 0o600 });
      receipt.push({ path, blob: anchor, originalSha256: frozen.sha256, instrumentedSha256: transformed.sha256, counts: transformed.counts, erasureExact: true });
    }
  } finally { api.close(); }
  const dependencyInputs = await materializeRuntimeDependencies(cwd, root);
  const bundles = await bundleCapsule(root);
  const harnessInputs = {};
  for (const path of ["scripts/edge-proof-build.mjs", "config/deployments/edge-proof.json", "worker/fixtures/edge-native-cancellation.ts", "worker/fixtures/edge-native-upstream.ts", "wrangler.edge-proof.toml", "wrangler.edge-proof-upstream.toml"]) harnessInputs[path] = sha256(await readFile(join(cwd, path)));
  return { sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, sourceFiles: files.map(({ path, oid, sha256 }) => ({ path, blob: oid, sha256 })), instrumentation: receipt, observerSha256: sha256(observer), harnessInputs, bundles, dependencyInputs, runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch }, classification: "instrumented-frozen-candidate-edge-composition" };
}
