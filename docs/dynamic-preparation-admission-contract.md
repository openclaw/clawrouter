# Dynamic preparation admission

This is an operational admission contract for selected request preparation.
Capacity denial is complete-operation denial, not truncation, a missing credential,
or permission to select another grant. It does not activate a provider or product.

## Owner and selected paths

One `PreparationAdmission` starts before selection in each proxy operation. The
same explicit token travels with the selection through template/model expansion,
configuration, credential preparation, transport construction, signing, internal
credential recovery, response failover and lifecycle digest/revalidation. Fusion
advisers are separate logical requests; the synthesizer keeps its token across
reservation and execution. No ambient owner or Env-keyed registry exists.

Standalone `concreteOpenAiSelection`, `prepareManifestRequest` and
`prepareNativeRequest` entries establish a token only when their caller has not
supplied one. The returned selection/preparation carries it to `prepareSelected`.
Direct `prepareSelected` callers with manually constructed selections establish
one token on that selection, retained across subsequent calls. This covers the
preparation portion of existing HTTP, native and WebSocket callers; it is not a
new public WebSocket upgrade or transcription codec qualification. Realtime's
separate ASR model selection remains a separate logical preparation owner.

`prepareResponseControl` establishes one independent CONTROL token before dynamic
construction. Its admitted URL configuration contains strings and ordered query
pairs, not Env. `responseRouteDigest` never establishes a token. The selected proxy,
Wan revalidation and CONTROL callers pass theirs explicitly. Digest bytes, field
order, omission and sorting remain unchanged.

Native MiniMax media revalidation uses a module factory whose returned function
receives current Env and the original signal. It captures authority inputs,
original identity and the token, not preparation-time Env. Both reads around each
actual fingerprint digest project fresh current primitives. Other existing
`revalidateAccount(signal)` consumers retain their interface and authority order.

Explicit follow-up: the existing PixVerse `inputRouteDigest` shared-helper caller
and discovery attestation remain ownerless and unqualified by this change. Their
optional helper path does not establish a hidden token. Other direct legacy helper
calls likewise do not establish an owner. Existing producer/catalog ownership,
manual caller selection construction and protocol-specific codec allocations are
not upgraded into an operation-wide memory claim by this consumer contract.

## Closed allowances

All byte ceilings below use UTF-8. String admission also rejects a UTF-16 length
above the same numeric ceiling before encoding. Counters do not receive credit
when a value, header or query entry is overwritten.

| Surface | Allowance |
| --- | --- |
| Optional/configured CSV | 32 KiB and 1,024 raw occurrences processed before trim/copy, including empty, duplicate and ignored occurrences; no retained raw-CSV pool |
| Selected primitive facts | 128 retained name/value facts; name 256; value 16 KiB; 64 KiB aggregate names and values, including selected CSV tokens |
| Template/path substitutions | 256 across the operation |
| Path parameters | 32; 64 relative segments; 4 KiB raw and 8 KiB encoded aggregate |
| Query writes | 128 pairs; name 256; value 4,096; 8 KiB encoded aggregate |
| Header writes | 256; name 128; value 8 KiB; 64 KiB cumulative writes |
| Final headers | 64 names; 32 KiB names and values |
| URLs | 4 KiB base; 16 KiB built URL |

The primitive projection reads selected declared keys and canonical aliases only.
It does not enumerate Env, retain Env/accessors, or accept object/function values.
Equal name/value facts can reuse their retained representation; a changed value
retains the old charge. CSV's separate source/processing allowance does not enlarge
the retained primitive projection. Only relevant declared optional names survive
filtering; configured-list tokens use the same primitive budget. Every CSV read
charges all raw occurrences, including unknown names, whitespace and duplicates.
Connection mutation is an independent normalization entry: applicable primitive
fields are admitted before its mutation object or label trim, preserving defaults.
The public SigV4 entry extracts primitives synchronously; its private async signer
receives no Env, grant or Env-reading closure.

