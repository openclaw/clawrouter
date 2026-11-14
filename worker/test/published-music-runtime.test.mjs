import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureMusic, musicBody, musicModels, musicWire } from "./openrouter-music-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { default: worker } = await import("../index.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED } = await import("../hot-cache.ts");
const MiB = 1024 * 1024;
const publicationPath = "/v1/input-assets/openrouter/music";
const nativePath = "/v1/native/openrouter/v1/chat/completions", manifestPath = "/v1/proxy/openrouter/music_generate";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGUlEQVR4nGP8z8Dwn/E/QyMLI8N/IGSsBwA6swYEbMHgjAAAAABJRU5ErkJggg==", "base64"));
function input(model = musicModels[0], url = `data:image/png;base64,${Buffer.from(png).toString("base64")}`) {
  const body = musicBody(model);
  body.messages[0].content = [{ type: "text", text: "Synthetic instrumental." }, { type: "image_url", image_url: { url } }];
  return body;
}
function byteStream(bytes) {
  let offset = 0;
  return new ReadableStream({ type: "bytes", pull(controller) {
    if (offset === bytes.length) { controller.close(); controller.byobRequest?.respond(0); return; }
    const end = Math.min(bytes.length, offset + 1024); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }, { highWaterMark: 0 });
}
async function setup(t, options = {}) {
  const provider = structuredClone(snapshot.providers.find(value => value.id === "openrouter")); configureMusic(provider);
  const f = await fixture(t, { pooled: true, ...options, providerId: "openrouter", configure(value) { Object.assign(value, provider); } });
  f.env.CLAWROUTER_PUBLIC_ORIGIN = "https://router.example"; f.env.OPENROUTER_API_KEY = "synthetic-environment-key";
  f.env.OPENROUTER_SITE_URL = "https://example.com";
  f.policy.inputPublication = { version: "clawrouter.input-publication.v1", allow: musicModels.map(model => ({
    providerId: "openrouter", endpointId: "music_generate", modelId: `openrouter/${model}`,
    publish: true, forward: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  })) };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.objects = new Map(); f.puts = 0; f.gets = 0;
  f.env.CONTENT_ARCHIVE = {
    async put(key, stream, options) {
      f.puts++; assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 64 * MiB);
      assert.equal(options.onlyIf.get("if-none-match"), "*"); assert.equal(f.objects.has(key), false);
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const object = { key, version: "fixture-object-version", etag: "fixture-object-etag", size: bytes.length,
        checksums: { sha256: await crypto.subtle.digest("SHA-256", bytes) }, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata };
      assert.deepEqual(object.checksums.sha256, options.sha256);
      f.objects.set(key, { bytes, object }); return object;
    },
    async get(key, options) {
      f.gets++; const value = f.objects.get(key); if (!value) return null;
      assert.equal(options.onlyIf.etagMatches, value.object.etag);
      return { ...value.object, body: byteStream(value.bytes) };
    },
  };
  f.rows = () => [...new Set(f.budgetCalls.map(value => value.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = async request => {
    f.dispatch = { charge: bodyBudgetCharged(), rows: f.rows() }; f.upload = await request.json();
    return new Response(byteStream(new TextEncoder().encode(musicWire(f.upload.model))), { headers: { "content-type": "text/event-stream" } });
  };
  f.publish = (body = input(), id = "fixture-publication", extra = {}) => f.call(publicationPath, body,
    { ...extra, headers: { "idempotency-key": id, ...extra.headers } });
  f.issued = async (body = input(), id) => {
    const response = await f.publish(body, id); assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json(); assert.match(result.url, /^https:\/\/router\.example\/v1\/input-assets\/[a-f0-9]{64}\/asset_[a-f0-9]{32}\/[a-f0-9]{64}$/);
    return result;
  };
  f.forward = (url, { model = musicModels[0], manifest = false, body = input(model, url), ...extra } = {}) =>
    f.call(manifest ? manifestPath : nativePath, manifest ? { body: { ...body, model: `openrouter/${model}` } } : body, extra);
  f.get = (url, extra = {}) => worker.fetch(new Request(url, extra), f.env, { waitUntil: () => {} });
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); });
  return f;
}
async function charge(f, micros) {
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, micros); assert.equal(events[0].grant_key, grantKey);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
}

