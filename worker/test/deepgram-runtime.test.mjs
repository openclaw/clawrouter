import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
import { accessBytesResponse } from "./access-byte-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { providerById } = await import("../providers.ts");
const { operationAffordability } = await import("../operation-budget.ts");
const { transcriptionLimits } = await import("../transcription-body.ts");
const { deepgramAudioLimit } = await import("../deepgram-prerecorded.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepgram/prerecorded.json", import.meta.url), "utf8"));
const audio = new Uint8Array(Buffer.from(wire.request.base64, "base64"));
const native = "/v1/native/openai/v1/listen", manifest = "/v1/proxy/openai/listen";
const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];

async function syntheticIdentityJson(response) {
  const body = response.body, decoder = new TextDecoder(), cleanup = [];
  let reader, text = "", value, hasPrimary = false, primary;
  try {
    reader = body.getReader({ mode: "byob" });
    for (;;) {
      const next = await reader.read(new Uint8Array(16 * 1024));
      if (next.value?.byteLength) text += decoder.decode(next.value, { stream: true });
      if (next.done) break;
    }
    value = JSON.parse(text + decoder.decode());
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    if (hasPrimary) {
      try { await (reader ? reader.cancel(primary) : body?.cancel(primary)); } catch (error) { cleanup.push(error); }
    }
    try { reader?.releaseLock(); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError(hasPrimary ? [primary, ...cleanup] : cleanup, "synthetic identity reply cleanup failed");
  if (hasPrimary) throw primary;
  return value;
}

function fixture(t, options = {}) {
  // Exercise dispatch by format before source-owned YAML/snapshot activation.
  const provider = providerById("openai"), original = structuredClone(provider);
  t.after(() => { Object.keys(provider).forEach(key => delete provider[key]); Object.assign(provider, original); });
  const endpoint = { ...structuredClone(provider.endpoints.find(e => e.id === "transcriptions")), id: "listen", path: "/v1/listen", request_format: "deepgram.prerecorded", response_format: "deepgram.prerecorded", query: {}, native_proxy: true };
  const model = { ...structuredClone(provider.models.find(m => m.id === "openai/gpt-4o-transcribe")), id: "openai/nova-3", upstream: "nova-3", capabilities: ["audio.transcription"], pricing: null, pricing_ref: null };
  provider.endpoints = [endpoint]; provider.models = [model];
  provider.capabilities = [{ id: "audio.transcription", endpoint: "listen", methods: ["POST"] }];
  provider.base_urls = { default: "https://api.deepgram.com" };
  provider.auth.schemes = [{ type: "bearer", header: "Authorization", format: "Token ${secret}", secretKind: "api_key" }];
  const env = usageEnv([], { limit: 1_000_000, fixedCost: 200, retainContent: false, ...options });
  const events = [], pending = [], admissions = [], ledger = sqlBudgetNamespace(t), originalGet = env.ACCESS_CONTROL.get;
  let edit = value => value;
  env.ACCESS_CONTROL.get = (...args) => { const stub = originalGet(...args); return { fetch: async (url, init) => {
    const response = await stub.fetch(url, init);
    const marked = new Headers(init?.headers).has("x-clawrouter-identity-admission");
    const value = marked ? await syntheticIdentityJson(response) : await response.json();
    if (new URL(url).pathname === "/admission/resolve") admissions.push(JSON.parse(init.body));
    return marked ? accessBytesResponse(JSON.stringify(edit(value)), response.url, { status: response.status, headers: response.headers }) : Response.json(edit(value));
  } }; };
  env.BUDGET_LEDGER = ledger; env.OPENAI_API_KEY = "synthetic-original-key";
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  env.CONTENT_ARCHIVE = { put: async () => { throw new Error("raw audio must not be retained"); } };
  const call = (body = audio, { path = native, query = new URLSearchParams(wire.request.query), headers = {}, signal } = {}) => handler.fetch(new Request("https://router.example" + path + (query.size ? "?" + query : ""), {
    method: "POST", headers: { authorization: "Bearer " + proxyKey(), "content-type": wire.request.contentType, ...headers }, body, signal, ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  }), env, { waitUntil: promise => pending.push(promise) });
  return { env, provider, endpoint, model, ledger, events, pending, admissions, call, editAuthority(fn) { edit = fn; } };
}

for (const path of [native, manifest]) test("raw native audio keeps bytes, repeated query, original credential and durable fixed accounting: " + path, async t => {
  const f = fixture(t), responseBytes = new TextEncoder().encode(JSON.stringify(wire.response));
  const upstream = t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input); assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen");
    assert.deepEqual([...url.searchParams], wire.request.query);
    assert.deepEqual(init.body, audio); assert.equal(init.redirect, "manual");
    assert.equal(init.headers.get("authorization"), "Token synthetic-original-key");
    assert.equal(init.headers.has("x-api-key"), false); assert.equal(init.headers.has("content-length"), false);
    assert.equal(init.headers.get("content-type"), wire.request.contentType);
    return new Response(responseBytes, { headers: { "content-type": "application/json", "set-cookie": "synthetic-private-cookie" } });
  });
  const response = await f.call(audio, { path, headers: { "x-api-key": "synthetic-caller-key", "content-length": String(audio.length) } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), responseBytes);
  assert.equal(response.headers.has("set-cookie"), false); assert.equal(response.headers.get("x-clawrouter-accounting"), "policy-fixed");
  await Promise.all(f.pending); assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events.length, 1);
  const event = f.events[0]; assert.equal(event.actual_cost_micros, 200); assert.equal(event.cost_basis, "policy_fixed");
  assert.equal(event.total_tokens, null); assert.equal(event.model, "openai/nova-3"); assert.equal(event.content_retained, false);
  assert.ok(!JSON.stringify(event).includes("synthetic")); assert.equal(f.admissions[0].selection, undefined); assert.equal(f.admissions[1].selection.model, "nova-3");
  for (const name of owners) { const [row] = f.ledger.get(name).reservations(); assert.equal(row.dispatch_started, 1); assert.equal(row.settled, 1); assert.equal(row.reserved_micros, 200); }
});

