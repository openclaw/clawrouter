# Stable retrieval diagnostic

Status: deployed and calibrated. One approved Sol retrieval comparison completed
2026-10-23 06:56:12 UTC: tool-level `Internal Error`, no marker, zero GET/HEAD
activity; result inconclusive. Active fixture version
`5739c9d6-c696-4358-ba31-5b4054cb5ba8`, normal source `12b5383` restored
following the temporary observation attempt. The owned diagnostic
generation was deleted; private controls and public GET/HEAD return 404.
Provider retrieval remains unqualified.

The [temporary request-observation attempt](search-semantics-request-observation.md#approved-deployment-attempt-and-restoration)
passed robots response comparisons but stopped at session creation. Normal
configuration restored; observation counters remain unqualified. No further paid
probe ran.

Purpose: replace the uncounted, GET-only JSON health comparison with ordinary
HTML and durable GET/HEAD evidence at a stable URL. The health endpoint and
existing UUID matrix pages retain their behavior.

## Interface

All endpoints use `https://clawrouter-fakeco.openclaw.ai`. Exact paths only;
alternate hosts, HTTP, query strings and trailing-slash variants are rejected.

| Path under `/search-semantics/` | Methods | Behavior |
| --- | --- | --- |
| `diagnostic` | GET, HEAD | Public HTML while an authenticated generation is active; otherwise 404. |
| `_control/diagnostic` | POST | Create one generation; strict `{ "ttlSeconds": 300 }` input. Active generation gives 409. |
| `_control/diagnostic` | GET | Read active generation privately, or 404. |
| `_control/diagnostic/{id}` | GET | Read only the matching generation privately. |
| `_control/diagnostic/{id}` | DELETE | Delete only the matching generation. Stale/unknown ID gives 404. |

Controls require the existing derived bearer token, checked against its existing
SHA-256 binding. There is no collection DELETE, public creation or public reset.
The server generates a fresh UUID and random synthetic marker. No arbitrary
content, URLs or caller-selected markers accepted. TTL defaults to five minutes;
accepted range remains 60–7,200 seconds.

One separate storage key in the existing bounded `fixture-v1` Durable Object;
no new class, namespace, route or binding. Existing matrix runs stay independent.
The shared alarm tracks the earliest run or diagnostic expiry. Expired content
is inaccessible even before its alarm executes. Explicit deletion remains the
normal cleanup; expiry is recovery, not a substitute for attended cleanup.

HTML contains only synthetic text and the marker. The marker is hidden from the
search request, URL, headers and operator receipts; it is visible in the public
HTML body while active. No JavaScript, authentication, redirects, links or
`X-Robots-Tag` on this diagnostic response. Existing matrix `noindex` headers
remain unchanged. All three cache-control headers use `no-store`; this requests
cache avoidance, not proof of provider behavior.

GET increments `gets` and sets `lastGetAt`; HEAD increments `heads` and sets
`lastHeadAt`, returns the same headers and no body. Private reads do not increment
either counter. Counts and timestamps persist transactionally. No IP address,
user agent, request body, prompt or completion is recorded.

`createDiagnosticFixture` in `scripts/search-semantics-fixture.mjs` exposes
`initial`, constant `url`, generation-checked `snapshot()` and `close()`.
Creation never fetches the public page. Keep `initial`/snapshots and marker in
memory; project only ID, expiry, counts, timestamps and marker-match booleans
into receipts. A helper failure is not permission to replace another generation.

## Rollout, calibration and one-call comparison

Steps 1–3 completed in the approved deployment/calibration batch below. One
separately approved provider attempt completed steps 4–6, also recorded below.
Any additional hosted write/probe batch requires separate user approval.

1. Read-only refresh: exact account/zone/route ownership, fixture version and
   binding, main FakeCo health and normal security state. New diagnostic path
   must be absent before deployment. Preserve the original version for rollback.
2. After approval, update only the existing fixture Worker using its unchanged
   Wrangler configuration and existing credential scope; no authentication
   fallback. Record new version. Verify health identity, public diagnostic 404
   with no active generation, and unauthorized controls 404. No security, robots,
   DNS, Access, router, budget, route pattern/destination or namespace changes.
   Record any deployment-created route ID replacement for later cleanup.
3. In that approved calibration batch, create one five-minute generation through
   authenticated control. Record its ID immediately. Make two public GETs and
   one HEAD; require matching HTML, empty HEAD body and exact counts 2/1, with
   correct timestamps. Compare existing owned matrix counters if available;
   otherwise record that this hosted independence check remains unqualified.
   Delete by ID in `finally`; verify control and public GET/HEAD 404. Save
   metadata only. This stage makes no OpenAI call.
4. After separate approval for one paid comparison, create a fresh five-minute
   generation and require zero counters. Send only the constant public URL to
   one direct Sol live-mode open, fresh session, short output, using the existing
   bounded `directSearchProbe`. Keep the marker private; count the attempt before
   dispatch and never retry an ambiguous outcome. No inference or broader matrix.
5. Snapshot after completion, allow a bounded late-request observation window,
   then snapshot again and delete only the owned ID in `finally`. Record UTC
   windows, provider request ID, tool-error flags, marker-match boolean and counter
   deltas. Keep operator HTTP checks outside this window or account for them
   explicitly. Do not log marker-bearing snapshots or raw/encrypted tool output.
6. Verify generation controls and public GET/HEAD return 404 after cleanup.
   Report partial failures and the owned ID immediately; never delete a different
   generation. No search retry or security relaxation follows automatically.

## Completed deployment and calibration

The version and route IDs in this historical section were superseded by normal
restoration; use [current ownership](search-semantics-validation.md#isolated-fixture)
for cleanup.

Reviewed source `12b53838cfb8c27a71d67ee2f5a7ad0c2cc3d7d9` deployed once to
the existing fixture Worker. Previous version:
`7c4bb07f-e01e-42f1-a784-7e58de842462`. New version:
`d29dd6b3-ceed-4d2c-93f5-c60fe791df26` at 100%.

Wrangler replaced internal route ID `3027364f1df44bcfa2b39ce11a1fea14` with
`a7df3050ed59443aa1b2f96362ecdd94`. Pattern, Worker destination and fail-open
setting match exactly. Substituting the old ID reproduces the complete baseline
route-inventory hash; no other route changed. The settings difference is solely
deployment annotations: substituting prior version annotations reproduces the
baseline settings hash. Bindings, runtime, namespace, main Worker, domains and
Access match baseline; BIC remains on. The preflight Safari rule inventory
contained only the original Catalog rule, with no temporary FakeCo exception.
Public unprovisioned diagnostic GET/HEAD and unauthorized controls returned 404;
dashboard Access challenge remained intact.

One authenticated 300-second generation, ID
`690a3d4e-7849-4e84-a5b2-e751978766cc`, began with zero counters. Private
reads did not increment them. Two public GETs returned the expected hidden
marker; HEAD returned an empty body. Counts progressed 1/0 → 2/0 → 2/1;
timestamps matched the methods and generation window. All three cache headers
were `no-store`; no `CF-Cache-Status` or `Age` was reported. No marker appeared
in headers or persisted receipts.

Generation-scoped deletion completed at 06:53:08 UTC. Its private lookup,
collection lookup and public GET/HEAD all returned 404. Postflight infrastructure
matched the immediate deployed baseline. No matrix runs were created; both
previously owned run controls remained 404 before/after. No active owned matrix
run was available for hosted counter-independence comparison; local workerd
independence tests passed. The registry object and namespace remain allocated.

Metadata receipts, under ignored `.artifacts/fakeco-codex-search-20261022/`:
`search-diagnostic-deployment-receipt.json` and
`search-diagnostic-calibration-receipt.json`. No router application writes,
paid search/inference calls, PR or push in that deployment/calibration batch.

## Approved single Sol retrieval comparison

Completed 2026-10-23 06:56:12 UTC. Read-only preflight confirmed the calibrated
version, exact route ID, settings/bindings/runtime/namespace, main FakeCo health,
Access challenge and diagnostic absence. BIC remained on. A refreshed Safari
Configuration Rules inventory showed one active rule, original Catalog only.
No security or deployment change accompanied this probe.

Created one 300-second generation, ID
`6f5c413f-dcae-4a37-95e6-81b12ec5fc5a`. Private baseline at 06:55:53.555 UTC
showed zero GET/HEAD counters and null timestamps. The operator never fetched
the public diagnostic while active; the marker stayed out of the provider request.

Exactly one direct `gpt-6.1-sol` `/v1/alpha/search` call, fresh session,
`external_web_access: true`, short output, opened only the constant public URL.
Dispatch 06:55:53.557 UTC; completion 06:55:54.386 UTC:

- HTTP 200; request ID `req_eb5773ea178843b1afd9baea22e0b728`.
- 281 output characters, tool-level `Internal Error`, expected marker absent.
  A search reference was present but does not qualify retrieval.
- Immediate snapshot at 06:55:54.527 UTC and final snapshot at 06:56:09.923 UTC
  both showed zero GET/HEAD and null timestamps. The final snapshot followed a
  15-second late-request observation window. No counted handler activity.
- No usage field; upstream billing remains unqualified. Raw/encrypted tool
  output, markers and credentials remained in memory; only metadata persisted.

Deleted only the owned generation. At 06:56:10.595 UTC its authenticated lookup,
collection lookup and public GET/HEAD all returned 404. Infrastructure matched
baseline after cleanup. No retry, inference, broader matrix, router application
write, budget change, Cloudflare management write, PR or push.

Receipt: ignored
`.artifacts/fakeco-codex-search-20261022/search-diagnostic-sol-receipt.json`.
The calibrated HTML handler saw no accepted GET/HEAD in this finite window.
Provider no-fetch, URL transformation, prerequisite/robots handling, DNS/network
failure and pre-Worker rejection remain possible; zero counters do not establish
no network attempt. Fresh retrieval, cached/live semantics and cause remain
unqualified. Further paid probing or Cloudflare mutation needs separate approval.

## Interpretation and rollback

- Expected marker returned, no tool errors, and attributable GET activity during
  the probe window: evidence of successful fresh content retrieval for this
  endpoint/model at that time. Background clients can hit a stable public URL;
  counters alone do not identify OpenAI as the caller.
- HEAD only: request activity reached the handler, but no content retrieval
  qualified. GET activity without a correct tool result also remains inconclusive
  about successful provider retrieval.
- No counted requests: the accepted diagnostic handler saw no GET/HEAD. DNS,
  pre-Worker edge rejection, modified URLs, provider eligibility or no attempted
  fetch remain possible. This does not establish no network attempt.
- Cached/live semantics and upstream billing remain unqualified by this control.

For a separately approved rollback, first delete any owned active generation and
verify inaccessibility. Restore only the recorded prior fixture source/version;
preserve the existing route, class, namespace, bindings and matrix runs. Do not
apply the class-deletion cleanup migration as a code rollback. Do not overwrite
an unexpected concurrent deployment or delete a generation owned by another run.

Local verification: Worker TypeScript check and 18 focused fixture/matrix/probe
tests passed, including workerd concurrency, generation ownership, input/auth
rejection, expiry before alarm and shared-alarm scheduling. Hosted calibration
passed; the subsequent single-call provider comparison was inconclusive.
