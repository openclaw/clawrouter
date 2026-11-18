// Rehearsal-only receipts. Never serialize native options or exception text.
import {journalCall,type RehearsalEnv} from './contract.ts';
export const startupStages=['export_resolution','https_provider','https_callback','http_deny','container_start'] as const;
export type StartupStage=typeof startupStages[number];
export const startupErrors=['type','unsupported','permission','capacity','timeout','unknown'] as const;
export type StartupError=typeof startupErrors[number];
export interface StartupEvent {stage:StartupStage;outcome:'started'|'completed'|'failed';error?:StartupError;at:number}
export interface ReadinessEvent {phase:string;reason:string;at:number}
export const monitorCategories=['success','process_exit','no_container','internal','image','permission','network','other'] as const;
export const monitorNames=['Error','TypeError','RangeError','AbortError','TimeoutError','other'] as const;
export interface MonitorEvent {outcome:'exited'|'rejected';category:typeof monitorCategories[number];name:typeof monitorNames[number];exitCode:number|null;at:number}
export interface StartupDiagnostics {stages:StartupEvent[];readiness?:ReadinessEvent;firstFailure?:ReadinessEvent;readyAt?:number;monitor?:MonitorEvent}
export function monitorFailure(error:unknown):Omit<MonitorEvent,'at'|'outcome'>{
 const e=error as {message?:unknown;name?:unknown;exitCode?:unknown}|null;
 const message=typeof e?.message==='string'?e.message.toLowerCase():'';
 const exitCode=Number.isSafeInteger(e?.exitCode)&&Number(e?.exitCode)>=-2147483648&&Number(e?.exitCode)<=2147483647?Number(e?.exitCode):null;
 const category=exitCode!==null?'process_exit':/monitor\(\).*not running|no container/.test(message)?'no_container':/internal error/.test(message)?'internal':/image|registry|manifest/.test(message)?'image':/permission|unauthorized|forbidden/.test(message)?'permission':/network|connection|dns|tls|certificate/.test(message)?'network':'other';
 const name=monitorNames.find(n=>n===e?.name)??'other';
 return {category,name,exitCode};
}
export function monitorValid(v:Omit<MonitorEvent,'at'>){
 return monitorCategories.includes(v.category)&&monitorNames.includes(v.name)&&(v.exitCode===null||Number.isInteger(v.exitCode)&&v.exitCode>=-2147483648&&v.exitCode<=2147483647)&&
 (v.outcome==='exited'?v.category==='success'&&v.exitCode===0:v.outcome==='rejected'&&(v.category==='process_exit'?v.exitCode!==null:v.category!=='success'&&v.exitCode===null));
}
export function readinessValid(v:{phase?:unknown;reason?:unknown}){
 return typeof v.phase==='string'&&['idle','starting','ready','failed','destroying','destroyed','stopped','blocked'].includes(v.phase)&&typeof v.reason==='string'&&
  /^(?:none|unreported|reconstructed|start_or_keepalive|readiness(?:_(?:health_deadline|effect_deadline|boot_changed|boot_invalid|runtime_identity|native_identity|native_image|keepalive_rejected|startup_expired))?|native_exit(?:_(?:engine|timeout|resource|start|unknown))?|destroy_unknown)$/.test(v.reason);
}
function errorKind(error:unknown):StartupError{
 if(error instanceof TypeError)return 'type';
 const message=error instanceof Error?error.message.toLowerCase():'';
 if(/unsupported|not supported|not implemented/.test(message))return 'unsupported';
 if(/permission|forbidden|unauthorized/.test(message))return 'permission';
 if(/capacity|resource|memory|limit/.test(message))return 'capacity';
 if(/timeout|timed out|deadline/.test(message))return 'timeout';
 return 'unknown';
}
export async function startupStep<T>(env:RehearsalEnv,identity:{slot:number;generation:number;runtimeSha:string},stage:StartupStage,effect:()=>T|Promise<T>):Promise<T>{
 await journalCall(env,'startup',{...identity,stage,outcome:'started'});
 let result:T;
 try{result=await effect();}
 catch(error){await journalCall(env,'startup',{...identity,stage,outcome:'failed',error:errorKind(error)});throw error;}
 // A receipt-write failure must not be reported as a failure of the effect.
 await journalCall(env,'startup',{...identity,stage,outcome:'completed'});
 return result;
}
