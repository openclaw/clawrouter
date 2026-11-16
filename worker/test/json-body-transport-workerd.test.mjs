import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {jsonBodyTransport} from './worker/json-body.ts';
const check=(value,message)=>{if(!value)throw new Error(message);};
export default {async fetch(){
 const length=8*1024*1024,body=Object.freeze({data:'A'.repeat(length-11)});
 const transport=jsonBodyTransport(body,length);
 check(transport.bytes===length&&transport.retirement===null,'exact measured bytes');
 const response=await fetch('https://fixture.example/echo',{method:'POST',body:transport.stream().pipeThrough(new FixedLengthStream(transport.bytes)),redirect:'manual'});
 const echoed=await response.json();
 check(response.status===200&&echoed.bytes===length&&echoed.valid,'complete original byte transport');
 check(transport.retirement==='eof'&&Object.isFrozen(body)&&body.data.length===length-11,'serializer EOF preserves original graph');
 const partial=jsonBodyTransport(body,length),reader=partial.stream().getReader();
 const first=await reader.read();check(!first.done&&first.value.length<=65536&&partial.retirement===null,'partial is not retirement');
 await reader.cancel();reader.releaseLock();check(partial.retirement==='cancel','native stream cancel retires');
 const discarded=jsonBodyTransport(body,length);discarded.discard();discarded.discard();
 check(discarded.retirement==='discard','pre-dispatch discard');
 const changed={value:'before'},failed=jsonBodyTransport(changed,100);changed.value='after';
 let rejected=false;try{await failed.stream().getReader().read();}catch{rejected=true;}
 check(rejected&&failed.retirement==='error','native serialization error retires');
 return Response.json({bytes:echoed.bytes,maximum:echoed.maximum,eof:transport.retirement,cancel:partial.retirement,discard:discarded.retirement,error:failed.retirement,intact:body.data.length===length-11});
}};`;
const upstream = `export default {async fetch(request){
 const reader=request.body.getReader({mode:'byob'});let window=new Uint8Array(16384),bytes=0,maximum=0,valid=true;
 const prefix=[123,34,100,97,116,97,34,58,34],length=8*1024*1024;
 for(;;){const next=await reader.read(window);if(next.value){maximum=Math.max(maximum,next.value.length);for(let i=0;i<next.value.length;i++){const at=bytes+i,want=at<prefix.length?prefix[at]:at===length-2?34:at===length-1?125:65;if(next.value[i]!==want)valid=false;}bytes+=next.value.length;window=new Uint8Array(next.value.buffer);}if(next.done)break;}
 reader.releaseLock();return Response.json({bytes,maximum,valid});
}};`;

test("workerd frozen JSON transport preserves full 8 MiB through FixedLengthStream and retires each terminal path", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "json-transport-"));
  let runtime;
  try {
    runtime = await startWorkerdFixture(temporary, router, upstream);
    const response = await runtime.dispatchFetch("https://router.example/check");
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.bytes, 8 * 1024 * 1024);
    assert.ok(result.maximum > 0 && result.maximum <= 16384);
    assert.deepEqual({ eof: result.eof, cancel: result.cancel, discard: result.discard, error: result.error, intact: result.intact }, { eof: "eof", cancel: "cancel", discard: "discard", error: "error", intact: true });
  } finally { await runtime?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
