# OpenRouter inline music input

This common profile uses the two registered Lyria models and their existing
native/manifest music endpoint. It accepts one inline PNG, JPEG or WebP reference
up to 8 MiB decoded, with a complete JSON envelope up to 12 MiB. HTTPS references
and reusable asset handles remain closed. Container validation does not grant
PixVerse permissions, pixel-decoder guarantees or cross-request asset authority.

The shared native Chat path resolves the registered model through the existing
capability selector. Ordinary Chat keeps its 32 MiB envelope and incremental
body charge. It does not acquire music's 64 MiB ingress reservation or freeze its
graph. Until the registered model resolves, byte-zero parsing reserves twice
the declared/consumed wire bytes under existing thresholds; it retains no raw
prefix. A selected inline music request grows that same lease to 64 MiB before
container decoding, digest snapshots or the borrowed codec's string inspection.

## Ownership phases

1. Authenticate before reading. Read bounded BYOB windows from byte zero into
   the existing incremental JSON parser; retain no raw prefix. `take()` moves
   the completed graph and retires parser/tokenizer references. Clear the native
   body or manifest envelope and preparation roots after selection.
2. Freeze the validated graph in place. The borrowed codec retains that exact
   graph; only its scalar model/format context enters the response constructor.
   Decode base64 in bounded slices, validate the declared container, and hash
   the actual bytes. Retire decoded bytes and the completed digest operation
   before the next phase. No caller digest or URL string proves ownership.
3. Bind request-local evidence to verified caller scope, selected model/route,
   exact slot and original durable API-key generation/lineage. Environment keys,
   alternate credentials and arbitrary destinations cannot qualify this path.
   Recheck the owner and current policy after budget and retention awaits, and
   again after complete quarantine before output release. This is fresh-at-check
   authority, not instantaneous revocation of bytes already released.
4. If router retention policy applies, stream the immutable record through the
   nonmutating serializer. Await the archive write and its physical pipe; clear
   record/serializer references before transferring capacity. Router retention
   policy is not vendor asset consent.
5. Atomically transfer the existing ingress charge into retained-input and
   response charges. Refusal leaves the original charge intact and makes no
   paid fetch. The upload serializer does not mutate media fields or create a
   whole-document string/UTF-8 copy.
6. Wait for upload-pipe completion, then replace selection's body with scalar
   streaming facts. Retain input capacity conservatively through final cleanup.
   Quarantine the complete native response before replay; release response
   capacity only after downstream EOF/cancellation. On interruption, wait for
   the physical quarantine reader and upload pipe to acknowledge cancellation
   before releasing their charges.

## Capacity ledger

All charges belong to the existing 96 MiB pool. No third lease is acquired.

| Phase | Charged ownership |
| --- | --- |
| Selected music ingress/validation | 64 MiB: one bounded string graph and parser/string preparation headroom, plus at most 8 MiB decoded image and 8 MiB digest snapshot |
| Before paid dispatch | One synchronous `splitCharges(32 MiB, 64 MiB)`; contention preserves the original 64 MiB charge |
| Retained input | 32 MiB: at most 24 MiB graph allowance plus 8 MiB structural/serialization/transport headroom |
| Response | 64 MiB: the qualified scalar wrapper's 32 MiB wire quarantine and bounded framing/JSON/windows/headroom, supporting 16 MiB decoded audio |

Input windows are at most 16 KiB; parser feeds and base64 decoding slices are
bounded. The codec permits at most 32 graph nodes, eight levels and a 32,768-code
unit prompt. Serializers emit at most 64 KiB per pull. Fixed-length pipes retain
their lease owner through consumption or cancellation. There is no assertion
that GC ran, no physical peak-memory claim, and no inference that serializer EOF
alone means a remote consumer finished reading.

## Billing and remaining activation

Unknown upstream-dollar prices remain denied under hard-dollar budgets.
Explicit policy-fixed charges remain separate. Missing, malformed, interrupted
or paid-error native responses retain conservative dispatch uncertainty; there
is no POST replay or invented token/invoice receipt.

Provider declarations, actual client integration and HTTPS asset mapping remain
separate work. Common qualification must compose the actual qualified capacity,
borrowed codec, scalar response, container validator and transport parents.
