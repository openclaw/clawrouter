import assert from "node:assert/strict";
import test from "node:test";
import { setup, native, poll, actor, grantKey, submitted, videoInput } from "./minimax-video-runtime-fixture.mjs";
import { inlineImage, uri } from "./minimax-video-inline-fixture.mjs";
const { miniMaxInlineVideoBinding, miniMaxVideoBinding } = await import("../../shared/minimax-video-binding.ts");
const { revokeGrantCredentials, inspectGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const image = uri(inlineImage("image/png", 1024));
const send = (f, manifest, input, key) => f.invoke(manifest ? "/v1/proxy/minimax/video" : native,
  manifest ? { body: { ...input, model: "minimax/" + input.model } } : input,
  key ? { headers: { "idempotency-key": key } } : {});
async function consume(response, status = 200) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text); }
async function denied(f, response) {
  const text = await response.text(); assert.ok(response.status >= 400, text); await f.drain();
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
}

for (const manifest of [false, true]) test(`inline original V2 ${manifest ? "manifest" : "native"} content digest, one POST and fixed receipt`, async t => {
  const f = await setup(t); await f.put({}, miniMaxInlineVideoBinding());
  const upstream = f.upstream; let sent;
  f.upstream = async request => { if (request.method === "POST") sent = await request.json(); return upstream(request); };
  const input = { ...videoInput(), first_frame_image: image };
  const response = await send(f, manifest, input, "inline-original"), job = f.state(response);
  assert.equal((await consume(response)).task_id, submitted.task_id); await f.drain();
  assert.deepEqual(sent, input); assert.equal(bodyBudgetCharged(), 0);
  await consume(await send(f, manifest, input, "inline-original"), 303); await f.drain();
  const different = { ...input, first_frame_image: uri(inlineImage("image/png", 1025)) };
  const conflict = await send(f, manifest, different, "inline-original");
  assert.equal(conflict.status, 409, await conflict.clone().text()); await conflict.text(); await f.drain();
  assert.equal(f.sent.filter(r => r.method === "POST").length, 1);
  await consume(await f.invoke(poll, null)); await f.drain(); await job.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
});

for (const manifest of [false, true]) for (const qualification of ["v1", "cn", "import", "unknown-price"])
  test(`inline ${qualification}/${manifest} denies before materialization`, async t => {
    const f = await setup(t, { region: qualification === "cn" ? "cn" : "global", qualify: qualification !== "import", fixed: qualification === "unknown-price" ? null : 700 });
    if (qualification === "unknown-price") await f.put({}, miniMaxInlineVideoBinding());
    if (qualification === "import") assert.equal(secretlessGrant({ provider: "minimax", minimaxVideoBinding: miniMaxInlineVideoBinding() }).minimaxVideoBinding, null);
    await denied(f, await send(f, manifest, { ...videoInput(), first_frame_image: image }));
    assert.equal(f.materializations, 0);
  });

for (const change of ["revoke", "rotate", "region", "clear"]) test(`inline final policy wait then ${change} never posts stale input authority`, async t => {
  const f = await setup(t); await f.put({}, miniMaxInlineVideoBinding());
  const get = f.env.ACCESS_CONTROL.get; let count = 0;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/authorization/snapshot" && ++count === 3) {
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, undefined, undefined, actor);
      else await f.put(change === "rotate" ? { credential: "synthetic-rotation" } : {}, change === "region" ? miniMaxVideoBinding("cn") : change === "clear" ? null : undefined);
    }
    return response;
  } }; };
  await denied(f, await send(f, false, { ...videoInput(), first_frame_image: image })); assert.equal(count, 3);
});

test("V2 re-attestation requires current SQL admin after pool admission; omission never upgrades V1", async t => {
  const f = await setup(t), original = await inspectGrantCredentials(f.env, grantKey), get = f.env.ACCESS_CONTROL.get; let changed = false;
  await f.put({ label: "T2V rename" }); assert.equal((await inspectGrantCredentials(f.env, grantKey)).minimaxVideoBinding.version, "clawrouter.minimax-video.v1");
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/grant-pools/admit" && !changed) { changed = true; await f.user(true, "user"); }
    return response;
  } }; };
  await assert.rejects(f.put({}, miniMaxInlineVideoBinding()));
  assert.equal(f.record().minimaxVideoBinding.version, "clawrouter.minimax-video.v1"); assert.equal(f.record().lineage, original.credentialLineage);
  assert.equal(f.sent.length, 0);
});
