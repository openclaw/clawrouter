import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sha = "0123456789abcdef0123456789abcdef01234567";
const otherSha = "f".repeat(40);

for (const name of ["deploy-cloudflare", "deploy-cloudflare-fakeco"]) {
  const workflow = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
  const steps = workflow.split("    steps:\n")[1].split(/^      - /m).slice(1);
  const script = (step) => {
    const body = step.match(/        run: \|\n((?:          .*\n)+)/)?.[1];
    assert.ok(body, "guard must be an inline shell step before repository code can run");
    return body.replace(/^          /gm, "");
  };
  const run = (body, expected = sha, dispatched = sha, cwd = tmpdir()) => spawnSync(
    "/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${body}\nprintf 'admitted\\n'`],
    { cwd, encoding: "utf8", env: { PATH: process.env.PATH, EXPECTED_SHA: expected, GITHUB_SHA: dispatched } },
  );

  test(`${name} guards dispatch first and actual checkout before dependencies`, () => {
    assert.match(workflow, /      expected_sha:\n        description: .+\n        required: true\n        type: string\n/);
    assert.match(steps[0], /^name: Verify dispatched deployment source\n/);
    assert.match(steps[1], /^uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n$/);
    assert.match(steps[2], /^name: Verify checked-out deployment source\n/);
    assert.match(steps[3], /^uses: actions\/setup-node@/);
    for (const step of [steps[0], steps[2]]) {
      assert.match(step, /        shell: bash\n/);
      assert.match(step, /          EXPECTED_SHA: \$\{\{ inputs.expected_sha \}\}\n/);
      assert.doesNotMatch(step, /continue-on-error:|\bif:/);
      assert.doesNotMatch(script(step), /\$\{\{/);
    }
  });

  test(`${name} admits only the exact full dispatch SHA`, () => {
    const result = run(script(steps[0]));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "admitted\n");
    for (const expected of ["", "main", sha.slice(0, 7), `${sha}0`, "g".repeat(40), ` ${sha}`, `${sha}\n`, "$(printf injected)", otherSha]) {
      const refused = run(script(steps[0]), expected);
      assert.equal(refused.status, 1, expected);
      assert.doesNotMatch(refused.stdout, /admitted|injected/);
      assert.match(refused.stdout, /::error::/);
    }
    assert.equal(run(script(steps[0]), sha, "").status, 1);
  });

  test(`${name} rejects a different or unavailable actual HEAD before dependencies`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "clawrouter-deploy-source-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const absent = run(script(steps[2]), sha, sha, directory);
    assert.notEqual(absent.status, 0);
    assert.equal(absent.stdout, "");
    git("init", "--quiet");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture");
    const actual = git("rev-parse", "HEAD");
    const accepted = run(script(steps[2]), actual, actual, directory);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, "admitted\n");
    const refused = run(script(steps[2]), otherSha, otherSha, directory);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /Checkout differs/);
    assert.doesNotMatch(refused.stdout, /admitted/);
  });
}
