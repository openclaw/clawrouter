// Bounded allocation shared by finite qualification and continuous lifecycles.
export const poolLimit=8;
export const attempt=/^prf_[a-f0-9]{32}$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface Grant {id:string;slot:number;fence:number;tenant:string;boot:string;until:number;stage:'granted'|'claimed'|'intent';generation?:number;admittedAt?:number;claimedAt?:number}
export interface PoolState {schema:1;fence:number;next:number;members:Array<{boot:string;quarantined:boolean}|null>;grants:Grant[];seen:Record<string,string>;issued:number}
export function initialPool():PoolState{return {schema:1,fence:0,next:0,members:Array(poolLimit).fill(null),grants:[],seen:{},issued:0};}
export function poolTransition(s:PoolState,op:string,v:any,now:number,options:{tenantLimit?:number}={}){
 for(const g of [...s.grants])if(g.until<=now){if(g.stage==='granted'){s.grants.splice(s.grants.indexOf(g),1);s.seen[g.id]='expired';}else{if(s.members[g.slot])s.members[g.slot]!.quarantined=true;}}
 if(op==='snapshot')return {status:200,state:s};
 if(op==='ready'){
  if(!Number.isSafeInteger(v.slot)||v.slot<0||v.slot>=poolLimit||!uuid.test(v.boot??''))return {status:400};
  const old=s.members[v.slot];if(old&&old.boot!==v.boot){old.quarantined=true;return {status:409};}
  s.members[v.slot]??={boot:v.boot,quarantined:false};return {status:200};
 }
 if(!attempt.test(v.id??''))return {status:400};
 if(op==='admit'){
  if(s.seen[v.id])return {status:409};
  if(!/^[a-f0-9]{64}$/.test(v.tenant??''))return {status:400};
  if(s.issued>=512)return {status:503};s.issued++;s.seen[v.id]='refused';
  if(s.grants.filter(g=>g.tenant===v.tenant).length>=(options.tenantLimit??2))return {status:429};
  const indexes=Array.from({length:poolLimit},(_,i)=>(s.next+i)%poolLimit);
  const slot=indexes.find(i=>s.members[i]&&!s.members[i]!.quarantined&&!s.grants.some(g=>g.slot===i));
  if(slot===undefined)return {status:503};
  const g:Grant={id:v.id,tenant:v.tenant,slot,fence:++s.fence,boot:s.members[slot]!.boot,until:now+5000,stage:'granted'};
  s.next=(slot+1)%poolLimit;s.grants.push(g);s.seen[v.id]='granted';return {status:200,grant:g};
 }
 const g=s.grants.find(g=>g.id===v.id);
 if(!g||g.slot!==v.slot||g.fence!==v.fence||g.boot!==v.boot||s.members[g.slot]?.quarantined)return {status:409};
 if(op==='claim'&&g.stage==='granted'){g.stage='claimed';g.until=now+455000;return {status:200};}
 if(op==='dispatch'&&g.stage==='claimed'){g.stage='intent';return {status:200};}
 if(op==='finish'&&['claimed','intent'].includes(g.stage)){
  s.seen[g.id]=v.clean===true?'complete':'quarantined';
  if(v.clean===true)s.grants.splice(s.grants.indexOf(g),1);else if(s.members[g.slot])s.members[g.slot]!.quarantined=true;
  return {status:200};
 }
 return {status:409};
}
