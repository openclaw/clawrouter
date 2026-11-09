# Accounting and retained-TEXT admission

This boundary admits the complete selected accounting operation before its first
reserve, soft-status invocation, retained-TEXT write, durable admission or provider
POST. Failure is a privately branded, sanitized
`503 accounting_preflight_unavailable`. Values and original error causes are not
included in that response. Existing monetary validation still applies.

## Closed representations

Serialized UTF-8 bytes and serialized UTF-16 units use the same numeric ceiling.
Escapes and repeated retained occurrences count before encoding or copying.

| Representation | Serialized ceiling | Depth | Values | Containers | Members | Array entries | Decoded strings | Key | Scalar |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Each of four intents and its message variants | 16 KiB | 8 | 256 | 64 | 128 | 64 | 8192 | 128 | 2048 |
| Complete capsule / future event | 64 KiB | 8 | 1024 | 128 | 512 | 256 | 32768 | 128 | 2048 |
| Selected TEXT archive | 8 MiB + 64 KiB | 32 | 65536 | 16384 | Combined with array entries: 32768 | Combined | 8 MiB | 1024 | Aggregate bound |

Numbers serialize to at most 64 units; JavaScript finite-number serialization is
already smaller. Root depth is zero for these three profiles. Independent maxima
do not promise that every dimension can be filled simultaneously. Some value
limits are dominated by member/entry limits; tests label that distinction.

Identity, model, attribution and limit-hint strings admit at most 1024 UTF-16
units. Derived ledger addresses admit at most 8192. Existing tighter correlation
limits remain. Address constituents are checked before concatenation; the scope
serialization is measured before stringify.

Search and private cover retain their actual, smaller control sink: 16 KiB,
root depth one / depth 16, 128 values, 128 members, 128 array entries, 8192 decoded
string units and 4096-unit scalars. Their seed **and prospective terminal event**
must fit. Dispatch, reserve, settle, charge, queue recovery and direct-ingest
representations are admitted before effects. Cover soft-status form encoding is
also admitted against its existing 4096-character URL before any status call.
The generic 64 KiB event ceiling is not a replacement for those sink limits.

## Owners and ordering

All four intents are constructed and admitted before starting a reserve. The
factory's privately copied cost binds standalone reservation callers to complete
capsule admission. Policy/daily/weekly/provider order, windows and IDs are
unchanged. Generic cleanup stays concurrent; Search cleanup stays serial.

The receipt owner captures admitted pricing, modifiers, tariffs, attribution,
protocol flags and actual budget/usage/queue capabilities. Image generation
tables and request bodies are not retained in its price projection. Private
copies are frozen; borrowed caller graphs are neither frozen nor mutated.
Grant updates admit the identity before changing the owned event. Prospective
growth includes bounded service tiers, tool/image fields, content references,
alternate grants and Realtime identifiers. Existing producers supply those
bounds. A valid funded Realtime input fork uses the admitted representation and
new fixed-length IDs, with no second capacity decision after media.

Soft descriptors are prepared before provider dispatch. Status execution still
starts at the existing post-dispatch point; the delivery grace remains 50 ms.
Response WebSocket pinned and unpinned admission prepares accounting and archive
before reserve. Failure paths use already-admitted facts and original IDs.
Existing abort and accounting-unavailable precedence is preserved.

Private error diagnostics from reservation cleanup remain nonenumerable and
retain the original plan-order failure, including `undefined`, and every ordered
terminal ledger/queue pair. Queue recovery success remains cleanup success.
No reserve replay, extra settlement attempt, inferred refund or error-graph size
bound is introduced.

## TEXT archive

The exact privacy-filtered envelope is measured before gateway mapping, copying
or serialization. Only the existing direct gateway-entry `headers` and
`authorization` fields are removed. Other fields and order remain.

The private copy preserves supported plain-JSON stringify semantics: own
`__proto__`, lone surrogates, array undefined/null substitution, object undefined
omission, negative zero and nonfinite numbers. Accessors, cycles and non-JSON
object prototypes are not supported inputs. This is not a new monetary check.

