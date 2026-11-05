# MiniMax music runtime

The registered `minimax.music` request/response pair supports global MiniMax
`music-2.6` and `music-2.6-free` through POST
`https://api.minimax.io/v1/music_generation`. A model must explicitly support
`music.generate` on that endpoint. Unary and SSE requests keep the existing
explicit MP3, 44100 Hz, 256000 bitrate and hex settings. Production declarations,
snapshots and the actual client bridge are separate qualification work.

## Original credential authority

An administrator can explicitly set `nativeMediaAuthorization` to
`minimax-global-music` through the existing upstream-grant PUT operation. This
selects the strict `clawrouter.native-media.v1` binding with operation
`minimax.music`, global region, native-media product, fixed origin and the actual
scalar API-key credential slot. The existing speech intent is separate. Image,
Messages OAuth, TokenPlan, bundle and access-token fallback do not supply music
authority. No caller-supplied binding or permission boolean is accepted.

Music grant mutations require a verified Access/local administrator backed by a
currently enabled SQL administrator record. The generic administrator bearer
token does not identify such a principal. The HTTP handler supplies private
actor provenance; request JSON cannot supply the actor, proof or tombstone state.

Within the serialized credential owner, requested **or existing** Music
authorization triggers a domain-separated mutation digest. It binds the actor,
policy/tenant scope, grant key, original attachment revision/generation/lineage,
result generation/lineage, credential fingerprint, account, provider, kind,
expiry, binding/removal and preservation/replacement mode. All preparation and
hashing precede pool admission. The last authority call checks the current SQL
role and exact attachment revision after that admission. The owner compares the
complete bounded reply and invokes storage without an unrelated await. This is
fresh-at-check authorization, not an atomic transaction across Durable Objects.

Demotion or disablement while the pool reply is held denies the mutation and
preserves the old credential, generation, lineage and binding. It does not
revoke that independently authorized grant. Pending or noncanonical Music
records deny before migration or attachment repair; a failed proposal cannot
be adopted by retrying a metadata edit. Admission for an already-active member
may advance its revision without creating pending work; a separately authorized
new edit can then proceed, retaining the original credential rather than the
discarded proposal. Revocation and already-published
tombstone retries also recheck SQL authority. A private tombstone marker keeps
the latter under that check without exposing state or advancing its generation.
OAuth, pool and legacy imports cannot attest Music authority. Search, Speech,
device onboarding and the separate environment configuration retain their
existing contracts.

Omission preserves music authorization only for the same original owner,
credential, account, provider, kind and lineage. Explicit removal, replacement
or revoked authorization requires renewed intent. Private projection overwrites
untrusted metadata. The owner checks exact generation and lineage before
materializing the admitted scalar key. Dispatch checks the original caller,
current policy/model, owner binding and generation after budget/retention waits.
A mismatch denies; it cannot refresh into a different key or borrow an
environment credential. This is fresh-at-check authorization, not instantaneous
revocation across the remaining synchronous fetch boundary.

A separate server-owned environment binding uses the same strict music
operation, `credentialSource: MINIMAX_API_KEY`, and `credentialSha256` equal to
the actual selected key's SHA-256. Discovery and dispatch verify the fingerprint;
rotation requires explicit renewal. A speech environment binding cannot qualify
music. An originally selected managed grant never falls back to this path.

## Capacity and retirement

Existing limits are operational bounds, not vendor limits: 64 KiB request JSON,
4 MiB decoded unary audio / 8 MiB + 64 KiB unary JSON, and 8 MiB decoded streamed
audio / 40 MiB + 64 KiB original SSE wire. The streaming reader retains a bounded
audio accumulator, validates all frames through physical EOF and replays one
complete terminal aggregate. Native DONE is not EOF. It uses returned BYOB
backings no larger than 64 KiB; the accumulator is never lent to the reader.
The bounded default-reader behavior is unchanged.

The existing response lease charges 64 MiB within the shared 96 MiB pool;
standard ingress may charge up to 16 MiB. These are reservation limits, not a
measured heap claim. Caller failure/accounting remains prompt. Physical reader
retirement separately joins the actual pending read, first cancellation and lock
release. Late validated output is disposed before releasing its lease. A
successful replay retains capacity until downstream EOF/cancellation retirement.
The workerd fixture observes the actual DO-returned body and independently holds
caller read and cancellation settlement. It does not certify producer-side
credential-owner cleanup acknowledgment or retained-buffer capacity.

Unknown USD cannot inherit a Chat token tariff. Hard-dollar admission fails
closed without a qualified price; explicit `policy_fixed` remains distinct.
Complete validated output supplies null tokens, never a provider invoice.
Possibly paid failures retain conservative accounting and never replay.

## Remaining scope

CN hostname/region qualification, cover/reference inputs and their ownership and
capacity remain closed internal dependencies. No OpenRouter published-input or
PixVerse receipt grants MiniMax input authority. No live account entitlement,
provider call or provisioning is supplied by this synthetic runtime proof.
