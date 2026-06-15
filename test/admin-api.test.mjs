import assert from "node:assert/strict";
import test from "node:test";
import { adminRequest } from "../scripts/admin-api.mjs";

test("admin API mutations carry admin and Access service credentials", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    CLAWROUTER_BASE_URL: process.env.CLAWROUTER_BASE_URL,
    CLAWROUTER_ADMIN_TOKEN: process.env.CLAWROUTER_ADMIN_TOKEN,
    CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET,
  };
  let request = null;
  process.env.CLAWROUTER_BASE_URL = "https://clawrouter.example/";
  process.env.CLAWROUTER_ADMIN_TOKEN = "admin-token";
  process.env.CF_ACCESS_CLIENT_ID = "access-id";
  process.env.CF_ACCESS_CLIENT_SECRET = "access-secret";
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await adminRequest("/v1/admin/keys/svc_docs/revoke", {
      method: "POST",
    });
    assert.deepEqual(response, { ok: true });
    assert.equal(request.url, "https://clawrouter.example/v1/admin/keys/svc_docs/revoke");
    assert.equal(request.init.headers.authorization, "Bearer admin-token");
    assert.equal(request.init.headers["CF-Access-Client-Id"], "access-id");
    assert.equal(request.init.headers["CF-Access-Client-Secret"], "access-secret");
    assert.equal(request.init.redirect, "manual");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  }
});

function restoreEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
