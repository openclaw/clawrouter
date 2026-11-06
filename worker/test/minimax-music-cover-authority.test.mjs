import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { installMusicAdmin, musicAdmin } from "./minimax-music-admin-fixture.mjs";
import { byteBody, syntheticTransport, jsonResponse } from "./minimax-search-byte-fixture.mjs";
import { beginMiniMaxMusicCoverInput, claimMiniMaxMusicCoverInput } from "../minimax-music-cover-input.ts";
import { prepareInactiveMiniMaxMusicCover, isInactiveMusicCoverPreparation } from "../minimax-music-cover-authority.ts";
import { runMiniMaxMusicCoverControls, musicCoverControlHeader, musicCoverControlVersion } from "../minimax-music-cover-control.ts";
import { authenticateProxyKey, musicCoverVerification, proxyAdmission, proxyKeyVerification } from "../proxy-auth.ts";
import { inspectGrantCredentials, putGrantCredentials, revokeGrantCredentials, materializeGrantCredentials } from "../grant-credentials.ts";
import { miniMaxMediaProjection } from "../native-media-credential.ts";
import { minimaxMusicCoverBinding } from "../../shared/native-media-binding.ts";
import { configureMusic } from "./minimax-music-runtime-fixture.mjs";
import { grantSupports } from "../provider-auth.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
const MiB = 1024 * 1024, tick = () => new Promise(resolve => setImmediate(resolve));
const headers = new Headers({ authorization: "Bearer clawrouter-live-fixture-fixture-secret" });
const selection = { providerId: "minimax", endpointId: "music-cover", mode: "http", model: "music-cover", catalogModelId: "minimax/music-cover", capability: "music.generate" };
const document = { audio_base64: "AAA=", model: "music-cover", prompt: "Synthetic style" };
async function setup(t, options = {}) {
  const f = await fixture(t, { providerId: "minimax", fixed: options.fixed ?? 700 });
  await installMusicAdmin(t, f);
  f.policy.models = ["minimax/music-cover"]; f.policy.budgetMode = options.soft ? "soft" : "reserve";
  f.policy.dailyBudgetMicros = 10000; f.policy.weeklyBudgetMicros = 10000;
  f.policy.grantRouting = { eligibleGrants: { minimax: ["replicate"] }, environmentFallback: false, failover: false };
  if (options.unknown) f.policy.requestCostMicros = null;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.put = body => f.musicPut({ provider: "minimax", kind: "api_key", enabled: true, accountId: "cover-account",
    credential: "synthetic-cover-key", nativeMediaAuthorization: "minimax-global-music-cover-inline-audio", ...body });
  await f.put(); f.calls = []; f.before = async () => {}; f.after = async (_entry, response) => response;
  for (const name of ["ACCESS_CONTROL", "GRANT_CREDENTIALS", "BUDGET_LEDGER", "USAGE_LEDGER"]) {
    const namespace = f.env[name], get = namespace.get.bind(namespace);
    namespace.get = id => { const stub = get(id); return { async fetch(url, init) {
      const cover = new Headers(init?.headers).get(musicCoverControlHeader) === musicCoverControlVersion;
      const entry = { name, id: String(id), path: new URL(url).pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
      if (cover) { f.calls.push(entry); await f.before(entry); }
      const converted = cover && typeof init?.body === "string" ? { ...init, body: byteBody(init.body), duplex: "half" } : init;
      const response = await stub.fetch(url, converted);
      return cover ? f.after(entry, await syntheticTransport(response)) : response;
    } }; };
  }
  f.input = async (route = "native", signal = new AbortController().signal) => {
    const op = beginMiniMaxMusicCoverInput({ body: byteBody(JSON.stringify(route === "manifest" ? { body: document } : document)),
      signal, deadlineAt: Date.now() + 30000, contentType: "application/json", route });
    return { op, sealed: await op.result };
  };
  f.run = async route => {
    const input = await f.input(route), flow = prepareInactiveMiniMaxMusicCover(f.env, headers, input.sealed);
    try { return { value: await flow.result, snapshot: flow.snapshot() }; }
    finally { await flow.retired; await input.op.retired; }
  };
  t.after(f.drain); return f;
}

for (const soft of [false, true]) for (const route of ["native", "manifest"]) test(`inactive cover ${route}/${soft ? "soft" : "hard"}: canonical controls, no POST, one finalizer`, async t => {
  const f = await setup(t, { soft }), result = await f.run(route);
  assert.ok(isInactiveMusicCoverPreparation(result.value)); assert.equal(isInactiveMusicCoverPreparation({ ...result.value }), false);
  assert.deepEqual(Object.keys(result.value), ["kind"]);
  assert.equal(result.snapshot.ordinary, soft ? 12 : 16); assert.equal(result.snapshot.postAttempts, 0);
  assert.equal(f.calls.filter(x => x.path === "/materialize").length, 1);
  assert.equal(f.calls.filter(x => x.path === "/settle").length, soft ? 0 : 4);
  assert.equal(f.calls.filter(x => x.path === "/dispatch").length, soft ? 0 : 4);
  assert.equal(f.calls.filter(x => x.path === "/status").length, soft ? 4 : 0);
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].cost_basis, "not_dispatched");
  assert.equal(events[0].input_tokens, null); assert.equal(events[0].content_retained, false);
});

