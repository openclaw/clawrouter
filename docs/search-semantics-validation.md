# FakeCo search semantics validation

A [Responses/alpha comparison](search-semantics-endpoint-comparison.md) is prepared
locally. Its public exposure and bounded paid pair need fresh approvals;
no new experimental provider calls or Cloudflare writes during preparation.

The independent [Tailscale Funnel experiment](search-semantics-funnel.md) passed
authorized public calibration at `2026-10-23T08:16:48.420Z`: returned fixture marker
and one corresponding origin GET. After marker rotation/counter reset, the one
separately approved direct Sol retrieval returned HTTP-200 `Internal Error`, no
marker and zero origin requests through the 15-second-late snapshot at
`2026-10-23T08:18:48.839Z`. Result inconclusive; upstream semantics and billing
remain unqualified. Fixture/Funnel closed, both configurations independently
verified `{}`, port 18765 free. Existing FakeCo deployment/results unchanged.

Fixture deployment approved and verified at 2026-10-23 04:45:59 UTC from
`77bf4ac4fa1f155861b2415648242178ec17089b`. One separately approved synthetic
calibration run has since been created, checked, and deleted. No router credential
registered, budget changed, or existing canary cleaned up. A separately approved
direct Sol probe ran two standalone search calls and deleted its fresh fixture run;
the result was inconclusive, as detailed below. No inference ran.
The later stable HTML diagnostic update/calibration completed, followed by one
separately approved Sol retrieval call. It returned `Internal Error` with no
marker and zero GET/HEAD counters. Both owned diagnostic generations were
deleted. See the completed diagnostic batches below. Provider retrieval remains
unqualified.

## What this can establish

Observe fresh retrieval, cache-only behavior, warm-cache reuse, refresh and
reference navigation for the tested endpoint/model/mode/time. A successful live
control requires a new origin GET plus an exact hidden marker in tool output.
Cached origin GET/HEAD activity, or an unseen fresh marker, is a violation.
Both modes failing is inconclusive, including HTTP-200 `Internal Error` output.
Warm cached output A after rotation to B strengthens the cache evidence; a miss
does not establish warm-cache reuse. Live mode may use caches: failure to return B
does not by itself violate live mode. No claim of universal provider isolation,
guaranteed cache bypass, or upstream billing qualification.

Previous fresh URLs at httpbingo and trycloudflare failed upstream with no origin
hits. FakeCo supplies a third, stable hostname under our control. If fresh live
retrieval still fails, stop; hostname eligibility, entitlement and upstream failure
remain unresolved alternatives. Existing query/indexed-URL successes alone cannot
resolve them. No OpenAI clarification is assumed available.

## Isolated fixture

`wrangler.search-semantics.toml` targets account
`91b59577e757131d68d55a471fe32aca`, zone
`72b20df9e990ac41365dadace6499187`.

| Resource | Deployed |
| --- | --- |
| Worker | `clawrouter-search-semantics-fakeco` |
| Route | `https://clawrouter-fakeco.openclaw.ai/search-semantics/*` |
| Durable Object | New SQLite `SearchSemanticsObject`, binding `SEARCH_SEMANTICS` |
| Secret binding | `SEARCH_SEMANTICS_CONTROL_SHA256` |
| Public readiness | `/search-semantics/health` |

Original deployment ownership receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-deployment-receipt.json`.
Current deployment ownership receipt:
`.artifacts/fakeco-codex-search-20261022/paired-retrieval-receipt.json`.
Active normal fixture version: `9ea3e336-0cf8-41e0-b44b-09e448fd70cb` at 100%.
Current route ID: `dd2ae4273551492db92c3b5ffc367529` (Wrangler recreated the
prefix route during the approved paired retrieval/restoration;
semantics unchanged).
SQLite namespace ID: `148cbb6483b4421dbf8b25301a325865`.
Readiness returns 200 with `cache-control: no-store`; unauthorized controls return
404. The existing router remains on `3d669069-fb9e-45e0-a71b-bded66c5b7b2`;
its settings, deployments, custom domains, Access app, and unrelated routes are
unchanged. All 36 prior namespaces remain present.

Cache Rules and Page Rules API inspection returned 403 with the management token.
Subsequent authorized read-only Safari inspection confirmed **no Cache Rules,
no Cache Response Rules, and no legacy Page Rules** for this account/zone.
No settings or credential permissions changed. The reviewed fixture config has
no Workers Cache opt-in; allowed Worker settings/version reads also contain no
cache/exports opt-in. Cloudflare documents that [omitting the cache block disables
Workers Cache](https://developers.cloudflare.com/workers/cache/configuration/).
This is configuration evidence, not an empirical guarantee of every request.
The separately approved counter calibration below passed; the subsequent direct
Sol probe failed its live positive control. OpenAI search semantics remain unqualified.
The default-cache configuration page was not inspected after the user began
using other Safari windows; further browser actions stopped. Evidence receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-cache-inspection.json`.

Cloudflare supports a path route in front of an existing custom-domain Worker;
the route takes precedence for matching requests. See [Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/).
No router source imports the fixture. Original fixture provisioning did not
modify preexisting Workers, Access policies, custom domains, queues, R2 buckets,
KV namespaces or Durable Objects. Later diagnostic updates target only the
fixture Worker and its own stored state. The public prefix is outside the
existing FakeCo Access destinations;
the control endpoints enforce their own bearer authentication. Recheck that
baseline before later changes. Exact path-route creation is now exercised;
route deletion and the destructive namespace migration remain untested.

