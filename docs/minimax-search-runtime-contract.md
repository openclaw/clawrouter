# MiniMax TokenPlan Search runtime

This runtime consumes the existing `minimax.search` request/response codec. Provider declarations and native-client activation are separate work. The only operation is model-less `search.web`, POST `/v1/coding_plan/search`. Native and manifest callers use a ClawRouter proxy key. Access/playground calls do not resolve a session for this operation.

## Authority

An administrator explicitly attests `minimax-global-tokenplan-search` or `minimax-cn-tokenplan-search` on the existing credential owner. `minimaxSearchAuthorization: null` removes permission. The closed private binding identifies TokenPlan Search, scalar API-key storage, region, exact origin, operation and null model. It is independent of PAYG, OAuth, Messages, speech, music and image authority. Environment credentials cannot satisfy it.

The verified HTTP actor travels privately to the owner. After credential preparation, fingerprint/digest hashing and pool admission, the SQL authority rechecks the current enabled administrator. Its bounded acknowledgment includes the original generation, lineage, attachment revision, mutation digest and resulting generation/lineage. The owner compares the complete acknowledgment before storing, without an unrelated await. This is a fresh-at-check boundary, not cross-Durable-Object atomicity. An uncertain or denied attestation is not installed or adopted through pending-attachment repair.

Same-owner renames can preserve an existing binding. Key, account, provider, kind, expiry or product/region changes invalidate it unless the administrator explicitly reattests. Removal, replacement and revocation cannot acquire permission by omission. Import and OAuth paths cannot supply it. Both materialized and secretless projections overlay the authoritative binding or null; the routing allowlist carries only that closed projection.

Admission resolves existing SQL state without legacy imports. It counts candidate rows and UTF-8 bytes before retrieving JSON, on initial reads and rereads. Each stored graph is inspected before parsing. Oversized, missing or pending candidate state denies the entire operation. Selection remains pinned to the original key, generation, lineage, account, region and destination, with no reselection or credential-cache repair. Connection, owner and current caller policy are rechecked before materialization, immediately before POST construction and before output publication.

Unknown USD under enforced monetary budgets denies before materialization or provider I/O. An explicit `policy_fixed` tariff does not grant credential permission. Unmetered usage keeps null tokens, `unpriced_usage`, a null known-cost component and no reporting estimate. A zero ledger debit is not known-free upstream usage. A possibly paid POST is never retried.

## Constant operational reservation

`BodyLease.grow(36 MiB)` requests a **total 72 MiB charge** in the existing 96 MiB pool before proxy-key hashing, authority controls or input reader acquisition. It is not a delta. No leaf lease is nested inside it. Failed admission performs no control/provider action. The reservation stays constant; no garbage-collection credits or early downshift are used.

| Partition | MiB | Simultaneously retained ownership |
| --- | ---: | --- |
| Input/selection | 4 | Original request, 64 KiB raw buffer, fatal UTF-8 text/flattening, bounded parsed graph, normalized selection, prepared native body and transport copies. Native serialization is at most 16 KiB; `q` is at most 4096 UTF-8 bytes. |
| Control tickets | 32 | At most 32 nonrefundable ticket representations, each exactly 1024 KiB as detailed below. |
| Shared control scratch | 8 | Four distinct ordinary-slot workspaces (1 MiB each), one mandatory-slot workspace (1 MiB), SQL/selection record representations (2 MiB), scheduler/digest/descriptors (1 MiB). These partitions are not reused simultaneously by different slots. |
| Native response | 24 | 1 MiB raw wire, 2 MiB UTF-16 text, 2 MiB flattening, 8 MiB graph/string representations, 2 MiB aggregate URL work, 4 MiB streaming serializer/queued delivery and 5 MiB parse/encoding work. The raw graph and projection may coexist. |
| Continuations/output | 4 | Bounded request/control correlation, accounting/retention continuations, error/projection state, output headers and delivery bookkeeping. |
| **Total** | **72** | Another 24 MiB charge fills the pool; any further charge is refused. |

Per-ticket KiB partition: **160 request + 144 response + 256 error/projection/fallback + 64 headers/windows + 128 handles + 272 private workspace = 1024**.

Request 160 KiB allows one bounded graph/strings (80 KiB), serialized and flattened UTF-16 (32 KiB each) and one 16 KiB encoded transport. Response 144 KiB allows the 16 KiB returned backing, 16 KiB raw storage, text and flattening (32 KiB each), graph (32 KiB) and decoded strings (16 KiB). Error/projection/fallback has four bounded 48 KiB graph/string representations plus 64 KiB of terminal/error scratch. Headers/windows permit two bounded header representations and two 16 KiB views. Handle and private-workspace partitions cover pending read/cancel promises, closures, decoder/tokenizer feeds, owner/SQL tuple preparation and serialization. These are operational allowances constrained by representation counts, not measured JavaScript heap guarantees.

SQL storage reads have a cumulative 16 KiB JSON byte budget and at most 32 record reads. Candidate projection count is at most 32; all candidates are preflighted before parsing. Each graph is capped at 128 values, members and entries; at most 4096 candidate nodes coexist. Shared record scratch covers those nodes, bounded strings and repeated authorization records. The final assembled control result must satisfy the control shape limit before serialization. This never puts a full model catalog into a credential row.

