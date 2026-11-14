// Adapter-only completion qualification. Canonical parsing/accounting stays in
// the router. A protocol terminal permits bounded draining, never owner release.
import {createResponsesUsageInspector} from '../../worker/responses-usage.ts';
import {responsesObservation} from '../../worker/token-usage.ts';
import {largeCreatePath} from '../../worker/large-http/headers.ts';

export const completedTailBytes=64*1024, completedDrainMs=5000;
export function completedSse(response:Response,path:string){
 if(!response.ok||!largeCreatePath(path)||/compact/.test(path)||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/event-stream')return null;
 let terminal=false,invalid=false,marker=false,tailBytes=0;
 let lineNonempty=false,comment=false,prefix='',fields=false,other=false,skipLf=false,tailFrame=false;
 const inspector=createResponsesUsageInspector(true,undefined,undefined,undefined,undefined,{
  accept(value){
   if(terminal){invalid=true;return;}
   const fact=responsesObservation(value);
   if(fact?.terminal&&((value as {type?:unknown})?.type!=='response.completed'||fact.status!=='completed'||!fact.tokens))invalid=true;
   if((value as {type?:unknown})?.type==='response.completed'&&fact?.status==='completed'&&fact.tokens)terminal=true;
  },
  invalid(){invalid=true;},
  done(){if(!terminal||marker)invalid=true;marker=true;},
  result(){return undefined;},
 });
 return {
  qualified:()=>terminal&&!invalid&&inspector.result(false).outcome==='success'&&Boolean(inspector.result(false).tokens),
  snapshot:()=>({terminal,invalid,tailBytes}),
  async push(bytes:Uint8Array){
   // Track framing only, without retaining data. Feed the canonical parser at
   // event boundaries so tail policy starts exactly after its validated event.
   let start=0;
   for(let i=0;i<bytes.length;i++){
    const byte=bytes[i];
    if(terminal&&++tailBytes>completedTailBytes)throw Error('completed_tail_limit');
    if(skipLf){skipLf=false;if(byte===10)continue;}
    if(byte!==10&&byte!==13){if(!lineNonempty)comment=byte===58;lineNonempty=true;if(prefix.length<5)prefix+=String.fromCharCode(byte);continue;}
    skipLf=byte===13;
    if(lineNonempty){if(!comment){fields=true;other||=prefix!=='data:'&&prefix!=='data';}}
    else{
     const hadMarker=marker;await inspector.push(bytes.subarray(start,i+1));start=i+1;
     if(tailFrame&&fields&&(other||marker===hadMarker))invalid=true;
     fields=false;other=false;tailFrame=terminal;
    }
    lineNonempty=false;comment=false;prefix='';
    if(terminal&&invalid)throw Error('completed_tail_invalid');
   }
   await inspector.push(bytes.subarray(start));
   if(terminal&&invalid)throw Error('completed_tail_invalid');
  },
  async end(){await inspector.end();if(terminal&&(fields||lineNonempty&&!comment))invalid=true;if(terminal&&(!this.qualified()||invalid))throw Error('completed_tail_invalid');},
  stop(){inspector.stop();},
 };
}
