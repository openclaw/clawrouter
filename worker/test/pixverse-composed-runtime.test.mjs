import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const test = (name, run) => nodeTest(name, { timeout: 15000 }, run);
const { default: worker } = await import("../index.ts");
const { snapshot, upstreamAuth } = await import("../providers.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { inputRouteDigest } = await import("../pixverse-input-dispatch.ts");
const { putGrantCredentials, revokeGrantCredentials, GrantCredentialObject } = await import("../grant-credentials.ts");
const { bodyBudgetCharged, BodyLease } = await import("../body-budget.ts");
const path = "/v1/native/pixverse/openapi/v2/video/img/generate", get = "/v1/native/pixverse/openapi/v2/video/result/456";
const profile = "clawrouter.pixverse-image-input.v1";
const headers = { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "Idempotency-Key": "same-composed-job" };
const plan = { model: "v6", prompt: "A lighthouse", duration: 5, quality: "720p" };
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
const encoder = new TextEncoder();
function multipart(value = plan, image = png, extras = []) {
  const boundary = "composed-fixture", parts = [];
  for (const [key, item] of [...Object.entries(value), ...extras]) parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${item}\r\n`));
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`), image, encoder.encode(`\r\n--${boundary}--\r\n`));
  return { raw: new Uint8Array(Buffer.concat(parts)), type: `multipart/form-data; boundary=${boundary}` };
}
async function setup(t, options = {}) {
  const originalProviders = [...snapshot.providers];
  const index = snapshot.providers.findIndex(provider => provider.id === "replicate"), original = snapshot.providers[index];
  const replacement = structuredClone(original); snapshot.providers[index] = replacement;
  // The shared fixture temporarily removes the shipped PixVerse row. Restore by
  // object identity because its earlier splice changes the Replicate index.
  t.after(() => { snapshot.providers[snapshot.providers.indexOf(replacement)] = original; });
  const f = await fixture(t, { providerId: "pixverse", pooled: options.pooled !== false, configure(provider) {
    provider.base_urls.default = "https://app-api.pixverse.ai";
    provider.auth.schemes = [{ type: "api_key", header: "API-KEY", secretKind: "api_key" }]; provider.auth.grantTransports = {};
    provider.adapter.injectHeaders = {}; provider.adapter.injectQuery = {}; provider.adapter.passthroughHeaders = [];
    const create = structuredClone(provider.endpoints[0]);
    Object.assign(create, { id: "image_video", method: "POST", methods: ["POST"], native_proxy: true, path: "/openapi/v2/video/img/generate", path_params: [],
      request_format: "pixverse.image_video", response_format: "pixverse.video", inputProfile: profile, query: {}, headers: {}, streaming: false,
      lifecycle: { protocol: "pixverse.video", retrieve: "video" } });
    const retrieve = { ...structuredClone(create), id: "video", method: "GET", methods: ["GET"], path: "/openapi/v2/video/result/${video_id}", path_params: ["video_id"],
      request_format: "pixverse.video_get", inputProfile: undefined, lifecycle: null };
    const text = { ...structuredClone(create), id: "text_video", path: "/openapi/v2/video/text/generate", request_format: "pixverse.text_video", inputProfile: undefined };
    provider.endpoints = [text, create, retrieve];
    provider.capabilities = [{ id: "media.predict", endpoint: "text_video", methods: ["POST"] }, { id: "video.generate", endpoint: "image_video", methods: ["POST"] }];
    provider.models = ["v6", "c1"].map(model => ({ id: `pixverse/${model}`, upstream: model, capabilities: ["media.predict", "video.generate"], pricing: null }));
  } });
  t.after(() => assert.deepEqual(snapshot.providers, originalProviders, "fixture restores every shipped provider row"));
  f.env.PIXVERSE_API_KEY = "synthetic-nonselected-key";
  f.policy.requestCostsMicros = { "pixverse.image_upload": 13, "video.generate": 700 };
  f.policy.upstreamRetention = { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "pixverse", protocol: "pixverse.video" }] };
  f.savePolicy = () => f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); await f.savePolicy();
  f.image = f.provider.endpoints.find(value => value.id === "image_video");
  const restart = f.restart;
  f.restart = () => { restart(); for (const state of f.env.GRANT_CREDENTIALS.objects.values()) state.object = new GrantCredentialObject(state.state, f.env); };
  if (options.pooled !== false) {
    const auth = await authenticateProxyKey(new Headers(headers), f.env, [{ id: "pixverse", tokenRef: "pixverse" }]); assert.ok(!(auth instanceof Response));
    const upstream = await upstreamAuth(f.provider, auth, f.env), destination = await inputRouteDigest(f.provider, f.image, upstream.grant, f.env);
    f.env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS = JSON.stringify({ version: "clawrouter.upstream-retention-bindings.v1", bindings: [{
      providerId: "pixverse", protocol: "pixverse.video", grantKey, routeSha256: destination.digest, retention: "allow", expiresAt: new Date(Date.now() + 120000).toISOString() }] });
  }
  f.jobs = () => [...f.env.ACCESS_CONTROL.objects.entries()].filter(([name]) => name.startsWith("http-continuations:"))
    .flatMap(([scope, state]) => state.db.prepare("SELECT job_json FROM responses_background").all().map(row => ({ scope, job: JSON.parse(row.job_json) })));
  f.upstream = async request => {
    assert.equal(request.headers.get("API-KEY"), "synthetic-original-key"); assert.equal(request.headers.has("authorization"), false);
    assert.match(request.headers.get("ai-trace-id"), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    if (request.method === "GET") return Response.json({ ErrCode: 0, Resp: { video_id: 456, status: 6 } });
    assert.equal(bodyBudgetCharged(), 96 * 1024 * 1024, "BOTH leases before either paid POST");
    const job = f.jobs()[0].job;
    assert.ok(job.legs.every(leg => leg.reserve === "accepted")); assert.ok(job.inputReceipt.upload.legs.every(leg => leg.reserve === "accepted"));
    assert.notEqual(job.requestId, job.inputReceipt.upload.requestId);
    if (request.url.endsWith("/image/upload")) {
      assert.equal(job.inputReceipt.state, "dispatch_unknown"); assert.equal(job.dispatchClaimed, false);
      const form = await request.formData(); assert.deepEqual([...form.keys()], ["image"]);
      const file = form.get("image"); assert.equal(file.name, "input-image"); assert.equal(file.type, "image/png");
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
      return Response.json({ ErrCode: 0, Resp: { img_id: 123 } });
    }
    assert.equal(request.url, "https://app-api.pixverse.ai/openapi/v2/video/img/generate");
    assert.equal(job.inputReceipt.state, "bound"); assert.equal(job.inputReceipt.createClaimed, true);
    assert.deepEqual(await request.json(), { ...plan, img_id: 123 });
    return new Response('{"ErrCode":0,"Resp":{"video_id":456},"native_extra":"preserved"}', { headers: { "content-type": "application/json" } });
  };
  f.send = async (value = plan, options = {}) => {
    const { raw, type } = multipart(value, options.image ?? png, options.extras ?? []), body = options.raw ?? raw;
    return worker.fetch(new Request(`https://router.example${options.path ?? path}`, { method: "POST", body, duplex: "half",
      headers: { ...headers, "content-type": type, ...options.headers } }), f.env, { waitUntil() {} });
  };
  return f;
}
async function rejected(f, response, before = 0) {
  assert.ok(response.status >= 400, await response.clone().text());
  assert.doesNotMatch(await response.text(), /synthetic-original-key|synthetic-nonselected-key|A lighthouse/);
  assert.equal(f.sent.length, before); assert.equal(bodyBudgetCharged(), 0);
}

