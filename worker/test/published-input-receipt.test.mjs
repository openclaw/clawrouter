import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqliteFixture } from "./sqlite-storage.mjs";
const { BackgroundStore, backgroundCapacity } = await import("../background-store.ts");
const { ResponsesScopeStore } = await import("../responses-scope.ts");
const { assertPublishedVerifier, publishedInputKey, samePublishedInput, validatePublishedInput } = await import("../published-input-receipt.ts");

const hash = n => n.repeat(64), now = Date.parse("2026-11-04T10:00:00Z");
function binding(overrides = {}) {
  return { version: "clawrouter.published-input.v1", id: `asset_${"1".repeat(32)}`, scope: `http-continuations:${hash("a")}`,
    issuer: { credentialId: "caller-key", principalId: null, policyId: "policy", policyGeneration: "p1", tenantId: "tenant",
      proof: { kind: "proxy_key", credentialId: "caller-key", principalId: null, secretSha256: hash("b"), expiresAt: new Date(now + 60_000).toISOString() } },
    owner: { providerId: "openrouter", endpointId: "music_generate", grantKey: "oauth/openrouter/original", lineage: "lineage-1", routeSha256: hash("c"), policyGeneration: "p1" },
    generation: 1, publicOrigin: "https://router.example", origin: "https://openrouter.ai", path: "/api/v1/chat/completions",
    modelId: "openrouter/google/lyria-3-pro-preview", upstreamModel: "google/lyria-3-pro-preview", slot: "messages[0].content[1].image_url.url",
    requestDigest: hash("d"), permissionDigest: hash("8"), digest: hash("e"), mime: "image/png", size: 1024, idempotencyDigest: hash("f"), verifierDigest: hash("0"),
    allocatedAt: now, expiresAt: now + 60_000, ...overrides };
}
function fixture(t) {
  let clock = now; t.mock.method(Date, "now", () => clock);
  const storage = sqliteFixture(t); let store = new BackgroundStore(storage.sql);
  return { storage, get store() { return store; }, restart() { store = new BackgroundStore(storage.sql); }, advance(ms) { clock += ms; } };
}
const object = b => ({ key: publishedInputKey(b), version: "immutable-upload-1", etag: "etag-1", digest: b.digest, mime: b.mime, size: b.size });
const attempt = () => ({ admissionDigest: "a".repeat(64), requestId: "request-1", eventId: "event-1", reservedMicros: 700,
  reservations: [{ objectName: "policy-budget", reservationId: "reservation-1" }] });
const unavailable = error => error.code === "published_input_unavailable";

test("publication uncertainty survives restart; a lost ACK cannot repeat the write claim", t => {
  const f = fixture(t), b = binding();
  assert.equal(f.store.allocatePublishedInput(b).state, "pending");
  f.store.claimPublishedInputPublication(b); f.restart();
  assert.equal(f.store.allocatePublishedInput(b).state, "publication_unknown");
  assert.throws(() => f.store.claimPublishedInputPublication(b), unavailable);
  assert.throws(() => f.store.claimPublishedInputForward(b, attempt()), unavailable);
  assert.equal(f.store.bindPublishedInputObject(b, object(b)).state, "published");
  f.restart(); assert.equal(f.store.bindPublishedInputObject(b, object(b)).state, "published");
  assert.throws(() => f.store.bindPublishedInputObject(b, { ...object(b), version: "replacement" }), unavailable);
});

test("one forwarding claim survives lost ACK and restart without refund or reset", t => {
  const f = fixture(t), b = binding();
  f.store.allocatePublishedInput(b); f.store.claimPublishedInputPublication(b); f.store.bindPublishedInputObject(b, object(b));
  f.store.claimPublishedInputForward(b, attempt()); f.restart();
  assert.equal(f.store.publishedInput(b.id).state, "forwarding_unknown");
  assert.deepEqual(f.store.publishedInput(b.id).attempt, attempt());
  for (const value of [attempt(), { ...attempt(), requestId: "another-request" }])
    assert.throws(() => f.store.claimPublishedInputForward(b, value), unavailable);
  assert.throws(() => f.store.claimPublishedInputPublication(b), unavailable);
});

test("expired record and idempotency identity cannot mint a replacement receipt or verifier", t => {
  const f = fixture(t), b = binding(); f.store.allocatePublishedInput(b);
  assert.throws(() => f.store.allocatePublishedInput({ ...b, verifierDigest: hash("1") }), unavailable);
  assert.throws(() => f.store.allocatePublishedInput({ ...b, id: `asset_${"2".repeat(32)}` }), unavailable);
  f.advance(60_000); f.restart();
  assert.throws(() => f.store.publishedInput(b.id), unavailable);
  assert.throws(() => f.store.allocatePublishedInput({ ...b, allocatedAt: now + 60_000, expiresAt: now + 120_000 }), unavailable);
  assert.equal(f.storage.db.prepare("SELECT count(*) AS n FROM responses_background").get().n, 1);
});

