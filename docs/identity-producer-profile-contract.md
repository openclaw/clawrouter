# Identity producer profile

This slice admits selected identity sources and derived representations before
materialization, selected copies and publication. It introduces whole-operation
resource denial; it does not truncate a candidate pool or return an accepted prefix.
Source inspection and authored tests are not runtime qualification.

## Closed vectors

Each ceiling is independent. The maxima need not fit simultaneously.

| Dimension | Record / private copy | Complete admission / identity |
| --- | ---: | ---: |
| Original UTF8 bytes or prospective serialized UTF8 bytes | 1,048,576 | 2,097,152 |
| Decoded UTF16 units or prospective serialized UTF16 units | 1,048,576 | 2,097,152 |
| Container depth | 16 | 24 |
| Value occurrences | 65,536 | 131,072 |
| Containers | 16,384 | 32,768 |
| Object member occurrences | 32,768 | 65,536 |
| Array entries | 16,384 | 32,768 |
| Members plus entries | 49,152 | 98,304 |
| Decoded string units, including keys | 1,048,576 | 2,097,152 |
| Individual key units | 1,024 | 1,024 |
| Individual string units | 1,048,576 | 1,048,576 |
| Number token characters | 64 | 64 |

The occurrence scanner counts overwritten and discarded JSON members before
`JSON.parse`. Unknown fields have the ordinary graph profile even when named
`candidates`, `pools` or `policyId`. Last-member-wins parsing, field order, own
`__proto__` members and valid legacy revisions above 64 KiB remain supported.
Prospective JSON admission preserves ordinary nonfinite-number serialization,
object undefined omission, array null substitution and escaped lone surrogates.
Access, assignment, user and policy-collection scanner profiles remain separate.

Actual admission positions allow 128 connections/pools, 256 candidates per pool
and 1,024 total candidates. The existing 98-key selection/runtime business guard
remains narrower: passing a 256-candidate profile check does not authorize a
256-key selection. Raw candidate inputs are checked before deduplication; repeated
entries do not create permission for an oversized intermediate collection.

## Source phases and selection

One proposed generation has a conservative cumulative source allowance of
2,097,152 original UTF8 bytes and 2,097,152 decoded UTF16 units, with the complete
occurrence counters. Repeated canonical reads charge again. Each individual
record also passes the record vector. Individually valid records can therefore
cause a whole-generation denial when combined or reread. Malformed sources retain
the charges for the bytes, text and occurrences already processed.

The selected authority phase shares its counter across SQL, cold KV records,
projection backfills, runtime rows, selection history and canonical rereads. The
caller shares one counter across an admission colo attempt and its authority
reply, or a pool reply and sequential KV fallback. The request envelope and the
DO's source phase are distinct. A later phase is not credit for earlier retained
objects, and separate DO budgets are not a combined caller-heap bound.

Default `policy-bindings` calls for `/admission/resolve`, `/grant-pools/resolve`
and `/grant-pools/select` use the private versioned
`x-clawrouter-identity-admission: v1` protocol after specialized control branches.
Generic credential `/materialize` uses the same private selector and bounded
reply. The selector is not authentication and is never copied from public headers.
An unsupported marked method, version or path owns its original body before
terminal rejection. Unmarked authority entry points retain their existing reader.

SQL count and BLOB-length metadata precedes selected value retrieval. Pool
membership metadata admits the entire collection before value maps or flattening.
Projection sizes are checked before retrieving that pool's first projection;
selection history and the prospective counter/cursor state pass before selected
writes. SQL-native work and the original KV/native page allocation are outside
this claim. Metadata checks are not rollback or storage-allocation guarantees.

Cold selected records and projection imports are staged. Current canonical rows,
publication markers and attachment revisions still win after every yielding read.
Complete admission and serialization precede staged import and selection writes.
A resource failure cannot commit an accepted prefix. Ordinary storage failures
retain existing uncertainty; this adds no transaction, replay or compensation
promise. Normalizers keep their existing projection and validation behavior.

## Original stream custody

Selected KV records use one original stream at a time. Selected requests,
authority replies and the admission Cache API namespace use original byte bodies,
with whole backing arrays at most 16 KiB, at most 8,192 reads including empty/EOF,
and, where present, at most 32 headers and 4 KiB aggregate header bytes.

Registration precedes get/fetch invocation. Pending reads, late response bodies,
the first memoized cancellation including rejection, and unlock are joined through
the unchanged input-retirement owner. A default reader is a cancellation owner
only. Unknown body or lock ownership remains held. No healthy body is replaced,
no default-reader read fallback is introduced, and no timer grants retirement.
Original wire bytes and replacement-decoded UTF16 are charged separately; BOM,
replacement decoding, empty response URL and existing MIME behavior remain.

Capacity, protocol, transport and cleanup denials use a private WeakSet brand and
fixed sanitized `503 identity_admission_unavailable`. Ordinary error objects
cannot forge the brand. Selected hydration, migration, materialization and colo
catches rethrow it rather than rescuing through old authorization, legacy records
or another provider. Ordinary bounded malformed/missing/revoked behavior remains;
ordinary cache lookup failure is still a miss. Unrelated colo namespaces keep
their existing behavior. No raw record, secret or error cause is archived.

## Publication and copies

Effective principal policies admit complete unknown override fields and preserve
own zero/null overrides. Refresh prepares and admits all identity fields before
changing the identity, policy, service tiers, principal or admission WeakMap.
Failure leaves those previously published references intact, but authorizes no
continuation using them. Successful replacement remains atomic and synchronous.

Routing and materialized-grant copies are guarded before selected private clones,
comparison/decorating paths and output serialization. Native credential storage
has already returned a graph before that guard: no retroactive allocation claim
is made. Existing specialized Search, Wan, video and private Cover controls retain
their separate owners. This slice does not activate a provider or public product.

Shared cache feedback can still update its existing advisory state. This work does
not add a generation borrower index or privatize every shared graph. It enforces
per-representation admission, not a total number of selected copies.

## Proof boundaries

Focused Node fixtures cover raw exact/+1 vectors, discarded occurrences, semantic
quotas and the separate 98/99 guard, SQL metadata ordering, canonical winners,
legacy bytes, zero staged writes, effective overrides, atomic failed refresh,
colo terminal denial and cancellation/unlock. Synthetic producers explicitly emit
byte streams; they do not qualify the platform's original streams.

The actual Workerd fixture first probes original KV/request/Cache bodies and then
runs a public route with current-request SQLite/KV owners and original selected
replies. It checks cold import, warm colo adoption, terminal SQL/KV/colo denial and
refresh. A separate labelled fault producer holds HTTP bytes to establish a
native pending read. Its cancellation continuation is deliberately held *after*
actual cancellation settles, then rejects; this is not a claim that the native
cancellation itself remained pending. Finite request, body and cleanup roots are
joined, preserving independent failures including undefined and shared reasons.

Two retained generations, last-borrower release, a combined two-copy allocator,
shared cache/feedback arena budgets, combined 32 MiB caller accounting, 64 MiB
Music handoff, whole-engine heap and native physical retirement remain outside
this slice. Serialized/graph vectors are not measured heap bytes.
