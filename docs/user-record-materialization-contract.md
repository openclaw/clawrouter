# Selected user-record materialization

This foundation bounds selected user-query and cold-import producer materialization.
It does not migrate, truncate or project records. Complete unknown SQL fields and
valid 1000-rule legacy assignment revisions larger than 64 KiB remain supported.
The selected reply consumer keeps its existing complete 1 MiB profile.

## Private selection

Only the default `policy-bindings` `/users/resolve` call and its exact cold
`/users/initialize` call construct `x-clawrouter-user-materialization: v1`.
This is a private protocol selector, not authorization or proof of the DO name.
Caller headers are never forwarded. Present unknown versions, unsupported paths
or methods are rejected before generic JSON parsing, after owning the body.
Unmarked callers, other namespaces, bulk `initialize-all`, generic initialization,
specialized transports and the seventeen ACK selectors remain unchanged. Selected
initialization uses the existing `initialized` ACK and its uncertainty contract.

## Independent phase limits

| Representation | Limits |
| --- | --- |
| Each raw SQL/KV record and cumulative records within one phase | 2,097,152 original UTF-8 bytes and UTF-16 units |
| Cumulative record scanner | Depth 16; 16,384 values; 4,096 containers; 8,192 members; 8,192 array entries; 2,097,152 decoded string units including keys; key 1,024; scalar 2,097,152; number token 64 |
| Selected request | Separate 2,097,152 wire bytes/text units and the source scanner limits; 4,096 raw email/row occurrences; raw email 1,024 units |
| Complete query envelope and normalized candidate batch, separately | 1,048,576 serialized UTF-8 bytes/text units; depth 16; 8,192 values; 2,048 containers; 4,096 members/entries; 1,048,576 decoded string units including keys; key 1,024; scalar 1,048,576; number token 64 |
| Original request/KV stream | One reused whole backing at most 16 KiB; 8,192 reads including empty and EOF |
| Selected request headers | 32 fields and 4 KiB aggregate name/value units |

All discarded and duplicate JSON occurrences count before `JSON.parse`.
Original wire bytes and decoded text are separate: replacement decoding and BOM
handling do not re-charge expanded replacement text as original bytes. Limits
compose independently; earlier byte, string or structural guards can dominate.
In particular, not every set of 4,096 initializer rows fits the structural caps.
Raw padding, escapes, duplicate floods and ignored normalization data can deny the
whole operation. No bounded prefix or partial record is returned as success.

Query DO requests and their cumulative SQL reads have separate budgets. The cold
caller shares one KV budget across its entire sequential hydration. Selected init
has separate request and cumulative existing-SQL budgets. A final canonical query
is another phase; it does not imply earlier graphs have been freed. Repeated actual
record reads are charged again, without GC credit or per-key resets.

SQL checks `length(CAST(user_json AS BLOB))` before selecting the value, then guards
raw text and every structural occurrence before parsing. SQL-native work and the
upstream creation of the original email array remain outside this boundary.
Caller JSON admission precedes stringify; output admission measures JSON escaping,
UTF-8 and UTF-16 without an encoded archive. It operates on internal plain JSON
data; it does not invoke custom accessors or `toJSON` during admission.

## Canonical and write behavior

Query emails normalize, filter invalid values, then deduplicate in first-normalized
order. Raw request occurrences count first. Group normalization separately retains
its existing raw-deduplicate-before-trim/lowercase behavior. Cold KV truthiness is
unchanged. Every relevant existing SQL row is parsed, including malformed records;
a present row keeps its existing wrapper truthiness even for parsed null/false/0.

The caller admits raw seeds without normalizing them. The owner first checks CURRENT
canonical rows and ordered first-wins candidates. A canonical winner can ignore an
otherwise normalization-invalid seed. Only insertion candidates are normalized.
All resource, validation, complete-batch and serialization checks finish before the
first insert. Prepared records avoid repeated `putUser` normalization/serialization.
There is no new transaction or rollback guarantee. A SQL failure after an earlier
write remains uncertain; committed imports are not compensated or replayed.

## Source ownership and evidence

One original KV stream is processed at a time. The actual get is registered and
normalized before invocation and is always joined, including late completion.
Original incoming request bodies are acquired before selector/header rejection.
Default readers are cancellation-only. Original reads, memoized FIRST cancellation
(including rejection) and unlock are joined using unchanged `inputRetirement`.
Rejected cleanup after unlock denies; unknown or retained locks keep the facade
pending. Retained production failures contain fixed sanitized classifications only.
No timer, deadline, signal, cross-request I/O join or whole-auth abort promise is added.
Failure is terminal; it never becomes missing-user creation or authentication fallback.

The authored Workerd fixture FIRST probes original KV and both original incoming DO
body shapes for BYOB, whole backing, EOF and unlock. Unsupported capability blocks
qualification; healthy bodies are not wrapped or replaced. Subsequent semantic
cases use real SQLite/KV. HTTP source faults, late-get holds and SQL-after-commit
failure are labelled injections. The held HTTP-read case waits for genuinely pending
native reading; the unknown-lock exit is only a fixture diagnostic with its owner
still unsettled. HTTP EOF and runtime disposal do not prove that owner's retirement.
Node byte producers are synthetic compatibility fixtures. All execution is pending
until fresh hosted qualification. These are operational data/ownership bounds, not
measured heap, platform allocation, global collection or common-memory closure.
