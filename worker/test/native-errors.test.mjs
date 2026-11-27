import assert from "node:assert/strict";
import test from "node:test";
import { errorResponse } from "../utils.ts";
import { withNativeLocalError } from "../native-errors.ts";

// Status/type pairs are the native Claude API error contract, not router codes.
for (const [status, type] of [
  [400, "invalid_request_error"], [401, "authentication_error"], [402, "billing_error"],
  [403, "permission_error"], [404, "not_found_error"], [409, "conflict_error"],
  [413, "request_too_large"], [429, "rate_limit_error"], [500, "api_error"],
  [503, "api_error"], [504, "timeout_error"], [529, "overloaded_error"],
]) test(`Claude router-owned ${status} uses native ${type} and separate diagnostics`, async () => {
  const response = withNativeLocalError(errorResponse("router_reason", "fixture explanation", status, undefined, { "retry-after": "12" }), "/v1/messages", "req_fixture");
  assert.equal(response.status, status);
  assert.equal(response.headers.get("retry-after"), "12");
  assert.equal(response.headers.get("request-id"), "req_fixture");
  assert.equal(response.headers.get("x-clawrouter-error-code"), "router_reason");
  assert.equal(await response.text(), JSON.stringify({ type: "error", error: { type, message: "fixture explanation" }, request_id: "req_fixture" }));
});

test("encoded native providers and playground aliases use the same error contract", async () => {
  for (const [path, anthropic] of [["/v1/decisions", false], ["/v1/native/%61nthropic/v1/messages", true], ["/v1/proxy/%6fpenai/responses", false], ["/v1/playground/v1/chat/completions", false], ["/v1/playground/proxy/anthropic/messages", true]]) {
    const response = withNativeLocalError(errorResponse("invalid_proxy_key", "fixture", 401), path, "req_fixture");
    assert.deepEqual(await response.json(), anthropic ? { type: "error", error: { type: "authentication_error", message: "fixture" }, request_id: "req_fixture" } : { error: { message: "fixture", type: "invalid_request_error", param: null, code: "invalid_proxy_key" } });
  }
});

test("upstream or already native errors cannot acquire router-owned provenance from their body or headers", async () => {
  const bytes = '{"error":{"code":"invalid_proxy_key","message":"opaque upstream"}}';
  const upstream = new Response(bytes, { status: 401, headers: { "x-clawrouter-error-code": "spoofed" } });
  const response = withNativeLocalError(upstream, "/v1/messages", "req_fixture");
  assert.equal(response, upstream);
  assert.equal(await response.text(), bytes);
});