test("asset rows cannot enter generation lookup, list, manual replay or scheduled recovery", t => {
  const f = fixture(t), b = binding(); f.store.allocatePublishedInput(b); f.store.claimPublishedInputPublication(b);
  assert.equal(f.store.get(b.id), null); assert.deepEqual(f.store.list(), []);
  assert.deepEqual(f.store.claim(now, b.id), []); assert.deepEqual(f.store.claim(now + 1_000_000), []);
  assert.equal(f.store.nextDeadline(), undefined);
  assert.throws(() => f.store.beginDispatch(b.id, null), error => error.code === "background_unavailable");
  f.restart(); assert.equal(f.store.publishedInput(b.id).state, "publication_unknown");
});

test("publication shares the existing finite scope capacity and never evicts an attempt", t => {
  const f = fixture(t);
  for (let i = 0; i < backgroundCapacity; i++) f.store.allocatePublishedInput(binding({
    id: `asset_${i.toString(16).padStart(32, "0")}`, idempotencyDigest: i.toString(16).padStart(64, "0") }));
  assert.throws(() => f.store.allocatePublishedInput(binding({ id: `asset_${"f".repeat(32)}` })), error => error.code === "background_capacity");
  assert.equal(f.storage.db.prepare("SELECT count(*) AS n FROM responses_background").get().n, backgroundCapacity);
});

for (const [name, change] of [
  ["scope", b => b.scope = "http-continuations:foreign"], ["version", b => b.version = "clawrouter.managed-input.v1"],
  ["model", b => b.upstreamModel = "unregistered"], ["provider", b => b.owner.providerId = "pixverse"],
  ["slot", b => b.slot = "other"], ["generation", b => b.generation = 0], ["lineage", b => b.owner.lineage = ""],
  ["environment", b => b.owner.grantKey = "env/OPENROUTER_API_KEY"], ["size", b => b.size = 8 * 1024 * 1024 + 1],
  ["digest", b => b.digest = "e".repeat(64) + "\n"], ["mime", b => b.mime = "image/svg+xml"],
  ["origin-query", b => b.publicOrigin += "?token=forged"], ["origin-userinfo", b => b.publicOrigin = "https://user@router.example"],
  ["path", b => b.path = "/other"], ["line-ending", b => b.id += "\n"],
  ["issuer", b => b.issuer.proof.credentialId = "foreign"], ["issuer-secret", b => b.issuer.proof.secret = "synthetic-never-store"],
  ["caller-authority", b => b.allowed = true], ["lifetime", b => b.expiresAt += 15 * 60_000],
]) test(`published input rejects malformed ${name}`, () => {
  const b = binding(); change(b); assert.throws(() => validatePublishedInput(b), unavailable);
});

for (const field of ["requestDigest", "digest", "mime", "size", "modelId", "generation", "slot", "publicOrigin"])
  test(`original receipt rejects changed ${field} before publication/forwarding`, t => {
    const f = fixture(t), b = binding(); f.store.allocatePublishedInput(b);
    const altered = { ...b, [field]: typeof b[field] === "number" ? b[field] + 1 : field.endsWith("Digest") || field === "digest" ? hash("3") : `changed-${b[field]}` };
    assert.throws(() => f.store.claimPublishedInputPublication(altered), unavailable);
    assert.equal(f.store.publishedInput(b.id).state, "pending");
  });

test("verifier and issuer expiry are checked without returning another scope's record", t => {
  const f = fixture(t), b = binding(); const record = f.store.allocatePublishedInput(b);
  assertPublishedVerifier(record, b.verifierDigest);
  assert.throws(() => assertPublishedVerifier(record, hash("9")), unavailable);
  const reordered = Object.fromEntries(Object.entries(b).reverse()); assert.equal(samePublishedInput(b, reordered), true);
  record.binding.issuer.proof.expiresAt = new Date(now).toISOString();
  assert.throws(() => assertPublishedVerifier(record, b.verifierDigest), unavailable);
});

test("private scoped owner serializes concurrent claims and exposes no asset alarm/recovery action", async t => {
  const f = fixture(t), b = binding();
  let owner = new ResponsesScopeStore({ ...f.storage,
    setAlarm() { assert.fail("assets cannot schedule background recovery"); },
    getAlarm() { assert.fail("assets cannot inspect generation alarms"); },
    deleteAlarm() { assert.fail("assets cannot mutate generation alarms"); } }, {});
  const call = body => owner.fetch(new Request("https://owner.invalid/responses-background", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await call({ action: "asset_allocate", binding: b })).status, 200);
  const results = await Promise.allSettled([call({ action: "asset_claim_publish", binding: b }), call({ action: "asset_claim_publish", binding: b })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && unavailable(result.reason)).length, 1);
  await assert.rejects(call({ action: "asset_get", id: b.id, verifierDigest: hash("9") }), unavailable);
  await assert.rejects(call({ action: "asset_get", id: b.id, verifierDigest: b.verifierDigest, allowed: true }), unavailable);
  assert.equal((await (await call({ action: "asset_get", id: b.id, verifierDigest: b.verifierDigest })).json()).state, "publication_unknown");
});
