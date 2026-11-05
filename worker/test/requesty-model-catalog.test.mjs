import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
// Native Node loading intentionally does not install the test TS resolver.
import { REQUESTY_MODELS_FORMAT, requestyCatalogRequest, filterRequestyModels, readRequestyModels } from "../requesty-model-catalog.ts";

const base = "https://router.requesty.ai/v1", signal = () => new AbortController().signal;
const row = (id = "synthetic-policy", facts = {}) => ({ id, api: "chat", ...facts });
const list = (...data) => ({ data });
const all = () => true;
const invalid = error => error.status === 502 && error.code === "invalid_model_discovery_response"
  && error.message === "Requesty managed catalog is invalid or exceeds the discovery bound";

test("Requesty factory binds the exact global managed-list path and original Bearer key", () => {
  assert.equal(REQUESTY_MODELS_FORMAT, "requesty.models_managed");
  for (const configured of [base, base + "/"]) {
    const controller = new AbortController(), request = requestyCatalogRequest(configured, "synthetic-original-key", controller.signal);
    assert.equal(request.url, base + "/models/managed"); assert.equal(request.method, "GET"); assert.equal(request.body, null);
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-original-key"]]);
    assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "manual");
    controller.abort(); assert.equal(request.signal.aborted, true);
  }
});

test("Requesty factory rejects alternate products, destinations and malformed keys without leaking inputs", () => {
  for (const configured of ["https://router.requesty.ai", base + "//", base + "/models", "http://router.requesty.ai/v1",
    "https://router.eu.requesty.ai/v1", "https://router.requesty.ai:444/v1", "https://synthetic-private@router.requesty.ai/v1",
    base + "?key=synthetic-private", base + "#synthetic-private", "https://router.requesty.ai/x/../v1", "https://foreign.example/v1", null]) {
    assert.throws(() => requestyCatalogRequest(configured, "synthetic-original-key", signal()), error => error.status === 503 && !error.message.includes("synthetic-private"));
  }
  for (const key of ["", " synthetic-private", "synthetic-private ", "Bearer synthetic-private", "synthetic-private\r\nx: y", "é", "x".repeat(8193), null]) {
    assert.throws(() => requestyCatalogRequest(base, key, signal()), error => error.status === 503 && !error.message.includes("synthetic-private"));
  }
});

test("Requesty strict data-only envelope never fabricates OpenAI markers or pagination", () => {
  assert.deepEqual(filterRequestyModels(list(), all), list());
  for (const payload of [null, [], {}, { data: {} }, { object: "list", data: [] }, { data: [], has_more: false },
    { data: [], next: "synthetic-private" }, { data: [], error: "synthetic-private" }]) assert.throws(() => filterRequestyModels(payload, all), invalid);
});

test("Requesty trims and first-occurrence deduplicates only eligible Chat IDs", () => {
  const input = list(null, "bad", {}, { id: 7, api: "chat" }, row(" "), row("same", { api: "embeddings" }),
    row("\t same \n", { input_price: 0 }), row("same", { input_price: 99 }), row("other"));
  assert.deepEqual(filterRequestyModels(input, all), list(row("same", { input_price: 0 }), row("other")));
  assert.equal(input.data[6].id, "\t same \n");
});

test("Requesty keeps bare, hosted and case-distinct policies without regional or provider aliases", () => {
  const input = list(row("synthetic-policy"), row("host/synthetic-policy"), row("Synthetic-Policy"),
    row("synthetic-policy@eu"), row("host/synthetic-policy@eu-central-1"), row("synthetic-policy", { api: "images" }));
  assert.deepEqual(filterRequestyModels(input, all), list(row("synthetic-policy"), row("host/synthetic-policy"), row("Synthetic-Policy")));
  assert.deepEqual(filterRequestyModels(input, id => id === "synthetic-policy"), list(row()));
  for (const permitted of ["requesty/synthetic-policy", "*", "synthetic-*", "host/*"]) {
    assert.deepEqual(filterRequestyModels(input, id => id === permitted), list());
  }
});

test("Requesty denied IDs and their duplicates cannot restore a seed or expose later facts", () => {
  const calls = [];
  assert.deepEqual(filterRequestyModels(list(row(), row(" synthetic-policy ", { input_price: 99 })), id => { calls.push(id); return false; }), list());
  assert.deepEqual(calls, ["synthetic-policy"]);
});

test("Requesty scan and ID limits remain bounded even for excluded rows", () => {
  assert.equal(filterRequestyModels(list(...Array.from({ length: 4096 }, (_, i) => row(`synthetic-${i}`))), all).data.length, 4096);
  for (const payload of [list(...Array(4097).fill(null)), list(row("x".repeat(513))), list(row("bad\0id")), list(row("bad id"))]) {
    assert.throws(() => filterRequestyModels(payload, () => false), invalid);
  }
});

