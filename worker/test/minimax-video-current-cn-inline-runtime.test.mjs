import assert from "node:assert/strict";
import test from "node:test";
import { setup, native, poll, grantKey, actor, videoInput, mp4 } from "./minimax-video-runtime-fixture.mjs";
import { inlineImage, uri } from "./minimax-video-inline-fixture.mjs";
import { miniMaxCurrentCnInlineVideoBinding, miniMaxCurrentCnVideoBinding, miniMaxFrozenVideoModels, miniMaxT2VModels } from "../../shared/minimax-video-binding.ts";
const { inspectGrantCredentials, revokeGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const image = uri(inlineImage("image/png", 1024)), origin = "https://api.minimax.cn";
const input = model => ({ ...videoInput(model), resolution: model.startsWith("I2V-") ? "720P" : "768P", first_frame_image: image });
const send = (f, manifest, body, key) => f.invoke(manifest ? "/v1/proxy/minimax/video" : native,
  manifest ? { body: { ...body, model: "minimax/" + body.model } } : body, key ? { headers: { "idempotency-key": key } } : {});
async function ready(t) { const f = await setup(t, { models: miniMaxFrozenVideoModels }); await f.put({}, miniMaxCurrentCnInlineVideoBinding()); return f; }
async function read(response, status = 200) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text); }
async function denied(f, response, secrets = true) {
  const text = await response.text(); assert.ok(response.status >= 400, text); await f.drain();
  assert.equal(f.sent.length, 0); if (secrets) assert.equal(f.materializations, 0); assert.equal(bodyBudgetCharged(), 0);
}

for (const model of miniMaxFrozenVideoModels) for (const manifest of [false, true]) {
  test(`V5 ${model}/${manifest}: missing private image and inconsistent shape deny before secrets`, async t => {
    const f = await ready(t), value = input(model), { first_frame_image: _image, ...missing } = value;
    for (const invalid of [missing, { ...missing, first_frame_image_id: "untrusted-handle" },
      { ...value, first_frame_image: "https://media.example/never-fetch" }, { ...value, first_frame_image: "uploaded-handle" },
      { ...value, duration: 5 }, { ...value, prompt: 7 }, { ...value, prompt: "x".repeat(2001) },
      { ...value, resolution: model.startsWith("I2V-") ? "1080P" : "512P" }])
      await denied(f, await send(f, manifest, invalid));
    if (!miniMaxT2VModels.includes(model)) delete value.prompt;
    const response = await send(f, manifest, value); await read(response); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(new URL(f.sent[0].url).origin, origin); assert.equal(bodyBudgetCharged(), 0);
  });
  for (const qualification of ["v4", "import"]) test(`V5 ${model}/${manifest} cannot borrow ${qualification} authority`, async t => {
    const f = await setup(t, { models: miniMaxFrozenVideoModels, qualify: false });
    if (qualification === "v4") await f.put({}, miniMaxCurrentCnVideoBinding());
    else { await f.put({ minimaxVideoBinding: miniMaxCurrentCnInlineVideoBinding() });
      assert.equal(secretlessGrant({ provider: "minimax", minimaxVideoBinding: miniMaxCurrentCnInlineVideoBinding() }).minimaxVideoBinding, null); }
    await denied(f, await send(f, manifest, input(model)));
  });
}

for (const manifest of [false, true]) test(`V5 current unknown tariff before first authoritative snapshot/${manifest}`, async t => {
  const f = await ready(t), get = f.env.ACCESS_CONTROL.get; let changed = false;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    if (new URL(url).pathname === "/authorization/snapshot" && !changed) {
      changed = true; f.policy.requestCostMicros = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    }
    return stub.fetch(url, init);
  } }; };
  await denied(f, await send(f, manifest, input(miniMaxFrozenVideoModels[0]))); assert.equal(changed, true);
});

for (const change of ["revoke", "rotate", "account", "expire", "v4"]) test(`V5 final policy wait then ${change} prevents stale image POST`, async t => {
  const f = await ready(t); if (change === "expire") await f.put({ expiresAt: new Date(Date.now() + 5000).toISOString() }, miniMaxCurrentCnInlineVideoBinding());
  const get = f.env.ACCESS_CONTROL.get; let count = 0;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/authorization/snapshot" && ++count === 3) {
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, undefined, undefined, actor);
      else if (change === "expire") f.advance(5001);
      else await f.put(change === "rotate" ? { credential: "synthetic-cn-inline-rotation" } : change === "account" ? { accountId: "synthetic-rebound-account" } : {},
        change === "v4" ? miniMaxCurrentCnVideoBinding() : miniMaxCurrentCnInlineVideoBinding());
    }
    return response;
  } }; };
  await denied(f, await send(f, false, input(miniMaxFrozenVideoModels[0])), false); assert.equal(count, 3);
});

for (const manifest of [false, true]) test(`V5 content and model digest fences survive CREATE retirement/${manifest}`, async t => {
  const f = await ready(t), body = input("MiniMax-Hailuo-2.3"), upstream = f.upstream; let sent;
  f.upstream = async request => { if (request.method === "POST") sent = await request.json(); return upstream(request); };
  const created = await send(f, manifest, body, "cn-inline"), job = f.state(created); await read(created); await f.drain();
  assert.deepEqual(sent, body); assert.equal(bodyBudgetCharged(), 0);
  await read(await send(f, manifest, body, "cn-inline"), 303); await f.drain();
  for (const changed of [{ ...body, first_frame_image: uri(inlineImage("image/png", 1025)) }, input("MiniMax-Hailuo-02")]) {
    await read(await send(f, manifest, changed, "cn-inline"), 409); await f.drain();
  }
  f.restart(); const terminal = await read(await f.invoke(poll, null)); await f.drain();
  const file = await f.invoke(terminal.video_url, null, { headers: { "x-clawrouter-job-id": terminal.task_id } });
  assert.equal(file.status, 200); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), mp4()); await f.drain();
  assert.equal(f.sent.filter(r => r.method === "POST").length, 1); assert.ok(f.sent.every(r => new URL(r.url).origin === origin));
  await job.alarm(); await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
});

test("V5 explicit re-attestation rotates lineage; metadata alone preserves V4", async t => {
  const f = await setup(t); await f.put({}, miniMaxCurrentCnVideoBinding());
  await f.put({ label: "metadata-only" }); const old = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(old.minimaxVideoBinding.version, "clawrouter.minimax-video.v4");
  await f.put({}, miniMaxCurrentCnInlineVideoBinding()); const next = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(next.minimaxVideoBinding.version, "clawrouter.minimax-video.v5"); assert.equal(next.credentialGeneration, old.credentialGeneration + 1);
  assert.notEqual(next.credentialLineage, old.credentialLineage);
});
