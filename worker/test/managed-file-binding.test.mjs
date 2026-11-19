import assert from "node:assert/strict";
import test from "node:test";
import { setup, adapter, override, body, wire, path, control } from "./managed-omni-runtime-fixture.mjs";
const { googleOmniVideos, prepareGoogleOmniFileControl } = await import("../provider-google-omni-files.ts");
const { backgroundCall } = await import("../http-background.ts");
const file = { id: "fixture-video", mimeType: "video/mp4" };
async function filesFixture(t, options = {}) {
  const f = await setup(t, options), read = adapter.read;
  override(t, "read", async (response, context) => {
    const observation = await read(response, context);
    if (observation.terminal === "succeeded") {
      // Source codec/descriptor qualification uses the selected original base.
      // Registration and file network dispatch remain a separate owned slice.
      observation.files = googleOmniVideos(observation.body, 16 * 1024 * 1024).filter(video => video.kind === "file").map(video => {
        const descriptor = prepareGoogleOmniFileControl("metadata", video, f.provider.base_urls.default);
        return { id: descriptor.fileName.slice("files/".length), mimeType: video.mimeType };
      });
    }
    return observation;
  });
  f.upstream = () => Response.json(wire.completed);
  return f;
}
function scoped(f, response) {
  const state = f.state(response), scope = "http-continuations:" + response.headers.get("x-clawrouter-background-recovery").split(".")[0];
  return { ...state, call: input => backgroundCall(f.env, scope, { action: "managed_files", id: state.id, responseId: wire.pending.id, ...input }) };
}

for (const origin of ["create", "public", "collector"]) test(`${origin} binds source-qualified output before delivery and preserves URI identity through inline GET/compaction`, async t => {
  const f = await filesFixture(t, { pooled: true });
  if (origin !== "create") f.upstream = request => Response.json(request.method === "POST" ? wire.pending : wire.completed);
  const created = await f.call(path, body({ background: true, store: true })); assert.equal(created.status, 200, await created.clone().text()); const state = scoped(f, created);
  if (origin === "public") assert.equal((await f.call(control, null)).status, 200);
  if (origin === "collector") { f.advance(5000); await state.alarm(); }
  assert.deepEqual(state.job().managed.files, [file]); assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal(state.job().phase, "complete"); const before = state.job();
  f.upstream = () => Response.json(wire.retrieved);
  assert.equal((await f.call(control, null)).status, 200); assert.deepEqual(state.job(), before, "inline output cannot erase the previously bound file");
  assert.deepEqual(await state.call({ files: [file, file] }), { files: [file] }); assert.deepEqual(state.job(), before);
  assert.equal((await f.events()).length, 1); assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original-key"));
});

test("a later qualified descriptor joins the same succeeded job without changing its frozen accounting", async t => {
  const f = await filesFixture(t), created = await f.call(path, body({ store: true })), state = scoped(f, created);
  await state.alarm(); await f.drain(); const before = state.job(); assert.equal(before.phase, "complete");
  f.upstream = () => Response.json({ ...wire.completed, steps: [{ type: "model_output", content: [{ type: "video", uri: "files/second-video" }] }] });
  assert.equal((await f.call(control, null)).status, 200);
  const after = state.job(); assert.deepEqual(after.managed.files, [file, { id: "second-video", mimeType: "video/mp4" }]);
  delete after.managed.files; delete before.managed.files; assert.deepEqual(after, before);
  await state.call({ files: [], outcome: { billable: false }, predictionStatus: "failed", statusCode: 500 });
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700); assert.equal((await f.events()).length, 1);
});

test("binding is scoped to the original native job and never publishes URL/credential/content metadata", async t => {
  const f = await filesFixture(t), created = await f.call(path, body({ store: true })), state = scoped(f, created), before = state.job();
  await assert.rejects(state.call({ responseId: "other-job", files: [file] }), error => error.code === "managed_files_unavailable");
  await assert.rejects(backgroundCall(f.env, "http-continuations:" + "f".repeat(64), { action: "managed_files", id: state.id, responseId: wire.pending.id, files: [file] }), error => error.code === "managed_files_unavailable");
  for (const entry of [{ ...file, id: "files/other" }, { ...file, id: "https://other.example/file" }, { ...file, id: "../file" }, { ...file, id: "x?key=synthetic" }, { ...file, id: "x".repeat(129) }, { ...file, mimeType: "text/html" }, { ...file, prompt: "synthetic private input" }, { ...file, key: "synthetic private credential" }]) {
    await assert.rejects(state.call({ files: [entry] }), error => error.code === "managed_files_invalid");
  }
  await assert.rejects(state.call({ files: [{ ...file, mimeType: "video/webm" }] }), error => error.code === "managed_file_conflict");
  assert.deepEqual(state.job(), before);
});

