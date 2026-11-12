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

## Qualification against pinned main

The sole main baseline is `17cb1a003efa00e572f2c88f227517c5bd9008f3`;
the measured runtime candidate is `e508e10a606a74d625fb197b601a2a7c8c903c92`.
Later documentation changes do not alter measured runtime inputs. Older-main
measurements remain archived and do not qualify this pair.

**Verdict: controlled runtime evidence supports no material regression; full
current-plan deployment qualification has an unresolved measurement gap.**
The patch is not presented as fully performance-qualified or ready for production.
No reproducible material product regression or repair mechanism was established.

The standard changed on 2026-11-11: 5% is contextual relative materiality guidance.
Absolute latency, throughput and resource consequences inform the engineering
verdict; there is no universal millisecond veto and no requirement to distinguish
zero from an immaterial change. Important material harm cannot be offset by
improvements elsewhere. Original results and policy changes remain preserved.

The controlled AWS comparison used eight independent Crabbox AWS c7i.2xlarge
hosts in eu-west-1, Node 24.22.1 and the same attested workerd executable for
both arms. Each host ran six independent runtime pairs and eight alternating
paired blocks per case. Creation order and physical-core assignment alternated.
Separate source-owned runtime modules, assets, compatibility flags, actors and
storage remained in place. Normal pools, natural reconnections and full drains
were measured, with no timing or candidate-cost subtraction. Native containers
and Cloudflare cron are not emulated by this controlled environment.

All 835,584 measured responses, 135,168 warmups and 1,056 gates completed with
zero errors. Every input was unchanged; all eight leases are verified absent.
Hosted execution and cleanup took 18 minutes 33 seconds, below the 30-minute
campaign/lease caps. The exact packaged one-host full-workload execution smoke
passed before fleet admission and is not used to qualify performance. A separate
pre-allocation coordinator inventory timeout is preserved as a setup failure;
it produced no product measurements or lease. No failed host was discarded or
replaced. No sustained unrelated-interference stop occurred; candidate costs
remain included. Provisioning concurrency was two, independently of client count.

| Controlled AWS workload | n/arm | Total p95 main → candidate, ms | Difference [95% interval] | Fixed-batch rate difference [95% interval] |
| --- | ---: | ---: | ---: | ---: |
| Small H1 reused, c1 | 24,576 | 11.352 → 11.182 | -1.50% [-5.50%, +3.29%] | +2.07% [+1.00%, +3.18%] |
| Native API H1 stream, c32 | 49,152 | 179.413 → 168.152 | -6.28% [-12.11%, +0.56%] | +5.70% [+4.29%, +7.14%] |
| Native API WS, c32 | 49,152 | 140.702 → 134.416 | -4.47% [-9.34%, +1.88%] | +3.36% [+1.74%, +4.97%] |
| H2 unary, c32 | 49,152 | 152.606 → 147.753 | -3.18% [-8.90%, +2.38%] | +2.68% [+1.67%, +3.68%] |
| H2 stream, c32 | 49,152 | 180.070 → 168.033 | -6.68% [-16.05%, +5.05%] | +2.80% [+1.27%, +4.35%] |
| H1 stream known, c1 | 24,576 | 23.987 → 23.733 | -1.06% [-5.46%, +3.26%] | +0.90% [+0.30%, +1.49%] |
| H1 stream chunked, c1 | 24,576 | 23.751 → 24.358 | +2.56% [-1.40%, +7.43%] | +0.13% [-0.40%, +0.70%] |
| Small H1 fresh, c1 | 24,576 | 16.765 → 16.663 | -0.61% [-5.02%, +3.42%] | +0.77% [-1.02%, +2.63%] |
| WS reused, c1 | 24,576 | 23.587 → 23.088 | -2.12% [-5.85%, +1.48%] | +0.69% [+0.04%, +1.36%] |
| Known 16 KiB H1, c32 | 49,152 | 174.942 → 171.545 | -1.94% [-6.69%, +3.65%] | +2.48% [+1.44%, +3.52%] |
| Chunked 16 KiB H1, c32 | 49,152 | 189.733 → 184.471 | -2.77% [-8.36%, +3.02%] | +3.69% [+2.24%, +5.22%] |

