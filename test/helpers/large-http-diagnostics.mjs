import {spawnSync} from 'node:child_process';
// Accept closed bootstrap diagnostics only. Raw Docker logs never enter evidence.
export function bootstrapDiagnostics(text){
 const rows=[];
 for(const line of String(text).split('\n')){
  if(line.length>1024)continue;let v;try{v=JSON.parse(line);}catch{continue;}
  if(!v||typeof v!=='object'||Array.isArray(v))continue;
  if(v.category==='large_http_bootstrap_failed'&&Object.keys(v).sort().join(',')==='category,code,name,reason,stage,status'&&
   ['imports','origin','fetch','headers','read','write','import'].includes(v.stage)&&
   ['origin','status','contract','size','integrity','operation_failed'].includes(v.reason)&&
   ['Error','TypeError','AbortError','TimeoutError','SyntaxError','other'].includes(v.name)&&
   [null,'ECONNREFUSED','ECONNRESET','EEXIST','ENOSPC','EACCES'].includes(v.code)&&
   (v.status===null||Number.isSafeInteger(v.status)&&v.status>=100&&v.status<=599))rows.push(v);
  if(v.category==='managed_bootstrap_failure'&&Object.keys(v).sort().join(',')==='category,code,reason,stage'&&
   ['imports','download','read','write','import'].includes(v.stage)&&
   ['bootstrap_origin','bootstrap_status','bootstrap_contract','bootstrap_size','bootstrap_integrity','operation_failed'].includes(v.reason)&&
   [null,'ECONNREFUSED','ECONNRESET','EEXIST','ENOSPC'].includes(v.code))rows.push(v);
  if(rows.length>=20)break;
 }
 return rows;
}

export function dockerBootstrapDiagnostics(id){
 if(!/^[a-f0-9]{12,64}$/.test(id))throw Error('docker_log_identity');
 const r=spawnSync('/usr/local/bin/docker',['--host','unix:///Users/joshavant/.docker/run/docker.sock','logs','--tail','20',id],{encoding:'utf8',timeout:15000,maxBuffer:128*1024,stdio:['ignore','pipe','pipe']});
 if(r.error||r.status!==0)throw Error('docker_log_unavailable');
 return bootstrapDiagnostics(r.stdout+'\n'+r.stderr);
}
