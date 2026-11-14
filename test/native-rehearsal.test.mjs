import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {writeFile,mkdir} from 'node:fs/promises';
import {openSavedCodex,finishTurn} from '../scripts/native-rehearsal-client.mjs';
import {readCodexCatalog} from '../scripts/codex-catalog.mjs';
import {join} from 'node:path';
import {hostedBoundaryFixture} from './helpers/native-rehearsal.mjs';
import {inspectSyntheticInput} from '../worker/native-rehearsal/input.ts';
import {rehearsalConfig,upstreamKey} from '../worker/native-rehearsal/contract.ts';
const worker='clawrouter-native-qualification-abcdef012345',origin='https://'+worker+'.fixture.workers.dev';
const sha='c'.repeat(64),seed='a'.repeat(64),hash=x=>createHash('sha256').update(x).digest('hex');
const config=()=>({schema:1,worker,origin,createdAt:Date.now()-1000,expiresAt:Date.now()+600000,maxStarts:24,maxRequests:8});
const env=()=>({NATIVE_REHEARSAL:JSON.stringify(config()),NATIVE_REHEARSAL_STATE:{},LARGE_HTTP_ORIGIN:origin,CLAWROUTER_PUBLIC_ORIGIN:origin,LARGE_HTTP_CAPACITY:'8',LARGE_HTTP_TESTING:'1'});
const body=(id,mode='success',context=seed)=>JSON.stringify({model:'gpt-6-astra',stream:true,input:[{role:'user',content:[{type:'input_text',text:'NATIVE_REHEARSAL_SEED:'+context+'\nNATIVE_REHEARSAL_CASE:'+id+':'+mode+':baseline'}]}]});

test('fixture configuration rejects production, deadline substitution and unbounded use',()=>{
 assert.equal(rehearsalConfig(env()).origin,origin);
 for(const patch of [{LARGE_HTTP_ORIGIN:'https://clawrouter.openclaw.ai'},{LARGE_HTTP_DEADLINE:'1'},{LARGE_HTTP_CAPACITY:'7'},{LARGE_HTTP_TESTING:'0'}, {NATIVE_REHEARSAL:JSON.stringify({...config(),maxRequests:65})},{NATIVE_REHEARSAL:JSON.stringify({...config(),expiresAt:Date.now()-1})}])assert.throws(()=>rehearsalConfig({...env(),...patch}));
});
test('synthetic scanner reads prior request context across arbitrary chunks, not a remembered fixed answer',async()=>{
 const bytes=new TextEncoder().encode(body('1'.repeat(32),'recall'));
 const r=new Request('https://api.openai.com/v1/responses',{method:'POST',body:new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close();}}),duplex:'half'});
 const actual=await inspectSyntheticInput(r);assert.equal(actual.seed,seed);assert.equal(actual.mode,'recall');assert.equal(actual.bytes,bytes.length);
 for(const input of [JSON.stringify({model:'gpt-6-astra',input:[{role:'user',content:[{type:'input_text',text:'NATIVE_REHEARSAL_CASE:'+'2'.repeat(32)+':recall:forward'}]}]}),body('3'.repeat(32)).slice(0,-1)])await assert.rejects(inspectSyntheticInput(new Request('https://api.openai.com/v1/responses',{method:'POST',body:input})));
});

test('fixture startup awaits intercepts, trusts runtime CA, retains native identity and fails without fallback',async()=>{
 const hooks=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.endsWith('.ts')&&!/\.[a-z]+$/i.test(s))return next(s+'.ts',c);if(s==='cloudflare:workers')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}};export class WorkerEntrypoint extends DurableObject {}')};return next(s,c);}});
 let Slot;try{({LargeHttpSlot:Slot}=await import('../worker/native-rehearsal-entry.ts'));}finally{hooks.deregister();}
 const effects=[],allow={},deny={},e=env();e.NATIVE_REHEARSAL_STATE={getByName:()=>({fetch:async()=>{effects.push('reserve');return Response.json({accepted:true});}})};
 const slot=Object.create(Slot.prototype);slot.env=e;let started;
 slot.ctx={exports:{NativeRehearsalEgress:()=>allow,NativeRehearsalDeny:deny},container:{interceptOutboundHttps:async(host,binding)=>{assert.equal(binding,allow);effects.push(host);},interceptAllOutboundHttp:async binding=>{assert.equal(binding,deny);effects.push('http-deny');},start:options=>{started=options;effects.push('start');}}};
 const options={image:'cloudflare/debian-trixie',enableInternet:true,instance:'standard-1',labels:{slot:'0',generation:'1',build:sha},env:{LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_SHA:sha,LARGE_HTTP_RUNTIME_TOKEN:'d'.repeat(64)},entrypoint:['node','--input-type=module','-e','/* unchanged production bootstrap */']};
 await slot.startContainer(options);assert.deepEqual(effects,['reserve','api.openai.com',new URL(origin).hostname,'http-deny','start']);
 assert.equal(started.enableInternet,false);assert.equal(started.env.NODE_EXTRA_CA_CERTS,'/etc/cloudflare/certs/cloudflare-containers-ca.crt');assert.equal(started.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);assert.deepEqual(started.labels,options.labels);assert.equal(started.env.LARGE_HTTP_RUNTIME_SHA,sha);assert.ok(started.entrypoint[3].endsWith(options.entrypoint[3]));
 effects.length=0;slot.ctx.container.interceptOutboundHttps=async()=>{throw Error('intercept unavailable');};await assert.rejects(slot.startContainer(options));assert.deepEqual(effects,['reserve']);
});


