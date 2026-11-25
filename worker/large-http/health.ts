import {bounded} from './capacity.ts';
export type Health = {kind:'unavailable'} | {kind:'response';status:number;value:unknown};
// A caller may treat an aborted pre-header startup GET as pending. This is
// read-only observation, never inference; the caller owns the startup deadline.
// Body/JSON/identity errors and unresolved operations are terminal, including
// body watchdog expiry. No work or start operation is retried.
export async function health(fetchHealth:(signal:AbortSignal)=>Promise<Response>,options:{pendingStartupHeaders?:boolean}={}):Promise<Health> {
  const controller = new AbortController();
  let expired = false, ended = false, response:Response | undefined;
  let reader:ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timer = setTimeout(() => { expired = true; controller.abort(); },500);
  try {
    try {
      const pending = fetchHealth(controller.signal);
      void pending.then(r => { if (ended && r.body) void r.body.cancel().catch(()=>{}); },()=>{});
      response = await bounded(pending,550);
    }
    catch {
      if (expired || controller.signal.aborted) {
        if(options.pendingStartupHeaders)return {kind:'unavailable'};
        throw Error('health_deadline');
      }
      return {kind:'unavailable'};
    }
    if (expired) throw Error('health_deadline');
    if (response.status !== 200) return {kind:'response',status:response.status,value:null};
    reader = response.body?.getReader();
    const bytes:Uint8Array[] = []; let size = 0;
    for (;;) {
      const n = reader ? await bounded(reader.read(),Math.max(1,500)) : {done:true,value:undefined};
      if (expired) throw Error('health_deadline');
      if (n.done) break;
      size += n.value!.byteLength;
      if (size > 2048) throw Error('health_size');
      bytes.push(n.value!);
    }
    const data = new Uint8Array(size); let offset = 0;
    for (const b of bytes) { data.set(b,offset); offset += b.length; }
    return {kind:'response',status:200,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data))};
  } finally {
    ended = true; clearTimeout(timer); controller.abort();
    if (reader) { void reader.cancel().catch(()=>{}); try { reader.releaseLock(); } catch { /* unresolved read: never grants readiness */ } }
    else if (response?.body) void response.body.cancel().catch(()=>{});
  }
}
