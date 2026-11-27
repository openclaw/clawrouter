import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {bootstrap} from '../runtime/large-http/bootstrap.ts';
import {bootstrapProbePrefix,bootstrapReceiptUrl,bootstrapReceiptValid,closedBootstrapFailure} from '../worker/native-rehearsal/bootstrap.ts';
import {hostedBoundaryFixture} from './helpers/native-rehearsal.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');

test('actual Node bootstrap retains closed failure receipt and fetch TLS cause without log ingestion',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'native-bootstrap-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const key=join(directory,'fixture.key'),cert=join(directory,'fixture.crt');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const receipts=[],requests=[];
 const diagnostic=httpServer(async(r,s)=>{const chunks=[];for await(const c of r)chunks.push(c);receipts.push(JSON.parse(Buffer.concat(chunks)));s.end('{}');});
 await new Promise(r=>diagnostic.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>diagnostic.close(r)));
 const runtime=createServer({key:await readFile(key),cert:await readFile(cert)},(r,s)=>{requests.push(r.url);s.writeHead(401);s.end('{}');});
 await new Promise(r=>runtime.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>runtime.close(r)));
 // Only the fixed intercepted diagnostic URL is mapped to a local collector.
 // Runtime download uses real Node HTTPS, with and without the fixture CA.
 const shim=`{const f=globalThis.fetch;globalThis.fetch=(u,o)=>f(u===${JSON.stringify(bootstrapReceiptUrl)}?${JSON.stringify('http://127.0.0.1:'+diagnostic.address().port)}:u,o);}`;
 const run=async(extra={})=>{const child=spawn(process.execPath,['--input-type=module','-e',shim+bootstrapProbePrefix()+bootstrap],{env:{PATH:process.env.PATH,LARGE_HTTP_ORIGIN:'https://127.0.0.1:'+runtime.address().port,LARGE_HTTP_RUNTIME_TOKEN:'sensitive-fixture-token',...extra},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),8000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);return {code,out,err};};
 for(const [env,stage,reason,cause] of [
  [{LARGE_HTTP_ORIGIN:'https://fixture-user:fixture-password@invalid.example/path'},'origin','origin',null],
  [{},'fetch','operation_failed','DEPTH_ZERO_SELF_SIGNED_CERT'],
  [{NODE_EXTRA_CA_CERTS:cert},'headers','status',null],
 ]){
  receipts.length=0;const r=await run(env);assert.equal(r.code,1);assert.equal(r.out,'');
  assert.equal(receipts.length,2);assert(receipts.every(bootstrapReceiptValid));assert.equal(receipts[0].event,'entered');
  assert.equal(receipts[1].event,'exit');assert.equal(receipts[1].diagnostic.stage,stage);assert.equal(receipts[1].diagnostic.reason,reason);assert.equal(receipts[1].fetchCode,cause);
  assert.doesNotMatch(JSON.stringify(receipts)+r.err,/fixture-user|fixture-password|sensitive-fixture-token|invalid.example/);
  t.diagnostic(JSON.stringify({provider:'local Node HTTPS and exact product bootstrap',node:process.version,code:r.code,receipt:receipts[1],limits:'diagnostic intercept mapped to local HTTP; does not certify hosted Container egress'}));
 }
 assert.deepEqual(requests,['/__large_http/runtime']);
 // Broken diagnostic transport is classified separately and does not run bootstrap.
 const unavailable=spawn(process.execPath,['--input-type=module','-e','globalThis.fetch=async()=>new Response(null,{status:503});'+bootstrapProbePrefix()+'throw Error("bootstrap must not run");'],{stdio:'ignore'});
 assert.equal(await new Promise(r=>unavailable.once('exit',r)),86);
});

test('closed bootstrap schema refuses raw content and unknown fields',()=>{
 const d={category:'large_http_bootstrap_failed',stage:'fetch',status:null,reason:'operation_failed',name:'TypeError',code:null};
 assert(closedBootstrapFailure(d));assert(bootstrapReceiptValid({event:'exit',diagnostic:d,fetchCode:null}));
 for(const v of [{...d,message:'sensitive'},{...d,stage:'sensitive'},{...d,status:999},{...d,code:'sensitive'}])assert.equal(closedBootstrapFailure(v),null);
 for(const v of [{event:'entered',diagnostic:d,fetchCode:null},{event:'exit',diagnostic:d,fetchCode:'sensitive'},{event:'exit',diagnostic:d,fetchCode:null,token:'sensitive'}])assert.equal(bootstrapReceiptValid(v),false);
});

test('real workerd bootstrap journal binds identity, rejects public writes, bounds receipts and denies forwarding',async t=>{
 const f=await hostedBoundaryFixture(t),sha='c'.repeat(64),identity={slot:0,generation:1,runtimeSha:sha};
 assert.equal((await f.call('setup',{seedHash:hash('a'.repeat(64)),credentialHash:hash('synthetic-client')})).status,200);
 const ns=await f.mf.getDurableObjectNamespace('NATIVE_REHEARSAL_STATE','fixture'),stub=ns.get(ns.idFromName('native-rehearsal'));
 const internal=(op,v)=>stub.fetch('https://rehearsal/'+op,{method:'POST',body:JSON.stringify(v)});
 const entered={event:'entered',diagnostic:null,fetchCode:null};
 assert.equal((await f.call('bootstrap',{...identity,...entered})).status,404);
 const call=(v,url=bootstrapReceiptUrl)=>f.mf.dispatchFetch(f.origin+'/test-bootstrap',{method:'POST',headers:{'x-test-url':url},body:JSON.stringify(v)});
 assert.equal((await call(entered)).status,500,'missing start cannot create diagnostic identity');
 assert.equal((await internal('start',identity)).status,200);
 for(const url of ['http://other.invalid/bootstrap',bootstrapReceiptUrl+'?x=1','https://native-rehearsal.invalid/bootstrap',bootstrapReceiptUrl+'/'])assert.equal((await call(entered,url)).status,403);
 assert.equal((await call({...entered,token:'sensitive'})).status,400);
 assert.equal((await call(entered)).status,200);
 assert.equal((await internal('bootstrap',{...identity,runtimeSha:'b'.repeat(64),event:'exit',diagnostic:null,fetchCode:null})).status,409);
 const d={category:'large_http_bootstrap_failed',stage:'fetch',status:null,reason:'operation_failed',name:'TypeError',code:null};
 assert.equal((await call({event:'exit',diagnostic:d,fetchCode:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'})).status,200);
 assert.equal((await internal('bootstrap',{...identity,...entered})).status,409);
 const s=await(await f.call('snapshot')).json();assert.equal(s.starts[0].diagnostics.bootstrap.length,2);
 assert.equal(s.starts[0].diagnostics.bootstrap[1].fetchCode,'UNABLE_TO_VERIFY_LEAF_SIGNATURE');assert(!JSON.stringify(s).includes('sensitive'));assert.deepEqual(f.outbound,[]);
});