test('real fixture DO refuses missing context/replay, bounds starts, holds until explicit release, and keeps evidence content-free',async t=>{
 const f=await hostedBoundaryFixture(t);
 assert.equal((await f.call('setup',{seedHash:hash(seed),credentialHash:hash('synthetic-client')},'bad')).status,401);
 assert.equal((await f.call('setup',{seedHash:hash(seed),credentialHash:hash('synthetic-client')})).status,200);
 assert.equal((await f.call('setup',{seedHash:hash(seed),credentialHash:hash('synthetic-client')})).status,409);
 const ns=await f.mf.getDurableObjectNamespace('NATIVE_REHEARSAL_STATE','fixture'),stub=ns.get(ns.idFromName('native-rehearsal'));
 const internal=(op,value)=>stub.fetch('https://rehearsal/'+op,{method:'POST',body:JSON.stringify(value)});
 for(let n=0;n<24;n++)assert.equal((await internal('start',{slot:n%8,generation:1+Math.floor(n/8),runtimeSha:sha})).status,200);
 assert.equal((await internal('start',{slot:0,generation:4,runtimeSha:sha})).status,409);
 const request=(id,mode='success',context=seed)=>f.mf.dispatchFetch(origin+'/test-upstream',{method:'POST',body:body(id,mode,context)});
 assert.equal((await request('1'.repeat(32),'recall','b'.repeat(64))).status,409);
 const response=await request('2'.repeat(32));assert.equal(response.status,200);assert.match(await response.text(),new RegExp(hash(seed+':baseline:'+'2'.repeat(32))));
 assert.equal((await request('2'.repeat(32))).status,409);
 const hold=request('3'.repeat(32),'hold');
 for(let i=0;i<100;i++){const s=await(await f.call('snapshot')).json();if(s.cases.some(x=>x.mode==='hold'))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal((await f.call('release',{id:'3'.repeat(32)})).status,200);assert.equal((await hold).status,200);await (await hold).text();
 for(const url of ['https://api.openai.com/v1/chat/completions','http://api.openai.com/v1/responses','https://api.openai.com.evil.invalid/v1/responses',origin+'/v1/responses',origin+'/__large_http/runtime?redirect=1'])assert.equal((await f.mf.dispatchFetch(origin+'/test-denied',{method:'POST',headers:{'x-test-url':url},body:'{}'})).status,403);
 const snapshot=await(await f.call('snapshot')).json();assert.equal(snapshot.qualified,false);assert.equal(snapshot.replays,1);assert.equal(snapshot.starts.length,24);assert.equal(snapshot.cases.length,2);
 const text=JSON.stringify(snapshot);assert.ok(!text.includes(seed));assert.ok(!text.includes(upstreamKey));assert.ok(!text.includes('NATIVE_REHEARSAL_'));assert.deepEqual(f.outbound,[]);
});

// Official saved client, not an SDK or a mocked resume response. This validates
// fixture/client compatibility locally; it cannot qualify Cloudflare Containers.
test('official Codex persists and resumes the same thread; distinct follow-ups require previous context',{skip:!process.env.CLAWROUTER_CODEX_BINARY,timeout:90000},async t=>{
 const f=await hostedBoundaryFixture(t),home=join(f.directory,'codex');await mkdir(home,{mode:0o700});
 assert.equal((await f.call('setup',{seedHash:hash(seed),credentialHash:hash('synthetic-client')})).status,200);
 const url=new URL(await f.mf.ready).origin,key='clawrouter-live-rehearsal-synthetic-client',binary=process.env.CLAWROUTER_CODEX_BINARY;
 const {catalog}=await readCodexCatalog({routerUrl:url,providerId:'openai',codex:binary,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,CLAWROUTER_API_KEY:key}});
 await writeFile(join(home,'models.json'),JSON.stringify(catalog));
 await writeFile(join(home,'config.toml'),[
 'model = "gpt-6-astra"','model_provider = "rehearsal"','model_catalog_json = '+JSON.stringify(join(home,'models.json')),'web_search = "disabled"','approval_policy = "never"','sandbox_mode = "read-only"','cli_auth_credentials_store = "file"','[model_providers.rehearsal]','name = "Fixture"','base_url = '+JSON.stringify(url+'/v1/native/openai/v1'),'env_key = "CLAWROUTER_API_KEY"','wire_api = "responses"','requires_openai_auth = false','supports_websockets = false','request_max_retries = 0','stream_max_retries = 0'].join('\n'));
 let threadId;
 for(const [n,direction] of ['baseline','forward','recovery'].entries()){
  const opened=await openSavedCodex({binary,home,key,threadId});threadId??=opened.threadId;
  try{
   const caseId=String(n+1).repeat(32),text=(n===0?'NATIVE_REHEARSAL_SEED:'+seed+'\n':'')+'NATIVE_REHEARSAL_CASE:'+caseId+':'+(n===0?'seed':'recall')+':'+direction;
   const started=await opened.client.rpc('turn/start',{threadId,input:[{type:'text',text}],serviceTier:'default'});
   await finishTurn(opened.client,started,hash(seed+':'+direction+':'+caseId));
  }finally{await opened.client.close();}
 }
 const snapshot=await(await f.call('snapshot')).json();assert.equal(snapshot.cases.length,3);assert.equal(snapshot.replays,0);assert.deepEqual(snapshot.cases.map(x=>x.direction),['baseline','forward','recovery']);assert.deepEqual(f.outbound,[]);
});
