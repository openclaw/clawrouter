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
error object. Native expired-key errors use only the native envelope; `expiresAt`,
`expired` and `active` remain available on the management `/v1/key/inspect` path.
Management APIs retain their existing error bodies. Errors from
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
  delivery, cancellation, and accounting keep their existing owners. A first
  error event before generation starts is a provisional received rejection:
  both budget reservations release to zero only while subsequent events remain
  empty or errors, including background creates and cancellations. Terminal-only
  `[DONE]` and Anthropic `message_stop` markers carry no content or usage and do
  not withdraw that zero-charge evidence. If a provider continues with actual
  content or usage, even after such a marker, authoritative later usage settles
  the request; missing or uninspectable usage retains the conservative reservation.
  Delivery bytes and the original error outcome stay unchanged. Background
  rejection settlement waits for delivery rather than freezing a free receipt
  before later work can be observed. Response identities after an initial error
  are not published as continuations.
  Claude hard-budget responses still pass through the
  [response pricing guard](anthropic-price-modifiers.md): an oversized frame may
  be withheld and replaced with its native pricing error. That guard retains the
  reservation and records a `502` pricing failure even if SSE headers were already
  delivered as `200`; an error followed only by a terminal marker remains free.
  Errors after `response.created` or `message_start` retain actual or conservative
  charges; HTTP 200 alone is not billing evidence.

## Correlation and browsers

`request-id` and `x-request-id` from upstream survive unchanged. Use
`x-clawrouter-request-id` to correlate with the router's usage events/logs; it is
separate from native provider IDs and cannot be set by upstream. Router-generated
Claude errors use this router ID in both `request_id` and `request-id`. The legacy
`x-request-id` alias remains when neither native ID is present.

Browser responses expose both native ID headers, router correlation/diagnostic
headers, `Retry-After`, and actual `x-ratelimit-*` / `anthropic-ratelimit-*`
headers. Arbitrary provider headers are not automatically exposed. Upstream organization,
project and workspace response IDs are stripped from all clients so pooled
operator tenancy identifiers are not disclosed.

CORS permits `X-Client-Request-Id`, `anthropic-user-profile-id`, and
`anthropic-workspace-id`; this is **not** authorization to forward a workspace
selector or other header. Actual forwarding and tenancy policy remain separate.
DELETE is not advertised because no current public provider route uses it.

These wire guarantees do not add new native API operations, change tenant or
resource ownership, or deploy any code.
