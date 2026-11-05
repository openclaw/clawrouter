import assert from "node:assert/strict";
import test from "node:test";
import { setup, actor, grantKey, native, poll, videoInput, submitted, completed, mp4 } from "./minimax-video-runtime-fixture.mjs";
import { hailuoModels } from "./minimax-video-declaration-fixture.mjs";
const { inspectGrantCredentials, revokeGrantCredentials, materializeGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { miniMaxVideoBinding } = await import("../../shared/minimax-video-binding.ts");
const { routingProjection } = await import("../grant-projection.ts");
const { bodyBudgetCharged, BodyLease } = await import("../body-budget.ts");
const MiB = 1024 * 1024;
async function consume(response, status = 200) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text); }
async function denied(f, response) { assert.ok(response.status >= 400, await response.clone().text()); await response.text(); await f.drain(); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0); }
for (const region of ["global", "cn"]) for (const manifest of [false, true]) for (const model of hailuoModels)
  test(`Hailuo ${region}/${model}/${manifest ? "manifest" : "native"}: create/restart/poll/original file, one POST and receipt`, async t => {
    const f = await setup(t, { region });
    const response = await f.create(manifest, model, { headers: { "idempotency-key": "original-job" } });
    const job = f.state(response); assert.equal((await consume(response)).task_id, submitted.task_id); await f.drain();
    f.restart();
    const observed = await consume(await f.invoke(manifest ? "/v1/proxy/minimax/task?task_id=" + submitted.task_id : poll, null));
    await f.drain(); assert.equal(observed.status, "Success");
    assert.equal(observed.video_url, "/v1/native/minimax/v1/files/retrieve_content?file_id=" + completed.file_id);
    const file = await f.invoke(observed.video_url, null, { headers: { "x-clawrouter-job-id": submitted.task_id } });
    assert.equal(file.status, 200, file.status === 200 ? "" : await file.clone().text());
    assert.equal(file.headers.get("content-type"), "video/mp4"); assert.equal(bodyBudgetCharged(), 96 * MiB);
    const competing = new BodyLease(); assert.equal(competing.grow(1), false); competing.release();
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), mp4()); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
    assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
    for (const request of f.sent) { assert.equal(new URL(request.url).origin, miniMaxVideoBinding(region).origin); assert.equal(request.headers.get("authorization"), "Bearer synthetic-video-key"); }
    const replay = await f.create(manifest, model, { headers: { "idempotency-key": "original-job" } }); await consume(replay, 303); await f.drain();
    assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
    const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.equal(events[0].total_tokens, null); assert.equal(job.job().managed.terminal, "succeeded");
  });
for (const options of [{ environment: true }, { qualify: false }, { fixed: null }]) test("Hailuo no borrowed authority or unknown tariff " + JSON.stringify(options), async t => {
  const f = await setup(t, options); await denied(f, await f.create()); assert.equal(f.materializations, 0);
});
for (const mutation of [{ credential: "synthetic-rotation" }, { accountId: "foreign" }, { kind: "oauth", accessToken: "synthetic-oauth" }, { provider: "other" }])
  test("Hailuo replacement requires renewed video intent " + Object.keys(mutation).join(","), async t => {
    const f = await setup(t); await f.put(mutation); assert.equal((await inspectGrantCredentials(f.env, grantKey)).minimaxVideoBinding, null);
    await denied(f, await f.create());
  });
test("Hailuo authoritative NULL, metadata preservation and stale generation", async t => {
  const f = await setup(t), original = await inspectGrantCredentials(f.env, grantKey);
  await f.put({ label: "renamed" }); const kept = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(kept.credentialLineage, original.credentialLineage); assert.deepEqual(kept.minimaxVideoBinding, miniMaxVideoBinding("global"));
  await assert.rejects(materializeGrantCredentials(f.env, grantKey, original, "minimax", null, false, undefined, "minimax.video"));
  await f.put({}, null); await f.put({ label: "still clear" });
  const cleared = await inspectGrantCredentials(f.env, grantKey); assert.equal(cleared.minimaxVideoBinding, null);
  assert.equal(routingProjection(cleared).minimaxVideoBinding, null);
  assert.equal(secretlessGrant({ provider: "minimax", minimaxVideoBinding: miniMaxVideoBinding("global") }).minimaxVideoBinding, null);
  await denied(f, await f.create());
});
for (const state of ["demote", "disable"]) test(`Hailuo CURRENT SQL admin after held pool ACK: ${state}`, async t => {
  const f = await setup(t), before = structuredClone(f.record()), get = f.env.ACCESS_CONTROL.get; let changed = false;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/grant-pools/admit" && !changed) { changed = true; await f.user(state !== "disable", state === "demote" ? "user" : "admin"); }
    return response;
  } }; };
  await assert.rejects(f.put({ credential: "synthetic-rotation" }, miniMaxVideoBinding("cn")));
  assert.equal(changed, true); assert.deepEqual(f.record(), before);
  await assert.rejects(f.put({ label: "no repair" })); assert.deepEqual(f.record(), before); assert.equal(f.sent.length, 0);
});
for (const change of ["revoke", "rotate", "metadata", "region"]) test(`Hailuo final policy wait then ${change} prevents old-key POST`, async t => {
  const f = await setup(t), get = f.env.ACCESS_CONTROL.get; let snapshots = 0;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/authorization/snapshot" && ++snapshots === 3) {
      if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, undefined, undefined, actor);
      else await f.put(change === "rotate" ? { credential: "synthetic-rotation" } : { label: "changed" }, change === "region" ? miniMaxVideoBinding("cn") : undefined);
    }
    return response;
  } }; };
  const response = await f.create(); await denied(f, response); assert.equal(snapshots, 3);
});
for (const confirmed of [false, true]) test(`Hailuo ${confirmed ? "confirmed then revoke" : "lost"} dispatch ACK: zero POST, exact freeze`, async t => {
  const f = await setup(t), get = f.env.ACCESS_CONTROL.get, actions = [];
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const action = new URL(url).pathname === "/responses-background" ? JSON.parse(init.body).action : null;
    if (action) actions.push(action);
    const response = await stub.fetch(url, init);
    if (action === "dispatch") {
      if (!confirmed) { await response.body.cancel(); throw new Error("synthetic lost ACK"); }
      await revokeGrantCredentials(f.env, grantKey, undefined, undefined, undefined, actor);
    }
    return response;
  } }; };
  await denied(f, await f.create()); assert.equal(actions.filter(action => action === "freeze").length, confirmed ? 1 : 0);
});
for (const manifest of [false, true]) for (const field of ["dailyBudgetMicros", "weeklyBudgetMicros", "monthlyBudgetMicros"])
  test(`Hailuo first current principal ${field}/${manifest}: unknown USD before materialization`, async t => {
    const f = await setup(t, { fixed: null });
    f.policy.monthlyBudgetMicros = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    const principalId = "principal@example.invalid";
    await f.authority("/users/put", { email: principalId, record: { enabled: true, role: "user", tenantId: "tenant", groups: [], budgetOverrides: { fixture: { [field]: 500 } } } });
    f.env.ACCESS_CONTROL.objects.get("policy-bindings").db.prepare("UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?")
      .run(JSON.stringify({ ...f.credential, principalId }), "fixture");
    await denied(f, await f.create(manifest)); assert.equal(f.materializations, 0);
  });