test("public composed bytes reserve both operations, return exact native body only after binding, and retrieve under original image route", async t => {
  const f = await setup(t), response = await f.send(); if (response.status !== 200) assert.fail(await response.text());
  assert.equal(bodyBudgetCharged(), 40 * 1024 * 1024, "public delivery retains ingress capacity");
  assert.equal(f.jobs()[0].job.managed.submission, "bound");
  assert.equal(await response.text(), '{"ErrCode":0,"Resp":{"video_id":456},"native_extra":"preserved"}');
  assert.equal(f.sent.length, 2); assert.equal(bodyBudgetCharged(), 0);
  const stored = f.jobs()[0], binding = stored.job.inputReceipt.binding;
  assert.equal(binding.inputProfile, profile); assert.equal(binding.owner.endpointId, "image_video");
  assert.doesNotMatch(JSON.stringify(stored.job), /A lighthouse|synthetic-|iVBORw0|native_extra/);
  f.restart(); const retry = await f.send(); assert.equal(retry.status, 409); assert.equal(retry.headers.get("location"), get);
  assert.equal((await retry.json()).error.code, "managed_create_response_unavailable"); assert.equal(f.sent.length, 2);
  // Text is first and shares the native GET. Only the bound IMAGE route wins.
  const control = await f.call(get, null); assert.equal(control.status, 410, await control.clone().text());
  assert.equal((await control.json()).error.code, "prediction_observation_unavailable");
  assert.equal(f.sent.length, 3); assert.equal(f.jobs()[0].job.managed.observationUnavailable, "deleted");
  await f.env.ACCESS_CONTROL.objects.get(stored.scope).object.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => [event.capability, event.actual_cost_micros, event.cost_basis]).sort(),
    [["pixverse.image_upload", 13, "policy_fixed"], ["video.generate", 700, "policy_fixed"]]);
});

