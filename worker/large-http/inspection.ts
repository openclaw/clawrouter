// A native inspection can queue behind cold start. Observe one read until it
// settles; the slot's startup deadline owns the overall wait. Never queue a
// second inspection while the first is unresolved.
export function startupInspection<T>(inspect:()=>Promise<T>) {
 let pending:{phase:'pending'|'resolved'|'rejected';value?:T;error?:unknown}|undefined;
 return (): {kind:'pending'}|{kind:'observed';value:T}=>{
  if(!pending){
   const current=pending={phase:'pending' as 'pending'|'resolved'|'rejected',value:undefined as T|undefined,error:undefined as unknown};
   try{void inspect().then(value=>{current.value=value;current.phase='resolved';},error=>{current.error=error;current.phase='rejected';});}
   catch(error){current.error=error;current.phase='rejected';}
  }
  if(pending.phase==='pending')return {kind:'pending'};
  const result=pending;pending=undefined;
  if(result.phase==='rejected')throw result.error;
  return {kind:'observed',value:result.value as T};
 };
}
