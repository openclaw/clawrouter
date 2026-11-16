import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function affectsOpenClawContract(path) {
  return (path.startsWith("worker/") && !/^worker\/test\/[^/]+\.test\.mjs$/.test(path))
    || path.startsWith("shared/")
    || path.startsWith("providers/")
    || /^test\/openclaw-[^/]*\.test\.mjs$/.test(path)
    || /^test\/fixtures\/openclaw-[^/]*-contract\.test\.ts$/.test(path)
    || ["test/helpers/openclaw-consumer.mjs", "test/helpers/workerd.mjs",
      ".github/workflows/openclaw-contract.yml", "scripts/openclaw-contract-changes.mjs",
      "test/openclaw-contract-changes.test.mjs", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(path)
    || /(^|\/)package\.json$/.test(path)
    || /(^|\/)\.npmrc$/.test(path)
    || /(^|\/)\.pnpmfile\.[^/]+$/.test(path)
    || /(^|\/)patches\//.test(path);
}

export function selectOpenClawContract(cwd = process.cwd()) {
  try {
    const git = (args) => execFileSync("git", args, {
      cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // pull_request checks out GitHub's synthetic merge. Depth two includes both
    // parent trees: compare the merged result to its base, without an API file cap.
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
    if (parents.length !== 3) return { required: true, reason: "merge parents unavailable" };
    // Disable rename detection so both sides remain visible when a runtime file
    // moves into an excluded test path. NUL separates even newline-bearing names.
    const diff = git(["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", "HEAD^1", "HEAD", "--"]);
    if (!diff || !diff.endsWith("\0")) return { required: true, reason: "changed paths unavailable" };
    const required = diff.slice(0, -1).split("\0").some(affectsOpenClawContract);
    return { required, reason: required ? "consumer inputs changed" : "consumer inputs unchanged" };
  } catch {
    return { required: true, reason: "change detection unavailable" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { required, reason } = selectOpenClawContract();
  console.log(`OpenClaw consumer contract: ${required ? "run" : "skip"} (${reason})`);
  appendFileSync(process.env.GITHUB_OUTPUT, `required=${required}\n`);
}
