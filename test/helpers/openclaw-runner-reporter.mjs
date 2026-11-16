import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Source-qualified D8 explicit-file plan, not an observed execution count.
export const runnerContract = Object.freeze({
  schema: "openclaw-native-runner.v1",
  pin: "d8bb939408aa4d2be7df0161748edb52ebf3b1fb",
  target: "extensions/qwen/worker-regions-contract.test.ts",
  expectedInvocations: 1,
});
export const reportByteLimit = 64 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const phases = ["run_start", "module_queued", "module_collected", "module_start", "module_end"];
const codes = ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_REQUIRE_ESM", "ERR_INVALID_PACKAGE_CONFIG"];
const names = ["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError", "URIError", "EvalError", "AggregateError"];
export const sha256 = value => createHash("sha256").update(value).digest("hex");

function keys(value, expected) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "closed runner record keys");
}
function count(value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000, "bounded runner count");
}
export function validateBinding(binding) {
  keys(binding, [...Object.keys(runnerContract), "fixtureSha256", "reporterSha256", "nonce",
    ...(Object.hasOwn(binding, "callsite") ? ["callsite"] : [])]);
  for (const [key, value] of Object.entries(runnerContract)) assert.equal(binding[key], value, "unsupported native runner plan");
  for (const key of ["fixtureSha256", "reporterSha256", "nonce"]) assert.match(binding[key], hashPattern);
  if (Object.hasOwn(binding, "callsite")) {
    const c = binding.callsite;
    keys(c, ["schema", "nonce", "pin", "target", "helperSHA", "fixtureSHA", "contract", "virtualSHA", "sources", "configSHA"]);
    assert.equal(c.schema, "qwen-value-overlay.v1");
    assert.equal(c.nonce, binding.nonce); assert.equal(c.pin, binding.pin);
    assert.equal(c.target, binding.target); assert.equal(c.fixtureSHA, binding.fixtureSha256);
    for (const key of ["helperSHA", "contract", "virtualSHA", "configSHA"]) assert.match(c[key], hashPattern);
    const originals = [
      { path: "packages/ai/src/providers/openai-provider-client.ts", sha256: "0c049068171de83e25e8c12cbbe9c24ad984280776ed47f3554e7beb50997e41" },
      { path: "src/agents/provider-transport-dispatcher-pool.ts", sha256: "fbdb819ace74f9aab0c5d9e9cc7c262e5959687258266f7d011524e8e99cb796" },
    ];
    assert.ok(Array.isArray(c.sources) && c.sources.length === 2);
    c.sources.forEach((row, index) => {
      keys(row, ["path", "sha256", "outputSHA"]);
      assert.equal(row.path, originals[index].path); assert.equal(row.sha256, originals[index].sha256);
      assert.match(row.outputSHA, hashPattern);
    });
    assert.equal(c.contract, sha256(JSON.stringify({ schema: c.schema, nonce: c.nonce, pin: c.pin,
      helperSHA: c.helperSHA, fixtureSHA: c.fixtureSHA, originals })), "worker contract/nonce binding");
  }
  return binding;
}

// Never evaluate error getters, messages, stacks, prototypes or arbitrary causes.
function ownField(error, key, allowed) {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  if (!descriptor) return { presence: "absent", value: "unknown" };
  if (!Object.hasOwn(descriptor, "value")) return { presence: "accessor", value: "unknown" };
  return {
    presence: descriptor.value === undefined ? "undefined" : "defined",
    value: allowed.includes(descriptor.value) ? descriptor.value : "unknown",
  };
}
export function projectRunnerError(error) {
  const received = error === null ? "null" : typeof error;
  const object = error !== null && (typeof error === "object" || typeof error === "function");
  const absent = () => ({ presence: "absent", value: "unknown" });
  return {
    received, originalPresence: "unknown",
    name: object ? ownField(error, "name", names) : absent(),
    code: object ? ownField(error, "code", codes) : absent(),
  };
}
function validateError(error) {
  keys(error, ["received", "originalPresence", "name", "code"]);
  assert.ok(["null", "undefined", "object", "function", "string", "number", "boolean", "bigint", "symbol"].includes(error.received));
  assert.equal(error.originalPresence, "unknown");
  for (const [key, allowed] of [["name", names], ["code", codes]]) {
    keys(error[key], ["presence", "value"]);
    assert.ok(["absent", "accessor", "undefined", "defined"].includes(error[key].presence));
    assert.ok(["unknown", ...allowed].includes(error[key].value));
    if (error[key].presence !== "defined") assert.equal(error[key].value, "unknown");
  }
}

