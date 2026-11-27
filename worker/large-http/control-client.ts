interface Env {CANARY_TOKEN:string;POOL:DurableObjectNamespace;DEADLINE:string}
export async function poolCall(e:Env,op:string,value:unknown){
 const r=await e.POOL.getByName('managed-pool').fetch('https://pool/'+op,{method:'POST',headers:{'x-container-token':e.CANARY_TOKEN,'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(3000)});
 const v=await r.json<any>();if(v.status!==r.status)throw Error('pool_status_mismatch');return v;
}
