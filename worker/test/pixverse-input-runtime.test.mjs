import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
const test = (name, run) => nodeTest(name, { timeout: 10_000 }, run);
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot, upstreamAuth } = await import("../providers.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { allocatePixVerseInput, dispatchPixVerseInput, getPixVerseInput } = await import("../pixverse-inputs.ts");
const { inputRouteDigest, encodeInputDispatch } = await import("../pixverse-input-dispatch.ts");
const { publicControlAuthorization } = await import("../response-control-authorization.ts");
const { backgroundCall } = await import("../http-background.ts");
const { GrantCredentialObject, putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const plan = { model: "v6", prompt: "A lighthouse", duration: 5, quality: "720p" };
// Decoder-valid 1x1 PNG, used unchanged; no remote input reference.
const bytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=", "base64"));
const permission = { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "pixverse", protocol: "pixverse.video" }] };
async function setup(t, options = {}) {
  const index = snapshot.providers.findIndex(provider => provider.id === "replicate"), original = snapshot.providers[index];
  snapshot.providers[index] = structuredClone(original); t.after(() => { snapshot.providers[index] = original; });
  const f = await fixture(t, { providerId: "pixverse", pooled: options.pooled !== false, configure(provider) {
    provider.base_urls.default = "https://app-api.pixverse.ai";
    provider.auth.schemes = [{ type: "api_key", header: "API-KEY", secretKind: "api_key" }];
    provider.auth.grantTransports = {};
    provider.adapter.injectHeaders = {}; provider.adapter.injectQuery = {}; provider.adapter.passthroughHeaders = [];
    const endpoint = structuredClone(provider.endpoints[0]);
    Object.assign(endpoint, { id: "image_video", method: "POST", path: "/openapi/v2/video/img/generate", path_params: [],
      request_format: "pixverse.image_video", response_format: "pixverse.video", query: {}, headers: {}, streaming: false, lifecycle: null });
    provider.endpoints = [endpoint]; provider.capabilities = [{ id: "video.generate", endpoint: "image_video", methods: ["POST"] }];
    provider.models = [{ id: "pixverse/v6", upstream: "v6", capabilities: ["video.generate"], pricing: null }];
  } });
  f.env.PIXVERSE_API_KEY = "synthetic-environment-key";
  f.policy.requestCostsMicros = { "pixverse.image_upload": 13, "video.generate": 700 };
  f.policy.upstreamRetention = permission;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const request = new Request("https://router.example/internal-fixture", { method: "POST", headers: {
    authorization: "Bearer clawrouter-live-fixture-fixture-secret", "Idempotency-Key": "same-job", "x-request-id": "input-fixture" } });
  const auth = await authenticateProxyKey(request.headers, f.env, [{ id: "pixverse", tokenRef: "pixverse" }]);
  assert.ok(!(auth instanceof Response));
  const selection = { provider: f.provider, endpoint: f.provider.endpoints[0], model: f.provider.models[0], capability: "video.generate", method: "POST", pathParams: {}, body: plan };
  if (options.pooled !== false) {
    const upstream = await upstreamAuth(f.provider, auth, f.env);
    const destination = await inputRouteDigest(f.provider, selection.endpoint, upstream.grant, f.env);
    f.env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS = JSON.stringify({ version: "clawrouter.upstream-retention-bindings.v1", bindings: [{
      providerId: "pixverse", protocol: "pixverse.video", grantKey, routeSha256: destination.digest,
      retention: "allow", expiresAt: new Date(Date.now() + 120_000).toISOString() }] });
  }
  const file = { bytes, type: "image/png" };
  f.upstream = async request => {
    assert.equal(request.headers.get("API-KEY"), "synthetic-original-key");
    assert.equal(request.headers.has("authorization"), false);
    assert.match(request.headers.get("ai-trace-id"), /^[0-9a-f-]{36}$/);
    if (request.url.endsWith("/image/upload")) {
      const form = await request.formData(), image = form.get("image");
      assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes); assert.deepEqual([...form.keys()], ["image"]);
      return Response.json({ ErrCode: 0, Resp: { img_id: 123 } });
    }
    assert.equal(request.url, "https://app-api.pixverse.ai/openapi/v2/video/img/generate");
    assert.deepEqual(await request.json(), { ...plan, img_id: 123 });
    return Response.json({ ErrCode: 0, Resp: { video_id: 456 } });
  };
  f.allocate = () => allocatePixVerseInput(request, f.env, { waitUntil() {} }, auth, selection, file);
  f.dispatch = (binding, action, input = action === "upload" ? bytes : undefined) => dispatchPixVerseInput(request, f.env, auth, binding, plan, action, input);
  f.row = binding => JSON.parse(f.env.ACCESS_CONTROL.objects.get(binding.scope).db.prepare("SELECT job_json FROM responses_background WHERE job_id = ?").get(binding.jobId).job_json);
  f.alarm = async binding => { await f.env.ACCESS_CONTROL.objects.get(binding.scope).object.alarm(); await f.drain(); };
  return Object.assign(f, { request, auth, selection, file });
}
const rejects = promise => assert.rejects(promise, error => error instanceof Error && !/synthetic-original-key|synthetic-environment-key/.test(error.message));

