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
  "packages/provider-plugin-contract/src/snapshot.ts", "packages/provider-plugin-contract/src/native-capabilities.ts",
  "packages/provider-plugin-contract/src/nested/future.ts", "packages/provider-plugin-contract/tsconfig.json",
  "packages/provider-plugin-contract/copy-manifest-schema.mjs",
  "test/openclaw-search.test.mjs", "test/openclaw-native-embeddings.test.mjs",
  "test/fixtures/openclaw-search-contract.test.ts", "test/helpers/openclaw-consumer.mjs",
  "test/helpers/workerd.mjs", "test/helpers/catalog-diagnostic-harness.mjs", ".github/workflows/openclaw-contract.yml",
  "test/helpers/cloudflare-response-clones.ts",
  "wrangler.toml",
  "scripts/provider-compiler.mjs",
  "scripts/provider-auth.mjs",
  "scripts/provider-catalogs.mjs",
  "scripts/provider-endpoints.mjs",
  "scripts/provider-lifecycles.mjs",
  "scripts/provider-models.mjs",
  "scripts/provider-offers.mjs",
  "scripts/provider-pricing.mjs",
  "scripts/provider-products.mjs",
  "scripts/provider-quota.mjs",
  "scripts/provider-validation/aws-bedrock.mjs",
  "scripts/provider-validation/baseten.mjs",
  "scripts/provider-validation/deepseek.mjs",
  "scripts/provider-validation/google.mjs",
  "scripts/provider-validation/gradium.mjs",
  "scripts/provider-validation/levanto.mjs",
  "scripts/provider-validation/pixverse.mjs",
  "scripts/provider-validation/transcription.mjs",
  "scripts/provider-validation/xai.mjs",
  "test/helpers/fixture-cleanup.mjs",
  "test/helpers/openclaw-catalog-variant.mjs",
  "test/helpers/openclaw-google-text.mjs",
  "test/helpers/qianfan-memory.mjs",
  "test/helpers/openclaw-baseten-guard-observer.mjs",
  "test/helpers/openclaw-pixverse-guard-observer.mjs",
  "test/helpers/openclaw-vydra-guard-observer.mjs",
  "test/helpers/openclaw-private-execution-observer.mjs",
  "test/helpers/openclaw-qwen-callsite-observer.mjs",
  "test/helpers/openclaw-runner-reporter.mjs",
  "scripts/openclaw-contract-changes.mjs", "test/openclaw-contract-changes.test.mjs",
  "package.json", "admin/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "test/helpers/worker-outcome-fixture.mjs",
  ".npmrc", ".pnpmfile.cjs", "patches/dependency.patch", "admin/patches/dependency.patch",
];
const unrelated = [
  "scripts/provider-smoke-plan.mjs", "scripts/sync-provider-icons.mjs",
  "scripts/provider-validation-extra/google.mjs", "wrangler.edge-proof.toml",
  "worker/test/provider-pricing-evidence.test.mjs", "worker/test/hosted-search-metering.test.mjs",
  "README.md", "CHANGELOG.md", "docs/architecture.md", "admin/src/App.svelte",
  "test/provider-compiler.test.mjs", "scripts/smoke-process.mjs", ".github/workflows/codeql.yml",
  "packages/provider-plugin-contract/README.md", "packages/provider-plugin-contract/LICENSE",
  "packages/provider-plugin-contract-extra/src/snapshot.ts", "packages/other/src/snapshot.ts",
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
  write("packages/provider-plugin-contract/src/snapshot.ts", "original contract\n");
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
  ["catalog diagnostic harness", [["test/helpers/catalog-diagnostic-harness.mjs", "fixture\n"]], true],
  ["portable contract source only", [["packages/provider-plugin-contract/src/snapshot.ts", "changed contract\n"]], true],
  ["portable contract build configuration", [["packages/provider-plugin-contract/tsconfig.json", "{}\n"]], true],
  ["portable schema packaging", [["packages/provider-plugin-contract/copy-manifest-schema.mjs", "// packaging\n"]], true],
  ["shared Worker outcome fixture", [["test/helpers/worker-outcome-fixture.mjs", "fixture\n"]], true],
  ["Cloudflare response clone observer", [["test/helpers/cloudflare-response-clones.ts", "fixture\n"]], true],
  ["wrangler.toml native input", [["wrangler.toml", "fixture\n"]], true],
  ["scripts/provider-compiler.mjs native input", [["scripts/provider-compiler.mjs", "fixture\n"]], true],
  ["scripts/provider-auth.mjs native input", [["scripts/provider-auth.mjs", "fixture\n"]], true],
  ["scripts/provider-catalogs.mjs native input", [["scripts/provider-catalogs.mjs", "fixture\n"]], true],
  ["scripts/provider-endpoints.mjs native input", [["scripts/provider-endpoints.mjs", "fixture\n"]], true],
  ["scripts/provider-lifecycles.mjs native input", [["scripts/provider-lifecycles.mjs", "fixture\n"]], true],
  ["scripts/provider-models.mjs native input", [["scripts/provider-models.mjs", "fixture\n"]], true],
  ["scripts/provider-offers.mjs native input", [["scripts/provider-offers.mjs", "fixture\n"]], true],
  ["scripts/provider-pricing.mjs native input", [["scripts/provider-pricing.mjs", "fixture\n"]], true],
  ["scripts/provider-products.mjs native input", [["scripts/provider-products.mjs", "fixture\n"]], true],
  ["scripts/provider-quota.mjs native input", [["scripts/provider-quota.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/aws-bedrock.mjs native input", [["scripts/provider-validation/aws-bedrock.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/baseten.mjs native input", [["scripts/provider-validation/baseten.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/deepseek.mjs native input", [["scripts/provider-validation/deepseek.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/google.mjs native input", [["scripts/provider-validation/google.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/gradium.mjs native input", [["scripts/provider-validation/gradium.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/levanto.mjs native input", [["scripts/provider-validation/levanto.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/pixverse.mjs native input", [["scripts/provider-validation/pixverse.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/transcription.mjs native input", [["scripts/provider-validation/transcription.mjs", "fixture\n"]], true],
  ["scripts/provider-validation/xai.mjs native input", [["scripts/provider-validation/xai.mjs", "fixture\n"]], true],
  ["fixture-cleanup.mjs native helper", [["test/helpers/fixture-cleanup.mjs", "fixture\n"]], true],
  ["openclaw-catalog-variant.mjs native helper", [["test/helpers/openclaw-catalog-variant.mjs", "fixture\n"]], true],
  ["openclaw-google-text.mjs native helper", [["test/helpers/openclaw-google-text.mjs", "fixture\n"]], true],
  ["qianfan-memory.mjs native helper", [["test/helpers/qianfan-memory.mjs", "fixture\n"]], true],
  ["openclaw-baseten-guard-observer.mjs native helper", [["test/helpers/openclaw-baseten-guard-observer.mjs", "fixture\n"]], true],
  ["openclaw-pixverse-guard-observer.mjs native helper", [["test/helpers/openclaw-pixverse-guard-observer.mjs", "fixture\n"]], true],
  ["openclaw-vydra-guard-observer.mjs native helper", [["test/helpers/openclaw-vydra-guard-observer.mjs", "fixture\n"]], true],
  ["openclaw-private-execution-observer.mjs native helper", [["test/helpers/openclaw-private-execution-observer.mjs", "fixture\n"]], true],
  ["openclaw-qwen-callsite-observer.mjs native helper", [["test/helpers/openclaw-qwen-callsite-observer.mjs", "fixture\n"]], true],
  ["openclaw-runner-reporter.mjs native helper", [["test/helpers/openclaw-runner-reporter.mjs", "fixture\n"]], true],
  ["portable contract renamed into documentation", [["packages/provider-plugin-contract/src/snapshot.ts", null], ["packages/provider-plugin-contract/README.md", "original contract\n"]], true],
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
