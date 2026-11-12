import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {nativeProviderSnapshotPlugin} from '../scripts/large-http-provider-snapshot.mjs';
const {build}=createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');

test('native catalogue preserves the complete snapshot, shares module state and builds deterministically',async()=>{
 const options={stdin:{contents:`import a from './worker/generated/provider-snapshot.json' with {type:'json'};import b from './worker/generated/provider-snapshot.json' with {type:'json'};export {a,b};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,metafile:true,format:'esm',platform:'node',target:'node24',plugins:[nativeProviderSnapshotPlugin()],logLevel:'silent'};
 const first=await build(options),second=await build(options);
 assert.deepEqual(first.outputFiles[0].contents,second.outputFiles[0].contents);
 assert.ok(Object.keys(first.metafile.inputs).includes('worker/generated/provider-snapshot.json'));
 const module=await import('data:text/javascript;base64,'+Buffer.from(first.outputFiles[0].contents).toString('base64'));
 assert.deepEqual(module.a,JSON.parse(await readFile('worker/generated/provider-snapshot.json','utf8')));
 assert.equal(module.a,module.b);
 assert.ok(first.outputFiles[0].contents.length<100000,'compressed catalogue unexpectedly large');
});
