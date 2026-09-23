import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const { default: worker } = await import("../index.ts");
const { sha256Hex } = await import("../utils.ts");
const adminToken = "synthetic-path-decoding-admin";
const env = { CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex(adminToken) };

const malformedRoutes = [
  ["POST", "/v1/proxy/%ZZ/search"],
  ["POST", "/v1/proxy/tavily/%"],
  ["POST", "/v1/native/%E0%A4/v1/chat/completions"],
  ["POST", "/v1/pool-submissions/pst_%FF/consume"],
  ["PUT", "/v1/admin/access-users/%ZZ"],
  ["PUT", "/v1/admin/access-user-grants/%ZZ"],
  ["PUT", "/v1/admin/policies/%ZZ"],
  ["POST", "/v1/admin/policies/%ZZ/revoke"],
  ["PUT", "/v1/admin/credentials/%ZZ"],
  ["POST", "/v1/admin/credentials/%ZZ/revoke"],
  ["PUT", "/v1/admin/connections/%ZZ"],
  ["PATCH", "/v1/admin/connections/%ZZ"],
  ["PUT", "/v1/admin/upstream-grants/policies/default/%ZZ"],
  ["PUT", "/v1/admin/assignment-rules/%ZZ"],
];

test("malformed route encodings are client errors without storage or upstream work", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  context.mock.method(globalThis, "fetch", () => assert.fail("malformed route reached upstream"));
  for (const [method, path] of malformedRoutes) {
    await context.test(`${method} ${path}`, async () => {
      const response = await worker.fetch(new Request(`https://router.example${path}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", "x-request-id": "encoding-regression" },
        body: "{}",
      }), env, { waitUntil() { assert.fail("malformed route started background work"); } });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: { code: "invalid_path_encoding", message: "path segment must use valid percent-encoded UTF-8" } });
      assert.equal(response.headers.get("x-request-id"), "encoding-regression");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
    });
  }
  assert.deepEqual(errors, []);
});

test("valid encoded unknown routes keep their not-found behavior", async () => {
  for (const path of ["/v1/proxy/tav%69ly/not-found", "/v1/native/%25/v1/chat/completions"]) {
    const response = await worker.fetch(new Request(`https://router.example${path}`, { method: "POST", body: "{}" }), {}, {});
    assert.equal(response.status, 404);
  }
});
