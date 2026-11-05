import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";

// Use the same locked Wrangler dependencies as the shared harness, with an
// explicit second isolate. No shared module singleton can lend control authority.
async function isolatedFixture(directory, source, upstreamSource, bindings) {
 const require=createRequire(import.meta.resolve('wrangler/package.json'));
 const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
 const bundled=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'copilot-isolation-fixture.ts',loader:'ts'},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const classes={ACCESS_CONTROL:'PolicyBindingIndexObject',BUDGET_LEDGER:'BudgetLedgerObject',USAGE_LEDGER:'UsageLedgerObject',GRANT_CREDENTIALS:'GrantCredentialObject'};
 const objects=external=>Object.fromEntries(Object.entries(classes).map(([name,className])=>[name,{className,useSQLite:true,unsafePreventEviction:true,...(external?{scriptName:'owner'}:{})}]));
 const common={modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-06-05',compatibilityFlags:['enable_request_signal'],bindings:{CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS:'0',...bindings},kvNamespaces:{POLICY_KV:'copilot-fixture-policy'},outboundService:'upstream'};
 const runtime=new Miniflare(convertV4MiniflareOptions({resourceTmpPath:directory,workers:[
  {...common,name:'front',durableObjects:objects(true)},
  {...common,name:'owner',durableObjects:objects(false),queueProducers:{USAGE_QUEUE:'usage'},queueConsumers:{usage:{maxBatchSize:1,maxBatchTimeout:0}}},
  {name:'upstream',modules:true,script:upstreamSource,compatibilityDate:'2026-06-05',compatibilityFlags:['enable_request_signal']},
 ]}));
 try{await runtime.ready;return runtime;}catch(error){await runtime.dispose();throw error;}
}

const origin = "https://router.example", issuer = "https://device-workerd.cloudflareaccess.com";
const email = "device-admin@example.invalid", key = "oauth/fixture/copilot";
const path = "/v1/admin/upstream-grants/policies/fixture/copilot/authorize";
async function access() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "device-workerd-key" };
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", kid: jwk.kid })}.${enc({ iss: issuer, aud: "device-workerd", email, sub: "device-workerd-admin", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return { jwk, jwt: `${unsigned}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned))).toString("base64url")}` };
}

