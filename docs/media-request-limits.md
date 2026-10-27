# Media JSON request limits

ClawRouter accepts up to **32 MB (32,000,000 bytes)** on media-bearing generation routes: Claude Messages and token counting, OpenAI-format Responses (create, compact and input-token counting), and Chat Completions. This covers their unified, native, and manifest-envelope forms, and every provider using those request formats. Other JSON routes retain the 8 MiB limit. For the manifest route, the envelope counts toward the ingress limit too. Unified `/v1/responses` and `/v1/chat/completions` admit the larger envelope before the model is resolved; a body above 8 MiB that resolves to another format, or to `clawrouter/fusion`, receives 413.

## What fits, and what does not

The limit applies to the **whole request**, and over HTTP that means the whole conversation: Codex and other agents resend every earlier screenshot on every turn, so images accumulate until the history crosses 32 MB. Codex prepares high-detail images at up to 2048 px and 2,500 patches (about 2048×1248), so a screenshot costs roughly:

| Screenshot content | Base64 per image | Images per 32 MB request |
| --- | --- | --- |
| Text-heavy UI (editor, terminal, docs) | ~0.5 MiB | ~60 |
| UI with photos or gradients (about a quarter of the area) | ~2.5 MiB | ~12 |
| Incompressible worst case (noise, dense photos) | ~9.8 MiB | 3 |

Production probe, 2026-10-27, synthetic screenshots of those three kinds at 2048×1248, `openai/gpt-6.1-sol`:

| Request | Size | Result |
| --- | --- | --- |
| Responses input tokens, 10 / 25 / 50 UI screenshots | 4.8 / 12.1 / 24.2 MiB | 200 (30k / 75k / 150k tokens) |
| Responses input tokens, 11 mixed / 3 worst-case images | 27.0 / 29.3 MiB | 200 |
| Chat Completions, 40 UI screenshots | 19.4 MiB | 200 |
| Responses WebSocket `generate: false`, 25 UI / 3 worst-case images | 12.1 / 29.3 MiB | `response.completed` |
| 4 concurrent 22 MiB Responses requests from one client | 4 × 22.1 MiB | all 200 |
| Responses input tokens, 4 worst-case images | 39 MiB | 413 `request_too_large` |
| Responses WebSocket frame | 33.2 MB | `error` event, status 413 `request_too_large` |

The probe key could not reach Claude models, so Claude routes are covered by the Worker tests (29 MiB turns), not this probe.

### Limitations

- **Over 32 MB is a hard 413.** Nothing is buffered or spilled elsewhere. Codex retries a 413 and then fails the turn; because the next turn resends the same history, the thread stays over the limit. Remote compaction sends that history too, so it can hit the same 413. Start a new thread, or drop or downscale images before the history crosses the limit.
- **WebSocket sends only new input per turn.** Over a Responses WebSocket, a continuation carries just the new items plus `previous_response_id`, so the 32 MB applies to one turn's additions rather than the whole history. Prefer it for long, screenshot-heavy sessions.
- **Concurrent large requests may get 503.** Requests in one isolate share the 96 MiB body budget below, so a burst of near-limit bodies can receive a nonbillable `503` with `Retry-After: 1`. Codex retries it. Bursts are often spread across isolates; the probe above saw none.
- **Upload time scales with size.** A 25–30 MB body took 14–16 s end to end on the probe's connection, nearly all of it upload.
- **Providers have their own rules.** Claude rejects any image over 10 MB of base64, accepts at most 100 or 600 images per request depending on the model, and when a request has **more than 20 images** rejects any image over 2000 px on either side ([Claude vision limits](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits)). Screenshots wider than 2000 px, such as Codex's 2048 px ones, therefore fail on Claude once a request holds 21 of them. ClawRouter does not resize images, so these surface as provider errors.

## Ingress parsing

Ingress reads incrementally, checks actual byte counts before decoding each chunk, and cancels at the first over-limit chunk. A `Content-Length` above the limit is rejected without reading the body; an absent or understated length cannot bypass the limit. Bodies **at or below 8 MiB** retain `JSON.parse` semantics and cost. Only after crossing 8 MiB does ingress switch to the streaming JSON tokenizer with 4 KiB feeds. It assembles values directly rather than retaining a second whole decoded document. Until then ingress holds raw bytes, not a decoded prefix: parser values sliced from one decoded 8 MiB string would keep all of it alive. Malformed JSON remains a 400; oversized or structurally excessive expanded input is a 413.

