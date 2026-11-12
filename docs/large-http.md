# Bounded large Responses HTTP requests

Supported Responses create/compact requests with a known body length through
32,000,000 bytes use the ordinary Worker route. Larger supported bodies through
64 MiB use exclusive native runtimes with the canonical authentication,
provider selection, budget, retention, accounting and continuation behavior.
Other protocols keep their existing limits.

Existing accounting and retention admission limits still apply. In particular,
a retained archive admits at most 8,388,608 aggregate UTF-16 string units and
8 MiB + 64 KiB of JSON wire/text accounting, including its metadata. An
oversized retained archive receives `503 accounting_preflight_unavailable`
before provider dispatch.
These are unchanged main limits; 64 MiB body-success proofs use a policy with
request retention disabled. Retention-enabled comparisons cover bodies through
1 MiB and do not establish 64 MiB retained-request support.

Unknown-length requests classify bytes through the existing 32,000,000-byte
Worker envelope using the canonical JSON admission and its shared body budget.
Complete bodies within that envelope retain ordinary routing and authentication.
Their admitted bytes transfer directly to the canonical JSON parser on the
original Request, without a replacement stream or a second admission pass.
Larger bodies transfer the retained prefix and unread tail to native capacity
without a tee or copy. Classification uses filled 16 KiB BYOB buffers and no
upload-speed deadline. Consumption, refusal and cancellation retire the prefix.
Once a native handoff consumes its retained prefix, its canonical Worker body
charge retires; waiting for provider headers cannot reserve ordinary body
capacity. Ordinary parsed bodies keep their existing lease lifetime.
Known bodies through 32,000,000 bytes bypass classification and native admission
synchronously, without reading the body or accessing native capacity.

Normal deployment packages the native runtime as a content-addressed private
static asset in the same version as the Worker and its existing dashboard assets.
Only authorized native bootstrap fetches that artifact through the asset binding;
ordinary Worker startup never imports or creates a JavaScript string for it.
Worker-first routing also guards direct artifact URLs. The deployment preserves
main's compatibility date and flags. Native bootstrap checks the exact byte count
and SHA-256 digest before executing code.
JSON admission owns classification for both known and unknown
lengths; unrelated routes and WebSocket upgrades use the original routing
function without an extra asynchronous wrapper. Deployment provisions the
internal control secret if absent, binds the SQLite pool/slot actors and native
application, and activates maintenance every five minutes. Public requests do
not synchronously start native capacity. Deployment must preserve existing actor generations and
settlement ownership; uncertain inference is never replayed during rollback.

Default native limits are eight slots, two simultaneous requests per tenant,
24 starts per slot per hour, a one-hour incarnation age and 64 admissions per
incarnation. Replacement is serial, normally beginning at 48 admissions while
spare capacity is available. These limits can cause pre-dispatch 429/503
responses. They do not guarantee throughput for dozens of large-body clients.
There is no waiting-body queue or inference replay. Uncertain delivery returns
nonretryable 424. Disabling `LARGE_HTTP_ENABLED` restores the Worker envelope;
operator rollback must first preserve/drain outstanding owners.

## Integrated qualification status

This branch integrates pinned main
`17cb1a003efa00e572f2c88f227517c5bd9008f3`. Integrated functional validation,
review, and direct performance comparison are in progress. The historical
measurements below describe an earlier source pair and do not qualify this
integrated candidate against the new baseline. Main remains pinned during this
cycle; production is unchanged and the PR remains unpublished.

## Historical qualification (previous baseline)

Sole pinned main is `4333686cf27ff5ab99c09aa7dcb0634038232e8f`; measured
runtime candidate is `b835c9a7982086572a2ef9a52d1f5e07f006afa6`. Later branch
changes are documentation only. Neither runtime pin advanced during this cycle.
**Verdict: evidence supports no material performance regression within the tested
overall client profile.** This is an engineering assessment, not a guarantee
that every diagnostic interval excludes 5% or that resource performance is equal.
The unary first-byte limitation and other uncertainty below remain explicit.

