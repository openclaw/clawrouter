import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { prepareLargeHttpRelease, verifyLargeHttpRelease } from '../scripts/prepare-large-http-release.mjs';

async function directory(t) { const d=await realpath(await mkdtemp(join(tmpdir(),'large-release-')));t.after(()=>rm(d,{recursive:true,force:true}));return d; }
test('release packaging freezes one runtime and three compatible configs; drift is refused',async t=>{
 const d=await directory(t);await mkdir(join(d,'assets'));await writeFile(join(d,'worker.mjs'),'export default {};\n');await writeFile(join(d,'assets/runtime.mjs'),'synthetic artifact\n');
 const source=await readFile('wrangler.toml','utf8'),config=join(d,'source.toml');
 const text=source.replace(/^main =.*$/m,'main = "worker.mjs"').replace(/^directory =.*$/m,'directory = "assets"').replace(/^name =.*$/m,'name = "clawrouter-release-fixture"\naccount_id = "'+'a'.repeat(32)+'"')+'\n[vars]\nLARGE_HTTP_ORIGIN = "https://fixture.example"\n';
 await writeFile(config,text);const p=await prepareLargeHttpRelease({configPath:config,directory:join(d,'package')});const manifest=await verifyLargeHttpRelease(p.path);
 assert.equal(manifest.worker,'clawrouter-release-fixture');assert.equal(Object.keys(manifest.files).length,2);
 for(const [name,stage]of Object.entries(manifest.stages)){const c=getStaticTOMLValue(parseTOML(await readFile(stage.path,'utf8')));assert.equal(c.build,undefined);assert.equal(c.vars.LARGE_HTTP_ENABLED,name==='bootstrap'?'0':'1');assert.equal(c.vars.LARGE_HTTP_INGRESS_ENABLED,name==='green'?'1':'0');assert.equal(c.triggers.crons[0],'*/5 * * * *');}
 await assert.rejects(prepareLargeHttpRelease({configPath:config,directory:join(d,'package')}),/EEXIST/);
 await writeFile(join(d,'assets/unexpected'),'drift');await assert.rejects(verifyLargeHttpRelease(p.path),/inventory drift/);await rm(join(d,'assets/unexpected'));
 const blue=manifest.stages.blue,original=await readFile(blue.path,'utf8');await writeFile(blue.path,original.replace('LARGE_HTTP_ENABLED = "1"','LARGE_HTTP_ENABLED = "0"'));await assert.rejects(verifyLargeHttpRelease(p.path),/configuration drift/);
 manifest.stages.blue.sha256=createHash('sha256').update(await readFile(blue.path)).digest('hex');await writeFile(p.path,JSON.stringify(manifest));await assert.rejects(verifyLargeHttpRelease(p.path),/stage contract/);
});