## Isolate body budget

The 128 MB isolate is shared by every in-flight request, and request bodies are the one allocation callers size. Bodies of **1 MiB or more** lease **twice their bytes** (parsed value plus one transport copy) from a **96 MiB** per-isolate budget, held until response completion, failure or observed cancellation. A declared `Content-Length` leases all at once before any body is read, so concurrent uploads cannot each stall partway past the budget; bodies without one lease as they arrive. Responses WebSocket creates of 1 MiB or more lease the same budget until settlement.

The caller is authenticated before any lease, so anonymous callers cannot hold the budget, and again before expansion past 8 MiB. Invalid/missing proxy keys receive 401 after no more than the ordinary envelope plus one transport chunk. Normal selection-aware authorization still runs after parsing.

A request that would exceed the budget receives HTTP **503** with `Retry-After: 1` before budget reservation, retention or upstream dispatch, and is **nonbillable**. Claude routes return an Anthropic-shaped `type: error` / `error.type: overloaded_error` body; other routes return `error.code: server_overloaded`. WebSocket creates receive an `error` event with status 503 and the same code. Leases release in `finally` on parse/admission failure or on observed completion; response headers alone do not release a lease while an accounting closure can still own the input. Cancellation depends on the runtime reporting it; see the [HTTP cancellation contract](api-reference.md#http-cancellation-diagnostics).

## Transport and retention copies

Unsigned bodies carrying at least 1 MiB in strings of 64 Ki characters or more — base64 images, data URLs, PDFs — are serialized by stringifying a skeleton with those strings swapped for per-call markers, then splicing them back as raw chunks of at most 64 KiB. Upstream delivery and optional R2 retention use this **known-length stream**: the Worker holds about one copy of the request (measured 1.03× at dispatch), at native-serializer CPU. Other Claude bodies above 8 MiB use the chunked serializer, and smaller bodies keep `JSON.stringify`. SigV4 bodies keep the signed string. Responses WebSocket creates are parsed once at receipt and forwarded as one frame; preparation builds no HTTP body for them.

## Platform constraints

Checked 2026-10-26:

- [Claude API request-size documentation](https://platform.claude.com/docs/en/api/errors#request-size-limits) lists **32 MB** for Messages and Token Counting. ClawRouter interprets the published unit as decimal and enforces **32,000,000 bytes**.
- [OpenAI image inputs](https://developers.openai.com/docs/guides/images-vision) allow far larger requests (512 MB payload, 1,500 images). ClawRouter's 32 MB is a Worker-memory constraint, not provider parity; it also matches Cloudflare's 32 MiB WebSocket message ceiling.
- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits) allow request bodies of **100 MB** on Free/Pro account plans, **200 MB** on Business, and up to **5 GB** on Enterprise.
- [Worker memory](https://developers.cloudflare.com/workers/platform/limits/#memory) is **128 MB per isolate**, not per request. A byte cap alone cannot bound JSON object expansion, so bodies **above 8 MiB** also cap **65,536 values, 128 container nesting levels, and 4,096 characters per object key or numeric lexeme**, returning 413 when exceeded. Large string/media values remain permitted up to the byte envelope. Workerd regressions cover routing, real Durable Object accounting, R2, budget admission and cancellation; they are not production heap-capacity certification.

## Budget and retention behavior

The larger transport envelope does not waive monetary admission. The #292 image-header bound still substitutes visual-token ceilings for recognized Claude inline image data in qualifying content positions. Large base64 PDFs, unknown image encodings, OpenAI image inputs and nonqualifying media keep the existing full-model input-window reservation. Token counting remains free.

When R2 retention is enabled, the **complete request, including whole documents/PDFs and inline media**, is retained—not just extracted text. Records above 8 MiB finish the upload before provider dispatch. See [Request content retention](content-retention.md).

Measure isolate memory for image-heavy turns with `node --expose-gc test/diagnostics/http-image-memory.test.mjs` (`IMAGE_PROVIDERS`, `IMAGE_COUNT`, `IMAGE_KIB`, `IMAGE_CONCURRENCY`, `IMAGE_RETENTION`).
