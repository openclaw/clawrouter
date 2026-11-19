// Source only, never credentials. A file avoids bsdtar closing its stdin before
// Node finishes writing Git's trailing archive blocks (successful tar + EPIPE).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fullSha } from './deploy-train-policy.mjs';
export function archiveDeploymentSource(source, directory, paths) {
  fullSha(source);
  const archive=join(resolve(directory),'deployment-source.tar');
  try {
    execFileSync('git',['archive','--format=tar','--output='+archive,source,...paths],{timeout:30_000});
    execFileSync('tar',['-xf',archive,'-C',resolve(directory)],{timeout:30_000});
  } finally { rmSync(archive,{force:true}); }
}
