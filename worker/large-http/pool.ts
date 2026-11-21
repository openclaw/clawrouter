import {DurableObject} from 'cloudflare:workers';
import {initialPool,poolTransition,type PoolState} from './pool-state.ts';
interface Env {CANARY_TOKEN:string;POOL:DurableObjectNamespace;DEADLINE:string}
export {poolCall} from './control-client.ts';
export class ManagedPool extends DurableObject<Env>{
 async fetch(r:Request):Promise<Response>{
  if(r.headers.get('x-container-token')!==this.env.CANARY_TOKEN||Date.now()>=Number(this.env.DEADLINE))return new Response(null,{status:403});
  const p=new URL(r.url).pathname.slice(1);if(r.method!=='POST'||!['ready','admit','claim','dispatch','finish','snapshot'].includes(p))return new Response(null,{status:404});
  const reader=r.body?.getReader();let text='';try{if(reader)for(;;){const n=await reader.read();if(n.done)break;text+=new TextDecoder().decode(n.value);if(text.length>4096){await reader.cancel();return new Response(null,{status:413});}}}finally{reader?.releaseLock();}
  let data;try{data=JSON.parse(text);}catch{return new Response(null,{status:400});}
  return this.ctx.storage.transaction(async tx=>{
   const s=await tx.get<PoolState>('pool')??initialPool(),result=poolTransition(s,p,data,Date.now());
   if(s.grants.length>8||new Set(s.grants.map(g=>g.slot)).size!==s.grants.length||JSON.stringify(s).length>65536)throw Error('pool_invariant');
   await tx.put('pool',s);return Response.json(result,{status:result.status});
  });
 }
}
