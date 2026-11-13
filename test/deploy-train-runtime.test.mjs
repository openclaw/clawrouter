import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentMessage, deploymentState } from '../scripts/deploy-train-policy.mjs';
import { nativeReceipt, assertRuntimePair, NATIVE_ANCHOR } from '../scripts/deploy-train-runtime.mjs';
import { recoverRemote } from '../scripts/deploy-train-recover.mjs';
import { recoverTrain, runTrain } from '../scripts/deploy-train.mjs';
import { uploadMessage } from '../scripts/deploy-train-secrets.mjs';
import { native, nativeVersion } from './helpers/deploy-native-fixture.mjs';

const blue = '11111111-1111-1111-1111-111111111111', green = '22222222-2222-2222-2222-222222222222';
const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
function fixture() {
  const state = { blue, green, sha, run: '123', native, status: 'rolling', unsafe: false, exposed: true, deploymentId: 'd0' };
  const versions = { [blue]: nativeVersion(blue, oldSha), [green]: nativeVersion(green, sha, blue) };
  const posts = [];
  const api = { version: async id => structuredClone(versions[id]), versions: async () => [versions[green], versions[blue]], latest: async () => ({ id: 'd0', annotations: { 'workers/message': deploymentMessage(state) }, versions: [{ version_id: green, percentage: 50 }, { version_id: blue, percentage: 50 }] }), deploy: async (...args) => { posts.push(args); return { id: 'restored' }; } };
  return { state, versions, api, posts };
}
test('manual launch anchor needs exact version/tag and ingress-enabled canonical owners', () => {
  const version = nativeVersion(NATIVE_ANCHOR.version, NATIVE_ANCHOR.sha);
  version.annotations['workers/message'] = 'original launch upload';
  assert.equal(nativeReceipt(version).runtimeSha, NATIVE_ANCHOR.runtimeSha);
  version.annotations['workers/tag'] = oldSha;
  assert.throws(() => nativeReceipt(version), /not attested/);
});
test('same-runtime pairs survive binding ordering and serialize a recovery receipt', () => {
  const f = fixture();
  f.versions[green].resources.bindings.reverse();
  assert.doesNotThrow(() => assertRuntimePair(f.versions[blue], f.versions[green], f.state));
  assert.deepEqual(deploymentState(awaitlessDeployment(f.state)).native, native);
});
function awaitlessDeployment(state) { return { annotations: { 'workers/message': deploymentMessage(state) }, versions: [{ version_id: blue, percentage: 100 }] }; }

const changes = {
  'pre-migration target': v => { v.resources.bindings = v.resources.bindings.filter(b => b.name !== 'LARGE_HTTP_POOL'); },
  'ingress-closed target': v => { v.resources.bindings.find(b => b.name === 'LARGE_HTTP_INGRESS_ENABLED').text = '0'; },
  'disabled lifecycle': v => { v.resources.bindings.find(b => b.name === 'LARGE_HTTP_ENABLED').text = '0'; },
  'missing private assets': v => { v.resources.bindings = v.resources.bindings.filter(b => b.name !== 'ASSETS'); },
  'missing control token': v => { v.resources.bindings = v.resources.bindings.filter(b => b.name !== 'LARGE_HTTP_TOKEN'); },
  'actor namespace drift': v => { v.resources.bindings.find(b => b.name === 'USAGE_LEDGER').namespace_id = 'foreign'; },
  'queue owner drift': v => { v.resources.bindings.find(b => b.name === 'USAGE_QUEUE').queue_name = 'foreign'; },
  'KV owner drift': v => { v.resources.bindings.find(b => b.name === 'POLICY_KV').namespace_id = 'foreign'; },
  'archive owner drift': v => { v.resources.bindings.find(b => b.name === 'CONTENT_ARCHIVE').bucket_name = 'foreign'; },
  'native settings drift': v => { v.resources.bindings.find(b => b.name === 'LARGE_HTTP_TENANT_LIMIT').text = '1'; },
  'unknown extra binding': v => { v.resources.bindings.push({ name: 'UNREVIEWED', type: 'plain_text', text: '1' }); },
  'unattested artifact': v => { delete v.annotations['workers/message']; },
  'different runtime': v => { v.annotations['workers/message'] = v.annotations['workers/message'].replace(native.runtimeSha, 'f'.repeat(64)); },
};
for (const [label, change] of Object.entries(changes)) {
  test(`both recovery owners refuse ${label} without a deployment write`, async () => {
    for (const local of [false, true]) {
      const f = fixture(); change(f.versions[blue]);
      await assert.rejects(local ? recoverTrain({ api: f.api, state: f.state }) : recoverRemote(f.api, '123'));
      assert.equal(f.posts.length, 0);
    }
  });
}
test('missing remote receipt and foreign latest upload cannot authorize rollback', async () => {
  const f = fixture();
  delete f.state.native;
  await assert.rejects(recoverRemote(f.api, '123'), /receipt/);
  assert.equal(f.posts.length, 0);
  f.state.native = native;
  f.api.versions = async () => [{ id: '33333333-3333-3333-3333-333333333333' }, ...Object.values(f.versions)];
  await assert.rejects(recoverRemote(f.api, '123'), /Unproven/);
  assert.equal(f.posts.length, 0);
});
test('different native fingerprint stops before even zero-percent exposure', async () => {
  const f = fixture();
  f.api.latest = async () => ({ id: 'd0' });
  let uploaded = false, smokes = 0;
  f.api.versions = async () => uploaded ? [f.versions[green], f.versions[blue]] : [f.versions[blue]];
  await assert.rejects(runTrain({ api: f.api, state: f.state, upload: async () => {
    uploaded = true; f.versions[green].annotations['workers/message'] = uploadMessage(f.state).replace(native.runtimeSha, 'f'.repeat(64)); return green;
  }, smoke: async () => smokes++ }), /receipt differs|Different native/);
  assert.equal(smokes, 0); assert.equal(f.posts.length, 0);
});
