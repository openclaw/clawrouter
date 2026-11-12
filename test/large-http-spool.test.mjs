import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,open,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spoolUpload} from '../runtime/large-http/spool.mjs';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'spool-proof-')),path=join(directory,'input'),handle=await open(path,'wx',0o600);
 t.after(async()=>{await handle.close();await rm(directory,{recursive:true,force:true});});
 return {path,handle};
}

test('spool preserves fragmented binary input including an incomplete final batch',async t=>{
 const {path,handle}=await fixture(t),input=Buffer.alloc(2*1024**2+173);
 for(let i=0;i<input.length;i++)input[i]=i%251;
 const chunks=[];for(let i=0;i<input.length;i+=317)chunks.push(input.subarray(i,i+317));
 let last=0;await spoolUpload(Readable.from(chunks),handle,new AbortController().signal,input.length,bytes=>{assert.ok(bytes>last&&bytes<=input.length);last=bytes;});
 assert.equal(last,input.length);assert.deepEqual(await readFile(path),input);
});

test('spool enforces the byte cap before an oversized chunk can be persisted',async t=>{
 const {path,handle}=await fixture(t);let accepted=0;
 await assert.rejects(spoolUpload(Readable.from([Buffer.alloc(1024**2,7),Buffer.alloc(12,9)]),handle,new AbortController().signal,1024**2+11,n=>accepted=n),e=>e.status===413);
 assert.equal(accepted,1024**2);assert.deepEqual(await readFile(path),Buffer.alloc(1024**2,7));
});

test('cancellation discards a buffered tail and does not flush it after abort',async t=>{
 const {path,handle}=await fixture(t),controller=new AbortController();
 async function* chunks(){yield Buffer.alloc(100,7);controller.abort();yield Buffer.alloc(100,9);}
 await assert.rejects(spoolUpload(Readable.from(chunks()),handle,controller.signal,1000,()=>{}),e=>e.name==='AbortError');
 assert.equal((await readFile(path)).length,0);
});

test('disk failure stops intake and propagates the original failure',async()=>{
 const failure=Object.assign(Error('fixture_disk_full'),{code:'ENOSPC'});let pulls=0;
 async function* chunks(){for(let i=0;i<20;i++){pulls++;yield Buffer.alloc(256*1024,7);}}
 const req=Readable.from(chunks(),{highWaterMark:1});
 await assert.rejects(spoolUpload(req,{writeFile:async()=>{throw failure;}},new AbortController().signal,64*1024**2,()=>{}),e=>e===failure);
 assert.ok(pulls<20);req.destroy();
});
