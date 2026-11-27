import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const { default: worker } = await import("../index.ts");
const { contentKey, retainRequestContent } = await import("../content-retention.ts");
const { sha256Hex } = await import("../utils.ts");
const token = "synthetic-content-admin";
const adminHash = await sha256Hex(token);
const now = 1_800_000_000_000;
const tenant = "tenant/name", ref = "content/fixture";
const record = { version: "clawrouter.retained-request.v1", tenantId: tenant, contentRef: ref, expiresAtMs: now + 1, body: { input: "synthetic private request" } };
const notFound = { error: { code: "content_not_found", message: "retained request content was not found" } };

function lookup(get, { query = new URLSearchParams({ tenant, ref }), authorization = `Bearer ${token}` } = {}) {
  return worker.fetch(new Request(`https://router.example/v1/admin/content?${query}`, {
    headers: { authorization, "x-request-id": "content-regression" },
  }), { CLAWROUTER_ADMIN_TOKEN_SHA256: adminHash, CONTENT_ARCHIVE: { get } }, {
    waitUntil() { assert.fail("content reads must not start background work"); },
  });
}

function privateHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-request-id"), "content-regression");
}

test("the Worker reads fresh object and array records produced at their exact encoded keys", async (t) => {
  t.mock.method(Date, "now", () => now);
  const query = { provider: "openai", endpoint: "chat/completions", query: record.body };
  const cases = [
    ["object", "openai.chat", record.body, record.body],
    ["array", "cloudflare_ai_gateway.universal", [{ ...query, headers: { Authorization: "synthetic-upstream" }, authorization: "synthetic-upstream" }], [query]],
  ];
  for (const [name, request_format, body, expectedBody] of cases) {
    await t.test(name, async () => {
      const objects = new Map();
      const auth = { policy: { tenantId: tenant }, policyId: "policy", credentialId: "credential", principalId: null };
      const selection = { provider: { id: "local" }, endpoint: { request_format }, model: null, capability: "llm.chat", body };
      const generatedRef = await retainRequestContent({ CONTENT_ARCHIVE: { put: async (key, text) => objects.set(key, text) } }, auth, selection, "request");
      const reads = [];
      const response = await lookup(async (key) => {
        reads.push(key);
        return Object.assign(new Response(objects.get(key)), { uploaded: new Date(now) });
      }, { query: new URLSearchParams({ tenant, ref: generatedRef }) });
      assert.deepEqual(reads, [contentKey(tenant, generatedRef)]);
      assert.equal(response.status, 200);
      const returned = await response.json();
      assert.deepEqual(returned, JSON.parse(objects.get(reads[0])));
      assert.deepEqual(returned.body, expectedBody);
      privateHeaders(response);
    });
  }
});

test("missing, expired, and invalid archives have indistinguishable private 404 responses", async (t) => {
  t.mock.method(Date, "now", () => now);
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const variants = [
    ["missing", null],
    ["expired", JSON.stringify({ ...record, expiresAtMs: now - 1 })],
    ["expiry equals current time", JSON.stringify({ ...record, expiresAtMs: now })],
    ["missing expiry", JSON.stringify({ ...record, expiresAtMs: undefined })],
    ["null expiry", JSON.stringify({ ...record, expiresAtMs: null })],
    ["string expiry", JSON.stringify({ ...record, expiresAtMs: String(now + 1) })],
    ["boolean expiry", JSON.stringify({ ...record, expiresAtMs: true })],
    ["infinite expiry", JSON.stringify(record).replace(String(now + 1), "1e400")],
    ["non-v1", JSON.stringify({ ...record, version: "clawrouter.retained-request.v2" })],
    ["wrong tenant", JSON.stringify({ ...record, tenantId: "another-tenant" })],
    ["wrong reference", JSON.stringify({ ...record, contentRef: "another-reference" })],
    ["malformed JSON", '{"body":"synthetic private request"'],
    ["null", "null"],
    ["array", JSON.stringify([record])],
    ["scalar", '"synthetic private request"'],
  ];
  for (const [name, text] of variants) {
    await t.test(name, async () => {
      const response = await lookup(async (key) => {
        assert.equal(key, contentKey(tenant, ref));
        return text === null ? null : Object.assign(new Response(text), { uploaded: new Date(now) });
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), notFound);
      privateHeaders(response);
    });
  }
  assert.deepEqual(errors, []);
});

test("expiry is checked after the asynchronous archive body read", async (t) => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const response = await lookup(async () => ({ uploaded: new Date(now), async text() {
    await Promise.resolve();
    clock = record.expiresAtMs;
    return JSON.stringify(record);
  } }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), notFound);
  privateHeaders(response);
});

test("archive upload age caps an overstated record expiry at 30 days", async (t) => {
  t.mock.method(Date, "now", () => now);
  const response = await lookup(async () => Object.assign(new Response(JSON.stringify(record)), { uploaded: new Date(now - 30 * 86_400_000) }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), notFound);
});

test("an earlier metadata expiry also denies reads before physical deletion", async (t) => {
  t.mock.method(Date, "now", () => now);
  const response = await lookup(async () => Object.assign(new Response(JSON.stringify(record)), { uploaded: new Date(now), customMetadata: { expiresAt: String(now) } }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), notFound);
});

test("unauthorized and invalid lookups never read the archive", async () => {
  const get = () => assert.fail("rejected lookup reached archive storage");
  for (const authorization of ["", "Bearer synthetic-wrong-admin"]) {
    const response = await lookup(get, { authorization });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "admin_unauthorized");
  }
  for (const query of [new URLSearchParams({ ref }), new URLSearchParams({ tenant }), new URLSearchParams({ tenant, ref: "x".repeat(257) })]) {
    const response = await lookup(get, { query });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_content_lookup");
  }
});

test("archive lookup and body transport failures remain redacted server errors", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const fail = async () => { throw new Error("synthetic private storage failure"); };
  for (const get of [fail, async () => ({ text: fail })]) {
    const response = await lookup(get);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "internal_error", message: "internal server error" } });
  }
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /synthetic private/);
});