The fixed registry has at most 16 runs with four unique synthetic pages each.
Run expiry defaults to one hour, bounded to 60 seconds–two hours. Storage alarm
prunes expired runs; requests also reject expired runs before serving content.
Unknown public IDs do not allocate objects. GET/HEAD counters persist inside
serialized storage transactions. No IPs, user agents, raw requests or completions
are stored. Public page IDs contain no markers. Authenticated snapshots carry
markers in memory only; output logs contain closed metadata.

Page responses allow upstream caching for one hour, while CDN cache-control
headers disable Cloudflare/shared-CDN caching. No Cache Rule is provisioned.
Before probing, inspect effective zone cache rules/readiness headers and ensure
the route executes the Worker for every page request. Counters cover only these
registered paths, not robots requests or every network operation by the provider.
Observations are finite windows; delayed/background requests and attribution
cannot prove universal isolation. Keep snapshots before/after each operation and
check the run again before deleting it. The matrix waits two seconds after each
call and checks fresh cached-page totals again at the end for late hits. This
does not bound arbitrarily delayed provider background work. No public test page
is fetched by readiness.

## Completed hosted counter calibration

One approved run with five-minute expiry passed against the deployed fixture.
At exactly the same URL, two GETs and one HEAD produced exact totals of two GETs
and one HEAD. Rotation changed the hidden marker, retained the URL and totals,
and reset revision GETs. The next GET returned the new marker, with totals of
three GETs/one HEAD and one GET at revision 2. All other synthetic pages stayed
at zero requests. No cache-busting query or request directive was used.

Responses carried both CDN `no-store` headers and upstream-eligible
`Cache-Control: public, max-age=3600`; none reported `CF-Cache-Status` or `Age`.
Only the owned run was deleted. Its authenticated snapshot and public page then
returned 404. The registry Durable Object remains allocated under the existing
namespace; later namespace cleanup still requires its delete migration.
Fixture/main deployments, settings and routes match the immediate baseline.
No OpenAI calls or router application writes ran. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-calibration-receipt.json`.

This validates counter and rotation behavior for these HTTP requests. It does not
qualify provider live/cache-only semantics or all possible client/edge behavior.
Next: separately approved direct Sol probing using a fresh run and hidden markers.

## Direct Sol probe: inconclusive

The approved run completed at 2026-10-23 06:19:59 UTC. Direct
`/v1/alpha/search` calls for `gpt-6.1-sol` used separate sessions and unique
registered cached/live pages. Both returned HTTP 200 with tool-level
`Internal Error`, no hidden marker and no reported usage. All page GET/HEAD
counters remained zero. The live positive control failed, so the matrix stopped
after two calls; warm-cache, rotation, navigation, Astra, routed and native
follow-ups did not run. No cache-only semantics can be inferred from this result.

The fresh run was deleted. Its authenticated lookup and all four public pages
then returned 404; fixture/main deployments, settings and routes matched baseline.
No inference, router key registration or budget mutation ran. Upstream search
billing remains unqualified: absence of reported usage does not establish no charge.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-semantics-direct-sol-receipt.json`.

Request IDs: `req_b54c32a071fb40cbac57fa50b71e7ab0` (cached),
`req_ff15d09ec74943c29324de26d26d982b` (live).
A read-only Cloudflare GraphQL security-event query scoped to this run/time/path
returned a permission error, so it supplied no usable edge evidence. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-direct-sol-edge-events.json`.
Zero Worker counters leave both upstream no-fetch and pre-Worker edge rejection
possible.

### Completed read-only Safari Security Events inspection

At 2026-10-23 06:23 UTC, Safari showed the OpenClaw account and `openclaw.ai`
zone. Security > Analytics > Events was filtered to 2026-10-23 06:18–06:21 UTC,
covering both calls. The zone-wide view showed two Browser Integrity Check block
events, both for `docs.openclaw.ai`. Adding `Host equals
clawrouter-fakeco.openclaw.ai` produced `No firewall events found matching your
filters`; all summary panels showed no data. A host-only filter covers every
fixture path without a narrower path filter.

This supplies no affirmative evidence of a Cloudflare security block for the
probe. It does not establish that the provider attempted a fetch, nor exclude
pre-Worker rejection: [Security Events may use sampled data](https://developers.cloudflare.com/waf/analytics/security-events/#sampling).
The dashboard also states that Worker subrequests are not included. The Sol
semantics result remains inconclusive. No Cloudflare settings/resources changed,
no credentials were read, and no additional OpenAI calls ran. Safari remains on
the filtered result.

### Completed stable public-page positive control

2026-10-23 06:24:22–06:24:23 UTC: one approved direct `/v1/alpha/search`
operation for `gpt-6.1-sol`, fresh session, `external_web_access: true`, opened
`https://www.iana.org/help/example-domains` with short response length. A local
unauthenticated HTTP preflight returned 200 with the expected public content.
The search call returned HTTP 200, 1,963 output characters, a search reference,
and the expected page title, `example.com`, and RFC 2606 content. No internal,
reference, or fetch error was detected. Raw tool output and encrypted output
remained in memory; only closed metadata was saved.

Request ID: `req_d17eddfba2ee4a7b93874efce2a19d98`. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-stable-public-sol-receipt.json`.
Exactly one standalone search call; no retries, inference, Cloudflare API calls,
resource mutations, router application writes, PR or push. No usage reported;
upstream billing remains unqualified.

This confirms the direct Sol endpoint/request setup can return stable public
page content. It does not prove a live origin fetch, because existing public
content could come from a cache. The earlier fresh-fixture failures are not a
universal failure of this endpoint/request setup. Fresh retrieval, cache-only,
rotation and navigation semantics remain unqualified.

### Completed read-only public fetch prerequisite inspection

2026-10-23 06:25:24–06:25:26 UTC: nine unauthenticated public HTTP GETs,
DNS lookups and one strict TLS connection. No OpenAI/Cloudflare API calls,
credential reads, fixture runs, registered page requests or resource mutations.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-fetch-prerequisites-receipt.json`.

