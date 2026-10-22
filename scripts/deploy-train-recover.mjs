// Runs in a fresh job after any failure, cancellation, or lost deploy runner.
// Uses only built-in modules: recovery does not depend on candidate installation.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createApi } from './deploy-train-api.mjs';
import { deploymentMessage, deploymentState, recoveryDecision } from './deploy-train-policy.mjs';

export async function recoverRemote(api, run) {
  const latest = await api.latest();
  const state = deploymentState(latest);
  if (state && state.run !== String(run)) return 'no owned deployment to recover';
  if (!state) {
    // A plain migration deploy annotates its version, not its deployment. Never
    // roll backwards across it, including when wrangler died after the mutation.
    for (const item of latest?.versions ?? []) {
      const version = await api.version(item.version_id);
      if (version.annotations?.['workers/message']?.startsWith(`clawrouter-migration:${run}:`)) return 'freeze: lifecycle migration';
    }
    return 'no owned deployment to recover';
  }
  const action = recoveryDecision(state);
  if (action !== 'rollback') return action;
  await api.deploy([{ version_id: state.blue, percentage: 100 }], deploymentMessage({ ...state, status: 'rolled-back' }), latest.id);
  return 'rollback: blue restored to 100%';
}
export async function failureIssue(api, { run, sha, result }) {
  const title = 'Production deployment train failures';
  const marker = '<!-- clawrouter-production-train-failures -->';
  let existing;
  for (let page = 1; ; page++) {
    const issues = await api.github(`/issues?state=all&per_page=100&page=${page}`);
    existing = issues.find((i) => !i.pull_request && i.title === title && i.body?.includes(marker));
    if (existing || issues.length < 100) break;
  }
  // Only fixed diagnostics and validated identifiers enter a public issue; no
  // provider bodies, arbitrary error strings, identities, mentions or assignments.
  if (!/^\d+$/.test(String(run)) || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Invalid failure receipt identity');
  const allowed = ['none', 'freeze', 'freeze: lifecycle migration', 'rollback: blue restored to 100%', 'no owned deployment to recover', 'recovery failed; inspect run logs'];
  if (!allowed.includes(result)) throw new Error('Invalid recovery result');
  const receipt = `Run: https://github.com/openclaw/clawrouter/actions/runs/${run}\nCommit: \`${sha}\`\nRecovery: **${result}**.\nSee the run summary and logs. A frozen rollout requires a forward fix; do not blindly roll back storage.`;
  const body = `${marker}\n${receipt}\n\nThis single issue tracks train failures. Successful trains do not post notifications. No people are mentioned or assigned.`;
  if (existing) return api.github(`/issues/${existing.number}`, { method: 'PATCH', body: { state: 'open', body } });
  return api.github('/issues', { method: 'POST', body: { title, body } });
}
export async function main(env = process.env) {
  const api = createApi({ env });
  let result;
  try { result = await recoverRemote(api, env.GITHUB_RUN_ID); }
  catch { result = 'recovery failed; inspect run logs'; }
  console.log(result);
  appendFileSync(env.GITHUB_STEP_SUMMARY, `## Failure recovery\n${result}\n`);
  await failureIssue(api, { run: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, result });
  if (result === 'recovery failed; inspect run logs') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