for (const [name, value, options] of [
  ["URL input", { ...plan, image_url: "https://example.com/file.png" }, {}],
  ["caller image ID", { ...plan, img_id: 123 }, {}],
  ["caller binding", { ...plan, binding: "forged" }, {}],
  ["duplicate scalar", plan, { extras: [["model", "v6"]] }],
  ["ambiguous number", { ...plan, duration: "05" }, {}],
  ["unregistered model", { ...plan, model: "v9" }, {}],
  ["false PNG MIME", plan, { image: Uint8Array.of(1, 2, 3) }],
  ["encoded envelope", plan, { headers: { "content-encoding": "gzip" } }],
  ["query override", plan, { path: path + "?image_url=https://example.com" }],
  ["incomplete envelope", plan, { raw: multipart().raw.subarray(0, -3) }],
  ["trailing bytes", plan, { raw: new Uint8Array(Buffer.concat([multipart().raw, Buffer.from("x")])) }],
]) test(`composed ${name} is denied with zero egress`, async t => {
  const f = await setup(t); await rejected(f, await f.send(value, options)); assert.equal(f.jobs().length, 0);
});

test("authentication precedes any multipart read or capacity claim", async t => {
  const f = await setup(t); let pulls = 0;
  const body = new ReadableStream({ type: "bytes", pull(controller) { pulls++; controller.error(new Error("body must not be read")); } }, { highWaterMark: 0 });
  await rejected(f, await f.send(plan, { raw: body, headers: { authorization: "Bearer invalid" } })); assert.equal(pulls, 0);
});

for (const field of ["pixverse.image_upload", "video.generate", "upstreamRetention", "serverRetention", "ownerGrant", "imageCapability"]) test(`missing ${field} cannot borrow policy-wide or environment authority`, async t => {
  const f = await setup(t, { pooled: field !== "ownerGrant" });
  if (["pixverse.image_upload", "video.generate"].includes(field)) { delete f.policy.requestCostsMicros[field]; await f.savePolicy(); }
  if (field === "upstreamRetention") { delete f.policy.upstreamRetention; await f.savePolicy(); }
  if (field === "serverRetention") delete f.env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS;
  if (field === "imageCapability") f.provider.models[0].capabilities = ["media.predict"];
  await rejected(f, await f.send());
});

test("manifest JSON img_id cannot bypass the native composed profile", async t => {
  const f = await setup(t); await rejected(f, await f.call("/v1/proxy/pixverse/image_video", { ...plan, img_id: 123 }));
});

test("changed plan/bytes/model under an existing key conflicts without another upload", async t => {
  const f = await setup(t), response = await f.send(); assert.equal(response.status, 200); await response.text();
  for (const changed of [{ ...plan, prompt: "Different" }, { ...plan, model: "c1" }]) await rejected(f, await f.send(changed), 2);
});

test("concurrent composed requests cannot exceed capacity or duplicate either POST", async t => {
  const f = await setup(t), results = await Promise.all([f.send(), f.send()]);
  for (const response of results) await response.text();
  assert.ok(results.some(response => response.status >= 400)); assert.ok(f.sent.length <= 2); assert.equal(f.jobs().length <= 1, true); assert.equal(bodyBudgetCharged(), 0);
});

for (const action of ["input_allocate", "input_claim_upload", "input_bind_upload", "input_claim_create", "managed_bind"]) test(`lost ${action} ACK preserves exact attempt ownership through restart`, async t => {
  const f = await setup(t), originalGet = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL); let lost = false;
  f.env.ACCESS_CONTROL.get = name => { const stub = originalGet(name); return { async fetch(url, init) {
    const input = JSON.parse(init.body), response = await stub.fetch(url, init);
    if (!lost && input.action === action && response.ok) { lost = true; return new Response("lost ACK", { status: 503 }); }
    return response;
  } }; };
  const response = await f.send(); await response.text(); assert.equal(lost, true);
  const count = f.sent.length; f.restart(); const retry = await f.send(); await retry.text(); assert.equal(f.sent.length, count);
  if (action === "input_claim_upload") assert.equal(count, 0);
  else if (action === "input_claim_create") assert.equal(count, 1);
  else { assert.equal(response.status, 200); assert.equal(count, 2); }
  assert.equal(bodyBudgetCharged(), 0);
});

