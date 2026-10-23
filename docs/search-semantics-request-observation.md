# Temporary request observations

Status: prepared locally only. No deployment, hosted session, new route/binding,
security change or search probe in this preparation. The active fixture remains
version `d29dd6b3-ceed-4d2c-93f5-c60fe791df26`; existing route ID
`a7df3050ed59443aa1b2f96362ecdd94`; namespace
`148cbb6483b4421dbf8b25301a325865`. Deployment and paid comparisons require
separate user approval.

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
fetch fallback if forwarding fails. Hosted equivalence still needs calibration.

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

Nothing below has run. Before requesting deployment approval, refresh read-only
inventory: exact account/zone, active fixture and main versions, all bindings and
routes, namespace/class ownership, Access scope, health and normal security state.
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
2. Create one observation and one diagnostic session, both five minutes; record
   each owned ID immediately on 201, before helper validation. Private snapshots
   must show no observed requests and zero diagnostic counters.
3. Seven accounted public requests: robots GET/HEAD; diagnostic GET/HEAD;
   diagnostic query GET; diagnostic trailing-slash GET; fixture health GET.
   Expect robots baseline statuses, diagnostic 200/empty HEAD with correct marker,
   query/slash 404, health 200. Require seven exact observation counts, diagnostic
   counts 1/1, no overflow/saturation and unchanged session expiry. Keep markers
   in memory. No matrix run or provider call.
4. Snapshot metadata. In `finally`, delete only the owned observation ID first,
   then the owned diagnostic ID; verify both collection/generation controls 404
   and public diagnostic GET/HEAD 404. Public cleanup checks occur after the
   observation session is closed. Reconcile infrastructure against the expected
   deployed baseline.

`createRequestObservation` supplies `initial`, generation-checked `snapshot()`
and `close()`. The caller still journals the creation ID immediately, retains
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
**while the wrapper is still deployed**; that read prunes expired observation
storage and clears its alarm. On failure, keep custody of the recorded IDs;
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