test("Requesty missing facts stay absent while explicit zero and false stay observable", () => {
  const zero = { input_price: 0, output_price: "0", cached_price: 0, caching_price: "0.0",
    context_window: 0, max_output_tokens: 0, supports_vision: false, supports_reasoning: false };
  assert.deepEqual(filterRequestyModels(list(row()), all), list(row()));
  assert.deepEqual(filterRequestyModels(list(row("synthetic-zero", zero)), all), list(row("synthetic-zero", zero)));
});

test("Requesty observations preserve native representation without currency conversion or fallback limits", () => {
  const facts = { input_price: "0.000003", output_price: 0.000015, cached_price: "3e-7", caching_price: "3.75e-6",
    context_window: 32768, max_output_tokens: 1024, supports_vision: true, supports_reasoning: true };
  assert.deepEqual(filterRequestyModels(list(row("synthetic-priced", facts)), all), list(row("synthetic-priced", facts)));
  for (const value of [undefined, null, -1, NaN, Infinity, "1e400", "abc", " 0 ", "-1", true, "0".repeat(129)]) {
    assert.deepEqual(filterRequestyModels(list(row("synthetic-policy", { input_price: value })), all), list(row()));
  }
  for (const value of [undefined, null, -1, 1.5, "4096", Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.deepEqual(filterRequestyModels(list(row("synthetic-policy", { context_window: value, max_output_tokens: value })), all), list(row()));
  }
  assert.deepEqual(filterRequestyModels(list(row("synthetic-policy", { supports_reasoning: "true", supports_vision: 0 })), all), list(row()));
});

test("Requesty strips private metadata and does not infer capabilities, units or entitlement", () => {
  const payload = list(row("synthetic-policy", { api_key: "synthetic-private", endpoint: "https://foreign.example", headers: { secret: "synthetic-private" },
    name: "vision reasoning", unit: "USD/token", currency: "USD", pricing: { input: 0 }, plan: "coding", region: "eu", tools: true }));
  assert.deepEqual(filterRequestyModels(payload, all), list(row()));
});

test("Requesty complete reader handles fragmented UTF-8 without changing the data-only shape", async () => {
  const payload = list(row("synthetic-café")), bytes = new TextEncoder().encode(JSON.stringify(payload)); let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset));
  } }), { headers: { "content-type": "application/json; charset=utf-8", "content-length": String(bytes.length) } });
  assert.deepEqual(await readRequestyModels(response, signal(), all), payload);
});

for (const [name, make] of [
  ["HTTP failure", () => new Response("synthetic-private", { status: 403 })],
  ["partial response", () => Response.json(list(), { status: 206 })],
  ["wrong MIME", () => new Response("{}", { headers: { "content-type": "text/plain" } })],
  ["content range", () => Response.json(list(), { headers: { "content-range": "bytes 0-10/20" } })],
  ["truncated length", () => Response.json(list(), { headers: { "content-length": "100" } })],
  ["invalid JSON", () => new Response("synthetic-private", { headers: { "content-type": "application/json" } })],
  ["invalid UTF-8", () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } })],
  ["declared oversize", () => Response.json(list(), { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })],
  ["streamed oversize", () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
]) test(`Requesty reader rejects ${name} with a content-free error`, async () => {
  await assert.rejects(readRequestyModels(make(), signal(), all), invalid);
});

test("Requesty reader rejects every redirect status and already-redirected responses", async () => {
  for (let status = 300; status < 400; status++) {
    let canceled = false;
    const response = new Response(status === 304 ? null : new ReadableStream({ cancel() { canceled = true; } }),
      { status, headers: { "content-type": "application/json", location: "https://foreign.example" } });
    await assert.rejects(readRequestyModels(response, signal(), all), invalid);
    assert.equal(canceled, status !== 304); assert.equal(response.body?.locked ?? false, false);
  }
  const redirected = Response.json(list()); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(readRequestyModels(redirected, signal(), all), invalid);
});

test("Requesty reader bounds empty chunks and cancels their producer", { timeout: 5000 }, async () => {
  let reads = 0, canceled; const canceledPromise = new Promise(resolve => { canceled = resolve; });
  const response = new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { canceled(); } },
    { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  await assert.rejects(readRequestyModels(response, signal(), all), invalid); await canceledPromise;
  assert.equal(reads, 8193);
});

