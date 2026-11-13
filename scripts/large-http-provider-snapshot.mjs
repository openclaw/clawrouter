// Native Node build only. Preserve the complete catalogue without embedding
// hundreds of KiB of repeated object keys in the bootstrap download.
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';

export function nativeProviderSnapshotPlugin(){
 return {name:'native-provider-snapshot',setup(build){
  build.onLoad({filter:/[/\\]worker[/\\]generated[/\\]provider-snapshot\.json$/},async({path})=>{
   const json=JSON.stringify(JSON.parse(await readFile(path,'utf8')));
   const compressed=gzipSync(json);
   // Preserve the launched artifact's Darwin gzip OS metadata on every build
   // host. This header byte does not affect decompression, but is fingerprinted.
   compressed[9]=19;
   const encoded=compressed.toString('base64');
   return {loader:'js',contents:`import {gunzipSync} from 'node:zlib';
import {Buffer} from 'node:buffer';
export default JSON.parse(gunzipSync(Buffer.from(${JSON.stringify(encoded)},'base64'),{maxOutputLength:${Buffer.byteLength(json)}}).toString('utf8'));`};
  });
 }};
}