## Limits before allocation or parse

- Input: complete 64 KiB wire, depth 16, at most 128 values/members/entries, 32768 decoded key/string units, scalar 16384 units. Selection then enforces the existing closed native query and 16 KiB outgoing body.
- Genuine controls: 16 KiB wire, depth 16, at most 128 values/members/entries, 8192 decoded key/string units, scalar 4096 units, 32 headers totaling 4 KiB. Preflight precedes stringify/encoding; queued work has no serialized body.
- Native JSON: 1 MiB complete wire, depth 64, at most 8192 values/members/entries, 1 Mi decoded key/string units, scalar 65536 units. The codec retains its 100-row/50-related-entry rules and validates all URLs, including rows outside the selected projection. Before either URL pass, the native reader limits aggregate link strings to 16384 UTF-16 units (individual links retain the codec's 8192-unit cap). This bounds both canonicalization passes and retained projection URLs within the 2 MiB URL allowance, even under percent expansion. It is an operational limit, not a vendor fact. Returned URLs are never fetched.
- Physical reads: at most 8192 calls including empty chunks and EOF; at most 16 KiB per returned backing, not only view length. BYOB uses the returned backing. An unqualified default reader is rejected before its first read, with its original cancellation still owned; it cannot establish a pre-acquisition backing bound. Fatal UTF-8 and bounded tokenizer feeds precede JSON.parse. No tee, page archive or retained read history.

The native writer streams the bounded graph. There is no whole-document response stringify/encoded-copy pair, and character validation does not allocate character arrays. Parser, selection, preparation, input and output references can coexist within the constant charge.

## Exchange scheduling and retirement

There are 22 ordinary and 10 mandatory nonrefundable tickets. Four ordinary physical slots and one separate mandatory slot are acquired **before** serialization and fetch/R2/queue construction. The provider slot is reserved before HTTP preparation. Soft-budget status calls and retention use the same scheduler. A queued branch retains only bounded descriptors, not prepared control wire bodies.

A maximum hard-budget success uses admission 1, pre-materialization freshness 3, materialization 1, retention 1, reserves 4, dispatch marks 4, pre-POST freshness 3, provider POST 1 and publication freshness 3: **21 ordinary**. Soft status replaces the reserve/dispatch work. Finalization serializes at most four settlement/charge operations, four existing fallback sends and queue/direct usage delivery: **10 mandatory**. Tickets are never refunded by cancellation or failure. No automatic retry is introduced.

The original input owner registers before header checks or the first read. Prompt public cancellation races the whole operation. Retirement separately joins the original read, first cancellation acknowledgment and reader unlock. A cleanup rejection remains distinct from successful cancellation. A held cleanup retains its charge and slot; the next mandatory fallback cannot wait inside its own predecessor's slot.

Late fetch responses are disposed through the same owner. Whole parse/validation work, accounting, retention, late validated output, serializer and downstream EOF/cancel all register before the operation closes. Completion joins these children without joining itself. Unclaimed successful output retains capacity and the original operation deadline. Each mandatory accounting attempt has a 30-second execution window independent of caller cancellation. At most ten nonrefundable attempts bound execution to ten such windows; an existing fallback starts only after its predecessor physically retires, with its own bounded signal. Physical HTTP cancellation and noncancelable Queue/R2 promises retain their slot and charge until actual settlement, even after that window. Bodyless pre-reader failures release before fallback; an unowned locked body fails closed. Cleanup rejection does not rewrite the original billing outcome. The caller owns the directly returned body; this contract does not assert a producer-side cleanup acknowledgment or total isolate heap measurement.

## Qualification

Focused suites cover binding round trips, both regions/routes, current administrator demotion after pool admission, newly enforced principal limits before materialization, mutation/replay fencing, null/import projections, revocation/rotation, unknown hard-budget zero egress, fixed and unknown usage, preparse/read/backing bounds, held read and first cancellation, cleanup rejection, late disposal, ticket/slot limits and 72+24 MiB contention.

The isolated workerd fixture uses real admin HTTP, SQL authority and credential Durable Objects, and instruments the actual returned provider body. Controlled cancellation is delivered on the original request's network continuation. It exercises maximum intake/native wire, both routes/regions, held cleanup, late fetch and unclaimed/canceled downstream delivery. Node mocks are logic evidence only. All hosted exact-head gates and actual workerd outcomes must pass before this runtime is ready; declarations, client composition and live product entitlement remain separate.

The caller ledger explicitly excludes credential-owner producer storage allocations: `/inspect` and `/materialize` currently load the whole private record before producing their bounded reply. SQL projection preflights do not bound that separate owner allocation, and this slice neither proves a leak there nor qualifies its capacity. Search also remains outside the existing request-content-retention capability set: enabling retention exercises the scheduled policy decision but produces no archive write. No Search retention permission is introduced.

The combined workerd case witnesses sequential intake/native-publication and settlement/fallback phases under one cumulative 72 MiB reservation, with no GC credit or downshift. It does not claim measured simultaneous heap liveness of the native graph and every later error/fallback representation. The ledger reserves their sum regardless of whether earlier references remain reachable. Maximum parsed error controls (16 KiB wire and 128 values) retire their original reader before fallback; a separate actual bodyless-reply case tests the pre-reader disposal boundary.
