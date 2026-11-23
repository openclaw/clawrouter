import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from 'yaml';

const sha = "0123456789abcdef0123456789abcdef01234567";
const otherSha = "f".repeat(40);
const spellings = (value) => [value, value.toUpperCase(), value.replace(/[ace]/g, (letter) => letter.toUpperCase())];

for (const name of ["deploy-cloudflare-fakeco"]) {
  const workflow = parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  const steps = workflow.jobs.deploy.steps;
  const guard = steps.find((s) => s.name === 'Verify dispatched deployment source');
  const checkoutGuard = steps.find((s) => s.name === 'Verify checked-out deployment source');
  const run = (body, expected = sha, dispatched = sha, cwd = tmpdir(), overrides = {}) => spawnSync(
    "/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${body}\nprintf 'admitted\n'`],
    { cwd, encoding: "utf8", env: { PATH: process.env.PATH, EXPECTED_SHA: expected, GITHUB_SHA: dispatched, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', ...overrides } },
  );

  test(`${name} admits only the exact full dispatch SHA`, () => {
    for (const expected of spellings(sha)) {
      const result = run(guard.run, expected);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "admitted\n");
    }
    for (const expected of ["", "main", sha.slice(0, 7), `${sha}0`, "g".repeat(40), ` ${sha}`, `${sha}\n`, "$(printf injected)", otherSha]) {
      const refused = run(guard.run, expected);
      assert.equal(refused.status, 1, expected);
      assert.doesNotMatch(refused.stdout, /admitted|injected/);
      assert.match(refused.stdout, /::error::/);
    }
    assert.equal(run(guard.run, sha, "").status, 1);
  });

  test(`${name} rejects a different or unavailable actual HEAD before dependencies`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "clawrouter-deploy-source-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.notEqual(run(checkoutGuard.run, sha, sha, directory).status, 0);
    git("init", "--quiet");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture");
    const actual = git("rev-parse", "HEAD");
    // The train selected SHA is canonical lowercase; the legacy FakeCo manual
    // checkout guard still normalizes operator input.
    for (const expected of name === 'deploy-cloudflare' ? [actual] : spellings(actual)) {
      const accepted = run(checkoutGuard.run, expected, actual, directory);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout, "admitted\n");
    }
    const refused = run(checkoutGuard.run, otherSha, otherSha, directory);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /Checkout differs/);
    assert.doesNotMatch(refused.stdout, /admitted/);
  });

  if (name === 'deploy-cloudflare') {
    test('production schedule admits main without a manual SHA but refuses other refs', () => {
      assert.equal(run(guard.run, '', sha, tmpdir(), { GITHUB_EVENT_NAME: 'schedule' }).status, 0);
      assert.equal(run(guard.run, sha, sha, tmpdir(), { GITHUB_REF: 'refs/heads/unreviewed' }).status, 1);
    });
  }
}


test("feature compatibility retains full ancestry after the pinned native-source fetch", t => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs["script-tests"].steps;
  assert.equal(steps[0].with["fetch-depth"], 0);
  const fetchStep = steps.find(step => step.name === "Fetch exact launch native source for synthetic compatibility");
  const checkStep = steps.find(step => step.name === "Validate deployment compatibility in the feature PR");
  assert.ok(steps.indexOf(fetchStep) < steps.indexOf(checkStep));
  assert.equal(checkStep.run, "node scripts/check-deployment-compatibility.mjs");
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-compat-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(directory, "init", "-q");
  const commit = message => { git(directory, "commit", "--allow-empty", "-qm", message); return git(directory, "rev-parse", "HEAD"); };
  const historical = commit("legacy change\n\nClawRouter-Rollback-Unsafe: historical fixture boundary");
  const launch = commit("native launch"), base = commit("current base");
  git(directory, "switch", "-qc", "feature", historical); commit("provider card");
  git(directory, "merge", "--no-ff", "-qm", "compose current base", base);
  const head = git(directory, "rev-parse", "HEAD");
  for (const shallow of [false, true]) {
    const checkout = join(directory, shallow ? "shallow-check" : "full-check"); mkdirSync(checkout);
    git(checkout, "init", "-q"); git(checkout, "remote", "add", "origin", directory);
    git(checkout, "fetch", "--no-tags", "origin", head); git(checkout, "checkout", "--detach", head);
    let command = fetchStep.run.replace("434a526a37fff4d91e04cc1caa5cd6aa2eff2d82", launch);
    if (shallow) command = command.replace("--no-tags", "--no-tags --depth=1");
    const fetched = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-c", command], { cwd: checkout, encoding: "utf8", timeout: 10_000 });
    assert.equal(fetched.status, 0, fetched.stderr);
    const range = git(checkout, "rev-list", base + ".." + head).split("\n");
    assert.equal(range.includes(historical), shallow, "only truncated ancestry reintroduces the already-landed boundary");
    assert.equal(git(checkout, "rev-parse", "--is-shallow-repository"), String(shallow));
  }
});
