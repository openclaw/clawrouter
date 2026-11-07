import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { installMusicAdmin, musicAdmin } from "./minimax-music-admin-fixture.mjs";
import { syntheticTransport } from "./minimax-search-byte-fixture.mjs";
const { putGrantCredentials, revokeGrantCredentials, inspectGrantCredentials, materializeGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { minimaxMusicBinding, minimaxSpeechBinding } = await import("../../shared/native-media-binding.ts");
const { miniMaxSearchBinding } = await import("../../shared/minimax-search-binding.ts");
const path = "/v1/admin/upstream-grants/policies/fixture/replicate";
const initial = { provider: "minimax", kind: "api_key", enabled: true, accountId: "synthetic-music-account", credential: "synthetic-music-key", nativeMediaAuthorization: "minimax-global-music" };
async function setup(t, create = true) {
  const f = await fixture(t); await installMusicAdmin(t, f);
  f.record = () => structuredClone(f.env.GRANT_CREDENTIALS.objects.get(grantKey)?.values.get("credential"));
  f.admin = (body, query = "", headers = f.musicHeaders) => f.call(path + query, body, { method: "PUT", headers });
  f.revoke = () => f.call(path + "/revoke", {}, { method: "POST", headers: f.musicHeaders });
  if (create) await f.musicPut(initial);
  t.after(f.drain); return f;
}
async function denied(response) { const text = await response.text(); assert.equal(response.status, 403, text); assert.doesNotMatch(text, /synthetic-music-key|synthetic-new-key/); }
function intercept(f, callback) {
  const get = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    return await callback(new URL(url).pathname, JSON.parse(init.body), response) ?? response;
  } }; };
}
for (const [name, body, query] of [
  ["reattest", { nativeMediaAuthorization: "minimax-global-music" }], ["preserve", { label: "renamed" }],
  ["rotate", { credential: "synthetic-new-key", nativeMediaAuthorization: "minimax-global-music" }],
  ["rebind", { accountId: "new-account" }], ["clear", { nativeMediaAuthorization: null }],
  ["speech switch", { nativeMediaAuthorization: "minimax-global-speech" }], ["replace", { ...initial, credential: "synthetic-new-key" }, "?mode=replace"],
]) for (const change of ["demote", "disable"]) test(`Music ${name}: current SQL admin ${change} after pool ACK preserves the old owner`, async t => {
  const f = await setup(t);
  // Resuming a paused member creates a real pending reservation. An already
  // active member only advances the revision and has no pending work to adopt.
  await f.musicPut({ enabled: false }); const before = f.record(); let reached = false;
  intercept(f, async (route, _body, response) => {
    if (route === "/grant-pools/admit" && !reached) {
      assert.equal((await response.clone().json()).pending, true);
      reached = true; await f.musicUser(change !== "disable", change === "demote" ? "user" : "admin");
    }
  });
  await denied(await f.admin({ ...body, enabled: true }, query)); assert.equal(reached, true); assert.deepEqual(f.record(), before);
  // Even renewed HTTP authority cannot adopt the failed proposal through repair.
  await f.musicUser(); await denied(await f.admin({ label: "retry" })); assert.deepEqual(f.record(), before);
});

test("Music active attachment: a fresh authorized edit cannot adopt the discarded replacement", async t => {
  const f = await setup(t), before = f.record(); let reached = false, checks = 0;
  intercept(f, async (route, _body, response) => {
    if (route === "/grant-music/authorize") checks++;
    if (route === "/grant-pools/admit" && !reached) {
      assert.equal((await response.clone().json()).pending, false); reached = true; await f.musicUser(true, "user");
    }
  });
  await denied(await f.admin({ credential: "synthetic-new-key", accountId: "discarded-account", nativeMediaAuthorization: "minimax-global-music" }));
  assert.equal(reached, true); assert.deepEqual(f.record(), before);
  await f.musicUser(); await f.musicPut({ label: "fresh authorized edit" });
  assert.equal(checks, 2); assert.equal(f.record().generation, before.generation + 1);
  for (const field of ["credential", "lineage", "accountId", "nativeMediaBinding", "enabled"]) assert.deepEqual(f.record()[field], before[field]);
});

