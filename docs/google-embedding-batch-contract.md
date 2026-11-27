# Google file-backed embedding batches

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/embedding-batch.ts`. The model set remains
`gemini-embedding-001`, `gemini-embedding-2`, and
`gemini-embedding-2-preview`. This extends the unary native validation contract;
it does not substitute synchronous batching for the frozen file-backed API.

## Wire contract

`worker/google-embedding-batch.ts` implements the following deterministic codecs.
All paths are relative to the original qualified Google origin. Credentials,
admission, retries, HTTP execution and durable ownership belong to runtime.

1. `prepareGoogleEmbeddingBatchUpload` creates multipart/related metadata and
   JSONL `{key, request}` records for POST
   `/upload/v1beta/files?uploadType=multipart`. The limits are 50,000 unique
   keys and 20 MiB JSONL per upload. The returned row descriptor contains only
   keys and dimensions; it contains no prompts, files or inline media.
2. `readGoogleEmbeddingUpload` reads a bounded native file response and returns
   the resource name, processing state and qualified expiration timestamp.
   `PROCESSING` is not readiness; runtime must qualify readiness before create.
   Uploaded URI/downloadURI values never become credential destinations.
3. `prepareGoogleEmbeddingBatchCreate` requires the already scoped input file
   and model to match `batch.inputConfig.file_name`. It preserves the frozen
   JSON and constructs POST `/v1beta/models/{model}:asyncBatchEmbedContent`.
4. `googleEmbeddingBatchControl` constructs GET `/v1beta/batches/{id}` or
   POST `/v1beta/batches/{id}:cancel`. Batch names are bounded and cannot contain
   origins, paths, query or traversal. DELETE is deliberately unsupported:
   deleting an operation does not cancel its work.
5. `readGoogleEmbeddingBatch` qualifies the operation identity and state.
   Successful output comes from `response.responsesFile` or
   `metadata.output.responsesFile`; conflicting names are rejected.
6. `googleEmbeddingBatchDownload` constructs only
   `/download/v1beta/files/{id}:download?alt=media` from an already scoped output
   file. No arbitrary URI, redirect, custom origin or credential rotation.
7. `readGoogleEmbeddingBatchResults` streams JSONL into consumer staging,
   validates unique submitted keys and exact finite vector dimensions, and
   requires complete UTF-8 EOF plus every submitted key. Alternate frozen
   key/direct-response shapes must be unambiguous. Limits are 512 KiB per line
   and 4 GiB total transfer, decoded in bounded segments without retaining all
   vectors. Runtime's deadline/caller signal remains authoritative.

These limits bound local resource use, not input tokens or monetary exposure.
They do not raise upstream limits. File names admit a bounded resource segment
for generated outputs; they cannot authorize access by themselves.

## Lifecycle, billing and ownership

Both documented BATCH_STATE and frozen JOB_STATE prefixes are recognized.
Pending/running observations ignore partial output-file claims. Succeeded,
failed and canceled states do not require metrics. Missing successful output
is a deliverable error, not permission to poll a completed job indefinitely.
Operation error code 1 is cancellation; other qualified operation errors are
failure. Native bodies and error text are not durable ownership records.

HTTP 200 empty cancellation response is an acknowledgement only. Poll the
original operation to learn the outcome. The API describes cancellation as
best effort; completion can win the race. Never infer a refund.
`EXPIRED` returns `observationUnavailable: expired_or_unknown`, with no invented
execution failure or further poll. The M03 transition must freeze uncertainty
once. Partial work may already have accrued cost.

Uploaded files have documented 48-hour retention; use an explicit returned
expiration when available. Generated-output and operation retention are not
inferred from the upload lifetime. Missing/expired files, restart and lost
observations do not authorize re-upload/create replay or zero settlement.
No whole-batch USD tariff bound is qualified here. Native per-row input tokens,
when present, are observations; absent counts stay unknown. Explicit
`policy_fixed` is distinct from upstream cost. Unknown upstream-dollar hard
budgets remain closed.

Runtime handoff: extend the existing BackgroundStore/ResponsesScopeStore
machinery with proposed protocol `google.embedding_batches`, not another job
index or framework. Bind caller, policy, original credential/grant/origin,
input file, model, batch ID and authenticated output file. Persist bounded
key/dimension descriptor chunks using the existing scope store; never persist
native request bodies or assume a 50,000-key manifest fits one storage value.
Every upload/create is uncertain after dispatch without a qualified response:
do not replay either POST. Expiry/restart/terminal settlement and the outbox
must preserve exactly one frozen charge outcome.

No route is registered by this PR. Shared owner work must authenticate before
upload reads, qualify file readiness, bind all file controls, use original
credentials for cancel/poll/download, and prove observation-loss settlement.
Existing Google YAML/schema belongs to its owner. Consumer integration must
stage streamed vectors, commit only after successful iterator exhaustion, and
discard partial staging on error/abort. Breaking early is not a successful
download. Actual Worker/client proof remains required before claiming parity.

## Evidence

Synthetic fixture: `providers/_fixtures/google/embedding-batch.json`.
Focused tests cover multipart framing, input/model/file identity, partial and
terminal outcomes, cancellation acknowledgement, expired observations, output
conflicts, unordered/duplicate/missing results, late errors, EOF and abort.

Primary sources checked 2026-11-03:

- [Google v1beta discovery](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta):
  async embedding request/output/state, operation polling and best-effort cancel.
- [Files API](https://ai.google.dev/gemini-api/docs/files):
  upload retention, file metadata and generated-file downloads.
- [Embedding guide](https://ai.google.dev/gemini-api/docs/embeddings):
  embedding shapes and batch processing. A batch discount is not a qualified
  per-model, per-modality admission bound.
