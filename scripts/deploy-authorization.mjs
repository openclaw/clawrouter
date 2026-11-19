// Operational authorization belongs to the canonical Action, not a source flag.
import { fullSha, verifyDispatch } from './deploy-train-policy.mjs';

export function assertDeploymentAction(env = process.env, sha = env.GITHUB_SHA) {
  verifyDispatch({ event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA, ref: env.GITHUB_REF });
  if (env.GITHUB_REPOSITORY !== 'openclaw/clawrouter' ||
      env.GITHUB_WORKFLOW_REF !== 'openclaw/clawrouter/.github/workflows/deploy-cloudflare.yml@refs/heads/main' ||
      fullSha(sha) !== fullSha(env.GITHUB_SHA) || !/^\d+$/.test(env.GITHUB_RUN_ID ?? ''))
    throw new Error('Production deployment must run through Deploy ClawRouter on main');
}

export function assertActivationAllowed(env = process.env) {
  const pause = env.CLAWROUTER_DEPLOY_PAUSED?.trim().toLowerCase() ?? '';
  if (!['', '0', 'false', '1', 'true'].includes(pause)) throw new Error('Invalid CLAWROUTER_DEPLOY_PAUSED value');
  if (['1', 'true'].includes(pause)) throw new Error('New production activations are paused by the GitHub repository variable');
}