for (const phase of ["before-upload", "after-upload", "after-upload-claim", "after-create-claim"]) test(`revocation or expiry ${phase} preserves original owner and zero unauthorized POSTs`, async t => {
  const f = await setup(t), originalUpstream = f.upstream;
  if (phase === "before-upload") await revokeGrantCredentials(f.env, grantKey);
  if (phase === "after-upload") f.upstream = async request => { const response = await originalUpstream(request); await revokeGrantCredentials(f.env, grantKey); return response; };
  if (phase.endsWith("claim")) {
    const originalGet = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
    f.env.ACCESS_CONTROL.get = name => { const stub = originalGet(name); return { async fetch(url, init) {
      const input = JSON.parse(init.body), response = await stub.fetch(url, init);
      if (input.action === (phase === "after-upload-claim" ? "input_claim_upload" : "input_claim_create")) f.advance(60001);
      return response;
    } }; };
  }
  const response = await f.send(); await rejected(f, response, phase === "after-upload" || phase === "after-create-claim" ? 1 : 0);
});

test("profile or lifecycle mutation never falls back to the legacy internal route digest", async t => {
  const f = await setup(t), response = await f.send(); assert.equal(response.status, 200); await response.text();
  delete f.image.inputProfile;
  const control = await f.call(get, null); assert.equal(control.status, 503);
  assert.equal((await control.json()).error.code, "response_owner_unavailable"); assert.equal(f.sent.length, 2);
});

test("capacity exhaustion refuses before reservations and releases on public cancellation", async t => {
  const f = await setup(t), competing = new BodyLease(); assert.equal(competing.grow(40 * 1024 * 1024), true);
  try { const response = await f.send(); assert.equal(response.status, 503); await response.text(); assert.equal(f.sent.length, 0); assert.equal(f.jobs().length, 0); }
  finally { competing.release(); }
  const response = await f.send(); assert.equal(response.status, 200); assert.equal(bodyBudgetCharged(), 40 * 1024 * 1024);
  await response.body.cancel(); await Promise.resolve(); assert.equal(bodyBudgetCharged(), 0);
});

for (const mode of ["qualified", "missing-upload-price", "combined-budget", "missing-retention", "environment-only"]) test(`caller catalog ${mode} projects only the qualified native composed profile`, async t => {
  const f = await setup(t, { pooled: mode !== "environment-only" });
  if (mode === "missing-upload-price") { delete f.policy.requestCostsMicros["pixverse.image_upload"]; await f.savePolicy(); }
  if (mode === "combined-budget") { f.policy.monthlyBudgetMicros = 712; await f.savePolicy(); }
  if (mode === "missing-retention") delete f.env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS;
  const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200, await response.clone().text());
  const catalog = await response.json(), provider = catalog.providers.find(value => value.id === "pixverse");
  const offers = provider?.offers?.filter(offer => offer.endpoint === "image_video") ?? [];
  assert.ok(offers.every(offer => offer.routeKind === "native" && offer.inputProfile === profile));
  if (mode === "qualified") {
    assert.ok(offers.some(offer => offer.modelId === "pixverse/v6" && offer.eligible));
    assert.equal(provider.routes.find(route => route.endpoint === "image_video").inputProfile, profile);
  } else assert.ok(offers.every(offer => !offer.eligible));
  const routes = await (await f.call("/v1/routes", null)).json();
  assert.ok(routes.manifestProxy.every(route => route.provider !== "pixverse" || route.endpoint !== "image_video"));
  assert.equal(f.sent.length, 0);
});

test("malformed or incomplete upstream upload/create results retain their dispatched cost without replay", async t => {
  const f = await setup(t), original = f.upstream;
  f.upstream = async request => {
    const response = await original(request);
    return request.url.endsWith("/image/upload") ? response : new Response('{"ErrCode":0,"Resp":', { headers: { "content-type": "application/json" } });
  };
  await rejected(f, await f.send(), 2); f.restart(); await rejected(f, await f.send(), 2);
  const state = f.jobs()[0]; f.advance(61000); await f.env.ACCESS_CONTROL.objects.get(state.scope).object.alarm(); await f.drain();
  assert.equal((await f.events()).length, 0, "input expiry does not invent a terminal generation");
  f.advance(state.job.observeUntil - Date.now() + 1);
  await f.env.ACCESS_CONTROL.objects.get(state.scope).object.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 2); assert.equal(events.reduce((total, event) => total + event.actual_cost_micros, 0), 713);
});

