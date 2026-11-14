import { fullSha, versionId } from './deploy-train-policy.mjs';

export function uploadMessage(state) {
  if (!/^\d+$/.test(String(state.run))) throw new Error('Invalid train run identity');
  if (state.native && (state.native.schema !== 1 || !/^[a-f0-9]{64}$/.test(state.native.runtimeSha ?? ''))) throw new Error('Invalid native upload receipt');
  return `${state.migration ? 'clawrouter-migration' : 'clawrouter-candidate'}:${state.run}:${fullSha(state.sha)}:preserve-secrets:${versionId(state.blue)}${state.native ? `:native-v1:${state.native.runtimeSha}` : ''}${state.nativeSource ? `:native-source:${fullSha(state.nativeSource)}` : ''}`;
}
// Wrangler inherits secrets from the latest upload, not the selected version.
// Require every intervening upload to attest preserved secrets. A hybrid
// recovery can have a newer sibling candidate, both rooted in its original blue;
// follow that contiguous, backwards-only ancestry without hiding foreign uploads.
function lineage(version) {
  const m=/^clawrouter-(?:candidate|migration):\d+:([a-f0-9]{40}):preserve-secrets:([a-f0-9-]{36})(?::native-v1:[a-f0-9]{64}(?::native-source:([a-f0-9]{40}))?)?$/.exec(version.annotations?.['workers/message']??'');
  return m&&version.annotations?.['workers/tag']===m[1]?{parent:versionId(m[2]),hybrid:!!m[3]}:null;
}
export function assertSecretLineage(versions, blue) {
  versionId(blue);
  if (!Array.isArray(versions) || !versions.length) throw new Error('Uploaded-version history unavailable');
  const positions=new Map();
  versions.forEach((v,i)=>{versionId(v.id);if(positions.has(v.id))throw new Error('Duplicate uploaded version');positions.set(v.id,i);});
  const selected=positions.get(blue);
  if(selected===undefined)throw new Error('Deployed secret lineage is outside available version history; refusing to guess');
  const hybrid=lineage(versions[selected])?.hybrid===true;
  let end=selected;
  for(let i=0;i<end;i++){
    const receipt=lineage(versions[i]);
    const parent=receipt?positions.get(receipt.parent):undefined;
    if(!receipt||parent===undefined||parent<=i||!hybrid&&receipt.parent!==blue)
      throw new Error('Unproven latest-upload secret lineage; reconcile the external upload before running the train');
    // A hybrid sibling may point beyond active recovery. Extend the contiguous
    // proof to that older base; every intervening upload must still qualify.
    end=Math.max(end,parent);
  }
  return versions[0].id;
}
