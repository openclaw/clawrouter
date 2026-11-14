# Internal PixVerse input receipts

This foundation has no public route, registry entry, provider declaration or
snapshot activation. It uses the existing scoped `responses_background` row,
credential owner, alarm and financial outbox. It does not create an asset store.

`allocatePixVerseInput(request, env, context, auth, selection, file)` accepts
verified caller identity, a registered image-create selection and bounded bytes.
A stable Idempotency-Key is required. The complete planned image-create body is
validated before allocation or upload. Caller img_id, URLs, extra controls and
unqualified models are rejected. The internal byte envelope is 8 MiB, smaller
than the provider helper's limit; it is a memory bound, not a price bound.

The returned `clawrouter.managed-input.v1` binding selects one job in the existing
verified continuation scope. It records the original caller scope, credential
owner generation and lineage, product, regional origin, create endpoint, model,
input slot, byte digest/size/MIME, planned-create digest and local expiry. No
bytes, prompt, secret or signed URL is persisted. Output-file ownership remains
separate. The row retains the existing 64 KiB cap.

`dispatchPixVerseInput` accepts that binding, the same planned body and either
`upload` with the exact bytes, or `create`. There is no general body/path override.
Upload uses only `/openapi/v2/image/upload`; create uses only
`/openapi/v2/video/img/generate`. The runtime generates Ai-trace-id and MIME
headers and supplies the original owner's API-KEY. Caller/static headers cannot
supply upload authority. The input lease charges 64 MiB against the existing
96 MiB isolate pool, covering bounded preparation and transport copies.

The private owner actions are `input_allocate`, `input_get`,
`input_claim_upload`, `input_bind_upload` and `input_claim_create` under the
existing `/responses-background` RPC. The upload changes from `pending` to
`dispatch_unknown` before any possible POST. A validated img_id is committed by
compare-and-set and acknowledged before it can be used. A lost binding ACK can
recover that same record. A lost dispatch ACK cannot retry upload. The create
claim is also single-attempt. Expiry, restart and tombstones never reset either
attempt. The 60-second admission expiry is local; no provider asset lifetime is
assumed. The existing managed job owns subsequent generation uncertainty.

Bounded bytes and multipart preparation occur before acquiring the original
credential owner's mutation ordering. That owner revalidates the exact recorded
generation, lineage, scalar API-key source, destination, caller policy/model and
retention consent. The receipt owner's final claim is the last await, followed
by synchronous deadline/expiry/header checks and fetch. Credential ordering is
released after fetch starts, without waiting for the provider response. The
receipt owner never calls back into the held credential owner. Revocation before
the relevant authoritative check denies dispatch; later revocation cannot retract
an already authorized attempt. This is not instantaneous global revocation.

Both operations require explicit entries in the existing policy map:
`requestCostsMicros["pixverse.image_upload"]` and
`requestCostsMicros["video.generate"]`. A policy-wide fixed fee does not authorize
both. These are explicitly labeled router policy prices, not provider invoices.
Unknown upstream dollar pricing remains closed. Upload and generation have
distinct reservation IDs and immutable usage events in the same job outbox.
Upload does not use generation beginEgress. Unknown upload outcomes retain the
upload charge; a never-dispatched generation remains separately unsent.

Remaining activation work includes the separately owned image/upload declaration,
public authenticated byte intake and its capacity lifetime, actual client binding,
and integrated original-job controls. No live grant/policy changes, provider calls
or credential provisioning are part of this foundation.
