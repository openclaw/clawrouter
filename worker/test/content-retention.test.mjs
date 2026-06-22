import assert from "node:assert/strict";
import test from "node:test";
import { contentKey, retainRequestContent, retentionRequired } from "../content-retention.ts";

const auth = {
  credentialId: "credential",
  principalId: "user@example.com",
  authType: "proxy_key",
  policyId: "policy",
  policy: { enabled: true, generation: "v1", providers: [], tenantId: "tenant/name", retainRequestContent: true },
  contentRetentionDisabled: false,
};
const selection = { provider: { id: "openai" }, model: { id: "openai/model" }, capability: "llm.chat", body: { messages: [{ role: "user", content: "hello" }] } };

test("retention is default-on for LLM requests and stores a bounded record", async () => {
  const writes = [];
  const ref = await retainRequestContent({ CONTENT_ARCHIVE: { put: async (...args) => writes.push(args) } }, auth, selection, "request");
  assert.match(ref, /^content_/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], contentKey("tenant/name", ref));
  const record = JSON.parse(writes[0][1]);
  assert.deepEqual(record.body, selection.body);
  assert.equal(record.requestId, "request");
  assert.equal(record.expiresAtMs - record.occurredAtMs, 30 * 86_400_000);
  assert.equal(writes[0][2].customMetadata.expiresAt, String(record.expiresAtMs));
});

test("policy opt-out, user exemption, and non-LLM traffic bypass retention", async () => {
  assert.equal(retentionRequired({ ...auth, policy: { ...auth.policy, retainRequestContent: false } }, "llm.chat"), false);
  assert.equal(retentionRequired({ ...auth, contentRetentionDisabled: true }, "llm.chat"), false);
  assert.equal(retentionRequired(auth, "web.search"), false);
  let writes = 0;
  const ref = await retainRequestContent({ CONTENT_ARCHIVE: { put: async () => { writes += 1; } } }, { ...auth, contentRetentionDisabled: true }, selection, "request");
  assert.equal(ref, null);
  assert.equal(writes, 0);
});
