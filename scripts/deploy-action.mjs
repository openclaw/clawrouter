// Local convenience dispatches the SAME Action. It cannot directly deploy.
import { execFileSync } from 'node:child_process';
if(process.argv.includes('--help'))console.log('Deploy main: GitHub Actions → Deploy ClawRouter → Run workflow (main). Or: gh workflow run deploy-cloudflare.yml --repo openclaw/clawrouter --ref main');
else {
  if(process.argv.length!==2)throw new Error('Deploy ClawRouter takes no per-release inputs');
  if(process.env.CLAWROUTER_DEPLOY_ENV && process.env.CLAWROUTER_DEPLOY_ENV!=='production' ||
     process.env.CLAWROUTER_WORKER_NAME && process.env.CLAWROUTER_WORKER_NAME!=='clawrouter-edge' ||
     process.env.CLAWROUTER_BASE_URL && process.env.CLAWROUTER_BASE_URL!=='https://clawrouter.openclaw.ai')
    throw new Error('This command dispatches production only; use the separate environment workflow for another target');
  execFileSync('gh',['workflow','run','deploy-cloudflare.yml','--repo','openclaw/clawrouter','--ref','main'],{stdio:'inherit',timeout:30_000});
}
