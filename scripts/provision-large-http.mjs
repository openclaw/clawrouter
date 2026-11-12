// Deployment-time secret provisioning. Never rotate an existing control token.
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assertDeploymentMutation,deploymentTarget} from './deployment-profile.mjs';
export async function provisionLargeHttp({env=process.env,fetchImpl=fetch}={}){
 const target=deploymentTarget(env);assertDeploymentMutation(target,env);
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 if(!/^[a-f0-9]{32}$/.test(account??'')||!token)throw Error('Cloudflare deployment credentials required');
 const url=`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(target.workerName)}/secrets`;
 const headers={authorization:`Bearer ${token}`};
 const inspect=async()=>{
  const r=await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(30000)}),v=await r.json();
  if(!r.ok||v.success!==true||!Array.isArray(v.result))throw Error('large_http_secret_inspection_failed');
  return v.result.some(s=>s.name==='LARGE_HTTP_TOKEN');
 };
 if(await inspect())return {created:false};
 try{
  const created=await fetchImpl(url,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),headers:{...headers,'content-type':'application/json'},body:JSON.stringify({name:'LARGE_HTTP_TOKEN',type:'secret_text',text:randomBytes(32).toString('hex')})});
  const ack=await created.json();if(!created.ok||ack.success!==true||!await inspect())throw Error();
 }catch{throw Error('large_http_secret_creation_unknown_do_not_retry');}
 return {created:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await provisionLargeHttp()));