test("raw upload authenticates before any reader or invalid MIME/length check", async t => {
  const f = fixture(t); let reads = 0;
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const response = await f.call(body, { headers: { authorization: "invalid", "content-type": "bad", "content-length": String(deepgramAudioLimit + 1) } });
  assert.equal(response.status, 401); assert.equal(reads, 0); assert.equal(f.events.length, 0); await body.cancel();
});

for (const path of [native, manifest]) {
  test("Nova-3 rejects legacy keywords before dispatch: " + path, async t => {
    const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unsupported keywords escaped"); });
    for (const query of ["keywords=synthetic", "model=nova-3&keyterm=valid&keywords=invalid"]) {
      const response = await f.call(audio, { path, query: new URLSearchParams(query) });
      await response.text(); assert.equal(response.status, 400);
    }
    await Promise.all(f.pending); assert.equal(upstream.mock.callCount(), 0); assert.equal(f.events.length, 0);
    for (const name of owners) assert.equal(f.ledger.get(name).reservations().length, 0);
  });

  for (const bound of ["entries", "serialized"]) test("Nova-3 bounds the final query including default model: " + path + " " + bound, async t => {
    const f = fixture(t);
    const serializedPairs = size => {
      const pairs = Array.from({ length: size > 9000 ? 9 : 5 }, () => ["keyterm", "x".repeat(size > 9000 ? 1800 : 1600)]);
      pairs.at(-1)[1] += "x".repeat(size - new URLSearchParams([...pairs, ["model", "nova-3"]]).toString().length);
      assert.ok(pairs.every(([, value]) => value.length <= 2048), "vendor-valid keyterms");
      return pairs;
    };
    const pairs = bound === "entries" ? Array.from({ length: 127 }, (_, i) => ["keyterm", "term" + i]) : serializedPairs(8192);
    const query = new URLSearchParams(pairs), expected = [...pairs, ["model", "nova-3"]];
    const upstream = t.mock.method(globalThis, "fetch", async (input, init) => {
      const outgoing = new URL(input).searchParams;
      assert.deepEqual([...outgoing], expected); assert.deepEqual(init.body, audio);
      assert.equal(bound === "entries" ? outgoing.size : outgoing.toString().length, bound === "entries" ? 128 : 8192);
      assert.equal(init.headers.get("authorization"), "Token synthetic-original-key");
      return Response.json(wire.response);
    });
    const response = await f.call(audio, { path, query, headers: { "x-request-id": "query-success" } });
    assert.deepEqual(await response.json(), wire.response); assert.equal(response.status, 200);
    assert.equal(query.has("model"), false); await Promise.all(f.pending);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].request_id, "query-success");
    assert.equal(f.events[0].actual_cost_micros, 200); assert.equal(f.events[0].cost_basis, "policy_fixed"); assert.equal(f.events[0].total_tokens, null);
    const original = owners.map(name => f.ledger.get(name).reservations());
    for (const rows of original) { assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].dispatch_started, 1); assert.equal(rows[0].reserved_micros, 200); assert.ok(rows[0].reservation_id); }
    if (bound === "entries") {
      query.append("keyterm", "overflow");
      const denied = await f.call(audio, { path, query }); await denied.text(); assert.equal(denied.status, 400);
      await Promise.all(f.pending); assert.equal(f.events.length, 1);
    } else {
      // The vendor's 16 KiB allowance remains valid; selected preparation is
      // intentionally tighter. Neither denial reserves or dispatches anything.
      for (const size of [8193, 16384]) {
        const requestId = "query-capacity-" + size;
        const denied = await f.call(audio, { path, query: new URLSearchParams(serializedPairs(size)), headers: { "x-request-id": requestId } });
        assert.equal((await denied.json()).error.code, "provider_preparation_unavailable"); assert.equal(denied.status, 503);
        await Promise.all(f.pending);
        const event = f.events.at(-1); assert.equal(event.request_id, requestId); assert.equal(event.status_code, 503);
        assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0); assert.equal(event.cost_basis, "none"); assert.equal(event.total_tokens, null);
        assert.equal(upstream.mock.callCount(), 1);
        owners.forEach((name, index) => assert.deepEqual(f.ledger.get(name).reservations(), original[index], "same successful reservation IDs and charges"));
      }
      const invalid = await f.call(audio, { path, query: new URLSearchParams(serializedPairs(16385)) });
      assert.equal((await invalid.json()).error.code, "transcription_option_unsupported"); assert.equal(invalid.status, 400);
      await Promise.all(f.pending); assert.equal(f.events.length, 3); assert.equal(new Set(f.events.map(event => event.id)).size, 3);
    }
    assert.equal(upstream.mock.callCount(), 1);
    owners.forEach((name, index) => assert.deepEqual(f.ledger.get(name).reservations(), original[index]));
  });
}

