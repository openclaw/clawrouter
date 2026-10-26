# Hot-path review and local load evidence

## Indexed usage snapshots (2026-10-25)

Production observation supplied for this change: one UsageLedgerObject
`GET /snapshot` spent **9.8 s CPU / 18.7 s wall**, and `/v1/usage` wall P99 was
**4.9 s**. Ownership and admin grouping repeatedly extracted IDs from full
event JSON across the thirty-day window.

Usage rows now project raw `principal_id`, authority-normalized `principal_key`,
and `credential_id`. Indexes on `(policy_id, principal_key, occurred_at_ms DESC)`
and `(policy_id, credential_id, occurred_at_ms DESC)` serve owner filters before
the event limit. Projected `cost_basis` also removes JSON parsing from the
unpriced counters. A `principal_nontext` flag preserves the old exclusion of
non-string, non-null principals from credential-owned reads. Raw event JSON,
retention, grant usage, public shapes, and principal merging stay unchanged.

The durable `usage_attribution_migration` row records an initial upper rowid,
last processed rowid, and completion. Each snapshot and alarm updates at most
2,000 rows with JS normalization, committing projections and cursor together.
Pending migrations schedule alarms every 60 seconds; new ingests write the
projections immediately. Only pending rows use the original JSON ownership and
counter expressions. Snapshots remain complete during migration, although
pending reads still incur JSON scan costs. Completed shards never restart the
backfill and snapshot SQL performs no JSON extraction. SQLite builds the two
new indexes once on first activation.

Reproduce with `node scripts/benchmark-usage-snapshots.mjs`: 100,000 synthetic
events averaging 1,500 bytes, multiple principals/providers/days, five warm
samples, median process CPU and wall time on Node 26.12.1 / Apple M3 Ultra.
The harness compares the pre-change SQL with the real migrated ledger and
asserts identical complete responses. This is local SQLite evidence, not a
post-deployment latency measurement.

| Snapshot | CPU before → after | Wall before → after | CPU speedup |
| --- | ---: | ---: | ---: |
| Personal | 2,188 → 272 ms | 2,839 → 425 ms | 8.04× |
| Admin | 2,349 → 355 ms | 3,250 → 469 ms | 6.62× |

Schema/index creation used 174 ms CPU. Backfill completed in 50 batches:
median 22.8 ms CPU, maximum 53.8 ms. Equality tests also cover partially
backfilled shards, Unicode/case/whitespace aliases, non-text historical
principals, credential-only events, concurrent-era ingests, restart/rollback,
and owner filtering before LIMIT.

## HTTP Responses CPU (2026-10-25)

The supplied 15-minute production tail reported `POST /v1/responses` at 101 ms
median / 2.2 s P99 / 3.7 s max CPU (135 requests), and native OpenAI Responses at
142 ms median / 1.5 s P99 (102 requests). Embeddings were about 15 ms median and
Durable Object routes at most 7 ms. DFW load shedding was 2.8%, LAX 0.9%. These
are the supplied observations, not a new production measurement or deployment.