The standard changed on 2026-11-11: 5% is contextual relative materiality
guidance; absolute latency and operational consequences provide context rather
than a universal +5/+10 ms veto. We need not distinguish zero from an immaterial
change. Important material harm cannot be offset by faster unrelated cases.
Original observations, intervals and historical numerical gates remain preserved.

The complete hosted evidence comprises three ordinary-configuration current-plan
Cloudflare studies: 16, 16 and 24 immutable main/candidate deployment pairs on
eight independent Crabbox AWS c7i.2xlarge hosts per study. Independent canonical
backends and disjoint equal-length credentials preserve product caching without
cross-arm reuse. Both physical path assignments occur within each AWS host;
execution order alternates. Normal connection pools, natural reconnections,
full drains and candidate maintenance remain included. The upstream is synthetic;
no timing or candidate-cost subtraction is applied.

All studies execute the same four 32-client cases, with 32 warmup and 32 measured
requests per arm/context/case. The first two use 64 contexts per deployment;
the targeted study uses 32. Overall: **1,441,792 client observations across
56 deployment pairs and 24 independent AWS hosts**, plus 448 strict functional
gates. The legacy small-H1 case identifier says c1; actual concurrency here is 32.
Every case's standalone first/total p50/p95, full-lifecycle rates and errors are
preserved. Targets were known 16 KiB H1 and native API H1 streaming before launch;
only those add combined inference over all three complete corpora. Previously
resolved H2/small-H1 inference remains the original two-study comparison.

| Hosted case, c32 | Measured requests/arm | Total p95 main → candidate, ms | Relative difference [95% envelope] |
| --- | ---: | ---: | ---: |
| H2 unary, original 32 pairs | 65,536 | 234.814 → 232.712 | −0.90% [−7.07%, +5.54%] |
| Known 16 KiB H1, all 56 pairs | 90,112 | 256.088 → 251.066 | −1.96% [−6.04%, +3.36%] |
| Small H1 unary, original 32 pairs | 65,536 | 232.179 → 231.399 | −0.34% [−5.71%, +4.71%] |
| Native API H1 stream, all 56 pairs | 90,112 | 254.228 → 250.659 | −1.40% [−6.61%, +5.97%] |

| Complete client lifecycle | Requests/arm | Total p95 main → candidate, ms | Relative difference [95% envelope] |
| --- | ---: | ---: | ---: |
| H2 unary, original 32 pairs | 131,072 | 654.591 → 650.859 | −0.57% [−5.15%, +4.98%] |
| Known 16 KiB H1, all 56 pairs | 180,224 | 650.074 → 649.414 | −0.10% [−4.52%, +4.61%] |
| Small H1 unary, original 32 pairs | 131,072 | 645.014 → 629.710 | −2.37% [−6.89%, +2.21%] |
| Native API H1 stream, all 56 pairs | 180,224 | 661.467 → 654.082 | −1.12% [−5.57%, +4.32%] |

Lifecycle includes warmups, initialization and drain costs. These are descriptive
95% envelopes over 9,999-draw hierarchical circular-four-context,
campaign-stratified, deployment-only and whole-AWS-host sensitivities, not
simultaneous or fixed-horizon guarantees. Earlier repeated studies and contrary
results remain visible; this is an engineering reading of the full evidence.
Known-16-KiB total medians add 1.941 ms (+1.38%) measured and 1.071 ms (+0.69%)
over the full lifecycle. Their upper endpoints are +3.80% and +3.12%.
Target measured/lifecycle fixed-batch rates change +0.22%/+0.84% (known) and
+0.78%/+1.60% (stream), with all lower endpoints above −2.71%. Rates include full
drains and are distinct from timed-capacity measurements. Current standalone
H2/small-H1 control total-p95 point changes are −2.26%/−3.46% measured and
−0.47%/−2.29% lifecycle; no material control regression reproduces.

