# PixVerse managed video contract

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/pixverse/constants.ts` and `video-generation-provider.ts`.
Only models `v6` and `c1`, text-to-video and single-image-to-video are in
this slice. No new model, fusion, webhook, editing, or consumer-app integration.

## Concrete adapter

`worker/managed-pixverse.ts` exports:

- `createPixVerseManagedAdapter(mode, boundImageId?)`: text/image create,
  native envelope observation, exact scoped retrieval, and response rewriting.
- `preparePixVerseImageUpload` and `readPixVerseImageUpload`: native multipart
  construction and bounded upload result validation.
- `pixVerseRequestHeaders`: a fresh non-secret UUID trace header per request.
- `pixVerseOrigins`: international and China origins from the frozen consumer.

Native paths are POST `/openapi/v2/video/text/generate`,
POST `/openapi/v2/image/upload`, POST `/openapi/v2/video/img/generate`,
and GET `/openapi/v2/video/result/{video_id}`. Original credentials use the
`API-KEY` header. No cancellation or separate result action is qualified.

Duration is 1–15 seconds; four quality tiers and eight aspect ratios match the
frozen consumer. Prompt and negative-prompt admission is conservatively bounded
to 2,048 UTF-8 bytes. Model-specific templates still need vendor acceptance;
the adapter does not invent template compatibility or prices.

Multipart preserves either file bytes in `image` or the URL in `image_url`.
It never sends both or sets a stale boundary. Files must be smaller than
20,000,000 bytes with JPEG/PNG/WebP MIME types and bounded safe filenames.
Pixel dimensions and remote image content remain vendor validation boundaries;
MIME alone is not image validation. The router does not fetch remote URLs.

## Shared runtime prerequisites

The adapter implements the shared `ManagedLifecycleAdapter` contract and remains
unregistered pending the provider manifest/schema and real Worker proof. Every
control returns fresh non-secret `headers` plus `transientHeaders: ["ai-trace-id"]`.
The route identity pins UUID volatility, not a random value. `identityProbe: "1"`
is a valid synthetic decimal ID for route qualification, never caller authority.
Original credentials remain bound on each poll. The shared controller generates
a new control request for each attempt, including restarts; caller trace IDs and
credentials are not reused.

Image upload IDs require a durable caller/policy/provider/region/credential
binding before image creation. The optional factory argument `boundImageId`
must come from that trusted lookup, never from the caller's `img_id`.
An unbound image adapter rejects create. Store only the necessary ownership
metadata using the existing scoped machinery, not a global ID index.
Upload timeout/uncertain response must not trigger automatic replay.

The JSON response limit is 1 MiB, valid UTF-8 through EOF, with HTTP success
and numeric `ErrCode=0`. IDs must be positive safe decimal integers; unsafe
JSON numeric precision is rejected instead of silently rounding another ID.
Retrieve responses may omit identity; their bound authenticated GET supplies
it. If either native `id` or `video_id` is present, it must match.

Status 5 is pending even with a partial URL. Status 1 is terminal execution;
missing or inaccessible media is a separate deliverable failure. Statuses 7
and 8 are terminal errors. Status 6 is the frozen client's deleted-task case:
return `observationUnavailable: "deleted"`, stop polling and freeze once
without inventing an upstream execution outcome or refund. This uses the shared
observation-loss transition. Unknown
status, transport errors, and malformed bodies are not terminal job proof.

Use the established reservation/idempotency/outbox path for one frozen terminal
settlement. Never replay an uncertain generation POST. Native bodies stay
transient; output URLs stay opaque. No task or asset retention duration was
qualified, so local expiry must preserve uncertainty and fixed-policy settlement.

## Billing and acceptance

Published reference conversion is 225 Credits per USD. Rates vary by model,
quality, seconds, audio, and capability. `Resp.credits` is preliminary;
final debit/refund evidence comes from the account ledger. This slice does not
activate a tariff, treat examples as prices, or equate terminal failure with a
refund. Unknown whole-request upstream cost remains denied under dollar hard
budgets. Explicit `policy_fixed` remains a different charging basis.

Synthetic lifecycle, upload, and result fixtures:
`providers/_fixtures/pixverse/lifecycle.json`. Eight dependency-free tests
cover deterministic behavior. Activation additionally requires the shared
protocol/header/asset/observation-loss contract, provider manifest and snapshot,
real Worker tests and actual frozen-client consumption. No deployment or live
model call has occurred.

Primary evidence checked 2026-11-03:

- [Native authentication and trace IDs](https://docs.platform.pixverse.ai/start-here-2394989m0)
- [Text create](https://docs.platform.pixverse.ai/text-to-video-generation-13016634e0)
- [Image upload](https://docs.platform.pixverse.ai/upload-image-13016631e0)
- [Image create](https://docs.platform.pixverse.ai/image-to-video-and-video-templates-13016633e0)
- [Task status](https://docs.platform.pixverse.ai/query-task-status-43051212e0)
- [Account/region and refund boundaries](https://docs.platform.pixverse.ai/faq-2394993m0)
- [Reference credit pricing](https://docs.platform.pixverse.ai/pixverse-api-pricing-2394995m0)
