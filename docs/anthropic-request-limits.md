# Claude JSON request limits

ClawRouter accepts up to **32 MB (32,000,000 bytes)** on Anthropic Messages and token-counting routes, including their unified, native, and manifest-envelope forms. Resolved [OpenAI native and manifest conversation routes](openai-request-limits.md) also opt into the same 32 MB envelope and share its two expanded-request slots. Other JSON routes retain the 8 MiB limit. For the manifest route, the envelope counts toward the ingress limit too.

Ingress reads incrementally, checks actual byte counts before decoding each chunk, and cancels at the first over-limit chunk. A `Content-Length` above the limit is rejected without reading the body; an absent or understated length cannot bypass the limit. Bodies **at or below 8 MiB** retain the existing `JSON.parse` semantics and cost. Only after crossing 8 MiB does ingress switch to the streaming JSON tokenizer with 4 KiB feeds, first processing the buffered prefix. It assembles values directly rather than retaining a second whole decoded document. Malformed JSON remains a 400; oversized or structurally excessive expanded input is a 413.

## Authentication and concurrency

Before parsing the chunk that crosses 8 MiB or reading another chunk, the Worker authenticates the caller against the existing authority. Invalid/missing proxy keys receive 401 after no more than the ordinary envelope plus one transport chunk, rather than allowing anonymous callers to consume the full expanded envelope. Normal selection-aware authorization still runs after parsing, preserving current credential, policy and grant checks. Bodies within 8 MiB keep existing error precedence.

At most **two authenticated expanded requests per isolate** can be in flight across these routes, including free token counting. Further requests receive HTTP **503** with `Retry-After: 1` and an Anthropic-shaped `type: error` / `error.type: overloaded_error` body. This rejection occurs before budget reservation, retention or upstream dispatch and is **nonbillable**. Small requests do not use these slots. Slots release in `finally` on parse/admission failure or on observed response completion, failure or cancellation; response headers alone do not release a slot while an accounting closure can still own the input. Cancellation depends on the runtime reporting it; see the [HTTP cancellation contract](api-reference.md#http-cancellation-diagnostics).

Pricing counts the same chunked serialization used for large outbound bodies. Both upstream delivery and optional R2 retention use **known-length streams**. Neither transport nor retention creates another whole-document serialization. This is not an unbounded `request.json()` or a tee that drains ahead of the caller.

## Platform constraints

Checked 2026-10-21:

- [Claude API error/request-size documentation](https://platform.claude.com/docs/en/api/errors#request-size-limits) lists **32 MB** for Messages and Token Counting, not MiB. It does not specify an alternative binary byte count. ClawRouter interprets the published unit as decimal and enforces **32,000,000 bytes**, rather than the larger 33,554,432-byte MiB interpretation. Anthropic remains authoritative for its own byte/media validation.
- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits) allow request bodies of **100 MB** on Free/Pro account plans, **200 MB** on Business, and up to **5 GB** on Enterprise. The Worker request-size ceiling therefore does not prevent a 32 MB request.
- [Worker memory](https://developers.cloudflare.com/workers/platform/limits/#memory) is **128 MB per isolate**, not per request. A byte cap alone cannot bound JSON object expansion. Claude bodies **above 8 MiB only** therefore also cap **65,536 values, 128 container nesting levels, and 4,096 characters per object key or numeric lexeme**, returning 413 when exceeded. Large string/media values remain permitted up to the byte envelope. These structural safeguards and the two-request admission limit are deliberate Worker-specific constraints, not unrestricted native-API parity. Workerd regressions cover routing, real Durable Object accounting, R2, concurrent admission and cancellation; they are not production heap-capacity certification. Small requests and other traffic still share the isolate memory budget.

## Budget and retention behavior

The larger transport envelope does not waive monetary admission. The #292 image-header bound still substitutes visual-token ceilings for recognized inline image data in qualifying content positions. Large base64 PDFs, unknown image encodings, and nonqualifying media keep the existing full-model input-window reservation. Token counting remains free.

When R2 retention is enabled, the **complete request, including whole documents/PDFs and inline media**, is retained—not just extracted text. Existing policy defaults, user exemptions, 30-day expiry and admin-only inspection remain unchanged. The R2 metadata envelope adds a small amount beyond the request bytes, and the upload still finishes before provider dispatch. See [Request content retention](content-retention.md). No paid provider calls or deployment are part of this validation.
