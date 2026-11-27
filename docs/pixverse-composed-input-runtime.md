# PixVerse composed image intake

`clawrouter.pixverse-image-input.v1` is a registered **native-only** multipart
profile for `POST /v1/native/pixverse/openapi/v2/video/img/generate`. It is not
vendor JSON, a general multipart override, or permission to use an uploaded ID.
The provider declaration and snapshot require separate qualified integration.

The caller sends one `image` file and native scalar fields. The parser enforces
an 8 MiB image, an 8 MiB + 32 KiB envelope, 11 parts, 2 KiB headers per part,
10 scalar fields and a 70-character boundary. Required fields are `model`,
`prompt`, `duration`, and `quality`. Supported optional fields are `seed`,
`negative_prompt`, `camera_movement`, `template_id`, `generate_audio_switch`,
and `motion_mode`. Duplicate, unknown, malformed, encoded, incomplete, URL and
caller `img_id` inputs fail before upload. PNG/JPEG/WebP containers must match
their declared MIME. Container validation is not pixel decompression.

Only explicit `video.generate` model bindings for `pixverse/v6` and
`pixverse/c1` qualify. Existing text `media.predict` bindings do not inherit
this route. The catalog carries `inputProfile` only on the native offer; the
legacy manifest JSON route stays unavailable for this profile.

## Admission and original ownership

Authentication precedes intake. A second model-specific admission precedes
allocation. Both `requestCostsMicros["pixverse.image_upload"]` and
`requestCostsMicros["video.generate"]` must be explicit nonnegative integers;
their two reservations and event IDs remain separate. These are `policy_fixed`
charges, not vendor dollar prices. A policy-wide fee does not authorize both.
Both reservations must be acknowledged before any paid POST.

The original owner-backed API-key grant, current caller policy and explicit
upstream-retention permission are required. Environment fallback is closed.
The existing private Responses scope stores one input intent on the original
job, including caller scope, original credential lineage/generation, model,
create route, origin/region, input digest, plan digest, MIME, size and expiry.
It stores no media, prompt, native response body, secret or signed URL.

Profiled receipts use the existing lifecycle route digest, pinned to the input
profile and original create endpoint. Existing unprofiled internal v1 receipts
retain their old digest only while the endpoint remains unprofiled. Verification
never tries both digests or upgrades an old receipt into a public profile.

Profiled private actions request a bounded state summary rather than repeatedly
serializing the embedded upload ledger. Existing full receipt callers remain
unchanged. These selectors carry no authority.

A single private binary `/managed-input/compose` call holds the owner capacity
across upload, image binding, create and response delivery. It uses no base64,
Blob, FormData or whole-body convenience reader. Each POST separately enters the
original credential object's mutation tail. The current owner, policy, model and
retention checks precede the receipt claim. The claim is the last await; deadline,
caller-proof expiry, credential expiry, receipt expiry and retention are checked
synchronously before fetch starts. The tail releases after fetch **starts**, not
after its response. A receipt owner never calls back into the held credential
owner. Revocation before its relevant authoritative check denies the attempt;
later revocation cannot retract an already authorized attempt.

Upload uncertainty is persisted before the sole upload attempt. A validated
`img_id` is usable only after its owner ACK. The sole create claim consumes that
same-job binding. Lost ACKs recover only the same committed record. Tombstones,
expiry, concurrent calls and retries do not reset attempts or grant refunds.
Fixed endpoints, generated filename/boundary/trace and runtime-owned `API-KEY`
prevent caller URL or header substitution.

## Native return and recovery

A complete validated native create response remains transient until
`managed_bind` is acknowledged. Only then may its original bytes be delivered.
If the ACK was lost, an exact matching committed job may confirm it. If native
response bytes were lost after a successful binding, retry returns
`409 managed_create_response_unavailable` with the original owned GET in
`Location`; it never fabricates a success body. Unbound or uncertain attempts
return `409 managed_input_unavailable` and cannot replay.

The same native GET path resolves the original image create route from scoped
ownership even when a text route shares it. Status 6 is observation loss, not
proof of failed or free generation. There is no cancel route or output-download
authority in this input profile.

## Capacity and retirement

The public side charges **40 MiB** through `BodyLease.grow(20 MiB)`; the
credential owner charges **56 MiB** through `grow(28 MiB)`. Both are held before
upload, exhausting the existing 96 MiB budget in a colocated isolate. There is
no third lease or later create-capacity gamble. The bound counts earlier
allocations alongside later phases; it does not assume immediate garbage
collection. Workerd transport allowances are conservative payload accounting,
not a promise about JavaScript-engine or process RSS.

| Side | Simultaneously counted payload allowance |
| --- | --- |
| Public | 8 MiB + 32 KiB fixed ingress buffer; borrowed image view adds zero |
| Public | 8 MiB + 16 KiB + 4 bytes for a full private transport copy |
| Public | 8 MiB hashing snapshot |
| Public | 9 MiB complete response parsing/quarantine allowance plus 1 MiB delivery copy |
| Public | 32 KiB envelope slack and 0.5 MiB small metadata/stream windows |
| **Public ceiling** | **34.57813 MiB within the 40 MiB charge** |
| Owner | 8 MiB + 16 KiB + 4 bytes fixed private buffer; borrowed image adds zero |
| Owner | 8 MiB hashing snapshot |
| Owner | 8 MiB + 1 KiB fixed multipart transport allowance |
| Owner | Two separate 9 MiB upload/create response parsing allowances, plus 1 MiB private delivery copy |
| Owner | 0.5 MiB small metadata/stream windows |
| **Owner ceiling** | **43.51661 MiB within the 56 MiB charge** |

Before JSON.parse, each response is limited to 1 MiB, depth 32, 4,096 nodes,
4,096 total properties, 128 properties per object, 1,024 array elements,
65,536 UTF-16 units per decoded string, and 262,144 decoded key/value string
units in aggregate. Tokenizer feeds are bounded; no unbounded scalar is built
before these checks. Native codec response views also use segmented streams.

Every generated stream chunk is at most 16 KiB, with zero producer read-ahead
and at most one queued and one in-flight chunk. At most four streams coexist,
so windows consume at most 128 KiB. Other small framing, metadata and string
allowances are at most 384 KiB per side. Intake requires native BYOB support;
there is no default-reader or whole-body fallback.

Public ingress remains owned through hashing and private transport consumption.
Private ingress remains owned through hashing and upload consumption. An early
upload response cannot acknowledge bytes that were not fully consumed. Upload
response buffers survive through image-binding ACK; create buffers survive
through job-binding ACK and private delivery. The public reply remains owned
through delivery EOF or cancellation. The owner and public leases release at
those respective boundaries, not when headers or the final chunk are enqueued.