test("bounded immutable descriptors reject overflow without partial insertion, then expire at the original retention deadline", async t => {
  const f = await filesFixture(t), created = await f.call(path, body({ store: true })), state = scoped(f, created);
  const entries = Array.from({ length: 63 }, (_, n) => ({ id: `file-${n}`, mimeType: "video/mp4" }));
  assert.equal((await state.call({ files: entries })).files.length, 64); const before = state.job();
  await assert.rejects(state.call({ files: [{ id: "one-too-many", mimeType: "video/mp4" }] }), error => error.code === "managed_files_invalid");
  assert.deepEqual(state.job(), before);
  f.advance(before.replayUntil - Date.now());
  await assert.rejects(state.call({ files: [file] }), error => error.code === "managed_files_unavailable");
});

for (const status of ["in_progress", "failed", "cancelled", "requires_action"]) test(`${status} cannot claim succeeded-job files or rewrite settlement`, async t => {
  const f = await filesFixture(t); f.upstream = () => Response.json({ ...wire.pending, status });
  const created = await f.call(path, body({ background: true, store: true })); assert.equal(created.status, status === "requires_action" ? 410 : 200);
  const state = scoped(f, created), before = state.job();
  await assert.rejects(state.call({ files: [file] }), error => error.code === "managed_files_unavailable"); assert.deepEqual(state.job(), before);
});

test("file write failure rolls back terminal receipt and closed binding before any output delivery", async t => {
  const f = await filesFixture(t);
  f.env.ACCESS_CONTROL.beforeFetch = async (scope, request) => {
    if (new URL(request.url).pathname !== "/responses-background" || (await request.clone().json()).action !== "managed_observe") return;
    f.env.ACCESS_CONTROL.objects.get(scope).db.exec("CREATE TRIGGER reject_files BEFORE UPDATE ON responses_background WHEN json_extract(NEW.job_json, '$.managed.files') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture file refusal'); END");
    f.env.ACCESS_CONTROL.beforeFetch = null;
  };
  const created = await f.call(path, body({ store: true })); assert.equal(created.status, 503); const state = scoped(f, created);
  assert.equal(state.job().event, null); assert.equal(state.job().managed.terminal, null); assert.equal(state.job().managed.files, undefined);
  assert.equal(state.state.db.prepare("SELECT background_closed FROM http_continuations WHERE background_job_id = ?").get(state.id).background_closed, 0);
  state.state.db.exec("DROP TRIGGER reject_files");
  assert.equal((await f.call(control, null)).status, 200); assert.deepEqual(state.job().managed.files, [file]);
  await state.alarm(); await f.drain(); assert.equal((await f.events()).length, 1); assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

test("a lost observation ACK keeps the committed file/receipt and retries only local ownership", async t => {
  const f = await filesFixture(t), get = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL); let lose = true;
  t.mock.method(f.env.ACCESS_CONTROL, "get", name => {
    const stub = get(name);
    return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (lose && new URL(url).pathname === "/responses-background" && JSON.parse(init.body).action === "managed_observe") { lose = false; return new Response("fixture lost ACK", { status: 503 }); }
      return response;
    } };
  });
  const input = body({ store: true }), headers = { "Idempotency-Key": "file-ack" };
  const created = await f.call(path, input, { headers }); assert.equal(created.status, 503); const state = scoped(f, created);
  assert.deepEqual(state.job().managed.files, [file]); assert.equal(state.job().amount, 700);
  f.restart(); assert.equal((await f.call(path, input, { headers })).status, 303); assert.equal(f.sent.length, 1);
  f.upstream = () => Response.json(wire.retrieved); assert.equal((await f.call(control, null)).status, 200); assert.deepEqual(state.job().managed.files, [file]);
  await state.alarm(); await f.drain(); assert.equal((await f.events()).length, 1);
});