// Descriptor retirement must preserve both outcomes, including throw undefined.
function closeRunnerDescriptor(fd, primaryFailed, primaryError) {
  try { closeSync(fd); }
  catch (closeError) {
    if (primaryFailed) throw new AggregateError([primaryError, closeError], "runner operation and descriptor close failed");
    throw closeError;
  }
  if (primaryFailed) throw primaryError;
}

export function readPrivateFile(file, limit) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let primaryFailed = false; let primaryError;
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size <= limit, "private bounded runner file");
    // Even a concurrent grower cannot turn this into an unbounded read/allocation.
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, size);
      if (n === 0) break;
      size += n;
    }
    assert.ok(size <= limit, "runner report grew past bound");
    return bytes.subarray(0, size);
  } catch (error) { primaryFailed = true; primaryError = error; }
  finally { closeRunnerDescriptor(fd, primaryFailed, primaryError); }
}

export function parseRunnerReport(bytes, binding) {
  validateBinding(binding);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= reportByteLimit, "bounded runner report");
  const text = bytes.toString("utf8");
  assert.ok(Buffer.from(text).equals(bytes) && text.endsWith("\n"), "complete UTF-8 runner records");
  const lines = text.slice(0, -1).split("\n");
  assert.ok(lines.length <= 512, "bounded runner record count");
  const records = lines.map(line => {
    const row = JSON.parse(line);
    // Our writer is canonical: duplicates, preambles and noncanonical encodings fail closed.
    assert.equal(JSON.stringify(row), line, "canonical runner record");
    return row;
  });
  let ready = 0; let results = 0; let errors = 0; let ended = false;
  const observed = new Set();
  for (const [index, row] of records.entries()) {
    assert.equal(row.seq, index); assert.equal(ended, false, "record after runner end");
    if (index === 0) {
      keys(row, ["kind", "seq", "binding"]); assert.equal(row.kind, "init");
      assert.deepEqual(row.binding, binding, "runner provenance mismatch");
    } else if (row.kind === "phase") {
      keys(row, ["kind", "seq", "phase", "count"]);
      assert.ok(phases.includes(row.phase) && !observed.has(row.phase));
      count(row.count); assert.ok(row.count <= 1, "multiple native modules");
      observed.add(row.phase);
    } else if (row.kind === "case") {
      keys(row, ["kind", "seq", "phase", "ready", "results"]);
      assert.ok(["ready", "result"].includes(row.phase));
      if (row.phase === "ready") ready++; else results++;
      assert.equal(row.ready, ready); assert.equal(row.results, results);
      count(ready); count(results);
    } else if (row.kind === "error") {
      keys(row, ["kind", "seq", "surface", "error"]);
      assert.ok(["collection", "unhandled"].includes(row.surface));
      validateError(row.error); errors++;
    } else {
      keys(row, ["kind", "seq", "reason", "ready", "results", "errors", "omitted", "complete"]);
      assert.equal(row.kind, "end");
      assert.ok(["passed", "failed", "interrupted"].includes(row.reason));
      for (const key of ["ready", "results", "errors", "omitted"]) count(row[key]);
      assert.ok(row.ready >= ready && row.results >= results && row.errors >= errors);
      assert.equal(row.complete, row.omitted === 0);
      if (row.complete) {
        assert.equal(row.ready, ready); assert.equal(row.results, results); assert.equal(row.errors, errors);
      }
      ended = true;
    }
  }
  return { records, complete: ended && records.at(-1).complete, bytes: bytes.length, sha256: sha256(bytes) };
}

export default class NativeRunnerReporter {
  #file; #binding; #inode; #sequence = 0; #bytes = 0; #ready = 0; #results = 0; #errors = 0; #omitted = 0;
  #root; #ended = false; #phases = new Set(); #readyCases = new WeakSet(); #resultCases = new WeakSet();

