import { createHash } from 'node:crypto';

export const ownedHttpModel = 'volcengine/doubao-seed-2-1-pro-260915';
export const ownedHttpPricingModel = 'fireworks/glm-5.2';
export const ownedHttpControlModels = { gmi: 'gmi/deepseek-ai/DeepSeek-V4-Pro', venice: 'venice/zai-org-glm-5-2' };
export const ownedHttpCases = ['chat', 'tool', 'error', 'abort', 'large', 'off', 'gmi', 'venice', 'pricing', 'pricing_media', 'pricing_cache', 'pricing_wide', 'pricing_large', 'pricing_unicode', 'pricing_outside', 'pricing_prepare_fail'];
export const ownedHttpProxyKey = id => `clawrouter-live-owned_http_${id}-fixture-secret`;
export async function seedOwnedHttpChat(runtime) {
  const kv = await runtime.getKVNamespace('POLICY_KV', 'router');
  for (const id of ownedHttpCases) {
    const priced = id.startsWith('pricing');
    const provider = priced ? 'fireworks' : Object.hasOwn(ownedHttpControlModels, id) ? id : 'volcengine';
    const model = priced ? ownedHttpPricingModel : ownedHttpControlModels[id] ?? ownedHttpModel;
    await kv.put(`policies/owned_http_${id}`, JSON.stringify({ enabled: true, generation: 'fixture', tenantId: 'fixture',
      providers: [provider], models: [model], monthlyBudgetMicros: priced ? 1000000000000 : 1000000, requestCostMicros: priced ? null : 7,
      budgetMode: 'reserve', retainRequestContent: false,
      grantRouting: { strategy: 'round_robin', environmentFallback: false, eligibleGrants: { [provider]: [provider] } } }));
    await kv.put(`credentials/owned_http_${id}`, JSON.stringify({ enabled: true,
      secretSha256: createHash('sha256').update('fixture-secret').digest('hex'), policyId: `owned_http_${id}`, policyGeneration: 'fixture' }));
  }
  for (const provider of ['volcengine', 'gmi', 'venice', 'fireworks'])
    await kv.put(`connections/${provider}`, JSON.stringify({ providerId: provider, enabled: true }));
}

