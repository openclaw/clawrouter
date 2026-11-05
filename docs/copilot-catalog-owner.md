# Private Copilot catalog owner

The credential owner exposes an internal `/copilot-catalog` operation. No public
route, provider declaration or generic credential materialization is activated.
It returns observations and an operation-scoped selection verdict, not a reusable
inference permit. The original GitHub token stays inside its credential owner;
there is no `/v2/token` exchange, environment fallback or account substitution.

## Authority and freshness

The private input pins the grant key, current generation and lineage, committed
device/account attempt IDs, verified caller proof, server-owned runtime identity,
original absolute deadline, and optional canonical model/advertised format.
The account and device acquisition bindings must match their private records.
Acquisition history is distinct from current installation generation.

Only the caller's direct policy or tenant owner is accepted. An explicit current
`eligibleGrants` restriction still applies. This slice does not make a private
`reauth_required` owner an active generic pool credential or enable shared-owner
selection. Collection authority, caller tokens, URLs and header bags are denied.

Every call performs one account GET followed by one models GET, on the SAME
original signal/deadline and token. The account's qualified destination must equal
the committed binding, including base path. Changed destinations fail closed.
Current caller policy and owner state are checked before each physical fetch,
after complete parsing/retirement, and before publication. The final owner read
is the last await before fetch starts under ordering; remote I/O runs outside the
tail. Replacement, revoke and account cancellation abort active catalog work.
There is no cache, automatic retry, invented token expiry or freshness TTL.
`qualifiedAt` and `observedAt` are observation times only.

The final inventory intersects the policy admitted before the first GET with the
current policy. IDs use the explicit `github-copilot/` namespace and exact trimmed
upstream identity. Selection requires a visible row, explicit normalized
`policy.state: enabled`, exact ID and an advertised Chat, Messages or Responses
format. Missing/unknown policy can remain a catalog observation but cannot yield
an eligible selection. Empty, hidden, disabled and unconfigured rows never seed
fallback models or grant consent. No prices or default limits are manufactured.

## Combined operational allocation

One 80 MiB response/parse reservation plus a separate 2 MiB control allocation is
charged in the existing 96 MiB isolate pool BEFORE the account GET. There is NO
nested 64 MiB account-owner reservation. Another 16 MiB charge prevents admission.
These are operational allowances, not measured heap or V8 object-size claims.

| Simultaneously covered representations | MiB |
| --- | ---: |
| Catalog fixed wire, UTF-16 text and parsed string payloads | 10 |
| Parsed container/member/value slots, including discarded metadata | 32 |
| Normalized rows, copied strings, sets and final policy projection | 20 |
| BOTH response read/promise continuations, tokenizer and normalization scratch | 8 |
| Account projection/canonicalization, bounded owner records, headers and URLs | 2 |
| Streaming publication scratch and bounded delivery windows | 1 |
| Operational headroom | 7 |
| Separate bounded private control intake | 2 |

Account intake is streaming: 16 MiB cumulative wire, no archive or AST, a 16 KiB
returned backing, 384-byte stack and 8192-byte projected URL storage. Its decoded
URL is at most 4096 UTF-16 units; canonical UTF-8 is bounded by the committed
48 KiB URL. The private predecessor row stays within the existing 96 KiB limit.
Catalog intake retains one fixed 2 MiB buffer and one decoded text. Its guard
runs before JSON.parse: depth 64; 32770 containers; 131072 members and array
entries each; 262146 values; 2 Mi UTF-16 decoded key/string units. All occurrences,
including overwritten and discarded fields, count. At most 4096 raw rows and
512 UTF-16 normalized ID units are accepted. Normalization/filtering retain no
page archive or prior observation.

Each response allows at most 8192 physical reads INCLUDING empty results and
EOF: 16384 across both. Each returned BYOB backing is at most 16 KiB and is reused;
there is no per-read HttpOperation race/history. Both response owners stay
registered until retirement. The ledger includes both account and catalog
representations; it never assumes GC between phases or downshifts after account
EOF. `jsonBodyTransport` measures an at-most 4 MiB output without a whole-document
string/copy, emits bounded chunks and retires serializer references explicitly.
Nothing is persisted to the credential row or another store.

## Retirement and proof

The operation races the complete registered physical continuation for prompt
failure. Capacity separately joins BOTH original response reads, FIRST cancel,
lock retirement, late-response disposal, parsing, final authority, serializer and
producer EOF/cancel. Cleanup settlement does not assert successful cancellation.
A lock that cannot retire keeps the charge. Owner mutation never waits for a held
vendor read. A response arriving after abort is disposed before physical release.

Node tests exercise real credential-owner and authority implementations with
synthetic transport. Workerd tests exercise actual admin/device/account setup,
the credential owner, fixed outbound factories and real HTTP response bodies.
The maximum fixture combines 16 MiB account input and 2 MiB catalog input with
4096 rows and the guard's container/member/array-entry maxima. Other scenarios
cover both exact read limits/overflow, independent held read and FIRST cancel,
cleanup rejection, late response, revoke/replacement, account cancellation,
policy tightening, changed destination and empty/unknown selection.

This proves the named owner and producer boundary only. It does not certify
another DO's retained transport buffers or physical host-disconnect propagation.
Public discovery, inference dispatch, client composition and billing remain
separate dependencies. Synthetic fixtures use no live provider credentials.