const MiB=1024*1024;
function maximumAccount(){
 const prefix='https://api.individual.githubcopilot.com/',root={endpoints:{api:prefix+'\ud800'.repeat(4096-prefix.length)}};
 let deep={};root.deep=deep;for(let i=1;i<63;i++){deep.n={};deep=deep.n;}root.rows=Array(2048).fill(null);
 for(let i=0;i<446;i++)root['o'+i]={};for(let i=0;i<1536;i++)root['s'+i]='';root.s0='x'.repeat(16*MiB-Buffer.byteLength(JSON.stringify(root)));
 return JSON.stringify(root);
}
function maximumCatalog(){
 const data=Array.from({length:4096},(_,i)=>({id:'model-'+i,model_picker_enabled:true,policy:{state:'enabled'},supported_endpoints:['/responses']}));
 const text='{"data":'+JSON.stringify(data)+',"discarded":['+'['.repeat(62)+']'.repeat(62)+','+'[],'.repeat(20416)+'null,'.repeat(102401)+'null],"meta":{'+Array(110588).fill('"":0').join(',')+'},"padding":"';
 const result=text+'x'.repeat(2*MiB-Buffer.byteLength(text+'"}'))+'"}';assert.equal(Buffer.byteLength(result),2*MiB);return result;
}
async function ioFixture(t){
 let mode='setup';const gates=new Map(),released=new Set(),counts={account:0,catalog:0,inference:0};
 const server=createServer(async(req,res)=>{
  if(req.url.startsWith('/gate/')){if(released.has(req.url))res.end('released');else gates.set(req.url,res);return;}
  const phase=req.url==='/account'?'account':req.url==='/catalog'?'catalog':req.url==='/inference'?'inference':null;if(!phase){res.writeHead(404);res.end();return;}counts[phase]++;
  if(phase==='inference'){
   let body='';for await(const part of req)body+=part;const input=JSON.parse(body),format=req.headers['x-fixture-api'];let text;
   const value=format==='messages'?{id:'reply',type:'message',role:'assistant',model:'model-0',content:[{type:'text',text:'hello'}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:3}}:format==='responses'?{id:'reply',object:'response',status:'completed',model:'model-0',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'hello'}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}}:{id:'reply',object:'chat.completion',model:'model-0',choices:[{index:0,message:{role:'assistant',content:'hello'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}};
   if(['held-inference','cleanup-error','revoke','replace','account-cancel','account-borrow'].includes(mode)){res.writeHead(200,{'content-type':input.stream?'text/event-stream':'application/json'});res.write(' ');return;}
   if(input.stream){const frame='data: '+JSON.stringify({model:'model-0',choices:[{delta:{content:'hello'}}]})+'\n\n';text=format==='messages'?'event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{...value,content:[],stop_reason:null,usage:{input_tokens:2,output_tokens:0}}})+'\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n':format==='responses'?'event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:value})+'\n\n':frame+'data: [DONE]\n\n';
    if(mode==='maximum-stream'){const prefix='data: {"x":"',suffix='"}\n\n',chunk=prefix+'x'.repeat(65536-Buffer.byteLength(prefix+suffix))+suffix;text=chunk.repeat(512);}
    if(mode==='incremental'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame);gates.set('/gate/incremental/stream',{end(){res.end('data: [DONE]\n\n');}});return;}
    if(mode==='bad-frame')text=frame+'data: {"x":['+Array(4096).fill(0).join(',')+']}\n\n';
   }else{text=JSON.stringify(value);if(mode==='maximum')text='{"x":"'+'x'.repeat(262144-8)+'"}';}
   res.writeHead(200,{'content-type':input.stream?'text/event-stream':'application/json','content-length':Buffer.byteLength(text)});res.end(text);return;
  }

  if((mode==='held-account'&&phase==='account')||(['held-catalog','discovery-held','discovery-control','discovery-revoke'].includes(mode)&&phase==='catalog')||(['held-inference','cleanup-error','revoke','replace','account-cancel','account-borrow'].includes(mode)&&phase==='inference')){res.writeHead(200,{'content-type':'application/json'});res.write(' ');return;}
  let text=phase==='account'?(['maximum','discovery-max'].includes(mode)?maximumAccount():'{"endpoints":{"api":"https://api.individual.githubcopilot.com/v1"}}')
   :(mode==='discovery-overflow'?JSON.stringify({data:Array.from({length:4096},(_,i)=>({id:'model-'+i+'x'.repeat(240),model_picker_enabled:true,policy:{state:'enabled'},supported_endpoints:['/chat/completions','/responses','/messages']}))}):['maximum','discovery-max'].includes(mode)?maximumCatalog():JSON.stringify({data:mode==='empty'?[]:[{id:'model-0',model_picker_enabled:true,policy:{state:mode==='unknown'?'future':'enabled'},supported_endpoints:['/chat/completions','/messages','/responses']}]}));
  if(mode==='destination'&&phase==='account')text='{"endpoints":{"api":"https://api.business.githubcopilot.com"}}';
  res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(text)});res.end(text);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 return{origin:`http://127.0.0.1:${server.address().port}`,setMode(m){mode=m;},counts,release(name){const p='/gate/'+name;released.add(p);gates.get(p)?.end('released');gates.delete(p);}};
}
const router=`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {GrantCredentialObject as Owner,inspectGrantCredentials,putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {authorityCall} from './worker/authority.ts';
import {authenticateProxyKey} from './worker/proxy-auth.ts';
import {publicControlAuthorization} from './worker/response-control-authorization.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
let mode='setup',readers=[],currentKey,contextEnv,firstSignal,events=[];
const originalFetch=globalThis.fetch,gate=phase=>originalFetch('https://catalog-fixture.example/gate/'+mode+'/'+phase).then(r=>r.text());
globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input),phase=url.includes('/copilot_internal/user')?'account':url.endsWith('/models')?'catalog':url.startsWith('https://api.individual.githubcopilot.com/')?'inference':null;
 const response=await originalFetch(input,init);if(!phase||mode==='setup')return response;
 if(phase==='account')firstSignal=init.signal;else if(firstSignal!==init.signal)throw Error('operation signal changed');
 const a={phase,reads:0,cancels:0,unlocks:0,readRetired:false,cleanup:false,body:response.body,maximumBacking:0};readers.push(a);
 const getReader=response.body.getReader.bind(response.body);
 response.body.getReader=options=>{const native=getReader(options);return{
  async read(view){a.reads++;const exact=mode==='reads-exact'||mode==='discovery-reads',over=mode==='reads-over-'+phase;
   if((exact||over)&&a.reads<=(over?8191:8190))return{done:false,value:view.subarray(0,0)};
   const pending=native.read(view);
   try{const part=await pending;if(part.value)a.maximumBacking=Math.max(a.maximumBacking,part.value.buffer.byteLength);return part;}
   finally{if(((mode==='held-account'&&phase==='account')||(['held-catalog','profile-revision','discovery-held','discovery-control','discovery-revoke','discovery-profile'].includes(mode)&&phase==='catalog')||(['held-inference','cleanup-error','revoke','replace','account-cancel','account-borrow'].includes(mode)&&phase==='inference'))&&a.reads===(['profile-revision','discovery-profile'].includes(mode)?1:2)){await gate('read');a.readRetired=true;}}
  },async cancel(reason){a.cancels++;await native.cancel(reason);if(mode.startsWith('held-')||['cleanup-error','revoke','replace','account-cancel','account-borrow','late','discovery-held','discovery-control','discovery-revoke','discovery-late'].includes(mode)){await gate('cleanup');a.cleanup=true;}if(mode==='cleanup-error')throw Error('synthetic cleanup failure');},
  releaseLock(){native.releaseLock();a.unlocks++;}};};
 if(mode==='late'&&phase==='inference'||mode==='discovery-late'&&phase==='catalog')await gate('response');
 if(['tighten','discovery-tighten'].includes(mode)&&phase==='catalog')await authorityCall(contextEnv,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:[]}});
 if(mode==='discovery-digest'&&phase==='catalog')compiled.models[0].pricing_ref='changed-tariff';
 return response;
};
export class GrantCredentialObject extends Owner{
 constructor(state,env){super(state,{...env,USAGE_QUEUE:{async send(event){events.push(event);}}});this.fixtureState=state;this.fixtureEnv=env;}
 async fetch(request){const p=new URL(request.url).pathname;
  if(p==='/fixture/mode'){mode=await request.text();configureCompiled(mode);readers=[];events=[];return Response.json({ok:true});}
  if(p==='/fixture/stats'){const competitor=new BodyLease(),admitted=competitor.grow(8*1024*1024);competitor.release();return Response.json({charged:bodyBudgetCharged(),contender:admitted,events,readers:readers.map(a=>({phase:a.phase,reads:a.reads,cancels:a.cancels,unlocks:a.unlocks,locked:a.body.locked,readRetired:a.readRetired,cleanup:a.cleanup,maximumBacking:a.maximumBacking}))});}
  if(p==='/copilot-public/execute'){
   contextEnv=this.fixtureEnv;
   const a={phase:'input',reads:0,cancels:0,unlocks:0,maximumBacking:0,body:request.body};readers.push(a);
   const get=request.body.getReader.bind(request.body);
   request.body.getReader=options=>{const r=get(options);return{async read(view){a.reads++;if((mode==='reads-exact'||mode==='reads-over-input')&&a.reads<=(mode==='reads-over-input'?8191:8190))return{done:false,value:view.subarray(0,0)};try{const part=await r.read(view);if(part.value)a.maximumBacking=Math.max(a.maximumBacking,part.value.buffer.byteLength);return part;}finally{if(mode==='held-input'&&a.reads===1){await gate('read');a.readRetired=true;}}},async cancel(reason){a.cancels++;await r.cancel(reason);if(mode==='held-input'){await gate('cleanup');a.cleanup=true;}},releaseLock(){a.unlocks++;r.releaseLock();}};};
  }
  return super.fetch(request);
 }
}
import {snapshot} from './worker/providers.ts';
const source=structuredClone(snapshot.providers.find(p=>p.id==='openai')),template=source.endpoints.find(e=>e.request_format==='openai.chat_completions');
const formats=['openai.chat_completions','openai.responses','anthropic.messages'],paths=['/chat/completions','/responses','/messages'],caps=['llm.chat','llm.responses','llm.messages'];
const compiled={...source,id:'github-copilot',config_keys:[],optional_config_keys:[],auth:{schemes:[{type:'oauth',tokenRef:'copilot'}],authorization:null,refresh:null,grantTransports:{}},routing:{...source.routing,modelPrefixes:['github-copilot/']},
 endpoints:formats.map((format,i)=>({...template,id:'api_'+i,path:paths[i],request_format:format,response_format:format,method:'POST',methods:['POST'],native_proxy:true,streaming:'sse',path_params:[],query:{},headers:{},auth:undefined,upstreamPath:undefined,websocket:undefined,lifecycle:undefined,responsesLifecycle:undefined,modelPassthrough:undefined})),
 capabilities:caps.map((id,i)=>({id,endpoint:'api_'+i,methods:['POST']})),models:[{id:'github-copilot/model-0',upstream:'model-0',capabilities:caps,pricing_ref:null,pricing:{inputPerMillion:1,outputPerMillion:1}}]};
snapshot.providers.push(compiled);
function configureCompiled(mode){compiled.models=Array.from({length:['discovery-max','discovery-overflow'].includes(mode)?4096:1},(_,i)=>{const upstream='model-'+i+(mode==='discovery-overflow'?'x'.repeat(240):'');return{id:'github-copilot/'+upstream,upstream,capabilities:caps,pricing_ref:null,pricing:null};});}
let frontLease,frontReads=0,frontChargedAtRead=[];
export default{async fetch(request,env,ctx){
 const url=new URL(request.url),key='oauth/fixture/'+(url.searchParams.get('grant')??'copilot');
 if(url.pathname==='/fixture/front-hold'){frontLease=new BodyLease();return Response.json({admitted:frontLease.grow(48*1024*1024),charged:bodyBudgetCharged()});}
 if(url.pathname==='/fixture/front-release'){frontLease?.release();frontLease=undefined;return Response.json({charged:bodyBudgetCharged()});}
 if(url.pathname==='/fixture/front-stats')return Response.json({charged:bodyBudgetCharged(),reads:frontReads,admission:frontChargedAtRead});
 if(url.pathname==='/fixture/setup'){
  await authorityCall(env,'/users/initialize-all',[{email:${JSON.stringify(email)},record:{role:'admin',tenantId:'default',enabled:true,groups:[],contentRetentionDisabled:false}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null,requestCostMicros:9999,requestCostsMicros:{'llm.chat':700,'llm.responses':1100,'llm.messages':1300},grantRouting:{eligibleGrants:{'github-copilot':[key.split('/').at(-1)]}}}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'catalog',credential:{enabled:true,policyId:'fixture',policyGeneration:'g1',principalId:null,secretSha256:await sha256Hex('abcdefgh')}}]);return Response.json({ok:true});
 }
 if(url.pathname==='/fixture/policy'){await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null,requestCostMicros:9999,requestCostsMicros:{'llm.chat':700,'llm.responses':1100,'llm.messages':1300},grantRouting:{eligibleGrants:{'github-copilot':[key.split('/').at(-1)]}}}});return Response.json({ok:true});}
 if(url.pathname==='/fixture/unknown'){await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null,monthlyBudgetMicros:1000,grantRouting:{eligibleGrants:{'github-copilot':[key.split('/').at(-1)]}}}});return Response.json({ok:true});}
 if(url.pathname==='/fixture/mode'){mode=url.searchParams.get('mode')??'setup';configureCompiled(mode);frontReads=0;frontChargedAtRead=[];}
 if(url.pathname==='/fixture/mode'||url.pathname==='/fixture/stats')return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch('https://clawrouter.internal'+url.pathname,{method:'POST',body:url.searchParams.get('mode')??''});
 if(url.pathname==='/fixture/owner'){const g=await inspectGrantCredentials(env,key);return Response.json({generation:g.credentialGeneration,lineage:g.credentialLineage,status:g.credentialStatus,hasAccessToken:g.hasAccessToken,hasCredential:g.hasCredential});}
 if(url.pathname==='/fixture/revoke'){await revokeGrantCredentials(env,key);return Response.json({ok:true});}
 if(url.pathname==='/fixture/replace'){await putGrantCredentials(env,key,{provider:'github-copilot',kind:'api_key',credential:'synthetic-replacement'});return Response.json({ok:true});}
 if(url.pathname.startsWith('/v1/native/github-copilot/')||url.pathname.startsWith('/v1/proxy/github-copilot/')||url.searchParams.get('provider')==='github-copilot'){
  const keyForRequest='oauth/fixture/'+request.headers.get('x-fixture-grant');
  const abort=new AbortController();if(mode.startsWith('held-')||['cleanup-error','late','profile-revision','discovery-held','discovery-late'].includes(mode))ctx.waitUntil(gate('abort').then(()=>abort.abort()));
  request=new Request(request,{signal:abort.signal});if(request.body){const get=request.body.getReader.bind(request.body);
  request.body.getReader=options=>{const r=get(options);return{async read(view){frontReads++;if(frontReads===1){const s=await env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(keyForRequest)).fetch('https://clawrouter.internal/fixture/stats',{method:'POST'});frontChargedAtRead.push((await s.json()).charged);}return r.read(view);},cancel:reason=>r.cancel(reason),releaseLock:()=>r.releaseLock()};};}
 }
 return worker.fetch(request,env,ctx);
},queue:worker.queue};`;
function upstream(io,signed){return `export default{async fetch(request){
 if(request.url===${JSON.stringify(issuer+'/cdn-cgi/access/certs')})return Response.json({keys:[${JSON.stringify(signed.jwk)}]});
 if(request.url==='https://github.com/login/device/code')return Response.json({device_code:'synthetic-private-device-code',user_code:'SYNTHETIC-CODE',verification_uri:'https://github.com/login/device',expires_in:900,interval:1});
 if(request.url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'synthetic-original-github-token',token_type:'bearer',scope:'read:user'});
 const phase=request.url==='https://api.github.com/copilot_internal/user'?'account':request.url.startsWith('https://api.individual.githubcopilot.com/')&&request.url.endsWith('/models')?'catalog':request.url.startsWith('https://api.individual.githubcopilot.com/')?'inference':null;
 if(phase){if(request.method!==(phase==='inference'?'POST':'GET')||request.headers.get('authorization')!=='Bearer synthetic-original-github-token'||request.headers.has('cf-access-jwt-assertion'))throw Error('original token');
  if(phase==='catalog'&&request.headers.get('copilot-integration-id')!=='fixture')throw Error('runtime identity');return fetch(${JSON.stringify(io.origin)}+'/'+phase,{method:request.method,...(phase==='inference'?{body:request.body,headers:{'x-fixture-api':new URL(request.url).pathname.split('/').at(-1)}}:{}),signal:request.signal});}
 if(request.url.startsWith('https://catalog-fixture.example/gate/'))return fetch(${JSON.stringify(io.origin)}+new URL(request.url).pathname);
 return new Response(null,{status:400});}};`;}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(Error(label+' did not settle')),5000);})]);}finally{clearTimeout(timer);}}
