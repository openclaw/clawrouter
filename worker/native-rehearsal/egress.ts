// Synthetic-only first-request trace. Never persist raw URLs, headers or errors.
import {journalCall,type RehearsalEnv} from './contract.ts';
import {bootstrapFetchCodes} from './bootstrap.ts';
export type EgressEvent={event:'entered';ownedOrigin:boolean;runtimePath:boolean;get:boolean;decorated:boolean;protocol:'https'|'http'|'other'}|
 {event:'forwarding'}|{event:'response';status:number}|{event:'rejected';name:'Error'|'TypeError'|'AbortError'|'TimeoutError'|'other';causeCode:typeof bootstrapFetchCodes[number]|null;reason:'unsupported_redirect'|'other'};
export function egressEvent(v:any):EgressEvent|null {
 if(!v||typeof v!=='object'||Array.isArray(v))return null;
 if(v.event==='entered'&&['ownedOrigin','runtimePath','get','decorated'].every(k=>typeof v[k]==='boolean')&&['https','http','other'].includes(v.protocol))return {event:v.event,ownedOrigin:v.ownedOrigin,runtimePath:v.runtimePath,get:v.get,decorated:v.decorated,protocol:v.protocol};
 if(v.event==='forwarding')return {event:v.event};
 if(v.event==='response'&&Number.isInteger(v.status)&&v.status>=100&&v.status<=599)return {event:v.event,status:v.status};
 if(v.event==='rejected'&&['Error','TypeError','AbortError','TimeoutError','other'].includes(v.name)&&['unsupported_redirect','other'].includes(v.reason)&&(v.causeCode===null||bootstrapFetchCodes.includes(v.causeCode)))return {event:v.event,name:v.name,causeCode:v.causeCode,reason:v.reason};
 return null;
}
export async function observeEgress(env:RehearsalEnv,identity:{slot:number;generation:number;runtimeSha:string},r:Request,origin:string,effect:(forwarding:()=>Promise<void>)=>Promise<Response>){
 const u=new URL(r.url),entered=await journalCall(env,'egress',{...identity,event:'entered',ownedOrigin:u.origin===origin,runtimePath:u.pathname==='/__large_http/runtime',get:r.method==='GET',decorated:!!(u.username||u.password||u.search||u.hash),protocol:u.protocol==='https:'?'https':u.protocol==='http:'?'http':'other'});
 // No start, duplicate request or completed trace: preserve existing behavior.
 if(entered.recorded!==true)return effect(async()=>{});
 const record=(event:EgressEvent)=>journalCall(env,'egress',{...identity,...event});
 let forwardingReceiptFailed=false;
 const forwarding=async()=>{try{await record({event:'forwarding'});}catch(error){forwardingReceiptFailed=true;throw error;}};
 let response:Response;
 try{response=await effect(forwarding);}
 catch(error){
  const e=error as {name?:unknown;message?:unknown;code?:unknown;cause?:{code?:unknown}}|null,code=e?.cause?.code??e?.code;
  const name=['Error','TypeError','AbortError','TimeoutError'].find(n=>n===e?.name) as 'Error'|'TypeError'|'AbortError'|'TimeoutError'|undefined;
  const reason=name==='TypeError'&&typeof e?.message==='string'&&e.message.startsWith('Invalid redirect value, must be one of "follow" or "manual"')?'unsupported_redirect':'other';
  // A journal failure must not replace the original forwarding exception.
  if(!forwardingReceiptFailed)await record({event:'rejected',name:name??'other',causeCode:bootstrapFetchCodes.includes(code as any)?code as typeof bootstrapFetchCodes[number]:null,reason}).catch(()=>{});
  throw error;
 }
 // Missing terminal evidence is a diagnostic gap, not a failed origin fetch.
 await record({event:'response',status:response.status}).catch(()=>{});
 return response;
}
