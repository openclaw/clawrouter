import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { groqMistralAudio } = await import("../groq-mistral-audio.ts");
const { bodyBudgetCharged, BodyLease } = await import("../body-budget.ts");
const { revokeGrantCredentials, putGrantCredentials } = await import("../grant-credentials.ts");
const sources = Object.fromEntries(["groq", "mistral"].map(id => [id, parse(readFileSync(new URL(`../../providers/${id}.provider.yaml`, import.meta.url), "utf8"))]));
const wires = Object.fromEntries(["groq", "mistral"].map(id => [id, JSON.parse(readFileSync(new URL(`../../providers/_fixtures/${id}/transcription.json`, import.meta.url), "utf8"))]));
const capacity = 96 * 1024 * 1024;
function declaration(id) {
  const value = structuredClone(sources[id]), model = groqMistralAudio[id].model;
  value.capabilities = value.capabilities.filter(item => item.endpoint !== "transcription");
  value.capabilities.push({ id: "audio.transcription", endpoint: "transcription", methods: ["POST"] });
  value.endpoints.transcription = { method: "POST", path: "/v1/audio/transcriptions", pathParams: [], requestFormat: `${id}.transcription`, responseFormat: `${id}.transcription` };
  value.models.entries = value.models.entries.filter(item => item.id !== `${id}/${model}`);
  value.models.entries.push({ id: `${id}/${model}`, upstream: model, capabilities: ["audio.transcription"] });
  return compileProviderSnapshot([value]).providers[0];
}
function form(id, native = true, extra = {}) {
  const wire = wires[id], body = new FormData();
  for (const [name, value] of Object.entries({ ...wire.fields, model: native ? groqMistralAudio[id].model : `${id}/${groqMistralAudio[id].model}`, ...extra })) body.append(name, value);
  body.append("file", new File([Buffer.from(wire.file.base64, "base64")], wire.file.name, { type: wire.file.type }));
  return body;
}
async function setup(t, id, { pooled = true, fixed = 700 } = {}) {
  const compiled = declaration(id), f = await fixture(t, { providerId: id, pooled, fixed, configure(provider) { Object.assign(provider, compiled); } });
  f.env[`${id.toUpperCase()}_API_KEY`] = "synthetic-environment-key";
  if (pooled) { f.policy.grantRouting = { eligibleGrants: { [id]: ["replicate"] }, environmentFallback: false }; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  const pending = [], baseDrain = f.drain;
  f.drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); await baseDrain(); };
  f.request = (body = form(id), { native = true, headers = {}, signal, suffix = "" } = {}) => worker.fetch(new Request(
    `https://router.example/v1/${native ? `native/${id}/v1/audio/transcriptions` : `proxy/${id}/transcription`}${suffix}`, {
      method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", ...headers }, body, signal,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    }), f.env, { waitUntil: promise => pending.push(promise) });
  f.upstream = () => Response.json({ text: "synthetic transcript", model: groqMistralAudio[id].model, usage: { prompt_audio_seconds: 3, input_tokens: 9000, output_tokens: 1000 }, duration: 3 });
  return f;
}
async function settled(f, cost = 700) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, cost);
  assert.equal(events[0].total_tokens, null); assert.equal(bodyBudgetCharged(), 0); return events[0];
}

