// One bounded staging buffer amortizes file writes from small HTTP chunks.
// Full upload and close still precede canonical routing; never replay a provider.
export async function spoolUpload(request,handle,signal,maximumBytes,onBytes){
 const staging=Buffer.allocUnsafe(1024*1024);let used=0,total=0;
 for await(const chunk of request.iterator({destroyOnReturn:false})){
  signal.throwIfAborted();
  if(total+chunk.length>maximumBytes)throw Object.assign(Error('too_large'),{status:413});
  total+=chunk.length;onBytes(total);
  for(let offset=0;offset<chunk.length;){
   const take=Math.min(staging.length-used,chunk.length-offset);
   chunk.copy(staging,used,offset,offset+take);used+=take;offset+=take;
   if(used===staging.length){await handle.writeFile(staging);signal.throwIfAborted();used=0;}
  }
 }
 signal.throwIfAborted();if(used)await handle.writeFile(staging.subarray(0,used));signal.throwIfAborted();
}