test("internal one-job input preserves exact bytes/original key, separate charges and no replay through restart", async t => {
  const f = await setup(t), binding = await f.allocate();
  assert.equal(f.sent.length, 0); const allocated = f.row(binding);
  assert.equal(allocated.inputReceipt.state, "pending");
  assert.notEqual(allocated.eventId, allocated.inputReceipt.upload.eventId);
  assert.notEqual(allocated.requestId, allocated.inputReceipt.upload.requestId);
  assert.doesNotMatch(JSON.stringify(allocated), /A lighthouse|synthetic-|iVBORw0/);
  const uploaded = await f.dispatch(binding, "upload"); assert.equal(uploaded.imageId, "123");
  f.restart(); assert.deepEqual(await f.allocate(), binding);
  await f.dispatch(binding, "upload"); assert.equal(f.sent.length, 1);
  await f.dispatch(binding, "create"); assert.equal(f.sent.length, 2);
  await rejects(f.dispatch(binding, "create")); assert.equal(f.sent.length, 2);
  await backgroundCall(f.env, binding.scope, { action: "managed_observe", id: binding.jobId, responseId: "456", predictionStatus: "succeeded", statusCode: 200 });
  await f.alarm(binding); f.restart(); await f.alarm(binding);
  assert.equal(f.row(binding).phase, "complete"); assert.equal(f.row(binding).inputReceipt.createClaimed, true);
  assert.equal(f.row(binding).inputReceipt.upload.phase, "complete");
  const events = await f.events(); assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => [event.capability, event.actual_cost_micros, event.cost_basis]).sort(),
    [["pixverse.image_upload", 13, "policy_fixed"], ["video.generate", 700, "policy_fixed"]]);
  assert.equal(bodyBudgetCharged(), 0);
});

test("concurrent upload and create contenders each authorize at most one POST", async t => {
  const f = await setup(t), [a, b] = await Promise.all([f.allocate(), f.allocate()]); assert.deepEqual(a, b);
  const uploads = await Promise.allSettled([f.dispatch(a, "upload"), f.dispatch(b, "upload")]);
  assert.ok(uploads.some(result => result.status === "fulfilled")); assert.equal(f.sent.length, 1);
  const creates = await Promise.allSettled([f.dispatch(a, "create"), f.dispatch(b, "create")]);
  assert.equal(creates.filter(result => result.status === "fulfilled").length, 1); assert.equal(f.sent.length, 2);
});

for (const action of ["input_allocate", "input_claim_upload", "input_bind_upload", "input_claim_create"]) test(`lost ${action} ACK cannot mint a second job or replay dispatch`, async t => {
  const f = await setup(t), originalGet = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL); let lost = false;
  f.env.ACCESS_CONTROL.get = name => { const stub = originalGet(name); return { async fetch(url, init) {
    const input = JSON.parse(init.body); const response = await stub.fetch(url, init);
    if (!lost && input.action === action && response.ok) { lost = true; return new Response("lost fixture ACK", { status: 503 }); }
    return response;
  } }; };
  const binding = await f.allocate();
  if (action === "input_claim_upload") {
    await rejects(f.dispatch(binding, "upload")); f.restart(); await rejects(f.dispatch(binding, "upload")); assert.equal(f.sent.length, 0);
  } else {
    if (action === "input_bind_upload") await rejects(f.dispatch(binding, "upload")); else await f.dispatch(binding, "upload");
    f.restart(); assert.equal((await f.dispatch(binding, "upload")).imageId, "123"); assert.equal(f.sent.length, 1);
    if (action === "input_claim_create") { await rejects(f.dispatch(binding, "create")); f.restart(); await rejects(f.dispatch(binding, "create")); assert.equal(f.sent.length, 1); }
  }
  assert.equal(lost, true);
});