test("forged public receipt/grant headers cannot replace original selected credentials or emitted trace", async t => {
  const f = await setup(t), response = await f.send(plan, { headers: { "API-KEY": "synthetic-forged-key", "Ai-trace-id": "forged", "x-clawrouter-managed-job-id": "999" } });
  assert.equal(response.status, 200); await response.text(); assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(request => request.headers.get("API-KEY") === "synthetic-original-key" && request.headers.get("ai-trace-id") !== "forged"));
});

test("expiry while upload response is read denies late image binding and any create", async t => {
  const f = await setup(t), original = f.upstream;
  f.upstream = async request => { const response = await original(request); f.advance(60001); return response; };
  await rejected(f, await f.send(), 1);
  const receipt = f.jobs()[0].job.inputReceipt; assert.equal(receipt.imageId, null); assert.equal(receipt.createClaimed, false);
  f.restart(); await rejected(f, await f.send(), 1);
});

test("current caller revocation before the owner authorization check denies upload", async t => {
  const f = await setup(t), originalGet = f.env.GRANT_CREDENTIALS.get.bind(f.env.GRANT_CREDENTIALS);
  f.env.GRANT_CREDENTIALS.get = name => { const stub = originalGet(name); return { async fetch(url, init) {
    if (new URL(url).pathname === "/managed-input/compose") {
      f.policy.enabled = false; await f.savePolicy();
    }
    return stub.fetch(url, init);
  } }; };
  await rejected(f, await f.send());
});

test("owner rotation between allocation and private composition never borrows the replacement or environment key", async t => {
  const f = await setup(t), originalGet = f.env.GRANT_CREDENTIALS.get.bind(f.env.GRANT_CREDENTIALS); let rotated = false;
  f.env.GRANT_CREDENTIALS.get = name => { const stub = originalGet(name); return { async fetch(url, init) {
    if (!rotated && new URL(url).pathname === "/managed-input/compose") {
      rotated = true; await putGrantCredentials(f.env, grantKey, { provider: "pixverse", kind: "api_key", enabled: true, credential: "synthetic-rotated-key" });
    }
    return stub.fetch(url, init);
  } }; };
  await rejected(f, await f.send()); assert.equal(rotated, true);
});

test("early upstream upload response cannot acknowledge partially consumed bytes", async t => {
  const f = await setup(t);
  // A valid larger PNG cannot fit in the fixed stream's bounded transport
  // window. The tiny 1x1 image can be fully consumed before a response arrives.
  const pixels = Buffer.alloc((256 * 4 + 1) * 256); let random = 1;
  for (let row = 0; row < 256; row++) for (let column = 1; column <= 256 * 4; column++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    pixels[row * (256 * 4 + 1) + column] = random & 255;
  }
  const compressed = deflateSync(pixels); assert.deepEqual(inflateSync(compressed), pixels);
  const chunk = (name, value) => {
    const data = Buffer.concat([Buffer.from(name), value]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(value.length); checksum.writeUInt32BE(crc32(data)); return Buffer.concat([size, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
  const image = new Uint8Array(Buffer.concat([png.subarray(0, 8), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]));
  assert.ok(image.length > 128 * 1024);
  f.upstream = () => Response.json({ ErrCode: 0, Resp: { img_id: 123 } });
  await rejected(f, await f.send(plan, { image }), 1);
  assert.equal(f.jobs()[0].job.inputReceipt.state, "dispatch_unknown");
  assert.equal(f.jobs()[0].job.inputReceipt.imageId, null);
});

test("removing the explicit image capability after allocation cannot borrow the text model binding", async t => {
  const f = await setup(t), originalGet = f.env.GRANT_CREDENTIALS.get.bind(f.env.GRANT_CREDENTIALS);
  f.env.GRANT_CREDENTIALS.get = name => { const stub = originalGet(name); return { fetch(url, init) {
    if (new URL(url).pathname === "/managed-input/compose") {
      f.provider.models[0].capabilities = ["media.predict"];
      f.provider.capabilities.push({ id: "media.predict", endpoint: "image_video", methods: ["POST"] });
    }
    return stub.fetch(url, init);
  } }; };
  await rejected(f, await f.send());
});
