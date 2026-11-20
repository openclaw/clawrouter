import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createApi } from './deploy-train-api.mjs';
import { assertDeploymentAction } from './deploy-authorization.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fullSha, LEGACY_DEPLOYMENT, stableVersion, versionSha, deploymentState } from './deploy-train-policy.mjs';

export function git(...args) { return execFileSync('git', args, { encoding: 'utf8', timeout: 30_000 }).trim(); }
export async function successfulJobs(api, run) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = await api.github(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    if (!result.jobs.length) throw new Error('Incomplete CI job listing');
  }
  const required = ['native-codex', 'self-host', 'admin', 'admin-fusion-macos', 'worker-package', 'script-tests'];
  return jobs.length > 0 && jobs.every((j) => j.status === 'completed' && j.conclusion === 'success') &&
    required.every((name) => jobs.some((j) => j.name === name || j.name.startsWith(`${name} (`)));
}
export async function deployedSource(api, deployment) {
  const blue = stableVersion(deployment);
  const state = deploymentState(deployment);
  if (state && !['done', 'rehearsed', 'rolled-back'].includes(state.status)) throw new Error('An unfinished train needs recovery before selection');
  const version = await api.version(blue);
  let deployedSha = versionSha(version);
  if (!deployedSha && blue === LEGACY_DEPLOYMENT.version) {
    const run = await api.github(`/actions/runs/${LEGACY_DEPLOYMENT.run}`);
    if (run.conclusion !== 'success' || run.head_sha !== LEGACY_DEPLOYMENT.sha || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/deploy-cloudflare.yml') throw new Error('Legacy deployment source attestation failed');
    deployedSha = LEGACY_DEPLOYMENT.sha;
  }
  if (!deployedSha) throw new Error('Deployed version has no verified commit annotation; refusing to guess rollback lineage');
  return { blue, deployedSha };
}
// Never fall back to an older green commit. A release means this event's main.
export async function waitForSourceCI({ api, sha, now = Date.now, wait = sleep, timeoutMs = 15 * 60_000 }) {
  fullSha(sha);
  const deadline = now() + timeoutMs;
  for (;;) {
    const response = await api.github(`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`);
    const runs = response.workflow_runs.filter(r => r.head_sha === sha && r.event === 'push' && r.head_branch === 'main')
      .sort((a,b) => Number(b.id) - Number(a.id) || b.run_attempt - a.run_attempt);
    const latest = runs[0];
    if (latest?.status === 'completed') {
      if (latest.conclusion !== 'success' || !await successfulJobs(api, latest)) throw new Error('Frozen main source failed exact-source CI');
      return latest.id;
    }
    if (now() >= deadline) throw new Error('Frozen main source CI did not finish within 15 minutes');
    await wait(Math.min(15_000, deadline - now()));
  }
}
export function candidateCommits(deployedSha, head, runGit = git) {
  try { runGit('merge-base', '--is-ancestor', deployedSha, head); }
  catch (error) {
    if (error.status !== 1) throw error;
    // A queued schedule can have an older event snapshot than an urgent train
    // that finished first. This is a no-op, not a downgrade or failure.
    runGit('merge-base', '--is-ancestor', head, deployedSha);
    return [];
  }
  return runGit('rev-list', '--first-parent', `${deployedSha}..${head}`).split('\n').filter(Boolean);
}
export async function main(env = process.env) {
  assertDeploymentAction(env);
  const api = createApi({ env });
  const deployment = await api.latest();
  const source = await deployedSource(api, deployment);
  // Freeze the event's main snapshot, not a branch that can advance during selection.
  const head = fullSha(env.GITHUB_SHA);
  const commits = candidateCommits(source.deployedSha, head);
  const selection = commits.length === 0 && source.deployedSha !== head
    ? { noop: true, reason: 'No main candidate newer than the deployed version' }
    : { noop: false, sha: head, ciRun: await waitForSourceCI({ api, sha: head }) };
  const plan = { ...source, ...selection, deploymentId: deployment.id, run: env.GITHUB_RUN_ID };
  writeFileSync(env.TRAIN_PLAN_PATH, JSON.stringify(plan, null, 2));
  for (const [key, value] of Object.entries({ noop: plan.noop, sha: plan.sha || '', blue: plan.blue, deployed_sha: plan.deployedSha })) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(plan));
  if (plan.noop) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Production train\nSuccessful no-op: ${plan.reason}.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