test("uncertain upload freezes its charge once while unsent generation remains separate", async t => {
  const f = await setup(t), binding = await f.allocate();
  f.upstream = () => { throw new Error("fixture lost upload response"); };
  await rejects(f.dispatch(binding, "upload")); f.restart(); await rejects(f.dispatch(binding, "upload")); assert.equal(f.sent.length, 1);
  f.advance(60_001); await f.alarm(binding); f.restart(); await f.alarm(binding);
  const events = await f.events(); assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => [event.capability, event.actual_cost_micros]).sort(), [["pixverse.image_upload", 13], ["video.generate", 0]]);
  assert.equal(f.row(binding).inputReceipt.state, "dispatch_unknown");
  await rejects(f.dispatch(binding, "upload")); assert.equal(f.sent.length, 1);
});

for (const field of ["scope", "owner", "model", "region", "origin", "digest", "createDigest", "jobId", "generation"]) test(`forged ${field} cannot redirect or reuse the input receipt`, async t => {
  const f = await setup(t), binding = await f.allocate(), changed = structuredClone(binding);
  if (field === "owner") changed.owner.grantKey = "oauth/other/pixverse";
  else if (field === "generation") changed.generation++;
  else if (field === "model") changed.model = "c1";
  else if (field === "region") changed.region = "cn";
  else if (field === "origin") changed.origin = "https://app-api.pixverseai.cn";
  else if (field === "jobId") changed.jobId = "bg_" + "f".repeat(32);
  else if (field === "scope") changed.scope = "http-continuations:" + "f".repeat(64);
  else changed[field] = "f".repeat(64);
  await rejects(f.dispatch(changed, "upload")); assert.equal(f.sent.length, 0);
});

for (const kind of ["environment", "flat-price", "missing-upload-price", "missing-create-price", "forged-auth", "remote-url", "caller-image-id"]) test(`${kind} is denied before any input POST`, async t => {
  const f = await setup(t, { pooled: kind !== "environment" });
  if (kind === "flat-price") f.auth.policy.requestCostsMicros = {};
  if (kind === "missing-upload-price") delete f.auth.policy.requestCostsMicros["pixverse.image_upload"];
  if (kind === "missing-create-price") delete f.auth.policy.requestCostsMicros["video.generate"];
  if (kind === "forged-auth") await rejects(allocatePixVerseInput(f.request, f.env, {}, structuredClone(f.auth), f.selection, f.file));
  else if (kind === "remote-url") await rejects(allocatePixVerseInput(f.request, f.env, {}, f.auth, f.selection, { url: "https://images.example/a.png" }));
  else { if (kind === "caller-image-id") f.selection.body = { ...plan, img_id: 123 }; await rejects(f.allocate()); }
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});

