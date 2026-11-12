// Download code only, once, bounded and digest checked. No persisted secrets.
export const bootstrap=`
let stage='imports',status=null;try{
const {writeFile}=await import('node:fs/promises');
const {createHash}=await import('node:crypto');
stage='origin';const origin=process.env.LARGE_HTTP_ORIGIN,u=new URL(origin);
if(origin!==u.origin||u.username||u.password||!(u.protocol==='https:'||process.env.LARGE_HTTP_LOCAL==='1'&&u.protocol==='http:'&&u.hostname==='host.docker.internal'))throw Error('origin');
stage='fetch';const r=await fetch(origin+'/__large_http/runtime',{headers:{'x-large-http-slot':process.env.LARGE_HTTP_SLOT,'x-large-http-generation':process.env.LARGE_HTTP_GENERATION,'x-large-http-token':process.env.LARGE_HTTP_RUNTIME_TOKEN},redirect:'error',signal:AbortSignal.timeout(20000)});
stage='headers';status=r.status;
if(r.status!==200)throw Error('status');
const n=Number(process.env.LARGE_HTTP_RUNTIME_BYTES),sha=process.env.LARGE_HTTP_RUNTIME_SHA;
if(!Number.isSafeInteger(n)||n<1||n>2097152||!/^[a-f0-9]{64}$/.test(sha))throw Error('contract');
stage='read';const reader=r.body.getReader(),parts=[];let count=0;
for(;;){const {value,done}=await reader.read();if(done)break;count+=value.length;if(count>n){await reader.cancel();throw Error('size');}parts.push(value);}
const bytes=Buffer.concat(parts);if(count!==n||createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('integrity');
stage='write';await writeFile('/tmp/large-http-runtime.mjs',bytes,{flag:'wx',mode:0o600});
stage='import';await import('file:///tmp/large-http-runtime.mjs');
}catch(e){console.error(JSON.stringify({category:'large_http_bootstrap_failed',stage,status,reason:['origin','status','contract','size','integrity'].includes(e?.message)?e.message:'operation_failed',name:['Error','TypeError','AbortError','TimeoutError','SyntaxError'].includes(e?.name)?e.name:'other',code:['ECONNREFUSED','ECONNRESET','EEXIST','ENOSPC','EACCES'].includes(e?.code)?e.code:null}));process.exit(1);}
`;