Intervals are descriptive 95% paired hierarchical host/runtime/block bootstrap
intervals (19,999 draws), not simultaneous guarantees. Forty-eight runtime pairs
are nested within eight hosts. Each c1 case has approximately 1,229 observations
in its upper 5% tail per arm; each c32 case has approximately 2,458. All case-level
first/total p50/p95, counts, differences and intervals are preserved separately.
Fixed-batch rates include final drain and natural reconnections; they measure
validated finite-batch goodput, not saturation capacity. Initialization and
warmup costs are preserved separately.

The mildly worse controlled chunked-stream total p95 is +0.608 ms (+2.56%);
its absolute interval permits +1.682 ms; the relative upper endpoint is +7.43%. Its median improves slightly and its
rate interval is -0.40% to +0.70%. This isolated small-tail uncertainty does not
establish a material operational regression under the revised standard. H2
stream total p95 improves 6.68%; its upper endpoint is +5.05%, only about 0.09 ms
beyond the contextual guide. Native WS first-event median is +0.965 ms (+1.87%),
interval -2.24% to +5.87%; its completion tail and goodput improve. These are
contextual assessments, not independent per-metric equivalence guarantees.
No product change was made to chase these immaterial or near-guide differences.

Whole-workerd resource observations across the 48 pairs show mean work-window
CPU -2.85%, lifetime CPU -2.83%, initial CPU +0.87% (about 2.1 ms), and peak process
RSS +0.52% (about 3.75 MiB). Final process RSS is +0.98%. These are descriptive
aggregates, including canonical actors, fixture work, warmups, queues and a fixed
five-second post-work window. They are not per-case/per-request CPU, formal
resource equivalence, or native/Cloudflare billing estimates; deferred settlement
may remain. Candidate-owned costs are never classified as environmental noise.

## Actual Cloudflare deployment evidence and remaining gap

Two completed comparisons used the current plan, immutable main/candidate root
deployments with source-owned configuration, ordinary pools and natural
reconnections. Both static equal-length path assignments occur within each AWS
host. No forwarding Worker, route changes during measurement or version override
was used. Native capacity and scheduled maintenance remained enabled. Independent
canonical backends and disjoint equal-length credentials retain real product
caching and settlement. The upstream is synthetic; no provider-inference
latency claim is made.

The original thirteen-case burst study used eight independent AWS hosts, sixteen
deployment pairs and eight credential contexts per pair: 83,968 measured and
74,240 warm responses, plus 416 gates. It included fresh/chunked small requests,
H1/H2/WS, native paths and ordinary/native unknown-length 1 MiB at c32. It showed
known-16-KiB total p50/p95 +10.59%/+11.57%, chunked-16-KiB total p95 +15.11%, and
native-WS first-event p95 +40.08% (+7.66 ms), with wide uncertainty. Its complete
profile, lifecycle costs and contrary signals remain preserved separately.

The longer-reuse six-case study used eight independent AWS hosts, sixteen
deployment pairs and four credential contexts per pair: 335,872 measured and
21,504 warm responses, plus 192 gates. Its complete results are:

| Longer-reuse Cloudflare workload | n/arm | Total p95 main → candidate, ms | Difference [95% envelope] |
| --- | ---: | ---: | ---: |
| Small H1 reused, c1 | 4,096 | 119.265 → 114.776 | -3.76% [-13.22%, +11.37%] |
| Native API WS, c32 | 32,768 | 344.436 → 349.404 | +1.44% [-6.50%, +17.32%] |
| H2 unary, c32 | 32,768 | 274.221 → 269.031 | -1.89% [-10.66%, +11.86%] |
| H2 stream, c32 | 32,768 | 262.738 → 260.667 | -0.79% [-9.57%, +5.12%] |
| Known 16 KiB H1, c32 | 32,768 | 265.162 → 266.560 | +0.53% [-10.49%, +8.82%] |
| Chunked 16 KiB H1, c32 | 32,768 | 265.420 → 266.976 | +0.59% [-13.22%, +20.97%] |

