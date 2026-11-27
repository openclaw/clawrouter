// One reader, one pending write. No tee, replay, eager drain or output buffer.
import {completedSse,completedDrainMs} from './completed-sse.ts';
export function responsePump({response,path,res,abort,delivery}){
 const completion=completedSse(response,path);
 let forwarded=false,closed=false,timer,finished=false,reader;
 const state=delivery.completionDrain={eligible:Boolean(completion),forwarded:false,disconnected:false,eof:false,drained:false};
 const onClose=()=>{
  if(res.writableFinished||finished)return;
  closed=true;state.disconnected=true;
  if(!forwarded||!completion?.qualified())abort.abort();
 };
 // The ingress handler delegates close handling here once response headers
 // exist. An upstream error or overall deadline still aborts unconditionally.
 const onError=()=>onClose();
 res.on('close',onClose);res.on('error',onError);
 const write=chunk=>new Promise((resolve,reject)=>{
  if(res.destroyed){onClose();return abort.signal.aborted?reject(Error('downstream_closed')):resolve(false);}
  res.write(chunk,error=>{if(!error)return resolve(true);if(forwarded&&completion?.qualified()){onClose();resolve(false);}else reject(error);});
 });
 return {
  close:onClose,
  async run(){
   reader=response.body?.getReader();
   const onAbort=()=>{res.destroy();void reader?.cancel().catch(()=>{});};
   abort.signal.addEventListener('abort',onAbort,{once:true});
   try{
    if(reader)for(;;){
     abort.signal.throwIfAborted();const next=await reader.read();abort.signal.throwIfAborted();
     if(next.done){state.eof=true;break;}
     await completion?.push(next.value);
     if(!closed){
      const written=await write(next.value);if(written){delivery.profile.mark('output_first');delivery.outputBytes+=next.value.length;}
      if(written&&completion?.qualified()&&!forwarded){
       forwarded=true;state.forwarded=true;
       timer=setTimeout(()=>{state.expired=true;abort.abort();},completedDrainMs);
      }
     }
    }
    await completion?.end();abort.signal.throwIfAborted();
    if(closed){if(!forwarded||!completion?.qualified())throw Error('downstream_closed');state.drained=true;}
    else await new Promise((resolve,reject)=>{res.once('finish',resolve);res.once('close',()=>{if(res.writableFinished)resolve();else if(forwarded&&completion?.qualified()){closed=true;state.disconnected=true;state.drained=true;resolve();}else reject(Error('downstream_closed'));});res.end();});
    delivery.outputFinished=res.writableFinished;delivery.profile.mark('output_eof');finished=true;
   }catch(error){abort.abort();void reader?.cancel().catch(()=>{});throw error;}
   finally{clearTimeout(timer);abort.signal.removeEventListener('abort',onAbort);if(completion)Object.assign(state,completion.snapshot());completion?.stop();reader?.releaseLock();res.removeListener('close',onClose);res.removeListener('error',onError);}
  },
 };
}
