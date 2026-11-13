// Controlled runtime proof. All HTTP is redirected to a local API server and
// pnpm is replaced only inside the proof subprocess environment. No live auth.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApi } from './deploy-train-api.mjs';
import { runTrain, uploadVersion } from './deploy-train.mjs';
import { prepareNativeUpload } from './deploy-train-artifacts.mjs';
import { NATIVE_ANCHOR } from './deploy-train-runtime.mjs';
import { deploymentMessage } from './deploy-train-policy.mjs';
import { nativeVersion } from '../test/helpers/deploy-native-fixture.mjs';

const out = resolve(process.argv[2]), hash = b => createHash('sha256').update(b).digest('hex');
await mkdir(out, { mode: 0o700 });
const save = (name, value) => writeFile(out + '/' + name + '.json', JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const blue = nativeVersion(NATIVE_ANCHOR.version, NATIVE_ANCHOR.sha), greenId = '22222222-2222-2222-2222-222222222222';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const state = { blue: blue.id, deployedSha: NATIVE_ANCHOR.sha, sha, run: '123', deploymentId: 'initial', migration: false, unsafe: false };
let deployment = { id: 'initial', versions: [{ version_id: blue.id, percentage: 100 }], annotations: {} };
let green, requests = [], time = Date.now();
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer local-proof-token');
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    let result;
    const path = new URL(req.url, 'http://local').pathname;
    if (path.endsWith('/deployments')) {
      if (req.method === 'POST') deployment = { id: 'd' + requests.length, versions: body.versions, annotations: body.annotations };
      result = req.method === 'POST' ? deployment : { deployments: [deployment] };
    } else if (path.endsWith('/versions')) result = { items: green ? [green, blue] : [blue] };
    else if (path.endsWith('/versions/' + blue.id)) result = blue;
    else if (path.endsWith('/versions/' + greenId)) result = green;
    else throw new Error('Unexpected local API operation');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, result }));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const origin = 'http://127.0.0.1:' + server.address().port;
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'local-proof-token' };
const api = createApi({ env, fetchImpl: (url, init) => {
  const u = new URL(url); assert.equal(u.origin, 'https://api.cloudflare.com');
  assert.ok(u.pathname.startsWith('/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + '/workers/scripts/clawrouter-edge/'));
  return fetch(origin + u.pathname + u.search, init);
} });
try {
  const configPath = out + '/source.toml', source = await readFile('wrangler.toml', 'utf8');
  const vars = blue.resources.bindings.filter(b => b.type === 'plain_text').map(b => `${b.name} = ${JSON.stringify(b.text)}`).join('\n');
  const text = source.replace(/^name =.*$/m, 'name = "clawrouter-edge"\naccount_id = "' + env.CLOUDFLARE_ACCOUNT_ID + '"')
    .replace(/^main =.*$/m, 'main = ' + JSON.stringify(resolve('.wrangler/large-http/worker.mjs')))
    .replace(/^directory =.*$/m, 'directory = ' + JSON.stringify(resolve('.wrangler/large-http/assets'))) + '\n[[kv_namespaces]]\nbinding = "POLICY_KV"\nid = "' + 'a'.repeat(32) + '"\n\n[vars]\n' + vars + '\n';
  await writeFile(configPath, text, { flag: 'wx', mode: 0o600 });
  await prepareNativeUpload({ state, blue, configPath, directory: out + '/release' });
  await mkdir(out + '/bin');
  const executable = out + '/bin/pnpm';
  await writeFile(executable, `#!${process.execPath}
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const a=process.argv.slice(2);assert.deepEqual(a.slice(0,4),['exec','wrangler','versions','upload']);
const config=a[a.indexOf('--config')+1],text=readFileSync(config,'utf8');
assert.ok(config.endsWith('/green.toml'));assert.ok(!/^\\[build\\]/m.test(text));
assert.ok(text.includes('LARGE_HTTP_INGRESS_ENABLED = "1"'));
writeFileSync(process.env.PROOF_UPLOAD_RECEIPT,JSON.stringify({args:a,config}));
console.log('Worker Version ID: ${greenId}');
`, { flag: 'wx', mode: 0o700 });
  await chmod(executable, 0o700);
  await runTrain({ api, state, mode: 'zero-smoke', analytics: async () => ({ disabled: 'controlled API proof' }),
    now: () => time, wait: async ms => { time += ms; }, save: () => {},
    upload: async s => {
      const id = await uploadVersion(s, { ...env, PATH: out + '/bin:' + process.env.PATH, PROOF_UPLOAD_RECEIPT: out + '/upload.json' });
      green = { id, annotations: { 'workers/tag': sha, 'workers/message': JSON.parse(await readFile(out + '/upload.json')).args.at(-1) }, resources: structuredClone(blue.resources) };
      return id;
    }, smoke: async () => assert.equal(deployment.versions[0].version_id, greenId),
  });
  assert.equal(state.status, 'rehearsed');
  const recovery = { ...state, status: 'rolling', exposed: true };
  deployment = { id: 'interrupted-run', annotations: { 'workers/message': deploymentMessage(recovery) }, versions: [{ version_id: greenId, percentage: 50 }, { version_id: blue.id, percentage: 50 }] };
  const moduleUrl = pathToFileURL(resolve('scripts/deploy-train-recover.mjs')).href;
  const code = `import {recoverRemote} from ${JSON.stringify(moduleUrl)};import {createApi} from ${JSON.stringify(pathToFileURL(resolve('scripts/deploy-train-api.mjs')).href)};const origin=${JSON.stringify(origin)};const api=createApi({env:${JSON.stringify(env)},fetchImpl:(url,init)=>{const u=new URL(url);if(u.origin!=='https://api.cloudflare.com')throw Error('external egress refused');return fetch(origin+u.pathname+u.search,init);}});console.log(await recoverRemote(api,'123'));`;
  const result = await new Promise((ok, no) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); child.on('error', no); child.on('close', code => code === 0 ? ok(output) : no(new Error('Fresh recovery process failed: ' + output)));
  });
  assert.match(result, /rollback: blue restored to 100%/);
  assert.deepEqual(deployment.versions, [{ version_id: blue.id, percentage: 100 }]);
  await save('proof', { passed: true, head: sha, platform: process.platform, node: process.version, provider: 'local controlled HTTP API; no Cloudflare deployment', releaseManifestSha256: state.releaseManifestSha256, runtimeSha: state.native.runtimeSha, workerSha256: hash(await readFile('.wrangler/large-http/worker.mjs')), uploadUsedFrozenGreen: true, coordinatorRehearsed: true, freshProcessRecovery: true, productionMutations: 0, limits: ['Local API validates coordinator behavior, not Cloudflare rollout convergence.', 'Real build artifacts; controlled version metadata, CLI upload and API responses.', 'Focused negative tests cover incompatible recovery and pre-exposure refusal.'] });
  console.log('Controlled train, frozen upload and fresh-process recovery passed.');
} finally {
  await save('requests', requests);
  server.closeAllConnections(); await new Promise(ok => server.close(ok));
}
