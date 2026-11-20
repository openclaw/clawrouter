import { assertNativeQualification } from './deploy-native-qualification.mjs';

// Modes remain implementation details of the proven engines. No workflow input,
// source approval entry, or mid-release follow-up dispatch selects them.
export async function executeRelease({ state, control, qualify, run, save = () => {} }) {
  if (state.migration || state.unsafe) throw new Error('Development error: unsupported destructive transition; implement and qualify a forward-compatible release before deployment');
  if (!['rollout','native-control','native-cutover'].includes(state.mode)) throw new Error('Automatic release plan missing');
  const stages = [];
  if (state.cutover) {
    const blue = await control.snapshot(state.blue);
    const artifactControl = blue.control?.artifactProtocol === 1 && blue.inspection?.length === 8 && blue.inspection.every(x => x.artifactProtocol === 1);
    if (state.mode === 'native-cutover' && !artifactControl) {
      const bridge = { ...state, native:{schema:1,runtimeSha:state.cutover.blueRuntimeSha}, mode:'native-control',
        cutover:{...state.cutover,kind:'control'}, releaseManifest:state.recoveryReleaseManifest,releaseManifestSha256:state.recoveryReleaseManifestSha256 };
      const proof = await qualify(bridge,'bridge'); assertNativeQualification(bridge,proof);
      await run(bridge); stages.push({kind:'control-bridge',blue:bridge.blue,green:bridge.green,status:bridge.status});
      if (bridge.status !== 'done') throw new Error('Control adoption did not complete; payload remains unchanged');
      state.blue = bridge.green; state.deploymentId = bridge.deploymentId;
      // The bridge uses current control with the old native source. Its source
      // annotation must never claim that the desired payload already runs.
      state.deployedSha = state.sha;
      state.baselineSettings = state.candidateSettings;
      save({...state,stages});
    }
    const proof = await qualify(state,'release'); assertNativeQualification(state,proof);
    state.qualification = proof;
  } else {
    // No determining controller/native/config bytes changed. Existing live
    // qualification remains applicable; ordinary rollout smoke is still required.
    state.qualification = {reused:true,reason:'unchanged native runtime and determining controller',runtimeSha:state.native.runtimeSha};
  }
  await run(state); stages.push({kind:state.mode,blue:state.blue,green:state.green,status:state.status});
  state.stages = stages; save(state);
  return state;
}