test("cover binding is private and never grants old text/speech or imported authority", async t => {
  const f = await setup(t), grant = await inspectGrantCredentials(f.env, grantKey);
  assert.deepEqual(grant.nativeMediaBinding, minimaxMusicCoverBinding);
  assert.equal(miniMaxMediaProjection(grant, "minimax.music"), false); assert.equal(miniMaxMediaProjection(grant, "minimax.speech"), false);
  await assert.rejects(materializeGrantCredentials(f.env, grantKey, grant, "minimax", null, false));
  await f.musicPut({ nativeMediaAuthorization: null });
  await putGrantCredentials(f.env, grantKey, { provider: "minimax", kind: "api_key", enabled: true,
    credential: "synthetic-import", nativeMediaBinding: minimaxMusicCoverBinding });
  assert.equal((await inspectGrantCredentials(f.env, grantKey)).nativeMediaBinding, null);
  await assert.rejects(f.run()); assert.equal(f.calls.filter(x => x.path === "/materialize").length, 0);
});

test("unknown enforced USD is refreshed before any secret", async t => {
  const f = await setup(t, { unknown: true });
  await assert.rejects(f.run(), error => error.code === "pricing_required");
  assert.equal(f.calls.filter(x => x.path === "/materialize").length, 0); assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

for (const change of ["price", "budget", "rotate", "revoke"]) test("final refresh denies " + change + " without repair or more reservations", async t => {
  const f = await setup(t); let changed = false;
  f.before = async entry => {
    if (entry.path !== "/authorization/snapshot" || changed || f.calls.filter(x => x.path === "/authorization/snapshot").length !== 2) return;
    changed = true;
    if (change === "rotate") await f.put({ credential: "synthetic-new-cover-key" });
    else if (change === "revoke") await revokeGrantCredentials(f.env, grantKey, undefined, undefined, musicAdmin);
    else { if (change === "price") f.policy.requestCostMicros = 900; else f.policy.dailyBudgetMicros = 500;
      await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  };
  await assert.rejects(f.run()); assert.ok(changed);
  assert.equal(f.calls.filter(x => x.path === "/reserve").length, 4); assert.equal(f.calls.filter(x => x.path === "/settle").length, 4);
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("single-use sealed post-hash claim excludes metadata claims, copied handles and pre-verifier controls", async t => {
  const f = await setup(t), { op, sealed } = await f.input();
  assert.throws(() => prepareInactiveMiniMaxMusicCover(f.env, headers, { ...sealed }), { code: "used" });
  claimMiniMaxMusicCoverInput(sealed);
  assert.throws(() => prepareInactiveMiniMaxMusicCover(f.env, headers, sealed), { code: "used" });
  await op.discard();
  const next = await f.input(); let started = false;
  const flow = runMiniMaxMusicCoverControls(next.sealed, async owner => {
    assert.throws(() => owner.controlJson({}, () => { started = true; return Promise.resolve(jsonResponse({})); }), { status: 403 });
    assert.throws(() => owner.task({}, async () => { started = true; }), { status: 403 });
  });
  await flow.result; await flow.retired; await next.op.retired;
  assert.equal(started, false); assert.equal(f.calls.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("partial reserve has exactly one finalizer and serial fallback retains original IDs", async t => {
  const f = await setup(t); let reserves = 0;
  f.after = async (entry, response) => {
    if (entry.path === "/reserve" && ++reserves === 2) { await response.body.cancel(); return new Response(null, { status: 503 }); }
    if (entry.path === "/settle") { await response.body.cancel(); return new Response(null, { status: 503 }); }
    return response;
  };
  await assert.rejects(f.run());
  const reserve = f.calls.filter(x => x.path === "/reserve"), settle = f.calls.filter(x => x.path === "/settle");
  assert.equal(reserve.length, 2); assert.equal(settle.length, 2); assert.deepEqual(settle.map(x => x.body.reservationId), reserve.map(x => x.body.reservationId));
  assert.equal(f.sent.length, 0); assert.equal(bodyBudgetCharged(), 0);
});

test("primitive mandatory independence is not a claim of overlapping registered controls", async t => {
  const f = await setup(t), { op, sealed } = await f.input(), held = Promise.withResolvers(), entered = Promise.withResolvers();
  let flow, ordinary, mandatory;
  try {
    flow = runMiniMaxMusicCoverControls(sealed, async owner => {
      const auth = await authenticateProxyKey(headers, f.env, [{ id: "minimax", tokenRef: "minimax" }], false,
        undefined, selection, "authoritative", undefined, undefined, owner);
      assert.equal(auth.authType, "proxy_key");
      ordinary = owner.controlJson({}, async () => { entered.resolve(); await held.promise; return jsonResponse({ ok: true }); });
      await entered.promise;
      mandatory = await owner.controlJson({}, async () => jsonResponse({ ok: true }), true);
      assert.deepEqual(mandatory, { ok: true }); assert.equal(owner.snapshot().ordinaryActive, 1);
      assert.equal(bodyBudgetCharged(), 96 * MiB);
      const competing = new BodyLease(); try { assert.equal(competing.grow(MiB), false); } finally { competing.release(); }
      held.resolve(); await ordinary;
    });
    await flow.result;
  } finally { held.resolve(); await flow?.retired; await op.discard(); }
  assert.equal(bodyBudgetCharged(), 0);
});

for (const rejectedCancel of [false, true]) test(`retained control flow clears physical and verifier references after ${rejectedCancel ? "rejected FIRST cancellation" : "success"}`, async t => {
  const f = await setup(t), controller = new AbortController(), { op, sealed } = await f.input("native", controller.signal);
  const readEntered = Promise.withResolvers(), readRelease = Promise.withResolvers();
  const cancelEntered = Promise.withResolvers(), cancelRelease = Promise.withResolvers(), finishRelease = Promise.withResolvers();
  const rawCleanup = new Error("synthetic raw cleanup failure");
  let retainedOwner, identity, response, cancels = 0, unlocks = 0;
  const flow = runMiniMaxMusicCoverControls(sealed, async owner => {
    retainedOwner = owner;
    identity = await authenticateProxyKey(headers, f.env, [{ id: "minimax", tokenRef: "minimax" }], false,
      undefined, selection, "authoritative", undefined, undefined, owner);
    response = jsonResponse({ ok: true });
    if (rejectedCancel) {
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = options => {
        const reader = getReader(options);
        return { async read(view) {
          try { return await reader.read(view); }
          finally { readEntered.resolve(); await readRelease.promise; }
        }, async cancel(reason) {
          cancels++; try { await reader.cancel(reason); }
          finally { cancelEntered.resolve(); await cancelRelease.promise; throw rawCleanup; }
        }, releaseLock() { unlocks++; reader.releaseLock(); } };
      };
    }
    await owner.controlJson({}, async () => response);
    readEntered.resolve(); await finishRelease.promise;
  });
  const result = rejectedCancel ? assert.rejects(flow.result) : flow.result;
  const retired = rejectedCancel ? assert.rejects(flow.retired, error => error !== rawCleanup && error.message === "cover control cleanup failed") : flow.retired;
  const inputRetired = rejectedCancel ? assert.rejects(op.retired, { code: "cleanup" }) : op.retired;
  try {
    await Promise.race([readEntered.promise, flow.result.then(
      () => { throw new Error("control completed before the held boundary"); }, error => { throw error; })]);
    assert.ok(retainedOwner.tickets.some(ticket => ticket.response && ticket.input && ticket.work));
    assert.equal(musicCoverVerification(retainedOwner), identity);
    assert.equal(bodyBudgetCharged(), 96 * MiB);
    if (rejectedCancel) {
      controller.abort("fixture cancellation"); await result; await cancelEntered.promise;
      assert.equal(response.body.locked, true); assert.equal(bodyBudgetCharged(), 96 * MiB);
      cancelRelease.resolve(); await tick();
      assert.equal(response.body.locked, true); assert.equal(bodyBudgetCharged(), 96 * MiB);
      assert.ok(retainedOwner.tickets.some(ticket => ticket.input && ticket.work));
      readRelease.resolve();
    }
    finishRelease.resolve(); await result; await retired; await inputRetired;
    for (const ticket of retainedOwner.tickets) {
      assert.equal(ticket.response, undefined); assert.equal(ticket.input, undefined);
      assert.equal(ticket.cancellation, undefined); assert.equal(ticket.work, undefined); assert.equal(ticket.released, true);
    }
    assert.equal(musicCoverVerification(retainedOwner), undefined);
    assert.equal(proxyAdmission(identity), undefined); assert.equal(proxyKeyVerification(identity), undefined);
    assert.equal(retainedOwner.controlPhase, undefined); assert.equal(retainedOwner.activeOperation, undefined);
    assert.equal(flow.snapshot().cleanupFailed, rejectedCancel); assert.equal(flow.snapshot().ordinary, 2);
    assert.equal(response.body.locked, false); assert.equal(bodyBudgetCharged(), 0);
    if (rejectedCancel) { assert.equal(cancels, 1); assert.equal(unlocks, 1); }
  } finally {
    readRelease.resolve(); cancelRelease.resolve(); finishRelease.resolve(); controller.abort("fixture teardown");
    await Promise.allSettled([result, retired, inputRetired]);
  }
});


test("strict cover profile denies generic Chat/discovery while V1 permission is unchanged", async t => {
  const f = await setup(t); configureMusic(f.provider);
  const chat = { ...f.provider.endpoints[0], id: "chat", path: "/v1/chat/completions", request_format: "openai.chat", response_format: "openai.chat" };
  f.provider.endpoints.push(chat); f.provider.capabilities.push({ id: "llm.chat", endpoint: "chat", methods: ["POST"] });
  f.provider.models.push({ ...f.provider.models[0], id: "minimax/fixture-chat", upstream: "fixture-chat", capabilities: ["llm.chat"] });
  f.policy.models = null; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const grant = await inspectGrantCredentials(f.env, grantKey);
  const requirement = { provider: f.provider, endpoint: chat, mode: "http", model: "fixture-chat" };
  assert.equal(grantSupports(requirement, grant), false);
  for (const endpoint of f.provider.endpoints) assert.equal(grantSupports({ ...requirement, endpoint }, grant), false);
  const denied = await (await f.call("/v1/catalog", null)).json();
  assert.equal(denied.providers.find(row => row.id === "minimax").offers.some(row => row.eligible), false);
  await f.musicPut({ nativeMediaAuthorization: "minimax-global-music" });
  const oldProfile = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(grantSupports(requirement, oldProfile), true);
  const oldCatalog = await (await f.call("/v1/catalog", null)).json();
  assert.equal(oldCatalog.providers.find(row => row.id === "minimax").offers.some(row => row.modelId === "minimax/fixture-chat" && row.eligible), true);
});
