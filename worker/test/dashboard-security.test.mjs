import assert from "node:assert/strict";
import test from "node:test";
import { dashboardSecurityHeaders } from "../dashboard-security.ts";

test("dashboard documents receive a restrictive browser security policy", () => {
  const headers = dashboardSecurityHeaders(new Headers({ "content-type": "text/html" }));

  assert.equal(headers.get("cache-control"), "private, no-store");
  assert.match(headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(headers.get("permissions-policy"), "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("content-type"), "text/html");
});
