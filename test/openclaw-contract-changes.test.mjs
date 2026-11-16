import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { affectsOpenClawContract, selectOpenClawContract } from "../scripts/openclaw-contract-changes.mjs";

const relevant = [
  "worker/index.ts", "worker/lib/routes.ts", "worker/generated/provider-snapshot.json",
  "worker/test/helpers/runtime.mjs", "worker/test/fixtures/search.json",
  "shared/contracts.ts", "providers/example.provider.yaml",
  "test/openclaw-search.test.mjs", "test/openclaw-native-embeddings.test.mjs",
  "test/fixtures/openclaw-search-contract.test.ts", "test/helpers/openclaw-consumer.mjs",
  "test/helpers/workerd.mjs", ".github/workflows/openclaw-contract.yml",
  "scripts/openclaw-contract-changes.mjs", "test/openclaw-contract-changes.test.mjs",
  "package.json", "admin/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  ".npmrc", ".pnpmfile.cjs", "patches/dependency.patch", "admin/patches/dependency.patch",
];
const unrelated = [
  "worker/test/provider-pricing-evidence.test.mjs", "worker/test/hosted-search-metering.test.mjs",
  "README.md", "CHANGELOG.md", "docs/architecture.md", "admin/src/App.svelte",
  "test/provider-compiler.test.mjs", "scripts/smoke-process.mjs", ".github/workflows/codeql.yml",
];

test("consumer selection retains runtime, fixture and install inputs, excluding unrelated tests", () => {
  for (const path of relevant) assert.equal(affectsOpenClawContract(path), true, path);
  for (const path of unrelated) assert.equal(affectsOpenClawContract(path), false, path);
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "clawrouter-consumer-selection-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (path, content = "changed\n") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  write("worker/original.ts", "original\n");
  write("README.md", "base\n");
  git("add", ".");
  git("commit", "-m", "Base");
  git("checkout", "-b", "topic");
  const merge = () => {
    git("add", "-A");
    git("commit", "-m", "Topic");
    git("checkout", "main");
    // Runtime changes already on the base must not trigger an unrelated PR.
    write("worker/base-only.ts");
    git("add", ".");
    git("commit", "-m", "Advance base");
    git("merge", "--no-ff", "topic", "-m", "Synthetic merge");
  };
  return { cwd, git, write, merge };
}

for (const [name, changes, expected] of [
  ["standalone tests", [["worker/test/pricing.test.mjs", "test\n"]], false],
  ["unrelated docs with Unicode and newline names", [["docs/文档\nnotes.md", "docs\n"]], false],
  ["runtime mixed with docs", [["README.md", "docs\n"], ["worker/lib/route.ts", "runtime\n"]], true],
  ["binary runtime", [["worker/fixture.bin", Buffer.from([0, 255, 0, 128])]], true],
  ["runtime deletion", [["worker/original.ts", null]], true],
  ["runtime renamed into excluded tests", [["worker/original.ts", null], ["worker/test/moved.test.mjs", "original\n"]], true],
  ["new consumer fixture", [["test/fixtures/openclaw-future-contract.test.ts", "fixture\n"]], true],
]) {
  test(`merge diff selects ${name}`, (t) => {
    const { cwd, write, merge } = fixture(t);
    for (const [path, content] of changes) {
      if (content === null) rmSync(join(cwd, path));
      else write(path, content);
    }
    merge();
    assert.equal(selectOpenClawContract(cwd).required, expected);
  });
}

test("depth-two parent trees suffice; missing merge history runs the full suite", (t) => {
  const { cwd, git, write, merge } = fixture(t);
  write("worker/test/pricing.test.mjs");
  merge();
  const parents = git("show", "-s", "--format=%P", "HEAD").trim().split(" ");
  write(".git/shallow", `${parents.join("\n")}\n`);
  assert.equal(git("rev-parse", "--is-shallow-repository").trim(), "true");
  assert.equal(selectOpenClawContract(cwd).required, false);
  write(".git/shallow", `${git("rev-parse", "HEAD").trim()}\n`);
  assert.equal(selectOpenClawContract(cwd).required, true);
});

test("non-merge, empty merge diff and unavailable Git data run the full suite", (t) => {
  const { cwd, git, write, merge } = fixture(t);
  assert.equal(selectOpenClawContract(cwd).required, true);
  write("temporary.md");
  merge();
  const parent = git("rev-parse", "HEAD^1").trim();
  const tree = git("rev-parse", "HEAD^1^{tree}").trim();
  const other = git("rev-parse", "HEAD^2").trim();
  const emptyMerge = git("commit-tree", tree, "-p", parent, "-p", other, "-m", "Empty merge").trim();
  git("reset", "--hard", emptyMerge);
  assert.equal(selectOpenClawContract(cwd).required, true);
  rmSync(join(cwd, ".git"), { recursive: true });
  assert.equal(selectOpenClawContract(cwd).required, true);
});

test("CLI publishes an explicit skip and falls back to run for missing merge metadata", (t) => {
  const { cwd, git, write, merge } = fixture(t);
  write("worker/test/pricing.test.mjs");
  merge();
  const script = fileURLToPath(new URL("../scripts/openclaw-contract-changes.mjs", import.meta.url));
  const output = join(cwd, "output");
  const run = () => execFileSync(process.execPath, [script], {
    cwd, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.match(run(), /contract: skip \(consumer inputs unchanged\)/);
  assert.equal(readFileSync(output, "utf8"), "required=false\n");
  git("checkout", "--detach", "HEAD^2");
  assert.match(run(), /contract: run \(merge parents unavailable\)/);
  assert.equal(readFileSync(output, "utf8"), "required=false\nrequired=true\n");
});