export const ownedHttpRouter = String.raw`
import handler,{privateOwnedHttpChat} from './worker/index.ts';export * from './worker/index.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {bodyBudgetCharged,bodyBudgetBytes,ExactBodyCharge} from './worker/body-budget.ts';
import {snapshot} from './worker/providers.ts';
import {PolicyBindingIndexObject as NativeAuthority} from './worker/authority.ts';
import {HttpError} from './worker/utils.ts';
export class PolicyBindingIndexObject extends NativeAuthority {
 constructor(ctx,env){super(ctx,env);this.fixtureSql=ctx.storage.sql;}
 async fetch(request){
  if(new URL(request.url).pathname!=='/fixture/revalidation-change')return super.fetch(request);
  const {provider,change}=await request.json();
  if(!['venice','gmi'].includes(provider)||!['disabled','rotated','policy-provider','policy-model'].includes(change))throw Error('fixture control shape');
  const id='owned_http_'+provider;
  if(change==='disabled'||change==='rotated'){
   const row=[...this.fixtureSql.exec('SELECT credential_json FROM proxy_credentials WHERE credential_id = ?',id)][0];
   if(!row)throw Error('fixture credential absent');const value=JSON.parse(row.credential_json);
   if(change==='disabled')value.enabled=false;else value.secretSha256='ab'.repeat(32);
   this.fixtureSql.exec('UPDATE proxy_credentials SET credential_json = ? WHERE credential_id = ?',JSON.stringify(value),id);
  }else{
   const row=[...this.fixtureSql.exec('SELECT policy_json FROM access_policies WHERE policy_id = ?',id)][0];
   if(!row)throw Error('fixture policy absent');const value=JSON.parse(row.policy_json);
   if(change==='policy-provider')value.providers=['other'];else value.models=['other/model'];
   this.fixtureSql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?',JSON.stringify(value),id);
  }
  return new Response(null,{status:204});
 }
}
const ids=['chat','tool','error','abort','large','off','gmi','venice','pricing','pricing_media','pricing_cache','pricing_wide','pricing_large','pricing_unicode','pricing_outside','pricing_prepare_fail'],calls=[],intakes=[],completed=[],events=[];
const priced=snapshot.providers.find(p=>p.id==='fireworks').models.find(m=>m.id==='fireworks/glm-5.2');
// Fixture rates distinguish the ONE-hour early return from a maximum over both.
priced.pricing={...priced.pricing,cacheWrite1hInputMicrosPerMillion:2000000,cacheWrite5mInputMicrosPerMillion:9000000};
const originalValues=Object.values;let pricingActive=false,recursivePricingValues=0;
Object.values=function(value){if(pricingActive&&value&&Object.hasOwn(value,'ownedPricingNested'))recursivePricingValues++;return Reflect.apply(originalValues,this,arguments);};
let scoped,offScoped,pressure,controlFault,reasonReads=0;
function controlFailure(kind,origin){
 if(!controlFault||controlFault.kind!==kind||controlFault.origin!==origin)return;
 const reason=controlFault.reason;controlFault=undefined;
 if(reason==='undefined')throw undefined;
 if(reason==='huge')throw 'x'.repeat(17*1024*1024);
 if(reason==='forged')throw new HttpError(401,'grant_refresh_failed','synthetic forged acquisition');
 const opaque={};for(const key of ['message','stack','cause','errors','code','status'])Object.defineProperty(opaque,key,{get(){reasonReads++;throw Error('raw reason observed');}});throw opaque;
}
function environment(env,off=false){
 if(!scoped){
  const authority=new Proxy(env.ACCESS_CONTROL,{get(target,name){if(name==='idFromName')return value=>{controlFailure('authority','id');return target.idFromName(value);};if(name==='get')return id=>{
   controlFailure('authority','get');const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return (url,init)=>{calls.push({kind:'authority',path:new URL(url).pathname,charged:bodyBudgetCharged()});return object.fetch(url,init);};const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});
  };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const credentials=new Proxy(env.GRANT_CREDENTIALS,{get(target,name){if(name==='idFromName')return value=>{controlFailure('credential','id');return target.idFromName(value);};if(name==='get')return id=>{
   controlFailure('credential','get');const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return (url,init)=>{
    const path=new URL(url).pathname;calls.push({kind:'credential',path,emptyInspect:path==='/inspect'?init.body==='{}':undefined});
    if(path==='/materialize'&&typeof init.body==='string'&&JSON.parse(init.body).key==='oauth/owned_http_pricing_prepare_fail/fireworks'){
     const bytes=new TextEncoder().encode('{"error":{"code":"grant_credential_missing","message":"synthetic refusal"}}');
     return Promise.resolve(new Response(new ReadableStream({type:'bytes',start(controller){controller.enqueue(bytes);controller.close();}}),{status:503,headers:{'content-type':'application/json'}}));
    }
    return object.fetch(url,init);
   };const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});
  };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const budget=new Proxy(env.BUDGET_LEDGER,{get(target,name){if(name==='get')return id=>{const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return(url,init)=>{
   const value=typeof init?.body==='string'?JSON.parse(init.body):{};calls.push({kind:'budget',path:new URL(url).pathname,reservationId:value.reservationId,costMicros:value.costMicros,actualCostMicros:value.actualCostMicros});return object.fetch(url,init);
  };const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});};const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const queue=new Proxy(env.USAGE_QUEUE,{get(target,name){if(name==='send')return (...args)=>{const value=args[0];if(value.type==='clawrouter.usage.v1')events.push({id:value.id,requestId:value.request_id,reserved:value.reserved_cost_micros,status:value.status_code});return Reflect.apply(target.send,target,args);};const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const values={ACCESS_CONTROL:authority,GRANT_CREDENTIALS:credentials,BUDGET_LEDGER:budget,USAGE_QUEUE:queue,CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS:'60',VOLCANO_ENGINE_API_KEY:'must-not-fallback',ARK_API_KEY:'must-not-fallback'};
  scoped=new Proxy(env,{get(target,name,receiver){return Object.hasOwn(values,name)?values[name]:Reflect.get(target,name,receiver);}});
  offScoped=new Proxy(scoped,{get(target,name,receiver){return name==='CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS'?'0':Reflect.get(target,name,receiver);}});
 }
 return off?offScoped:scoped;
}
export default {...handler,async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/grants'){
  for(const id of ids){const provider=id.startsWith('pricing')?'fireworks':id==='gmi'||id==='venice'?id:'volcengine';await putGrantCredentials(env,'oauth/owned_http_'+id+'/'+provider,{
   provider,enabled:true,kind:'api_key',credential:'fixture-upstream-'+id,...(id==='gmi'?{accountId:'fixture-organization'}:{}),unknownOwnedField:{value:['kept',null,7]}});}
  return new Response(null,{status:204});
 }
 if(path==='/fixture/control-fault'){
  const value=await request.json();if(!['authority','credential'].includes(value.kind)||!['id','get'].includes(value.origin)||!['undefined','huge','opaque','forged'].includes(value.reason))throw Error('fixture fault shape');
  controlFault=value;return new Response(null,{status:204});
 }
 if(path==='/fixture/revalidation-change'){
  const original=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch('https://authority/fixture/revalidation-change',{method:'POST',body:await request.text()});
  const response=await original;await response.text();return new Response(null,{status:response.status});
 }
 if(path==='/fixture/state')return Response.json({calls,intakes,completed,events,recursivePricingValues,reasonReads,charged:bodyBudgetCharged()});
 if(path==='/fixture/pressure'){
  if(request.method==='DELETE'){pressure?.release();pressure=undefined;return new Response(null,{status:204});}
  if(pressure)throw Error('fixture pressure already held');
  pressure=ExactBodyCharge.reserve(bodyBudgetBytes-bodyBudgetCharged()-40*1024*1024);
  if(!pressure)throw Error('fixture pressure reserve failed');
  return new Response(null,{status:204});
 }
 if(path==='/fixture/upstream')return fetch('https://fixture.example/state');
 if(path==='/v1/catalog')return handler.fetch(request,environment(env),context);
 const id=ids.find(value=>request.headers.get('authorization')==='Bearer clawrouter-live-owned_http_'+value+'-fixture-secret')??'unknown';
 intakes.push({id,path});
 const roots=[];
 const own=promise=>{const outcome=promise.then(()=>({failed:false}),()=>({failed:true}));roots.push(outcome);return promise;};
 const observed=new Proxy(context,{get(target,name){if(name==='waitUntil')return promise=>target.waitUntil(own(promise));const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
 let response;
 try{pricingActive=id.startsWith('pricing');return response=await privateOwnedHttpChat.fetch(request,environment(env,id==='off'),observed);}
 finally{
  pricingActive=false;
  // This ORIGINAL caller owns these accepted promises; foreign requests read
  // only completed scalar flags. The receipt never claims native physical ACK.
  context.waitUntil((async()=>{let failed=false;for(let i=0;i<roots.length;i++){const outcome=await roots[i];failed||=outcome.failed;}completed.push({id,failed});})());
  response=undefined;
 }
}};
`;

