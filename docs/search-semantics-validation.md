# FakeCo search semantics validation

Fixture deployment approved and verified at 2026-10-23 04:45:59 UTC from
`77bf4ac4fa1f155861b2415648242178ec17089b`. No synthetic pages created, router
credential registered, budget changed, paid probe run, or existing canary cleaned up.

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

Deployment ownership receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-deployment-receipt.json`.
Active fixture version: `7c4bb07f-e01e-42f1-a784-7e58de842462` at 100%.
Route ID: `3027364f1df44bcfa2b39ce11a1fea14`.
New SQLite namespace ID: `148cbb6483b4421dbf8b25301a325865`.
Readiness returns 200 with `cache-control: no-store`; unauthorized controls return
404. The existing router remains on `3d669069-fb9e-45e0-a71b-bded66c5b7b2`;
its settings, deployments, custom domains, Access app, and all prior routes are
unchanged. All 36 prior namespaces remain present.

Cache Rules and Page Rules API inspection returned 403 with the management token.
Their effective behavior remains unqualified. Resolve this through read-only
dashboard inspection and/or separately approved counter calibration before
claiming cache-only semantics. No credential/auth-mode fallback was attempted.

Cloudflare supports a path route in front of an existing custom-domain Worker;
the route takes precedence for matching requests. See [Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/).
No router source imports the fixture. No existing Worker, Access policy, custom
domain, queue, R2 bucket, KV namespace, or Durable Object is modified by fixture
deployment. The public prefix is outside the existing FakeCo Access destinations;
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
