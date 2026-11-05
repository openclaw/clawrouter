import assert from "node:assert/strict";
import test from "node:test";
import { setup, override, body, wire, path, control } from "./managed-omni-runtime-fixture.mjs";
const { googleOmniVideos, prepareGoogleOmniFileControl, readGoogleOmniFileState, readGoogleOmniFile } = await import("../provider-google-omni-files.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const { managedFileLimit } = await import("../managed-files.ts");
const fileId = "fixture-video", filePath = `/v1/native/replicate/files/${fileId}`;
const fileHeaders = { "x-clawrouter-job-id": wire.pending.id };
const media = new Uint8Array([0, 255, 128, 7]);
const file = { id: fileId, mimeType: "video/mp4" };
const adminActor = { auth: "admin_token", email: "fixture@example.com", role: "admin" };

async function fixture(t, options = {}) {
  const f = await setup(t, options), create = f.provider.endpoints.find(e => e.id === "predictions");
  create.lifecycle.files = { metadata: "file", download: "download" };
  for (const [id, suffix, query] of [["file", "", {}], ["download", ":download", { alt: "media" }]]) {
    f.provider.endpoints.push({ ...structuredClone(f.provider.endpoints.find(e => e.id === "prediction")), id,
      path: "/files/${file_id}" + suffix, path_params: ["file_id"], query, headers: {}, methods: ["GET"],
      request_format: "fixture.file_" + id, response_format: id === "file" ? "fixture.file" : "fixture.bytes" });
  }
  // Actual source codecs behind the public Worker/controller seam. This does
  // not register a provider or claim that a shipped Google offer is activated.
  const wrapper = {
    protocol: "replicate.predictions",
    describe(observation, base) {
      return googleOmniVideos(observation.body, managedFileLimit).filter(video => video.kind === "file").map(video => {
        const target = prepareGoogleOmniFileControl("metadata", video, base);
        return { id: target.fileName.slice(6), mimeType: video.mimeType };
      });
    },
    identify(action, params, query) {
      assert.deepEqual(Object.keys(params), ["file_id"]);
      assert.match(params.file_id, /^[A-Za-z0-9_-]{1,128}$/);
      assert.deepEqual([...query], action === "metadata" ? [] : [["alt", "media"]]); return params.file_id;
    },
    control(action, endpoint, descriptor, base, state) {
      assert.equal(endpoint.method, "GET");
      assert.equal(endpoint.path, "/files/${file_id}" + (action === "download" ? ":download" : ""));
      assert.deepEqual(endpoint.query, action === "metadata" ? {} : { alt: "media" });
      const target = prepareGoogleOmniFileControl(action, { kind: "file", resource: "files/" + descriptor.id, mimeType: descriptor.mimeType }, base,
        state && { name: "files/" + state.id, state: state.status.toUpperCase(), ready: state.status === "active", failed: state.status === "failed" });
      const url = new URL(target.url);
      return { path: url.pathname.slice(new URL(base).pathname.replace(/\/$/, "").length), query: url.searchParams };
    },
    async readState(response, descriptor) {
      const state = await readGoogleOmniFileState(response, "files/" + descriptor.id);
      return { id: descriptor.id, status: state.state.toLowerCase(), body: { name: state.name, state: state.state } };
    },
    readFile(response, _descriptor, maxBytes) { return readGoogleOmniFile(response, maxBytes); },
    rewrite(input, paths) {
      const result = structuredClone(input);
      for (const step of result.steps ?? []) for (const video of step.content ?? []) {
        if (video.type === "video" && video.uri) {
          const descriptor = paths.find(p => video.uri.includes(p.id)); assert.ok(descriptor);
          video.uri = descriptor.download;
        }
      }
      return result;
    },
  };
  override(t, "files", wrapper);
  f.upstream = request => {
    if (request.method === "POST") return Response.json(wire.completed);
    if (request.url.includes(":download")) return new Response(media, { headers: { "content-type": "video/mp4", "content-length": String(media.length) } });
    if (request.url.includes("/files/")) return Response.json({ name: "files/" + fileId, state: "ACTIVE", mimeType: "video/mp4" });
    return Response.json(wire.retrieved);
  };
  f.fileCall = (route = filePath + ":download?alt=media", extra = {}) => f.call(route, null, { ...extra, headers: { ...fileHeaders, ...extra.headers } });
  f.wrapper = wrapper; return f;
}

for (const pooled of [false, true]) for (const store of [false, true]) test(`bound file delivery uses original ${pooled ? "pooled" : "environment"} credential after compaction, store=${store}`, async t => {
  const f = await fixture(t, { pooled }), created = await f.call(path, body({ store }));
  assert.equal(created.status, 200, await created.clone().text()); const state = f.state(created);
  assert.equal(created.headers.get("x-clawrouter-job-id"), wire.pending.id);
  assert.equal((await created.json()).steps.find(step => step.type === "model_output").content[0].uri, filePath + ":download?alt=media");
  assert.deepEqual(state.job().managed.files, [file]);
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const before = state.job(), response = await f.fileCall();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), media);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-clawrouter-job-id"), wire.pending.id);
  assert.equal(bodyBudgetCharged(), 0);
  const reads = f.sent.slice(1);
  assert.deepEqual(reads.map(r => r.url), ["https://generativelanguage.googleapis.com/v1beta/files/fixture-video", "https://generativelanguage.googleapis.com/v1beta/files/fixture-video:download?alt=media"]);
  assert.ok(reads.every(r => r.redirect === "manual" && r.headers.get("authorization") === (pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-environment-key") && !r.headers.has("x-clawrouter-job-id")));
  assert.deepEqual(state.job(), before); assert.equal((await f.events()).length, 1);
});

test("native and manifest metadata require the same original job; native URIs are not forwarded", async t => {
  const f = await fixture(t); await f.call(path, body({ store: true }));
  f.upstream = () => Response.json({ name: "files/" + fileId, state: "ACTIVE", uri: "https://untrusted.example/credential", downloadUri: "https://untrusted.example/data" });
  for (const route of [filePath, "/v1/proxy/replicate/file?file_id=" + fileId]) {
    const response = await f.fileCall(route); assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { name: "files/" + fileId, state: "ACTIVE" });
  }
  assert.equal(bodyBudgetCharged(), 0);
});

for (const scenario of ["missing-job", "other-job", "other-file", "other-caller", "query-key", "duplicate-alt", "route-change", "environment-key-change", "expired"]) test(`file ${scenario} fails before any file egress`, async t => {
  const f = await fixture(t), created = await f.call(path, body({ store: true })); assert.equal(created.status, 200);
  let route = filePath + ":download?alt=media", extra = {};
  if (scenario === "missing-job") extra.headers = { "x-clawrouter-job-id": "" };
  if (scenario === "other-job") extra.headers = { "x-clawrouter-job-id": "v1_another_job" };
  if (scenario === "other-file") route = route.replace(fileId, "unbound-file");
  if (scenario === "other-caller") extra.headers = { authorization: "Bearer invalid" };
  if (scenario === "query-key") route += "&key=synthetic";
  if (scenario === "duplicate-alt") route += "&alt=media";
  if (scenario === "route-change") f.provider.endpoints.find(e => e.id === "download").query.alt = "other";
  if (scenario === "environment-key-change") f.env.REPLICATE_API_TOKEN = "synthetic-replacement-key";
  if (scenario === "expired") f.advance(f.state(created).job().replayUntil - Date.now());
  const response = await f.fileCall(route, extra); assert.ok([400, 401, 403, 409, 503].includes(response.status), await response.text());
  assert.equal(f.sent.length, 1); assert.equal(bodyBudgetCharged(), 0);
});

for (const status of ["PROCESSING", "FAILED"]) test(`metadata ${status} performs no download and leaves the original charge untouched`, async t => {
  const f = await fixture(t), created = await f.call(path, body({})), before = f.state(created).job();
  f.upstream = () => Response.json({ name: "files/" + fileId, state: status });
  const response = await f.fileCall(); assert.equal(response.status, 409);
  assert.equal(response.headers.get("retry-after"), status === "PROCESSING" ? "5" : null);
  assert.equal((await response.json()).error.code, status === "PROCESSING" ? "managed_file_processing" : "managed_file_failed");
  assert.equal(f.sent.length, 2); assert.deepEqual(f.state(created).job(), before); assert.equal(bodyBudgetCharged(), 0);
});

for (const change of ["caller", "grant"]) test(`fresh ${change} revocation between metadata and download prevents content egress`, async t => {
  const f = await fixture(t, { pooled: true }); await f.call(path, body({})); const upstream = f.upstream; let changed = false;
  f.upstream = async request => {
    if (!request.url.includes(":download")) {
      if (change === "caller") {
        const result = await (await f.authority("/credentials/mutate", { scope: "admin", actor: adminActor, operation: "revoke", credentialId: "fixture" })).json();
        assert.equal(result.outcome, "updated");
      }
      else await putGrantCredentials(f.env, "oauth/fixture/replicate", { provider: "replicate", kind: "api_key", enabled: true, credential: "synthetic-replacement-key" });
      changed = true;
    }
    return upstream(request);
  };
  const response = await f.fileCall(); assert.ok([401, 403, 409, 502, 503].includes(response.status), await response.text());
  assert.equal(changed, true, "the authority mutation must commit before this test can prove revocation");
  assert.equal(f.sent.length, 2); assert.equal(bodyBudgetCharged(), 0);
});

for (const malformed of ["redirect", "wrong-id", "truncated", "oversized", "partial", "html", "wrong-mime", "metadata-oversized"]) test(`file ${malformed} is never delivered or used to refund generation`, async t => {
  const f = await fixture(t), created = await f.call(path, body({})), before = f.state(created).job(), upstream = f.upstream;
  f.upstream = request => {
    if (malformed === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.example/asset" } });
    if (malformed === "wrong-id") return Response.json({ name: "files/another", state: "ACTIVE" });
    if (malformed === "metadata-oversized") return Response.json({ name: "files/" + fileId, state: "ACTIVE", unused: "x".repeat(65536) });
    if (!request.url.includes(":download")) return upstream(request);
    if (malformed === "oversized") return new Response(new Uint8Array(managedFileLimit + 1), { headers: { "content-type": "video/mp4" } });
    return new Response(media, { status: malformed === "partial" ? 206 : 200, headers: { "content-type": malformed === "html" ? "text/html" : malformed === "wrong-mime" ? "video/webm" : "video/mp4", "content-length": malformed === "truncated" ? "999" : String(media.length) } });
  };
  const response = await f.fileCall(); assert.equal(response.status, 502, await response.clone().text());
  assert.deepEqual(f.state(created).job(), before); assert.equal(bodyBudgetCharged(), 0);
  assert.ok(f.sent.every(r => new URL(r.url).hostname === "generativelanguage.googleapis.com"));
});

test("caller cancellation cancels the held source reader and releases file capacity", { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.call(path, body({})); const controller = new AbortController(); let cancel = false, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.upstream = () => new Response(new ReadableStream({ start() { entered(); }, cancel() { cancel = true; } }), { headers: { "content-type": "application/json" } });
  const pending = f.fileCall(undefined, { signal: controller.signal });
  await Promise.race([ready, pending.then(async response => assert.fail(`file read ended before source entry: ${response.status} ${await response.text()}`))]); controller.abort();
  const response = await pending; assert.equal(response.status, 499); await Promise.resolve();
  assert.equal(cancel, true); assert.equal(bodyBudgetCharged(), 0); assert.equal(f.sent.length, 2);
});

test("collector qualifies and binds the original selected-origin file before publication", async t => {
  const f = await fixture(t); f.upstream = request => Response.json(request.method === "POST" ? wire.pending : wire.completed);
  const created = await f.call(path, body({ store: true, background: true })), state = f.state(created);
  f.advance(5000); await state.alarm(); assert.deepEqual(state.job().managed.files, [file]);
  assert.equal((await f.call(control, null)).status, 200); await state.alarm(); await f.drain(); assert.equal((await f.events()).length, 1);
});

test("unqualified result origins keep the known job binding but expose no file or replay", async t => {
  const f = await fixture(t), payload = structuredClone(wire.completed);
  payload.steps.find(step => step.type === "model_output").content[0].uri = "https://other.example/v1beta/files/fixture-video";
  f.upstream = () => Response.json(payload);
  const created = await f.call(path, body({ store: true }), { headers: { "Idempotency-Key": "bad-origin" } });
  assert.equal(created.status, 503); const state = f.state(created);
  assert.equal(state.job().managed.upstreamId, wire.pending.id); assert.equal(state.job().managed.files, undefined);
  assert.equal((await f.fileCall()).status, 409); assert.equal(f.sent.length, 1);
});

for (const change of ["missing-wrapper", "private-base", "internal-base"]) test(`${change} fails before generation dispatch or reservation`, async t => {
  const f = await fixture(t);
  if (change === "missing-wrapper") override(t, "files", undefined);
  else f.provider.base_urls.default = change === "private-base" ? "https://127.0.0.1/v1beta" : "https://service.internal/v1beta";
  const response = await f.call(path, body({})); assert.ok([400, 409, 503].includes(response.status), await response.text());
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

test("file grants must permit both linked endpoints before paid creation", async t => {
  const f = await fixture(t);
  const { grantSupports } = await import("../provider-auth.ts");
  const create = f.provider.endpoints.find(e => e.id === "predictions");
  f.provider.auth.grantTransports.api_key = { allowedEndpoints: ["predictions", "prediction", "prediction_cancel"], endpointPaths: {} };
  const requirement = { provider: f.provider, endpoint: create, mode: "http", managedLifecycle: true };
  assert.equal(grantSupports(requirement, { kind: "api_key" }), false);
  f.provider.auth.grantTransports.api_key.allowedEndpoints.push("file", "download");
  assert.equal(grantSupports(requirement, { kind: "api_key" }), true);
});

test("canceling returned bytes releases the bounded allocation", async t => {
  const f = await fixture(t); await f.call(path, body({}));
  const response = await f.fileCall(); assert.equal(response.status, 200);
  assert.ok(bodyBudgetCharged() > 0); await response.body.cancel(); assert.equal(bodyBudgetCharged(), 0);
});

test("another valid credential in the same policy cannot claim the original caller's file", async t => {
  const f = await fixture(t); await f.call(path, body({}));
  const result = await (await f.authority("/credentials/mutate", { scope: "admin", actor: adminActor, operation: "create", credentialId: "other", credential: { ...f.credential } })).json();
  assert.equal(result.outcome, "updated");
  const response = await f.fileCall(undefined, { headers: { authorization: "Bearer clawrouter-live-other-fixture-secret" } });
  assert.equal(response.status, 409, await response.clone().text()); assert.equal(f.sent.length, 1);
});

test("two owned jobs still cannot borrow each other's output descriptor", async t => {
  const f = await fixture(t); await f.call(path, body({}));
  const second = structuredClone(wire.completed); second.id = "v1_second";
  second.steps.find(step => step.type === "model_output").content[0].uri = "files/second-video";
  f.upstream = () => Response.json(second);
  assert.equal((await f.call(path, body({}))).status, 200);
  const response = await f.fileCall("/v1/native/replicate/files/second-video:download?alt=media");
  assert.equal(response.status, 409); assert.equal(f.sent.length, 2);
});

test("metadata cannot reset the one file-delivery deadline", async t => {
  const f = await fixture(t), created = await f.call(path, body({})), before = f.state(created).job();
  f.upstream = () => { f.advance(30_000); return Response.json({ name: "files/" + fileId, state: "ACTIVE" }); };
  const response = await f.fileCall(); assert.equal(response.status, 409);
  assert.equal(f.sent.length, 2); assert.equal(bodyBudgetCharged(), 0); assert.deepEqual(f.state(created).job(), before);
});

for (const phase of ["metadata", "download"]) for (const first of ["read", "cancel"]) for (const cleanupRejects of [false, true]) {
  test(`managed ${phase} abort holds original read and first cleanup (${first}, rejection=${cleanupRejects})`, { timeout: 5000 }, async t => {
    const f = await fixture(t); await f.call(path, body({})); const upstream = f.upstream, caller = new AbortController();
    const started = Promise.withResolvers(), readAck = Promise.withResolvers(), cancelAck = Promise.withResolvers(), cancelStarted = Promise.withResolvers();
    let cancels = 0, unlocks = 0, drained = false;
    const source = new ReadableStream({ pull() { started.resolve(); }, async cancel() {
      cancels++; cancelStarted.resolve(); await cancelAck.promise; if (cleanupRejects) throw new Error("synthetic cleanup failure");
    } }, { highWaterMark: 0 });
    const acquire = source.getReader.bind(source);
    source.getReader = () => { const reader = acquire(); return {
      async read() { try { return await reader.read(); } finally { await readAck.promise; } },
      cancel: reason => reader.cancel(reason), releaseLock() { unlocks++; reader.releaseLock(); },
    }; };
    f.upstream = request => phase === "download" && !request.url.includes(":download") ? upstream(request)
      : new Response(source, { headers: { "content-type": phase === "metadata" ? "application/json" : "video/mp4" } });
    try {
      const pending = f.fileCall(undefined, { signal: caller.signal }); await started.promise; caller.abort();
      const response = await pending; assert.equal(response.status, 499); await response.text(); await cancelStarted.promise;
      const retirement = f.drain().then(() => { drained = true; });
      assert.equal(bodyBudgetCharged(), 32 * 1024 * 1024); assert.equal(source.locked, true); assert.equal(cancels, 1);
      const { BodyLease } = await import("../body-budget.ts"); const contender = new BodyLease();
      assert.equal(contender.grow(33 * 1024 * 1024), false); contender.release();
      (first === "read" ? readAck : cancelAck).resolve(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(drained, false); assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), 32 * 1024 * 1024);
      (first === "read" ? cancelAck : readAck).resolve(); await retirement;
      assert.equal(bodyBudgetCharged(), 0); assert.equal(source.locked, false); assert.equal(unlocks, 1); assert.equal(cancels, 1);
      assert.equal(f.sent.length, phase === "metadata" ? 2 : 3); assert.equal((await f.events()).length, 1);
    } finally { readAck.resolve(); cancelAck.resolve(); }
  });
}

for (const phase of ["metadata", "download"]) test(`managed ${phase} adapter completion remains owned after original EOF`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.call(path, body({})); const caller = new AbortController();
  const parsed = Promise.withResolvers(), release = Promise.withResolvers(); let drained = false;
  const method = phase === "metadata" ? "readState" : "readFile", original = f.wrapper[method];
  f.wrapper[method] = async (...args) => { const value = await original(...args); parsed.resolve(); await release.promise; return value; };
  try {
    const pending = f.fileCall(undefined, { signal: caller.signal }); await parsed.promise; caller.abort();
    const response = await pending; assert.equal(response.status, 499); await response.text();
    const retirement = f.drain().then(() => { drained = true; });
    assert.equal(bodyBudgetCharged(), 32 * 1024 * 1024); await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    release.resolve(); await retirement; assert.equal(bodyBudgetCharged(), 0);
    assert.equal(f.sent.length, phase === "metadata" ? 2 : 3); assert.equal((await f.events()).length, 1);
  } finally { release.resolve(); }
});

for (const phase of ["metadata", "download"]) test(`managed late ${phase} response keeps capacity until original cleanup`, { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.call(path, body({})); const upstream = f.upstream, caller = new AbortController();
  const started = Promise.withResolvers(), reply = Promise.withResolvers(), cancelStarted = Promise.withResolvers(), cleanup = Promise.withResolvers();
  let cancels = 0, drained = false;
  f.upstream = request => { if (phase === "download" && !request.url.includes(":download")) return upstream(request); started.resolve(); return reply.promise; };
  const source = new ReadableStream({ async cancel() { cancels++; cancelStarted.resolve(); await cleanup.promise; } }, { highWaterMark: 0 });
  try {
    const pending = f.fileCall(undefined, { signal: caller.signal }); await started.promise; caller.abort();
    const response = await pending; assert.equal(response.status, 499); await response.text();
    const retirement = f.drain().then(() => { drained = true; }); assert.equal(bodyBudgetCharged(), 32 * 1024 * 1024);
    reply.resolve(new Response(source, { headers: { "content-type": phase === "metadata" ? "application/json" : "video/mp4" } })); await cancelStarted.promise;
    assert.equal(drained, false); assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), 32 * 1024 * 1024);
    cleanup.resolve(); await retirement;
    assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0); assert.equal((await f.events()).length, 1);
  } finally { reply.resolve(new Response(null)); cleanup.resolve(); }
});
