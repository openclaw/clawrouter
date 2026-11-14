import {DurableObject} from 'cloudflare:workers';
import {readJson,sha256Hex} from '../utils.ts';
import {budgetStatus,providerBudgetStatus,usageSnapshots} from '../ledgers.ts';
import {putGrantCredentials} from '../grant-credentials.ts';
import {lifecycleCall} from '../large-http/lifecycle-client.ts';
import {rehearsalConfig,caseId,upstreamKey,type RehearsalEnv} from './contract.ts';
import {inspectSyntheticInput} from './input.ts';
interface Case {id:string;mode:string;direction:string;slot:number;generation:number;runtimeSha:string;startedAt:number;finishedAt?:number;releasedAt?:number;contextSha256:string;answerSha256:string;bytes:number;outcome:string}
interface State {schema:1;phase:'initializing'|'ready'|'closed';seedHash:string;starts:{slot:number;generation:number;runtimeSha:string;at:number}[];requests:number;cases:Case[];callbacks:unknown[];replays:number;createdAt:number;expiresAt:number}
const digest=/^[a-f0-9]{64}$/;
export class NativeRehearsalState extends DurableObject<RehearsalEnv>{
 private async update<T>(fn:(s:State)=>T){return this.ctx.storage.transaction(async tx=>{const s=await tx.get<State>('rehearsal');if(!s)throw Error('fixture_not_initialized');const result=fn(s);await tx.put('rehearsal',s);return result;});}
 private async close(){
  await this.update(s=>{s.phase='closed';});
  const before=await lifecycleCall(this.env,'snapshot',{});
  if(before.state.accepting===false)return;
  const result=await lifecycleCall(this.env,'admission',{accepting:false,expectedRevision:before.control.revision,operationId:'fixture-expire-'+rehearsalConfig(this.env,Date.now(),true).createdAt});
  if(result.status!==200)throw Error('fixture_close_unknown');
 }
 async alarm(){await this.close();}
 async fetch(r:Request):Promise<Response>{
  const p=new URL(r.url).pathname,c=rehearsalConfig(this.env,Date.now(),['/snapshot','/close','/callback','/release'].includes(p));
  if(r.method!=='POST')return new Response(null,{status:405});
  if(p==='/upstream')return this.upstream(r);
  const v=await readJson<any>(r,undefined,8192);
  if(p==='/setup'){
   if(!digest.test(v.seedHash)||!digest.test(v.credentialHash))return new Response(null,{status:400});
   const created=await this.ctx.storage.transaction(async tx=>{if(await tx.get('rehearsal'))return false;
    await tx.put('rehearsal',{schema:1,phase:'initializing',seedHash:v.seedHash,starts:[],requests:0,cases:[],callbacks:[],replays:0,createdAt:c.createdAt,expiresAt:c.expiresAt} satisfies State);return true;});
   if(!created)return new Response(null,{status:409});
   // Actual old-format persistent inputs, materialized by the unmodified router.
   // One-shot setup only on coordinator-owned empty namespaces.
   await this.env.POLICY_KV.put('policies/rehearsal',JSON.stringify({enabled:true,generation:'rehearsal-v1',providers:['openai'],models:['openai/gpt-6-astra'],tenantId:'rehearsal',budgetMode:'reserve',monthlyBudgetMicros:10000,requestCostMicros:7,retainRequestContent:false,grantRouting:{strategy:'priority',stickiness:'none',failover:true,environmentFallback:false}}));
   await this.env.POLICY_KV.put('credentials/rehearsal',JSON.stringify({enabled:true,secretSha256:v.credentialHash,policyId:'rehearsal',policyGeneration:'rehearsal-v1'}));
   await this.env.POLICY_KV.put('connections/openai',JSON.stringify({providerId:'openai',enabled:true,monthlyBudgetMicros:10000}));
   for(const id of ['primary','alternate'])await putGrantCredentials(this.env,'oauth/rehearsal/'+id,{provider:'openai',kind:'api_key',enabled:true,credential:upstreamKey});
   await this.update(s=>{s.phase='ready';});await this.ctx.storage.setAlarm(c.expiresAt);
   return Response.json({initialized:true,qualified:false});
  }
  if(p==='/snapshot'){
   const s=await this.ctx.storage.get<State>('rehearsal');
   if(!s)return new Response(null,{status:404});const {seedHash:_,...visible}=s;
   const [policy,provider,usage]=await Promise.all([budgetStatus(this.env,'rehearsal',{tenantId:'rehearsal',monthlyBudgetMicros:10000}),providerBudgetStatus(this.env,'openai',10000),usageSnapshots(this.env,[{policyId:'rehearsal',tenantId:'rehearsal'}],{kind:'admin'},100)]);
   const events=await Promise.all(usage.events.map(async x=>({idHash:await sha256Hex(String(x.id)),requestIdHash:await sha256Hex(String(x.request_id)),actualCostMicros:x.actual_cost_micros,reservedCostMicros:x.reserved_cost_micros,status:x.status,statusCode:x.status_code,contentRetained:x.content_retained})));
   return Response.json({...visible,accounting:{policySpentMicros:policy.spentMicros,providerSpentMicros:provider.spentMicros,events},qualified:false});
  }
  if(p==='/close'){await this.close();return Response.json({closed:true,qualified:false});}
  if(p==='/start'){
   if(!Number.isSafeInteger(v.slot)||v.slot<0||v.slot>=8||!Number.isSafeInteger(v.generation)||v.generation<1||!digest.test(v.runtimeSha))return new Response(null,{status:400});
   const accepted=await this.update(s=>{if(s.phase!=='ready'||s.starts.length>=c.maxStarts||s.starts.some(x=>x.slot===v.slot&&x.generation===v.generation))return false;
    s.starts.push({slot:v.slot,generation:v.generation,runtimeSha:v.runtimeSha,at:Date.now()});return true;});
   return Response.json({accepted},{status:accepted?200:409});
  }
  if(p==='/release'){
   if(!caseId.test(v.id))return new Response(null,{status:400});
   const released=await this.update(s=>{const x=s.cases.find(x=>x.id===v.id);if(!x||x.mode!=='hold'||x.finishedAt)return false;x.releasedAt??=Date.now();return true;});
   return Response.json({released},{status:released?200:409});
  }
  if(p==='/callback'){
   // This route is reachable only from the bound egress entrypoint, not HTTP.
   if(!['dispatch','finish','queue','do'].includes(v.op)||!Number.isInteger(v.slot)||v.slot<0||v.slot>=8||!Number.isInteger(v.generation)||!digest.test(v.runtimeSha)||!Number.isInteger(v.status))return new Response(null,{status:400});
   await this.update(s=>{if(s.callbacks.length>=1024)throw Error('fixture_evidence_full');s.callbacks.push({op:v.op,slot:v.slot,generation:v.generation,runtimeSha:v.runtimeSha,status:v.status,at:Date.now(),...(v.idHash?{idHash:v.idHash}:{}),...(typeof v.clean==='boolean'?{clean:v.clean}:{}),...(v.usage?{usage:v.usage}:{})});});
   return Response.json({recorded:true});
  }
  return new Response(null,{status:404});
 }
 private async upstream(r:Request):Promise<Response>{
  const c=rehearsalConfig(this.env),slot=Number(r.headers.get('x-rehearsal-slot')),generation=Number(r.headers.get('x-rehearsal-generation')),runtimeSha=r.headers.get('x-rehearsal-runtime')??'';
  if(r.headers.get('authorization')!=='Bearer '+upstreamKey||!Number.isInteger(slot)||slot<0||slot>=8||!Number.isInteger(generation)||generation<1||!digest.test(runtimeSha))return new Response(null,{status:403});
  const admitted=await this.update(s=>{if(s.phase!=='ready'||s.requests>=c.maxRequests)return false;s.requests++;return true;});
  if(!admitted)return new Response(null,{status:429});
  let input;try{input=await inspectSyntheticInput(r);}catch{return new Response(null,{status:400});}
  const contextSha256=await sha256Hex(input.seed),answer=await sha256Hex(input.seed+':'+input.direction+':'+input.id);
  const accepted=await this.update(s=>{
   if(s.phase!=='ready'||contextSha256!==s.seedHash)return false;
   if(s.cases.some(x=>x.id===input.id)){s.replays++;return false;}
   s.cases.push({id:input.id,mode:input.mode,direction:input.direction,slot,generation,runtimeSha,startedAt:Date.now(),contextSha256,answerSha256:answer,bytes:input.bytes,outcome:'active'});return true;
  });
  if(!accepted)return new Response(null,{status:409});
  const finish=async(outcome:string)=>this.update(s=>{const x=s.cases.find(x=>x.id===input.id)!;x.outcome=outcome;x.finishedAt=Date.now();});
  if(input.mode==='hold'){
   const until=Math.min(c.expiresAt,Date.now()+120000);let released=false;
   while(Date.now()<until&&!r.signal.aborted){const s=await this.ctx.storage.get<State>('rehearsal');if(s?.phase!=='ready')break;if(s.cases.find(x=>x.id===input.id)?.releasedAt){released=true;break;}await new Promise(resolve=>setTimeout(resolve,250));}
   if(!released){await finish('hold_timeout');return new Response(null,{status:504});}
  }
  if(input.mode==='reject'){await finish('rejected');return Response.json({error:{code:'synthetic_rejection'}},{status:400});}
  if(input.mode==='lost'){await finish('delivery_unknown');let sent=false;return new Response(new ReadableStream({async pull(controller){if(!sent){sent=true;controller.enqueue(new TextEncoder().encode('{\"id\":'));return;}await new Promise(resolve=>setTimeout(resolve,50));controller.error(Error('synthetic_disconnect'));}}),{headers:{'content-type':'application/json'}});}
  const message={id:'msg_'+input.id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
  const result={id:'resp_'+input.id,object:'response',status:'completed',model:input.model,service_tier:'default',output:[message],usage:{input_tokens:10,input_tokens_details:{cached_tokens:0},output_tokens:2,total_tokens:12}};
  await finish('completed');
  if(!input.stream)return Response.json(result);
  const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response:result}];
  return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 }
}
