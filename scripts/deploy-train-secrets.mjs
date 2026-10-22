import { fullSha, versionId } from './deploy-train-policy.mjs';

export function uploadMessage(state) {
  if (!/^\d+$/.test(String(state.run))) throw new Error('Invalid train run identity');
  return `${state.migration ? 'clawrouter-migration' : 'clawrouter-candidate'}:${state.run}:${fullSha(state.sha)}:preserve-secrets:${versionId(state.blue)}`;
}
// Wrangler 4.147 inherits secret values from the LATEST UPLOAD, not blue. Secret
// values cannot be read back and script-version upload cannot select a base ID.
// Accept only an uninterrupted sequence of this train's no-secret-change uploads
// back to blue; an unrelated upload must be reconciled by its owner first.
export function assertSecretLineage(versions, blue) {
  versionId(blue);
  if (!Array.isArray(versions) || !versions.length) throw new Error('Uploaded-version history unavailable');
  for (const version of versions) {
    versionId(version.id);
    if (version.id === blue) return versions[0].id;
    const match = /^(clawrouter-candidate|clawrouter-migration):(\d+):([a-f0-9]{40}):preserve-secrets:([a-f0-9-]{36})$/.exec(version.annotations?.['workers/message'] ?? '');
    if (!match || match[4] !== blue || version.annotations?.['workers/tag'] !== match[3]) throw new Error('Unproven latest-upload secret lineage; reconcile the external upload before running the train');
  }
  throw new Error('Deployed secret lineage is outside available version history; refusing to guess');
}