test("raw input rejects callbacks, URL substitution, injected credentials, unknown models and malformed lengths before egress", async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("invalid upload escaped"); });
  for (const query of ["callback=https://callback.example", "url=https://audio.example", "token=synthetic", "model=flux-general-en", "model=nova-3&model=nova-3", "channels=0"]) {
    assert.equal((await f.call(audio, { query: new URLSearchParams(query) })).status, 400);
  }
  for (const headers of [{ "content-type": "application/json" }, { "content-encoding": "gzip" }, { "content-length": "-1" }, { "content-length": "9007199254740992" }, { "content-length": String(audio.length + 1) }]) assert.equal((await f.call(audio, { headers })).status, 400);
  assert.equal((await f.call(new Uint8Array())).status, 400);
  assert.equal((await f.call(audio, { headers: { "content-length": String(deepgramAudioLimit + 1) } })).status, 413);
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.events.length, 0);
});

test("chunked audio is bounded and its reader canceled without egress", async t => {
  const f = fixture(t); let pulls = 0, canceled = 0;
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("oversize escaped"); });
  const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(1_000_000)); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  assert.equal((await f.call(body)).status, 413); assert.equal(pulls, 26); assert.equal(canceled, 1); assert.equal(upstream.mock.callCount(), 0);
});

for (const cause of ["deadline", "cancel"]) test("raw upload " + cause + " stops reading before admission/dispatch", async t => {
  const f = fixture(t), caller = new AbortController(); let canceled = 0;
  const oldReadMs = transcriptionLimits.readMs; transcriptionLimits.readMs = 5; t.after(() => { transcriptionLimits.readMs = oldReadMs; });
  const body = new ReadableStream({ pull() { if (cause === "cancel") caller.abort(); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const response = await f.call(body, { signal: caller.signal });
  assert.equal(response.status, cause === "deadline" ? 408 : 400); assert.equal(canceled, 1); assert.equal(f.admissions.length, 1); assert.equal(f.events.length, 0);
});

for (const scenario of ["capability", "stream", "lifecycle", "query", "passthrough"]) test("raw format requires a qualified synchronous declaration: " + scenario, async t => {
  const f = fixture(t);
  if (scenario === "capability") f.provider.capabilities = [{ id: "audio.other", endpoint: "listen", methods: ["POST"] }];
  if (scenario === "stream") f.endpoint.streaming = "sse";
  if (scenario === "lifecycle") f.endpoint.lifecycle = { protocol: "replicate.predictions", retrieve: "listen" };
  if (scenario === "query") f.endpoint.query = { callback: "https://callback.example" };
  if (scenario === "passthrough") f.endpoint.modelPassthrough = {};
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unqualified route escaped"); });
  const response = await f.call(); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "transcription_route_unsupported");
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.events.length, 0);
});

for (const scenario of ["model-missing", "model-denied", "policy-revoked", "credential-revoked", "grant-denied"]) test("raw upload re-admission closes " + scenario + " before egress", async t => {
  const f = fixture(t); if (scenario === "model-missing") f.provider.models = [];
  f.editAuthority(value => {
    if (f.admissions.length > 1) {
      if (scenario === "model-denied") value.policy.policy.models = ["openai/other"];
      if (scenario === "policy-revoked") value.policy.policy.enabled = false;
      if (scenario === "credential-revoked") value.credential.credential.enabled = false;
      if (scenario === "grant-denied") value.selection = { selected: null, hasConfiguredGrant: true };
    } return value;
  });
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("revoked upload escaped"); });
  const response = await f.call(); assert.ok([400, 401, 403, 503].includes(response.status), await response.text()); assert.equal(upstream.mock.callCount(), 0);
});