test("Music live admin preserves rename; rotation, account, expiry and explicit removal stay bound", async t => {
  const f = await setup(t), before = f.record();
  await f.musicPut({ label: "renamed" }); assert.equal(f.record().lineage, before.lineage);
  assert.deepEqual(f.record().nativeMediaBinding, minimaxMusicBinding); assert.equal(f.record().generation, before.generation + 1);
  for (const body of [{ credential: "synthetic-new-key" }, { accountId: "new-account" }, { nativeMediaAuthorization: null }]) {
    await f.musicPut(body); assert.equal(f.record().nativeMediaBinding, null);
    await f.musicPut({ nativeMediaAuthorization: "minimax-global-music" }); assert.deepEqual(f.record().nativeMediaBinding, minimaxMusicBinding);
  }
  await f.musicPut({ ...initial, credential: "synthetic-replacement-key" }, "?mode=replace");
  assert.notEqual(f.record().lineage, before.lineage); assert.deepEqual(f.record().nativeMediaBinding, minimaxMusicBinding);
  await f.musicPut({ nativeMediaAuthorization: "minimax-global-speech" }); assert.deepEqual(f.record().nativeMediaBinding, minimaxSpeechBinding);
});

test("Music clear stays NULL on omission; reattestation cannot resurrect a revoked generation", async t => {
  const f = await setup(t); await f.musicPut({ nativeMediaAuthorization: null }); await f.musicPut({ label: "cleared" });
  assert.equal(f.record().nativeMediaBinding, null);
  await f.musicPut({ nativeMediaAuthorization: "minimax-global-music" });
  const response = await f.revoke(); assert.equal(response.status, 200, await response.clone().text()); await response.text();
  const tombstone = f.record(); assert.equal(tombstone.credential, undefined); assert.equal(tombstone.minimaxMusicTombstone, true);
  const again = await f.revoke(); assert.equal(again.status, 200); const publicValue = await again.text();
  assert.doesNotMatch(publicValue, /minimaxMusicTombstone|musicActor|musicAttestation/);
  assert.equal(f.record().generation, tombstone.generation); assert.equal(f.record().lineage, tombstone.lineage);
  await f.musicUser(true, "user"); await denied(await f.revoke()); assert.deepEqual(f.record(), tombstone);
});

test("Music revoke rechecks current SQL role after its attachment wait", async t => {
  const f = await setup(t), before = f.record(); let changed = false;
  intercept(f, async route => { if (route === "/grant-pools/attachment" && !changed) { changed = true; await f.musicUser(false); } });
  await denied(await f.revoke()); assert.equal(changed, true); assert.deepEqual(f.record(), before);
});

for (const field of ["musicActor", "musicAttestation", "minimaxMusicTombstone", "nativeMediaBinding", "nativeMediaIntent"])
  test(`Music HTTP rejects caller-supplied ${field}`, async t => {
    const f = await setup(t), before = f.record(), response = await f.admin({ [field]: musicAdmin });
    assert.equal(response.status, 400, await response.clone().text()); await response.text(); assert.deepEqual(f.record(), before);
  });
test("Music generic admin bearer is not a current SQL principal attestation", async t => {
  const f = await setup(t, false), { sha256Hex } = await import("../utils.ts");
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-token-admin");
  await denied(await f.admin(initial, "", { authorization: "Bearer synthetic-token-admin" })); assert.equal(f.record(), undefined);
});

