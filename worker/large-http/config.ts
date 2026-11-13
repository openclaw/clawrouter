import {sha256Hex} from '../utils.ts';
import type {Env} from '../types.ts';
import type {ContinuousConfig} from './continuous.ts';
import {validateEpochConfig} from './epoch.ts';
import {runtimeFields} from './provider-config.ts';
export {runtimeFields};
export interface RuntimeConfig extends ContinuousConfig {origin:string;image:string;runtimeSha:string;runtimeBytes:number;local:boolean}
declare const __LARGE_HTTP_RUNTIME_SHA__:string;
declare const __LARGE_HTTP_RUNTIME_BYTES__:number;
export async function runtimeConfig(e:Env):Promise<RuntimeConfig>{
 const origin=String(e.LARGE_HTTP_ORIGIN??e.CLAWROUTER_PUBLIC_ORIGIN??''),url=new URL(origin),local=e.LARGE_HTTP_LOCAL==='1';
 if(origin!==url.origin||url.username||url.password||!(url.protocol==='https:'||local&&url.protocol==='http:'&&['host.docker.internal','127.0.0.1'].includes(url.hostname)))throw Error('runtime_origin_invalid');
 const image=String(e.LARGE_HTTP_IMAGE??'cloudflare/debian-trixie');
 if(!(image==='cloudflare/debian-trixie'||/^sha256:[a-f0-9]{64}$/.test(image)))throw Error('runtime_image_invalid');
 const runtimeSha=String(e.LARGE_HTTP_RUNTIME_SHA??(typeof __LARGE_HTTP_RUNTIME_SHA__==='undefined'?'':__LARGE_HTTP_RUNTIME_SHA__)),runtimeBytes=Number(e.LARGE_HTTP_RUNTIME_BYTES??(typeof __LARGE_HTTP_RUNTIME_BYTES__==='undefined'?0:__LARGE_HTTP_RUNTIME_BYTES__));
 if(!/^[a-f0-9]{64}$/.test(runtimeSha)||!Number.isSafeInteger(runtimeBytes)||runtimeBytes<1||runtimeBytes>2097152||!/^[a-f0-9]{64}$/.test(e.LARGE_HTTP_TOKEN??''))throw Error('runtime_bundle_invalid');
 const options={origin,image,runtimeSha,runtimeBytes,local,testing:e.LARGE_HTTP_TESTING==='1',capacity:Number(e.LARGE_HTTP_CAPACITY??8),tenantLimit:Number(e.LARGE_HTTP_TENANT_LIMIT??Math.min(2,Number(e.LARGE_HTTP_CAPACITY??8))),slotStartsPerHour:Number(e.LARGE_HTTP_SLOT_STARTS_PER_HOUR??24),epochMs:Number(e.LARGE_HTTP_EPOCH_MS??3600000),startWindowMs:3600000,startsPerWindow:3};
 // Environment/policy changes retire an existing epoch before adoption. Only
 // the digest is persisted here; the values stay in the current deployment.
 const fingerprint=await sha256Hex(JSON.stringify({...options,controlToken:e.LARGE_HTTP_TOKEN,settings:runtimeFields.map(k=>e[k]??null)}));
 const c={...options,fingerprint,enabled:e.LARGE_HTTP_ENABLED!=='0',deadline:Number(e.LARGE_HTTP_DEADLINE??Number.MAX_SAFE_INTEGER)};validateEpochConfig(c);return c;
}
