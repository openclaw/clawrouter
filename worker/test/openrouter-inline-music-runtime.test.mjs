import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureMusic, musicBody, musicModels, musicWire } from "./openrouter-music-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { default: worker } = await import("../index.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const MiB = 1024 * 1024;
// The existing offline-decoded 2x2 PNG, not a magic-only byte prefix.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGUlEQVR4nGP8z8Dwn/E/QyMLI8N/IGSsBwA6swYEbMHgjAAAAABJRU5ErkJggg==", "base64");
const nativePath = "/v1/native/openrouter/v1/chat/completions", manifestPath = "/v1/proxy/openrouter/music_generate";
function input(model = musicModels[0], bytes = png, mime = "image/png") {
  const value = musicBody(model);
  value.messages[0].content = [{ type: "text", text: "Synthetic instrumental." },
    { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } }];
  return value;
}
function maximumPng() {
  // A valid ancillary text chunk reaches the exact file-byte bound while
  // retaining the original complete pixel stream. This is container proof.
  const chunk = Buffer.alloc(8 * MiB - png.length, 65);
  chunk.writeUInt32BE(chunk.length - 12); chunk.write("tEXt", 4); chunk.write("Fixture\0", 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}
async function setup(t, options = {}) {
  const provider = structuredClone(snapshot.providers.find(value => value.id === "openrouter")); configureMusic(provider);
  const f = await fixture(t, { pooled: true, ...options, providerId: "openrouter", configure(selected) { Object.assign(selected, provider); } });
  // Node's Request constructor requires duplex for a streamed upload; the
  // actual workerd case exercises the unchanged production fetch separately.
  const fetchFixture = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (request, init) => fetchFixture(request, { ...init, duplex: "half" }));
  f.env.OPENROUTER_API_KEY = "synthetic-environment-key"; f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.rows = () => [...new Set(f.budgetCalls.map(value => value.name))].flatMap(name => f.budgets.get(name).reservations());
  f.request = (body = input(), { manifest = false, ...extra } = {}) => f.call(manifest ? manifestPath : nativePath,
    manifest ? { body: { ...body, model: `openrouter/${body.model}` } } : body, extra);
  f.upstream = async request => {
    f.dispatch = { capacity: bodyBudgetCharged(), rows: f.rows() };
    f.upload = await request.json();
    return new Response(musicWire(f.upload.model), { headers: { "content-type": "text/event-stream" } });
  };
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); });
  return f;
}
async function receipt(f, micros, basis = "policy_fixed") {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  const event = events[0]; assert.equal(event.actual_cost_micros, micros); assert.equal(event.cost_basis, basis);
  assert.equal(event.grant_key, grantKey); assert.equal(event.capability, "music.generate");
  for (const field of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[field], null);
  return event;
}

for (const model of musicModels) for (const manifest of [false, true])
  test(`inline music ${model} ${manifest ? "manifest" : "native"} binds original bytes/key and delivery charges`, async t => {
    const f = await setup(t), body = input(model), response = await f.request(body, { manifest });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), musicWire(model)); assert.deepEqual(f.upload, body);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(f.sent[0].redirect, "manual");
    assert.equal(f.dispatch.capacity, 96 * MiB); assert.equal(f.dispatch.rows.length, 2);
    assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0));
    await receipt(f, 700);
  });

test("full 8 MiB inline container preserves every original byte through common dispatch", async t => {
  const f = await setup(t), image = maximumPng(), expected = createHash("sha256").update(image).digest("hex");
  assert.equal(image.length, 8 * MiB);
  const response = await f.request(input(musicModels[0], image));
  assert.equal(response.status, 200, await response.clone().text()); await response.arrayBuffer();
  const actual = Buffer.from(f.upload.messages[0].content[1].image_url.url.split(",")[1], "base64");
  assert.equal(actual.length, image.length); assert.equal(createHash("sha256").update(actual).digest("hex"), expected);
  assert.equal(f.dispatch.capacity, 96 * MiB); await receipt(f, 700);
});