Admission precedes complete template replacement, path encoding/copy, caller query
conversion and comma-merge split/map/Set/join. Manifest path admission uses a bounded
scan; null query entries never reach a bulk record converter. CONTROL counts raw
query occurrences and decoded form fields before URLSearchParams construction.
Literal replacement prefix/suffix tokens are measured as ranges before copying.
Header measurement conservatively counts untrimmed values, including NBSP that
Headers preserves; near-limit HTTP-whitespace inputs can therefore be denied.
Header overwrite attempts and repeat preparation count. The signing plan admits generated fixed-width hash/signature
fields before cryptographic work. Canonical query encoding is admitted before
arrays/sorting; bounded header/query/URI inputs bound the derived canonical strings.
The body passed to signing has its existing, separate ownership contract.

Earlier limits can dominate a later one. Helper-level exact-boundary witnesses do
not claim every maximum can be simultaneously reached by one public route. Native
URL and Headers internal allocations and shared compiled catalogs remain outside
this operational representation accounting.

## Compatibility and failure

Candidate order, null/empty/whitespace distinctions, canonical secret aliases,
first-only path and secret replacement, optional header omission, required binding
checks, protected query rejection, repeated query order and transport merge order
remain. Missing required bindings are still checked even if an optional header
will be omitted. Connection/default/null behavior and incomplete selected AWS
credentials retain their prior meaning. No selected grant can borrow an environment
secret to fill a missing field.

Capacity failure is privately branded and exposes only sanitized
`503 provider_preparation_unavailable`. Arbitrary caller error properties cannot
forge the brand. Configuration/credential absence remains separately classified.
The brand escapes environment-rescue and alternate-credential catches.

For a response alternate, only that fixed branded error is retained while the
existing logical preparation observer joins. The original signal is checked after
the join and before the brand is thrown: competing abort retains precedence.
Capacity failure sends no alternate POST, does not select a third grant, and does
not create environment rescue. A received original rejection retains its existing
known-nonbillable accounting evidence and original reservation IDs. This does not
add a reservation/settlement attempt, retry, refund, rollback or new timeout.

## Authored proof and limits

Focused Node coverage includes exact/+1 primitive, CSV, substitution, path, query,
header and URL ceilings; overwrite/repeated-work accounting; pre-expansion and
pre-crypto observations; unused Env getters; optional/required semantics; protected
query order; deterministic SigV4; selected incomplete AWS denial; fresh post-digest
attestation and the ownerless-versus-owned route digest boundary. Descriptor
restoration is registered before instrumentation.

One actual Workerd fixture uses the registered public Responses route, real SQLite
policy/credential/budget/usage owners, current-request namespace handles and a
local HTTP provider/barrier server. Individually admissible large headers and
credentials make initial preparation fit while the shared alternate exceeds its
cumulative allowance. It covers healthy and initial denial, original 401/403/429,
held alternate admission, original-signal abort while the diagnostic client stays
connected, and branded rejection with a queued final-await abort. Reservation IDs,
settlement and one usage event are asserted. In the originating request the fixture
consumes the actual original body once before joining delivery-dependent accounting.
It returns a labelled diagnostic containing the observed handler status and body;
this does not claim the original aborted response body is delivered over HTTP.
The local fault producer admits headers up to its explicit 64 KiB server bound.
The existing alternate fixture's
in-memory omission control still removes only its abort fence.

Fixture releases and immediate tagged outcome observers precede clients. Original
Response bodies and finite background roots are joined; primary failure, including
undefined, and independent cleanup failures remain visible. Runtime disposal is
fixture cleanup, not evidence of operation retirement. Local semantic execution is
UNRUN in CODE_ONLY/HOSTED mode; source and authored coverage are not runtime proof.
There is no engine-heap, whole-32-MiB, signing-body, arbitrary-error-graph, native
allocation or platform physical-lifetime claim. No manual deployment is included.
