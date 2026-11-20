# Google native embedding contract

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/embedding-provider.ts`. This slice implements only
`gemini-embedding-001`, `gemini-embedding-2`, and
`gemini-embedding-2-preview`. Fixtures are synthetic, not live provider receipts.

## Native transport

`worker/provider-google-embeddings.ts` exports `prepareGoogleEmbedding`,
`observeGoogleEmbedding` and `readGoogleEmbedding`. Preparation returns the
unchanged native JSON body, relative path and non-secret JSON headers:

- Unary POST `/v1beta/models/{model}:embedContent`.
- Synchronous batch POST `/v1beta/models/{model}:batchEmbedContents`.
  Every sub-request must contain the exact `models/{model}` identity.

Local admission bounds are 100 requests/parts, 20 MiB serialized request and
16 MiB response. Dimensions are integers from 128 through 3072, default 3072.
These memory/shape bounds are not token, media-duration or cost bounds.
The consumer must split larger synchronous batches before dispatch.

Stable Embedding 2 rejects `taskType`; the consumer supplies already formatted
text. The adapter neither prepends instructions nor renormalizes vectors.
Multiple parts produce one aggregated vector per request, not one per part.
The older 001 model accepts text only; the 2 variants preserve bounded inline
image/audio/video/PDF parts. File URLs, remote downloads and arbitrary extra
request fields are outside this frozen unary contract. MIME/base64 checks do
not certify media decoding, duration or native model acceptance.

The response reader requires HTTP 200, JSON MIME, valid UTF-8 and complete EOF,
under the caller/runtime deadline signal. Batch vectors are validated atomically
in request order, including each requested dimension and finite scalar values.
Missing rows, invalid later rows, API errors, transport failure or caller abort
cannot publish a partially successful embedding result.

## Accounting and integration

Only native `usageMetadata.promptTokenCount` qualifies input-token observation.
Missing or malformed counts remain unknown. Modality details are usable only
when names are known, unique, nonnegative integer counts sum to that total.
Vector dimensions, source characters and inline byte sizes never become tokens.
No USD rate card or conservative whole-request tariff bound is qualified here.
Unknown upstream-dollar hard budgets stay closed. Explicit `policy_fixed`
settlement is distinct from an upstream invoice or evidence of zero cost.

Runtime owner integrates these methods after existing credential-scoped
selection/admission, preserves the selected Google grant, uses the established
deadline and classifies incomplete delivery conservatively. No model-provider
credential fallback, stream-prefix accounting or unsafe POST replay.

Existing manifest owner adds the exact native embedding endpoints and finite
models to `providers/google-gemini.provider.yaml`; this PR does not edit that
owned file. Client owner consumes `providers/_fixtures/google/embeddings.json`
through the actual frozen native provider and retains its task formatting,
batch splitting and normalization. Integration owner proves real Worker/client
transport and settlement before advertising parity.

The frozen `embedding-batch.ts` file-backed async API remains a separate required
slice: upload, original-credential file binding, create/poll, bounded authenticated
download and keyed result validation. Synchronous `batchEmbedContents` does not
substitute for that API. Google Live and other media are separate queue items.
This module alone does not activate a route or complete provider parity.

## Primary evidence

Checked 2026-11-03:

- [Google embeddings guide](https://ai.google.dev/gemini-api/docs/embeddings)
  documents model shape/task distinctions and dimensions.
- [Google's live v1beta discovery schema](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta)
  defines `EmbedContentRequest`, `BatchEmbedContentsRequest`,
  `ContentEmbedding` and `EmbeddingUsageMetadata`, including response ordering
  and explicit native input/modality token counts.

The discovery schema deprecates top-level task/dimension fields in favor of
`embedContentConfig`; it still defines the frozen top-level fields. This
adapter preserves the frozen wire surface and does not invent a removal.