for (const [mime, encoded] of [
  ["image/jpeg", "/9j//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAGcAAQEAAAAAAAAAAAAAAAAAAAMHAQEBAQAAAAAAAAAAAAAAAAACBAcQAAICAgIDAQAAAAAAAAAAAAIBAwUGBAARdrQ3BxEAAgICAgEFAQEAAAAAAAAAAwIBBAUGAAcRtXaycyI3NP/AABEIAAIAAgMBEgACEgADEgD/2gAMAwEAAhEDEQA/AKFgFVVz4JiksujpyySUNOckh68RmZlowsiIiBsiJvttvtvj/nfz/EfHqX0IOZD2eYtLsrdqtUj1gA2bPBAALSIIRDyVhUGMaTCIiLEKiLEQsR4iOHtj+p757q2H1Szxrr+ByCxcuYnG27VmIsWbNinXMewYv7IYxSDZyEI8yzu8yzNMzM+eWUf8Vb6BfCOf/9k="],
  ["image/webp", "UklGRjQAAABXRUJQVlA4TCcAAAAvAUAAEB8w/wKCIv9HExAU+T+agKDouuWCd0KCmrYNWPwmHRH9jwMA"],
]) test(`inline ${mime} preserves the existing offline-decoded fixture's native spelling and bytes`, async t => {
  const f = await setup(t), body = input(musicModels[0], Buffer.from(encoded, "base64"), mime);
  const response = await f.request(body); assert.equal(response.status, 200, await response.clone().text()); await response.text();
  assert.deepEqual(f.upload, body); await receipt(f, 700);
});

for (const name of ["https", "mime", "container", "forged-digest", "foreign-model", "foreign-origin", "query", "unknown-dollar", "text-rate", "environment-only"])
  test(`inline music rejects ${name} before paid egress`, async t => {
    const f = await setup(t, { pooled: name !== "environment-only", fixed: ["unknown-dollar", "text-rate"].includes(name) ? null : 700 });
    const body = input();
    if (name === "https") body.messages[0].content[1].image_url.url = "https://assets.example/image.png";
    if (name === "mime") body.messages[0].content[1].image_url.url = `data:image/jpeg;base64,${png.toString("base64")}`;
    if (name === "container") body.messages[0].content[1].image_url.url = "data:image/png;base64,AQID";
    if (name === "forged-digest") body.messages[0].content[1].image_url.sha256 = "0".repeat(64);
    if (name === "foreign-model") body.model = "other/model";
    if (name === "foreign-origin") f.provider.base_urls.default = "https://other.example/api";
    if (name === "text-rate") for (const model of f.provider.models.filter(value => musicModels.includes(value.upstream)))
      model.pricing = structuredClone(snapshot.providers.find(value => value.id === "openai").models.find(value => value.pricing).pricing);
    const response = name === "query" ? await f.call(nativePath + "?credential=other", body) : await f.request(body);
    assert.ok(response.status >= 400, await response.text()); assert.equal(f.sent.length, 0);
    await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  });

test("phase contention fails atomically before egress and preserves the competing charge", async t => {
  const f = await setup(t), other = new BodyLease(); assert.equal(other.grow(MiB), true);
  try {
    const response = await f.request(); assert.equal(response.status, 503); await response.text(); await f.drain();
    assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 2 * MiB);
    other.release();
    const accepted = await f.request(); assert.equal(accepted.status, 200); await accepted.text();
    assert.equal(f.sent.length, 1);
  } finally { other.release(); }
});

