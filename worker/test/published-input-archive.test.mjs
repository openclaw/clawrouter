import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { sqliteFixture } from "./sqlite-storage.mjs";
const { ResponsesScopeStore } = await import("../responses-scope.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { publishedInputKey } = await import("../published-input-receipt.ts");
const { parsePublishedInputUrl, publishedInputUrl, resolvePublishedInputUrl, publishInputBytes, publishedInputResponse } = await import("../published-input-archive.ts");

const MiB = 1024 * 1024, hash = x => x.repeat(64), verifier = "f".repeat(64);
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGUlEQVR4nGP8z8Dwn/E/QyMLI8N/IGSsBwA6swYEbMHgjAAAAABJRU5ErkJggg==", "base64"));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function fixture(t) {
  const now = Date.now(), controller = new AbortController(), operation = new HttpOperation(controller.signal, 30_000);
  const binding = { version: "clawrouter.published-input.v1", id: `asset_${"1".repeat(32)}`, scope: `http-continuations:${hash("a")}`,
    issuer: { credentialId: "caller", principalId: null, policyId: "policy", policyGeneration: "p1", tenantId: "tenant",
      proof: { kind: "proxy_key", credentialId: "caller", principalId: null, secretSha256: hash("b") } },
    owner: { providerId: "openrouter", endpointId: "music_generate", grantKey: "oauth/openrouter/original", lineage: "lineage", routeSha256: hash("c"), policyGeneration: "p1" },
    generation: 1, publicOrigin: "https://router.example", origin: "https://openrouter.ai", path: "/api/v1/chat/completions",
    modelId: "openrouter/google/lyria-3-pro-preview", upstreamModel: "google/lyria-3-pro-preview", slot: "messages[0].content[1].image_url.url",
    requestDigest: hash("d"), permissionDigest: hash("8"), digest: createHash("sha256").update(png).digest("hex"), mime: "image/png", size: png.length,
    idempotencyDigest: hash("e"), verifierDigest: createHash("sha256").update(verifier).digest("hex"), allocatedAt: now, expiresAt: now + 60_000 };
  const storage = sqliteFixture(t), owner = new ResponsesScopeStore(storage, {}), objects = new Map(), trace = [];
  const env = { CLAWROUTER_PUBLIC_ORIGIN: binding.publicOrigin,
    ACCESS_CONTROL: { idFromName: name => name, get: name => ({ fetch(url, init) {
      assert.equal(name, binding.scope); trace.push(JSON.parse(init.body).action); return owner.fetch(new Request(url, init));
    } }) },
    CONTENT_ARCHIVE: {
      async put(key, body, options) {
        trace.push("put"); assert.equal(options.onlyIf.get("if-none-match"), "*");
        const reader = body.getReader(), chunks = [];
        try { while (true) { const { value, done } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); } }
        finally { reader.releaseLock(); }
        const bytes = Buffer.concat(chunks), metadata = { key, version: "version-1", etag: "etag-1", size: bytes.length,
          checksums: { sha256: options.sha256 }, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata };
        assert.equal(createHash("sha256").update(bytes).digest("hex"), binding.digest);
        objects.set(key, { metadata, bytes }); return metadata;
      },
      async get(key, options) {
        trace.push("get"); const stored = objects.get(key); if (!stored) return null;
        assert.equal(options.onlyIf.etagMatches, stored.metadata.etag);
        return { ...stored.metadata, body: new Response(stored.bytes).body };
      },
    },
  };
  const f = { env, binding, controller, operation, objects, trace, checks: 0, authorized: true,
    access: { binding, operation, async authorize() { trace.push("authorize"); f.checks++; if (!f.authorized) throw new Error("revoked"); },
      assertLive() { if (!f.authorized || operation.signal.aborted) throw new Error("revoked"); } } };
  await env.ACCESS_CONTROL.get(binding.scope).fetch("https://owner.invalid/responses-background", { method: "POST", body: JSON.stringify({ action: "asset_allocate", binding }) });
  t.after(() => { operation.stop("complete"); assert.equal(bodyBudgetCharged(), 0); });
  return f;
}

test("archive publication preserves exact bytes, claims before write and acknowledges only verified object", async t => {
  const f = await fixture(t), receipt = await publishInputBytes(f.env, f.access, png);
  assert.deepEqual(f.trace, ["asset_allocate", "authorize", "asset_claim_publish", "authorize", "put", "authorize", "asset_bind_publish"]);
  assert.equal(receipt.state, "published"); assert.deepEqual(f.objects.get(publishedInputKey(f.binding)).bytes, Buffer.from(png));
  assert.equal(JSON.stringify(receipt).includes(verifier), false);
  const url = publishedInputUrl(f.binding, verifier);
  assert.deepEqual(parsePublishedInputUrl(url, f.binding.publicOrigin), { scope: f.binding.scope, id: f.binding.id, verifier });
  assert.deepEqual(await resolvePublishedInputUrl(f.env, url, f.operation.signal), receipt);
  await assert.rejects(publishInputBytes(f.env, f.access, png), error => error.code === "published_input_unavailable");
  assert.equal(f.trace.filter(value => value === "put").length, 1);
});

for (const [name, change] of [
  ["query", url => url + "?download=1"], ["fragment", url => url + "#asset"], ["foreign-origin", url => url.replace("router.example", "foreign.example")],
  ["encoded-slash", url => url.replace("/asset_", "%2Fasset_")], ["extra-segment", url => url + "/extra"],
  ["traversal", url => url.replace("/v1/", "/other/../v1/")], ["newline", url => url + "\n"],
]) test(`published URL denies ${name} without a storage request`, async t => {
  const f = await fixture(t), url = publishedInputUrl(f.binding, verifier);
  await assert.rejects(resolvePublishedInputUrl(f.env, change(url), f.operation.signal), error => error.code === "published_input_unavailable");
  assert.deepEqual(f.trace, ["asset_allocate"]);
});

