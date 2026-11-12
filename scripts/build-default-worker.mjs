// Rebuild generated deployment files only. No Cloudflare API or credentials.
import {cp,mkdir,rm} from 'node:fs/promises';
import {buildLargeHttp} from './build-large-http.mjs';
const directory='.wrangler/large-http';
await rm(directory,{recursive:true,force:true});
await mkdir(directory+'/assets',{recursive:true,mode:0o700});
await cp('admin/dist',directory+'/assets',{recursive:true});
const manifest=await buildLargeHttp(directory);
console.log(JSON.stringify({workerBytes:manifest.worker.bytes,runtimeBytes:manifest.runtime.bytes,runtimeSha256:manifest.runtime.sha256}));