for (const mutation of ["revoked", "rotated", "policy-model", "caller-disabled"])
  test(`inline music fresh original authority denies ${mutation} during retention`, async t => {
    const f = await setup(t); f.policy.retainRequestContent = true;
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    let retained = 0;
    f.env.CONTENT_ARCHIVE = { async put(_key, body) {
      const record = await new Response(body).json(); assert.equal(record.body.model, musicModels[0]); retained++;
      if (mutation === "revoked" || mutation === "rotated")
        await putGrantCredentials(f.env, grantKey, { provider: "openrouter", kind: "api_key", enabled: mutation !== "revoked", credential: "synthetic-replaced-key" });
      if (mutation === "policy-model") {
        f.policy.models = ["openrouter/foreign/model"];
        await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      }
      if (mutation === "caller-disabled") {
        f.credential.enabled = false;
        await f.authority("/credentials/mutate", { credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
      }
    } };
    const response = await f.request(); assert.ok(response.status >= 400, await response.text());
    assert.equal(retained, 1); assert.equal(f.sent.length, 0); await f.drain();
    assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  });

test("retention consumes the frozen graph before transfer without mutating the paid upload", async t => {
  const f = await setup(t); f.policy.retainRequestContent = true;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  let archived;
  f.env.CONTENT_ARCHIVE = { async put(_key, body) {
    assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 64 * MiB);
    archived = await new Response(body).json();
  } };
  const body = input(), response = await f.request(body);
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get("x-clawrouter-content-retention"), "on; retention-days=30");
  await response.text(); assert.deepEqual(archived.body, body); assert.deepEqual(f.upload, body);
  assert.equal((await receipt(f, 700)).content_retained, true);
});

test("retention refusal before taking the upload reader retires both unclaimed transports", { timeout: 15000 }, async t => {
  const f = await setup(t); f.policy.retainRequestContent = true;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const FixedLength = globalThis.FixedLengthStream, streams = [], cancelCharges = [];
  let canceled, release;
  const cancelEntered = new Promise(resolve => { canceled = resolve; });
  const cleanupAllowed = new Promise(resolve => { release = resolve; });
  t.signal.addEventListener("abort", () => release(), { once: true });
  t.mock.method(globalThis, "FixedLengthStream", function (bytes) {
    const stream = new FixedLength(bytes); streams.push(stream);
    const cancel = stream.readable.cancel.bind(stream.readable);
    t.mock.method(stream.readable, "cancel", async reason => {
      cancelCharges.push(bodyBudgetCharged());
      try { await cancel(reason); } finally { canceled(); await cleanupAllowed; }
    });
    return stream;
  });
  let attempted = 0;
  f.env.CONTENT_ARCHIVE = { async put(_key, body) {
    attempted++; assert.equal(body.locked, false); assert.equal(bodyBudgetCharged(), 64 * MiB);
    throw new Error("synthetic archive refusal before reading");
  } };
  const pending = f.request();
  await cancelEntered;
  // The cleanup promise still owns the charge even after its physical cancel.
  assert.equal(bodyBudgetCharged(), 64 * MiB); assert.equal(f.sent.length, 0);
  release();
  const response = await pending; assert.equal(response.status, 503); await response.text();
  await f.drain(); assert.equal(attempted, 1); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(streams.length, 2); assert.deepEqual(cancelCharges, [64 * MiB, 64 * MiB]);
  for (const stream of streams) {
    assert.equal(stream.readable.locked, false); assert.equal(stream.writable.locked, false);
    assert.equal(stream.readable.cancel.mock.callCount(), 1);
    const reader = stream.readable.getReader();
    // Abort may close or error the stream; neither may retain queued bytes.
    try { assert.equal(await reader.read().then(part => part.done, () => true), true); } finally { reader.releaseLock(); }
  }
  assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
});

