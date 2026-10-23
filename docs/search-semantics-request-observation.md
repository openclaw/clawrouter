# Temporary request observations

Status: approved readiness deployment completed; all seven public responses passed,
but only six requests were observed. Calibration incomplete. Both owned sessions
cleared; normal fixture restored at 2026-10-23 07:35:04 UTC.
Current version `e5e5231c-4477-4e4a-b95c-0f9c9e2b7101`; prefix route ID
`adf4daadf3f0489ba46a5084f2193688`; namespace
`148cbb6483b4421dbf8b25301a325865`. Temporary robots route/service binding removed.
No paid search calls. Hosted observation counters remain unqualified; further
Cloudflare mutations and paid comparisons require separate approval.
Local transition diagnostics and a stricter runner are prepared below; the new
wrapper is not deployed.

## Read-only follow-up

Safari Security Events, OpenClaw account `91b59577e757131d68d55a471fe32aca`,
`openclaw.ai` zone: exact Host equals `clawrouter-fakeco.openclaw.ai`,
2026-10-23 06:55–06:57 UTC. This covers provider dispatch
06:55:53.557 UTC through final counter snapshot 06:56:09.923 UTC for request
`req_eb5773ea178843b1afd9baea22e0b728`.

Filtered view showed `No firewall events found matching your filters` and no
summary data. The zone-wide view's one BIC block belonged to `docs.openclaw.ai`,
not FakeCo. No matching rule/action or affirmative block evidence available.
Sampling, excluded Worker subrequests and finite-window limits remain; this
does not prove no network attempt or no pre-Worker rejection. No settings were
saved. Safari remains on the exact-host filtered result.

## Candidate scope

`wrangler.search-semantics.observe.toml` selects an optional wrapper,
`worker/fixtures/search-semantics-observe.ts`. The normal fixture entrypoint and
normal/cleanup Wrangler configurations stay unchanged. Main router source stays
unchanged. No provider manifest, secret upload, new class, namespace or migration.

