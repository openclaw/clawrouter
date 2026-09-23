import assert from "node:assert/strict";
import test from "node:test";
import { adminRequest } from "../scripts/admin-api.mjs";

const env = { CLAWROUTER_BASE_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "admin-fixture" };
const acknowledge = (response) => adminRequest("/v1/admin/upstream-grants/policies/fixture/openai", {
  method: "PUT", env, responseMode: "ack", fetchImpl: async () => response,
});

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

test("mutation acknowledgment discards an oversized success without reading its payload", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("private-success-fixture".repeat(10_000))); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json; charset=utf-8" } });
  assert.equal(await acknowledge(response), undefined);
  assert.equal(cancelled, true);
});

for (const cleanup of ["pending", "rejecting"]) {
  test(`acknowledgment does not await ${cleanup} body cancellation`, async () => {
    let release, cancelled = false, timer;
    const response = new Response(new ReadableStream({
      cancel() {
        cancelled = true;
        return cleanup === "pending" ? new Promise((resolve) => { release = resolve; }) : Promise.reject(new Error("private-cleanup-fixture"));
      },
    }), { headers: { "content-type": "application/json" } });
    try {
      await Promise.race([
        acknowledge(response),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("acknowledgment waited for cleanup")), 500); }),
      ]);
      assert.equal(cancelled, true);
    } finally { clearTimeout(timer); release?.(); }
  });
}

for (const contentType of ["application/json", "Application/JSON; Charset=UTF-8", 'application/json; charset="utf-8"; note="a;b\\\"c"', "application/json; ; charset=utf-8"]) {
  test(`acknowledgment accepts the JSON media type ${contentType}`, async () => {
    assert.equal(await acknowledge(new Response("unused", { headers: { "content-type": contentType } })), undefined);
  });
}

test("acknowledgment accepts bodyless 204", async () => {
  assert.equal(await acknowledge(new Response(null, { status: 204 })), undefined);
});

for (const contentType of [null, "text/html", "application/problem+json", "application/jsonp", "text/application/json", "application/json, text/html", "application/json garbage", "application/json; charset", "application/json; charset=", 'application/json; charset="unterminated', 'application/json; charset="utf-8"garbage']) {
  test(`acknowledgment rejects missing or invalid JSON media type ${contentType}`, async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: contentType === null ? {} : { "content-type": contentType },
    });
    await assert.rejects(acknowledge(response), { message: "admin API returned non-JSON 200" });
    assert.equal(cancelled, true);
  });
}

for (const responseMode of ["ack", "json"]) {
  test(`${responseMode} keeps errors bounded and does not expose raw response data`, async () => {
    for (const [response, message] of [
      [Response.json({ error: { message: "policy does not exist" }, secret: "private-error-fixture" }, { status: 400 }), /failed \(400\): policy does not exist/],
      [new Response("private-error-fixture", { status: 403 }), /returned non-JSON 403/],
      [Response.json({ secret: "private-error-fixture", padding: "x".repeat(128 * 1024) }, { status: 500 }), /response was too large/],
    ]) {
      await assert.rejects(adminRequest("/v1/admin/fixture", { method: "POST", env, responseMode, fetchImpl: async () => response }), (error) => {
        assert.match(error.message, message);
        assert.ok(!error.message.includes("private-error-fixture"));
        return true;
      });
    }
  });
}
