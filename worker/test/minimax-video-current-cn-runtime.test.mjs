import assert from "node:assert/strict";
import test from "node:test";
import { setup, actor, grantKey, native, poll, videoInput, submitted, mp4 } from "./minimax-video-runtime-fixture.mjs";
import { inlineImage, uri } from "./minimax-video-inline-fixture.mjs";
import { miniMaxCurrentCnVideoBinding, miniMaxVideoBinding, miniMaxFrozenVideoModels, miniMaxT2VModels } from "../../shared/minimax-video-binding.ts";
import { inspectGrantCredentials, putGrantCredentials, revokeGrantCredentials, secretlessGrant } from "../grant-credentials.ts";
import { managedFileBase } from "../managed-files.ts";
import { prepareMiniMaxVideo, prepareMiniMaxVideoFile, isMiniMaxVideoOrigin } from "../minimax-video.ts";
import { bodyBudgetCharged } from "../body-budget.ts";
const origin = "https://api.minimax.cn";
async function ready(t, options = {}) {
  const f = await setup(t, { models: miniMaxFrozenVideoModels, ...options }); await f.put({}, miniMaxCurrentCnVideoBinding()); return f;
}
async function read(response, status = 200) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text); }
const send = (f, manifest, input, key) => f.invoke(manifest ? "/v1/proxy/minimax/video" : native,
  manifest ? { body: { ...input, model: "minimax/" + input.model } } : input, key ? { headers: { "idempotency-key": key } } : {});
async function denied(f, response, secrets = true) {
  assert.ok(response.status >= 400, await response.clone().text()); await response.text(); await f.drain();
  assert.equal(f.sent.length, 0); if (secrets) assert.equal(f.materializations, 0); assert.equal(bodyBudgetCharged(), 0);
}

for (const model of miniMaxT2VModels) for (const manifest of [false, true])
  test(`V4 exact current-CN ${model}/${manifest}: original create restart poll file and receipt`, async t => {
    const f = await ready(t), input = videoInput(model), response = await send(f, manifest, input, "current-cn");
    const job = f.state(response); await read(response); await f.drain(); f.restart();
    const observed = await read(await f.invoke(poll, null)); await f.drain();
    const file = await f.invoke(observed.video_url, null, { headers: { "x-clawrouter-job-id": submitted.task_id } });
    assert.equal(file.status, 200); assert.equal(file.headers.get("content-type"), "video/mp4");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), mp4()); await f.drain();
    assert.deepEqual(f.sent.map(r => new URL(r.url).origin), [origin, origin, origin, origin]);
    assert.deepEqual(f.sent.map(r => new URL(r.url).pathname), ["/v1/video_generation", "/v1/query/video_generation", "/v1/files/retrieve", "/v1/files/retrieve_content"]);
    await read(await send(f, manifest, input, "current-cn"), 303); await f.drain();
    await read(await send(f, manifest, { ...input, prompt: input.prompt + " changed" }, "current-cn"), 409); await f.drain();
    assert.equal(f.sent.filter(r => r.method === "POST").length, 1); await job.alarm(); await f.drain();
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].total_tokens, null); assert.equal(bodyBudgetCharged(), 0);
  });

for (const manifest of [false, true]) test(`V4 cannot borrow inline or six-model permission/${manifest}`, async t => {
  const f = await ready(t), first_frame_image = uri(inlineImage("image/png", 1024));
  for (const model of miniMaxFrozenVideoModels) {
    const input = { ...videoInput(model), resolution: model.startsWith("I2V-") ? "720P" : "768P", first_frame_image };
    await denied(f, await send(f, manifest, input));
    if (!miniMaxT2VModels.includes(model)) { delete input.first_frame_image; await denied(f, await send(f, manifest, input)); }
  }
});

for (const manifest of [false, true]) test(`V4 current unknown tariff denies before materialization/${manifest}`, async t => {
  const f = await ready(t), get = f.env.ACCESS_CONTROL.get; let changed = false;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    if (new URL(url).pathname === "/authorization/snapshot" && !changed) {
      changed = true; f.policy.requestCostMicros = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    }
    return stub.fetch(url, init);
  } }; };
  await denied(f, await f.create(manifest)); assert.equal(changed, true);
});

for (const change of ["revoke", "rotate", "expire", "legacy"]) test(`V4 final policy await then ${change} denies the original POST`, async t => {
  const f = await ready(t); if (change === "expire") await f.put({ expiresAt: new Date(Date.now() + 5000).toISOString() }, miniMaxCurrentCnVideoBinding());
  const get = f.env.ACCESS_CONTROL.get; let count = 0;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/authorization/snapshot" && ++count === 3) {
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, undefined, undefined, actor);
      else if (change === "expire") f.advance(5001);
      else await f.put(change === "rotate" ? { credential: "synthetic-current-cn-rotation" } : {}, change === "legacy" ? miniMaxVideoBinding("cn") : miniMaxCurrentCnVideoBinding());
    }
    return response;
  } }; };
  await denied(f, await f.create(), false); assert.equal(count, 3);
});

test("V4 re-attestation invalidates the old legacy job without migrating a separately retained owner", async t => {
  const f = await setup(t, { region: "cn" }), legacyKey = "oauth/fixture/retained-cn";
  await putGrantCredentials(f.env, legacyKey, { provider: "minimax", kind: "api_key", enabled: true, credential: "synthetic-retained-cn-key", accountId: "retained-cn" },
    false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, miniMaxVideoBinding("cn"), actor);
  const retained = await inspectGrantCredentials(f.env, legacyKey), before = await inspectGrantCredentials(f.env, grantKey);
  await read(await f.create()); await f.drain(); const sent = f.sent.length;
  await f.put({}, miniMaxCurrentCnVideoBinding()); const after = await inspectGrantCredentials(f.env, grantKey);
  assert.notEqual(after.credentialLineage, before.credentialLineage); assert.equal(after.credentialGeneration, before.credentialGeneration + 1);
  const denied = await f.invoke(poll, null); assert.ok(denied.status >= 400); await denied.text(); await f.drain(); assert.equal(f.sent.length, sent);
  assert.deepEqual(await inspectGrantCredentials(f.env, legacyKey), retained);
});

test("V4 import stays authoritative NULL and exact file bases cannot fall through to declared aliases", async t => {
  const f = await setup(t, { qualify: false });
  await f.put({ minimaxVideoBinding: miniMaxCurrentCnVideoBinding() });
  assert.equal((await inspectGrantCredentials(f.env, grantKey)).minimaxVideoBinding, null);
  assert.equal(secretlessGrant({ provider: "minimax", minimaxVideoBinding: miniMaxCurrentCnVideoBinding() }).minimaxVideoBinding, null);
  await denied(f, await f.create());
  assert.equal(managedFileBase(f.provider, origin), origin); assert.equal(isMiniMaxVideoOrigin(origin), true);
  assert.equal(prepareMiniMaxVideo("cn", videoInput()).origin, "https://api.minimaxi.com");
  assert.equal(prepareMiniMaxVideoFile("download", origin, "1").origin, origin);
  for (const value of [origin + "/", origin + ":443", origin + "/v1", origin + ".example", "https://other.minimax.cn", "https://declared.example"]) {
    f.provider.base_urls.extra = value; assert.equal(isMiniMaxVideoOrigin(value), false); assert.throws(() => managedFileBase(f.provider, value));
  }
  assert.equal(managedFileBase({ ...f.provider, id: "unrelated", base_urls: { default: "https://declared.example" } }, "https://declared.example/v1"), "https://declared.example/v1");
});
