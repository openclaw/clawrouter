import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse, stringify } from 'yaml';

// CI supplies a checksum-pinned actionlint. No parser-only or mocked validator fallback.
const source = readFileSync(new URL('../.github/workflows/preflight-native-rehearsal.yml', import.meta.url), 'utf8');
const validate = input => {
  const result = spawnSync(process.env.ACTIONLINT_BIN || 'actionlint', ['-shellcheck=', '-pyflakes=', '-'],
    { input, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  return result;
};

test('complete preflight workflow passes expression-context admission', () => {
  const result = validate(source);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const scope of ['workflow', 'job']) {
  test(`runner receipt path is rejected at ${scope} env before any step executes`, () => {
    const workflow = parse(source), job = workflow.jobs.observe;
    const receipt = job.steps[0].env.PREFLIGHT_RECEIPT;
    for (const step of job.steps) if (step.env) delete step.env.PREFLIGHT_RECEIPT;
    delete job.steps[0].env;
    const target = scope === 'workflow' ? workflow : job;
    target.env = { ...target.env, PREFLIGHT_RECEIPT: receipt };
    const result = validate(stringify(workflow));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /context "runner" is not allowed here/);
  });
}
