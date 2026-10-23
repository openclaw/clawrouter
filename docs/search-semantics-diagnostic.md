# Stable retrieval diagnostic

Status: prepared locally only. No Worker deployment, hosted generation creation,
Cloudflare setting change or paid search call authorized by this preparation.
The last deployed fixture remains version `7c4bb07f-e01e-42f1-a784-7e58de842462`.

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

## Future rollout, calibration and one-call comparison

Each hosted write/probe batch requires separate user approval. Nothing below
ran during local preparation.

1. Read-only refresh: exact account/zone/route ownership, fixture version and
   binding, main FakeCo health and normal security state. New diagnostic path
   must be absent before deployment. Preserve the original version for rollback.
2. After approval, update only the existing fixture Worker using its unchanged
   Wrangler configuration and existing credential scope; no authentication
   fallback. Record new version. Verify health identity, public diagnostic 404
   with no active generation, and unauthorized controls 404. No security, robots,
   DNS, Access, router, budget, route or namespace changes.
3. In that approved calibration batch, create one five-minute generation through
   authenticated control. Record its ID immediately. Make two public GETs and
   one HEAD; require matching HTML, empty HEAD body and exact counts 2/1, with
   correct timestamps and unchanged existing matrix counters. Delete by ID in
   `finally`; verify control and public GET/HEAD 404. Save metadata only. This
   stage makes no OpenAI call.
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
rejection, expiry before alarm and shared-alarm scheduling. Hosted calibration,
deployed behavior and provider retrieval still require the approved stages above.
