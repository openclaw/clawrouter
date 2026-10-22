# Native request-header boundaries

ClawRouter forwards selected native request metadata, not caller authority over a pooled credential. This is not a claim of complete native API parity.

| Header | Behavior | Authority / limitation |
| --- | --- | --- |
| `anthropic-user-profile-id` | Forward on Anthropic operations through the provider allowlist. | Caller-asserted upstream attribution only; never authenticates a caller, selects a grant or proves workspace membership. |
| `anthropic-workspace-id` | Authenticated Anthropic requests containing the header, including an empty value, receive HTTP 403 with an Anthropic `type: error` / `permission_error` envelope and matching `request_id` / `request-id`. No upstream request is made. | Policies, provider connections and grants currently have no explicitly authorized workspace binding. Neither a claimed-own value nor an environment credential establishes one. Silently discarding it could execute in the wrong workspace. |
| `X-Client-Request-Id` | Forward on all currently bundled OpenAI native operations: Responses create/retrieve/cancel/compact and WebSocket, Chat Completions, Embeddings, Realtime WebSocket, multipart Transcriptions, Speech and Image Generations. | Diagnostic correlation only. Different IDs on create/control calls do not alter the original response owner, credential or route digest. Native upstream validation still applies. |
| `Idempotency-Key` | Do not forward caller values, even if a future manifest accidentally allowlists them. | Out of scope until a supported operation has an explicitly authorized, durable owner-bound replay contract. No replay, retry, deduplication or exactly-once guarantee is provided. |

The request-header copier defensively blocks both workspace selectors and replay keys case-insensitively. Trusted provider configuration is not a caller-selected tenancy binding. Diagnostic IDs are endpoint metadata rather than global OpenAI adapter passthrough: the existing response-owner digest includes adapter passthrough and must not bind a generation to one diagnostic ID. Response controls carry the new per-call ID across credential-owner dispatch without persisting it as ownership. Multipart requests rebuild their framing while preserving file bytes/fields and the diagnostic header.

## Integration boundaries and decision needed

- Workspace selection can become available only after an explicit policy/grant workspace-binding model and authorization rules are designed, including pooled-grant eligibility and mismatch behavior. Do not replace the denial with blind forwarding.
- The denial is already native-shaped on its own. An outer native-error boundary must preserve it rather than wrap or transform it a second time. New Anthropic routes that bypass `proxySelected` must enforce the same guard after authentication and before any upstream work.
- Browser CORS ownership is separate: allow `anthropic-user-profile-id`, `anthropic-workspace-id` and `x-client-request-id` in the shared ingress allowlist. This change does not modify that parent-owned boundary or advertise idempotency support.
- New OpenAI operations must explicitly declare diagnostic passthrough. Do not infer support for absent operations from this list.

## Native evidence

- Anthropic TypeScript SDK `sdk-v1.1.0`, commit `5badc765f17d373405f300ee8e69e7f490b1f172`: [`messages-request.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/5badc765f17d373405f300ee8e69e7f490b1f172/src/lib/internal/messages-request.ts) maps `user_profile_id` / `workspace_id` to their headers. The same revision's [`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/5badc765f17d373405f300ee8e69e7f490b1f172/src/resources/messages/messages.ts) describes profile attribution and requires an explicitly supplied workspace to match workspace-bound credentials. A pooled credential is not permission to select any workspace.
- OpenAI [API overview: debugging requests](https://developers.openai.com/api/reference/overview#debugging-requests), inspected October 21, 2026: client-supplied `X-Client-Request-Id` is diagnostic metadata, supported across endpoints including Chat Completions, Embeddings and Responses; values must be ASCII and at most 512 characters. This is not evidence of idempotency support.

## Behavioral verification

`test/native-request-headers-workerd.test.mjs` runs the real Worker and SQLite Durable Objects against a synthetic workerd upstream. It observes exact outgoing headers and JSON/binary bytes, denied-workspace zero egress across environment/pooled lanes, pooled response-control dispatch with changing diagnostic IDs, multipart file bytes/fields on public aliases and both native WebSocket transports. No live provider requests or credentials are used.
