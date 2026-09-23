import assert from "node:assert/strict";
import test from "node:test";
import { adminRequest } from "../scripts/admin-api.mjs";

test("admin API mutations carry admin and Access service credentials", async () => {
  let request = null;
  const signal = new AbortController().signal;
  const response = await adminRequest("/v1/admin/keys/svc_docs/revoke", {
    method: "POST",
    signal,
    env: {
      CLAWROUTER_BASE_URL: "https://clawrouter.example/",
      CLAWROUTER_ADMIN_TOKEN: "admin-token",
      CF_ACCESS_CLIENT_ID: "access-id",
      CF_ACCESS_CLIENT_SECRET: "access-secret",
    },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(response, { ok: true });
  assert.equal(request.url, "https://clawrouter.example/v1/admin/keys/svc_docs/revoke");
  assert.equal(request.init.headers.authorization, "Bearer admin-token");
  assert.equal(request.init.headers["CF-Access-Client-Id"], "access-id");
  assert.equal(request.init.headers["CF-Access-Client-Secret"], "access-secret");
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.init.signal, signal);
});

test("admin API cancels oversized response streams at the shared byte limit", async () => {
  let cancelled = false;
  let reads = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(adminRequest("/v1/admin/overview", {
    method: "GET",
    env: { CLAWROUTER_BASE_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "admin-fixture" },
    fetchImpl: async () => response,
  }), /admin API response was too large/);
  assert.equal(cancelled, true);
  assert.ok(reads <= 4);
});
