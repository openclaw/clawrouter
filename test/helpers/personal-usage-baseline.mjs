import { execFileSync } from "node:child_process";

/**
 * Native upgrade/rollback tests need the released baseline commit. CI fetches
 * it explicitly; anywhere else a missing object skips with instructions. In CI
 * a missing baseline fails rather than silently skipping the coverage.
 */
export function requireBaselineCommit(t, sha) {
  try {
    execFileSync("git", ["cat-file", "-e", sha + "^{commit}"], { stdio: "ignore" });
    return true;
  } catch {
    const message = "baseline commit " + sha + " is unavailable; run: git fetch --no-tags --depth=1 origin " + sha;
    if (process.env.CI) throw new Error(message);
    t.skip(message);
    return false;
  }
}