The earlier startup-tail gap is now sufficiently resolved for the overall client
profile: both targeted lifecycle total-p95 upper endpoints are below 5%, and
streaming lifecycle first-byte p95 changes −0.57%, upper +4.61%. The retained
measured-stream total-p95 upper endpoint is +5.97% despite a −1.40% point change;
its extension beyond the contextual 5% guide is about 2.47 ms at this baseline.
It remains uncertainty, rather than an independently demonstrated regression.
Streaming measured first-byte p95 changes −4.28%, upper +3.23%; the complete
streaming profile and independently measured direct-AWS stream comparison
support acceptable behavior. No universal 5% exclusion is claimed.

One diagnostic remains wider: known-16-KiB measured unary first-byte p95 is
165.786 → 165.411 ms (−0.23%, −0.375 ms), envelope [−7.07%, +7.09%], allowing
about +11.75 ms at its upper endpoint. All sensitivity families remain reported;
none is selected for its favorable bound. Separate study point changes are
+0.88%, −4.89% and −1.33%. A tight independent unary first-byte equivalence claim
is **unestablished**. For the tested unary JSON operation, the validated complete
response is the usable result; its end-to-end profile supports qualification.
First-byte timing remains a diagnostic, not a separately qualified unary TTFB
SLA. This limitation is retained, not called a numerical pass or hidden by faster
unrelated workloads. Known-16-KiB lifecycle first-byte upper +5.48% and older mild
measured control upper endpoints remain contextual, not automatic vetoes.
Further campaigns solely to sharpen these isolated diagnostic or near-guide
endpoints would not currently change the material client-performance decision.

The latest study contains 32 failed responses: one main H2 warmup batch returned
empty HTTP 200 bodies. None occurred on candidate or in the two preselected
targets. Failed responses retain their complete elapsed costs, lost validated
goodput and failure-aware standalone latency profile. Saved Cloudflare logs show
32 continuation-authority errors on the same main version and time window;
request-level correlation and the underlying cause remain unestablished. The
campaign is not called zero-error, and neither environmental noise nor candidate
causation is inferred. All prior smoke and historical failures remain preserved.

The original cross-study reporter requires zero failures in every complete
corpus and therefore cannot admit the latest study. An explicit retrospective
analysis amendment combines only the two previously selected cases, requiring
zero failures within them and retaining all 56 deployments, every response,
all four standalone case profiles and the complete failure census. Estimators,
weights and uncertainty formulas are unchanged. The amendment passed independent
P2 review and complete-corpus loading checks; it is not an originally predeclared
whole-corpus-zero-error result. The second study's original campaign remains
failed after initial cleanup checks; separately reviewed read-only administrative
admission verifies its complete immutable measurement and resource absence within
the original bounds. No failed status or result is rewritten. A separate earlier
Cloudflare setup failure supplies no performance estimate.

All 56 owned deployment pairs and 24 AWS leases are verified absent. Campaigns
ended within 22, 24 and 27 minutes respectively; production and route fingerprints
stayed unchanged. Full source/configuration/credential/version checks passed.
Complete original reports, current per-case tables, amendments, review results
and cleanup receipts are indexed in the local qualification packet.

Direct AWS evidence separately supports no material regression across 19 latency
and three timed-capacity workloads. Small reused H1 total p50/p95 is
5.190/11.667 → 5.067/11.300 ms (24,576 requests/arm; p95 relative upper bound
+2.31%). Known 16 KiB H1 at 32 clients has total p95 178.430 → 175.539 ms
(49,152/arm; upper +4.36%). Native API streaming total p95 changes −2.71%, upper
+3.20%. Unknown 1 MiB H1 has total p95 567.437 → 511.163 ms
(32,768/arm; upper −8.63%). Retained late-Unicode 1 MiB total p95 is
1979.615 → 1957.393 ms (245,760/arm; upper +0.99%). Original per-criterion
confidence levels are 97.5%, 98.75% or 99.375%, depending on declaration.
AWS timed throughput improves 3.43–4.85%. Separate workerd instances and storage
paths per arm isolate these comparisons from hosted fixture-cache concerns.
The old absolute-cap Unicode result remains historically inconclusive;
revised materiality changes no observation or original interval.

