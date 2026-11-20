// Interrupted execution is evidence, not the session-continuity verdict.
// No turn is resent. Only a distinct challenge in the saved thread proves recovery.
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
export function turnEvidence(client,started){
 const turnId=started.turn.id;
 const completed=client.notifications.find(n=>n.method==='turn/completed'&&n.params.turn.id===turnId);
 return {turnId,status:completed?.params.turn.status??(client.errors.length?'transport_failed':'unknown'),finishedAt:Date.now(),retryNotifications:client.notifications.filter(n=>n.method==='error'&&n.params.turnId===turnId&&n.params.willRetry).length,transportErrors:client.errors.length};
}
export async function observeInterruptedTurn(client,started,{now=Date.now,wait=sleep,timeoutMs=120000}={}){
 const end=now()+timeoutMs;
 while(now()<end){const r=turnEvidence(client,started);if(r.status!=='unknown')return r;await wait(Math.min(250,end-now()));}
 return turnEvidence(client,started);
}
export function assertContextAnswer(client,started,expected){
 const r=turnEvidence(client,started);assert.equal(r.status,'completed','context-dependent saved turn failed');
 assert(client.notifications.some(n=>n.method==='item/completed'&&n.params.turnId===r.turnId&&n.params.item?.type==='agentMessage'&&n.params.item.text===expected),'synthetic answer must derive from prior context');
 return {...r,answerSha256:expected};
}