Both studies had zero request failures, no sustained-interference stop and
unchanged inputs. All owned AWS/Cloudflare resources are verified absent within
the original bounds (25 minutes 35 seconds and 23 minutes 9 seconds respectively).
Production and root-route fingerprints remained unchanged. Neither study is
retrospectively rewritten or pooled with a different workload profile.

The remaining gap is deployed behavior, particularly native WebSocket c32.
In the longer-reuse study, first-event median is 63.120 → 74.726 ms:
+11.607 ms (+18.39%), envelope -8.15% to +39.43%. First-event p95 improves 4.50%,
completion p95 is +1.44% (envelope -6.50% to +17.32%), and measured goodput is
-3.32% (envelope -9.77% to +2.16%). Full-lifecycle goodput is -3.72%
[-9.12%, +0.84%]. Host directions are heterogeneous. Original burst first-event
p95 harm did not repeat in the longer-use study, but that difference in conditioning
does not erase it. Other deployed tails and H2 goodput also retain wider uncertainty
than their minor point differences.

Those ranges still permit operationally meaningful harm; this is not merely
failure to distinguish zero from a 0.5% change. Controlled AWS improvements do
not prove that a deployment-only cost is absent. There is no demonstrated source
mechanism to justify a speculative product repair. Repeating the whole matrix
or optimizing toward noisy favorable subsets is not a substitute for resolving
this specific deployment-level gap. No additional campaign has been launched
after the completed controlled comparison.

Thirty-six read-only aggregate analytics responses returned empty invocation
arrays. They are missing data, not zero CPU usage. Hosted per-case CPU/RSS
comparison remains unestablished. First latency means the first HTTP body byte
or WebSocket response.created event; total means the complete response body or
completion event. All original initialization, warmup and lifecycle measurements,
first/total p50/p95, rates, errors and sensitivity intervals remain available.

## Functional proof and limits

Current-pin isolated Cloudflare proof passed all 232 required offers. It covered
create/compact aliases, transformed byte counts and digests, canonical dispatch /
accounting, known and genuinely unknown bodies through 64 MiB, 64 MiB+1 refusal,
authentication and tenant-capacity refusal, cancellation and resource retirement.
Eight ingress diagnostics remain separate. The broad attempt's original
production-fingerprint guard failure is preserved and attributed to an independent
scheduled production deployment; all of its owned resources are independently
verified absent. The separate sixteen-offer unknown-maximum proof passed its
original guards and cleanup. No production change was made by this work.

Proof used Crabbox AWS c7i.2xlarge leases `cbx_27b017e2d49c` and
`cbx_f59f95f6edb9`. Node 24.22.1 full validation on AWS lease
`cbx_086087e40151` passed 11,772 Worker, 312 admin and 1,377 script tests,
with 74 script skips; focused validation passed 332 tests with one skip and
21 grant-credit tests passed separately. Precommit and committed runtime Codex
reviews were clean through P2. Source/configuration receipts bind the proofs to
the current pair. All validation and functional leases are verified absent.

Observed peak native RSS ranged from 331,603,968 to 485,822,464 bytes across
eight slots in the functional fixtures. Every slot retired body/spool/background
resources. These are candidate-only observations, not CPU/RSS or billing
equivalence. Logical retirement does not promise RSS shrinkage. Hosted per-case
resource equivalence and sustainable large-body capacity remain unestablished.

Main rejects bodies above 32,000,000 bytes, so larger-body successes have no
successful-main latency baseline. Maximum-body proofs disable request retention;
64 MiB retained-request support is not established. Native slots and maintenance
add real operational costs. Default capacity is eight slots and two simultaneous
requests per tenant, not throughput for dozens of large clients.

No production deployment, resource, configuration or traffic was changed by
this work. No plan upgrade, soak, PR publication, push or merge occurred.
