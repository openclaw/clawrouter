# Native response wire contract

The OpenAI unified inference routes, explicit `/v1/native/openai/*` and
`/v1/proxy/openai/*` routes use OpenAI-shaped router errors:

```json
{"error":{"message":"a valid ClawRouter proxy key is required","type":"invalid_request_error","param":null,"code":"invalid_proxy_key"}}
```

Anthropic `/v1/messages`, `/v1/messages/count_tokens`, and explicit native/manifest
Anthropic routes use Claude-shaped router errors:

```json
{"type":"error","error":{"type":"authentication_error","message":"a valid ClawRouter proxy key is required"},"request_id":"req_..."}
```

HTTP status remains the router's actual decision (including budget `402` and
unavailable-pool `503`). Claude error types follow the native status contract;
`402` is `billing_error`. Router-specific diagnostics are also available in
`x-clawrouter-error-code`, without inserting a non-native `code` into Claude's
error object. Management APIs retain their existing error bodies. Errors from
an upstream provider are not branded as router-generated errors.

## Streaming errors

- Non-streaming provider responses remain opaque.
- A streaming request rejected with native JSON retains the upstream HTTP status
  and valid native JSON bytes, including OpenAI `param`/`code`, Claude
  `type`/`request_id`, and extension fields.
- A non-2xx SSE rejection is converted to a native JSON error without changing its
  HTTP status. Missing or unreadable details receive a native-shaped fallback;
  `Retry-After` and provider request IDs survive.
- An error event after HTTP 200 stays HTTP 200 SSE **even if it is the first
  event**. No synthetic HTTP 502 or guessed status is substituted. Unknown native
  SSE events, UTF-8, and line endings remain byte-identical.
- First-event inspection remains bounded and owns the endpoint deadline. Stream
  delivery, cancellation, and accounting keep their existing owners. A protocol
  error after HTTP 200 does not prove that dispatched work was free: absent
  authoritative usage, existing conservative settlement still applies.

## Correlation and browsers

`request-id` and `x-request-id` from upstream survive unchanged. Use
`x-clawrouter-request-id` to correlate with the router's usage events/logs; it is
separate from native provider IDs and cannot be set by upstream. Router-generated
Claude errors use this router ID in both `request_id` and `request-id`. The legacy
`x-request-id` alias remains when neither native ID is present.

Browser responses expose both native ID headers, router correlation/diagnostic
headers, `Retry-After`, and actual `x-ratelimit-*` / `anthropic-ratelimit-*`
headers. Arbitrary provider headers are not automatically exposed.

CORS permits `X-Client-Request-Id`, `anthropic-user-profile-id`, and
`anthropic-workspace-id`; this is **not** authorization to forward a workspace
selector or other header. Actual forwarding and tenancy policy remain separate.
DELETE is not advertised because no current public provider route uses it.

These wire guarantees do not add new native API operations, change tenant or
resource ownership, or deploy any code.