test("Requesty reader withholds valid JSON until EOF and propagates caller cancellation", { timeout: 5000 }, async () => {
  const controller = new AbortController(); let reads = 0, waiting, canceled, published = false;
  const waitingPromise = new Promise(resolve => { waiting = resolve; }), canceledPromise = new Promise(resolve => { canceled = resolve; });
  const response = new Response(new ReadableStream({ pull(stream) {
    if (++reads === 1) stream.enqueue(new TextEncoder().encode(JSON.stringify(list(row())))); else waiting();
  }, cancel() { canceled(); } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const pending = readRequestyModels(response, controller.signal, all).then(value => { published = true; return value; });
  await waitingPromise; assert.equal(published, false); controller.abort();
  await assert.rejects(pending, invalid); await canceledPromise; assert.equal(published, false);
});

test("Requesty pre-aborted reader performs no body work", async () => {
  const controller = new AbortController(); controller.abort(); let reads = 0, canceled = false;
  const response = new Response(new ReadableStream({ pull() { reads++; }, cancel() { canceled = true; } }, { highWaterMark: 0 }),
    { headers: { "content-type": "application/json" } });
  await assert.rejects(readRequestyModels(response, controller.signal, all), invalid);
  assert.equal(reads, 0); assert.equal(canceled, true);
});

const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import { requestyCatalogRequest, readRequestyModels } from './worker/requesty-model-catalog.ts';
export default {async fetch(incoming) {
  const query = new URL(incoming.url).search;
  await (await fetch('https://requesty-fixture.test/reset'+query)).text();
  const request = requestyCatalogRequest('https://router.requesty.ai/v1','synthetic-original-key',incoming.signal);
  if(request.redirect!=='manual'||request.method!=='GET'||request.body!==null)throw new Error('invalid factory request');
  let catalog, status=200;
  try {catalog=await readRequestyModels(await fetch(request),incoming.signal,id=>id==='synthetic-policy');}
  catch(error) {status=error.status;}
  const proof=await(await fetch('https://requesty-fixture.test/proof')).json();
  return Response.json({status,catalog,...proof});
}};`;
const upstream = `
let status=200,foreign=false,calls=0,followed=0;
export default {fetch(request) {
  const url=new URL(request.url);
  if(url.origin==='https://requesty-fixture.test') {
    if(url.pathname==='/reset'){status=Number(url.searchParams.get('status'));foreign=url.searchParams.has('foreign');calls=followed=0;return new Response('reset');}
    return Response.json({calls,followed});
  }
  if(url.pathname==='/followed'){followed++;return Response.json({data:[]});}
  calls++;
  if(request.url!=='https://router.requesty.ai/v1/models/managed'||request.method!=='GET'||request.body!==null
    ||request.headers.get('authorization')!=='Bearer synthetic-original-key'||request.headers.has('cookie')||request.headers.has('x-api-key'))throw new Error('invalid owner request');
  if(status!==200)return new Response(status===304?null:'synthetic-private',{status,headers:{'content-type':'application/json',location:(foreign?'https://foreign.example':url.origin)+'/followed'}});
  return Response.json({data:[{id:' synthetic-policy ',api:'chat',input_price:0},{id:'hidden',api:'chat'}]});
}};`;

test("actual workerd constructs the Requesty factory and never follows redirects or replaces its key", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-requesty-catalog-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream); t.after(() => instance.dispose());
  const origin = (await instance.ready).origin;
  for (const [status, foreign] of [[200, false], [302, false], [302, true], [307, true], [403, false]]) {
    await t.test(`${status} ${foreign ? "foreign" : "same"}`, async () => {
      const response = await fetch(`${origin}/?status=${status}${foreign ? "&foreign" : ""}`);
      assert.equal(response.status, 200, await response.clone().text()); const proof = await response.json();
      assert.equal(proof.status, status === 200 ? 200 : 502); assert.equal(proof.calls, 1); assert.equal(proof.followed, 0);
      if (status === 200) assert.deepEqual(proof.catalog, list(row("synthetic-policy", { input_price: 0 })));
      else assert.equal(proof.catalog, undefined);
    });
  }
});
test("Requesty registers its original reader before header rejection and joins first cleanup", async () => {
  let release, started, owner, canceled = 0, settled = false;
  const cleanup = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { started = resolve; });
  const response = new Response(new ReadableStream({ async cancel() {
    assert.ok(owner); canceled++; started(); await cleanup; throw new Error("synthetic cleanup rejection");
  } }, { highWaterMark: 0 }), { headers: { "content-type": "text/plain" } });
  const pending = readRequestyModels(response, signal(), all, (input, original) => { assert.equal(original, response); owner = input; });
  const rejected = assert.rejects(pending, invalid).then(() => { settled = true; });
  try {
    await reached; assert.equal(response.body.locked, true); assert.equal(settled, false);
    const first = owner.retire("cancel"), second = owner.retire("cancel"); assert.equal(first, second);
    release(); await rejected; await first; assert.equal(canceled, 1); assert.equal(response.body.locked, false);
  } finally { release(); }
});

test("Requesty never registers ownership of an already used or externally locked response", async () => {
  let registered = 0;
  const used = Response.json(list()); await used.text();
  await assert.rejects(readRequestyModels(used, signal(), all, () => { registered++; }), invalid);
  const locked = Response.json(list()), reader = locked.body.getReader();
  await assert.rejects(readRequestyModels(locked, signal(), all, () => { registered++; }), invalid);
  assert.equal(registered, 0); assert.equal(locked.body.locked, true);
  await reader.cancel(); reader.releaseLock();
});
