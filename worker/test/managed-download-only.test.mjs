import assert from "node:assert/strict";
import test from "node:test";
import { fixture, contract, path, grantKey } from "./managed-runtime-fixture.mjs";
import { override } from "./managed-omni-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { readOpenRouterVideoContent } = await import("../openrouter-video.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const { managedFileRoute } = await import("../managed-files.ts");
const { grantSupports } = await import("../provider-auth.ts");
const id = contract.responses.succeeded.id, contentPath = `${path}/${id}/content?index=0`;
const media = new Uint8Array([0, 255, 128, 7]), descriptor = { id, mimeType: "video/mp4" };

async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, configure(provider) {
    const create = provider.endpoints.find(endpoint => endpoint.id === "predictions");
    create.lifecycle.files = { mode: "download_only", download: "content" };
    provider.endpoints.push({ ...structuredClone(provider.endpoints.find(endpoint => endpoint.id === "prediction")), id: "content",
      path: "/v1/predictions/${prediction_id}/content", query: { index: "0" }, headers: {},
      request_format: "fixture.file_download", response_format: "fixture.file_bytes" });
  } });
  // Synthetic adapter seam: exercise common ownership and the published content
  // reader without registering or duplicating the source owner's video wrapper.
  const wrapper = {
    protocol: "replicate.predictions", mode: "download_only",
    describe(observation) { return [{ id: observation.id, mimeType: "video/mp4" }]; },
    identify(action, params, query) {
      assert.equal(action, "download"); assert.deepEqual(Object.keys(params), ["prediction_id"]);
      assert.match(params.prediction_id, /^[A-Za-z0-9_-]{1,128}$/);
      assert.deepEqual([...query], [["index", "0"]]); return params.prediction_id;
    },
    control(action, endpoint, file, base, state) {
      assert.equal(action, "download"); assert.equal(state, undefined);
      assert.equal(endpoint.path, "/v1/predictions/${prediction_id}/content"); assert.equal(endpoint.method, "GET");
      assert.equal(base, "https://api.replicate.com"); assert.deepEqual(endpoint.query, { index: "0" });
      return { path: `/v1/predictions/${file.id}/content`, query: new URLSearchParams({ index: "0" }) };
    },
    async readFile(response, file, maxBytes) {
      const value = await readOpenRouterVideoContent(response, new AbortController().signal);
      assert.equal(value.mimeType, file.mimeType); assert.ok(value.video.byteLength <= maxBytes); return value.video;
    },
    rewrite(body, paths) {
      for (const entry of paths) assert.equal(Object.hasOwn(entry, "metadata"), false);
      return { ...body, content_url: paths[0]?.download };
    },
  };
  override(t, "files", wrapper);
  f.upstream = request => request.method === "POST" ? Response.json(contract.responses.succeeded)
    : new Response(media, { headers: { "content-type": "video/mp4", "content-length": String(media.length) } });
  f.fileCall = (manifest = false, extra = {}) => f.call(manifest ? `/v1/proxy/replicate/content?prediction_id=${id}&index=0` : contentPath,
    null, { ...extra, headers: { "x-clawrouter-job-id": id, ...extra.headers } });
  f.create = async () => {
    const response = await f.call();
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.clone().text());
    return response;
  };
  f.wrapper = wrapper; t.after(f.drain); return f;
}
async function read(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const pooled of [false, true]) for (const manifest of [false, true]) {
  test(`download-only ${pooled ? "pooled" : "environment"} ${manifest ? "manifest" : "native"} uses original succeeded job after compaction without metadata or new accounting`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled }), created = await f.create(), state = f.state(created);
    assert.equal((await read(created)).content_url, contentPath); assert.deepEqual(state.job().managed.files, [descriptor]);
    f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
    assert.equal(state.job().phase, "complete"); const before = state.job(), calls = f.budgetCalls.length;
    const response = await f.fileCall(manifest); assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), media);
    assert.equal(response.headers.get("content-type"), "video/mp4"); assert.equal(response.headers.get("x-clawrouter-job-id"), id);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(f.sent.map(request => request.url), ["https://api.replicate.com/v1/predictions", `https://api.replicate.com/v1/predictions/${id}/content?index=0`]);
    const request = f.sent[1]; assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-environment-key");
    assert.equal(request.headers.get("x-clawrouter-job-id"), null);
    assert.deepEqual(state.job(), before); assert.equal(f.budgetCalls.length, calls); assert.equal((await f.events()).length, 1);
    assert.equal(bodyBudgetCharged(), 0);
  });
}

for (const scenario of ["missing-job", "other-job", "other-caller", "unbound-file", "expired", "rotated-grant", "changed-route", "changed-mode"]) {
  test(`download-only ${scenario} denies before any content fetch`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { pooled: true }), created = await f.create(), state = f.state(created); await read(created);
    let route = contentPath, headers = { "x-clawrouter-job-id": id };
    if (scenario === "missing-job") headers = {};
    if (scenario === "other-job") headers["x-clawrouter-job-id"] = "other-job";
    if (scenario === "unbound-file") route = route.replace(id, "unbound-file");
    if (scenario === "other-caller") {
      await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "create", credentialId: "second", credential: f.credential });
      headers.authorization = "Bearer clawrouter-live-second-fixture-secret";
    }
    if (scenario === "expired") f.advance(state.job().replayUntil - Date.now());
    if (scenario === "rotated-grant") await putGrantCredentials(f.env, grantKey, { provider: "replicate", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
    if (scenario === "changed-route") f.provider.endpoints.find(endpoint => endpoint.id === "content").path = "/other/${prediction_id}";
    if (scenario === "changed-mode") delete f.provider.endpoints.find(endpoint => endpoint.id === "predictions").lifecycle.files.mode;
    const response = await f.call(route, null, { headers }), failure = await response.json();
    if (scenario === "rotated-grant") {
      assert.equal(response.status, 502); assert.equal(failure.error.code, "managed_file_unavailable");
    } else assert.ok([400, 403, 404, 409, 503].includes(response.status), JSON.stringify(failure));
    assert.doesNotMatch(JSON.stringify(failure), /synthetic-original-key|synthetic-replacement/);
    assert.equal(f.sent.length, 1); if (scenario === "rotated-grant") await f.drain(); assert.equal(bodyBudgetCharged(), 0);
  });
}