for (const change of ["scope", "generation", "actor", "digest"]) test(`Music rejects ${change} in a mismatched authority reply`, async t => {
  const f = await setup(t), before = f.record();
  intercept(f, async (route, body, response) => {
    if (route !== "/grant-music/authorize") return;
    const reply = await response.json();
    if (change === "scope") reply.scope = ["tenants", "foreign", "replicate"];
    if (change === "generation") reply.original.generation++;
    if (change === "actor") reply.actor.email = "foreign@example.invalid";
    if (change === "digest") reply.digest = "f".repeat(64);
    return syntheticTransport(Response.json(reply));
  });
  await denied(await f.admin({ label: "changed" })); assert.deepEqual(f.record(), before);
});

test("Music exact proof is owner-computed, domain separated and stale after commit", async t => {
  const f = await setup(t), proofs = [];
  intercept(f, async (route, body) => { if (route === "/grant-music/authorize") proofs.push(body); });
  await f.musicPut({ label: "first" }); await f.musicPut({ expiresAt: "2026-12-31T00:00:00.000Z" });
  assert.equal(proofs.length, 2); assert.notEqual(proofs[0].digest, proofs[1].digest);
  for (const proof of proofs) {
    assert.equal(proof.domain, "clawrouter.minimax-music-mutation.v1"); assert.deepEqual(proof.scope, ["policies", "fixture", "replicate"]);
    assert.match(proof.digest, /^[a-f0-9]{64}$/); assert.equal(proof.resultGeneration, proof.original.generation + 1);
    assert.doesNotMatch(JSON.stringify(proof), /synthetic-music-key/);
  }
  const response = await f.env.ACCESS_CONTROL.get("policy-bindings").fetch("https://authority/grant-music/authorize", { method: "POST", body: JSON.stringify(proofs[0]) });
  assert.notEqual(response.status, 200); await response.text();
});

for (const damage of ["metadata", "lineage", "pending"]) test(`Music rejects ${damage} before loadRecord repair`, async t => {
  const f = await setup(t), owner = f.env.GRANT_CREDENTIALS.objects.get(grantKey), record = f.record();
  if (damage === "pending") record.poolSyncPending = true; else delete record[damage];
  owner.values.set("credential", structuredClone(record));
  await denied(await f.admin({ nativeMediaAuthorization: "minimax-global-music" })); assert.deepEqual(f.record(), record);
});

test("Music owner never imports or accepts OAuth/pool intent; authoritative NULL overrides forged metadata", async t => {
  const f = await setup(t, false), grant = { ...initial, nativeMediaBinding: minimaxMusicBinding };
  delete grant.nativeMediaAuthorization;
  await putGrantCredentials(f.env, grantKey, grant); let projection = await inspectGrantCredentials(f.env, grantKey);
  assert.equal(projection.nativeMediaBinding, null);
  assert.equal((await materializeGrantCredentials(f.env, grantKey, { ...projection, nativeMediaBinding: minimaxMusicBinding }, "minimax", null, false)).nativeMediaBinding, null);
  assert.equal(secretlessGrant(grant).nativeMediaBinding, null);
  await assert.rejects(putGrantCredentials(f.env, grantKey, grant, true, undefined, "clawrouter_oauth", minimaxMusicBinding,
    undefined, undefined, undefined, undefined, undefined, undefined, musicAdmin));
  await assert.rejects(putGrantCredentials(f.env, grantKey, grant, true, undefined, undefined, minimaxMusicBinding));
  projection = await inspectGrantCredentials(f.env, grantKey); assert.equal(projection.nativeMediaBinding, null);
});

test("Music to Search switch uses one final current-role check and distinct explicit product intent", async t => {
  const f = await setup(t); let checks = 0;
  intercept(f, async route => { if (route === "/grant-music/authorize") checks++; });
  await f.musicPut({ nativeMediaAuthorization: null, minimaxSearchAuthorization: "minimax-global-tokenplan-search" });
  assert.equal(checks, 1); assert.equal(f.record().nativeMediaBinding, null); assert.deepEqual(f.record().minimaxSearchBinding, miniMaxSearchBinding("global"));
});