async function body(response,status=200){const text=await response.text();assert.equal(response.status,status,text);assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(text,/synthetic-original|synthetic-private|apiBaseUrl|ownerBinding|copilotAccountBinding/);return JSON.parse(text);}



// This fixture runs the public Worker and credential owner in distinct isolates.
// Fixture-only gates instrument ORIGINAL request readers; they do not replace
// the production dispatch, control capability or credential publication path.
test('actual isolated public Copilot native and manifest admission, tariffs and retirement',{timeout:180000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'copilot-public-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const io=await ioFixture(t),signed=await access(),runtime=await isolatedFixture(directory,router,upstream(io,signed),{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'device-workerd',CLAWROUTER_ACCESS_ADMIN_EMAILS:email});t.after(()=>runtime.dispose());
 const request=(p,grant,mode)=>runtime.dispatchFetch(origin+p+'?grant='+grant+(mode?'&mode='+mode:''));
 const control=async(p,grant,mode)=>{const r=await request(p,grant,mode);assert.equal(r.status,200,await r.clone().text());return r.json();};
 const adminHeaders={origin,'content-type':'application/json','cf-access-jwt-assertion':signed.jwt};
 const run=(grant,flow,value)=>runtime.dispatchFetch(origin+path.replace('/copilot/','/'+grant+'/')+'?flow='+flow,{method:'POST',headers:adminHeaders,body:JSON.stringify({flow,provider:'github-copilot',...value})});
 const profile={integrationId:'fixture',editorVersion:'Fixture/1',editorPluginVersion:'Fixture/1',userAgent:'Fixture/1',initiator:'agent'};
 const configure=async(value=profile)=>{const r=await runtime.dispatchFetch(origin+'/v1/admin/credentials/catalog',{method:'PUT',headers:adminHeaders,body:JSON.stringify({policyId:'fixture',enabled:true,copilotPublicIdentity:value})});assert.equal(r.status,200,await r.clone().text());assert.doesNotMatch(await r.text(),/copilotPublicIdentity|integrationId|revision/);};
 const until=async(grant,predicate)=>{let s;for(let i=0;i<150;i++){s=await control('/fixture/stats',grant);if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}assert.fail(JSON.stringify(s));};
 await control('/fixture/setup','copilot');
 const apiFormats=['openai.chat_completions','openai.responses','anthropic.messages'],apiPaths=['/chat/completions','/responses','/messages'],tariffs=[700,1100,1300];
 const cases=[...['native','manifest'].flatMap(route=>apiFormats.flatMap((format,index)=>[false,true].map(stream=>({mode:route+'-'+index+'-'+stream,route,format,index,stream})))),...['maximum','maximum-stream','reads-exact','reads-over-input','held-input','held-account','held-catalog','held-inference','cleanup-error','late','revoke','replace','account-cancel','profile-revision','unknown-price','missing-profile','empty','destination','downstream-cancel','discovery-max','discovery-overflow','discovery-digest','discovery-tighten','discovery-reads','discovery-models','discovery-held','discovery-control','discovery-revoke','discovery-late','discovery-profile'].map(mode=>({mode,route:'native',format:apiFormats[1],index:1,stream:mode==='maximum-stream'}))];
 for(const {mode,route,format,index,stream} of cases)await t.test(mode,async t=>{
  const grant='public-'+mode;
  t.after(async()=>{for(const phase of ['abort','response','cleanup','read','stream'])io.release(mode+'/'+phase);await until(grant,s=>s.charged===0);});
  io.setMode(['maximum','discovery-max'].includes(mode)?'maximum':'setup');await control('/fixture/policy',grant);await control('/fixture/mode',grant,'setup');await configure();
  const begun=await body(await run(grant,'copilot-device.v1',{operation:'begin',githubDomain:'github.com',intentId:'synthetic-public-'+mode,expectedGeneration:0}));
  await new Promise(r=>setTimeout(r,Math.max(0,begun.nextPollAt-Date.now())+10));
  assert.equal((await body(await run(grant,'copilot-device.v1',{operation:'poll',attemptId:begun.attemptId}))).status,'committed');
  const original=await control('/fixture/owner',grant),account=operation=>run(grant,'copilot-account.v1',{operation,attemptId:begun.attemptId,expectedGeneration:original.generation,expectedLineage:original.lineage});
  assert.equal((await body(await account('qualify'))).status,'qualified');await until(grant,s=>s.charged===0);
  io.setMode(mode);await control('/fixture/mode',grant,mode);if(mode==='unknown-price')await control('/fixture/unknown',grant);if(mode==='missing-profile')await configure(null);
  const counts={...io.counts},native={model:route==='native'?'model-0':'github-copilot/model-0',stream,...(index===2?{max_tokens:128}:{}),...(index===1?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})};
  const value=route==='native'?native:{body:native};if(mode==='maximum'){native.padding='';native.padding='x'.repeat(262144-Buffer.byteLength(JSON.stringify(value)));}
  const pending=mode.startsWith('discovery-')?runtime.dispatchFetch(origin+(mode==='discovery-models'?'/v1/models':'/v1/catalog')+'?provider=github-copilot',{headers:{authorization:'Bearer clawrouter-live-catalog-abcdefgh'}}):runtime.dispatchFetch(origin+(route==='native'?'/v1/native/github-copilot'+apiPaths[index]:'/v1/proxy/github-copilot/api_'+index),{method:'POST',headers:{authorization:'Bearer clawrouter-live-catalog-abcdefgh','content-type':'application/json','x-fixture-grant':grant,'copilot-integration-id':'forged','x-initiator':'user'},body:JSON.stringify(value)});
  const held=mode.startsWith('held-')||['cleanup-error','late','revoke','replace','account-cancel'].includes(mode);
  if(mode.startsWith('discovery-')){
   if(['discovery-held','discovery-control','discovery-revoke','discovery-late'].includes(mode)){
    await until(grant,s=>s.readers.some(r=>r.phase==='catalog'&&r.reads===(mode==='discovery-late'?0:2)));
    assert.equal((await control('/fixture/stats',grant)).charged,96*MiB);
    if(mode==='discovery-control'){assert.equal((await body(await bounded(account('status'),'discovery status'))).status,'qualified');assert.equal((await body(await bounded(account('cancel'),'discovery cancellation'))).status,'cancelled');}
    else if(mode==='discovery-revoke')await bounded(control('/fixture/revoke',grant),'discovery revocation');else io.release(mode+'/abort');
    const response=await bounded(pending,'prompt discovery failure');assert.ok(response.status>=400);await response.arrayBuffer();
    if(mode==='discovery-late')io.release(mode+'/response');
    let stats=await until(grant,s=>s.readers.some(r=>r.phase==='catalog'&&r.cancels===1));assert.equal(stats.charged,96*MiB);assert.equal(stats.contender,false);assert.equal(stats.readers.find(r=>r.phase==='catalog').locked,true);
    io.release(mode+'/cleanup');await until(grant,s=>s.readers.some(r=>r.phase==='catalog'&&r.cleanup));if(mode!=='discovery-late'){assert.equal((await control('/fixture/stats',grant)).charged,96*MiB);io.release(mode+'/read');}
    stats=await until(grant,s=>s.charged===0);assert.ok(stats.readers.every(r=>!r.locked));assert.equal(stats.events.length,0);assert.equal(io.counts.inference-counts.inference,0);return;
   }
   if(mode==='discovery-profile'){await until(grant,s=>s.readers.some(r=>r.phase==='catalog'&&r.reads===1));await configure({...profile,userAgent:'Fixture/2'});io.release(mode+'/read');}
   const response=await pending;const text=await response.text();
   if(['discovery-overflow','discovery-digest','discovery-profile'].includes(mode)){assert.ok(response.status>=400,text);assert.doesNotMatch(text,/model-0|clawrouter.client-catalog/);}
   else{assert.equal(response.status,200,text);assert.ok(Buffer.byteLength(text)<=4*MiB);const result=JSON.parse(text);if(mode==='discovery-models')assert.equal(result.data.length,1);else{assert.equal(result.providers[0].models.length,mode==='discovery-max'?4096:mode==='discovery-tighten'?0:1);if(mode==='discovery-max')assert.equal(result.providers[0].offers.length,4096);}}
   const stats=await until(grant,s=>s.charged===0);assert.equal(stats.events.length,0);assert.equal(io.counts.inference-counts.inference,0);assert.ok(stats.readers.every(r=>!r.locked&&r.maximumBacking<=16384));if(mode==='discovery-reads')assert.equal(stats.readers.reduce((n,r)=>n+r.reads,0),16384);
  }else if(mode==='profile-revision'){
   await until(grant,s=>s.readers.some(r=>r.phase==='catalog'&&r.reads===1));await configure({...profile,editorVersion:'Fixture/2'});io.release(mode+'/read');
   const response=await bounded(pending,'profile revision denial');assert.ok(response.status>=400);await response.arrayBuffer();await until(grant,s=>s.charged===0);assert.equal(io.counts.inference-counts.inference,0);
  }else if(held){
   const target=mode==='held-input'?'input':mode==='held-account'?'account':['held-catalog','profile-revision'].includes(mode)?'catalog':'inference';
   const response=target==='inference'&&mode!=='late'?await pending:null,consuming=response?.text();if(consuming)void consuming.catch(()=>{});
   await until(grant,s=>s.readers.some(r=>r.phase===target&&r.reads===(mode==='late'?0:mode==='held-input'?1:2)));
   if(mode==='revoke'||mode==='replace')await bounded(control('/fixture/'+mode,grant),'owner mutation');
   else if(mode==='account-cancel'){assert.equal((await body(await bounded(account('status'),'account status'))).status,'qualified');assert.equal((await body(await bounded(account('cancel'),'account cancellation'))).status,'cancelled');}
   else io.release(mode+'/abort');
   if(consuming)await assert.rejects(bounded(consuming,'prompt response failure'));else {const r=await bounded(pending,'prompt public failure');const text=await r.text();assert.ok(r.status>=400,text);}
   let stats=await control('/fixture/stats',grant);assert.equal(stats.charged,96*MiB);assert.equal(stats.contender,false);
   if(mode==='late')io.release(mode+'/response');
   stats=await until(grant,s=>s.readers.some(r=>r.phase===target&&r.cancels===1));assert.equal(stats.readers.find(r=>r.phase===target).locked,true);
   io.release(mode+'/cleanup');if(mode!=='late')io.release(mode+'/read');
   stats=await until(grant,s=>s.charged===0);assert.ok(stats.readers.every(r=>!r.locked));
   assert.equal(io.counts.inference-counts.inference,target==='inference'?1:0);
  }else{
   const response=await pending;
   if(mode==='downstream-cancel'){assert.equal(response.status,200);await response.body.cancel();}
   else if(mode==='unknown-price'){await body(response,400);assert.deepEqual(io.counts,counts);}
   else if(['missing-profile','empty','destination'].includes(mode)){assert.ok(response.status>=400);await response.arrayBuffer();}
   else if(mode==='reads-over-input'){await body(response,503);}
   else{assert.equal(response.status,200,await response.clone().text());const text=await response.text();if(mode==='maximum')assert.equal(Buffer.byteLength(text),262144);if(mode==='maximum-stream')assert.equal(Buffer.byteLength(text),32*MiB);}
   const stats=await until(grant,s=>s.charged===0),front=await control('/fixture/front-stats',grant);
   assert.ok(stats.readers.every(r=>!r.locked&&r.unlocks===1&&r.maximumBacking<=16384));
   if(mode==='missing-profile'){assert.equal(front.reads,0);assert.deepEqual(io.counts,counts);}else assert.deepEqual(front.admission,[96*MiB]);
   if(io.counts.inference>counts.inference){assert.equal(stats.events.length,1);assert.equal(stats.events[0].actual_cost_micros,tariffs[index]);assert.equal(stats.events[0].cost_basis,'policy_fixed');}
  }
  assert.ok(io.counts.inference-counts.inference<=1);assert.ok(io.counts.account-counts.account<=1);assert.ok(io.counts.catalog-counts.catalog<=1);
 });
});
