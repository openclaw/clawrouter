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

test("ordinary shared-path Chat admits concurrent small calls while music capacity is unavailable", async t => {
  const f = await setup(t), chat = f.provider.models.find(value => value.capabilities.includes("llm.chat")); assert.ok(chat);
  const held = new BodyLease(); assert.equal(held.grow(40 * MiB), true);
  let release; const barrier = new Promise(resolve => { release = resolve; }); let entered = 0;
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