for (const model of musicModels) for (const manifest of [false, true])
  test(`published music ${model} ${manifest ? "manifest" : "native"} binds archive, original key and one paid attempt`, async t => {
    const f = await setup(t), issued = await f.issued(input(model));
    assert.equal(f.sent.length, 0); assert.equal(f.puts, 1); assert.equal(bodyBudgetCharged(), 0);
    const asset = await f.get(issued.url); assert.equal(asset.status, 200); assert.equal(bodyBudgetCharged(), 16 * MiB);
    assert.equal(asset.headers.get("content-type"), "image/png"); assert.equal(asset.headers.has("access-control-allow-origin"), false);
    assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), png); assert.equal(bodyBudgetCharged(), 0);
    const response = await f.forward(issued.url, { model, manifest }); assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), musicWire(model)); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(f.sent[0].redirect, "manual");
    assert.equal(f.sent[0].url, "https://openrouter.ai/api/v1/chat/completions"); assert.equal(f.upload.messages[0].content[1].image_url.url, issued.url);
    assert.equal(f.dispatch.charge, 80 * MiB); assert.equal(f.dispatch.rows.length, 2);
    assert.ok(f.dispatch.rows.every(row => row.dispatch_started === 1 && row.settled === 0)); await charge(f, 700);
    const retry = await f.forward(issued.url, { model, manifest }); assert.ok(retry.status >= 400); await retry.text(); assert.equal(f.sent.length, 1);
    f.restart(); const restarted = await f.forward(issued.url, { model, manifest }); assert.ok(restarted.status >= 400); await restarted.text(); assert.equal(f.sent.length, 1);
  });

for (const invalid of ["absent", "publish-false", "forward-false", "expired", "environment", "foreign-model", "url", "mime", "query"])
  test(`publication ${invalid} has zero archive and provider egress`, async t => {
    const f = await setup(t, { pooled: invalid !== "environment" }), body = input();
    if (invalid === "absent") delete f.policy.inputPublication;
    if (invalid === "publish-false") f.policy.inputPublication.allow[0].publish = false;
    if (invalid === "forward-false") f.policy.inputPublication.allow[0].forward = false;
    if (invalid === "expired") f.advance(3600_001);
    if (invalid === "foreign-model") body.model = "google/foreign";
    if (invalid === "url") body.messages[0].content[1].image_url.url = "https://foreign.example/image.png";
    if (invalid === "mime") body.messages[0].content[1].image_url.url = `data:image/jpeg;base64,${Buffer.from(png).toString("base64")}`;
    if (["absent", "publish-false", "forward-false"].includes(invalid)) await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    const response = invalid === "query" ? await f.call(publicationPath + "?model=other", body, { headers: { "idempotency-key": "fixture" } }) : await f.publish(body);
    assert.ok(response.status >= 400, await response.text()); assert.equal(f.puts, 0); assert.equal(f.sent.length, 0);
  });

