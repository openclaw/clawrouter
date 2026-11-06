import assert from "node:assert/strict";
import test from "node:test";
import { setup, native, poll, grantKey, actor, submitted, videoInput } from "./minimax-video-runtime-fixture.mjs";
import { inlineImage, uri } from "./minimax-video-inline-fixture.mjs";
import { miniMaxSixModelVideoBinding, miniMaxFrozenVideoModels, miniMaxInlineVideoBinding, miniMaxVideoBinding } from "../../shared/minimax-video-binding.ts";
const { inspectGrantCredentials, revokeGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const added = miniMaxFrozenVideoModels.slice(2), image = uri(inlineImage("image/png", 1024));
const input = model => ({ ...videoInput(model), resolution: model.startsWith("I2V-") ? "720P" : "768P", first_frame_image: image });
const send = (f, manifest, body, key) => f.invoke(manifest ? "/v1/proxy/minimax/video" : native,
  manifest ? { body: { ...body, model: "minimax/" + body.model } } : body, key ? { headers: { "idempotency-key": key } } : {});
async function denied(f, response) {
  const text = await response.text(); assert.ok(response.status >= 400, text); await f.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.materializations, 0); assert.equal(bodyBudgetCharged(), 0);
}
async function ready(t) { const f = await setup(t, { models: miniMaxFrozenVideoModels }); await f.put({}, miniMaxSixModelVideoBinding()); return f; }

for (const model of added) for (const manifest of [false, true]) {
  test(`V3 ${model}/${manifest}: exact shape, prompt and required private image`, async t => {
    const f = await ready(t), value = input(model), { first_frame_image: _image, ...missing } = value;
    for (const invalid of [missing, { ...value, duration: 5 }, { ...value, resolution: "4K" },
      { ...value, prompt: 17 }, { ...value, prompt: "x".repeat(2001) },
      model.startsWith("I2V-") ? { ...value, resolution: "768P" } : { ...value, duration: 10, resolution: "1080P" }])
      await denied(f, await send(f, manifest, invalid));
    delete value.prompt;
    const r = await send(f, manifest, value); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.filter(r => r.method === "POST").length, 1); assert.equal(bodyBudgetCharged(), 0);
  });
  for (const version of ["v1", "v2", "cn", "import"]) test(`V3 ${model}/${manifest} denies ${version} before secrets`, async t => {
    const f = await setup(t, { models: miniMaxFrozenVideoModels, qualify: version !== "import", region: version === "cn" ? "cn" : "global" });
    if (version === "v2") await f.put({}, miniMaxInlineVideoBinding());
    if (version === "import") assert.equal(secretlessGrant({ provider: "minimax", minimaxVideoBinding: miniMaxSixModelVideoBinding() }).minimaxVideoBinding, null);
    await denied(f, await send(f, manifest, input(model)));
  });
}

for (const manifest of [false, true]) test(`V3 current unknown tariff denies before materialization/${manifest}`, async t => {
  const f = await ready(t), get = f.env.ACCESS_CONTROL.get; let changed = false;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    if (new URL(url).pathname === "/authorization/snapshot" && !changed) {
      changed = true; f.policy.requestCostMicros = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    }
    return stub.fetch(url, init);
  } }; };
  await denied(f, await send(f, manifest, input(added[0]))); assert.equal(changed, true);
});

