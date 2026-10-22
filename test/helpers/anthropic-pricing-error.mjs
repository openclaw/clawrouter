import assert from "node:assert/strict";

// Assert the client-visible contract, not the production envelope builder.
export function assertAnthropicPricingError(response, text, stream, requestId) {
  assert.ok(requestId);
  let value;
  if (stream) {
    const errors = text.split(/\r\n\r\n|\n\n|\r\r/).filter(frame => /^event: error$/m.test(frame));
    assert.equal(errors.length, 1, text);
    value = JSON.parse(errors[0].split(/\r\n|\n|\r/).find(line => line.startsWith("data: ")).slice(6));
    assert.equal(response.status, 200); assert.doesNotMatch(text, /message_stop/);
    assert.equal(response.headers.get("x-clawrouter-error-code"), null, "late SSE failure cannot rewrite sent headers");
    assert.equal(response.headers.get("request-id"), "fixture-upstream-id", "published provider ID survives the late error");
  } else {
    value = JSON.parse(text);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-clawrouter-error-code"), "pricing_required");
    assert.equal(response.headers.get("request-id"), requestId, "replacement JSON uses the router ID, not the provider ID");
  }
  assert.deepEqual(Object.keys(value).sort(), ["error", "request_id", "type"]);
  assert.deepEqual(Object.keys(value.error).sort(), ["message", "type"]);
  assert.equal(value.type, "error"); assert.equal(value.error.type, "api_error");
  assert.match(value.error.message, /Anthropic response pricing could not be verified/);
  assert.match(value.error.message, /reservation is retained/);
  assert.equal(value.request_id, requestId);
  assert.equal(response.headers.get("x-clawrouter-request-id"), requestId);
}