for (const status of ["starting", "failed", "canceled", "aborted"]) {
  test(`download-only ${status} job cannot claim a completed file`, { timeout: 10_000 }, async t => {
    const f = await setup(t); f.upstream = () => Response.json({ ...contract.responses.created, id, status,
      ...(status === "failed" ? { error: "synthetic failure" } : {}) });
    const created = await f.create(); await read(created); const state = f.state(created);
    assert.equal(state.job().managed.files, undefined);
    await read(await f.fileCall(), 409); assert.equal(f.sent.length, 1);
  });
}

test("download-only links and adapters must agree; polling cannot masquerade as file metadata or content", { timeout: 10_000 }, async t => {
  const f = await setup(t), create = f.provider.endpoints.find(endpoint => endpoint.id === "predictions");
  const links = structuredClone(create.lifecycle.files);
  for (const files of [{ mode: "download_only", metadata: "prediction", download: "content" }, { mode: "download_only", download: "prediction" },
    { mode: "unknown", download: "content" }, { download: "content" }, { metadata: "prediction", download: "content" }]) {
    create.lifecycle.files = files; assert.throws(() => managedFileRoute(f.provider, create), error => error.code === "managed_file_owner_unavailable");
  }
  create.lifecycle.files = links; f.wrapper.readState = () => { throw new Error("unexpected metadata"); };
  assert.throws(() => managedFileRoute(f.provider, create)); delete f.wrapper.readState;
  assert.equal(managedFileRoute(f.provider, create).endpoints.metadata, undefined);
  assert.equal(f.sent.length, 0);
});

for (const failure of ["expired-content", "redirect", "mime", "range", "length", "overflow", "interrupted"]) {
  test(`download-only ${failure} leaves the frozen generation charge unchanged and never returns a prefix`, { timeout: 10_000 }, async t => {
    const f = await setup(t), created = await f.create(), state = f.state(created); await read(created); await state.alarm(); await f.drain();
    const before = state.job();
    f.upstream = () => {
      if (failure === "expired-content") return new Response("synthetic expired output", { status: 404 });
      if (failure === "redirect") return new Response(null, { status: 302, headers: { location: "https://unbound.example/content" } });
      const headers = { "content-type": failure === "mime" ? "text/html" : "video/mp4" };
      if (failure === "range") headers["content-range"] = "bytes 0-3/100";
      if (failure === "length") headers["content-length"] = "100";
      if (failure === "overflow") return new Response(new Uint8Array(16 * 1024 * 1024 + 1), { headers });
      if (failure === "interrupted") return new Response(new ReadableStream({ start(controller) { controller.enqueue(media); controller.error(new Error("synthetic lost EOF")); } }), { headers });
      return new Response(media, { headers });
    };
    const response = await f.fileCall(); await read(response, 502);
    assert.deepEqual(state.job(), before); assert.equal(before.amount, 700); assert.equal(before.basis, "policy_fixed");
    assert.equal((await f.events()).length, 1); assert.equal(f.sent.length, 2); assert.equal(bodyBudgetCharged(), 0);
  });
}

test("download-only cancellation interrupts the source reader without replay or generation refund", { timeout: 10_000 }, async t => {
  const f = await setup(t), created = await f.create(), state = f.state(created); await read(created); await state.alarm(); await f.drain();
  const before = state.job(), reached = Promise.withResolvers(), abort = new AbortController(); let canceled = false;
  f.upstream = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(media); reached.resolve(); }, cancel() { canceled = true; } }), { headers: { "content-type": "video/mp4" } });
  const pending = f.fileCall(false, { signal: abort.signal }); await reached.promise; abort.abort();
  const response = await pending; await response.text(); assert.ok([499, 502].includes(response.status));
  assert.equal(canceled, true); assert.equal(f.sent.length, 2); assert.deepEqual(state.job(), before);
  assert.equal((await f.events()).length, 1); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
});

test("download-only credential qualification checks actual content links and retains transport allowlists", { timeout: 10_000 }, async t => {
  const f = await setup(t), create = f.provider.endpoints.find(endpoint => endpoint.id === "predictions");
  const requirement = { provider: f.provider, endpoint: create, mode: "http", managedLifecycle: true };
  const grant = { kind: "api_key" };
  f.provider.auth.grantTransports.api_key = { allowedEndpoints: ["predictions", "prediction", "prediction_cancel", "content"] };
  assert.equal(grantSupports(requirement, grant), true, "the mode discriminator is not an endpoint");
  f.provider.auth.grantTransports.api_key.allowedEndpoints.pop();
  assert.equal(grantSupports(requirement, grant), false, "the original credential must permit content delivery");
  delete f.provider.auth.grantTransports.api_key;
  f.provider.endpoints = f.provider.endpoints.filter(endpoint => endpoint.id !== "content");
  assert.equal(grantSupports(requirement, null), false, "environment credentials cannot excuse a missing content link");
});
