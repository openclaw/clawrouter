import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import {sqliteFixture} from './sqlite-storage.mjs';
const {PolicyBindingIndexObject}=await import('../authority.ts');
const {UsageLedgerObject}=await import('../ledgers.ts');
const {readCompleteUsage,exportCompleteUsage}=await import('../usage-report.ts');
import {usageShardName} from '../usage-sharding.ts';

// Real production dispatchers and transactionSync over isolated in-memory SQLite.
// This synthetic verifier is deliberately NOT proof of the later auth adapters.
export async function completeFixture(t,count=2){
 const authority=sqliteFixture(t),shards=new Map(),calls=[];let owner,hook,active=0,peak=0;
 const env={POLICY_KV:{get(){throw Error('unexpected KV read')},list(){throw Error('unexpected KV list')}},ACCESS_CONTROL:{idFromName:n=>n,get:n=>({fetch:(url,init)=>dispatch('authority',n,url,init)})},USAGE_LEDGER:{idFromName:n=>n,get:n=>({fetch:(url,init)=>dispatch('shard',n,url,init)})}};
 owner=new PolicyBindingIndexObject({id:'policy-bindings',storage:authority},env);
 const direct=(path,body)=>owner.fetch(new Request('https://private'+path,{method:'POST',body:JSON.stringify(body)}));
 async function dispatch(kind,name,url,init){
  const request=new Request(url,init),body=await request.clone().json(),path=new URL(request.url).pathname,entry={kind,name,path,body};calls.push(entry);active++;peak=Math.max(peak,active);
  try{const target=kind==='authority'?owner:shards.get(name)?.ledger;if(!target)throw Error('missing test shard');const response=await target.fetch(request);return await hook?.(entry,response)??response;}finally{active--;}
 }
 const addShard=(tenantId,policyId)=>{const storage=sqliteFixture(t),ledger=new UsageLedgerObject({storage:{...storage,getAlarm:async()=>null,setAlarm:async()=>{}}});const item={...storage,ledger,tenantId,policyId};shards.set(usageShardName(tenantId,policyId),item);return item;};
 assert.equal((await direct('/policies/initialize-all',[])).status,200);
 for(let i=0;i<count;i++){const policyId='p'+i;assert.equal((await direct('/policies/put',{policyId,policy:{tenantId:'tenant',enabled:true,providers:[]}})).status,200);addShard('tenant',policyId);}
 const now=Date.now(),query={from:now-3600000,to:now,timezone:'UTC',grain:'day',groupBy:'model',rankBy:'calls',rankOffset:0,filters:{}};
 let caller={session:{authenticated:true,auth:'local',role:'admin',email:'admin@example.com',subject:null,tenantId:'tenant',groups:[],contentRetentionDisabled:false},actor:'a'.repeat(64),sessionBinding:'b'.repeat(64),audience:'admin'};
 const verify=async()=>caller;
 t.after(()=>{if(owner.usageCuts)for(const root of [...owner.usageCuts.roots.values()])owner.usageCuts.dispatch('release',{binding:root.binding,operation:root.operation},root.revision);});
 function event(id,extra={}){return {type:'clawrouter.usage.v1',id,occurred_at_ms:now-1000,tenant_id:'tenant',policy_id:'p0',key_id:'p0',principal_id:'alice@example.com',credential_id:'key',provider:'openai',model:'model',status:'success',status_code:200,input_tokens:1,output_tokens:2,total_tokens:3,actual_cost_micros:7,cost_basis:'manifest_pricing',grant_lane:'api_key',...extra};}
 async function ingest(index,e){const shard=typeof index==='number'?[...shards.values()][index]:index;const value={...e,tenant_id:shard.tenantId,policy_id:shard.policyId};const response=await shard.ledger.fetch(new Request('https://private/ingest',{method:'POST',body:JSON.stringify(value)}));assert.equal(response.status,200);assert.equal((await response.json()).outcome,'stored');}
 return {env,owner,authority,shards,calls,now,query,event,ingest,addShard,direct,verify,
  get caller(){return caller},set caller(value){caller=value},set hook(value){hook=value},get peak(){return peak},
  read:(input={},signal)=>readCompleteUsage(env,verify,{kind:'report',intent:'summary',query,...input},signal),
  continuation:(input,signal)=>readCompleteUsage(env,verify,{query,...input},signal),
  export:(q=query,signal)=>exportCompleteUsage(env,verify,q,signal),
  async personal(ids=['p0']){caller={...caller,audience:'personal',session:{...caller.session,role:'user',email:'alice@example.com'}};
   assert.equal((await direct('/initialize',[{principal:{principalType:'user',principalId:caller.session.email},bindings:ids.map(policyId=>({principalType:'user',principalId:caller.session.email,policyId,enabled:true,priority:0}))}])).status,200);},
 };
}
export function complete(result){assert.equal(result.kind,'complete',JSON.stringify(result));return result.value;}