for (const kind of ["revoked", "replacement", "policy", "consent", "model", "expired", "route"]) test(`${kind} after allocation denies original owner dispatch without fallback`, async t => {
  const f = await setup(t), binding = await f.allocate();
  if (kind === "revoked") await revokeGrantCredentials(f.env, grantKey, { provider: "pixverse", kind: "api_key" });
  if (kind === "replacement") await putGrantCredentials(f.env, grantKey, { provider: "pixverse", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  if (kind === "policy") f.policy.enabled = false;
  if (kind === "consent") f.policy.upstreamRetention = null;
  if (kind === "model") f.policy.models = ["pixverse/c1"];
  if (["policy", "consent", "model"].includes(kind)) await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  if (kind === "expired") f.advance(60_001);
  if (kind === "route") f.provider.base_urls.default = "https://app-api.pixverseai.cn";
  await rejects(f.dispatch(binding, "upload")); assert.equal(f.sent.length, 0);
});

test("late upload binding and tombstones cannot reset attempts or grant an image handle", async t => {
  const f = await setup(t), binding = await f.allocate();
  f.upstream = () => { f.advance(60_001); return Response.json({ ErrCode: 0, Resp: { img_id: 123 } }); };
  await rejects(f.dispatch(binding, "upload")); await f.alarm(binding);
  await rejects(backgroundCall(f.env, binding.scope, { action: "input_bind_upload", binding, imageId: "123" }));
  await rejects(f.dispatch(binding, "upload")); assert.equal(f.sent.length, 1); assert.equal(f.row(binding).inputReceipt.imageId, null);
});

test("credential revocation during pre-tail byte preparation denies; tail releases after fetch starts", async t => {
  const f = await setup(t), binding = await f.allocate();
  const input = encodeInputDispatch({ binding, authorization: publicControlAuthorization(f.auth), action: "upload", deadline: binding.expiresAt, plan }, bytes);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const body = new ReadableStream({ async start(controller) { await gate; controller.enqueue(input); controller.close(); } });
  const pending = f.env.GRANT_CREDENTIALS.get(grantKey).fetch("https://clawrouter.internal/managed-input/dispatch", { method: "POST", body, duplex: "half" });
  await revokeGrantCredentials(f.env, grantKey, { provider: "pixverse", kind: "api_key" }); release();
  const response = await pending; assert.equal(response.status, 409); await response.text(); assert.equal(f.sent.length, 0);
});

test("in-flight provider response does not hold credential mutation ordering", async t => {
  const f = await setup(t), binding = await f.allocate(); let started, complete;
  const began = new Promise(resolve => { started = resolve; }), upstream = new Promise(resolve => { complete = resolve; });
  f.upstream = () => { started(); return upstream; };
  const pending = f.dispatch(binding, "upload"); await began;
  await revokeGrantCredentials(f.env, grantKey, { provider: "pixverse", kind: "api_key" });
  complete(Response.json({ ErrCode: 0, Resp: { img_id: 123 } })); await pending;
  await rejects(f.dispatch(binding, "create")); assert.equal(f.sent.length, 1);
});

test("final receipt claim timeout prevents fetch after the persisted uncertainty", async t => {
  const f = await setup(t), binding = await f.allocate(), get = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
  f.env.ACCESS_CONTROL.get = name => { const stub = get(name); return { async fetch(url, init) {
    const result = await stub.fetch(url, init); if (JSON.parse(init.body).action === "input_claim_upload") f.advance(30_001); return result;
  } }; };
  await rejects(f.dispatch(binding, "upload")); assert.equal(f.sent.length, 0); assert.equal(f.row(binding).inputReceipt.state, "dispatch_unknown");
});

test("collection authority and public private-action attempts do not authorize uploads", async t => {
  const f = await setup(t), binding = await f.allocate();
  const body = encodeInputDispatch({ binding, authorization: { kind: "collection" }, action: "upload", deadline: binding.expiresAt, plan }, bytes);
  const response = await f.env.GRANT_CREDENTIALS.get(grantKey).fetch("https://clawrouter.internal/managed-input/dispatch", { method: "POST", body });
  assert.equal(response.status, 403); await response.text();
  const publicAttempt = await f.call("/responses-background", { action: "input_claim_upload", binding });
  assert.ok(publicAttempt.status >= 400); await publicAttempt.text(); assert.equal(f.sent.length, 0);
});

test("fresh policy revocation during owner preparation wins before the receipt claim", async t => {
  const f = await setup(t), binding = await f.allocate(); let changed = false;
  f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
    if (!changed && new URL(request.url).pathname === "/authorization/snapshot") {
      changed = true; f.policy.enabled = false;
      await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    }
  };
  await rejects(f.dispatch(binding, "upload")); assert.equal(changed, true); assert.equal(f.sent.length, 0);
  assert.equal(f.row(binding).inputReceipt.state, "pending");
});

for (const change of ["header", "query", "path", "oversize"]) test(`${change} cannot escape fixed input dispatch preparation`, async t => {
  const f = await setup(t);
  if (change === "header") f.provider.adapter.injectHeaders = { "API-KEY": "synthetic-static-substitute" };
  if (change === "query") f.selection.endpoint.query = { redirect: "https://elsewhere.example" };
  if (change === "path") f.selection.endpoint.path = "/openapi/v2/elsewhere";
  if (change === "oversize") f.file.bytes = new Uint8Array(8 * 1024 * 1024 + 1);
  await rejects(f.allocate()); assert.equal(f.sent.length, 0);
});

test("another verified caller on the same policy cannot use the original job handle", async t => {
  const f = await setup(t), binding = await f.allocate();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "create", credentialId: "other", credential: { ...f.credential } });
  const headers = new Headers({ authorization: "Bearer clawrouter-live-other-fixture-secret" });
  const other = await authenticateProxyKey(headers, f.env, [{ id: "pixverse", tokenRef: "pixverse" }]);
  assert.ok(!(other instanceof Response));
  await rejects(getPixVerseInput(f.env, other, binding));
  await rejects(dispatchPixVerseInput(f.request, f.env, other, binding, plan, "upload", bytes));
  assert.equal(f.sent.length, 0);
});
