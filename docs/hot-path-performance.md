# Hot-path review and local load evidence

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
Only the current authenticated operation holds the result; every HTTP request
and WebSocket create resolves again. Nothing caches revocation, policy,
budget, membership, runtime, or selection state across requests.

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
| WebSocket create (excluding handshake and continuation publication) | 5 (+1 owner) | 2 |
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
| Discovery, Access policy selection, pinned continuations, Fusion preflight, WebSocket creates | Existing paths | Existing paths |

The full target of one authority call **plus upstream only is not claimed**.
No authorization, policy, pool, runtime, selection or credential secret is cached
between requests.

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