for (const id of ["groq", "mistral"]) {
  for (const native of [true, false]) for (const pooled of [true, false]) test(`${id} ${native ? "native" : "manifest"} multipart preserves original fields, bytes and ${pooled ? "grant" : "environment"} key`, async t => {
    const f = await setup(t, id, { pooled }); let inspected = false;
    f.upstream = async request => {
      assert.equal(bodyBudgetCharged(), capacity); assert.equal(request.url, groqMistralAudio[id].origin + groqMistralAudio[id].path);
      assert.equal(request.redirect, "manual"); assert.equal(request.headers.get("authorization"), `Bearer synthetic-${pooled ? "original" : "environment"}-key`);
      assert.equal(request.headers.get("accept"), "application/json"); assert.equal(request.headers.has("x-api-key"), false);
      const outgoing = await request.formData(), input = wires[id];
      assert.deepEqual([...outgoing.keys()], [...Object.keys(input.fields), "file"]);
      assert.equal(outgoing.get("model"), groqMistralAudio[id].model);
      const file = outgoing.get("file"); assert.equal(file.name, input.file.name); assert.equal(file.type, input.file.type);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(input.file.base64, "base64")); inspected = true;
      return Response.json({ text: "synthetic transcript", usage: { input_tokens: 999, output_tokens: 999 }, duration: 3 });
    };
    const response = await f.request(form(id, native), { native, headers: { "x-api-key": "synthetic-caller-key" } });
    assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).text, "synthetic transcript");
    assert.equal(inspected, true); assert.equal(f.sent.length, 1);
    const event = await settled(f); assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.provider, id);
  });

  test(`${id} authentication precedes reading and capacity admission`, async t => {
    const f = await setup(t, id); let pulls = 0;
    const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
    const response = await f.request(body, { headers: { authorization: "invalid", "content-type": "bad" } });
    assert.equal(response.status, 401); assert.equal(pulls, 0); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0); await body.cancel();
  });

  for (const revoked of ["caller", "grant", "rotation", "model"]) test(`${id} ${revoked} change during admitted upload denies original-key dispatch`, async t => {
    const f = await setup(t, id), encoded = new Request("https://fixture.example", { method: "POST", body: form(id) });
    const bytes = new Uint8Array(await encoded.arrayBuffer()); let pulled = false;
    const body = new ReadableStream({ async pull(controller) {
      // Capacity is acquired only after the enabled original grant is selected.
      assert.equal(bodyBudgetCharged(), capacity); pulled = true;
      if (revoked === "grant") await revokeGrantCredentials(f.env, grantKey);
      else if (revoked === "rotation") await putGrantCredentials(f.env, grantKey, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-replacement-key" });
      else { f.policy = { ...f.policy, ...(revoked === "caller" ? { enabled: false } : { models: [`${id}/unrelated`] }) }; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
      controller.enqueue(bytes); controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.request(body, { headers: { "content-type": encoded.headers.get("content-type") } });
    assert.ok([401, 403, 409, 503].includes(response.status), await response.text()); assert.equal(pulled, true); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
  });

  for (const bound of ["caller", "provider"]) test(`${id} unknown USD ${bound} budget cannot borrow Chat pricing`, async t => {
    const f = await setup(t, id, { fixed: null });
    if (bound === "provider") { f.policy.monthlyBudgetMicros = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    else await f.authority("/connections/put", { providerId: id, enabled: true, monthlyBudgetMicros: null });
    const response = await f.request(); assert.equal(response.status, 400, await response.clone().text()); assert.equal((await response.json()).error.code, "pricing_required");
    assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
  });

  test(`${id} capacity contention denies before reading or egress`, async t => {
    const f = await setup(t, id), held = new BodyLease(); assert.equal(held.grow(1024 * 1024), true); let pulls = 0;
    const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
    try { const response = await f.request(body, { headers: { "content-type": "multipart/form-data; boundary=x" } }); assert.equal(response.status, 503); assert.equal(pulls, 0); assert.equal(f.sent.length, 0); }
    finally { held.release(); await body.cancel(); }
    assert.equal(bodyBudgetCharged(), 0);
  });

  test(`${id} parser rejects JSON, extra fields, unqualified models and mismatched lengths`, async t => {
    const f = await setup(t, id);
    for (const extra of [{ model: "foreign" }, { stream: "false" }, { response_format: "json" }, ...(id === "mistral" ? [{ prompt: "unqualified" }] : [])]) {
      const response = await f.request(form(id, true, extra)); assert.equal(response.status, 400, await response.text());
    }
    assert.equal((await f.request("{}", { headers: { "content-type": "application/json" } })).status, 400);
    assert.equal((await f.request(form(id), { suffix: "?model=foreign" })).status, 400);
    const encoded = new Request("https://fixture.example", { method: "POST", body: form(id) }), bytes = new Uint8Array(await encoded.arrayBuffer());
    assert.equal((await f.request(bytes, { headers: { "content-type": encoded.headers.get("content-type"), "content-length": String(bytes.length + 1) } })).status, 400);
    assert.equal(f.sent.length, 0); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
  });

  for (const failure of ["http", "redirect", "partial", "invalid", "compressed"]) test(`${id} ${failure} after dispatch retains conservative charge and never retries`, async t => {
    const f = await setup(t, id);
    f.upstream = () => failure === "http" ? new Response("private error", { status: 422 }) : failure === "redirect" ? new Response(null, { status: 302, headers: { location: "https://other.example" } })
      : failure === "partial" ? new Response('{"text":', { headers: { "content-type": "application/json" } })
      : Response.json(failure === "invalid" ? { error: "private error" } : { text: "synthetic" }, { headers: failure === "compressed" ? { "content-encoding": "gzip" } : {} });
    const response = await f.request(); assert.equal(response.status, 502); assert.ok(!(await response.text()).includes("private error")); assert.equal(f.sent.length, 1); await settled(f);
  });

  test(`${id} uploaded bodies have a read-count bound and cancellation releases capacity`, async t => {
    const f = await setup(t, id); let reads = 0, canceled = false;
    const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    const response = await f.request(body, { headers: { "content-type": "multipart/form-data; boundary=x" } });
    assert.equal(response.status, 413); assert.equal(reads, 8192); assert.equal(canceled, true); assert.equal(f.sent.length, 0); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
  });

  test(`${id} pending provider read cancellation has one dispatched settlement`, async t => {
    const f = await setup(t, id), caller = new AbortController(), reached = Promise.withResolvers(); let canceled = false;
    f.upstream = () => new Response(new ReadableStream({ pull() { reached.resolve(); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const pending = f.request(form(id), { signal: caller.signal }); await reached.promise; caller.abort(); const response = await pending;
    assert.equal(response.status, 499); await response.text(); assert.equal(canceled, true); assert.equal(f.sent.length, 1); await settled(f);
  });

  test(`${id} upstream deadline cancels the physical reader and retains dispatched cost`, async t => {
    const f = await setup(t, id); f.provider.endpoints.find(item => item.id === "transcription").timeout_ms = 20;
    let canceled = false;
    f.upstream = () => new Response(new ReadableStream({ pull() {}, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const response = await f.request(); assert.equal(response.status, 504); await response.text();
    assert.equal(canceled, true); assert.equal(f.sent.length, 1); await settled(f);
  });

  test(`${id} caller abort during upload cancels before dispatch and releases capacity`, async t => {
    const f = await setup(t, id), caller = new AbortController(); let canceled = false;
    const body = new ReadableStream({ pull() { assert.equal(bodyBudgetCharged(), capacity); caller.abort(); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    const response = await f.request(body, { signal: caller.signal, headers: { "content-type": "multipart/form-data; boundary=x" } });
    assert.equal(response.status, 400); assert.equal(canceled, true); assert.equal(f.sent.length, 0); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
  });

  test(`${id} delivery EOF or cancellation releases only the request capacity`, async t => {
    const f = await setup(t, id), response = await f.request(); assert.equal(response.status, 200);
    assert.equal(bodyBudgetCharged(), capacity); await response.body.cancel(); await settled(f); assert.equal(f.sent.length, 1);
  });
}

for (const id of ["groq", "mistral"]) for (const mode of ["headers", "abort", "overflow"]) {
  test(`${id} response forwarding joins first source cancel for ${mode}`, { timeout: 5000 }, async t => {
    const { readMultipartResponse } = await import("../transcription-protocol.ts");
    const ready = Promise.withResolvers(), canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
    const abort = new AbortController(); let cancels = 0, complete = false, sent = false;
    const source = new ReadableStream({
      pull(controller) { ready.resolve(); if (mode === "overflow" && !sent) { sent = true; controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); } },
      cancel() { cancels++; abort.abort(); canceled.resolve(); return cleanup.promise; },
    }, { highWaterMark: 0 });
    t.after(() => cleanup.resolve());
    const result = readMultipartResponse({ providerId: id }, new Response(source, {
      status: mode === "headers" ? 502 : 200, headers: { "content-type": "application/json" },
    }), abort.signal).finally(() => { complete = true; });
    const rejected = assert.rejects(result);
    if (mode === "abort") { await ready.promise; abort.abort(); }
    await canceled.promise; await new Promise(setImmediate);
    assert.equal(complete, false); assert.equal(source.locked, true); assert.equal(cancels, 1);
    cleanup.resolve(); await rejected;
    assert.equal(source.locked, false); assert.equal(cancels, 1);
  });
}

for (const id of ["groq", "mistral"]) for (const phase of ["upload", "response"]) for (const first of ["read", "cancel"]) {
  test(`${id} ${phase} public abort keeps physical read, first cleanup and capacity (${first})`, { timeout: 5000 }, async t => {
    const f = await setup(t, id), caller = new AbortController();
    const started = Promise.withResolvers(), readAck = Promise.withResolvers(), cancelAck = Promise.withResolvers(), cancelStarted = Promise.withResolvers();
    let cancels = 0, unlocks = 0, drained = false;
    const source = new ReadableStream({ pull() { started.resolve(); }, async cancel() { cancels++; cancelStarted.resolve(); await cancelAck.promise; } }, { highWaterMark: 0 });
    const acquire = source.getReader.bind(source);
    source.getReader = () => { const reader = acquire(); return {
      async read() { try { return await reader.read(); } finally { await readAck.promise; } },
      cancel: reason => reader.cancel(reason), releaseLock() { unlocks++; reader.releaseLock(); },
    }; };
    if (phase === "response") f.upstream = () => new Response(source, { headers: { "content-type": "application/json" } });
    try {
      const pending = phase === "upload" ? f.request(source, { signal: caller.signal, headers: { "content-type": "multipart/form-data; boundary=x" } })
        : f.request(form(id), { signal: caller.signal });
      await started.promise; caller.abort(new Error("synthetic caller stop"));
      const response = await pending; assert.equal(response.status, phase === "upload" ? 400 : 499); await response.text(); await cancelStarted.promise;
      const retirement = f.drain().then(() => { drained = true; });
      assert.equal(bodyBudgetCharged(), capacity); assert.equal(source.locked, true); assert.equal(cancels, 1);
      const contender = new BodyLease(); assert.equal(contender.grow(1024 * 1024), false); contender.release();
      (first === "read" ? readAck : cancelAck).resolve(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(drained, false); assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), capacity);
      (first === "read" ? cancelAck : readAck).resolve(); await retirement;
      assert.equal(bodyBudgetCharged(), 0); assert.equal(source.locked, false); assert.equal(unlocks, 1); assert.equal(cancels, 1);
      assert.equal(f.sent.length, phase === "upload" ? 0 : 1);
      const events = await f.events(); assert.equal(events.length, phase === "upload" ? 0 : 1);
      if (events.length) assert.equal(events[0].actual_cost_micros, 700);
    } finally { readAck.resolve(); cancelAck.resolve(); }
  });
}

for (const id of ["groq", "mistral"]) test(`${id} late dispatched response stays charged through its first cleanup`, { timeout: 5000 }, async t => {
  const f = await setup(t, id), caller = new AbortController(), started = Promise.withResolvers(), reply = Promise.withResolvers();
  const cancelStarted = Promise.withResolvers(), cleanup = Promise.withResolvers(); let cancels = 0, drained = false;
  f.upstream = () => { started.resolve(); return reply.promise; };
  const source = new ReadableStream({ async cancel() { cancels++; cancelStarted.resolve(); await cleanup.promise; } }, { highWaterMark: 0 });
  try {
    const pending = f.request(form(id), { signal: caller.signal }); await started.promise; caller.abort();
    const response = await pending; assert.equal(response.status, 499); await response.text();
    const retirement = f.drain().then(() => { drained = true; }); assert.equal(bodyBudgetCharged(), capacity);
    reply.resolve(new Response(source, { headers: { "content-type": "application/json" } })); await cancelStarted.promise;
    assert.equal(drained, false); assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), capacity);
    cleanup.resolve(); await retirement;
    assert.equal(source.locked, false); assert.equal(cancels, 1); assert.equal(bodyBudgetCharged(), 0); assert.equal(f.sent.length, 1);
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
  } finally { reply.resolve(new Response(null)); cleanup.resolve(); }
});
