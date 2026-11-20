import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { catalogCases, catalogFixtures } from "./catalog-redirect-fixture.mjs";

for (const fixture of catalogCases(new AbortController().signal)) {
  test(`${fixture.id} reader rejects every 3xx and already-redirected response`, async () => {
    for (let status = 300; status < 400; status++) {
      let canceled = 0;
      const body = status === 304 ? null : new ReadableStream({ cancel() { canceled++; } });
      const response = new Response(body, { status, headers: { "content-type": "application/json", location: "https://foreign.example/catalog" } });
      await assert.rejects(fixture.read(response), error => error.status === 502);
      assert.equal(response.body?.locked ?? false, false);
      assert.equal(canceled, status === 304 ? 0 : 1);
    }
    const redirected = Response.json(fixture.payload);
    Object.defineProperty(redirected, "redirected", { value: true });
    await assert.rejects(fixture.read(redirected), error => error.status === 502);
    assert.equal(redirected.body.locked, false);
  });
}

const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import { catalogCases } from './worker/test/catalog-redirect-fixture.mjs';
import { fetchPublicModelDiscovery } from './worker/public-model-discovery.ts';
import { fetchFeatherlessModelCatalog } from './worker/featherless-catalog-scan.ts';
import { HttpOperation } from './worker/http-operation.ts';
export default { async fetch(incoming) {
  const query = new URL(incoming.url).searchParams, status = Number(query.get('status'));
  const control = await fetch('https://catalog-fixture.test/reset?status='+status+'&location='+query.get('location'));
  await control.text();
  const results = [], controller = new AbortController(), requests = [];
  if (query.get('mode') === 'factories') {
    for (const fixture of catalogCases(controller.signal)) {
      // Do not replace Request: construction must run in the actual workerd runtime.
      const request = fixture.request(); requests.push(request);
      if (request.url !== fixture.url || request.method !== 'GET' || request.body !== null || request.redirect !== 'manual') throw new Error('invalid factory request');
      const response = await fetch(request);
      try { await fixture.read(response); results.push({id:fixture.id,ok:true}); }
      catch (error) { results.push({id:fixture.id,ok:false,status:error.status}); }
    }
    controller.abort();
    if (!requests.every(request => request.signal.aborted)) throw new Error('lost original signal');
  } else {
    const bases = {cerebras:'https://api.cerebras.ai/v1',nvidia:'https://integrate.api.nvidia.com/v1',chutes:'https://llm.chutes.ai/v1',venice:'https://api.venice.ai/api/v1',featherless:'https://api.featherless.ai/v1'};
    for (const [providerId,inferenceBaseUrl] of Object.entries(bases)) {
      const operation = new HttpOperation(controller.signal,5000);
      const input = {providerId,inferenceBaseUrl,operation,revalidateAccount:async signal=>signal.throwIfAborted(),allows:()=>true,permittedModelIds:new Set()};
      try {
        const result = providerId === 'featherless'
          ? await fetchFeatherlessModelCatalog({...input,selectedApiKey:'synthetic-original-key'})
          : await fetchPublicModelDiscovery(input);
        const rows = Array.isArray(result.catalog) ? result.catalog : result.catalog.data;
        if (rows.length) throw new Error('unexpected catalog rows');
        results.push({id:providerId,ok:true});
      } catch (error) { results.push({id:providerId,ok:false,status:error.status}); }
      finally { operation.stop('complete'); }
    }
  }
  const proof = await (await fetch('https://catalog-fixture.test/proof')).json();
  return Response.json({results,...proof});
}};`;
const upstream = `
const fixtures = ${JSON.stringify(catalogFixtures)};
let status=200, sameOrigin=false, calls=0, followed=0, invalid=0;
export default {async fetch(request){
  const url = new URL(request.url);
  if (url.origin === 'https://catalog-fixture.test') {
    if (url.pathname === '/reset') {status=Number(url.searchParams.get('status'));sameOrigin=url.searchParams.get('location')==='same';calls=followed=invalid=0;return new Response('reset');}
    return Response.json({calls,followed,invalid});
  }
  if (url.pathname === '/redirect-target') {followed++;return Response.json({object:'list',data:[]});}
  calls++;
  const fixture = fixtures.find(f => f.url === request.url);
  if (!fixture || request.method !== 'GET' || request.body !== null || request.headers.has('cookie') || request.headers.has('x-api-key')
    || request.headers.get('authorization') !== (fixture.keyed ? 'Bearer synthetic-original-key' : null)) {
    invalid++; return new Response('invalid original factory request',{status:400});
  }
  if (status !== 200) return new Response(status===304 ? null : 'redirect denied',{status,headers:{location:(sameOrigin?url.origin:'https://foreign.example')+'/redirect-target','content-type':'application/json'}});
  return Response.json(fixture.payload);
}};`;

test("actual workerd catalog factories and public/page scans construct requests without following redirects", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-catalog-redirect-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream);
  t.after(() => instance.dispose());
  const origin = (await instance.ready).origin;
  for (const mode of ["factories", "scans"]) {
    for (const status of [200, 301, 302, 303, 304, 307, 308]) {
      for (const location of status === 200 ? ["foreign"] : ["same", "foreign"]) {
        await t.test(`${mode} ${status} ${location}`, async () => {
          const response = await fetch(`${origin}/?mode=${mode}&status=${status}&location=${location}`);
          assert.equal(response.status, 200, await response.clone().text());
          const proof = await response.json();
          assert.equal(proof.results.length, mode === "factories" ? 11 : 5);
          for (const result of proof.results) {
            assert.equal(result.ok, status === 200, result.id);
            if (status !== 200) assert.equal(result.status, 502, result.id);
          }
          assert.equal(proof.calls, mode === "factories" ? 11 : status === 200 ? 6 : 5);
          assert.equal(proof.followed, 0); assert.equal(proof.invalid, 0);
        });
      }
    }
  }
});