for (const path of [native, manifest]) for (const revoked of ["policy", "credential"]) test(`raw post-upload ${revoked} check bypasses warm admission: ${path}`, async t => {
  overrideHotCacheConfig({ maxAgeMs: 60_000, freshMs: 60_000 });
  t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => Response.json(wire.response));
  const first = await f.call(audio, { path });
  assert.equal(first.status, 200, await first.clone().text()); await first.arrayBuffer(); await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events.length, 1);
  assert.ok(f.admissions.some(value => value.selection?.model === "nova-3"));
  const before = f.admissions.length; let reads = 0;
  // The first complete Worker request established the warm admission. HWM0
  // prevents producer prefetch; revoke only when the authenticated reader pulls.
  const body = new ReadableStream({ pull(controller) {
    reads++;
    f.editAuthority(value => {
      if (value.policy && revoked === "policy") value.policy.policy.enabled = false;
      if (value.credential && revoked === "credential") value.credential.credential.enabled = false;
      return value;
    });
    controller.enqueue(audio); controller.close();
  } }, { highWaterMark: 0 });
  const denied = await f.call(body, { path });
  assert.ok([401, 403].includes(denied.status), await denied.text());
  await Promise.all(f.pending);
  assert.equal(reads, 1); assert.equal(f.admissions.length, before + 1);
  assert.equal(f.admissions.at(-1).selection.model, "nova-3");
  assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].actual_cost_micros, 200);
  for (const name of owners) assert.equal(f.ledger.get(name).reservations().length, 1);
});

for (const bound of ["policy", "provider", "daily", "weekly"]) test("unknown whole-upload cost denies " + bound + " hard budget and discovery", async t => {
  const f = fixture(t, { limit: bound === "policy" ? 1_000_000 : null, providerLimit: bound === "provider" ? 1_000_000 : null, fixedCost: null, dailyLimit: bound === "daily" ? 1_000_000 : undefined, weeklyLimit: bound === "weekly" ? 1_000_000 : undefined });
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unpriced upload escaped"); });
  const response = await f.call(); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required"); assert.equal(upstream.mock.callCount(), 0);
  const policy = { monthlyBudgetMicros: bound === "policy" ? 1_000_000 : null, requestCostMicros: null, dailyBudgetMicros: bound === "daily" ? 1_000_000 : null, weeklyBudgetMicros: bound === "weekly" ? 1_000_000 : null };
  assert.deepEqual(operationAffordability({ policy }, { monthlyBudgetMicros: bound === "provider" ? 1_000_000 : null }, f.model, "audio.transcription", f.endpoint), { status: "exact-blocked", reasonCode: "pricing_required" });
});

for (const mode of ["unmetered", "soft"]) test("duration and channel diagnostics remain unknown dollars/tokens in " + mode + " mode", async t => {
  const f = fixture(t, { limit: mode === "soft" ? 1_000_000 : null, providerLimit: mode === "soft" ? 1_000_000 : null, fixedCost: null, budgetMode: mode === "soft" ? "soft" : "reserve" });
  t.mock.method(globalThis, "fetch", async () => Response.json(wire.response));
  const response = await f.call(); assert.equal(response.status, 200); await Promise.all(f.pending);
  assert.equal(response.headers.get("x-clawrouter-accounting"), "unpriced-usage"); assert.equal(f.events[0].cost_basis, "unpriced_usage"); assert.equal(f.events[0].total_tokens, null);
  assert.equal(f.events[0].actual_cost_micros, 0, "numeric storage placeholder remains explicitly unknown, never a free tariff");
});