test("ordinary shared-path Chat admits concurrent small calls while music capacity is unavailable", { timeout: 15000 }, async t => {
  const f = await setup(t), chat = f.provider.models.find(value => value.capabilities.includes("llm.chat")); assert.ok(chat);
  const held = new BodyLease(); assert.equal(held.grow(40 * MiB), true);
  let release; const barrier = new Promise(resolve => { release = resolve; }); let entered = 0;
  t.signal.addEventListener("abort", () => release(), { once: true });
  f.upstream = async request => {
    const body = await request.json(); assert.equal(body.model, chat.upstream); entered++;
    assert.equal(bodyBudgetCharged(), 80 * MiB); if (entered === 3) release(); await barrier;
    return Response.json({ model: chat.upstream, choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  try {
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.call(nativePath, { model: chat.upstream, messages: [{ role: "user", content: "hello" }] })));
    assert.equal(entered, 3); for (const response of responses) { assert.equal(response.status, 200); await response.text(); }
    assert.equal(f.sent.length, 3); assert.equal(bodyBudgetCharged(), 80 * MiB);
  } finally { release(); held.release(); }
});

test("authentication rejects before any candidate input pull", async t => {
  const f = await setup(t); let reads = 0, canceled = false;
  const body = new ReadableStream({ type: "bytes", pull() { reads++; }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  const response = await worker.fetch(new Request(`https://router.example${nativePath}`, { method: "POST", body, duplex: "half",
    headers: { "content-type": "application/json", authorization: "Bearer invalid" } }), f.env, { waitUntil() {} });
  assert.equal(response.status, 401); await response.text(); assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  await body.cancel(); assert.equal(canceled, true);
});

test("authenticated candidate intake cancellation stops its pending bounded read without paid dispatch", { timeout: 15000 }, async t => {
  const f = await setup(t), controller = new AbortController(); let ready, canceled = 0, chargeAtCancel;
  const entered = new Promise(resolve => { ready = resolve; });
  t.signal.addEventListener("abort", () => controller.abort(), { once: true });
  const body = new ReadableStream({ type: "bytes", pull() { ready(); }, cancel() { canceled++; chargeAtCancel = bodyBudgetCharged(); } }, { highWaterMark: 0 });
  const pendingWork = [];
  const pending = worker.fetch(new Request(`https://router.example${nativePath}`, { method: "POST", body, duplex: "half", signal: controller.signal,
    headers: { "content-type": "application/json", "content-length": String(12 * MiB), authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env,
  { waitUntil(value) { pendingWork.push(value); } });
  await entered; controller.abort(); const response = await pending; assert.ok(response.status >= 400); await response.text();
  await Promise.all(pendingWork); assert.equal(canceled, 1); assert.equal(chargeAtCancel, 24 * MiB);
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("abort during the actual upload keeps both phase charges until reader cancellation", { timeout: 15000 }, async t => {
  const f = await setup(t), controller = new AbortController();
  t.signal.addEventListener("abort", () => controller.abort(), { once: true });
  let ready, cancelCharge, canceled = 0; const entered = new Promise(resolve => { ready = resolve; });
  f.upstream = async request => {
    const reader = request.body.getReader(); await reader.read();
    await new Promise(resolve => {
      request.signal.addEventListener("abort", async () => {
        cancelCharge = bodyBudgetCharged(); await reader.cancel(); canceled++; reader.releaseLock(); resolve();
      }, { once: true }); ready();
    });
    throw request.signal.reason;
  };
  const pending = f.request(input(musicModels[0], maximumPng()), { signal: controller.signal });
  await entered; assert.equal(bodyBudgetCharged(), 96 * MiB); controller.abort();
  const response = await pending; assert.equal(response.status, 502); await response.text();
  assert.equal(cancelCharge, 96 * MiB); assert.equal(canceled, 1); assert.equal(f.sent.length, 1);
  await receipt(f, 700);
});

test("abort during quarantine waits for the pending physical read before releasing response capacity", { timeout: 15000 }, async t => {
  const f = await setup(t), controller = new AbortController();
  t.signal.addEventListener("abort", () => controller.abort(), { once: true });
  let ready, cancelCharge, reads = 0, canceled = 0; const entered = new Promise(resolve => { ready = resolve; });
  f.upstream = async request => {
    await request.json();
    const body = new ReadableStream({ type: "bytes", pull(stream) {
      reads++;
      if (reads === 1) stream.enqueue(new TextEncoder().encode('data: {'));
      else ready();
    }, cancel() { cancelCharge = bodyBudgetCharged(); canceled++; } }, { highWaterMark: 0 });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const pending = f.request(undefined, { signal: controller.signal });
  await entered; assert.equal(bodyBudgetCharged(), 96 * MiB); controller.abort();
  const response = await pending; assert.equal(response.status, 502); await response.text();
  assert.equal(canceled, 1); assert.equal(cancelCharge, 96 * MiB); assert.equal(f.sent.length, 1);
  await receipt(f, 700);
});

test("abort during retention remains charged until the actual archive owner returns, with zero paid fetch", { timeout: 15000 }, async t => {
  const f = await setup(t), controller = new AbortController(); f.policy.retainRequestContent = true;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  let ready, release; const entered = new Promise(resolve => { ready = resolve; }), finish = new Promise(resolve => { release = resolve; });
  t.signal.addEventListener("abort", () => { controller.abort(); release(); }, { once: true });
  f.env.CONTENT_ARCHIVE = { async put(_key, body) { await new Response(body).arrayBuffer(); ready(); await finish; } };
  const pending = f.request(undefined, { signal: controller.signal });
  await entered; controller.abort(); assert.equal(bodyBudgetCharged(), 64 * MiB); assert.equal(f.sent.length, 0);
  release(); const response = await pending; assert.equal(response.status, 503); await response.text(); await f.drain();
  assert.equal(f.sent.length, 0); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
});

test("downstream cancellation retires response replay once without refund or repeated paid fetch", async t => {
  const f = await setup(t), response = await f.request(); assert.equal(response.status, 200);
  // This is direct Worker production, before a host transport can prefetch EOF.
  // No assertion equates unread host-side bytes with an active Worker owner.
  assert.equal(bodyBudgetCharged(), 96 * MiB);
  await response.body.cancel(); assert.equal(f.sent.length, 1); await receipt(f, 700);
});

for (const change of ["grant", "model-policy", "caller"])
  test(`inline music withholds quarantined output after ${change} revocation without refund`, async t => {
    const f = await setup(t);
    f.upstream = async request => {
      const body = await request.json();
      if (change === "grant") await putGrantCredentials(f.env, grantKey,
        { provider: "openrouter", kind: "api_key", enabled: false, credential: "synthetic-original-key" });
      if (change === "model-policy") {
        f.policy.models = ["openrouter/unrelated"];
        await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      }
      if (change === "caller") await f.authority("/credentials/mutate", {
        credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" },
      });
      return new Response(musicWire(body.model), { headers: { "content-type": "text/event-stream" } });
    };
    const response = await f.request(); assert.equal(response.status, 502); const error = await response.text();
    assert.ok(!error.includes('"audio"')); assert.equal(f.sent.length, 1); await receipt(f, 700);
  });

for (const change of ["revoke", "rotate", "models", "foreign-grant", "owner-unavailable", "retention-policy", "monetary-policy"])
  test(`warm inline admission rechecks original ${change} after the final budget await`, async t => {
    const f = await setup(t);
    f.policy.grantRouting = { eligibleGrants: { openrouter: ["replicate"] }, environmentFallback: true, failover: true };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 });
    t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
    const warm = await f.request(); assert.equal(warm.status, 200); await warm.text(); await f.drain();
    assert.equal(f.sent.length, 1);
    const namespace = f.env.BUDGET_LEDGER; let changed = false;
    f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
      const response = await namespace.get(name).fetch(url, init);
      if (!changed && new URL(url).pathname === "/dispatch") {
        changed = true;
        if (change === "revoke" || change === "rotate")
          await putGrantCredentials(f.env, grantKey, { provider: "openrouter", kind: "api_key", enabled: change !== "revoke", credential: "synthetic-rotated-key" });
        if (["models", "foreign-grant", "retention-policy", "monetary-policy"].includes(change)) {
          if (change === "models") f.policy.models = ["openrouter/unrelated"];
          if (change === "foreign-grant") f.policy.grantRouting = { eligibleGrants: { openrouter: ["foreign"] }, environmentFallback: true, failover: true };
          if (change === "retention-policy") f.policy.retainRequestContent = true;
          if (change === "monetary-policy") f.policy.requestCostMicros = null;
          await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
        }
        if (change === "owner-unavailable") f.env.GRANT_CREDENTIALS = { idFromName: name => name, get: () => ({ fetch: async () => new Response("unavailable", { status: 503 }) }) };
      }
      return response;
    } }) };
    const response = await f.request(); assert.equal(changed, true); assert.ok(response.status >= 400, await response.text());
    assert.equal(f.sent.length, 1); await f.drain();
    const events = await f.events(); assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.actual_cost_micros).sort((a, b) => a - b), [0, 700]);
  });
