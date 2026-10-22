# Claude JSON request limits

ClawRouter accepts up to **32 MiB (33,554,432 bytes)** on Anthropic Messages and token-counting routes, including their unified, native, and manifest-envelope forms. Other JSON routes retain the 8 MiB limit. For the manifest route, the envelope counts toward the ingress limit too.

Ingress reads the stream incrementally, checks actual byte counts before decoding each chunk, and cancels at the first over-limit chunk. A `Content-Length` above the limit is rejected without reading the body; an absent or understated length cannot bypass the limit. The expanded routes use the existing streaming JSON tokenizer with 4 KiB feeds, assembling values directly rather than retaining a second whole decoded document for `JSON.parse`. Pricing counts the same chunked serialization used for large outbound bodies; optional R2 retention uses a known-length stream. Neither transport nor retention creates another whole-document serialization. This is **not** an unbounded `request.json()` or a tee that drains ahead of the caller. Malformed JSON remains a 400; oversized input is a 413. Authentication error precedence is unchanged.

## Platform constraints

Checked 2026-10-21:

- [Claude API error/request-size documentation](https://platform.claude.com/docs/en/api/errors#request-size-limits) lists **32 MB** for Messages and Token Counting. The implementation uses a 32 MiB byte ceiling; Anthropic remains authoritative for its own byte/media validation.
- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits) allow request bodies of **100 MB** on Free/Pro account plans, **200 MB** on Business, and up to **5 GB** on Enterprise. The Worker request-size ceiling therefore does not prevent a 32 MiB request.
- [Worker memory](https://developers.cloudflare.com/workers/platform/limits/#memory) is **128 MB per isolate**, not per request. A byte cap alone cannot bound JSON object expansion. Expanded Claude ingress therefore also caps **65,536 values, 128 container nesting levels, and 4,096 characters per object key or numeric lexeme**, returning 413 when exceeded. Large string/media values remain permitted up to the byte envelope. These structural safeguards are a deliberate Worker-specific constraint rather than a native-API parity claim. Workerd regression coverage exercises large media through routing, real Durable Object accounting, and R2 retention; it is not a production concurrency or heap-capacity certification. Concurrent large requests still share the platform isolate budget.

## Budget behavior

The larger transport envelope does not waive monetary admission. The #292 image-header bound still substitutes visual-token ceilings for recognized inline image data in qualifying content positions. Large base64 PDFs, unknown image encodings, and nonqualifying media keep the existing full-model input-window reservation. Token counting remains free. No paid provider calls or deployment are part of this validation.