for (const change of ["revoke", "rotate", "v2"]) test(`V3 final policy await then ${change} denies original image dispatch`, async t => {
  const f = await ready(t), get = f.env.ACCESS_CONTROL.get; let count = 0;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/authorization/snapshot" && ++count === 3) {
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, undefined, undefined, actor);
      else await f.put(change === "rotate" ? { credential: "synthetic-v3-rotation" } : {}, change === "v2" ? miniMaxInlineVideoBinding() : miniMaxSixModelVideoBinding());
    }
    return response;
  } }; };
  const response = await send(f, false, input(added[0])); assert.ok(response.status >= 400); await response.text(); await f.drain();
  assert.equal(count, 3); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("V3 explicit re-attestation rotates lineage; current SQL demotion preserves the original V2 owner", async t => {
  const f = await setup(t, { models: miniMaxFrozenVideoModels }); await f.put({}, miniMaxInlineVideoBinding());
  const original = await inspectGrantCredentials(f.env, grantKey), get = f.env.ACCESS_CONTROL.get; let armed = true;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/grant-pools/admit" && armed) { armed = false; await f.user(true, "user"); }
    return response;
  } }; };
  await assert.rejects(f.put({}, miniMaxSixModelVideoBinding()));
  assert.equal(f.record().generation, original.credentialGeneration); assert.equal(f.record().lineage, original.credentialLineage);
  assert.equal(f.record().minimaxVideoBinding.version, "clawrouter.minimax-video.v2");
  await f.user(); await assert.rejects(f.put({}, miniMaxSixModelVideoBinding()));
});

test("fresh V3 re-attestation changes lineage exactly once", async t => {
  const f = await setup(t, { models: miniMaxFrozenVideoModels }); await f.put({}, miniMaxInlineVideoBinding());
  const original = await inspectGrantCredentials(f.env, grantKey);
  await f.put({}, miniMaxSixModelVideoBinding());
  const current = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(current.minimaxVideoBinding.version, "clawrouter.minimax-video.v3");
  assert.notEqual(current.credentialLineage, original.credentialLineage); assert.equal(current.credentialGeneration, original.credentialGeneration + 1);
});

for (const version of ["v1", "v2", "v3"]) test(`Hailuo discovery keeps router policy identity and exact upstream binding/${version}`, async t => {
  const f = await setup(t, { models: miniMaxFrozenVideoModels });
  await f.put({}, version === "v3" ? miniMaxSixModelVideoBinding() : version === "v2" ? miniMaxInlineVideoBinding() : miniMaxVideoBinding("global"));
  const id = "minimax/" + added[1]; f.policy.models = [id]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const r = await f.invoke("/v1/catalog", null); assert.equal(r.status, 200, await r.clone().text());
  const view = (await r.json()).providers.find(row => row.id === "minimax");
  assert.equal((view?.offers ?? []).some(offer => offer.modelId === id && offer.eligible), version === "v3");
  assert.ok((view?.offers ?? []).filter(offer => offer.eligible).every(offer => offer.modelId === id));
  assert.equal(f.materializations, 0); assert.equal(f.sent.length, 0);
});

for (const kind of ["missing", "duplicate", "ambiguous", "foreign"]) test(`V3 discovery rejects ${kind} selected card`, async t => {
  const f = await ready(t), id = "minimax/" + added[1], card = f.provider.models.find(row => row.id === id);
  if (kind === "missing") delete card.upstream;
  if (kind === "foreign") card.upstream = "foreign/I2V-01-Director";
  if (kind === "duplicate") f.provider.models.push({ ...card });
  if (kind === "ambiguous") f.provider.models.push({ ...card, id: "minimax/ambiguous-director" });
  f.policy.models = [id]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const r = await f.invoke("/v1/catalog", null); assert.equal(r.status, 200, await r.clone().text());
  const view = (await r.json()).providers.find(row => row.id === "minimax");
  assert.equal((view?.offers ?? []).some(offer => offer.modelId === id && offer.eligible), false);
  assert.equal(f.materializations, 0); assert.equal(f.sent.length, 0);
});

for (const shape of [{ duration: 10, resolution: "768P" }, { duration: 6, resolution: "1080P" }])
  test(`V3 Fast admits exact ${shape.resolution}/${shape.duration} without normalizing the shape`, async t => {
    const f = await ready(t), upstream = f.upstream; let observed;
    f.upstream = async request => { if (request.method === "POST") observed = await request.clone().json(); return upstream(request); };
    const value = { ...input(added[0]), ...shape, prompt: "[Pan left] Synthetic frame" };
    const r = await send(f, false, value); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.deepEqual(observed, value); assert.equal(f.sent.filter(r => r.method === "POST").length, 1); assert.equal(bodyBudgetCharged(), 0);
  });
