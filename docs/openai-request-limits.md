# OpenAI JSON request limits

ClawRouter accepts up to **32 MB (32,000,000 UTF-8 bytes)** on the following resolved **OpenAI native and manifest routes**:

| Endpoint | Native route | Manifest route |
| --- | --- | --- |
| Responses | `/v1/native/openai/v1/responses` | `/v1/proxy/openai/responses` |
| Chat Completions | `/v1/native/openai/v1/chat/completions` | `/v1/proxy/openai/chat_completions` |
| Responses compaction | `/v1/native/openai/v1/responses/compact` | `/v1/proxy/openai/responses_compact` |
| Responses input token counting | `/v1/native/openai/v1/responses/input_tokens` | `/v1/proxy/openai/responses_input_tokens` |

The manifest envelope counts toward the limit. Unified OpenAI-style routes such as `/v1/responses` and `/v1/chat/completions`, other OpenAI endpoints, OpenAI-compatible providers, admin APIs, private Codex routes and WebSocket frames keep their existing limits. This change fixes large native conversations without expanding routes whose provider is not resolved before body intake.

## Safeguards

These routes reuse the [Claude expanded JSON safeguards](anthropic-request-limits.md): incremental actual-byte checks regardless of `Content-Length`, authentication before parsing beyond the ordinary 8 MiB envelope, streaming JSON parsing, and limits of 65,536 values, 128 nesting levels and 4,096 characters per object key or numeric lexeme above 8 MiB. Invalid JSON remains a 400; byte or structural excess is a 413.

OpenAI and Claude share **two expanded requests per isolate**. Slots remain occupied through response delivery or observed cancellation, not just upload or receipt of response headers. Excess authenticated traffic receives a nonbillable **503** with `Retry-After: 1`, before provider dispatch or budget reservation; OpenAI errors use the existing native error normalization. Small requests do not occupy expanded slots. Missing or invalid credentials still receive 401 before expanded parsing.

Pricing avoids whole-document serialization for these formats. Large upstream bodies and retained request records use known-length streams. Full-content retention, fail-closed large retention before dispatch, model/account authorization and monetary admission remain unchanged. Token counting remains free.

## Why not 512 MB?

Checked 2026-10-26: [OpenAI's image-input documentation](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements) lists up to **512 MB total payload per request**. That is an upstream image-input allowance, not a promise that every endpoint accepts an arbitrary JSON body of that size.

[Cloudflare Workers memory](https://developers.cloudflare.com/workers/platform/limits/#memory) is **128 MB per isolate**, shared by concurrent requests, and [edge request-body limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits) also depend on the account plan. ClawRouter therefore uses its existing guarded 32 MB envelope rather than claiming direct-API parity. Structural/concurrency safeguards are not production heap-capacity certification; other traffic still shares the isolate. Upstream token, media, model and account limits remain authoritative.