The candidate preserves the fixture prefix route and adds only
`https://clawrouter-fakeco.openclaw.ai/robots.txt*`, plus a service binding
`SEARCH_SEMANTICS_ROBOTS_ORIGIN` to the existing `clawrouter-edge-fakeco` Worker.
Cloudflare matches query strings as part of the URL, so the trailing wildcard
is required to cover robots query variants. It also matches robots lookalikes;
the wrapper forwards all of them to the main Worker without rewriting the
request or response. It does not create an allow/disallow robots policy.
See [route matching](https://developers.cloudflare.com/workers/configuration/routing/routes/)
and [HTTP service forwarding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/).
The service binding avoids recursion through the added public route. No public
fetch fallback if forwarding fails. Four hosted response comparisons passed;
observation counters still need calibration.

One additional fixed object, `request-observations-v1`, uses the existing
`SearchSemanticsObject` class/namespace. It has its own storage and alarm;
`fixture-v1` diagnostic/matrix storage and expiry remain independent. The object
can be allocated by public traffic, but stores no request observations without
authenticated session creation. This is one bounded object, not one per URL.

## Private lifecycle and retained data

All control paths are under HTTPS FakeCo `/search-semantics/_control/` and use
the existing derived bearer/digest authentication. Alternate host/scheme/port,
queries and unauthenticated controls return 404. Never persist credentials.

| Path suffix | Method | Behavior |
| --- | --- | --- |
| `observations/ready` | GET | Authenticated compatible-handler check; no session/storage read or write. |
| `observations` | POST | Strict `{ "ttlSeconds": 300 }`; one session, active slot 409. |
| `observations` | GET | Active session snapshot, or 404. |
| `observations/{id}` | GET | Matching session snapshot, or 404. |
| `observations/{id}` | DELETE | Delete only matching session; stale IDs 404. |

No collection DELETE or public creation/reset. Server-generated UUID, fixed
five-minute TTL, no extension on traffic. Requests reject/prune expired state
before alarm execution; the observation object's alarm also deletes it. Explicit
owned deletion remains required during attended work. Code/routes do not expire.

Snapshots contain only session ID/expiry, at most 128 aggregate counter buckets,
overflow count and saturation flag. Each bucket holds:

- Fixed path category: robots, robots variant, diagnostic, diagnostic variant,
  health, matrix-shaped path or other fixture path.
- Method bucket: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS or OTHER.
- Query-present boolean; never query names/values.
- Returned status, or zero if the delegated handler threw before a Response.
- Count, capped at 1,000,000. New buckets beyond 128 increment bounded overflow;
  exhausted numeric capacity sets saturation. Overflow/saturation means partial
  measurement and must prevent claims of complete coverage.

The prepared observation object marks controls and capture acknowledgements with
`x-clawrouter-observation-handler: observations-v2`. Readiness returns exactly
`{ "ready": true, "protocol": "observations-v2" }`. Authenticated observation
controls also carry `x-clawrouter-observation-worker: observations-worker-v2`.
A current Worker forwarding to an older object can therefore return a Worker
marker without the object marker. These identify protocol implementations,
not exact deployment versions. Authentication/URL denials expose neither marker.

Private `x-clawrouter-observation-captures` contains four capped counters:
`recorded`, `inactive`, `rejected`, `transport`. Capture acceptance requires HTTP
204, the object identity and an explicit recorded/inactive acknowledgement.
A returned old-handler 404 or unmarked 204 is rejected. Diagnostics contain no
request data; they describe only the responding Worker isolate, reset with that
isolate, and cannot establish complete deployment-wide capture. Public responses
carry none of these diagnostics. Durable session counters remain authoritative
for the calibration gate.

No raw URL/path/query, headers, IP, user agent, cookie, body, prompt, completion,
marker or request identifier is retained. Private controls are excluded, including
failed authentication; snapshots do not count themselves. No general Workers
Logs/Traces enablement. Snapshot metadata may be saved; diagnostic marker-bearing
snapshots and raw provider output must stay in memory.

Every eligible temporary-fixture request adds an awaited observation-object call.
This overhead stays outside the main router data plane. Capture is best effort:
failure does not replace the original response/exception. Consequently even zero
observation counters cannot prove that no request arrived. This supplements the
existing accepted-page counters; it is not a complete network trace.

## Prepared deployment and calibration sequence

The first approved attempt is recorded below. Before another deployment approval,
refresh read-only inventory: exact account/zone, active fixture and main versions,
all bindings and routes, namespace/class ownership, Access scope, health and normal security state.
Require the added robots route and service binding absent, no overlapping route
owned by another operator, and no active diagnostic/observation session.

Record current robots GET/HEAD/query/lookalike response status/body hashes and
stable headers, with a fixed synthetic request ID. Retain metadata only. Verify
main version `3d669069-fb9e-45e0-a71b-bded66c5b7b2` and the known original
fixture identity. Existing deployment success does not prove new service-binding
or route write/delete permissions. No auth/account fallback on failure.

An approved deployment batch updates only the fixture with the observation config,
preserving its existing digest, namespace and `v1` migration. Do not upload or
rotate secrets. Record the new version, both current route IDs and binding names
immediately, including after partial failure. Wrangler may recreate internal
route IDs: reconcile exact pattern/destination/fail-open semantics and all other
routes; do not use stale IDs for cleanup.

Hosted calibration, if included in that approval:

1. Require public diagnostic absent and unauthorized controls denied. Compare
   forwarded robots responses with baseline before starting counted sessions.
   Before any session POST, require authenticated `observations/ready` 200 with
   the exact payload, both identities and valid private diagnostics on three
   consecutive checks spaced five seconds apart. An unmarked object 404 resets
   the streak; unexpected responses stop. Poll for at most 120 seconds/25 checks;
   never retry a session POST. This samples stability, not global propagation.
   Record numeric status, separate identity booleans and validated counters before
   validation, without raw bodies.
   Then require marked observation collection 404 and diagnostic collection 404.
2. Create one observation and one diagnostic session, both five minutes; record
   response status before validation and each owned ID immediately on 201.
   Private snapshots must show no observed requests and zero diagnostic counters.
3. Seven accounted public requests: robots GET/HEAD; diagnostic GET/HEAD;
   diagnostic query GET; diagnostic trailing-slash GET; fixture health GET.
   Expect robots baseline statuses, diagnostic 200/empty HEAD with correct marker,
   query/slash 404, health 200. After each public request require the exact expected
   counter prefix, stopping before another public request if capture is missing.
   Finally require seven exact observation counts, diagnostic counts 1/1,
   no overflow/saturation and unchanged session expiry. Keep markers
   in memory. No matrix run or provider call.
4. Snapshot metadata. In `finally`, delete only the owned observation ID first,
   then the owned diagnostic ID; verify both collection/generation controls 404
   and public diagnostic GET/HEAD 404. Public cleanup checks occur after the
   observation session is closed. Reconcile infrastructure against the expected
   deployed baseline.

`createRequestObservation` supplies `initial`, generation-checked `snapshot()`
and `close()`. Creation first checks readiness; failure cannot reach POST.
Control errors retain only the HTTP status, without echoing response bodies.
The caller still journals the creation ID immediately, retains
cleanup custody after partial failure, and never deletes an unexpected session.
An ambiguous create/delete outcome requires read-only reconciliation, not replay.

Deployment approval should include the restoration below if calibration fails or
the campaign pauses. Do not leave the temporary route awaiting an unspecified
future experiment. A later paired paid comparison requires separate approval.

## Proposed paired comparison, separately approved

At most two standalone calls, same key/model/settings, separate fresh sessions:
first the previously successful IANA URL; only if that returns expected content,
create fresh observation/diagnostic sessions and open the fixed FakeCo diagnostic.
Require both counter baselines zero; keep the marker out of the request. No
operator public requests while FakeCo sessions are active. Take immediate and
15-second late snapshots, then delete only both owned session IDs in `finally`
and verify absence. Never retry an ambiguous provider call. No inference or
broader matrix. Absent usage does not establish no upstream charge.

This comparison can distinguish a failing known-content control from continued
FakeCo-specific failure. IANA success does not establish a fresh IANA origin
fetch. Robots/rejected-path activity can narrow where the FakeCo attempt went;
zero activity still leaves upstream failure, pre-Worker rejection, unobserved
HTTP/host/path variants, cached prerequisites and capture failure possible.

## Restoration and later cleanup

Before restoring the normal class implementation, snapshot metadata and delete
only the owned observation/diagnostic IDs. Verify observation collection/ID 404
**while the wrapper is still deployed**, with the observation handler marker on
that same 404 response; that read prunes expired observation storage and clears
its alarm. An unmarked 404 is inconclusive and cannot authorize state-cleanup
claims. On failure, keep custody of the recorded IDs;
do not blindly roll back to code whose alarm does not know observation storage.
Expiry fallback also depends on the wrapper remaining deployed until this check.

For separately approved restoration:

1. Read and match the newly recorded robots route ID, exact pattern, Worker and
   ownership. Delete only that added route; verify absence and original robots
   responses/main health. Do not remove the existing fixture-prefix route.
2. Redeploy `wrangler.search-semantics.toml`, restoring the unchanged normal
   fixture code. Preserve the existing digest/namespace/migration. Verify the
   temporary service binding is absent; exact three normal bindings remain.
3. Reconcile the active version and any recreated prefix route ID, all unrelated
   routes/settings/main Worker/domains/Access, BIC and public health. Diagnostic
   absent; authorized/unauthorized observation controls 404. Update ownership
   and cleanup receipts with current IDs. No global security change.

Deleting session state does not delete the allocated fixed object. Its existing
namespace remains in the original separately approved class-deletion cleanup
procedure; no new namespace or class-deletion migration is introduced here.

Local verification: Worker TypeScript check and 24 focused fixture/observation/
matrix/probe tests passed. Autoreview of preparation commit `c1a1ae2` completed
with no actionable P0–P2 findings. Hosted deployment, four robots forwarding
comparisons and infrastructure restoration passed in the batch below. Observation
creation, counting and owned-session deletion remain unqualified. Review
status: `/Users/joshavant/.codex/review-results/search-request-observation-preparation-20261023/status.json`.

## Approved deployment attempt and restoration

Batch 2026-10-23 07:10:54–07:11:24 UTC deployed reviewed source `c1a1ae2`
as temporary version `e0e2c851-3f43-4062-94af-ec0c47715b77`. Added robots route
`0d2f713b00354801882592550300ace4` and the main-Worker service binding.
Robots GET, HEAD, query GET and lookalike GET matched the original 404 status,
body hash and selected stable headers. Main Worker stayed on
`3d669069-fb9e-45e0-a71b-bded66c5b7b2`.

Observation creation returned non-2xx before any ID was recorded. The operator
failed to retain that response's HTTP status; its cause is unresolved. No
diagnostic generation was attempted, and none of the seven counted calibration
requests ran. Private collection checks and public diagnostic GET/HEAD returned
404 before restoration. These checks do not independently establish that the
new observation handler ran or cleared storage. No owned session ID exists for
later deletion; retain the namespace in the existing class-deletion cleanup.

The added robots route was deleted and the normal config redeployed. Current
version/route are at the top of this document. Normal code bytes match the prior
normal deployment; exactly the three normal bindings remain. Runtime/base
settings, namespace, unrelated routes, main Worker, domains, Access and BIC were
preserved. Dashboard remains Access-protected. No router writes, secret changes,
security relaxation, paid calls, PR or push.

A post-restoration authentication check at 07:13:14 UTC sent literal `null` to
the diagnostic control POST. It returned 400 `invalid_input`, proving current
control authentication works without creating a generation. This rules out a
current credential mismatch, not a temporary version/handler issue. No replay or
automatic redeploy. The ignored operator now journals every control response's
status before helper validation; the lost status cannot be recovered.

Receipt: ignored
`.artifacts/fakeco-codex-search-20261022/request-observation-calibration-receipt.json`.
Before another attempt, prepare status and handler/version evidence sufficient
to distinguish authentication, old-handler routing and runtime failure; obtain
fresh mutation approval. Paid search remains gated on hosted counter calibration.


## Local diagnosis and prepared readiness correction

Read-only reconciliation after the failed batch matched the restored version,
prefix route and all captured infrastructure hashes. No Cloudflare mutation or
paid call in this investigation. Wrangler dry run exported the intended class.
The actual generated bundle succeeded in a local normal → observed → normal
upgrade: authenticated invalid diagnostic input 400, observation creation 201,
owned read 200, then restored diagnostic validation 400.

A separate local pairing of the new Worker with the old object implementation
returned 404 for both creation and collection GET. This reproduces the ambiguity
in the failed calibration; it does not establish its historical cause because
that response's status was lost. Cloudflare documents temporary Worker/object
version skew, typically seconds to minutes, during eventually consistent code
updates: [Durable Object code updates](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).
Propagation is a supported hypothesis, not a confirmed root cause; other edge or
runtime failures remain possible.

Prepared correction: authenticated no-session readiness GET in the observation
object, fixed handler marker on control responses, and helper readiness gating
before creation. Non-2xx helper errors include numeric HTTP status only. Tests
cover no stored keys/alarm after readiness, denied readiness, empty-state marker,
new Worker/old object rejection before POST, malformed/missing handler identity,
and response-body privacy. Normal fixture/main router/configuration unchanged.

The old ignored calibration operator is historical and pinned to its earlier
source/IDs; do not replay it. A new approved batch must prepare fresh receipts
and source/review pins, journal status and marker-match before validation, and
require marked absence checks before treating observation state as cleared.
No automatic deploy or creation retry. Hosted lifecycle/counting remain unqualified.

Ignored local evidence: `observation-upgrade-reproduction.json` and
`observation-diagnosis-readonly-inventory.json` in the campaign artifact directory.


Correction commit `593a2fa`: Worker TypeScript and 27 focused fixture/observation/
matrix/probe tests passed. Corrected Wrangler dry-run bundle also passed local
upgrade/readiness checks. Autoreview completed scoped-clean through P2; report
status: `/Users/joshavant/.codex/review-results/search-observation-readiness-20261023/status.json`.
An initial review found no issues but failed report publication; the completed
rerun produced the valid status above. No hosted deployment in this follow-up.
The original ignored `.draft.mjs` retry operator is historical and remains
blocked. Its reviewed replacement and fresh preflight are recorded below.


## Reviewed runner and fresh read-only preflight

Completed 2026-10-23T07:28:15.575Z. No Cloudflare resource mutation, hosted
session creation or paid search call. Normal fixture/version/route/namespace at
the top of this document remain current; no robots route or temporary binding.

Reviewed runner: ignored
`.artifacts/fakeco-codex-search-20261022/run-request-observation-readiness-calibration.mjs`.
Runtime source remains `593a2fa`. Four source-only operator/dependency/test files
were frozen in an isolated detached worktree as commit `5fc8431`; their exact
bytes were reviewed through P2, scoped-clean. Three executable operator/dependency
SHA-256 hashes are verified by the runner before preflight, deployment and route
removal. Review manifest: `request-observation-runner-review.json`. Review status:
`/Users/joshavant/.codex/review-results/search-observation-runner-20261023/status.json`.
The isolated review worktree contains source only; no live receipts or secrets
were copied into its commit or added to the feature branch.

Eight offline operator checks passed: read-only mode; delayed-ready successful
calibration/owned cleanup/restoration; bounded old-handler rejection; ambiguous
creation; ambiguous deletion; partial deployment inventory; failed restoration;
and source/hash changes. These run the actual operator with simulated network,
filesystem and deployment dependencies; no live mutation. The live preflight
uses the real inventory helper and credentials, without deployment.

The runner accepts only explicit `--preflight-only` or `--deploy-approved` modes.
Source protection accepts documentation descendants of `593a2fa` while requiring
all protected runtime/helper/test/config files unchanged. Preflight verifies exact
restored resource identities and infrastructure hashes, Access challenge, absent
diagnostic, four robots baselines, and current authentication using literal `null`
(400 `invalid_input`, rejected before session storage). Secrets stay in memory.
Preflight writes a local timestamped receipt and latest pointer; it never launches
Wrangler or creates a session. Refresh it if more than ten minutes old before an
approved deployment. The deployment receipt is exclusive; do not replay a batch.

Readiness polls GET only, at most 25 attempts within 120 seconds; unexpected
responses stop. Session POST and owned-ID DELETE are attempted once per kind,
with attempts/status recorded before further validation. A marked observation
collection 404 is required before treating cleanup as qualified and before normal
restoration. If readiness/cleanup is unresolved, or deployment/restoration has an
ambiguous outcome, stop with recorded ownership for read-only reconciliation.
Do not blindly restore, redeploy or delete an unknown session. No broader matrix,
secret rotation, security relaxation, router writes or upstream search in this
runner.

Fresh live preflight at 2026-10-23T07:27:32.734Z passed. Account/zone,
normal fixture, main Worker, three normal bindings, namespace/class ownership,
route inventory, domains, Access and BIC matched the restored baseline.
Authentication returned 400 `invalid_input`; public diagnostic absent and Access
challenge intact. Normal-mode unmarked observation 404 is expected and does not
qualify observation storage/counters. Browser rule inventory was not refreshed;
the prior Catalog-only browser inspection remains historical.

Current local receipts: `request-observation-readiness-preflight.json` and
`request-observation-runner-preparation-receipt.json` in the campaign artifact
directory. The reviewed operator and dependencies remain ignored on the feature
branch. These preparation receipts are historical; the approved execution and
current ownership receipt are recorded below. No paid calls were included.


## Approved readiness deployment, incomplete calibration and qualified restoration

Approved batch started 2026-10-23 07:29:05 UTC. Source `593a2fa` deployed as
`fea5430a-e2ae-448e-84df-611db7e45c8b`, prefix route
`1c2b602bb58a4cb6b1db52e45820bdae`, temporary robots route
`7ac3c4e743d145dc8f18a7ae43c4bae4`, with the existing main-Worker service binding.
Readiness passed on its first GET at 07:29:19 UTC; marked empty baseline and both
session creations passed. The initial owned snapshots showed zero counters.

All seven public responses passed status/body/header checks. The final observation
read returned unmarked 404 at 07:29:22 UTC, stopping counter validation. Read-only
reconciliation at 07:30:17 UTC returned the same owned observation ID, unchanged
expiry, no overflow/saturation, and only six recorded requests:

| Public request | HTTP | Recorded count |
| --- | --- | --- |
| `/robots.txt` GET | 404 | 1 |
| `/robots.txt` HEAD | 404 | 1 |
| `/search-semantics/diagnostic` GET | 200 | 1 |
| `/search-semantics/diagnostic` HEAD | 200 | 1 |
| `/search-semantics/diagnostic?calibration=1` GET | 404 | 1 |
| `/search-semantics/diagnostic/` GET | 404 | 0 |
| `/search-semantics/health` GET | 200 | 1 |

Diagnostic GET contained the private marker; HEAD was empty; HTML/cache headers
and robots forwarding comparisons passed. Final diagnostic durable-counter
validation did not run because the observation read failed first. No additional
operator public requests occurred while this observation remained active; later
reconciliation used private controls only. Seven successful responses do not
qualify complete observation capture. Initial readiness also did not establish
stable handler identity for all subsequent requests. Intermittent unmarked 404s
and the missing capture remain unexplained; version propagation/capture failure
are possible, not confirmed causes.

Observation `c2667132-2ad2-4516-9344-955f4304defe` was created with expiry
07:34:20.614 UTC. Its single DELETE attempt returned unmarked 404, and the later
marked GET proved it still active. The DELETE was not retried. Diagnostic
`ac1f54ea-67ab-4dcb-a0cc-1f21be8b035a` DELETE returned 200; owned-ID/collection
absence verified. Mutations paused while observation TTL elapsed. At 07:34:27 UTC,
read-only checks returned marked 404 for both observation collection and owned ID,
plus diagnostic absence. The existing namespace remains allocated for later
separately approved class-deletion cleanup; marked expiry cleanup clears the
observation state/alarm, not the fixed object's allocation.

Restoration continued within the approved cleanup scope using
`complete-observation-readiness-restoration.mjs`. Its restoration functions match
the reviewed runner; the new entrypoint was separately reviewed as frozen commit
`47cb04c`, scoped-clean through P2. Exact source/session/version/route pins, TTL
expiry, marked absence, and fresh infrastructure checks gated restoration. No
session creation or DELETE retry in this continuation.

Cleanup reverified at 07:34:49 UTC, then only owned robots route
`7ac3c4e743d145dc8f18a7ae43c4bae4` was removed and normal config redeployed.
Restoration verified 07:35:04 UTC. Current version/prefix route are at the top;
normal code bytes match the prior normal deployment, exactly three normal
bindings remain, and temporary service binding is absent. Main Worker stays on
`3d669069-fb9e-45e0-a71b-bded66c5b7b2`; runtime/base settings, namespace, unrelated
routes/domains, Access and BIC preserved. Dashboard challenge remains intact.
No secret changes, router writes, new namespace, security relaxation, paid search
call, PR or push. Browser rule inventory was not refreshed.

Current ownership: ignored `request-observation-readiness-restoration-receipt.json`.
Original failed calibration: `request-observation-readiness-calibration-receipt.json`.
Combined outcome: `request-observation-readiness-batch-summary.json`.
All are in the campaign artifact directory. Both batch runners now have exclusive
execution receipts and must not be replayed. Further investigation should explain
or stabilize handler identity and capture before another hosted calibration;
paid comparisons remain gated on a successful calibration.


## Local transition reproduction and stability preparation

Prepared source `d3af38c`; not deployed. A workerd test starts with compatible
readiness and successful creation, then dispatches capture/control calls to the
actual normal/older object implementation while preserving the same storage.
The trailing-slash public request still returns 404; the capture and owned-ID
read also return old-handler 404. Switching back reveals the same active session
with no recorded request. This reproduces a mechanism consistent with the hosted
failure; it does not prove that code propagation caused that historical failure.

The prepared v2 wrapper checks explicit capture acknowledgements and exposes
separate private Worker/object identities plus bounded isolate-local diagnostics.
Tests cover valid/inactive acknowledgements, old-handler 404, unmarked 204 and
transport errors. Public forwarding, auth denials, bounded storage and independent
fixture/observer alarms remain covered. Worker type checking and 30 focused
fixture/observation/matrix/probe tests pass; Wrangler dry run passes. Runtime
commit review is scoped-clean through P2:
`/Users/joshavant/.codex/review-results/search-observation-transition-20261023/status.json`.

Fresh ignored operator `run-request-observation-stability-calibration.mjs` pins
this runtime and the current normal version/route. Its distinct receipt/preflight
names preserve both historical attempts. Twelve offline scenarios exercise
read-only mode, delayed/reset readiness, late old handlers, missing trailing-slash
capture, ambiguous creation/deletion/restoration, partial inventory and source
changes. Creation/deletion remain single-attempt; unqualified cleanup prevents
restoration. No new deployment or paid call is authorized by this preparation.


Operator review: frozen `7c8d7b9` found one P2 in the inventory helper: a failed
unrelated read could discard successfully read ownership. Correction `5bf1ed4`
uses a separate `search-observation-stability-operations.mjs` and journals each
available version/route result before rejecting incomplete inventory. A test calls
the real helper with Access failure and deployment-read failure independently.
All twelve operator scenarios pass. Correction review is scoped-clean through P2:
`/Users/joshavant/.codex/review-results/search-observation-stability-inventory-fix-20261023/status.json`.
Historical operator source hashes remain unchanged; its receipts must not be
replayed. The new source/hash manifest is
`request-observation-stability-runner-review.json`; mutation approval is null.


Fresh read-only preflight passed at 2026-10-23T07:45:28.992Z against the current
restoration receipt. Normal version `e5e5231c-4477-4e4a-b95c-0f9c9e2b7101`,
prefix `adf4daadf3f0489ba46a5084f2193688`, namespace and main version unchanged.
Exactly three normal bindings; temporary robots route/service absent. Qualified
inventory hashes, four robots baselines, private/public absence, non-creating
literal-null auth check (400), Access challenge and BIC verified. Browser rules
were not refreshed. No denied-endpoint retry or authentication fallback.

Current preparation receipts: `request-observation-stability-preflight.json` and
`request-observation-stability-preparation-receipt.json`. Cloudflare writes,
session creations/DELETEs and paid search calls: zero. No PR or push. The new
wrapper remains undeployed; the next hosted calibration requires separate
approval and a fresh preflight. Retrieval semantics and hosted observation
coverage remain unqualified until that calibration succeeds.