test("actual MIME/digest mismatch and prepublication revocation make zero archive writes", async t => {
  const f = await fixture(t), altered = png.slice(); altered[0] ^= 1;
  await assert.rejects(publishInputBytes(f.env, f.access, altered));
  f.authorized = false;
  await assert.rejects(publishInputBytes(f.env, f.access, png), /revoked/);
  assert.equal(f.trace.includes("put"), false); assert.equal(f.trace.includes("asset_claim_publish"), false);
});

test("revocation after archive completion cannot publish the URL or reset the attempted write", async t => {
  const f = await fixture(t), put = f.env.CONTENT_ARCHIVE.put;
  f.env.CONTENT_ARCHIVE.put = async (...args) => { const result = await put(...args); f.authorized = false; return result; };
  await assert.rejects(publishInputBytes(f.env, f.access, png), /revoked/);
  assert.equal(f.trace.includes("asset_bind_publish"), false);
  f.authorized = true;
  await assert.rejects(publishInputBytes(f.env, f.access, png), error => error.code === "published_input_unavailable");
  assert.equal(f.trace.filter(value => value === "put").length, 1);
});

test("archive refusal before acquiring a reader settles its unclaimed stream", async t => {
  const f = await fixture(t); let readable;
  f.env.CONTENT_ARCHIVE.put = async (_key, body) => { readable = body; throw new Error("archive refused"); };
  await assert.rejects(publishInputBytes(f.env, f.access, png), /archive refused/);
  assert.equal(readable.locked, false);
  const reader = readable.getReader();
  try { assert.equal(await reader.read().then(value => value.done, error => error instanceof Error), true); }
  finally { reader.releaseLock(); }
  assert.equal(f.trace.includes("asset_bind_publish"), false);
});

test("delegated GET holds independent capacity through producer EOF and validates original object pins", async t => {
  const f = await fixture(t), receipt = await publishInputBytes(f.env, f.access, png);
  const response = await publishedInputResponse(f.env, receipt, f.access);
  assert.equal(response.headers.get("content-type"), "image/png"); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(bodyBudgetCharged(), 16 * MiB);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png)); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(f.checks, 5);
});

for (const field of ["version", "etag", "size", "checksum", "mime", "expiry"])
  test(`delegated GET withholds a changed ${field} and cancels the object reader`, async t => {
    const f = await fixture(t), receipt = await publishInputBytes(f.env, f.access, png); let canceled = 0;
    const original = f.objects.get(publishedInputKey(f.binding)).metadata;
    f.env.CONTENT_ARCHIVE.get = async () => {
      const metadata = { ...original, checksums: { ...original.checksums }, httpMetadata: { ...original.httpMetadata }, customMetadata: { ...original.customMetadata } };
      if (field === "checksum") metadata.checksums.sha256 = new Uint8Array(32).buffer;
      else if (field === "mime") metadata.httpMetadata.contentType = "image/jpeg";
      else if (field === "expiry") metadata.customMetadata.expiresAt = "1";
      else metadata[field] = field === "size" ? original.size + 1 : "replacement";
      return { ...metadata, body: new ReadableStream({ cancel() { canceled++; } }, { highWaterMark: 0 }) };
    };
    await assert.rejects(publishedInputResponse(f.env, receipt, f.access), error => error.code === "published_input_unavailable");
    assert.equal(canceled, 1); assert.equal(bodyBudgetCharged(), 0);
  });

test("pending object read cancellation retains its charge until actual cancellation settles", async t => {
  const f = await fixture(t), receipt = await publishInputBytes(f.env, f.access, png), entered = deferred(), release = deferred();
  const metadata = f.objects.get(publishedInputKey(f.binding)).metadata; let canceled = 0, source;
  f.env.CONTENT_ARCHIVE.get = async () => ({ ...metadata, body: source = new ReadableStream({
    pull() { entered.resolve(); }, async cancel() { canceled++; assert.equal(bodyBudgetCharged(), 16 * MiB); await release.promise; },
  }, { highWaterMark: 0 }) });
  const response = await publishedInputResponse(f.env, receipt, f.access), reader = response.body.getReader();
  const pending = reader.read().catch(error => error); await entered.promise;
  f.controller.abort(new Error("caller canceled"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canceled, 1); assert.equal(bodyBudgetCharged(), 16 * MiB); assert.equal(source.locked, true);
  release.resolve(); assert.ok(await pending instanceof Error); reader.releaseLock();
  assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
});

test("GET capacity refusal happens before storage; a music response lease can coexist with bounded GET", async t => {
  const f = await fixture(t), receipt = await publishInputBytes(f.env, f.access, png), other = new BodyLease();
  assert.equal(other.grow(48 * MiB), true);
  await assert.rejects(publishedInputResponse(f.env, receipt, f.access), error => error.code === "server_overloaded");
  assert.equal(f.trace.includes("get"), false); other.release();
  assert.equal(other.grow(32 * MiB), true);
  const response = await publishedInputResponse(f.env, receipt, f.access); assert.equal(bodyBudgetCharged(), 80 * MiB);
  await response.body.cancel(); assert.equal(bodyBudgetCharged(), 64 * MiB); other.release();
});