The selected serializer uses whole backings of at most 32 KiB, one synchronous
pending pull and at most one queued chunk. It does not build an entries vector
or use shared scratch. Escaped chunks are measured before encoding. Small
complete serializations fit the same ceiling; larger writes use a fixed-length
stream. R2 completion, serializer/pipe completion and started cancellation are
joined, retaining a primary failure including `undefined` alongside independent
cleanup failures. Serializer EOF alone does not prove R2 completion.

OpenRouter's separate inline-media archive profile remains unchanged. MiniMax
Search, text Music and private cover remain ZERO_R2.

## Fusion and durable consumers

Fusion preserves early synthesizer reserve, then adviser fanout, then synthesizer
POST. Before NUL placeholders, body copies or that reserve, a private immutable
certificate covers original body/configuration, route/active renames, archive
metadata and every successful subset of zero to four advisers. The unknown
proposal component contributes at most 80000 UTF-16 units / 480000 escaped JSON
bytes; known instructions, labels, delimiters and body fields are measured too.
Conservative near-limit early denial is intentional. Local message projections
are measured before flatMap/normalization. Final assembly checks containment in
the certificate; the independent final pricing-coverage guard remains.

An early reservation has one custodian until handoff. A pre-handoff failure
settles acknowledged original IDs once as known-unsent. Started adviser logical
operations remain observed in the originating request; deadlines, collection
completion and cancellation requests are not physical I/O retirement proof.

New durable admission measures initial, observing and terminal serialized states
before writes. Paired upload/generation admission covers both operations and
their combinations before the first commit. These are serialized-state checks,
not GC credit for earlier retained graphs. New managed file additions are
admitted before their copies/write; they do not alter a frozen financial event.
Existing durable receipts, outboxes and recovery do not re-enter new admission.
SQL failure after an earlier commit retains its existing uncertainty.

| Existing consumer | Disposition |
| --- | --- |
| Copilot qualification callback | Existing callback uses the receipt factory; its returned cost binds later reserve admission. No caller/qualification transport change. |
| Managed predictions | Existing prepare/addition calls reach caller and durable preflight; route and provider behavior unchanged. |
| PixVerse paired generation/upload | Complete pair preflight is shared by caller and store. A private capacity denial escapes unchanged before recovery lookup; ordinary lost-ACK/concurrent-winner recovery preserves canonical binding and IDs. |
| Realtime WebSocket | Funded-unit closures retain extracted facts and sinks, not the options/Env/auth/selection/body graph. No session-wide child-count claim. |
| Private cover | Seed and future receipt plus every actual control message fit the existing tighter sink before funding. No public activation. |
| Background store | NEW admission/additions only; existing finalization and recovery keep their original semantics. |

## Qualification and remaining boundary

Authored Node cases cover independent exact/+1 limits, private copies, tighter
Search sink growth, four-leg no-effects denial, Realtime forks, WebSocket ordering,
durable/legacy behavior and injected Fusion containment cleanup. The actual
Workerd fixture covers public HTTP, real SQLite/R2, original serializer EOF and
whole backing observations. Its held/rejected R2 sink and direct-ingest queue
are explicitly injected; neither is platform queue-delivery proof. Existing
PixVerse Node/SQLite coverage is not public Workerd accounting proof.

The PixVerse allocation catch recognizes only the private admission brand. It
rethrows that identical failure before recovery lookup, even when a canonical
winner exists. An ordinary failure with the same HTTP status and code remains
eligible for the existing same-key recovery; it neither replays allocation nor
changes original IDs. The authored caller/SQLite regression distinguishes both
paths without claiming public Workerd proof.

Local semantic tests, TypeScript checking and Workerd execution are UNRUN in
CODE_ONLY/HOSTED mode. Source/syntax checks are not runtime qualification. Fresh
native CI, security and registered consumer qualification remain required.
This does not bound generic request bodies, the whole background-job graph,
arbitrary errors, native SQL/URL/Headers/R2 internals, platform lifetime, engine
heap or a common 32/64 MiB total. No deployment is part of this change.