- Both A and AAAA lookups resolved (three records each). Strict hostname/chain
  verification passed over TLS 1.3; the presented certificate expires
  2027-01-21 03:37:36 GMT. This verifies reachability from the operator's machine.
- HTTPS `/robots.txt` returned the router's JSON `route_not_found` 404 for an
  ordinary diagnostic user-agent and the published OAI-SearchBot/ChatGPT-User
  strings. No robots directives, challenge indicators, authentication challenge,
  or redirect. HTTP `/robots.txt` also returned the same 404. A 4xx robots
  response is unavailable under [RFC 9309 §2.3.1.3](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.3.1.3),
  which permits crawling; it is not an explicit disallow policy. This does not
  establish the alpha endpoint's implementation or cached robots state.
- `/search-semantics/health` returned the expected fixture JSON with HTTP 200
  and `Cache-Control: no-store` for all three user-agent strings. No redirect or
  detected challenge. `/search-semantics/robots.txt` returned fixture 404; the
  standard robots location is at the origin root, outside the fixture route.
- `/` returned a same-host 302 to `/dashboard`. The health URL did not redirect;
  do not follow the dashboard path for a public-fetch control.

The reviewed fixture/config remain byte-identical to commit `77bf4ac`. Source
inspection confirms public pages are plain static HTML without JavaScript or
authorization, but send `X-Robots-Tag: noindex`, require the exact HTTPS host and
two UUID path components, and reject all query strings. The `noindex` header is
an indexing/eligibility variable, not proof of a fetch block. The observed
zero-hit fresh calls never obtained that page's header from this Worker, so it
cannot directly explain their failure on first fetch. Provider handling is
unqualified. The [official OpenAI crawler documentation](https://developers.openai.com/api/docs/bots)
distinguishes search crawlers from user-triggered fetches; it does not document
alpha/search handling of this fixture/header. User-agent checks here do not
impersonate verified OpenAI egress or establish IP-based security behavior.

No confirmed public-fetch prerequisite blocker found. No live registered HTML
page was rechecked because the prior run was deleted and this inspection was
read-only. Fresh/cache-only semantics remain inconclusive. Next bounded
comparison proposal: one direct Sol live-mode open of the existing
`https://clawrouter-fakeco.openclaw.ai/search-semantics/health`, fresh session,
no inference/retry/Cloudflare mutation. Expected public health fields can test
same-host provider retrieval without creating a run. Success would still not
prove fresh HTML retrieval; failure would preserve host/network/robots/provider
policy uncertainty. Do not change robots, noindex or security settings on this
evidence alone.

### Completed same-host health positive control: failed

2026-10-23 06:26:41–06:26:42 UTC: one approved direct Sol alpha/search
live-mode open of the existing fixture health URL, fresh session, short response
length. Local HTTP preflight returned 200 with the correct fixture/environment/
ok fields and `Cache-Control: no-store`. The provider returned HTTP 200 with
273 output characters and a tool-level `Internal Error`; fixture identity and
`ok: true` content were absent. A reference appeared in the output, but this
does not establish successful retrieval. Request ID:
`req_1969c4ec241d43d3b9af621f3f5b2f1a`.

Receipt: `.artifacts/fakeco-codex-search-20261022/search-fixture-health-sol-receipt.json`.
Exactly one call; no retries, inference, Cloudflare API calls/mutations, fixture
run creation or router application writes. Only metadata persisted. No reported
usage; billing remains unqualified. No PR or push.

The failure also occurs at this stable, public, non-UUID URL with no `noindex`
header. It is not confined to registered synthetic HTML pages. It does not
establish the same underlying cause across both failures: the controls also
differ in host, content type and provider cache/history. Health has no origin
counter, so do not infer zero requests from this result. Stable IANA retrieval
still passed; same-host provider retrieval and fresh/cache-only semantics remain
unqualified. Next candidate: inspect Cloudflare bot/security settings read-only
for host-relevant restrictions before preparing any targeted fixture/config
change. Do not broaden permissions, disable protections, add robots rules, or
repeat paid probes based on the generic error alone.

### Completed read-only Safari bot/security inspection

2026-10-23 06:27–06:29 UTC: verified the OpenClaw account and `openclaw.ai`
zone in the existing Safari session. Opened configuration drawers for reading,
then closed them without Save/Apply or changing any value. No credential reads,
Cloudflare API calls/resource mutations, OpenAI calls, PR or push.

Observed in Security > Settings:

- AI bot policies: Search, Agent and Training each `Allow (do not block)`;
  Bot Preference Sync off. AI Labyrinth off; Precursor off.
- Super Bot Fight Mode: definitely automated traffic `Allow`, verified bots on,
  JavaScript detections off. Static-resource protection state was not qualified.
- Browser Integrity Check on. Security level is automated; its drawer explicitly
  showed `I'm under attack mode: disabled` and an off switch.
- Cloudflare Managed Ruleset and OWASP Core off. HTTP, network-layer and TLS
  DDoS protections always active. Schema validation on, but zero endpoints and
  zero active schemas shown. This does not establish per-request behavior.

Security > Security rules showed no Custom rules (0/20), Rate limiting rules
(0/2), or Managed rules; Response rules showed Cloudflare default protection.
Rules > Overview showed one active Configuration Rule, `Catalog public API
clients`, matching exactly `catalog.openclaw.ai`, with Browser Integrity Check
as its displayed action. It does not match FakeCo. No Origin, URL Rewrite,
Request/Response Header Transform, Cache or Cache Response rules were present.
The two redirects matched other hostnames. No FakeCo BIC exception was visible
in these viewed rules. Account-level inherited restrictions were not separately
audited; do not call this an exhaustive effective-policy proof.

AI Crawl Control > Security, filtered to OpenAI with inactive crawlers included,
showed `Block Crawler` off individually for ChatGPT-User, OAI-SearchBot and GPTBot
(verified in both screenshot and accessibility state). Seven-day zone-wide
allowed/unsuccessful counters were not attributed to this host or probe.

Finally, Security Events filtered to `Host equals
clawrouter-fakeco.openclaw.ai`, 2026-10-23 06:18–06:28 UTC, showed no matching
firewall events and no summary data. This covers the original fresh-page calls
and the later health control. Sampling/excluded-request caveats still apply.
Safari was left on this result, with no configuration drawer open.

No explicit OpenAI crawler block found. BIC is a plausible, unconfirmed
candidate: [Cloudflare documents header-based bot/crawler challenges and selective exceptions](https://developers.cloudflare.com/waf/tools/browser-integrity-check/).
Enabled BIC plus no visible FakeCo exception does not prove that it rejected
these requests; there is no matching event or response evidence.

Next candidate for preparation/review, not execution: a temporary BIC-only
exception limited to the exact FakeCo hostname and the public health/robots
GET/HEAD paths, preserving all application authorization and other protections.
Include robots in the proposed scope because rejection of a prerequisite robots
fetch could otherwise confound a health-only test. Verify current effective rule
scope and mutation/cleanup path first; prepare the exact rule, original-state
comparison, one-call Sol control and deletion/absence checks before requesting
approval. No zone-wide disable, inference, fixture deployment or broader
semantics matrix is justified by this inspection. A failed comparison would
remain inconclusive, not rule out all Cloudflare/provider restrictions.

Prepared follow-up: [exact BIC rule, one-call comparison and cleanup](search-semantics-bic-probe.md).
Read-only API refresh at 2026-10-23 06:32 UTC confirmed zone BIC `on`, but the
Configuration Rules phase read returned 403/code 10000. No auth fallback.
Safari inspection qualified the existing Catalog rule as BIC off for only
`catalog.openclaw.ai`; its editor was cancelled unchanged. A separate narrow
FakeCo form is populated but unsaved. No Cloudflare writes or paid calls in
this preparation; browser create/delete permissions remain unproven.

## Approved temporary BIC health comparison

User approved the prepared exception, one Sol search call and removal of the
named disposable rule. Preflight at 2026-10-23 06:35:44 UTC confirmed zone BIC
`on`, fixture health 200 with expected identity, and the unchanged sole Catalog
rule. Safari showed `Rule validation passed` before deployment.

The exact [prepared payload](../config/search-semantics-bic-probe.json) was
deployed once through Safari. Rule ID
`9111c95048fc49808b65af773c1476b5`; submission recorded at 06:36:18 UTC,
active verification recorded at 06:36:32 UTC. It appeared second/last, active,
with the exact host/method/path/empty-query expression and only BIC off. Global
BIC and the Catalog rule were not changed. Public health remained 200 with
expected fixture JSON, root robots 404, neither challenged nor redirected.
Allowed over 60 seconds after active verification before the provider call;
this does not independently establish propagation to the provider's edge.

Exactly one direct `gpt-6.1-sol` `/v1/alpha/search` call, fresh session,
`external_web_access: true`, short output, opening the existing public health
URL. Attempt 2026-10-23 06:37:40 UTC, complete 06:37:41 UTC:

- HTTP 200; request ID `req_752aecefcc0d49bfb3e20898a80dc1bc`.
- 273 output characters, `Internal Error`; no fixture identity or `ok: true`.
  A search reference and the `fakeco` substring did not establish retrieval.
- No usage field. Billing remains unqualified; no inference, retries, fixture
  runs, router registrations or broader matrix.
- Health has no origin counter: no origin-hit or no-hit conclusion is possible.
  No raw or encrypted output or secret values persisted.

Receipt: ignored operator artifact
`.artifacts/fakeco-codex-search-20261022/search-fixture-health-bic-sol-receipt.json`.
Ownership/cleanup journal:
`.artifacts/fakeco-codex-search-20261022/search-bic-experiment-ownership.json`.

Cleanup followed immediately. Reopened and matched the new rule's recorded ID,
name, exact expression and BIC-only action; deleted only that disposable rule
through its row menu and named confirmation dialog. Deletion observed at
06:38:16 UTC. A fresh dashboard load showed one active Configuration Rule:
original Catalog ID `a260a98b2a824554a8eacbb7eabcb095`, original hostname-only
expression and BIC off, inspected read-only and cancelled unchanged. Security
Settings showed zone-wide BIC still on. Final public checks at 06:38:49 UTC:
fixture health 200/expected JSON, main health 200/FakeCo/version
`3d669069-fb9e-45e0-a71b-bded66c5b7b2`, robots expected 404. Safari was left on
the Configuration Rules inventory with only Catalog present. Dashboard absence
qualifies configuration cleanup, not instantaneous global edge propagation.

The exception did not resolve retrieval in this comparison. Result remains
inconclusive about cause; it neither proves nor rules out a BIC-related failure,
provider/robots caching, propagation, inherited restrictions or other fetch
failures. Live-origin fetching and cached/live semantics remain unqualified.
Browser creation/deletion is now empirically qualified for this temporary rule
in this zone; token API write permissions remain unqualified. No Worker, route,
DNS, Access, credential, budget or namespace changes in this experiment. Stop
here; any further paid probe or Cloudflare mutation needs separate approval.

## Read-only follow-up and locally prepared HTML diagnostic

After the BIC comparison, Safari Security Events filtered to exact host
`clawrouter-fakeco.openclaw.ai`, 2026-10-23 06:36–06:39 UTC, showed no matching
firewall events and no summary data. This includes the 06:37:40 UTC provider
attempt. Sampling/excluded-request limits remain; it is not proof of no fetch
or no edge rejection.

The fixture Worker overview explicitly showed Workers Logs and Workers Traces
disabled. Its Observability view showed `Workers Observability is Disabled`.
The main `clawrouter-edge-fakeco` Worker Observability view showed the same
disabled message; it handles the root robots path. No retained invocation data
was available through either view. Neither Enable Observability button was
clicked. No Cloudflare settings changed, credentials read or paid calls made.
Safari was returned to the filtered Security Events result.

Prepared locally: [stable HTML diagnostic and rollout/cleanup](search-semantics-diagnostic.md).
Adds one authenticated, expiring generation at a fixed public URL, transactional
GET/HEAD counters and timestamps, and generation-specific deletion. Existing
health/matrix behavior, routes, bindings and migration configuration stay intact.
No deployment or hosted generation creation in this preparation. Worker
TypeScript check and 18 focused workerd fixture/matrix/probe tests passed.

## Approved stable HTML deployment and hosted calibration

Completed 2026-10-23 06:53:10 UTC. Reviewed source `12b5383` deployed once to
the existing fixture Worker as version
`d29dd6b3-ceed-4d2c-93f5-c60fe791df26`, replacing version
`7c4bb07f-e01e-42f1-a784-7e58de842462`. Wrangler recreated the owned route as
`a7df3050ed59443aa1b2f96362ecdd94`; old ID
`3027364f1df44bcfa2b39ce11a1fea14` is absent. Read-only reconciliation proved
the route inventory differs only by that ID, and Worker settings only by the
reviewed deployment annotations. Bindings/runtime, namespace, main Worker,
domains and Access stayed unchanged; BIC remains on. This section's version and
route ID are historical; use the current ownership record above for cleanup.

One five-minute diagnostic generation produced matching HTML on two GETs,
empty HEAD output, exact durable counters 2/1 and correct timestamps. Private
snapshots did not increment counters. All cache headers were `no-store`; no
`CF-Cache-Status` or `Age` was reported. Deleted only owned generation
`690a3d4e-7849-4e84-a5b2-e751978766cc`, then verified private generation and
collection lookups plus public GET/HEAD all returned 404. Immediate postflight
infrastructure matched baseline. Both prior owned matrix controls remained 404;
no active matrix run was available for a hosted counter-independence comparison.
Local workerd independence tests passed. No matrix run, router write, budget
change, security change, paid search/inference call, PR or push in this batch.

Receipts: ignored `search-diagnostic-deployment-receipt.json` and
`search-diagnostic-calibration-receipt.json` under
`.artifacts/fakeco-codex-search-20261022/`. Full interface, evidence limits and
next separately approved one-call comparison:
[stable retrieval diagnostic](search-semantics-diagnostic.md). This validates
hosted diagnostic behavior, not OpenAI fetching, cached/live semantics or billing.

### Single Sol diagnostic comparison: inconclusive

2026-10-23 06:55:53.557–06:55:54.386 UTC: exactly one separately approved
direct `gpt-6.1-sol` `/v1/alpha/search` open of the stable HTML diagnostic URL,
fresh session, external web access enabled, short output. Fresh five-minute
generation `6f5c413f-dcae-4a37-95e6-81b12ec5fc5a` started at zero counters;
the operator made no public diagnostic request while active and kept the marker
out of the provider request. Preflight matched calibrated deployment/route/
bindings/namespace and healthy FakeCo. BIC on; refreshed Safari Configuration
Rules inventory contained only the original active Catalog rule.

HTTP 200, 281 output characters, tool-level `Internal Error`, no expected marker;
request ID `req_eb5773ea178843b1afd9baea22e0b728`. A returned search reference
alone does not qualify retrieval. Immediate counters and the final snapshot at
06:56:09.923 UTC, after a 15-second late-request window, were both zero GET/HEAD
with null timestamps. No accepted diagnostic handler activity; upstream no-fetch,
prerequisite/URL/network failures and pre-Worker rejection remain possible.
This is not proof of no network attempt or a cached/live semantics result.

Owned generation deleted; private generation/collection and public GET/HEAD
returned 404 at 06:56:10.595 UTC. Infrastructure unchanged. No retries, inference,
broader matrix, router/budget/security/deployment changes, PR or push. Only closed
metadata persisted; no usage reported and billing remains unqualified. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-diagnostic-sol-receipt.json`.
Stop after this one call. Any further paid probe or Cloudflare mutation requires
separate user approval.

### Read-only event follow-up and prepared request observations

Safari Security Events filtered to exact FakeCo host, 2026-10-23 06:55–06:57 UTC,
showed no matching firewall events and no summary data. The zone-wide BIC block
in that interval belonged to `docs.openclaw.ai`. No affirmative edge-block
evidence; sampling/excluded requests still prevent a no-network/no-block claim.
No Cloudflare setting changed; Safari remains on the exact-host result.

Prepared locally: [temporary request observations](search-semantics-request-observation.md).
An optional fixture wrapper observes robots forwarding and rejected/public fixture
requests using only fixed method/path categories, query-presence, status and
bounded aggregate counts. One five-minute authenticated session in a separate
fixed object of the existing namespace; independent alarm and owned deletion.
Temporary robots route and main-Worker service binding have deployment/restoration
steps prepared. Normal fixture and main router source stay unchanged. No hosted
session, deployment, new live route/binding or further search probe in this batch.
Worker TypeScript and 24 focused fixture/observation/matrix/probe tests passed.
Autoreview of `c1a1ae2` completed with no actionable P0–P2 findings. Hosted
equivalence still requires separately approved calibration.

### Approved request-observation attempt and restoration

Completed 2026-10-23 07:11:24 UTC. Temporary version
`e0e2c851-3f43-4062-94af-ec0c47715b77` deployed successfully; four robots
response comparisons matched the main-Worker baseline. Observation-session
creation returned non-2xx, with no ID recorded. HTTP status was not retained;
root cause remains unresolved. No diagnostic creation or seven-request counter
calibration ran. No paid search/inference calls or router writes.

Temporary robots route `0d2f713b00354801882592550300ace4` deleted; temporary
service binding removed. Normal source bytes restored, with current resource
IDs above. Base settings/runtime, main Worker, namespaces, unrelated routes,
domains, Access and BIC preserved. Private collection and public diagnostic checks
returned 404 before restoration; this does not independently prove execution or
cleanup of the observation handler. No owned session ID; retain the namespace
for its existing class-deletion cleanup.

Post-restoration control POST with invalid literal `null` returned 400
`invalid_input` at 07:13:14 UTC. Current authentication works; no generation
created. Temporary handler/version issues remain possible. Operator status
journaling corrected locally; no automatic retry or redeploy. Hosted counters
remain unqualified. Further mutation/probe batches require approval. See
[full evidence and restoration](search-semantics-request-observation.md#approved-deployment-attempt-and-restoration).

API inventory was refreshed for this batch. A Safari focus change interrupted
read-only rule-inventory refresh; the latest browser rule observation remains
the earlier inspection. No browser settings were changed.

### Local follow-up: mixed-version reproduction and readiness gate

Read-only inventory matched the restored deployment. Actual Wrangler bundle
passed an in-place normal/observed/normal upgrade locally. Pairing the new Worker
with the old Durable Object reproduced creation 404 and collection 404, showing
why empty-state checks alone were insufficient. Historical root cause remains
unconfirmed because the failed HTTP status was lost.

Prepared locally: authenticated no-session observation readiness GET, fixed
object-handler response marker, helper readiness gate before any creation POST,
and numeric HTTP status in helper failures. No normal-fixture/main-router or
configuration changes. Regression tests cover the mixed-version boundary and
prevent a readiness failure from reaching POST; readiness stores no session or
alarm. Nothing deployed. See [diagnosis and retry requirements](search-semantics-request-observation.md#local-diagnosis-and-prepared-readiness-correction).

### Reviewed runner and fresh read-only preflight

Completed 2026-10-23T07:28:15.575Z. Reviewed frozen operator commit `5fc8431`
(runtime source `593a2fa`) scoped-clean through P2; eight offline operator scenarios
passed, including read-only mode, readiness delay, ambiguous writes and cleanup/
restoration failure. Local operator bytes match the reviewed copy. No main-router,
fixture runtime or configuration change in this step.

Fresh preflight passed: current normal version/route/namespace above, three normal
bindings, no temporary robots route/service binding, main Worker and unrelated
infrastructure hashes unchanged. Authentication validation with literal `null`
returned 400 `invalid_input`; no session created. Access challenge intact. No
Cloudflare resource writes or paid search calls. Browser rule inventory remains
historical. Hosted counters remain unqualified; next mutation batch needs approval.
See [review, exact runner and failure custody](search-semantics-request-observation.md#reviewed-runner-and-fresh-read-only-preflight).

### Approved readiness calibration: six of seven captures; normal restored

Batch 2026-10-23 07:29:05–07:35:04 UTC. Temporary version
`fea5430a-e2ae-448e-84df-611db7e45c8b` passed readiness, marked empty baseline and
both session creations. All seven public responses passed. Final observation
read and its sole DELETE returned unmarked 404. Later private reads found the
owned session active with six counts: only diagnostic trailing-slash GET was
missing. No overflow/saturation; expiry unchanged. Final diagnostic-counter
assertions did not run. Calibration remains incomplete; initial readiness was
insufficient to establish stable capture/handler identity. Cause unconfirmed.

Diagnostic owned DELETE acknowledged and absence verified. Observation DELETE
not retried: its five-minute TTL elapsed, then marked collection/owned-ID 404
verified at 07:34:27 UTC and reverified at 07:34:49. Reviewed restoration-only
entrypoint `47cb04c` (P0–P2 scoped-clean) completed the already-approved cleanup.
Temporary robots route `7ac3c4e743d145dc8f18a7ae43c4bae4` deleted; normal code
bytes restored, temporary service binding absent. Current ownership above
supersedes prior IDs. Main Worker, runtime/base bindings, namespace, unrelated
infrastructure, Access and BIC preserved. No paid search, router writes, secret
changes, new namespace, PR or push.

Receipts: ignored `request-observation-readiness-calibration-receipt.json`,
`request-observation-readiness-restoration-receipt.json` (current ownership), and
`request-observation-readiness-batch-summary.json`. Full
[evidence, capture table and cleanup](search-semantics-request-observation.md#approved-readiness-deployment-incomplete-calibration-and-qualified-restoration).
Do not replay either executed batch. Further mutations need approval; paid
comparisons remain gated on successful hosted observation calibration.

## Secret and credential preparation

The operator reads the existing FakeCo `ADMIN_TOKEN` from 1Password in memory.
`fixtureControlToken` derives a separate HMAC-SHA256 token with a fixed fixture
control context. Upload **only its SHA-256 digest** as the fixture secret. Never
upload the admin token to the fixture, print derived tokens, put them in argv, or
persist them in an env file. Regenerate the token in memory for probes.

`prepareSemanticsCredential` prepares a separate router key and registration
digest, purpose-separated by context and credential ID. Candidate policy and
credential ID: `codex_search_semantics_20261022`; verify both absent first. If either
exists unexpectedly, stop and choose a new ID. The key has a two-hour expiry and
uses `config/search-semantics-canary-policy.json`: Sol/Astra, OpenAI only,
no fallback, retention off, $0.001/search, inference token pricing, $50 policy cap.
Never reactivate `codex_search_canary_20261022` or reset existing spend.

Before native tests, refresh provider/policy ledgers. The previous provider cap
was $50 with $3.614986 spent: its remaining $46.385014 cannot cover the known
$46.7144 conservative Astra opaque-input reservation. A **separately approved**
provider cap increase to $100 would provide headroom without resetting spend.
Reserve estimates are not actual charges. The $200 campaign allowance is the
outer authorization; router tariffs/caps do not qualify alpha/search billing.

## Staged execution (each Cloudflare write batch needs approval)

1. Read-only refresh: Worker/domain/zone route inventories, Access destinations,
   cache rules and relevant credential metadata. Require exact existing FakeCo
   ownership, new fixture Worker absent and no overlapping route. Read-only
   permission evidence cannot guarantee writes or later deletion.
2. **Completed approved write batch:** deploy the dedicated Worker + new DO migration
   and exact path route, then install its control digest through stdin. A missing
   digest fails closed for all controls; no pages exist before authenticated run
   creation. Record Worker version, route ID and namespace ID immediately, even
   after partial failure. Verify route ownership, environment, digest binding
   name, public readiness, unauthorized control denial and existing FakeCo health.
   Deployment does not include router credential/budget changes or paid probes.
3. **Separate approved direct probe batch:** use the hosted controls to create,
   rotate and delete one run per model. Run `probe-search-semantics.mjs --target
   direct --model gpt-6.1-sol`, then Astra only after a successful Sol live control.
   Inject `CLAWROUTER_SEARCH_LIVE=1`, `SEARCH_SEMANTICS_CONTROL_TOKEN` and
   `OPENAI_API_KEY` in memory. At most seven standalone search calls/model,
   no inference; a failed fresh live control stops after two calls. Save closed
   result metadata plus final snapshots projected to counters only.
4. Only after direct fresh retrieval succeeds: **separately approve** the new
   scoped policy/key registration and provider headroom change, then routed
   matrix runs (`--target router`, `CLAWROUTER_SMOKE_KEY`). Fresh runs and sessions
   prevent direct/routed page or history contamination. Capture authoritative
   provider/policy spend and usage baselines; after each run wait for queue drain
   and reconcile correlated receipts. The standalone matrix reports semantics,
   not accounting qualification; native harness retains its accounting checks.
5. Native Codex: use existing harness with `--router-url
   https://clawrouter-fakeco.openclaw.ai --expected-environment fakeco
   --origin-only --hosted-origin --model MODEL --web-search live
   --transport websocket --max-budget-micros 50000000`. Then cached in a separate
   fresh run; extend to HTTP only if material. Inject fixture control and new
   router credentials only into the parent; Codex receives a synthetic key and
   isolated HOME. At most 32 operations/run, 4,096 output tokens/inference. Cached
   no-fetch is reported inconclusive by this single-mode native test; combine
   with the successful live control explicitly, never call a cached fetch a pass.

The direct/routed matrix checks fresh cached/live URLs, warm A → rotated B,
then live refresh and live click/find when references/link IDs are returned.
Mode flags are explicit per call; reference navigation retains its own session.
An `observed` status establishes only the populated observation flags; warm reuse,
refresh and navigation each have separate booleans and may remain unqualified.
The native harness still checks mode preservation on every native search call.

## Cleanup prepared before provisioning

Probe `finally` deletes only its own synthetic run and reports deletion failure.
Expiry limits exposure after a crash; it does not substitute for operator cleanup.
Before deletion, take a final counter snapshot and compare cached-only pages for
late hits. Never persist the private snapshot containing markers.

After user approval for cleanup, revoke only the newly registered semantics key,
settle receipts/drain queues, preserve usage evidence, and cap/disable only its
new policy. Restore any provider limit **only after** reading current spend and
confirming no unrelated operator changed the setting; never reset spend or set a
cap below settled spend accidentally.

Then read exact recorded ownership IDs and all account bindings to the new DO:

1. Remove only the recorded route with `DELETE
   /zones/72b20df9e990ac41365dadace6499187/workers/routes/{recorded-route-id}`;
   confirm the pattern and Worker match first. Verify route absence and original
   FakeCo health.
2. With the fixture Worker still present, deploy
   `wrangler.search-semantics.cleanup.toml`. It removes the class export and DO
   binding and applies `v2-delete-fixture` with
   `deleted_classes = ["SearchSemanticsObject"]`. This is the supported namespace
   deletion mechanism, not an assumed standalone namespace DELETE API. Confirm
   no other Worker binds to the namespace; fail on an unexpected migration tag.
   Verify the exact recorded namespace disappears from account inventory.
3. Delete only the now-empty Worker via `DELETE
   /accounts/91b59577e757131d68d55a471fe32aca/workers/scripts/clawrouter-search-semantics-fakeco`.
   Confirm absence, including its secret binding and deployments. Do not rerun
   the normal fixture config after the delete migration.

Cloudflare documents that [delete migrations remove a class and its stored data](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/).
Record partial cleanup failures and stop on any ownership/binding mismatch.
Delete permissions cannot be exercised read-only. Do not delete the existing FakeCo custom domain,
router Worker, shared Access app/service token/IdP, or original canary resources.
Those remain under their separate campaign cleanup record and user approval.


## Observation transition follow-up, preparation only

Runtime `d3af38c` reproduces a post-readiness transition to the actual normal
object handler locally: capture/control 404s leave an active session with a
missing trailing-slash request. This is a possible failure mechanism, not proof
of the historical hosted cause. Prepared v2 instrumentation separates private
Worker/object protocol identities, validates explicit capture acknowledgements,
and exposes bounded isolate-local failure counts without changing public replies.

The new runner requires three matching readiness checks, resets on an old-handler
404, and checks the durable counter prefix after every public request. A later
transition or missing capture cannot qualify the experiment. Readiness samples
and isolate-local counters do not prove deployment-wide consistency.

Thirty focused tests, Worker type checking and the observation Wrangler dry run
pass; twelve offline runner scenarios pass. Runtime autoreview is scoped-clean
through P2. New preparation details, operator review and read-only preflight are
recorded in [Temporary request observations](search-semantics-request-observation.md#local-transition-reproduction-and-stability-preparation).
At that preparation stage, no new hosted calibration or paid comparison had run;
hosted counters, retrieval semantics and upstream billing remained unqualified.
The approved v2 calibration below supersedes that instrumentation status.

Read-only preflight passed 2026-10-23T07:45:28.992Z: current normal deployment,
route, three bindings, namespace/main identity, Access, BIC and robots baselines
match the restoration receipt. Operator review found one inventory-evidence P2;
`5bf1ed4` corrects it and is scoped-clean through P2. No Cloudflare writes, hosted
session creation/deletion or paid calls. Preparation receipt:
`request-observation-stability-preparation-receipt.json` in the campaign artifacts.


## V2 observation calibration passed

Approved 2026-10-23 07:46:25–07:47:09 UTC batch passed all seven expected public
responses and all seven exact durable counters, checked after every request.
Three consecutive readiness checks matched both private protocol identities.
The previously missing trailing-slash request was captured. No overflow or
saturation; diagnostic GET/HEAD durable counts 1/1, marker checked only in memory.
Both owned sessions deleted exactly once and marked absence verified before
restoration. Normal code bytes, three bindings, namespace, main Worker, unrelated
infrastructure, Access and BIC preserved. Temporary robots route/service removed.
Current version/route/receipt above supersede previous ownership records.

[Calibration evidence](search-semantics-request-observation.md#approved-v2-hosted-calibration-and-normal-restoration).
This qualifies the tested synthetic instrumentation only. Historical failure cause,
provider retrieval semantics and upstream billing remain unresolved. No paid call,
inference, router write, secret change, security relaxation or broader cleanup.
A paired known-content/FakeCo retrieval comparison now requires its own approval,
freshly pinned operator/preflight and qualified cleanup/restoration plan.


## Paired experiment ready for approval

[Prepared batch](search-semantics-paired-retrieval.md): frozen operator
`0f45b1f`, review scoped-clean through P2, thirteen offline scenarios and five
standalone-probe tests pass. Read-only preflight passed 2026-10-23T07:54:45.783Z;
current normal version/route/infrastructure unchanged. Public IANA HTTP control
checks pass. No Cloudflare writes, hosted sessions or paid search calls. Pending
approval covers temporary wrapper deployment, IANA then conditional FakeCo
(at most two direct Sol search calls), owned cleanup and normal restoration.
No approval or execution receipt exists yet; billing remains unqualified.


## Paired retrieval completed; fresh control still unqualified

Approved 2026-10-23 07:56:17–07:57:15 UTC pair used two direct Sol search calls.
IANA returned expected content. Only then were fresh FakeCo sessions created;
FakeCo returned HTTP-200 tool-level `Internal Error` with no fresh marker.
Initial, immediate and 15-second late counters: no recorded requests (including
robots), diagnostic GET/HEAD 0/0, no overflow/saturation. Controls consistently
identified the compatible Worker/object during the observation window. No
operator public FakeCo requests during active sessions. Both owned sessions
DELETEd once with marked cleared-state verification; temporary routing removed,
normal code/three bindings restored. Current ownership above supersedes the prior
stability-calibration receipt/IDs. Read-only follow-up observed normal unmarked
controls after a transient v2 marker during normal deployment propagation.

[Detailed evidence and limits](search-semantics-paired-retrieval.md#approved-execution-and-inconclusive-result).
Known IANA content can be cached; this does not establish live origin fetch
capability. Zero best-effort observations do not identify the failure layer.
Fresh FakeCo retrieval, cached/live semantics and upstream billing remain
unqualified. Larger matrix and further paid probes remain gated. No inference,
router write, secret change, security relaxation, new namespace, PR or push.