The local baseline is `f8faad4`, the clean checkout actually present at task start
(newer than the work order's `2163d3f`). The diagnostic drives `handler.fetch`
through unified and native OpenAI HTTP Responses, with a soft-budget policy,
warm admission snapshots, an environment credential, fake continuation ACKs and
fake budget status/charge receipts. It asserts zero pre-dispatch backend calls,
zero warm KV reads, exact delivered byte counts, one usage receipt per request,
the terminal token counts, and the expected number of archive writes.

Synthetic Codex histories contain messages, function calls/results, function
schemas and reasoning with encrypted content. Request sizes are 524,257,
2,097,121 and 5,242,849 UTF-8 bytes. Each response has 600 deltas, an item-done
snapshot and a final completed snapshot with usage: 1,185,305 SSE bytes in
4,093-byte chunks crossing JSON escapes, UTF-8 and CRLF boundaries. Generation
and encoding of these fixtures happen outside measurement. Each cell warms 30
requests, then averages `process.cpuUsage()` over 30 sequential requests, from
handler entry through byte delivery and all accounting/retention background work.
Request construction is excluded. The fixture freezes only its test hot-cache
clock so a long cell cannot become a refresh experiment; production cache rules
are unchanged. Node v26.12.1 was used; the raw report records the runtime.

| Route | Input MiB | Retention | Before CPU ms/request | After CPU ms/request | Reduction |
| --- | ---: | --- | ---: | ---: | ---: |
| Unified | 0.5 | Off | 65.86 | 62.30 | 5.4% |
| Unified | 2 | Off | 79.24 | 73.11 | 7.7% |
| Unified | 5 | Off | 98.48 | 97.02 | 1.5% |
| Unified | 5 | On | 97.02 | 91.55 | 5.6% |
| Native | 0.5 | Off | 61.40 | 46.49 | 24.3% |
| Native | 2 | Off | 75.57 | 68.28 | 9.6% |
| Native | 5 | Off | 97.45 | 80.79 | 17.1% |
| Native | 5 | On | 102.59 | 94.22 | 8.2% |

These are process CPU averages, not edge invocation measurements. Whole-request
variation is material: retention-on can appear cheaper than retention-off in
separate cells, and unified/native dispatches share most code. Do not infer a
uniform speedup, an archive discount, or production tail/load-shedding changes.
The [raw before/intermediate/after samples](performance/http-responses-cpu-local.json)
preserve that variation rather than selecting the best rounds. Exploratory runs
with shorter warmups, a cache-refresh crossing, or overlapping task-owned runs
were excluded; the retained native 5 MiB baseline briefly overlapped a focused
test process, so shared-host interference remains possible even though CPU
counters exclude that other process. No full scripts test suite was run.

### Sampled CPU ranking

Separate inspector profiles cover 20 requests per cell at a 100 µs interval
(10 warmups before, 30 after). Profiling overhead raises the baseline unified
5 MiB retention-off mean to **119.23 ms**, versus 98.48 ms without the profiler.
Self and inclusive totals below are sample-count estimates normalized to that
profiled process CPU, excluding idle/program samples. Inclusive rows overlap;
async stack boundaries and Node test/Promise hooks limit stage attribution.
They are not precise workerd timers or independently additive stage durations.

| Rank | Function / stage | Self ms | Inclusive ms | Request CPU |
| ---: | --- | ---: | ---: | ---: |
| 1 | Identity inspector byte `push` (`response-identities.ts`) | 3.91 | 25.88 | 21.7% |
| 2 | Token pipeline `next` (`stream-chain`) | 5.05 | 22.58 | 18.9% |
| 3 | `estimateModelCost`: redundant JSON stringify + UTF-8 count | 7.53 | 11.79 | 9.9% |
| 4 | `readJson`: required request decode/JSON parse | 6.27 | 8.49 | 7.1% |
| 5 | `prepareSingleSelected`: outbound serialization/preparation | 7.98 | 8.23 | 6.9% |
| 6 | Metadata/tool/witness token dispatch (`responses-usage.ts`) | 1.69 | 8.11 | 6.8% |
| 7 | JSON tokenizer (`stream-json`) | 6.87 | 6.92 | 5.8% |
| 8 | Garbage collection | 5.76 | 5.76 | 4.8% |
| 9 | UTF-8 encode builtin, across owners | 5.45 | 5.45 | 4.6% |
| 10 | UTF-8 decode builtin, across owners | 4.31 | 4.31 | 3.6% |
| 11 | Compaction witness `observe` | 0.16 | 0.80 | 0.7% |
| 12 | Recursive cache TTL body scan | 0.55 | 0.68 | 0.6% |
| 13 | Recursive cache-control key body scan | 0.44 | 0.61 | 0.5% |
| 14 | `sha256Hex`, all request/continuation owners | 0.22 | 0.58 | 0.5% |
| 15 | Usage extraction (`extractUsageTokens`) | <0.02 | 0.04 | <0.1% |

Request continuation/tool-base classification and witness construction had no
self samples in this profile; that is below sampling resolution, not zero work.
With retention enabled, archive `write` was 10.18 ms self/inclusive (8.2% of that
separate 123.96 ms profile). The response parser already uses one streaming
decoder, bounded feeds and incremental scalar/tool projections; it does not
accumulate or repeatedly decode the whole SSE response. Identity inspection has
its own decoder because it publishes protocol identities independently of full
JSON validity and bounded pricing/tool qualification. Removing that independence
would change delivery/error/publication semantics.

### Safe changes and measured savings

`422d4ef` defers serialized-size estimation until bytes can affect the input
bound. Opaque reasoning, history references and unbounded media already select
the full existing bound. The pricing-gap, media, service-tier, output-limit and
reservation rules remain in place. At 5 MiB, before-header CPU fell from
25.50 to 20.23 ms unified, and 25.78 to 20.39 ms native: **about 5.3 ms saved**.
Whole-request means in that intermediate run were 98.43/97.71 ms, effectively
unchanged against 98.48/97.45 ms because delivery variation masked the gain.
Ingress still parses once; the opaque retention-off request now serializes once
for dispatch instead of twice. The optional JSON audit confirms one large parse
and one large stringify per request after the change; retention adds its original
archive-envelope serialization. Original ingress length cannot generally replace
the transformed pricing body's length (model rewrites, whitespace and escaping).

`d87b694` feeds complete SSE data spans into the bounded identity scanner and
skips irrelevant string runs with native delimiter searches. It preserves
escape parity across chunks, typed identity paths, UTF-8 limits, conflicts,
line endings and incomplete-event publication rules. In the separate 5 MiB
profile, identity byte `push` fell **25.88 → 8.02 ms**, about **17.9 ms / 69%**.
Final profiled request CPU was 110.48 ms. The unprofiled table above is the
whole-request result; profile-attributed savings are not additive predictions.

Substantial work remains: one ingress decode/parse, the transformed outbound
serialization, and validating streamed usage, tool ancestry and witness evidence.
The latter pipeline is now the dominant sampled response cost. Further safe
work should target tokenizer/projection allocation and Promise overhead, with
the same fault/cancellation/duplicate-key corpus. Sharing the identity decoder
and parser would need a design that preserves early identity publication and
its error precedence. Forwarding unchecked raw input, dropping final output
inspection or reducing archive content would change contracts; none was done.
No auth, policy, budget state, pricing result or continuation witness cache was
added or extended.

### Synchronous tokenizer (2026-10-25)

stream-json's tokenizer stage (`jsonParser`) is synchronous, but `parser()`
wraps it in UTF-8 and async generator stages, and `fun()` adds another async
layer: every 4 KiB feed and every per-event `end()` paid generator and Promise
overhead larger than the tokenizing. `worker/json-tokens.ts` calls the bare
stage directly (pinned 3.7.0 exports it at runtime, not in its typings;
`worker/test/json-tokens.test.mjs` fails if an upgrade drops it). The Responses
inspector, its SSE line handling and the large-body JSON parser are now
synchronous; only observation delivery is awaited. The metadata and tool
projections resolve their selected path only at value starts instead of on
every token. Token order, per-feed materialization, malformed-feed rejection
(no tokens from a failing feed), limits and evidence are unchanged.

Interleaved local runs (same host, Node 26, three/two rounds):

| Case | Before CPU ms | After CPU ms |
| --- | ---: | ---: |
| Inspector only, 4,000 tiny deltas, ~0.9 MiB (`responses-inspector-cpu`) | 77–94 | 21–24 |
| Whole handler, 0.5 MiB, after-header share (unified / native) | 43–44 / 42–48 | 26–34 / 24 |
| Whole handler, 5 MiB retention off, after-header share (unified / native) | 65–77 / 55 | 39–44 / 40–51 |

Real Codex streams are dominated by many small deltas, so the inspector-only
case is closer to production than the two-snapshot handler fixture. Remaining
inspector CPU is flat: tokenizer ~12%, projection dispatch and path
classification ~35%, GC ~4%.

### Claude body byte counting (2026-10-26)

Production native Anthropic Messages requests were ~730 KiB at p50 and spent
~69 ms CPU per MiB, nearly all before upstream dispatch. A profile of the new
`http-anthropic-cpu` diagnostic (Claude Code-shaped history: system blocks with
cache control, tool schemas, thinking, tool use/results) put **71%** of request
CPU in `jsonBodyBytes`, called by pricing and again by dispatch (and by
retention). It measured a body by running the generator-based chunk serializer
and UTF-8-encoding every chunk, to avoid a whole-document copy of bodies up to
32 MB.

`jsonBodyBytes` now walks the value directly and measures each string with the
same 4 KiB `JSON.stringify` chunks, written by `encodeInto` into one reused
scratch buffer: no generators, no per-chunk `Uint8Array`, still no document
copy. The result is the exact UTF-8 length of `JSON.stringify(value)` (fuzzed
against it, including lone/paired surrogates across chunk boundaries); the
streaming serializer for bodies above 8 MiB is unchanged.

| Native Anthropic, interleaved local runs | Before CPU ms | After CPU ms |
| --- | ---: | ---: |
| 0.75 MiB, before headers | 18.2–22.5 | 7.8–9.3 |
| 2 MiB, before headers | 50.9–57.9 | 18.0–19.1 |
| 2 MiB retention on, whole request | 86.5–97.0 | 26.8–32.7 |

Byte counting alone: 2.1 MiB ASCII 5.2 → 1.5 ms, mixed emoji/escapes 8.8 →
5.0 ms, 6 MiB CJK 6.9 → 2.5 ms. A regex scan over non-ASCII text was tried and
rejected: 9× slower on CJK. Remaining pre-dispatch CPU is the two counts (~35%
of the smaller total), ingress parse and dispatch serialization.

Reproduce timing, profiles and the optional serialization audit separately:

```sh
# Choose an artifact directory on the external volume, outside this checkout.
proof=/Volumes/Clawstudio-Storage/CodexWorktrees/clawrouter-http-cpu-proof
HTTP_CPU_OUT="$proof/timing" node test/diagnostics/http-responses-cpu.test.mjs
HTTP_CPU_PROFILE=1 HTTP_CPU_SIZES=5 HTTP_CPU_RUNS=20 HTTP_CPU_OUT="$proof/profile" \
  node test/diagnostics/http-responses-cpu.test.mjs
node scripts/summarize-http-cpu.mjs "$proof/profile/unified-5MiB-retention-off.cpuprofile" "$proof/profile/results.json"
node --cpu-prof --cpu-prof-dir="$proof" test/diagnostics/http-responses-cpu.test.mjs
HTTP_CPU_COUNT_JSON=1 HTTP_CPU_RUNS=1 HTTP_CPU_WARMUPS=1 HTTP_CPU_SIZES=5 \
  node test/diagnostics/http-responses-cpu.test.mjs
node test/diagnostics/responses-inspector-cpu.test.mjs
HTTP_CPU_OUT="$proof/anthropic" node test/diagnostics/http-anthropic-cpu.test.mjs
```

CPU profiles remain outside Git. `before-node.cpuprofile` and
`after-node.cpuprofile` capture complete `node --cpu-prof` runs; per-cell inspector
profiles exclude startup/fixture generation. No live provider call or deployment
was performed.

## WebSocket create follow-up (2026-10-23)

Live production baseline, measured **before #326's hot caches**: 15 chained
`previous_response_id` turns on one Responses WebSocket, using the same model
on both sides. Direct OpenAI median `response.created` was about **120 ms**,
versus **810 ms** through ClawRouter; TTFT was about **995 ms**, versus
**1,550 ms**. The router added roughly 550–700 ms per turn. A warm
edge-to-global-authority round trip measured about 72 ms (`cr-admission;dur=72`);
HTTP router overhead was about 130–200 ms.

Budget reservation now starts every configured monthly, daily, weekly and
provider leg concurrently, including on HTTP hard-budget paths. Attempted IDs
are observed before each leg's I/O. All results finish before rollback; every
successful leg is released on failure, and the first failure in plan order wins.
Failed rollback still returns `accounting_unavailable`.

On pinned WebSocket creates without a same-socket witness, continuation resolution overlaps grant preparation.
Once continuation tool evidence resolves, budget reservation also overlaps the
remaining preparation. Its provider connection comes from the same request's
admission result through `assertProviderAccess`, with no extra I/O, whether that
admission came from the hot cache or the authority. Pinned preparation uses that
same connection object and does not refresh the authorization snapshot. First
creates retain sequential continuation/preparation/reservation ordering because
unpinned selection can refresh the snapshot. This change adds no cache of its
own; admission and credential caching follow [#326's hot-cache bounds](#zero-hop-warm-path-2026-10-23).

For a warm pinned, chained create with a stored grant, no credential refresh,
and retention disabled, these were the **sequential storage round trips before
upstream send** after #325. The baseline is main at `0f0d455`; its counts follow
the sequential awaits in that version. The current counts appear below.

| Budget legs | Warm caches: main → merged | Cache disabled: main → merged |
| --- | ---: | ---: |
| None | 3 → 2 | 5 → 4 |
| One (policy monthly) | 5 → 3 | 7 → 5 |
| Policy monthly + provider | 6 → 3 | 8 → 5 |
| Policy monthly + daily + weekly + provider | 8 → 3 | 10 → 5 |

At #325, warm main waited for continuation → KV → select → each reserve →
parallel dispatch. That follow-up overlapped `KV → select` with
`continuation → parallel reserve`, then awaited parallel dispatch. WebSocket
creates still read KV and called `/grant-pools/select` then. Cache-off added
foreground admission before those branches and credential materialization after
select. The local-selection and combined-dispatch improvements below supersede
those counts.

WebSocket retention, when required, still completes after reservation and before
dispatch; #326's post-dispatch retention applies to ordinary HTTP. These counts
exclude the connection handshake, earlier-turn settlement, and continuation
publication. In reserve mode, credential preparation,
budget reservation, required retention and dispatch finish before the frame is sent.

Soft-policy WebSocket turns now omit reserve and dispatch calls. They perform
local budget preflight and start `/status` reads alongside the send; exhaustion
never aborts the active turn and instead denies the next create in this isolate.
Observed usage uses the shared soft charge/recovery path. With local selection,
the causal fixture now asserts zero warm rounds with a committed same-socket
witness, or two with caching disabled (`admission`, then `materialize`), with
zero, one, two or four budget legs. Required retention remains ahead of send.

Non-terminal frames (including `response.created`, metadata, deltas and items)
forward in wire order while identity and pricing evidence writes run in their
own per-operation FIFO. The terminal frame waits for every write; binding failure
closes with `continuation_unavailable` before that terminal can reach the client.
Pending writes and held frames consume the output count/byte limits. Settlement
waits for both writes and terminal delivery, including on close/timeout races.

After terminal publication, the next same-lane create can begin admission while
the prior turn settles. Sending and the final soft-budget preflight wait for
that settlement and recheck cancellation. A cap observed by the previous turn
therefore denies the next send; an unsent denial settles once without closing
the socket. The per-lane settlement wait runs outside shared admission and
connection establishment, so other lanes can admit and send while it is held.
Settling operations still count toward the active limit.

The SQLite-backed Node admission fixture releases each storage round only once
exactly its expected hops are waiting, so concurrency is proven causally rather
than by wall-clock timing; a serialized or unexpected hop fails the test. It
asserts each batch in both cache and budget modes, freezing the cache clock after warm-up
so host scheduling cannot expire entries. It also proves that
`assertProviderAccess` and pinned preparation return the same admitted connection
without a new connection lookup in both modes. A separate 40 ms-per-reserve test
observes four simultaneous legs completing in roughly one delay. These are
scheduling proofs, not a new production latency measurement.
A continuation belonging to another grant returns the actionable
`409 continuation_restart_required` before dispatch, instead of reaching the
session's generic `502 provider_unavailable` pin-change close. The fixture also
proves unsent reservations are released after mismatch or materialization failure;
materialization-failure fixtures explicitly disable the credential cache.

### Same-socket continuation witnesses (2026-10-24)

Each session holds at most 32 recently committed identities. A witness contains
the exact committed owner, grant key/revision and final pricing evidence; turn
state retains routing affinity without inheriting response pricing. It is added
only after both binding and evidence writes acknowledge success. Pending writes,
failed writes and lost evidence acknowledgements cannot mint witnesses.

Every supplied identity must match the fresh create's continuation scope,
policy generation, provider/endpoint and socket grant pin. Otherwise the whole
lookup goes to the continuation authority with the existing restart semantics.
HTTP, reconnects and other sockets cannot use these witnesses. Eviction just
falls back to authority; closing clears the session and prevents late writes
from repopulating it. No isolate-global cache or additional staleness window is
introduced. Header/metadata conflicts still reject before either lookup path.

The causal fixture's current counts, excluding handshake, previous settlement,
publication and required retention, are:

| Policy / budget legs | Warm same-socket witness | Cache off, same-socket witness |
| --- | ---: | ---: |
| Soft / 0, 1, 2 or 4 | 0 | 2 |
| Reserve / none | 0 | 2 |
| Reserve / 1, 2 or 4 | 1 | 3 |

Warm reserve legs issue parallel reserve-dispatched calls in the sole round.
Cache-off first performs admission, then materializes credentials, then reserves
when required. Without a witness, warm creates add a continuation round before
reservation; cache-off overlaps continuation with materialization. These are
exact-multiset scheduling proofs, not new production latency measurements.
The binding-write-held fixture separately proves `response.created` reaches
the client before the binding commits while terminal delivery stays blocked.

### Soft turns and combined reserve/dispatch (2026-10-23)

Reserve-mode creates without required retention now request dispatch-started
reservations in the same call per leg. Only an explicit `dispatched: true` reply
allows the Worker to skip that leg's `/dispatch`; older Durable Objects keep
the separate call. The causal fixture expects exactly these rounds for a pinned,
chained create with stored credentials and retention disabled:

| Policy / budget legs | Warm: combined dispatch → local selection | Cache off: combined dispatch → local selection |
| --- | ---: | ---: |
| Reserve / none | 2 → 1 | 4 → 2 |
| Reserve / one | 2 → 2 | 4 → 3 |
| Reserve / policy + provider | 2 → 2 | 4 → 3 |
| Reserve / monthly + daily + weekly + provider | 2 → 2 | 4 → 3 |
| Soft / none | 2 → 1 | 4 → 2 |
| Soft / one | 2 → 1 | 4 → 2 |
| Soft / policy + provider | 2 → 1 | 4 → 2 |
| Soft / monthly + daily + weekly + provider | 2 → 1 | 4 → 2 |

Each create supplies its provider, endpoint, model, WebSocket requirement and
hashed session identity to the same admission selector used by HTTP. Warm
selection uses the existing snapshot and coalesces counters into background
`/grant-pools/record`; it has no foreground KV read or `/grant-pools/select`.
A pinned request filters to its key before selection and checks revision or
lineage against both the snapshot and materialized grant. Missing, ineligible
or changed pinned grants return `409 upstream_grant_changed` (or the existing
continuation restart error), never a different account. First creates with a
continuation retain the resolved owner's pinned preparation path.

Before same-socket witnesses, warm rounds were `continuation`, then all reserve-dispatched legs concurrently
when present. Cache-off performs authoritative admission and selection first,
then `continuation + materialize`, then reserve-dispatched legs when present.
That warm reserve path took two rounds: continuation tool evidence
had to resolve before reserving. Soft `/status` reads run alongside send and add
no foreground round. These are causal scheduling proofs, not production timings.
No new cache or staleness bound is introduced; the shared fresh/max-age limits
and `CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS=0` authority behavior apply to every
create. Legacy grant projections retain the existing KV/selection fallback and
are outside this stored-credential table.

Ordinary HTTP reserve requests also combine the calls after all fallible
preparation. Fail-closed retention and account revalidation keep two-step
dispatch; so do durable background owners, Fusion synthesizer reservations,
transcription and realtime owners. Required WebSocket retention still runs
between reserve and dispatch. A crash between a combined call and send leaves a
dispatch-started receipt that is retained/conservatively settled at lease expiry
instead of refunded. This errs toward over-charge, never under-charge. A known
unsent failure or multi-leg denial still settles successful legs to zero.

## Zero-hop warm path (2026-10-23)

Directive: the router should add no measurable delay beyond the network path to
the provider; operations may be asynchronous and small tracking discrepancies are
acceptable. A warm proxy-key HTTP inference now performs **no foreground backend
call** (no Durable Object, KV or R2) before the upstream `fetch` on soft or
unbudgeted policies.

| Concern | Before | After |
| --- | --- | --- |
| Admission + grant selection | `/admission/resolve` on the global `policy-bindings` authority every request | Isolate snapshot (`worker/admission-cache.ts`): fresh 10 s, stale-while-revalidate to the 60 s max age, one single-flight background refresh |
| WebSocket create selection | Per-create KV bulk read → `/grant-pools/select` | Same operation snapshot selector as HTTP, constrained to the pinned key and qualified WebSocket transport; committed same-socket witnesses skip continuation lookup |
| Selection counters | Atomic SQLite update inside admission | Same shared strategy code (`chooseGrantKey`, `selectAdmissionCandidate`) on the snapshot; counters coalesced (25 ms) into one background `/grant-pools/record` |
| Credential materialization | `/materialize` on the per-grant owner every request | Isolate memory (`worker/credential-cache.ts`), keyed by grant + generation + revision, bounded by max age and the token refresh margin; upstream 401/403 evicts |
| Quota feedback | Background authority write | Also applied to this isolate's snapshot at once |
| Request retention | R2 put before dispatch, fail-closed | R2 put after dispatch in `waitUntil`, best-effort; background jobs and >8 MiB Claude bodies keep the fail-closed write |
| Soft budgets | Concurrent status + 50 ms post-header grace | Unchanged, plus a 10 s exhausted-scope verdict that denies before dispatch with no ledger call; new policies default to soft |
| Reserve budgets | reserve + dispatch | Combined reserve/dispatch when no fallible preparation remains; still authoritative and foreground |

Correctness boundaries:

- Every request hashes its secret and compares it with `safeEqual`; a mismatch
  re-asks the authority and never evicts the owner's entry. Only fully admitted
  outcomes are cached.
- Revocation, policy, owner, connection and pool changes reach a warm isolate
  within the max age (typically within 10 s under traffic). A mutation served by
  the same isolate (admin, session credentials, pool submissions, OAuth callback)
  clears that isolate's caches immediately. Failover after an upstream rejection
  always takes a fresh authoritative admission.
- Credentials stay in isolate memory only: never persisted, logged or returned.
- `CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS=0` restores per-request authority checks.
  `Server-Timing` reports `cr-cache;desc=hit|stale|miss|off`.
- Counters can drift slightly across isolates; least-used/round-robin/threshold
  remain per-isolate exact. Soft caps can overspend by in-flight work.

### Measured local comparison

Same harness and fixture as the soft-budget comparison below (100 measured
requests per cell, concurrency 1, 200 ms synthetic upstream, weekly window), now
also counting credential-owner calls and R2 operations
(`--retention on|off`, `--hot-cache on|off`). Foreground calls are per warm
request; local Durable Objects run in-process, so the latency columns understate
production round trips and are noisy (load average 45-65 during both runs).

| Policy | Foreground backend calls, before → after | Messages TTFB added p50 / p95 ms, before → after | Stream TTFB added p50 / p95 ms, before → after |
| --- | --- | --- | --- |
| Unbudgeted | 2 → 0 | 7.1 / 63.0 → 9.0 / 123.3 | 6.8 / 13.6 → 5.4 / 54.0 |
| Soft | 2 → 0 | 13.7 / 214.0 → 7.6 / 76.2 | 11.3 / 195.3 → 5.2 / 15.7 |
| Soft + retention | 3 → 0 | 20.4 / 124.9 → 8.4 / 80.5 | 12.8 / 32.4 → 6.3 / 71.7 |
| Reserve | 4 → 2 | 14.5 / 152.2 → 8.4 / 82.1 | 11.0 / 106.8 → 6.4 / 14.9 |
| Reserve + retention | 5 → 2 | 21.7 / 192.3 → 8.2 / 75.4 | 15.9 / 150.2 → 7.5 / 44.1 |

Per 100 requests the authority received 2-3 `/admission/resolve` (background
stale refreshes) instead of 100, and the credential owner 14-16 `/materialize`
(first use of each of the seven pooled grants plus background refreshes) instead
of 100. Every cell reconciled 100 selections and 100 usage events. The
deterministic proof is `worker/test/hot-path-cache.test.mjs`: a warm request
issues zero authority, credential-owner and KV calls before upstream, and local
selection matches the authority across all strategies and stickiness modes.
Raw reports: [hot-cache-local.json](performance/hot-cache-local.json).

### Production measurement (2026-10-24)

Live `clawrouter.openclaw.ai` on `165a53c` (hot cache deployed), from SJC, 40
sequential zero-cost `POST /v1/responses/input_tokens` requests per run with a
member key, three runs. Durations are the Worker's own `Server-Timing` values.

| Request | Count | `cr-admission` | Client total minus `cr-upstream-ttfb` |
| --- | ---: | ---: | ---: |
| Cache miss (per-request authority path) | 1 per run | 73 ms | ~485 ms (includes cold credential materialization) |
| Cache hit | 38 per run | 0.0 ms | 40-55 ms p50 |
| `/v1/health` (no backend work, network floor) | 20 | — | 30.5 ms p50 total |

Warm admission reports 0.0 ms because Workers timers advance only across I/O: a
hit performs no backend round trip. Upstream OpenAI time to headers was ~190 ms;
the remaining ~10-25 ms above the network floor is request/response transfer and
Worker CPU.

### Production monitoring (2026-10-24)

Seven minutes of `wrangler tail` on the live hot-cache build (`2473bdd3`) and 36
hours of per-version invocation analytics:

- About 180 inference requests produced 13 `/admission/resolve` and 12
  `/materialize` Durable Object calls: roughly a 93% hot-cache hit rate on real
  traffic. No warning or error logs.
- Compared with the previous version, hourly `loadShed` fell from 1-29 to about 2
  and `scriptThrewException` from 1-9 to 0-2.
- From 18:00Z, 13 hours after the deploy and with no version change, client
  disconnects rose to 15% and then 46% of requests. 139 of 140 sampled cancels
  were non-streaming `/v1/responses` calls (200-750 KB bodies) from one client
  population (`OpenAI/JS 7.35.0`, a single ISP network) that disconnected 1.0-1.7 s
  after sending, before any response. This is client behavior, not a router
  regression; `pnpm cf:health-report` now shows this distinction directly.
- Discovery remains the slowest warm path on that build: `/v1/models` and
  `/v1/catalog` took about 212 ms against a 28 ms network floor. The per-key
  discovery reuse from #327 removes those backend reads once deployed.
- Router CPU before dispatch is small: an in-process chat request with a 600 KB
  history costs 2.6 ms p50 (1.1 ms at 200 KB). Responses CPU in the tail
  (162 ms p50 for completed requests) is spent after headers, in delivery
  inspection and accounting.

### Background drain bound (2026-10-25)

A 15-minute production tail on `cab719cc` (1,947 events, no exceptions or 5xx)
showed three requests logging `waitUntil() tasks did not complete within the
allowed time after invocation end and have been cancelled`, each with 30-37 s of
wall time. When that limit hits, Cloudflare cancels every remaining task of the
request, including its usage accounting and settlement.

The Worker entry handed the whole global set of pending background work (stale
refreshes, colo publishes, counter flushes) to each request's `waitUntil`,
including work owned by other requests. If such work never settles in the
draining request's context (for example after its owner's client disconnected),
the 25 s bound inside `runInBackground` does not help either, because that timer
also belongs to the owning request. A request now drains only work registered
after its own entry (`backgroundMark`) and races it against a 10 s timer created
in its own context (`DRAIN_BOUND_MS`), so it can no longer reach the platform
limit through someone else's work.

### Production check of the colo layer and burst coalescing (2026-10-24)

On `f8d67e89` (#334), one warm-up request followed by three waves of ten
requests over fresh connections from SJC returned 22 isolate hits, 4 stale hits
and 4 `cr-cache;desc=colo` adoptions at 6 ms median admission (10 ms max), with
no authority calls after the warm-up. A cold isolate that previously paid ~91 ms
now adopts its neighbour's snapshot.

The same probe exposed a burst gap: twelve simultaneous cold requests for one
key made twelve authority calls. Concurrent foreground misses for a key now share
the first request's authority admission; the others wait for its snapshot,
re-verify their own secret and select locally, reporting `cr-cache;desc=joined`.
A wrong secret or an uncacheable leader result sends the follower to the
authority itself, and failover never joins.

The first version of this awaited the leader's promise and failed the workerd
revocation-under-load test with hundreds of HTTP 500s:
`Cannot perform I/O on behalf of a different request (I/O type:
ReadableStreamSource)`. Workers resume the code after `await promise` in the I/O
context of the request that resolved it, so the follower's upstream fetch and
response stream belonged to the leader's request. The credential cache's
existing single-flight (`HotCache.load`) had the same shape; it did not fail
locally only because in-process credential loads finish too quickly to overlap.
No request may await another request's promise: waiters poll the shared entry
or a settled flag on their own timers (`waitForOtherRequest`, bounded at 5 s)
and fall back to their own call.

### Per-location snapshot sharing (2026-10-24)

A live tail during light traffic showed 13 `/admission/resolve` calls for about
17 inference requests: Cloudflare spreads sparse traffic across many isolates,
and each cold isolate paid the 78-102 ms admission round trip. Admission
snapshots now also go to a per-location Workers Cache API layer
(`worker/colo-cache.ts`). On a local miss, an isolate first checks that layer
(single-digit milliseconds) and adopts a snapshot another isolate in the same
location fetched, before calling the authority.

- Only the secretless admission snapshot is shared (policy, owner, connection,
  pool routing projections, the key's secret digest). Upstream credentials stay
  in isolate memory.
- An adopted entry keeps its original fetch time: the 10 s fresh window and 60 s
  max age are measured from the authority fetch, so staleness bounds are
  unchanged. The request's secret must match through the same `cacheable` check.
- A mutation served by an isolate fences that isolate against shared entries
  fetched at or before the mutation, so its own changes still apply immediately.
  Other isolates converge within the max age, as before.
- Failover, the disabled knob (`CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS=0`) and
  Cache API errors all fall through to the authority.

### Verified in production (2026-10-24)

`68377baf` (`50717c7`, #326-#332) rolled out through the full canary train on
the first attempt after the read-lag fix. Measured from SJC with a member key:

| Path (warm) | `2473bdd3` (#326 only) | `68377baf` |
| --- | ---: | ---: |
| `/v1/models` | ~212 ms | 19.6 ms |
| `/v1/catalog` | ~215 ms | 28.8 ms |
| Count request, total minus upstream | ~33 ms | ~32 ms |
| `/v1/health` network floor | 28 ms | 25 ms |

38 of 40 count requests were hot-cache hits with 0.0 ms admission. A two-minute
tail of real traffic on `68377baf` showed no exceptions or warning/error logs,
and `pnpm cf:health-report` showed about 0.1% failures per hour on the new
versions.

### Cold-miss overlap (2026-10-24)

Correction after deploying `68377baf`: the first measurement below
misattributed client connection setup to the credential owner. Spaced requests
(70 s apart, past the 60 s max age) showed `cr-admission` 76-167 ms plus
128-263 ms outside admission and upstream, against 33-60 ms on the next warm
request. Repeating them with a `/v1/health` call immediately before each cold
request (which itself took 83-411 ms to re-establish the client's TLS
connection) left cold and warm requests with the same remaining time (47-142 ms
vs 31-214 ms). For that key, whose OpenAI pool has no credential-owner grant and
reports no `cr-credential`, a cold miss costs only the admission round trip,
78-102 ms. Pools with owner-held grants also pay the owner round trip on a cold
isolate, which the change below overlaps with admission.

On a foreground admission miss the isolate now starts materializing the grant it
last selected for the same key, provider, endpoint, mode and model, keyed by that
grant's generation and revision. If admission selects the same version, the real
lookup joins the in-flight load; otherwise the prefetched entry is unused. The
hint is secretless routing data and only the secret digest that earned it can
start an owner call. Staleness bounds are unchanged. `Server-Timing` now carries
`cr-credential;dur=<owner wait>;desc=hit|stale|miss|off`.

### Stress and hardening (2026-10-23)

Concurrency sweep on the same fixture (400 requests per cell, 20 ms synthetic
upstream, soft weekly budget, retention on), hot cache off vs on in one build:

| Scenario | Concurrency | TTFB p50 / p95 ms, off → on | Throughput req/s, off → on |
| --- | ---: | --- | --- |
| count | 50 | 168 / 208 → 122 / 138 | 291 → 401 |
| count | 200 | 646 / 892 → 393 / 516 | 257 → 470 |
| messages | 50 | 206 / 271 → 121 / 141 | 236 → 411 |
| messages | 200 | 696 / 952 → 443 / 587 | 261 → 366 |
| stream | 50 | 135 / 368 → 80 / 227 | 181 → 288 |
| stream | 200 | 635 / 814 → 353 / 607 | 158 → 333 |

Every cell reconciled selections, usage and upstream dispatches exactly. Cache-on
cells issued 0-1 foreground `/admission/resolve` and 2-5 `/materialize` per 400
requests. Findings and changes:

- Quota feedback was still one global-authority write per request. It is now
  merged per grant (`mergeGrantRuntimeState`) and flushed with the selection
  counters every 250 ms: 400 → 14-57 feedback writes and 2-9 counter writes per
  400 requests in the follow-up sweep. With the hot cache disabled feedback is
  written per response, as before.
- Catalog and model lists stayed CPU/KV-bound with zero authority calls. The
  derived per-key inventory (health, grant eligibility, balances) is now reused
  within the hot-cache bounds, keyed by the full authorized identity and policy.
- Background work is bounded at 25 s so a hung backend call leaves the pending
  set instead of extending every later request's `waitUntil`.
- The harness now waits for asynchronous selection counters to converge before
  reconciling them.
- Mid-stream aborts at concurrency 200 produced occasional client `ECONNRESET`
  (0-57 per 400) only with the faster cache-on router. Instrumented runs showed
  every request that reached the Worker returned 200 and none threw; the resets
  are local workerd/loopback socket churn under mass client aborts, not router
  failures.
- `test/hot-cache-revocation-workerd.test.mjs` runs 16 concurrent clients
  (~2,000 req/s locally) against the real Worker and SQLite authority, disables
  the policy at the authority mid-load and requires every request to be denied
  after the max age. With a 4 s max age, successes stopped 2.94-2.96 s after
  revocation across three runs, with no 5xx.
- Pools whose grants still carry legacy (KV-only) projections take the
  authority read-and-select path. The first such request now asks the grant's
  credential owner to republish its routing projection (`/reconcile`, at most
  once per grant per 10 minutes per isolate, only with the hot cache enabled), so
  the pool joins the local hot path on a later admission.

Interleaved A/B against the landed hot path (three alternating rounds per side,
concurrency 50, 400 requests per cell, medians; all cells reconciled with zero
errors):

| Scenario | TTFB p50 / p95 ms, before → after | Throughput req/s | Feedback writes per 400 |
| --- | --- | --- | --- |
| catalog | 107 / 162 → 12 / 22 | 450 → 3,341 | 0 → 0 |
| messages | 168 / 481 → 184 / 440 | 247 → 207 | 400 → 21-54 |
| stream | 98 / 237 → 87 / 135 | 206 → 341 | 400 → 28-43 |

Messages differences are within this host's run-to-run noise; the deterministic
change there is the 10x drop in global-authority writes.


## Soft-budget instrumentation (2026-10-18)

Ordinary proxied HTTP inference exposes three `Server-Timing` durations in
milliseconds, with no identities or request content:

| Metric | Interval |
| --- | --- |
| `cr-admission` | Authentication/admission, including policy and owner resolution; Access sessions also include their existing policy selection |
| `cr-budget` | Foreground budget wait: reserve/dispatch time in reserve mode; only the post-header wait in soft mode, normally zero |
| `cr-upstream-ttfb` | Initial upstream dispatch to final selected upstream headers, including any rejected attempt and failover |

Soft mode starts all configured ledger observations concurrently with upstream
fetch. It waits at most **50 ms** after final upstream headers if those reads
remain pending; errors and timeouts fail open. The timing does not include
response-body generation or the later asynchronous charge. Credential
materialization, required content retention and continuation publication retain
their existing ordering; these metrics are not a complete partition of request
time. See [soft-budget semantics and reserve-only paths](agent-spend-control.md#soft-budgets-and-dynamic-caps).

### Measured local comparison

Sequential cells on the same checkout, 100 measured Messages requests per cell,
concurrency 1, seven subscription owners, 70 sessions, `max_tokens=16`, and a
fixed **200 ms** artificial upstream TTFB. Seven warm-up requests precede each
cell. Added latency is end-to-end total minus that 200 ms delay; it includes
loopback transport, response processing, scheduling and local SQLite work.

```sh
pnpm loadtest:local --requests 100 --concurrency 1 --delay-ms 200 \
  --max-tokens 16 --scenarios messages --budget-window weekly \
  --budget-mode soft --out soft-budget-soft-local.json
```

Repeat with `--budget-mode none` and `--budget-mode reserve` for the other cells.

| Policy | Added p50 (ms) | Added p95 (ms) | Ledger calls per measured request |
| --- | ---: | ---: | --- |
| Unbudgeted | 28.2 | 389.5 | None |
| Reserve, weekly window | 47.9 | 485.2 | 1 reserve + 1 dispatch + 1 settle |
| Soft, weekly window | 40.1 | 410.4 | 1 concurrent status + 1 off-response charge |

All 300 requests returned 200 with zero unexpected errors. Each cell reconciled
100 selections, 100 upstream requests and 100 persisted usage events, with one
foreground admission per request. Soft had no reserve/dispatch calls. Raw
reports: [unbudgeted](performance/soft-budget-none-local.json),
[reserve](performance/soft-budget-reserve-local.json),
[soft](performance/soft-budget-soft-local.json).

Soft removed the foreground budget RPCs and its tail was close to unbudgeted
in this sample. This is **not an idle-host or production speedup claim**:
the shared host's load averages were 89.58 / 93.50 / 95.63 near completion,
and the hundreds-of-milliseconds tail exceeds the budget protocol work itself.
The task's browser suite was stopped before measurement; unrelated host work
remained. Use the timing headers and repeat this fixture on a quiet host or an
approved synthetic edge deployment to isolate the network savings.

The [combined admission follow-up](#combined-admission-follow-up-2026-10-11)
implements the first finding and part of findings 3/6. The original review and
measurements below remain as historical evidence; the follow-up records current
RPC counts, parity coverage and the new before/after measurements.

Review base: `6e26587` (PR #267, following #266). No edge deployment or live
provider traffic. The load fixture uses synthetic credentials and intercepts
**all** outbound provider requests in a second workerd service.

## Ranked findings

| Rank | Finding and evidence | Minimal proposal | Disposition |
| --- | --- | --- | --- |
| 1 | Five sequential authority calls for a warmed, unowned service-key inference all land on `ACCESS_CONTROL.idFromName("policy-bindings")`: credential, policy, connection, pool resolution, selection. `worker/authority.ts:747`, `worker/proxy-auth.ts:12`, `worker/proxy.ts:415`, `worker/grant-selection.ts:165`, `worker/grant-selection.ts:142`. Selection writes are global traffic even for unrelated tenants. | Design a canonical request-admission RPC to reduce network hops, or partition authority by ownership with a documented revocation fence. Neither is a safe caching change. | **Design change; not implemented.** Preserve authority semantics. |
| 2 | Credential materialization is serialized by a Promise tail per full grant key (`worker/grant-credentials.ts:107`, `:153`, `:274`). A refresh/repair/maintenance operation holds that same tail, including network I/O. Seven grants provide at most seven independent credential-owner lanes; sticky sessions can concentrate on one. | Separate maintenance I/O from admission only with a generation/CAS design and explicit revocation/rotation guarantees. Measure per-owner queue wait on edge first. | **Design change; not implemented.** |
| 3 | Every selected attempt writes `upstream_grant_selection` and reads its count back (`worker/authority.ts:543`). Quota response feedback writes JSON to `upstream_grant_runtime` in the same global object (`:488`). Selection happens even before a later budget denial. | Keep selection and authoritative strategy counters atomic. Consider splitting advisory statistics from selection state and coalescing compatible runtime observations, with freshness/revision rules. | **Design change; not implemented.** Do not defer `recordSelection` blindly: least-used/round-robin/threshold depend on state. |
| 4 | A budgeted inference reserves then marks dispatch on a shared policy/principal ledger; a provider budget adds a second shared ledger (`worker/accounting.ts:71`, `:113`). Settlement competes with later admissions. Budget `maintain()` runs on every RPC (`worker/ledgers.ts:29`). | Profile SQL and ledger queue wait; investigate bounded maintenance work. Sharding balances, parallel reservation with rollback, or removing dispatch changes financial authority. | **Design change; not implemented.** |
| 5 | Top-level request-field renaming deep-cloned the whole prompt/tool tree (`worker/providers.ts:275`). Native Anthropic and OpenAI-compatible registered models both take this path. | Copy only the top-level object; nested payloads are read-only and renames only write/delete top-level properties. | **Fix now; implemented and tested.** No schema or protocol change. |
| 6 | Discovery rebuilds provider/model/offer projections per request (`worker/discovery.ts:232`). Pool status scans both KV prefixes, reads runtime/statistics, then aggregates seven days of usage (`worker/pool.ts:34`, `:45`, `:59`). These are much more than static catalog reads. | Profile projection CPU; consider a versioned public/catalog projection cache and separate expensive usage reporting, while keeping caller eligibility current. | **Design change; not implemented.** No authorization-result cache added. |
| 7 | The usage queue consumer awaits each message serially (`worker/ledgers.ts:266`); each event causes a SQLite insert and cleanup in a policy usage shard (`:151`). Reporting can lag while delivery succeeds. | Evaluate bounded parallel ingestion across independent shards and batch SQL within a shard, retaining per-message receipt/retry/idempotency semantics. | **Design change; not implemented.** |

The global authority is a structural concentration point, not proof of a specific
edge throughput ceiling. Local latency includes workerd scheduling, host load,
loopback sockets, local SQLite persistence and the load generator itself. The
stress results below are end-to-end symptoms, not per-DO timing attribution.

## Request trace and I/O inventory

For native `POST /v1/messages`, `worker/index.ts:109` dispatches to
`proxyNative` (`worker/proxy.ts:204`). The same entry supports streaming and
non-streaming. For an OpenAI-compatible `POST /v1/chat/completions`,
`worker/index.ts:108` dispatches to `proxyOpenAi` (`worker/proxy.ts:65`), then
`concreteOpenAiSelection` (`worker/proxy-selection.ts:33`). An Anthropic model
is not automatically converted to OpenAI chat: the route must support the
requested capability and unified path. Both paths converge on `proxySelected`.

| Step | Calls, work and serialization | First-byte effect |
| --- | --- | --- |
| Ingress/correlation | `worker/index.ts:42`, `worker/correlation.ts:62`: validate attribution; generate request ID using cryptographic randomness when absent. No DO/KV. | Synchronous validation. |
| Proxy authentication | `worker/proxy-auth.ts:9`: authority `/credentials/resolve`, SHA-256 of supplied secret plus constant-time digest comparison, then `/policies/resolve`; optional `/users/resolve` for a principal-owned key. All authority calls use global `policy-bindings`. Small JSON RPC bodies/responses. | Sequential; identity must be established. Credential lookup and digest computation could overlap, but was not changed because this is authentication code. |
| Migration edge cases | `worker/authority.ts:792-827`: missing records before a family's global initialization marker cause KV reads, optional initialize writes and canonical rereads. Missing connection before its marker can repeat KV fallback/reread. | Cold/uninitialized counts exceed the warmed counts below. Never cache away canonical revocation. |
| Body/classification | `worker/utils.ts:141`: bounded 8 MiB body read, UTF-8 decode and one full JSON parse. Native prepares the registered/passthrough model; unified OpenAI rewrites the upstream model. `worker/proxy-selection.ts:61`, `worker/providers.ts:275`: top-level transformation; formerly a full `structuredClone`. | Body fully read before provider work. |
| Allowlist/connection | `worker/policy-models.ts:7`, `worker/proxy.ts:413`: local model allowlist and provider check, then authority `/connections/resolve`. No model-allowlist I/O. | Awaited before credential selection. |
| Sticky selection | `worker/proxy.ts:464`: one SHA-256 of session/identity when enabled. Authority `/grant-pools/resolve` returns scoped membership **and runtime state together**. One bulk KV JSON get for two default keys plus members (nine unique keys for seven differently named grants). Local filters enforce eligibility, cooldown, reserve, model-scoped quota, stale-state rule, priority and transport. | Connection, sticky digest, pool RPC, KV get and selection RPC are sequential. No separate runtime-state RPC is needed here. |
| Atomic choice/statistics | `worker/grant-selection.ts:142`, `worker/authority.ts:506`: `/grant-pools/select` selects and increments a SQLite counter in the global object. Session stickiness uses deterministic `stickyScore`, not a persistent session map; it takes precedence over ranking among eligible candidates. `recordSelection` is a boolean controlling this call, **not a second RPC**. | Awaited before materialization. Strategy/state ownership must stay intact. |
| Credential owner | `worker/providers.ts:348`, `worker/grant-credentials.ts:704`: `/materialize` on `GRANT_CREDENTIALS.idFromName(full oauth key)`, e.g. `oauth/<policy>/<ref>` or `oauth/tenants/<tenant>/<ref>`. Normal canonical owner does one storage get and no KV write. | Per-grant tail is awaited. Expiring credentials add a provider refresh, durable writes/alarm work and projection publication. Dirty ownership repair adds global attachment/publish RPCs; stale KV generations can cause repeated projection writes (KV's per-key write limit matters). |
| Encode/cost | `worker/proxy.ts:438`: JSON stringify of transformed outbound body. Subscription system blocks are prepended through a shallow top-level copy (`worker/provider-auth.ts:111`). Token pricing may stringify the body again to estimate UTF-8 input (`worker/pricing.ts:101`); fixed policy price bypasses that estimate. No SigV4 crypto for Anthropic/OpenAI; the shared signing function is a no-op for them. | Full-body encode(s) before fetch. No proposed reuse of pricing/transport bytes: their inputs differ. |
| Budget | `worker/accounting.ts:71`: zero, one, or two `/reserve` RPCs, sequential when both policy and provider limits apply, with rollback on the second failure. Policy object is `<tenant>:<policy>[:<principal>]`; provider object is `provider:<provider>`. Month is a row/window key, not the object name (`worker/budget-scope.ts:12`). | Mandatory preflight. Count-tokens skips monetary reservation. |
| Retention/dispatch | `worker/content-retention.ts:24`: if enabled, full JSON serialization and one R2 put, fail-closed; no cleanup DO on each request. `worker/accounting.ts:113`: `/dispatch` to every reservation object in parallel. Fixture disables retention. | Both complete before fetch. Retention could theoretically overlap independent preparation, but starting it earlier changes failure/retention behavior; not changed. |
| Upstream | `worker/proxy.ts:310`: one fetch; same-provider failover permits at most one alternate for qualified 401/403/429. Retry redoes pool/KV/selection/materialization and body/signing, reuses resolved connection/reservation. | Remote provider header/body latency dominates normal calls. |
| Quota feedback | `worker/proxy.ts:458`: normalize headers and `waitUntil(/grant-pools/feedback)` to global authority. Small sanitized runtime JSON; SQLite upsert. One call per applicable attempt, not one per token. | Already background; do not claim moving it is a new optimization. Competes with other authority traffic. |
| SSE first event | `worker/proxy-response.ts:117`: streaming requests sniff up to the first meaningful complete SSE event (bounded 8 KiB) to normalize errors, then replay bytes. | Intentionally delays response headers/first wire byte until an event. First content delta can arrive later than message_start. Removing sniffing changes error behavior. |
| Delivery/usage | `worker/proxy-response.ts:23`: a single backpressured reader observes delivery, without clone/tee or eager drain. JSON inspection and SSE frames bounded at 2 MiB. Nonstream JSON parsed at EOF; SSE usage extracted incrementally. Abort signal/cancel ends observation and retains conservative cost without authoritative terminal usage. | Per-chunk CPU; no extra DO/KV for ordinary messages/chat. Responses-continuation publication is a separate path. |
| Accounting | `worker/proxy.ts:370`, `worker/proxy-accounting.ts:94`, `worker/accounting.ts:99`: after observed delivery, waitUntil independently settles budget and publishes one event. `/settle` per reservation; one queue send, fallback to direct ingest on send failure. Consumer `/ingest` on `USAGE_LEDGER` `policy:<tenant>:<policy>` (`worker/usage-sharding.ts:18`); no principal sharding here. | Already off first-byte path. Queue retry can add calls; not counted as normal traffic. |

Warmed success estimate (service key without principal, one scoped grant, no
refresh/failover/retention): **8 foreground backend calls** without budgets
(5 global authority + 1 credential DO + 1 bulk KV + 1 upstream). Each budget leg
adds reserve + dispatch, so a policy-budgeted message has **10 foreground calls**.
Quota feedback, queue send, queued usage ingestion and one settlement bring that
to **14 total backend operations across both invocations**. Some quota-free
responses omit feedback. Two budget legs give 12 foreground / 17 total; a
principal-owned key adds one global read. R2 retention adds one. KV bulk is one
API call reading nine records here, not nine round trips. This is a code-derived
inventory, not a Cloudflare billing/subrequest-limit claim; platform accounting
for internal service/DO/KV/queue operations differs.

The measured count route has 8 foreground / 11 total with quota feedback and
usage queue/ingest, but no reserve, dispatch or settle. An environment fallback
avoids materialization/feedback. Retry adds pool resolve + KV + select + owner +
fetch, plus feedback for the extra attempt; it does not reserve again.

Besides the secret/session SHA-256 operations, `crypto.randomUUID()` creates
the request ID (when absent), one usage-event ID, one reservation ID per budget
leg and an optional retained-content ID. A new credential lineage uses a UUID
only on ownership creation/replacement, not steady materialization. Weighted
random selection uses `crypto.getRandomValues`; the measured sticky strategy
instead scores candidates with a noncryptographic hash of the private digest.

## Load generator

Node 22+; no new dependencies. The workspace still requires its existing Node
24+ runtime for Worker tests. Use an existing protected key file; never put a
bearer key in the shell command or environment output:

```sh
pnpm loadtest --base-url https://router.example \
  --key-file /secure/clawrouter.key --scenario stream \
  --model anthropic/claude-sonnet-5 --concurrency 50 --requests 1000 \
  --session-spread 70 --max-tokens 32 --timeout-ms 30000 \
  --abort-fraction 0.1 --json-out /tmp/load-results.json
```

Scenarios: `catalog`, `pool`, `count`, `messages`, `stream`, `mixed` (round-robin
across the five). `--duration` is seconds and excludes new admissions after the
deadline, while in-flight requests drain subject to timeout. It is mutually
exclusive with `--requests`. `--rps` schedules open-loop opportunities; when the
concurrency ceiling is full the opportunity is **dropped and counted**, not
silently queued. `--requests` then counts offered opportunities. Throughput is
completed requests divided by elapsed time including drain. No RPS cap means a
closed-loop concurrency test. There are no automatic request retries.

Each JSON row contains status/error code, total latency, first wire-byte time,
TTFB (SSE **first content_block_delta**, otherwise first byte), lane,
grant/failover headers and request ID. Missing TTFB remains null. Cancellation is
chosen once, after the first nonempty wire chunk, and appears separately as
`intentional_abort`; it is not included in the unexpected-error count. Reported
percentiles are nearest rank. JSON output is exclusive-create, mode 0600; the key
path, bearer value, prompt and response bodies are omitted. Redirects are not
followed. A mode other than exactly 0600, symlink or oversized key file fails.

Received SSE error codes remain errors even when an intentional abort was
requested. Non-aborted streams must contain `message_stop`; a normal socket EOF
after a delta alone is reported as `incomplete_stream`. A successful response
with a non-SSE media type is `unexpected_content_type`, with null delta TTFB.
A duration/RPS run keeps
its full measurement window even when the next scheduled request falls beyond
the deadline.

Current responses expose lane and failover, **not grant identity**. The CLI says
that it cannot establish stickiness from a lane. The local fixture additionally
joins the latest 100 accounting events to returned request IDs to inspect a
bounded sample of session-to-grant consistency, without changing response headers.

## Local stress method

```sh
pnpm loadtest:local --requests 200 --concurrency 10,50,100,200 \
  --delay-ms 20 --out /tmp/local-load.json
```

`--scenarios` can also include `pool`. The fixture uses the repository's locked
Miniflare/workerd bundler and DO classes, seven subscription credential owners,
`most_remaining`, 70 sessions, an exact model allowlist, 10% included reserve,
explicit environment fallback and a generous policy budget with fixed one-micro
request pricing. Retention/maintenance/refresh are disabled. The fake emits
message_start immediately, content delta after 20 ms and terminal usage after a
further 40 ms. Nonstream and count responses wait 20 ms. Quota headers carry
synthetic 90% headroom. It does not exercise live OAuth or spend money.

The stress fixture overrides the shared helper's original 1-message/immediate
queue configuration with production's **50-message/5-second** batching. Every
cell warms seven requests and drains warmup accounting first. Queue lag is
observed as sent requests minus persisted usage, not a real queue-depth API.
The latest fixture compares bookkeeping with observed upstream dispatches:
requests reset before ingress have no usage obligation. Every error remains in
the status/error histograms; it is never retried or hidden.

The first exploratory 400-request run used the helper default, stopped after a
15-second drain cutoff, and overlapped validation later in its lifetime. It is
not used as comparative evidence. It did reveal why immediate single-message
batches and undrained warmup are poor benchmark defaults. The final paired
sweeps use 200 requests/cell and isolated before/after worker bundles. This is a
short concurrency sweep, not a sustained capacity qualification; p99 at 200
samples represents only two tail observations.

Results are **before / after**; latency in ms, throughput in completed requests/s.
TTFB for streams means first content delta. “Added” subtracts the configured
20 ms fake delay and is an upper estimate including local scheduling and I/O,
not an isolated router CPU measurement. Catalog has no upstream delay; abort
TTFB samples exclude streams canceled before any delta.

| Scenario | Concurrency | TTFB p50 | TTFB p95 | Total p50 | Added p50 | Throughput | Unexpected errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| catalog | 10 | 30 / 39 | 40 / 63 | 30 / 40 | — | 312.5 / 228.2 | 0 / 0 |
| catalog | 50 | 166 / 239 | 204 / 408 | 167 / 243 | — | 289.4 / 178.4 | 0 / 0 |
| catalog | 100 | 1240 / 664 | 1407 / 707 | 1240 / 665 | — | 78.5 / 147.0 | 0 / 0 |
| catalog | 200 | 2363 / 2505 | 2364 / 2512 | 2366 / 2514 | — | 84.4 / 79.0 | 0 / 0 |
| count | 10 | 73 / 103 | 662 / 172 | 78 / 103 | 53 / 83 | 62.3 / 90.7 | 0 / 0 |
| count | 50 | 343 / 309 | 737 / 602 | 344 / 313 | 323 / 289 | 124.2 / 121.2 | 0 / 0 |
| count | 100 | 417 / 363 | 510 / 811 | 418 / 366 | 397 / 343 | 235.4 / 176.7 | 0 / 0 |
| count | 200 | 2432 / 1270 | 3756 / 1616 | 2435 / 1288 | 2412 / 1250 | 53.1 / 123.3 | 33 / 38 |
| messages | 10 | 180 / 92 | 442 / 165 | 182 / 93 | 160 / 72 | 47.9 / 95.4 | 0 / 0 |
| messages | 50 | 1082 / 582 | 1384 / 1407 | 1083 / 584 | 1062 / 562 | 47.6 / 62.7 | 0 / 0 |
| messages | 100 | 704 / 638 | 830 / 1325 | 705 / 638 | 684 / 618 | 140.8 / 95.4 | 0 / 0 |
| messages | 200 | 1144 / 1149 | 1146 / 1434 | 1148 / 1152 | 1124 / 1129 | 142.0 / 139.0 | 0 / 0 |
| stream | 10 | 221 / 115 | 1128 / 346 | 287 / 186 | 201 / 95 | 20.7 / 43.3 | 0 / 0 |
| stream | 50 | 355 / 500 | 589 / 762 | 409 / 678 | 335 / 480 | 104.3 / 63.8 | 0 / 0 |
| stream | 100 | 669 / 863 | 1895 / 6563 | 747 / 1185 | 649 / 843 | 58.1 / 25.5 | 0 / 0 |
| stream | 200 | 2138 / 2084 | 2146 / 2087 | 2357 / 2101 | 2118 / 2064 | 84.7 / 91.6 | 27 / 0 |
| abort | 10 | 271 / 102 | 925 / 176 | 282 / 115 | — | 28.8 / 83.8 | 0 / 0 |
| abort | 50 | 422 / 606 | 512 / 1947 | 432 / 786 | — | 108.8 / 45.0 | 0 / 0 |
| abort | 100 | 975 / 727 | 2344 / 1856 | 1287 / 890 | — | 52.4 / 73.2 | 0 / 0 |
| abort | 200 | 1354 / 2987 | 1354 / 2990 | 1316 / 3419 | — | 50.9 / 51.0 | 0 / 0 |

No unexpected errors through concurrency 100. At concurrency 200, baseline
count had 33 and stream had 27 `ECONNRESET` failures; after count had 38. All
were status-less, request-ID-less client transport failures. This supports a
loopback ingress/accept-limit hypothesis, not a proven router exception. Both
programs deliberately exited nonzero to preserve the failures. The baseline
also used the older attempted-count expectation and waited 60 seconds in those
two cells; the current harness compares against actual synthetic dispatches.
No error/exception diagnostics appeared in either captured workerd log.

Across measured inference cells, selection, usage and synthetic upstream counts
matched exactly: **3140 before / 3162 after**. Catalog made no provider
calls, selections or usage records. All seven grants had quota windows. The
latest-100-event sample in each inference cell reported zero multi-grant sessions.
This is bounded evidence, not a whole-run history or an atomic quota-reservation
proof. Non-aborted message samples retained 12 input / 4 output tokens per event.
Count-token events intentionally carry no billable usage tokens.

| Observation | Before | After |
| --- | ---: | ---: |
| Maximum sampled workerd RSS (MiB) | 780.8 | 811.2 |
| Maximum sampled workerd CPU (%) | 95.3 | 88.5 |
| Maximum initially unpersisted usage events after delivery | 197 | 147 |
| Intentional aborts, all four cells | 393 | 392 |

For cells without ingress loss, baseline drain observation was at most 4736 ms; after
was at most 5446 ms. This includes polling and reporting latency, not solely queue
processing. The 60-second baseline cutoffs are not evidence of lost accounting: the
actual dispatch counts had already matched. Raw percentiles, histograms, counts,
CPU/RSS samples and drain observations are in
[local-load-results.json](performance/local-load-results.json).

Client aborts do not necessarily prevent provider completion: buffering can let
terminal usage arrive before cancellation is observed. Accounting retained both
successful and client-error outcomes accordingly. The fake upstream
ReadableStream cancel callback was not invoked reliably by local workerd, so its
`canceled: 0` counter does not prove upstream work stopped; downstream abort and
accounting observations are the supported evidence.



## Safe change and verification

`worker/providers.ts` now copies only the request's top-level object before
renaming fields. Frozen nested messages and tool definitions are shared read-only;
the caller's top-level object stays unchanged. The regression covers a 256 KiB
prompt, frozen nested data, applied renames and an untouched native request. No
authority checks, budget semantics, storage formats or protocols changed.

A local seven-round microbenchmark of 1,000 Anthropic request transformations
with a 256 KiB prompt measured before `[122.87, 87.50, 72.01, 36.52, 55.19, 40.17,
55.85]` ms and after `[0.258, 0.180, 0.167, 0.143, 3.492, 0.067, 0.079]` ms.
Median **55.85 → 0.167 ms per 1,000 transformations**. This is an allocation/CPU
improvement, not evidence of equivalent end-to-end acceleration. The default
short-prompt stress sweep is dominated by scheduling, I/O and contention.

Reproduce the isolated transform comparison on the current checkout (the
Anthropic adapter has no rename rules, so `structuredClone(body)` is the prior
implementation's full-body work):

```sh
node --import ./worker/test/typescript-setup.mjs --input-type=module <<'JS'
import { transformRequestBody, providerById } from './worker/providers.ts';
const body = { model: 'fixture', messages: [{ role: 'user', content: 'x'.repeat(262144) }] };
const provider = providerById('anthropic');
for (const [name, transform] of [
  ['before-copy', () => structuredClone(body)],
  ['after-transform', () => transformRequestBody(provider, '/v1/messages', 'fixture', body, {})],
]) {
  for (let i = 0; i < 100; i++) transform();
  const rounds = [];
  for (let r = 0; r < 7; r++) {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) transform();
    rounds.push(performance.now() - start);
  }
  console.log(name, rounds);
}
JS
```

Validation tails:

```text
pnpm check                         exit 0
Worker: tests 1223, pass 1223, fail 0
Admin:  tests 224,  pass 224,  fail 0
Scripts: tests 361, pass 343, fail 0, skipped 18

pnpm worker:e2e                    exit 0
local Worker smoke passed
Responses WebSocket workerd fixture passed
contentCleanup: ok

focused native/transform/model tests: tests 26, pass 26, fail 0
load generator helper/HTTP tests:     tests 6, pass 6, fail 0
```

The first validation run overlapped the exploratory stress run: an existing
liveness timing assertion and the local smoke's expected budget-denial status
failed under that load. The liveness test passed alone (15/15), the complete
check passed on retry, and the complete e2e chain passed on its separate retry.
E2e includes intentional recovery/failed-accounting diagnostics; its passing
outcome is not a claim of silent logs for those fault-injection fixtures.
The final load-generator HTTP regressions cover preservation of SSE errors on
both 2xx and non-2xx responses, errors concurrent with requested aborts, premature
EOF, and low-RPS duration windows. Independent autoreview identified the abort
error masking, premature-EOF and non-SSE response gaps; all were corrected. All provider
manifests also passed an explicit compile/validation run.
The corrected harness then passed another local 20-stream / 20-abort-scenario
smoke: zero unexpected errors, nine intentional aborts, and exactly 20 selection
and usage records in each cell. The full paired matrix is unchanged by these
error-detection fixes: its successful fake streams all emitted terminal events.


## Remaining risks / edge-only questions

- Real authority/credential/budget DO placement and inter-colo round-trip tails;
  isolate CPU saturation, queue admission limits and storage input/output gates.
- The per-grant stall during real refresh, projection repair, stale KV generations,
  token rotation and simultaneous revocation. Those semantic changes were deferred.
- Long-lived streams, slow consumers, larger prompts/tool trees, scoped quota
  exhaustion and fallback/failover under real headers. The fixture enables the
  policies but does not exhaust quota or perform OAuth refresh.
- Production queue backlog/retry/dead-letter behavior and reporting contention
  across many policies. Local batches use production size/timeout, not distributed
  queue infrastructure or the production DLQ.
- Physical memory numbers include the single workerd process serving router,
  upstream and local services. They are not Worker isolate heap measurements.
  Process %CPU is an OS sample, not per-request CPU, and other host workloads can
  perturb both paired sweeps. No exact DO queue-time or per-method timing was
  instrumented, so attribution remains a code-backed hypothesis.

No claim that removing any authority or budget call is safe follows from these
numbers. The next useful live test is the same capped workload with per-stage
spans, DO location/queue timing, isolate CPU and queue depth, against a dedicated
synthetic edge deployment approved separately.

## Combined admission follow-up (2026-10-11)

The round-trip reduction is implemented on `perf/hot-path-load-harness` without
partitioning the global authority. `/admission/resolve` reads the credential,
policy, optional principal, requested provider connections, and scoped pool
membership/runtime in one invocation of the existing `policy-bindings` object.
The Worker still computes and compares the secret digest with `safeEqual`.
At this stage only the current authenticated operation held the result. This
historical no-cache behavior was superseded by [#326](#zero-hop-warm-path-2026-10-23);
current admissions use its bounded isolate cache on HTTP and WebSocket creates.

Cold imports retain the existing family markers, normalization, guarded
initialization and canonical reread. A disable or migration closure committed
while KV is read wins over the stale KV value. Discovery retains the existing
all-connections migration marker behavior. Policy/owner import failures are
deferred until after secret verification; provider-read failures wait until
after secret/policy/model checks, preserving their error precedence.
Existing individual routes remain available to admin and migration callers.

The selected provider is known before admission on native/manifest routes;
unified requests parse their bounded JSON body before choosing admission's
provider. Parse failures still authenticate before returning the parse error.
Secret hashing and a supplied session's sticky hash overlap the RPC. Once
admitted, the Worker bulk-reads the default/member grant keys, applies local
filters, and calls `/grant-pools/select`. Selection remains atomic; its counter
upsert now uses `RETURNING selected_count` rather than a second SQL read.
Failover takes a fresh pool snapshot for the alternate attempt.

Key-authenticated models/catalog requests include the requested provider
connections and eligible pools in their one admission read. They never call
`/grant-pools/select` or a separate pool-resolution RPC. Health and grant
projections still come from KV and budget observations remain live ledger reads.
Compiled model metadata, route metadata and connection types have immutable
module-level projections; filtering, offers and affordability remain per request.

| Warm path | Previous foreground global authority RPCs | Now |
| --- | ---: | ---: |
| Native Messages/count_tokens; registered unified/manifest inference, service key | 5 | 2 (admission + select) |
| Same, principal-owned key | 6 | 2 |
| Models/catalog with one eligible provider, service key | 4 | 1 |
| Models/catalog with N eligible providers, service key | 3 + N | 1 |
| Key inspect, me, usage authentication | 2 (+1 owner) | 1 |
| Pool status authentication | 2 (+1 owner) | 1 |
| WebSocket create (excluding handshake and continuation publication) | 5 (+1 owner) | Warm same-socket witnesses: 0 authority reads; cache disabled: admission + credential materialization. Explicit reserve legs add one parallel round; [full sequential storage counts](#same-socket-continuation-witnesses-2026-10-24). |
| Alternate attempt after provider rejection | 2 (resolve + select) | 2 |

Pool status still scans the caller's scopes and reads statistics/runtime and
seven-day usage after authentication. Those reads are a different reporting
operation, not the inference admission sequence. Cloudflare Access sessions
still evaluate multiple policies and transport compatibility through their
existing path. Fusion's multiple provider operations and durable continuation/
background/control admissions retain their separate ownership and revocation
checks. No budget or credential-owner RPCs were removed.

The real-SQLite tests cover valid, revoked, stale, missing-policy, disabled-policy,
disabled-owner, unmaterialized-owner and unowned keys; missing/incorrect keys;
all four import-family closure/disable races; model denial; disabled/missing
connections; unavailable pools; explicit environment fallback; and invalid-secret
precedence during failed policy/owner imports. A warmed
subscription HTTP test asserts exactly admission + select. Existing HTTP,
manifest, discovery, lifecycle and real-workerd WebSocket tests remain in use.

### Non-streaming investigation

Ordinary Messages JSON delivery does not await accounting, settlement, quota
feedback or complete-body JSON inspection before returning bytes. Inspection
accumulates bounded text as the single backpressured reader forwards chunks;
JSON parsing occurs only at EOF. Settlement and usage publication are registered
with `waitUntil`; quota feedback was already background work. Responses has
additional durable continuation/publication requirements that Messages does not.

A regression test holds upstream EOF open, verifies the first JSON bytes arrive,
then closes upstream while holding usage publication open and verifies the client
still reaches EOF. This rules out those router waits for ordinary Messages. It
does not establish why the supplied live non-streaming p50 was 3.6 s versus a
streaming content-delta p50 of 1.6 s. Those measure different completion points;
without upstream header/completion timing for matched requests, provider queueing
or full-generation time cannot be separated from live router contention.

### Instrumented local comparison

Both bundles use the same instrumented harness: 200 requests per cell, seven
subscription owners, 70 sessions, 20 ms synthetic provider delay, `max_tokens=16`,
and production-style queue batching. Baseline is `b827638`; after is this admission
change. Runs are sequential, with no other task-owned load or test run during the
measurement cells. The harness counts actual authority-stub invocations; quota
feedback is reported separately from foreground admission/selection.

```sh
pnpm loadtest:local --requests 200 --concurrency 50,100,200 \
  --delay-ms 20 --max-tokens 16 --out /tmp/clawrouter-admission-after.json
```

All cells have zero unexpected errors and exact selection/usage reconciliation
against synthetic upstream dispatches. All seven grants receive quota feedback;
the bounded recent-event samples show no session selecting multiple grants.
Latency is TTFB p50 / total p50 in milliseconds; throughput is completed req/s.
Each entry is **before → after**.

| Scenario | Concurrency | Foreground authority RPC/request | TTFB p50 | Total p50 | Throughput |
| --- | ---: | ---: | ---: | ---: | ---: |
| catalog | 50 | 4 → 1 | 255.8 → 112.7 | 256.2 → 114.1 | 173.7 → 386.5 |
| catalog | 100 | 4 → 1 | 604.5 → 273.6 | 604.6 → 275.5 | 81.7 → 351.7 |
| catalog | 200 | 4 → 1 | 1499.7 → 1768.5 | 1503.2 → 1771.0 | 132.3 → 58.0 |
| count | 50 | 5 → 2 | 196.5 → 438.5 | 197.7 → 439.8 | 220.9 → 109.9 |
| count | 100 | 5 → 2 | 407.6 → 1107.4 | 412.0 → 1113.6 | 210.1 → 87.8 |
| count | 200 | 5 → 2 | 1432.3 → 1144.8 | 1442.9 → 1149.7 | 130.3 → 173.4 |
| messages | 50 | 5 → 2 | 633.6 → 815.7 | 635.7 → 818.2 | 64.5 → 52.9 |
| messages | 100 | 5 → 2 | 708.0 → 3098.8 | 708.4 → 3099.0 | 75.0 → 21.6 |
| messages | 200 | 5 → 2 | 851.2 → 3185.6 | 858.4 → 3191.3 | 204.9 → 37.0 |
| stream | 50 | 5 → 2 | 253.7 → 667.2 | 382.1 → 886.7 | 120.4 → 43.5 |
| stream | 100 | 5 → 2 | 535.5 → 403.5 | 620.9 → 458.6 | 130.5 → 112.9 |
| stream | 200 | 5 → 2 | 1247.6 → 2198.2 | 1324.9 → 2269.2 | 135.5 → 58.4 |
| abort | 50 | 5 → 2 | 327.3 → 2055.5 | 401.2 → 2312.3 | 95.5 → 13.7 |
| abort | 100 | 5 → 2 | 820.7 → 1526.0 | 807.3 → 1879.4 | 105.3 → 46.6 |
| abort | 200 | 5 → 2 | 1348.6 → 2535.7 | 1703.1 → 2683.6 | 107.5 → 66.9 |

These short local sweeps do **not** establish a consistent latency or throughput
improvement. Catalog improves at 50/100; most inference cells regress, while
count at 200 and stream TTFB at 100 improve. The deterministic result is fewer
network round trips, not a measured production speedup. Host/workerd scheduling,
SQLite persistence and loopback client contention remain in the measurements.
The baseline once again showed large run-to-run variation relative to the
earlier exploratory sweep (which had 71 stream resets at concurrency 200).
Do not extrapolate these local numbers to the supplied SJC cross-colo timings.

A separate concurrency-30 run (200 requests each, `max_tokens=16`) observed:

| Response | TTFB p50 (ms) | Total p50 (ms) | Throughput | Errors |
| --- | ---: | ---: | ---: | ---: |
| messages | 10248.8 | 10251.8 | 2.73 | 0 |
| stream | 5415.1 | 6401.5 | 4.05 | 0 |

Host load averages were 40.28 / 56.63 / 60.85 near the end of this run, with
unrelated compilation and system activity. The configured fake upstream is only
20 ms, so this comparison is confounded by shared-host contention and does not
isolate a response-path cause. It retained exactly two foreground authority RPCs
per request and reconciled all 400 selections and usage events. No live provider
benchmark or deployment was performed.

## Admit-and-select follow-up (2026-10-11)

Implemented work-order parts 1–2 on `perf/single-hop-inference`. Ordinary
proxy-key HTTP inference passes the prepared endpoint, transport, upstream model,
catalog model, capability and hashed session into admission. After any cold
imports, the authority rereads authentication, policy, connection and pool state,
filters candidates and updates selection counters in one synchronous SQLite
transaction. No network wait occurs in that transaction. The Worker consumes
that result once, only for the matching operation. Failed-provider exclusions
use a fresh combined admission, including current policy and connection checks.

`worker/grant-eligibility.ts` is the shared owner of candidate filtering, routing
normalization, priority, credential usability and revision matching. Both paths
use the existing provider transport/configuration functions and the same
stateful authority selector. Provider logic and selection strategies are not
copied into a second implementation. The immutable bundled provider catalog
resolves the endpoint facts; no request content enters the authority.

The additive `upstream_grant_projections` table stores an allowlisted, secretless
routing projection. The credential owner's existing attachment publication
writes it in the same transaction as membership/version changes, before the
existing KV publication. Generation and attachment revision accompany the
selected grant. An overlapping old owner publication without a projection marks
the row legacy, preventing a stale projection from surviving a version update.
This revision is publication provenance, **not** permission to cache credentials.

A missing row triggers at most one bounded bulk read for the two pools and two
default keys (66 maximum). Each inserted row is its import marker, including
known-absent defaults. Import rereads the marker and attachment revision inside
a synchronous transaction, so concurrent owner publication, rotation or revoke
wins over delayed KV. A version mismatch or raw legacy secret marks the row
legacy and retains the old Worker KV + select path until owner publication
repairs it. Failed KV reads and missing metadata for an attached/versioned owner create no
marker and may retry; only an unowned default-key miss becomes a durable absent
marker. Old writers that
only change KV after the marker are not supported; use the credential owner.
The upgrade is additive; do not remove markers or restore old projections over
new owner versions.

### Why materialization remains

The credential cache escape hatch was taken. Revocation currently commits a
secretless tombstone even if the global authority is unavailable. Pause and
permanent OAuth-refresh rejection likewise commit owner state before repairing
its derived index. During a publication outage, the authority may still return
the old active generation. A cached token keyed by that generation would pass
the proposed check and bypass revocation. Blocking secret deletion on a global
index write would violate the existing owner safety contract.

No secret cache was added. Every selected grant still reaches its credential
owner, which rejects revoked/disabled/reauthorization-required state and handles
near-expiry refresh. A successful rotation is visible in the next authority
projection; a failed publication is repaired or rejected at materialization,
never served from cached secret material. Policy and proxy-key disable are
checked afresh at admission. Requests admitted before a concurrent mutation
retain the existing in-flight semantics; already dispatched requests cannot be
retroactively revoked.

Completing part 3 requires a separately designed pre-mutation invalidation
protocol, including index-unavailable revocation, recovery and overlapping old
writers. A TTL or matching generation alone does not solve this boundary.

| Foreground path (excluding budgets and upstream) | Before | After |
| --- | --- | --- |
| Warm proxy-key HTTP inference | 2 authority + 1 KV bulk read + 1 credential owner | 1 authority + 1 credential owner |
| Cold authority projection, current owner metadata in KV | 2 authority + 1 Worker KV + 1 owner | 1 authority (internal bounded KV import) + 1 owner |
| Legacy/unimportable projection | 2 authority + 1 Worker KV + 1 owner | Same fallback; first read may attempt bounded import |
| Alternate after 401/403/429, projections ready | 2 authority + 1 KV + 1 owner | 1 fresh authority + 1 owner |
| Environment fallback, projections ready | admission, optional select, KV | 1 authority; no credential owner |
| Discovery, Access policy selection, HTTP pinned continuations, Fusion preflight | Existing paths | Existing paths |
| Pinned WebSocket create | 2 authority + 1 KV + 1 credential owner, serial continuation/reserves | Warm same-socket witnesses: 0 reads before send; cache off: admission + materialization. Explicit reserve legs add one parallel round ([round-trip counts](#same-socket-continuation-witnesses-2026-10-24)). |

At this stage the full target of one authority call **plus upstream only was
not claimed**, and no authorization or credential state was cached between
requests. [#326](#zero-hop-warm-path-2026-10-23) supersedes that historical cache
restriction; the WebSocket row above reflects the current merged behavior.

The regression suite compares old and combined outcomes/counters across all six
strategies, three stickiness modes, priority tiers, reserve, model-scoped
exhaustion, cooldown, stale revisions/state, eligibility, exclusions and OpenAI
HTTP/WebSocket transport requirements. It checks warm hop counts, fresh failover,
legacy migration, bounded once-only backfill, concurrent revoke/rotation/tenant
changes, generation publication and secret exclusion. The publication-outage
regression explicitly observes an old active authority generation after owner
revocation, then proves materialization rejects it.

Validation on the final implementation:

```text
pnpm check                      exit 0
Worker:  tests 1301, pass 1301, fail 0
Admin:   tests 224,  pass 224,  fail 0
Scripts: tests 361,  pass 343,  fail 0, skipped 18
focused selection/continuation: tests 91, pass 91, fail 0

pnpm worker:e2e                 exit 0
local Worker smoke passed
Responses WebSocket workerd fixture passed
contentCleanup: ok

autoreview (P0–P2): scoped-clean
```

The review caught and fixed two stale-input races on legacy failover (tenant
scope and sticky input), plus a transient KV-miss import that could hide an
attached grant. Regression tests cover each. Existing cancellation/deadline
fault-injection hooks now target combined admission instead of the removed
standalone select call. An early full run was stopped after those old hooks
left a continuation test waiting forever; the corrected 43-test continuation
file and final full check pass. E2e's intentional accounting and cleanup failure
diagnostics remain expected. No live provider call or deployment was performed.

The final synthetic load pass ran separately from tests:

```sh
pnpm loadtest:local --requests 100 --concurrency 10,30 --max-tokens 16 \
  --out docs/performance/single-authority-selection-local.json \
  --label single-authority-selection
```

All 1,000 requests completed with **zero unexpected errors**. The 800 inference
requests had exactly 800 selections and 800 persisted usage events, including
104 intentional aborts. Each cell recorded exactly one foreground admission
RPC per request, with no standalone pool resolve/select RPC. Quota feedback is
reported separately (one background observation per inference). All seven
grants received quota updates; bounded recent-event checks found no session
using multiple grants. Clean credential materialization is still one separate
owner invocation, proved by the HTTP unit test; refresh/dirty-owner repair can
add provider-token and owner-to-authority publication work.

| Scenario | Concurrency | TTFB p50 ms | Total p50 ms | Requests/s |
| --- | ---: | ---: | ---: | ---: |
| catalog | 10 | 30.7 | 31.2 | 316.5 |
| catalog | 30 | 75.8 | 76.3 | 342.6 |
| count | 10 | 45.5 | 46.3 | 82.6 |
| count | 30 | 74.3 | 76.6 | 196.0 |
| messages | 10 | 64.5 | 68.0 | 113.4 |
| messages | 30 | 314.6 | 315.1 | 63.4 |
| stream | 10 | 52.2 | 102.7 | 71.1 |
| stream | 30 | 146.1 | 221.6 | 124.3 |
| abort | 10 | 102.4 | 99.0 | 58.4 |
| abort | 30 | 87.1 | 92.7 | 237.6 |

TTFB for streaming means first content delta. Abort latency samples include
different completion subsets. The fake provider waits 20 ms before content;
the same workerd process hosts the router and fixture. Host load averages near
the final pass were 40.64 / 48.28 / 44.55. These are indicative local results,
not an idle-host A/B or a production speedup claim. The coordinator should
compare the saved [raw results](performance/single-authority-selection-local.json)
against main on an idle host.
