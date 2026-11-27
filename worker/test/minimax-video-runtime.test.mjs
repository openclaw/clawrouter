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
for (const manifest of [false, true]) test(`Hailuo exact ${manifest ? "manifest" : "native"} model selection rejects foreign, undeclared and ambiguous identities`, async t => {
  const f = await setup(t), upstream = hailuoModels[0], target = manifest ? "/v1/proxy/minimax/video" : native;
  const invoke = model => f.invoke(target, manifest ? { body: { ...videoInput(), model } } : { ...videoInput(), model });
  for (const model of ["foreign/" + upstream, upstream + "-unknown", " " + upstream, manifest ? upstream : "minimax/" + upstream])
    await denied(f, await invoke(model));
  f.provider.models.push({ ...f.provider.models[0], id: manifest ? f.provider.models[0].id : "minimax/ambiguous" });
  await denied(f, await invoke(manifest ? "minimax/" + upstream : upstream));
  assert.equal(f.materializations, 0);
});
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
    const competing = new BodyLease();
    try { assert.equal(competing.grow(MiB), false); assert.equal(bodyBudgetCharged(), 96 * MiB); } finally { competing.release(); }
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), mp4()); await f.drain(); assert.equal(bodyBudgetCharged(), 0);
    assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
    for (const request of f.sent) { assert.equal(new URL(request.url).origin, miniMaxVideoBinding(region).origin); assert.equal(request.headers.get("authorization"), "Bearer synthetic-video-key"); }
    const replay = await f.create(manifest, model, { headers: { "idempotency-key": "original-job" } }); await consume(replay, 303); await f.drain();
    assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
    await job.alarm(); await f.drain();
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
  const response = await f.create(); const body = await consume(response, 503); await f.drain();
  assert.equal(body.error.code, confirmed ? "prediction_submission_unsent" : "prediction_submission_unknown");
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(actions.filter(action => action === "freeze").length, confirmed ? 1 : 0);
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
for (const manifest of [false, true]) test(`Hailuo current tariff before first snapshot reaches original durable receipt/${manifest}`, async t => {
  const f = await setup(t), get = f.env.ACCESS_CONTROL.get; let changed = false;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    if (new URL(url).pathname === "/authorization/snapshot" && !changed) {
      changed = true; f.policy.requestCostMicros = 900; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
    }
    return stub.fetch(url, init);
  } }; };
  const response = await f.create(manifest), job = f.state(response); await consume(response); await f.drain();
  await consume(await f.invoke(poll, null)); await f.drain();
  await job.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 900);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(f.sent.filter(r => r.method === "POST").length, 1);
});

for (const kind of ["poll", "file"]) test(`Hailuo ${kind} complete-scope overflow denies before ANY lookup`, async t => {
  const f = await setup(t);
  const { MiniMaxVideoOperation } = await import("../minimax-video-operation.ts");
  const { resolveResponseControlOwner } = await import("../response-controls.ts");
  const owner = new MiniMaxVideoOperation(kind); let lookups = 0;
  const env = { ...f.env, ACCESS_CONTROL: { idFromName: value => value, get() { lookups++; throw new Error("lookup must not start"); } } };
  try { await assert.rejects(resolveResponseControlOwner(env, Array(kind === "poll" ? 16 : 12).fill({}), "synthetic", owner.operation,
    "minimax", "video", undefined, owner), { code: "minimax_video_control_limit" }); assert.equal(lookups, 0); }
  finally { await owner.finish(); }
  assert.equal(bodyBudgetCharged(), 0);
});
for (const collection of [false, true]) test(`Hailuo final owner policy after preparation denies ${collection ? "collector" : "public"} GET`, async t => {
  const f = await setup(t);
  f.env.ACCESS_CONTROL.objects.get("policy-bindings").db.prepare("UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?")
    .run(JSON.stringify({ ...f.credential, principalId: actor.email }), "fixture");
  const response = await f.create(), state = f.state(response); await consume(response); await f.drain();
  const original = state.job(), grantGet = f.env.GRANT_CREDENTIALS.get, authorityGet = f.env.ACCESS_CONTROL.get, order = [];
  let inside = false;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = grantGet(id); return { async fetch(url, init) {
    if (new URL(url).pathname !== "/responses/control") return stub.fetch(url, init);
    inside = true; try { return await stub.fetch(url, init); } finally { inside = false; }
  } }; };
  f.env.ACCESS_CONTROL.get = id => { const stub = authorityGet(id); return { async fetch(url, init) {
    const path = new URL(url).pathname;
    if (inside) {
      if (["/connections/resolve", "/authorization/snapshot"].includes(path)) order.push(path);
      if (path === "/authorization/snapshot") {
        assert.ok(order.includes("/connections/resolve"));
        await f.authority("/users/put", { email: actor.email, record: { enabled: false, role: "admin", tenantId: "tenant", groups: [] } });
      }
    }
    return stub.fetch(url, init);
  } }; };
  const sent = f.sent.length; let accepted = 0;
  if (collection) {
    const { collectManagedPrediction } = await import("../managed-predictions.ts");
    await assert.rejects(collectManagedPrediction(f.env, original, async () => { accepted++; }));
  } else { const denied = await f.invoke(poll, null); assert.ok(denied.status >= 400, await denied.text()); await f.drain(); }
  assert.equal(accepted, 0); assert.equal(f.sent.length, sent); assert.equal(order.at(-1), "/authorization/snapshot");
  assert.equal(bodyBudgetCharged(), 0);
});

test("Hailuo durable admission accepts its exact protocol and preserves closed metadata and tariff guards", async t => {
  const f = await setup(t), get = f.env.ACCESS_CONTROL.get; let admission;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    if (new URL(url).pathname === "/responses-background") { const packet = JSON.parse(init.body); if (packet.action === "managed_admit") admission = packet.admission; }
    return stub.fetch(url, init);
  } }; };
  await consume(await f.create()); await f.drain(); assert.ok(admission);
  const { BackgroundStore } = await import("../background-store.ts"), { sqliteFixture } = await import("./sqlite-storage.mjs");
  const { sql } = sqliteFixture(t), store = new BackgroundStore(sql);
  assert.equal(store.admitManaged(admission).created, true);
  assert.equal(new BackgroundStore(sql).get(admission.id).managed.protocol, "minimax.video");
  for (const change of [{ protocol: "minimax.video.unknown" }, { providerId: undefined }, { requestDigest: "invalid" },
    { requestedVersion: "" }, { unexpected: true }, { fileBaseUrl: "https://user@foreign.example" }]) {
    assert.throws(() => store.admitManaged({ ...admission, managed: { ...admission.managed, ...change } }), { code: "background_request_invalid" });
  }
  assert.throws(() => store.admitManaged({ ...admission, facts: { ...admission.facts, fixed: 701 } }), { code: "pricing_required" });
});
