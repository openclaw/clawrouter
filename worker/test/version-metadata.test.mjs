import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { default: worker } = await import("../index.ts");
const versionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const context = { waitUntil() {} };

test("health and Worker responses identify the runtime version, not caller or upstream claims", async () => {
  const env = { CF_VERSION_METADATA: { id: versionId }, ASSETS: { fetch: async () => new Response("asset", { headers: { "x-clawrouter-version-id": "upstream" } }) } };
  for (const [path, status] of [["/v1/health", 200], ["/", 302], ["/missing", 404], ["/v1/models", 401], ["/assets/test.js", 200]]) {
    const response = await worker.fetch(new Request(`https://example.com${path}`, { headers: { "x-clawrouter-version-id": "caller" } }), env, context);
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get("x-clawrouter-version-id"), versionId, path);
    if (path === "/v1/health") assert.equal((await response.json()).versionId, versionId);
    else await response.text();
  }
  const invalid = await worker.fetch(new Request("https://example.com/v1/health", { headers: { "x-request-id": "invalid id" } }), env, context);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("x-clawrouter-version-id"), versionId);
});

test("metadata is optional for local/custom environments without a binding", async () => {
  const response = await worker.fetch(new Request("https://example.com/v1/health"), {}, context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawrouter-version-id"), null);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.versionId, null);
});
