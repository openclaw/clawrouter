import type {Env} from '../types.ts';
export async function lifecycleCall(e:Env,op:string,value:unknown):Promise<any>{
 const r=await e.LARGE_HTTP_POOL!.getByName('large-http-pool').fetch('https://pool/'+op,{method:'POST',headers:{'x-container-token':e.LARGE_HTTP_TOKEN!},body:JSON.stringify(value),signal:AbortSignal.timeout(3000)});
 const v=await r.json<any>();if(v.status!==r.status)throw Error('pool_status_mismatch');return v;
}
