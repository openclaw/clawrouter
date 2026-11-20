import '../../../test/helpers/typescript-resolver.mjs';
import {DatabaseSync} from 'node:sqlite';
import {sqliteStorage} from '../../../worker/test/sqlite-storage.mjs';
const {PolicyBindingIndexObject}=await import('../../../worker/authority.ts');
const {UsageLedgerObject}=await import('../../../worker/ledgers.ts');
const {parseCompleteUsageRequest}=await import('../../../worker/usage-report-session.ts');
const {readCompleteUsage}=await import('../../../worker/usage-report.ts');

// Real complete parser, authority inventory, retained-row SQL, root and cursor
// registry. Only identity verification and private DO transport are synthetic.
export async function cursorUsageFixture({audience='personal',rows=142}={}) {
 const databases=[],calls=[];
 function storage(){const db=new DatabaseSync(':memory:');databases.push(db);return sqliteStorage(db);}
 const ledger=new UsageLedgerObject({storage:{...storage(),getAlarm:async()=>null,setAlarm:async()=>{}}});
 let authority;
 const env={POLICY_KV:{get(){throw Error('unexpected KV read')},list(){throw Error('unexpected KV list')}},ACCESS_CONTROL:{idFromName:n=>n,get:()=>({fetch:(url,init)=>authority.fetch(new Request(url,init))})},USAGE_LEDGER:{idFromName:n=>n,get:()=>({fetch:(url,init)=>ledger.fetch(new Request(url,init))})}};
 authority=new PolicyBindingIndexObject({id:'policy-bindings',storage:storage()},env);
 const direct=async(path,body)=>{const r=await authority.fetch(new Request('https://private'+path,{method:'POST',body:JSON.stringify(body)}));if(!r.ok)throw Error(await r.text());return r;};
 await direct('/policies/initialize-all',[]);await direct('/policies/put',{policyId:'p',policy:{tenantId:'tenant',enabled:true,providers:[]}});
 await direct('/initialize',[{principal:{principalType:'user',principalId:'member@example.com'},bindings:[{principalType:'user',principalId:'member@example.com',policyId:'p',enabled:true,priority:0}]}]);
 const now=Date.now();
 async function ingest(id,extra={}){const r=await ledger.fetch(new Request('https://private/ingest',{method:'POST',body:JSON.stringify({type:'clawrouter.usage.v1',id,occurred_at_ms:now-1000,tenant_id:'tenant',policy_id:'p',key_id:'p',principal_id:'member@example.com',credential_id:'retained-key',provider:'openai',model:'cursor-model',capability:'llm.responses',status:'success',status_code:200,input_tokens:1,output_tokens:2,total_tokens:3,actual_cost_micros:7,cost_basis:'policy_fixed',grant_lane:'api_key',...extra})}));if(!r.ok)throw Error(await r.text());}
 for(let i=0;i<rows;i++)await ingest('row-'+String(i).padStart(4,'0'),{occurred_at_ms:now-(i+1)*1000});
 let current=true;
 const verify=async()=>current?{session:{authenticated:true,auth:'local',role:audience==='admin'?'admin':'user',email:'member@example.com',subject:null,tenantId:'tenant',groups:[],contentRetentionDisabled:false},actor:'a'.repeat(64),sessionBinding:'b'.repeat(64),audience}:null;
 return {now,calls,ingest,direct,revoke:()=>{current=false;},
  async read(path,at=now,method='GET') {const url=new URL(path,'https://console.example'),kind=method==='DELETE'?'release':url.pathname.split('/').at(-1);const input=parseCompleteUsageRequest(new Request(url,{method}),kind,audience,at);calls.push({input,method});return readCompleteUsage(env,verify,input);},
  close(){for(const root of [...authority.usageCuts?.roots.values()??[]])authority.usageCuts.dispatch('release',{binding:root.binding,operation:root.operation},root.revision);for(const db of databases)db.close();},
 };
}