for (const scenario of ["partial-track", "native-error", "invalid-utf8", "truncated-length", "wrong-mime", "fetch-error", "redirect", "rejection429"]) test("raw response " + scenario + " never replays or delivers incomplete tracks", async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => {
    if (scenario === "fetch-error") throw new Error("synthetic dispatch uncertainty");
    if (scenario === "redirect") return new Response("redirect", { status: 307, headers: { location: "https://not-followed.example" } });
    if (scenario === "rejection429") return Response.json({ error: "synthetic rejection" }, { status: 429 });
    if (scenario === "invalid-utf8") return new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } });
    const value = structuredClone(wire.response);
    if (scenario === "partial-track") value.results.channels.push({ alternatives: [{}] });
    if (scenario === "native-error") value.err_code = "INSUFFICIENT_PERMISSIONS";
    return Response.json(value, { headers: { ...(scenario === "wrong-mime" ? { "content-type": "text/plain" } : {}), ...(scenario === "truncated-length" ? { "content-length": "100000" } : {}) } });
  });
  const response = await f.call(); assert.equal(response.status, scenario === "rejection429" ? 429 : 502); assert.equal(upstream.mock.callCount(), 1);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, scenario === "rejection429" ? 0 : 200); assert.equal(f.events[0].cost_basis, scenario === "rejection429" ? "none" : "policy_fixed");
  for (const name of owners) assert.equal(f.ledger.get(name).reservations()[0].settled, 1);
});

test("dispatch acknowledgement failure prevents raw upload and refunds reservations", async t => {
  const f = fixture(t), get = f.ledger.get.bind(f.ledger);
  f.env.BUDGET_LEDGER = { idFromName: x => x, get(name) { const stub = get(name); return { fetch: (url, init) => new URL(url).pathname === "/dispatch" ? Response.json({ dispatched: false }) : stub.fetch(url, init) }; } };
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("dispatch ACK failure escaped"); });
  assert.equal((await f.call()).status, 503); await Promise.all(f.pending); assert.equal(upstream.mock.callCount(), 0);
  for (const name of owners) { const [row] = get(name).reservations(); assert.equal(row.settled, 1); assert.equal(row.reserved_micros, 0); }
});

test("raw response cancellation after dispatch retains one fixed settlement and cancels the reader", async t => {
  const f = fixture(t), caller = new AbortController(); let canceled = 0;
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull() { caller.abort(); }, cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }));
  assert.equal((await f.call(audio, { signal: caller.signal })).status, 499); await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1); assert.equal(canceled, 1); assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 200); assert.equal(f.events[0].status, "client_error");
});

for (const path of ["/v1/native/deepgram/v1/listen", "/v1/proxy/deepgram/listen"]) test("shipped Deepgram declaration dispatches raw audio under its real policy identity: " + path, async t => {
  const provider = providerById("deepgram"); assert.ok(provider, "integration must compile the source-owned Deepgram declaration before activation");
  const model = provider.models.find(item => item.id === "deepgram/nova-3"); assert.equal(model?.upstream, "nova-3"); assert.equal(model.pricing, null);
  const env = usageEnv([], { provider: "deepgram", limit: 1_000_000, fixedCost: 200, retainContent: false }), events = [], pending = [];
  env.DEEPGRAM_API_KEY = "synthetic-original-key"; env.BUDGET_LEDGER = sqlBudgetNamespace(t); env.USAGE_QUEUE = { send: async event => events.push(event) };
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.deepgram.com/v1/listen?model=nova-3"); assert.equal(init.headers.get("authorization"), "Token synthetic-original-key"); assert.deepEqual(init.body, audio);
    return Response.json(wire.response);
  });
  const response = await handler.fetch(new Request("https://router.example" + path, { method: "POST", headers: { authorization: "Bearer " + proxyKey(), "content-type": wire.request.contentType }, body: audio }), env, { waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), wire.response); await Promise.all(pending);
  assert.equal(upstream.mock.callCount(), 1); assert.equal(events.length, 1); assert.equal(events[0].provider, "deepgram"); assert.equal(events[0].model, "deepgram/nova-3"); assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
  for (const name of ["tenant:maintainer_access:owner@example.com", "provider:deepgram"]) { const [row] = env.BUDGET_LEDGER.get(name).reservations(); assert.equal(row.dispatch_started, 1); assert.equal(row.settled, 1); }
});
