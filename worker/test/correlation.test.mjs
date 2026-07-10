import assert from "node:assert/strict";
import test from "node:test";

import {
  correlateIngressRequest,
  correlationMetadata,
  normalizeRequestId,
  parseTraceparent,
  withRequestId,
} from "../correlation.ts";
import { caughtResponse, corsPreflight, errorResponse, withCors } from "../utils.ts";

test("ingress echoes one safe request id across success, owned errors, and CORS", async () => {
  const correlated = correlateIngressRequest(new Request("https://router.example/v1/health", {
    headers: { "x-request-id": "caller_123" },
  }));
  const supplied = withCors(withRequestId(Response.json({ ok: true }), correlated.requestId));
  assert.equal(supplied.status, 200);
  assert.equal(supplied.headers.get("x-request-id"), "caller_123");
  assert.match(supplied.headers.get("access-control-expose-headers"), /(?:^|,)\s*x-request-id(?:,|$)/);

  const missingA = correlateIngressRequest(new Request("https://router.example/v1/health"));
  const missingB = correlateIngressRequest(new Request("https://router.example/v1/health"));
  assert.match(missingA.requestId, /^req_[a-f0-9]{32}$/);
  assert.match(missingB.requestId, /^req_[a-f0-9]{32}$/);
  assert.notEqual(missingA.requestId, missingB.requestId);

  const ownedError = withRequestId(errorResponse("route_not_found", "route not found", 404), "owned_error");
  assert.equal(ownedError.status, 404);
  assert.equal(ownedError.headers.get("x-request-id"), "owned_error");

  const preflight = withRequestId(corsPreflight(), missingA.requestId);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /(?:^|,)\s*x-request-id(?:,|$)/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /(?:^|,)\s*traceparent(?:,|$)/);
  assert.match(preflight.headers.get("access-control-expose-headers"), /(?:^|,)\s*x-request-id(?:,|$)/);
});

test("invalid and oversized request ids are rejected without reflection", async () => {
  for (const rejected of ["bad id", "bad\tid", "x".repeat(129), "ümlaut", ""]) {
    const correlated = correlateIngressRequest(new Request("https://router.example/v1/health", {
      headers: { "x-request-id": rejected },
    }));
    assert.equal(correlated.error?.status, 400);
    assert.equal(correlated.error?.code, "invalid_request_id");
    assert.match(correlated.requestId, /^req_[a-f0-9]{32}$/);
    assert.notEqual(correlated.requestId, rejected);
  }
  assert.equal(normalizeRequestId("  caller.trimmed  "), "caller.trimmed");
});

test("canonical attribution wins and documented session fallbacks normalize once", () => {
  const explicit = correlateIngressRequest(new Request("https://router.example/v1/health", {
    headers: {
      "x-clawrouter-session-id": "openclaw-session",
      "x-claude-code-session-id": "claude-session",
      "session-id": "codex-session",
      "x-clawrouter-agent-id": "configured-agent",
      "x-claude-code-agent-id": "native-agent",
      "x-clawrouter-project-id": "project-one",
      "x-clawrouter-client": "openclaw",
    },
  }));
  assert.equal(explicit.error, null);
  assert.deepEqual(correlationMetadata(explicit.request), {
    requestId: explicit.requestId,
    traceId: null,
    spanId: null,
    sessionId: "openclaw-session",
    agentId: "configured-agent",
    parentAgentId: null,
    projectId: "project-one",
    client: "openclaw",
  });

  const claudeFallback = correlateIngressRequest(new Request("https://router.example/v1/health", {
    headers: { "x-claude-code-session-id": "claude-session" },
  }));
  assert.equal(correlationMetadata(claudeFallback.request).sessionId, "claude-session");

  const codexFallback = correlateIngressRequest(new Request("https://router.example/v1/health", {
    headers: { "session-id": "codex-session" },
  }));
  assert.equal(correlationMetadata(codexFallback.request).sessionId, "codex-session");
});

test("unsafe selected attribution is rejected while lower-priority input cannot override explicit values", () => {
  const invalid = correlateIngressRequest(new Request("https://router.example/v1/health", {
    headers: {
      "x-request-id": "attribution_error",
      "x-clawrouter-session-id": "bad session",
      "session-id": "safe-fallback",
    },
  }));
  assert.equal(invalid.error?.code, "invalid_attribution_id");
  assert.match(invalid.error?.message, /x-clawrouter-session-id/i);

  const explicit = correlateIngressRequest(new Request("https://router.example/v1/health", {
    headers: {
      "x-clawrouter-session-id": "explicit-session",
      "session-id": "ignored unsafe fallback",
    },
  }));
  assert.equal(explicit.error, null);
  assert.equal(correlationMetadata(explicit.request).sessionId, "explicit-session");
});

test("W3C traceparent parsing accepts bounded lineage and ignores invalid contexts", () => {
  const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  assert.deepEqual(parseTraceparent(valid), {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
  });
  assert.deepEqual(
    parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future"),
    { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" },
  );
  for (const invalid of [
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0g",
    "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
  ]) assert.equal(parseTraceparent(invalid), null);
});

test("unhandled owned errors log only bounded request correlation metadata", async () => {
  const logs = [];
  const original = console.error;
  console.error = (...values) => logs.push(values);
  try {
    const response = withRequestId(
      caughtResponse(new Error("private-body-and-secret-sentinel"), "safe_log_id"),
      "safe_log_id",
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("x-request-id"), "safe_log_id");
  } finally {
    console.error = original;
  }
  assert.deepEqual(logs, [["unhandled request error", { request_id: "safe_log_id" }]]);
  assert.doesNotMatch(JSON.stringify(logs), /private-body-and-secret-sentinel/);
});
