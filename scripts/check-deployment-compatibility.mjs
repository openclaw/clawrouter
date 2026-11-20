// Feature PRs own compatibility. Detect unsupported settings/migration changes in
// CI, before a teammate reaches the deploy button. Runtime transitions are also
// exercised by the normal upgrade tests and the Action's isolated rehearsal.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { inspectSource } from './deploy-train-source.mjs';
import { fullSha } from './deploy-train-policy.mjs';
export function checkDeploymentCompatibility(base, head) {
  const result=inspectSource({blueSha:fullSha(base),greenSha:fullSha(head)});
  if(result.migration||result.unsafe)throw new Error('Unsupported deployment transition: implement compatible migration/recovery and old-state proof in this feature PR. Do not add operator release steps or a source approval flag.');
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:30_000}).trim();
  const head=git('rev-parse','HEAD'),base=process.env.DEPLOYMENT_BASE_SHA;
  if(!base)throw new Error('CI must supply its immutable PR base or push before SHA');
  console.log(JSON.stringify({head,base,...checkDeploymentCompatibility(base,head)}));
}
