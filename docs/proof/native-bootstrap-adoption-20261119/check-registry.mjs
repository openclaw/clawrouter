import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNativeQualification,nativeControlDigest} from '../../../scripts/deploy-native-qualification.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),output=process.argv[2];
assert(output&&isAbsolute(output),'Fresh absolute receipt path outside checkout required');
const dest=resolve(realpathSync(dirname(output)),output.split('/').at(-1));assert(relative(root,dest).startsWith('../'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim(),sha=git('rev-parse','HEAD');
const tested='0d237fb6e1bd23b27862761ada6588d818150f9b',digest='a01be212ffdc671888dd043a2edb61ca627b668cefe9692e115b423ffae482a7';
assert.equal(nativeControlDigest(),digest);
const registry=JSON.parse(readFileSync(new URL('../../../config/native-cutovers.json',import.meta.url))),rows=registry.qualified.filter(q=>q.source===tested);
assert.equal(rows.length,2);assert.deepEqual(rows.map(q=>q.kind??'payload').sort(),['control','payload']);
const projection=JSON.parse(readFileSync(new URL('./HOSTED-PROJECTION.json',import.meta.url)));
assert.equal(projection.source,tested);assert.equal(projection.controlSha256,digest);
const rejected=[];
for(const row of rows){
 assert.equal(row.controlSha256,digest);
 assert.equal(row.blueRuntimeSha,projection.nativePayloads.old);assert.equal(row.greenRuntimeSha,row.kind==='control'?projection.nativePayloads.old:projection.nativePayloads.candidate);
 const hosted=projection.originalRows.find(r=>r.kind===(row.kind??'payload'));assert(hosted);assert.equal(row.evidence,hosted.url);
 for(const name of ['deployment','continuity-forward','continuity-recovery','accounting'])assert(hosted.cases[name].passed);
 const state={sha,blue:'11111111-1111-4111-8111-111111111111',green:'22222222-2222-4222-8222-222222222222',native:{schema:1,runtimeSha:row.greenRuntimeSha},unsafe:false,migration:false,
 cutover:{schema:1,...(row.kind?{kind:row.kind}:{}),blueRuntimeSha:row.blueRuntimeSha,nativeSource:'2b89f2dd9ca6710558716f540dcf9049548e0f2c',recovery:'33333333-3333-4333-8333-333333333333',phase:'prepared'}};
 assert.deepEqual(assertNativeQualification(state,registry,{cwd:root}),row);
 for(const [name,patch]of [['wrong-controller',{controlSha256:'0'.repeat(64)}],['missing-evidence',{evidence:''}],['unknown-source',{source:'f'.repeat(40)}]]){
  assert.throws(()=>assertNativeQualification(state,{schema:1,qualified:[{...row,...patch}]},{cwd:root}));rejected.push((row.kind??'payload')+':'+name);
 }
 assert.throws(()=>assertNativeQualification(state,{schema:1,qualified:[row,row]},{cwd:root}));rejected.push((row.kind??'payload')+':duplicate');
 const wrong=structuredClone(state);if(row.kind)delete wrong.cutover.kind;else wrong.cutover.kind='control';
 assert.throws(()=>assertNativeQualification(wrong,registry,{cwd:root}));rejected.push((row.kind??'payload')+':wrong-purpose');
}
const provenance=JSON.parse(readFileSync(new URL('./PROVENANCE.json',import.meta.url)));
for(const [name,hash]of Object.entries(provenance.portableSha256))assert.equal(createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex'),hash);
for(const [name,hash]of Object.entries(provenance.reusedSdkEvidenceSha256))assert.equal(createHash('sha256').update(readFileSync(new URL('../native-cutover-20261119/'+name,import.meta.url))).digest('hex'),hash);
const hold=readFileSync(new URL('../../../config/deployment-hold.json',import.meta.url),'utf8');assert.equal(hold,execFileSync('git',['show',tested+':config/deployment-hold.json'],{cwd:root,encoding:'utf8'}));
const receipt={at:new Date().toISOString(),passed:true,node:process.version,sha,testedSource:tested,controlSha256:digest,acceptedPurposes:rows.map(q=>q.kind??'payload'),rejected,portableHashesVerified:true,sourceHoldBytesUnchanged:true,remoteCalls:0,productionChanges:0,limits:'Actual local qualification guard and Git ancestry. Illustrative version IDs; no deployment or new hosted/SDK proof.'};
writeFileSync(dest,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));
