import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { overrideHotCacheConfig } = await import("../hot-cache.ts");
const model = "claude-fable-5", foreign = "zai-org-glm-5-2", native = "/v1/native/venice/chat/completions";
const encoder = new TextEncoder(), decoder = new TextDecoder();
const input = (extra = {}) => ({ model, messages: [{ role: "user", content: "Synthetic prompt." }], ...extra });
const output = (selected = model) => ({ id: "synthetic-chat", object: "chat.completion", model: selected,
  choices: [{ index: 0, message: { role: "assistant", content: "AUTHORIZED_CONTENT" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, cost: { usd: 9, diem: 17 } });
const frame = (selected = model, text = "AUTHORIZED_CONTENT") => `data: ${JSON.stringify({ id: "synthetic-chat", object: "chat.completion.chunk", model: selected,
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const terminal = () => `data: ${JSON.stringify({ ...output(), object: "chat.completion.chunk", choices: [] })}\n\ndata: [DONE]\n\n`;

async function setup(t, options = {}) {
  const source = structuredClone(snapshot.providers.find(value => value.id === "venice")); assert.ok(source);
  const f = await fixture(t, { pooled: true, ...options, providerId: "venice", configure(provider) {
    Object.assign(provider, source);
    provider.models = [model, foreign].map(upstream => ({ id: `venice/${upstream}`, upstream, capabilities: ["llm.chat"], pricing: null, pricing_ref: null }));
  } });
  f.env.VENICE_API_KEY = "synthetic-environment-key";
  f.upstream = () => Response.json(output());
  f.request = (body = input(), options = {}) => f.call(native, body, options);
  f.disable = () => putGrantCredentials(f.env, grantKey, { provider: "venice", kind: "api_key", enabled: false, credential: "synthetic-original-key" });
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); });
  return f;
}
async function settled(f, cost, tokens = undefined) {
  await f.drain(); const rows = await f.events(); assert.equal(rows.length, 1);
  assert.equal(rows[0].actual_cost_micros, cost);
  if (cost) assert.equal(rows[0].cost_basis, "policy_fixed");
  if (tokens) assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens], tokens);
}
async function consumed(response) {
  const reader = response.body.getReader(); let text = "", failure;
  try { for (;;) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value); } }
  catch (error) { failure = error; }
  finally { reader.releaseLock(); }
  return { text, failure };
}

for (const route of ["native", "manifest", "unified"]) test(`Venice ${route} JSON preserves selected model, original key and observed token usage`, async t => {
  const f = await setup(t);
  const response = route === "native" ? await f.request() : route === "manifest"
    ? await f.call("/v1/proxy/venice/chat_completions", { body: input({ model: `venice/${model}` }) })
    : await f.call("/v1/chat/completions", input({ model: `venice/${model}` }));
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), output());
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://api.venice.ai/api/v1/chat/completions");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(f.sent[0].redirect, "manual");
  assert.equal((await f.sent[0].json()).model, model); await settled(f, 700, [7, 3, 10]);
});

for (const value of [[], [{ model: foreign }], null, false, "foreign"]) test(`Venice rejects presence of fallbacks ${JSON.stringify(value)} before egress`, async t => {
  const f = await setup(t), response = await f.request(input({ fallbacks: value }));
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "unsupported_venice_fallbacks");
  assert.equal(f.sent.length, 0); await f.drain(); assert.ok((await f.events()).every(row => row.actual_cost_micros === 0));
});

for (const kind of ["alias", "origin", "query", "hard-dollar"]) test(`Venice ${kind} remains unqualified before egress`, async t => {
  const f = await setup(t, kind === "hard-dollar" ? { fixed: undefined } : {});
  if (kind === "hard-dollar") { delete f.policy.requestCostMicros; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  if (kind === "origin") f.provider.base_urls.default = "https://other.example/api/v1";
  const response = kind === "query" ? await f.call(`${native}?model=${foreign}`, input())
    : await f.request(input(kind === "alias" ? { model: `venice/${model}` } : {}));
  assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

for (const selected of [foreign, undefined, null, 7, `${model}-alias`]) test(`Venice JSON denies unrequested or missing returned model ${selected}`, async t => {
  const f = await setup(t); f.policy.models = [`venice/${model}`, `venice/${foreign}`];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => Response.json({ ...output(), model: selected, choices: [{ message: { content: "FORBIDDEN_CONTENT" } }] });
  const response = await f.request(); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /FORBIDDEN_CONTENT/);
  assert.equal(f.sent.length, 1); await settled(f, 700);
});

test("Venice SSE preserves fragmented original frames, comments, CRLF and cumulative usage without per-frame authority I/O", async t => {
  const f = await setup(t), wire = (": keepalive\n\n" + frame() + frame() + terminal()).replaceAll("\n", "\r\n");
  const namespace = f.env.GRANT_CREDENTIALS; let inspections = 0;
  f.env.GRANT_CREDENTIALS = { ...namespace, get(id) { const owner = namespace.get(id); return { fetch(url, init) {
    if (new URL(url).pathname === "/inspect") inspections++; return owner.fetch(url, init);
  } }; } };
  f.upstream = () => { const bytes = encoder.encode(wire); let at = 0; return new Response(new ReadableStream({
    pull(controller) { if (at === bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(at, ++at)); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream", "content-length": String(bytes.length) } }); };
  const response = await f.request(input({ stream: true })); assert.equal(response.status, 200); assert.equal(await response.text(), wire);
  assert.equal(inspections, 2); assert.equal(f.sent.length, 1); await settled(f, 700, [7, 3, 10]);
});

test("Venice SSE releases an authorized frame before future bytes and withholds a later foreign frame", { timeout: 5000 }, async t => {
  const f = await setup(t); let release, pulls = 0, canceled = false;
  const barrier = new Promise(resolve => { release = resolve; });
  f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
    pulls++; if (pulls === 1) { controller.enqueue(encoder.encode(frame())); return; }
    await barrier; if (!canceled) { controller.enqueue(encoder.encode(frame(foreign, "FORBIDDEN_CONTENT") + terminal())); }
  }, cancel() { canceled = true; release(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const response = await f.request(input({ stream: true })); assert.equal(response.status, 200);
  const reader = response.body.getReader(), first = await reader.read(); assert.equal(decoder.decode(first.value), frame());
  assert.ok(pulls >= 1 && pulls <= 2); release(); await assert.rejects(reader.read()); reader.releaseLock();
  assert.equal(canceled, true); assert.equal(f.sent.length, 1); await settled(f, 700);
});

for (const suffix of ["data: {}\n\n", "event: error\ndata: {}\n\n", "data: {broken}\n\n", "data: [DONE]\n\ndata: {}\n\n"]) {
  test(`Venice SSE withholds malformed or foreign evidence after selected output: ${suffix.slice(0, 18)}`, async t => {
    const f = await setup(t); f.upstream = () => new Response(frame() + suffix, { headers: { "content-type": "text/event-stream" } });
    const response = await f.request(input({ stream: true })), read = await consumed(response);
    assert.ok(read.failure); assert.ok(read.text.startsWith(frame())); assert.doesNotMatch(read.text, /data: \{\}|broken|event: error/);
    assert.equal(f.sent.length, 1); await settled(f, 700);
  });
}

for (const stream of [false, true]) test(`Venice ${stream ? "SSE" : "JSON"} original owner revocation before publication discards generated content`, async t => {
  const f = await setup(t); overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  f.upstream = async () => { await f.disable(); return stream ? new Response(frame() + terminal(), { headers: { "content-type": "text/event-stream" } }) : Response.json(output()); };
  const response = await f.request(input({ stream })), read = await consumed(response);
  assert.doesNotMatch(read.text, /AUTHORIZED_CONTENT|synthetic-original-key/); assert.ok(response.status >= 400 || read.failure);
  assert.equal(f.sent.length, 1); await settled(f, 700);
});

test("Venice current model policy tightens before JSON publication", async t => {
  const f = await setup(t); f.upstream = async () => { f.policy.models = [`venice/${foreign}`];
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); return Response.json(output()); };
  const response = await f.request(); assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(), /AUTHORIZED_CONTENT/); await settled(f, 700);
});

test("Venice first fresh environment selection works but cannot rotate its key during response delivery", async t => {
  const f = await setup(t, { pooled: false });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-environment-key");
  f.upstream = () => { f.env.VENICE_API_KEY = "synthetic-rotated-key"; return Response.json(output()); };
  const rotated = await f.request(); assert.ok(rotated.status >= 400); assert.doesNotMatch(await rotated.text(), /AUTHORIZED_CONTENT/);
  assert.equal(f.sent.length, 2); await f.drain(); const rows = await f.events(); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.actual_cost_micros === 700));
});

test("Venice pre-dispatch capacity denial remains known-unsent", async t => {
  const f = await setup(t), held = new BodyLease(); assert.equal(held.grow(32 * 1024 * 1024), true);
  try { const response = await f.request(); assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); await settled(f, 0); }
  finally { held.release(); }
});

test("Venice SSE cancellation aborts pending upstream demand and releases response capacity", { timeout: 5000 }, async t => {
  const f = await setup(t); let canceled = false;
  f.upstream = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(frame())); },
    cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const response = await f.request(input({ stream: true })), reader = response.body.getReader();
  assert.equal(decoder.decode((await reader.read()).value), frame()); await reader.cancel(); reader.releaseLock();
  assert.equal(canceled, true); assert.equal(f.sent.length, 1); await settled(f, 700);
});

test("Venice preserves explicit unpriced model passthrough without inventing a catalog card", async t => {
  const f = await setup(t), selected = "synthetic-unregistered-model";
  assert.ok(f.provider.endpoints.find(endpoint => endpoint.id === "chat_completions").modelPassthrough);
  f.upstream = () => Response.json(output(selected));
  const response = await f.request(input({ model: selected })); assert.equal(response.status, 200); assert.equal((await response.json()).model, selected);
  assert.equal(f.provider.models.some(row => row.upstream === selected), false); await settled(f, 700, [7, 3, 10]);
});

for (const change of ["disabled", "replaced", "policy", "caller", "environment"]) test(`Venice ${change} change after reservation denies an admitted warm request before egress`, async t => {
  const f = await setup(t, { pooled: change !== "environment" }); overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
  const warm = await f.request(); assert.equal(warm.status, 200); await warm.text(); await f.drain(); assert.equal(f.sent.length, 1);
  const namespace = f.env.BUDGET_LEDGER; let changed = false;
  f.env.BUDGET_LEDGER = { ...namespace, get(id) { const ledger = namespace.get(id); return { async fetch(url, init) {
    const response = await ledger.fetch(url, init);
    if (new URL(url).pathname === "/dispatch" && !changed) {
      changed = true;
      if (change === "disabled") await f.disable();
      if (change === "replaced") await putGrantCredentials(f.env, grantKey, { provider: "venice", kind: "api_key", enabled: true, credential: "synthetic-replacement-key" });
      if (change === "policy") { f.policy.models = [`venice/${foreign}`]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
      if (change === "caller") await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "revoke", credentialId: "fixture" });
      if (change === "environment") f.env.VENICE_API_KEY = "synthetic-replacement-key";
    }
    return response;
  } }; } };
  const response = await f.request(); assert.ok(response.status >= 400); await response.text();
  assert.equal(changed, true); assert.equal(f.sent.length, 1); await f.drain();
  assert.deepEqual((await f.events()).map(row => row.actual_cost_micros).sort((a, b) => a - b), [0, 700]);
});

for (const shape of ["oversized-frame", "missing-done", "trailing-fragment", "invalid-utf8"]) test(`Venice SSE ${shape} does not release unvalidated bytes`, async t => {
  const f = await setup(t);
  const wire = shape === "oversized-frame" ? encoder.encode(`data: {"model":"${model}","padding":"${"x".repeat(128 * 1024)}"}\n\n`)
    : shape === "invalid-utf8" ? new Uint8Array([100, 97, 116, 97, 58, 32, 0xff, 10, 10])
    : encoder.encode(frame() + (shape === "trailing-fragment" ? terminal() + "data: {" : ""));
  f.upstream = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const response = await f.request(input({ stream: true })), read = await consumed(response);
  assert.ok(response.status >= 400 || read.failure); assert.doesNotMatch(read.text, /padding|data: \{$|�/);
  assert.equal(f.sent.length, 1); await settled(f, 700);
});

for (const failure of ["status", "redirect", "length", "utf8", "size", "interruption"]) test(`Venice JSON ${failure} retains dispatched uncertainty without output or replay`, async t => {
  const f = await setup(t);
  f.upstream = () => {
    if (failure === "status") return new Response("PRIVATE_ERROR", { status: 422 });
    if (failure === "redirect") return new Response(null, { status: 307, headers: { location: "https://other.example/" } });
    if (failure === "interruption") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic interruption")); } }), { headers: { "content-type": "application/json" } });
    const bytes = failure === "utf8" ? new Uint8Array([0xff]) : encoder.encode(failure === "size" ? "x".repeat(2 * 1024 * 1024 + 1) : JSON.stringify(output()));
    return new Response(bytes, { headers: { "content-type": "application/json", ...(failure === "length" ? { "content-length": String(bytes.length + 1) } : {}) } });
  };
  const response = await f.request(); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /AUTHORIZED_CONTENT|PRIVATE_ERROR/);
  assert.equal(f.sent.length, 1); await settled(f, 700);
});

test("Venice SSE checks original credential expiry locally before later frames", { timeout: 5000 }, async t => {
  const f = await setup(t); await putGrantCredentials(f.env, grantKey, { provider: "venice", kind: "api_key", enabled: true,
    credential: "synthetic-original-key", expiresAt: new Date(Date.now() + 10000).toISOString() });
  let release, sent = false, canceled = false; const barrier = new Promise(resolve => { release = resolve; });
  f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
    if (!sent) { sent = true; controller.enqueue(encoder.encode(frame())); return; }
    await barrier; if (!canceled) controller.enqueue(encoder.encode(frame(model, "EXPIRED_CONTENT") + terminal()));
  }, cancel() { canceled = true; release(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const response = await f.request(input({ stream: true })), reader = response.body.getReader();
  assert.equal(response.status, 200); assert.equal(decoder.decode((await reader.read()).value), frame());
  f.advance(20000); release(); await assert.rejects(reader.read()); reader.releaseLock();
  assert.equal(canceled, true); assert.equal(f.sent.length, 1); await settled(f, 700);
});