test("publication authenticates before body reads and leaves no archive attempt", async t => {
  const f = await setup(t); let reads = 0, canceled = 0;
  const body = new ReadableStream({ pull() { reads++; }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const response = await worker.fetch(new Request("https://router.example" + publicationPath,
    { method: "POST", duplex: "half", headers: { "content-type": "application/json", "idempotency-key": "fixture" }, body }), f.env, { waitUntil() {} });
  assert.equal(response.status, 401); assert.equal(reads, 0); assert.equal(canceled, 1); assert.equal(f.puts, 0);
});

test("same idempotency key cannot replace an acknowledged URL or image", async t => {
  const f = await setup(t); await f.issued();
  const response = await f.publish(); assert.equal(response.status, 409); await response.text(); assert.equal(f.puts, 1);
  const body = input(); body.messages[0].content[0].text = "Changed request.";
  const changed = await f.publish(body); assert.equal(changed.status, 409); await changed.text(); assert.equal(f.puts, 1); assert.equal(f.sent.length, 0);
});

for (const phase of ["after-claim", "after-put"])
  test(`revocation ${phase} withholds publication without resetting its claim`, async t => {
    const f = await setup(t);
    if (phase === "after-put") {
      const put = f.env.CONTENT_ARCHIVE.put;
      f.env.CONTENT_ARCHIVE.put = async (...args) => { const result = await put(...args);
        await putGrantCredentials(f.env, grantKey, { provider: "openrouter", kind: "api_key", enabled: false, credential: "synthetic-original-key" }); return result; };
    } else {
      const get = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
      f.env.ACCESS_CONTROL.get = name => { const owner = get(name); return { async fetch(url, init) {
        const response = await owner.fetch(url, init);
        if (typeof init?.body === "string" && JSON.parse(init.body).action === "asset_claim_publish")
          await putGrantCredentials(f.env, grantKey, { provider: "openrouter", kind: "api_key", enabled: false, credential: "synthetic-original-key" });
        return response;
      } }; };
    }
    const response = await f.publish(); assert.ok(response.status >= 400); await response.text();
    assert.equal(f.puts, phase === "after-put" ? 1 : 0); assert.equal(f.sent.length, 0);
  });

for (const mutation of ["grant-disabled", "grant-rotated", "policy", "permission", "caller", "expired"])
  test(`fresh ${mutation} denies both delegated GET and paid forward`, async t => {
    const f = await setup(t), issued = await f.issued();
    if (mutation.startsWith("grant-")) await putGrantCredentials(f.env, grantKey,
      { provider: "openrouter", kind: "api_key", enabled: mutation !== "grant-disabled", credential: "synthetic-replaced-key" });
    if (mutation === "policy") { f.policy.models = ["openrouter/foreign/model"]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    if (mutation === "permission") { f.policy.inputPublication.allow[0].forward = false; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    if (mutation === "caller") await f.authority("/credentials/mutate", { credentialId: "fixture", operation: "revoke", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "fixture@example.com" } });
    if (mutation === "expired") f.advance(15 * 60_000 + 1);
    const get = await f.get(issued.url); assert.equal(get.status, 404); assert.equal(f.gets, 0);
    const response = await f.forward(issued.url); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
  });

for (const mutation of ["foreign-url", "query", "verifier", "model", "prompt", "format", "unknown-dollar", "soft"])
  test(`forward ${mutation} cannot inherit receipt or billing authority`, async t => {
    const f = await setup(t, { fixed: mutation === "unknown-dollar" ? null : 700 }), issued = await f.issued(), body = input(musicModels[0], issued.url);
    if (mutation === "foreign-url") body.messages[0].content[1].image_url.url = issued.url.replace("router.example", "foreign.example");
    if (mutation === "query") body.messages[0].content[1].image_url.url += "?download=1";
    if (mutation === "verifier") body.messages[0].content[1].image_url.url = issued.url.slice(0, -64) + "0".repeat(64);
    if (mutation === "model") body.model = musicModels[1];
    if (mutation === "prompt") body.messages[0].content[0].text = "Changed request.";
    if (mutation === "format") body.audio.format = "mp3";
    if (mutation === "soft") { f.policy.budgetMode = "soft"; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
    const response = await f.forward(issued.url, { body }); assert.ok(response.status >= 400, await response.text()); assert.equal(f.sent.length, 0);
    await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  });

test("lost destination claim acknowledgment retains reservation and never sends or replays", async t => {
  const f = await setup(t), issued = await f.issued(), get = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL); let lost = false;
  f.env.ACCESS_CONTROL.get = name => { const owner = get(name); return { async fetch(url, init) {
    const response = await owner.fetch(url, init);
    if (!lost && typeof init?.body === "string" && JSON.parse(init.body).action === "asset_claim_forward") { lost = true; return new Response(null, { status: 503 }); }
    return response;
  } }; };
  const response = await f.forward(issued.url); assert.equal(response.status, 502); await response.text(); assert.equal(f.sent.length, 0); await charge(f, 700);
  f.restart(); const retry = await f.forward(issued.url); assert.ok(retry.status >= 400); await retry.text(); assert.equal(f.sent.length, 0);
});

test("concurrent forwards claim once; contention before claim cannot spend the receipt", async t => {
  const f = await setup(t), issued = await f.issued(), held = new BodyLease(); assert.equal(held.grow(20 * MiB), true);
  try {
    const response = await f.forward(issued.url); assert.equal(response.status, 503); await response.text(); await f.drain();
    assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 40 * MiB);
  } finally { held.release(); }
  const replies = await Promise.all([f.forward(issued.url), f.forward(issued.url)]);
  for (const response of replies) await response.text();
  assert.equal(replies.filter(response => response.status === 200).length, 1); assert.equal(f.sent.length, 1);
});

for (const change of ["rotate", "revoke", "models", "foreign-grant", "retention", "price", "owner-unavailable"])
  test(`warm publication admission rechecks ${change} after budget awaits`, async t => {
    const f = await setup(t), issued = await f.issued();
    overrideHotCacheConfig({ admissionMaxAgeMs: 30000, credentialMaxAgeMs: 60000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
    // Warming publication uses the SAME issuer and selected owner without
    // consuming this receipt's sole destination attempt.
    await f.issued(input(), "warm-owner");
    const namespace = f.env.BUDGET_LEDGER; let changed = false;
    f.env.BUDGET_LEDGER = { idFromName: name => name, get: name => ({ async fetch(url, init) {
      const response = await namespace.get(name).fetch(url, init);
      if (!changed && new URL(url).pathname === "/dispatch") {
        changed = true;
        if (change === "rotate" || change === "revoke") await putGrantCredentials(f.env, grantKey,
          { provider: "openrouter", kind: "api_key", enabled: change !== "revoke", credential: "synthetic-replaced-key" });
        if (["models", "foreign-grant", "retention", "price"].includes(change)) {
          if (change === "models") f.policy.models = ["openrouter/foreign"];
          if (change === "foreign-grant") f.policy.grantRouting = { eligibleGrants: { openrouter: ["foreign"] }, environmentFallback: true, failover: true };
          if (change === "retention") f.policy.retainRequestContent = true;
          if (change === "price") f.policy.requestCostMicros = null;
          await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
        }
        if (change === "owner-unavailable") f.env.GRANT_CREDENTIALS = { idFromName: name => name, get: () => ({ async fetch() { return new Response(null, { status: 503 }); } }) };
      }
      return response;
    } }) };
    const response = await f.forward(issued.url); assert.equal(changed, true); assert.ok(response.status >= 400); await response.text();
    assert.equal(f.sent.length, 0); await f.drain(); assert.ok((await f.events()).every(event => event.actual_cost_micros === 0));
  });

test("forwarding logging retains only a secret-free locator; a changed policy cannot borrow the archive verdict", async t => {
  const f = await setup(t), issued = await f.issued(); f.policy.retainRequestContent = true;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const original = f.env.CONTENT_ARCHIVE.put; let log;
  f.env.CONTENT_ARCHIVE.put = async (key, body, options) => {
    if (key.startsWith("published-input/")) return original(key, body, options);
    log = await new Response(body).json();
    assert.equal(JSON.stringify(log).includes(issued.url), false);
    assert.equal(JSON.stringify(log).includes(issued.url.split("/").at(-1)), false);
    assert.equal(log.body.messages[0].content[1].image_url.url, `published-input:${issued.receiptId}`);
  };
  const response = await f.forward(issued.url); assert.equal(response.status, 200, await response.clone().text()); await response.text();
  assert.ok(log); await charge(f, 700);
});

test("an interrupted native response retains the dispatched fixed charge and forbids retry", async t => {
  const f = await setup(t), issued = await f.issued();
  f.upstream = async request => {
    await request.json();
    return new Response(byteStream(new TextEncoder().encode('data: {"choices":')), { headers: { "content-type": "text/event-stream" } });
  };
  const response = await f.forward(issued.url); assert.equal(response.status, 502); await response.text(); await charge(f, 700);
  const retry = await f.forward(issued.url); assert.ok(retry.status >= 400); await retry.text(); assert.equal(f.sent.length, 1);
});

test("cancel during archive consumption retains ingress until the physical reader retires", { timeout: 15000 }, async t => {
  const f = await setup(t), controller = new AbortController(); let enter, release, canceled = false;
  const entered = new Promise(resolve => { enter = resolve; }), cleanup = new Promise(resolve => { release = resolve; });
  t.signal.addEventListener("abort", () => { controller.abort(); release(); }, { once: true });
  f.env.CONTENT_ARCHIVE.put = async (_key, body) => {
    f.puts++; const reader = body.getReader(); await reader.read(); enter();
    await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }));
    try { await reader.cancel(); canceled = true; await cleanup; throw new Error("fixture publication canceled"); }
    finally { reader.releaseLock(); }
  };
  const pending = f.publish(input(), "cancel-publication", { signal: controller.signal });
  await entered; controller.abort();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(bodyBudgetCharged(), 64 * MiB);
  release(); const response = await pending; assert.ok(response.status >= 400); await response.text();
  assert.equal(canceled, true); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});
