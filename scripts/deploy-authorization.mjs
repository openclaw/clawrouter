// Production deployment belongs to the canonical Action.
import { fullSha, verifyDispatch } from './deploy-train-policy.mjs';

export function assertDeploymentAction(env = process.env, sha = env.GITHUB_SHA) {
  verifyDispatch({ event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA, ref: env.GITHUB_REF });
  if (env.GITHUB_REPOSITORY !== 'openclaw/clawrouter' ||
      env.GITHUB_WORKFLOW_REF !== 'openclaw/clawrouter/.github/workflows/deploy-cloudflare.yml@refs/heads/main' ||
      fullSha(sha) !== fullSha(env.GITHUB_SHA) || !/^\d+$/.test(env.GITHUB_RUN_ID ?? ''))
    throw new Error('Production deployment must run through Deploy ClawRouter on main');
}
