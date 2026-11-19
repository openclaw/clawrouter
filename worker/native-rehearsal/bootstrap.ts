// Rehearsal only. No raw exception, URL, environment or log text is reported.
export const bootstrapReceiptUrl='http://native-rehearsal.invalid/bootstrap';
export const bootstrapFetchCodes=['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'] as const;
// Self-contained because the exact function is embedded into the Node prefix.
export function closedBootstrapFailure(v:any){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!=='category,code,name,reason,stage,status'||
  v.category!=='large_http_bootstrap_failed'||!['imports','origin','fetch','headers','read','write','import'].includes(v.stage)||
  !['origin','status','contract','size','integrity','operation_failed'].includes(v.reason)||
  !['Error','TypeError','AbortError','TimeoutError','SyntaxError','other'].includes(v.name)||
  ![null,'ECONNREFUSED','ECONNRESET','EEXIST','ENOSPC','EACCES'].includes(v.code)||
  !(v.status===null||Number.isInteger(v.status)&&v.status>=100&&v.status<=599))return null;
 return {category:v.category,stage:v.stage,status:v.status,reason:v.reason,name:v.name,code:v.code};
}
export interface BootstrapReceipt {event:'entered'|'exit';diagnostic:ReturnType<typeof closedBootstrapFailure>;fetchCode:typeof bootstrapFetchCodes[number]|null;at:number}
export function bootstrapReceiptValid(v:any){
 if(!v||Object.keys(v).sort().join()!=='diagnostic,event,fetchCode'||!['entered','exit'].includes(v.event))return false;
 if(v.event==='entered')return v.diagnostic===null&&v.fetchCode===null;
 return (v.diagnostic===null||closedBootstrapFailure(v.diagnostic)!==null)&&(v.fetchCode===null||bootstrapFetchCodes.includes(v.fetchCode));
}
export function bootstrapProbePrefix(){return `{
 const originalFetch=globalThis.fetch,originalExit=process.exit.bind(process),originalError=console.error.bind(console);
 const closed=${closedBootstrapFailure.toString()},codes=${JSON.stringify(bootstrapFetchCodes)};
 let diagnostic=null,fetchCode=null,exiting=false;
 const report=async body=>{const r=await originalFetch(${JSON.stringify(bootstrapReceiptUrl)},{method:'POST',body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(1500)});await r.body?.cancel();if(!r.ok)throw Error('diagnostic_receipt_refused');};
 // Exit 86 identifies an unavailable diagnostic channel, not a product failure.
 try{await report({event:'entered',diagnostic:null,fetchCode:null});}catch{originalExit(86);}
 globalThis.fetch=async(...args)=>{try{return await originalFetch(...args);}catch(error){const code=error?.cause?.code??error?.code;fetchCode=codes.includes(code)?code:null;throw error;}};
 console.error=(...args)=>{if(args.length===1&&typeof args[0]==='string'&&args[0].length<=1024){try{diagnostic??=closed(JSON.parse(args[0]));}catch{}}originalError(...args);};
 process.exit=code=>{if(code!==1)return originalExit(code);if(exiting)return;exiting=true;void report({event:'exit',diagnostic,fetchCode}).catch(()=>{}).finally(()=>originalExit(code));};
}
`;}
