import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {assertNativeQualification, nativeControlDigest} from '../../../scripts/deploy-native-qualification.mjs';
import {deploymentHold, assertNoDeploymentHold} from '../../../scripts/deploy-release-hold.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.argv[2];
assert(output && isAbsolute(output), 'Provide a fresh absolute receipt path outside the checkout');
const destination = resolve(realpathSync(dirname(output)), output.split('/').at(-1));
assert(relative(root, destination).startsWith('..' + '/'), 'Receipt must be outside the checkout');
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const sha = git('rev-parse', 'HEAD');
const registry = JSON.parse(readFileSync(new URL('../../../config/native-cutovers.json', import.meta.url)));
const row = registry.qualified[0];
assert.equal(registry.qualified.length, 1);
assert.equal(row.source, '25c972712d995070ffe0777a7888a749e433bdf4');
assert.equal(nativeControlDigest(), 'c68cd35e5c66bab05e7fc86f8242c46966df3de20d2ec194b6f1e5d9f497554c');
const state = {
  sha, blue: '11111111-1111-4111-8111-111111111111',
  green: '22222222-2222-4222-8222-222222222222',
  native: {schema: 1, runtimeSha: row.greenRuntimeSha}, unsafe: false, migration: false,
  cutover: {schema: 1, blueRuntimeSha: row.blueRuntimeSha,
    nativeSource: '2b89f2dd9ca6710558716f540dcf9049548e0f2c',
    recovery: '33333333-3333-4333-8333-333333333333', phase: 'prepared'},
};
assert.deepEqual(assertNativeQualification(state, registry, {cwd: root}), row);
const rejected = [];
for (const [name, patch] of [
  ['wrong-pair', {greenRuntimeSha: '0'.repeat(64)}],
  ['wrong-controller', {controlSha256: '0'.repeat(64)}],
  ['missing-evidence', {evidence: undefined}],
]) {
  assert.throws(() => assertNativeQualification(state, {schema: 1, qualified: [{...row, ...patch}]}, {cwd: root}));
  rejected.push(name);
}
const holdBytes = readFileSync(new URL('../../../config/deployment-hold.json', import.meta.url), 'utf8');
assert.equal(JSON.parse(holdBytes).hold, true);
assert.equal(holdBytes, execFileSync('git', ['show', row.source + ':config/deployment-hold.json'], {cwd: root, encoding: 'utf8'}));
assert(deploymentHold(sha, root));
assert.throws(() => assertNoDeploymentHold(sha, root), /held/);
const provenance = JSON.parse(readFileSync(new URL('./PROVENANCE.json', import.meta.url)));
for (const [name, expected] of Object.entries(provenance.portableSha256))
  assert.equal(createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex'), expected);
const receipt = {schema: 1, at: new Date().toISOString(), passed: true, provider: 'local-macos',
  node: process.version, sha, registrySha256: createHash('sha256').update(JSON.stringify(registry)).digest('hex'),
  testedSource: row.source, controlSha256: nativeControlDigest(), exactPairAccepted: true, rejected,
  sourceHoldEffective: true, holdByteIdentical: true, portableProvenanceVerified: true,
  limits: 'Actual local gate and Git ancestry, not deployment. Fixed illustrative version IDs. Hosted evidence remains independently scoped; no remote calls.'};
writeFileSync(destination, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(JSON.stringify(receipt));
