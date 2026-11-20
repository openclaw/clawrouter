import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {bootstrap} from '../runtime/large-http/bootstrap.ts';
import {bootstrapDiagnostics,dockerBootstrapDiagnostics} from './helpers/large-http-diagnostics.mjs';
test('actual bootstrap reports a closed origin failure without raw credential or URL',()=>{
 const r=spawnSync(process.execPath,['--input-type=module','-e',bootstrap],{encoding:'utf8',env:{PATH:process.env.PATH,LARGE_HTTP_ORIGIN:'https://secret-user:secret-password@invalid.example/path',LARGE_HTTP_RUNTIME_TOKEN:'sensitive-fixture-value'}});
 assert.equal(r.status,1);assert.equal(r.stdout,'');const rows=bootstrapDiagnostics(r.stderr);assert.equal(rows.length,1);assert.equal(rows[0].stage,'origin');assert.equal(rows[0].reason,'origin');assert.doesNotMatch(r.stderr,/secret-user|secret-password|invalid.example|sensitive-fixture-value/);
});
test('Docker diagnostics reject unknown fields, enums, oversized lines and raw logs',()=>{
 const good={category:'large_http_bootstrap_failed',stage:'fetch',status:null,reason:'operation_failed',name:'TypeError',code:null};
 for(const value of [{...good,token:'secret'},{...good,reason:'secret'},{...good,status:999},{...good,stage:'secret'}])assert.deepEqual(bootstrapDiagnostics(JSON.stringify(value)),[]);
 assert.deepEqual(bootstrapDiagnostics('raw secret\n'+JSON.stringify(good)+'\n'+('x'.repeat(2048))),[good]);
});

// This proof uses the pinned macOS canary Docker engine/image, outside the portable unit suite.
// Run explicitly with CLAWROUTER_BOOTSTRAP_DOCKER_PROOF=1 on that prepared host.
test('actual Docker stderr reaches the closed bootstrap diagnostic collector',{skip:process.env.CLAWROUTER_BOOTSTRAP_DOCKER_PROOF!=='1'},t=>{
 const image='sha256:e85849410b41b0e1f554f9633fb1a4504f3467e9927cbf9b998bf71c4055b65a',name='bootstrap-diagnostic-'+crypto.randomUUID();
 const docker=args=>execFileSync('/usr/local/bin/docker',['--host','unix:///Users/joshavant/.docker/run/docker.sock',...args],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 const id=docker(['create','--name',name,'--env','LARGE_HTTP_ORIGIN=https://invalid.example/path','--entrypoint','node',image,'--input-type=module','-e',bootstrap]).trim();
 try{
  try{docker(['start','-a',id]);}catch(e){assert.equal(e.status,1);}
  const rows=dockerBootstrapDiagnostics(id);assert.equal(rows.length,1);assert.equal(rows[0].stage,'origin');assert.equal(rows[0].reason,'origin');
  const state=JSON.parse(docker(['inspect',id]))[0];assert.equal(state.Image,image);assert.equal(state.State.ExitCode,1);assert.equal(state.Name,'/'+name);
  t.diagnostic(JSON.stringify({provider:'actual Docker CLI and pinned Node image',id,image,diagnostic:rows[0]}));
 }finally{docker(['rm','-f',id]);}
});
