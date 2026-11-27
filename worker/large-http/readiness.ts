import {bounded} from './capacity.ts';
import type {Health} from './health.ts';
type Ports = {acknowledgement():'pending'|'resolved'|'rejected';running():boolean;inspect():Promise<{image:string;labels:Record<string,string>}|null>;health():Promise<Health>};
type Config = {session:string;image:string;deadline:number};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class StartupReadiness {
  private boot:string|null = null;
  private checks = 0;
  private startupChecks = 0;
  private blocked = false;
  private busy = false;
  private until:number|null = null;
  private events:{check:number;decision:string;reason:string}[] = [];
  private ports:Ports;
  private config:Config;
  private clock:()=>number;
  constructor(ports:Ports,config:Config,clock=Date.now) {this.ports=ports;this.config=config;this.clock=clock;}
  snapshot(){return {boot:this.boot,checks:this.checks,startupChecks:this.startupChecks,blocked:this.blocked,until:this.until,events:structuredClone(this.events)};}
  private live(){if(this.blocked||this.clock()>=this.config.deadline)throw Error('readiness_closed');}
  private pending(reason:string):false {
    this.live();
    if(this.boot||this.startupChecks>=60||this.clock()>=this.until!)throw Error('readiness_exhausted_or_lost');
    this.events.push({check:this.checks,decision:'pending',reason});return false;
  }
  async check():Promise<boolean>{
    if(this.busy){this.blocked=true;throw Error('readiness_overlap');}
    this.busy=true;this.checks++;
    try{
      this.live();if(this.events.length>=128)throw Error('readiness_evidence_full');
      if(!this.boot){
        this.until??=Math.min(this.config.deadline,this.clock()+30000);
        if(++this.startupChecks>60||this.clock()>=this.until)throw Error('readiness_exhausted');
      }
      const acknowledgement=this.ports.acknowledgement();
      if(acknowledgement==='rejected')throw Error('native_keepalive_failed');
      if(acknowledgement==='pending')return this.pending('keepalive_pending');
      if(!this.ports.running())return this.pending('not_running');
      const info=await bounded(this.ports.inspect(),350);this.live();
      if(info===null)return this.pending('absent');
      if(info.labels?.session!==this.config.session||info.labels?.member!=='B'||info.labels?.permit!=='1')throw Error('native_identity');
      if(info.image==='')return this.pending('image_pending');
      if(info.image!==this.config.image)throw Error('native_image');
      const h=await bounded(this.ports.health(),1100);this.live();
      if(h.kind==='unavailable')return this.pending('http_before_response');
      const v=h.value as Record<string,unknown>|null;
      if(h.status!==200||!v||Array.isArray(v)||Object.keys(v).sort().join(',')!=='boot,member,ready,session,workIds'||
        v.ready!==true||v.session!==this.config.session||v.member!=='B'||typeof v.boot!=='string'||!uuid.test(v.boot)||
        !Array.isArray(v.workIds)||v.workIds.length>2||new Set(v.workIds).size!==v.workIds.length||
        !v.workIds.every(id=>id==='new-1'||id==='new-2')||this.boot!==null&&v.boot!==this.boot)throw Error('health_identity');
      if(!this.ports.running())throw Error('readiness_lost');
      this.live();if(!this.boot&&this.clock()>=this.until!)throw Error('startup_deadline');
      this.boot=v.boot;this.events.push({check:this.checks,decision:'ready',reason:'strict_http'});return true;
    }catch(error){
      const code=error instanceof Error?error.message:'';
      const reason=['readiness_closed','readiness_exhausted_or_lost','readiness_exhausted','native_keepalive_failed','native_identity','native_image','health_identity','readiness_lost','startup_deadline','effect_deadline','health_deadline','health_size'].includes(code)?code:'closed';
      this.blocked=true;if(this.events.length<128)this.events.push({check:this.checks,decision:'terminal',reason});throw Error('readiness_terminal');
    }finally{this.busy=false;}
  }
}