Retained hosted evidence separately supports fresh/chunked small H1, unknown
1 MiB and native WebSocket profiles. Unknown 1 MiB total p95 changes −0.23%
[−4.61%, +5.07%]; WebSocket total p95 changes −1.92% [−6.16%, +3.15%] and
full drained goodput −1.83% [−4.42%, +0.79%]. Original first-byte/p50 uncertainty
and counts remain available. These supporting cases do not offset harm elsewhere.
Earlier fixed-assignment studies repeated unfavorable completion-tail points
around +8–12% with wide intervals; later balanced studies did not establish source
causation. Incompatible assignments, durations, shared credentials, stopped and
failed studies remain separately preserved rather than pooled or subset-selected.
Earlier empty-response errors correlated with shared continuation publication
failures on both pins; their underlying cause and any indirect candidate
contribution remain unknown. Current candidate zero-errors do not prove absence
of historical failure risk.

Hosted per-case/per-request and native CPU/memory performance remains
unestablished. Mixed-workload aggregates include controls, warmups and candidate
cron and do not cover all later settlement/retirement. They are diagnostic,
not resource equivalence or a reason to exclude candidate costs. Functional
resource-limit proof is separate from resource performance.

The latency driver measures the first response body byte for HTTP and the
`response.created` event for WebSockets; total latency ends at the complete
response body or completion event. Fresh HTTP includes connection establishment;
reused pools retain natural reconnections. Public transport names describe
client framing through Cloudflare ingress normalization. A service-binding
fixture separately guarantees genuinely unknown-length Worker entry; its
forwarding overhead is not separately timed.

## Functional proof and limits

Deployed proof for the measured runtime passed 216 required offers: 180
successes, 30 expected size refusals, four authentication refusals and two tenant
capacity refusals. It covered create/compact aliases, exact transformed bytes
and digests, once-only dispatch/accounting, known bodies through 64 MiB,
genuine unknown-length ingress, and a held large request alongside 32 ordinary
1 MiB clients. All eight native slots retired body leases, spool and background
resources; observed peak native RSS was 499,507,200 bytes. A separate 16-offer
proof passed unknown-length 64 MiB maximum/overflow for create/compact on both
managed and native provider routes. Eight separately declared ingress diagnostics,
including four fixture-path 522s, remain recorded separately.

Proof used isolated current-plan Cloudflare deployments and Crabbox AWS
c7i.2xlarge leases `cbx_9c74d59e97b7` and `cbx_1fdc52b41c3f`. All required
statuses, byte/digest, dispatch/accounting and retirement checks passed;
resources were removed and read-only production fingerprints stayed unchanged.
Supporting Node 24 validation passed 11,455 Worker, 308 admin, 1,310 script and
130 focused tests, with 67 script skips and one focused skip. Full runtime
Codex review was clean through P2. Source and proof hashes were reverified for
reuse; only documentation changed after the runtime pin.

These synthetic-upstream proofs establish router behavior, not real provider
latency or untested placement performance. Main rejects bodies above 32,000,000
bytes, so new larger-body capabilities have no successful-main latency baseline.
The 64 MiB successes disable request retention; retention-enabled performance
comparisons extend through 1 MiB. Default native limits are eight slots and two
simultaneous requests per tenant, not throughput for dozens of large clients.

This qualification made no production deployment, resource, configuration or
traffic changes. No plan upgrade, soak, PR publication or merge occurred.
