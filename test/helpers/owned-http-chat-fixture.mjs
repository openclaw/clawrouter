import { createHash } from 'node:crypto';

export const ownedHttpModel = 'volcengine/doubao-seed-2-1-pro-260915';
export const ownedHttpCases = ['chat', 'tool', 'error', 'abort', 'large', 'off'];
export const ownedHttpProxyKey = id => `clawrouter-live-owned_http_${id}-fixture-secret`;
export async function seedOwnedHttpChat(runtime) {
  const kv = await runtime.getKVNamespace('POLICY_KV', 'router');
  for (const id of ownedHttpCases) {
    await kv.put(`policies/owned_http_${id}`, JSON.stringify({ enabled: true, generation: 'fixture', tenantId: 'fixture',
      providers: ['volcengine'], models: [ownedHttpModel], monthlyBudgetMicros: 1000000, requestCostMicros: 7,
      budgetMode: 'reserve', retainRequestContent: false,
      grantRouting: { strategy: 'round_robin', environmentFallback: false, eligibleGrants: { volcengine: ['volcengine'] } } }));
    await kv.put(`credentials/owned_http_${id}`, JSON.stringify({ enabled: true,
      secretSha256: createHash('sha256').update('fixture-secret').digest('hex'), policyId: `owned_http_${id}`, policyGeneration: 'fixture' }));
  }
  await kv.put('connections/volcengine', JSON.stringify({ providerId: 'volcengine', enabled: true }));
}

export const ownedHttpRouter = String.raw`
import handler,{privateOwnedHttpChat} from './worker/index.ts';export * from './worker/index.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
const ids=['chat','tool','error','abort','large','off'],calls=[],intakes=[],completed=[];
let scoped,offScoped;
function environment(env,off=false){
 if(!scoped){
  const authority=new Proxy(env.ACCESS_CONTROL,{get(target,name){if(name==='get')return id=>{
   const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return (url,init)=>{calls.push({kind:'authority',path:new URL(url).pathname});return object.fetch(url,init);};const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});
  };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const credentials=new Proxy(env.GRANT_CREDENTIALS,{get(target,name){if(name==='get')return id=>{
   const stub=target.get(id);return new Proxy(stub,{get(object,key){if(key==='fetch')return (url,init)=>{calls.push({kind:'credential',path:new URL(url).pathname});return object.fetch(url,init);};const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});
  };const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  const values={ACCESS_CONTROL:authority,GRANT_CREDENTIALS:credentials,CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS:'60',VOLCANO_ENGINE_API_KEY:'must-not-fallback',ARK_API_KEY:'must-not-fallback'};
  scoped=new Proxy(env,{get(target,name,receiver){return Object.hasOwn(values,name)?values[name]:Reflect.get(target,name,receiver);}});
  offScoped=new Proxy(scoped,{get(target,name,receiver){return name==='CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS'?'0':Reflect.get(target,name,receiver);}});
 }
 return off?offScoped:scoped;
}
export default {...handler,async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/grants'){
  for(const id of ids)await putGrantCredentials(env,'oauth/owned_http_'+id+'/volcengine',{
   provider:'volcengine',enabled:true,kind:'api_key',credential:'fixture-upstream-'+id,unknownOwnedField:{value:['kept',null,7]}});
  return new Response(null,{status:204});
 }
 if(path==='/fixture/state')return Response.json({calls,intakes,completed,charged:bodyBudgetCharged()});
 if(path==='/fixture/upstream')return fetch('https://fixture.example/state');
 if(path==='/v1/catalog')return handler.fetch(request,environment(env),context);
 const id=ids.find(value=>request.headers.get('authorization')==='Bearer clawrouter-live-owned_http_'+value+'-fixture-secret')??'unknown';
 intakes.push({id,path});
 const roots=[];
 const own=promise=>{const outcome=promise.then(()=>({failed:false}),()=>({failed:true}));roots.push(outcome);return promise;};
 const observed=new Proxy(context,{get(target,name){if(name==='waitUntil')return promise=>target.waitUntil(own(promise));const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
 let response;
 try{return response=await privateOwnedHttpChat.fetch(request,environment(env,id==='off'),observed);}
 finally{
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
 if(request.url!=='https://ark.cn-beijing.volces.com/api/v3/chat/completions')throw Error('unexpected owned HTTP destination');
 const header=request.headers.get('authorization')??'',id=header.startsWith('Bearer fixture-upstream-')?header.slice('Bearer fixture-upstream-'.length):'invalid';
 const body=await request.json(),row={id,method:request.method,model:body.model,stream:body.stream===true,bytes:JSON.stringify(body).length,canceled:false};calls.push(row);
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
