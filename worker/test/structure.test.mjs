import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const codeExtensions = /\.(?:css|html|js|jsx|mjs|ts|tsx|yaml|yml)$/;

test("source files stay below the 1,000-line structural ceiling", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n").filter((file) => existsSync(file) && codeExtensions.test(file) && file !== "pnpm-lock.yaml" && !file.startsWith("admin/dist/") && !file.startsWith("worker/generated/"));
  const oversized = files.flatMap((file) => {
    const lines = readFileSync(file, "utf8").split("\n").length;
    return lines > 1_000 ? [`${file}:${lines}`] : [];
  });
  assert.deepEqual(oversized, []);
});

test("build and CI contain no Rust toolchain path", () => {
  const files = ["package.json", "wrangler.toml", ".github/workflows/ci.yml", ".github/workflows/deploy-cloudflare.yml"];
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(text, /\b(?:cargo|rustc|rustup|worker-build|wasm32)\b/i);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts["provider:compile"], "node scripts/compile-providers.mjs providers/*.provider.yaml");
});

test("expired pending budget reservations release their reserved amount", () => {
  const source = readFileSync("worker/ledgers.ts", "utf8");
  assert.match(source, /DELETE FROM budget_reservations WHERE settled = 0 AND created_at_ms < \?/);
  assert.doesNotMatch(source, /UPDATE budget_reservations SET settled = 1 WHERE settled = 0/);
});