  onInit(ctx) {
    assert.equal(this.#file, undefined, "runner reporter initialized twice");
    assert.equal(ctx.version, "5.0.5", "unqualified native reporter API");
    assert.ok(ctx.projects.length === 1 && ctx.projects[0].name === "extension-providers", "unqualified native project plan");
    assert.equal(typeof ctx.config.outputFile, "string", "explicit runner output required");
    this.#file = resolve(ctx.config.outputFile); this.#root = resolve(ctx.config.root);
    const plan = readPrivateFile(join(dirname(this.#file), "plan.json"), 4096);
    this.#binding = validateBinding(JSON.parse(plan.toString("utf8")));
    assert.equal(sha256(readFileSync(fileURLToPath(import.meta.url))), this.#binding.reporterSha256);
    assert.equal(sha256(readFileSync(join(this.#root, this.#binding.target))), this.#binding.fixtureSha256);
    if (this.#binding.callsite) {
      const directory = dirname(this.#file), c = this.#binding.callsite;
      assert.equal(dirname(directory), this.#root, "owned explicit config root");
      assert.equal(sha256(readFileSync(join(directory, "callsite-observer.mjs"))), c.helperSHA);
      assert.equal(sha256(readPrivateFile(join(directory, "worker-values.mjs"), 65536)), c.virtualSHA);
      assert.equal(sha256(readPrivateFile(join(directory, "qwen-callsite.config.ts"), 8192)), c.configSHA);
      // Output hashes bind source supplied to Vite, not final emitted JS or
      // activation. Activation is observed separately inside the worker sink.
      for (const row of c.sources) assert.equal(sha256(readFileSync(join(this.#root, row.path))), row.sha256);
    }
    const fd = openSync(this.#file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let primaryFailed = false; let primaryError;
    try { this.#inode = fstatSync(fd).ino; }
    catch (error) { primaryFailed = true; primaryError = error; }
    finally { closeRunnerDescriptor(fd, primaryFailed, primaryError); }
    this.#write({ kind: "init", binding: this.#binding });
  }
  #write(value, final = false) {
    assert.ok(this.#file && !this.#ended, "runner report lifecycle");
    const bytes = Buffer.from(`${JSON.stringify({ ...value, seq: this.#sequence })}\n`);
    if (!final && (this.#bytes + bytes.length > reportByteLimit - 1024 || this.#sequence >= 510)) {
      this.#omitted++; return;
    }
    assert.ok(this.#bytes + bytes.length <= reportByteLimit, "runner final report bound");
    const fd = openSync(this.#file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let primaryFailed = false; let primaryError;
    try {
      const stat = fstatSync(fd);
      assert.ok(stat.isFile() && stat.ino === this.#inode && stat.size === this.#bytes && (stat.mode & 0o777) === 0o600, "runner report replaced");
      let offset = 0;
      while (offset < bytes.length) { const n = writeSync(fd, bytes, offset); assert.ok(n > 0); offset += n; }
      this.#bytes += bytes.length; this.#sequence++;
    } catch (error) { primaryFailed = true; primaryError = error; }
    finally { closeRunnerDescriptor(fd, primaryFailed, primaryError); }
  }
  #module(module) {
    assert.equal(resolve(module.moduleId), join(this.#root, this.#binding.target), "foreign runner module");
  }
  #phase(phase, modules) {
    assert.ok(!this.#phases.has(phase) && modules.length <= 1, "duplicate or multiple native invocation");
    for (const module of modules) this.#module(module);
    this.#phases.add(phase); this.#write({ kind: "phase", phase, count: modules.length });
  }
  onTestRunStart(specs) { this.#phase("run_start", specs); }
  onTestModuleQueued(module) { this.#phase("module_queued", [module]); }
  onTestModuleCollected(module) { this.#phase("module_collected", [module]); }
  onTestModuleStart(module) { this.#phase("module_start", [module]); }
  onTestModuleEnd(module) { this.#phase("module_end", [module]); }
  onTestCaseReady(test) {
    this.#module(test.module); assert.ok(!this.#readyCases.has(test), "duplicate ready case");
    this.#readyCases.add(test); this.#ready++;
    this.#write({ kind: "case", phase: "ready", ready: this.#ready, results: this.#results });
  }
  onTestCaseResult(test) {
    this.#module(test.module); assert.ok(!this.#resultCases.has(test), "duplicate result case");
    this.#resultCases.add(test); this.#results++;
    this.#write({ kind: "case", phase: "result", ready: this.#ready, results: this.#results });
  }
  #capture(surface, errors) {
    assert.ok(Array.isArray(errors), "native serialized error list");
    for (const error of errors) {
      this.#errors++;
      if (this.#errors > 32) { this.#omitted++; continue; }
      this.#write({ kind: "error", surface, error: projectRunnerError(error) });
    }
  }
  onTestRunEnd(modules, unhandledErrors, reason) {
    assert.ok(modules.length <= 1 && ["passed", "failed", "interrupted"].includes(reason));
    for (const module of modules) { this.#module(module); this.#capture("collection", module.errors()); }
    this.#capture("unhandled", unhandledErrors);
    this.#write({ kind: "end", reason, ready: this.#ready, results: this.#results, errors: this.#errors, omitted: this.#omitted, complete: this.#omitted === 0 }, true);
    this.#ended = true;
  }
}
