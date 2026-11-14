import assert from "node:assert/strict";
import test from "node:test";
import { isPublishedMusicInputSupport } from "../../shared/native-capabilities.ts";

const support = {
  version: "clawrouter.published-input.v1",
  publication: { method: "POST", path: "/v1/input-assets/openrouter/music", query: false, body: "native_plan",
    idempotencyKey: { header: "Idempotency-Key", pattern: "^[A-Za-z0-9._:-]{1,128}$" } },
  slot: "messages[0].content[1].image_url.url", count: 1, encoding: "base64_data_url",
  mimeTypes: ["image/png", "image/jpeg", "image/webp"], maxDecodedBytes: 8388608, maxJsonBytes: 12582912,
  maxForwardJsonBytes: 262144, maxLifetimeSeconds: 900, renewable: false, destinationAttempts: 1,
};

test("published music support preserves exact bounds and false values through JSON independently of key order", () => {
  assert.equal(isPublishedMusicInputSupport(JSON.parse(JSON.stringify(support))), true);
  assert.equal(isPublishedMusicInputSupport(Object.fromEntries(Object.entries(support).reverse())), true);
  assert.equal(support.renewable, false);
  assert.equal(support.publication.query, false);
});

test("publication support rejects incomplete, future, widened and authority-bearing records", () => {
  for (const value of [undefined, null, false, {}, [], { ...support, version: "next" },
    ...["permission", "admitted", "origin", "grant", "automatic"].map(key => ({ ...support, [key]: true })),
    ...Object.keys(support).map(key => { const copy = structuredClone(support); delete copy[key]; return copy; }),
    ...["maxDecodedBytes", "maxJsonBytes", "maxForwardJsonBytes", "maxLifetimeSeconds", "count", "destinationAttempts"].map(key => ({ ...support, [key]: support[key] + 1 })),
    { ...support, renewable: true }, { ...support, publication: { ...support.publication, query: true } },
    { ...support, publication: { ...support.publication, body: "manifest_envelope" } },
    { ...support, publication: { ...support.publication, origin: "https://untrusted.example" } },
    { ...support, publication: { ...support.publication, idempotencyKey: { header: "Other", pattern: ".*" } } },
    { ...support, slot: "messages[1].content[1].image_url.url" }, { ...support, encoding: "https" },
    { ...support, mimeTypes: ["image/png", "image/jpeg", "image/gif"] },
  ]) assert.equal(isPublishedMusicInputSupport(value), false);
});

test("nested publication records and MIME tuples are closed, including sparse arrays", () => {
  for (const key of Object.keys(support.publication)) {
    const value = structuredClone(support); delete value.publication[key];
    assert.equal(isPublishedMusicInputSupport(value), false);
  }
  const extra = structuredClone(support); extra.publication.idempotencyKey.retry = true;
  assert.equal(isPublishedMusicInputSupport(extra), false);
  const sparse = structuredClone(support); sparse.mimeTypes.length = 4;
  assert.equal(isPublishedMusicInputSupport(sparse), false);
});
