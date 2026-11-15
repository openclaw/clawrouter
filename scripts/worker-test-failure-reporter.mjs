import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

const failureTypes = new Set(["testCodeFailure", "subtestsFailed", "testTimeoutFailure", "cancelledByParent", "parentAlreadyFinished", "hookFailed", "testAborted"]);
const codes = new Set(["ERR_TEST_FAILURE", "ERR_ASSERTION", "ERR_ASSERTION_ERROR", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_INVALID_ARG_TYPE"]);
const filePattern = /^(?:worker\/)?test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/;
const limit = 1_000_000;

// Do not inspect names, messages, causes, aggregate members or accessors.
function own(value, key) {
  if (value === null || !["object", "function"].includes(typeof value) || types.isProxy(value)) return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? { present: true, value: descriptor.value } : { present: false };
}

function trackedTestFiles(cwd) {
  try {
    const git = args => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const root = realpathSync(git(["rev-parse", "--show-toplevel"]).trim());
    const lexicalRoot = resolve(cwd, relative(realpathSync(cwd), root));
    const files = new Set(git(["ls-files", "--stage", "-z", "--", ":(top)worker/test", ":(top)test"]).split("\0")
      .map(entry => /^(?:100644|100755) [0-9a-f]{40,64} 0\t(.+)$/.exec(entry)?.[1])
      .filter(file => file && file.length <= 240 && filePattern.test(file)));
    return value => {
      if (typeof value !== "string" || /[\\\x00-\x1f\x7f]/.test(value) || /^[A-Za-z]:/.test(value)
        || value.replace(/%2e/gi, ".").split("/").includes("..")) return null;
      try {
        let path;
        if (value.startsWith("file:")) {
          const url = new URL(value);
          if (url.hostname || url.search || url.hash || url.username || url.password) return null;
          path = fileURLToPath(url);
        } else path = isAbsolute(value) ? value : resolve(cwd, value);
        const file = [lexicalRoot, root].map(base => relative(base, path).split(sep).join("/")).find(file => files.has(file));
        if (!file) return null;
        if (!lstatSync(path).isFile()) return null;
        if (realpathSync(path) !== resolve(root, file)) return null;
        return file;
      } catch { return null; }
    };
  } catch { return () => null; }
}

function failureRecord(data, tracked) {
  const details = own(data, "details").value;
  const error = own(details, "error");
  const value = error.value;
  const failureType = own(value, "failureType").value;
  const code = own(value, "code").value;
  const file = tracked(own(data, "file").value), line = own(data, "line").value;
  return {
    v: 1, kind: "failure", file,
    line: file && Number.isSafeInteger(line) && line > 0 && line <= limit ? line : null,
    failureType: failureTypes.has(failureType) ? failureType : "unknown",
    errorClass: !error.present ? "missing" : value === undefined ? "undefined" : value === null ? "null"
      : !types.isProxy(value) && types.isNativeError(value) ? "native_error" : "unknown",
    code: codes.has(code) ? code : "unknown",
  };
}

function annotation(record, level) {
  const json = JSON.stringify(record);
  const escaped = json.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  const line = `::${level} title=Worker test identity::${escaped}\n`;
  if (Buffer.byteLength(line) > 768) throw new Error("worker identity record exceeds limit");
  return line;
}

// Buffer only nine leaf and nine parent identities. Parent summaries cannot
// crowd out later leaf failures, and presentation never changes runner verdicts.
export async function* workerFailureReport(source, { cwd = process.cwd() } = {}) {
  const tracked = trackedTestFiles(cwd), leaves = new Map(), parents = new Map();
  let failures = 0, unknownFiles = 0;
  for await (const event of source) {
    if (own(event, "type").value !== "test:fail") continue;
    failures = Math.min(limit, failures + 1);
    const record = failureRecord(own(event, "data").value, tracked);
    if (record.file === null) unknownFiles = Math.min(limit, unknownFiles + 1);
    const bucket = record.failureType === "subtestsFailed" ? parents : leaves;
    const key = JSON.stringify(record);
    if (bucket.has(key) || bucket.size < 9) bucket.set(key, record);
  }
  const selected = [...leaves.values(), ...parents.values()].slice(0, 9);
  for (const record of selected) yield annotation(record, "error");
  // Zero observed failures is not a success verdict; Node owns the exit code.
  yield annotation({ v: 1, kind: "summary", failureEvents: failures, reported: selected.length,
    omittedEvents: Math.max(0, failures - selected.length), unknownFiles, countsSaturated: failures === limit }, failures ? "error" : "notice");
}

export default workerFailureReport;
