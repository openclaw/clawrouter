// Test-only contract. Never imported by the ordinary or native router entry.
import type {Env} from '../types.ts';
export interface RehearsalConfig {schema:1;worker:string;origin:string;createdAt:number;expiresAt:number;maxStarts:number;maxRequests:number}
export interface RehearsalEnv extends Env {NATIVE_REHEARSAL:string;NATIVE_REHEARSAL_STATE:DurableObjectNamespace}
export const upstreamKey='synthetic-native-rehearsal-not-a-provider-key';
export const caseId=/^[a-f0-9]{32}$/;
export function rehearsalConfig(e:Env,now=Date.now(),allowExpired=false):RehearsalConfig {
 const c=JSON.parse(String(e.NATIVE_REHEARSAL??'null')) as RehearsalConfig;
 if(!c||Object.keys(c).sort().join()!=='createdAt,expiresAt,maxRequests,maxStarts,origin,schema,worker'||c.schema!==1||!/^clawrouter-native-qualification-[a-f0-9]{12}$/.test(c.worker)||
 !Number.isSafeInteger(c.createdAt)||!Number.isSafeInteger(c.expiresAt)||c.createdAt>now||c.expiresAt<=c.createdAt||c.expiresAt-c.createdAt>3600000||!allowExpired&&now>=c.expiresAt||
 !Number.isSafeInteger(c.maxStarts)||c.maxStarts<24||c.maxStarts>40||!Number.isSafeInteger(c.maxRequests)||c.maxRequests<8||c.maxRequests>64)throw Error('rehearsal_contract');
 const u=new URL(c.origin);
 if(u.origin!==c.origin||u.protocol!=='https:'||!new RegExp('^'+c.worker+'[.][a-z0-9-]+[.]workers[.]dev$').test(u.hostname)||e.LARGE_HTTP_ORIGIN!==c.origin||e.CLAWROUTER_PUBLIC_ORIGIN!==c.origin||e.LARGE_HTTP_DEADLINE!==undefined||e.LARGE_HTTP_CAPACITY!=='8'||e.LARGE_HTTP_TESTING!=='1'||!e.NATIVE_REHEARSAL_STATE)throw Error('rehearsal_target');
 return c;
}
export function journal(e:Env){return (e as RehearsalEnv).NATIVE_REHEARSAL_STATE.getByName('native-rehearsal');}
export async function journalCall(e:Env,op:string,body:unknown){
 const r=await journal(e).fetch('https://rehearsal/'+op,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 if(!r.ok){await r.body?.cancel();throw Error('rehearsal_'+op+'_refused');}return r.json<any>();
}
