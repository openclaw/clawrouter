// Finite rendezvous; the caller owns deadlines and cleanup. After any failure,
// cancel outstanding observers and stop owned children. This helper never retries
// a child or dispatch. Real Actions recovery shares no runner or local state.
export async function exerciseActions({ids,launch,held,dispatch,greenReady,save}){
 const checkpoint=(child,observation)=>Promise.race([observation,child.done.then(()=>{throw Error('Overlap client ended before held checkpoint; do not dispatch or replay');})]);
 const guard=(controller,operation)=>Promise.race([operation,controller.done.then(()=>{throw Error('Hosted workflow ended before client rendezvous');})]);
 const forward=await launch('FORWARD-CLIENT',['USER-CLIENT.mjs','overlap','forward',ids.blue,ids.green]);
 await save('FORWARD-HELD.json',await checkpoint(forward,held('forward')));
 const workflow=await dispatch();
 await guard(workflow,forward.done);
 await guard(workflow,greenReady());
 const recovery=await launch('RECOVERY-CLIENT',['USER-CLIENT.mjs','overlap','recovery',ids.green,ids.recovery]);
 await save('RECOVERY-HELD.json',await guard(workflow,checkpoint(recovery,held('recovery'))));
 await Promise.all([recovery.done,workflow.done]);
 return workflow.id;
}