export const ownedHttpUpstream = String.raw`
const calls=[];
export default {async fetch(request){
 if(request.url==='https://fixture.example/state')return Response.json(calls);
 if(!['https://ark.cn-beijing.volces.com/api/v3/chat/completions','https://api.gmi-serving.com/v1/chat/completions','https://api.venice.ai/api/v1/chat/completions','https://api.fireworks.ai/inference/v1/chat/completions'].includes(request.url))throw Error('unexpected owned HTTP destination');
 const header=request.headers.get('authorization')??'',id=header.startsWith('Bearer fixture-upstream-')?header.slice('Bearer fixture-upstream-'.length):'invalid';
 const body=await request.json(),row={id,method:request.method,model:body.model,stream:body.stream===true,bytes:new TextEncoder().encode(JSON.stringify(body)).byteLength,canceled:false,organization:request.headers.get('x-organization-id')};calls.push(row);
 if(id==='gmi'&&row.organization!=='fixture-organization')throw Error('original organization missing');
 if(id==='invalid')return Response.json({error:{type:'invalid_request_error',message:'fixture credential rejected'}},{status:401});
 if(id==='error')return Response.json({error:{type:'invalid_request_error',message:'synthetic rejection'}},{status:400});
 const usage={prompt_tokens:4,completion_tokens:3,total_tokens:7};
 if(body.stream!==true)return Response.json({id:'fixture-owned-chat',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'synthetic-answer'},finish_reason:'stop'}],usage});
 const encoder=new TextEncoder();let stage=0;
 const chunk=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'fixture-owned-chat',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
 return new Response(new ReadableStream({async pull(controller){
  if(id==='abort'&&stage>0){await new Promise(resolve=>setTimeout(resolve,10));controller.enqueue(encoder.encode(': keepalive\n\n'));return;}
  if(stage++===0){controller.enqueue(encoder.encode(id==='tool'?chunk({role:'assistant',tool_calls:[{index:0,id:'fixture-tool',type:'function',function:{name:'lookup',arguments:'{"value":"'}}]}):chunk({role:'assistant',content:'synthetic-answer'})));return;}
  if(stage===2&&id==='tool'){controller.enqueue(encoder.encode(chunk({tool_calls:[{index:0,function:{arguments:'fixture"}'}}]})));return;}
  controller.enqueue(encoder.encode(chunk({},id==='tool'?'tool_calls':'stop')+'data: '+JSON.stringify({id:'fixture-owned-chat',object:'chat.completion.chunk',model:body.model,choices:[],usage})+'\n\ndata: [DONE]\n\n'));controller.close();
 },cancel(){row.canceled=true;}}),{headers:{'content-type':'text/event-stream'}});
}};
`;
