# Pinned-review remediation

Hannes relayed the completed, non-passing Studio full review of base 6fceb88d4d165ba66281c931b74c3047772a2ef5 through ffdc0c53301243739b2c2b2c3c995e7a300790ba using exact runner 7af0b3df82e30c661bd041fa09216724b3587658. Exit zero meant review completed, not acceptance. This replacement requires full pinned re-review before publication.

## P2: retained reservations are not known partial prices

worker/usage-report-cost.ts centralizes evidence classification. Positive unpriced debits are unknown unless the producer records a genuine reporting_known_cost_micros component. It must be a positive safe integer no larger than the recorded actual debit. Partial reporting uses that component, not the entire debit. Noncanonical partial labels do not establish evidence. Legacy unpriced amounts without the marker stay unknown.

worker/proxy-accounting.ts records a marker only from measured token/tool components. Reservation bounds, fixed tariffs, fallback costs, character estimates and published rate upper bounds do not establish a measured partial token amount. Actual cost/basis formulas and all budget enforcement/settlement remain unchanged. SQL retained-history classification shares the canonical known-basis mapping and is parity-tested against the JavaScript projection.

The real Anthropic JSON and SSE served-tier guard flows through createProxyAccounting.pricingFailure and retains 7,626 micros, with no known component: reporting is unknown. A genuine soft hosted-tool response records a 56-micro token component while its fee is unknown: partial is 56. Complete observed nominal fee plus measured tokens is 10,056, still partial if the overall price remains unqualified. Ingestion, retained read-through, resumable historical projection, CSV and recorded charges are tested with these actual producers. The read-only CLI preview in dry-run.json preserves the SQLite file hash and distinguishes unknown reservation from genuine partial component.

## P2: presets use server time

The browser sends days=7 or days=30, without client-authored boundaries. Worker Date.now resolves each fresh read. The exact returned range is used for all event pages, retries and cursors. Refresh/periodic refresh/reselecting a preset requests a new server anchor. Custom ranges stay pinned and strictly reject future ends; days cannot be mixed with from/to. Tests cover browsers one minute ahead/behind, refresh, custom transitions, event range reuse, native server preset resolution and strict future-custom rejection on shipped authenticated routes.

## Preserve history at cutover without a production backfill

An incomplete reporting projection no longer drops retained current-baseline history. Reports read the canonical ledger through the existing policy/principal/time index, with exact tenant and at-most-30-day bounds. SQL evaluates scalar metadata only inside that owner range. It does not enumerate principals, discover aliases, scan policy pools or infer historical owners from today's credentials. Sparse reporting projections are not unioned in, so originals count exactly once.

Common unfiltered event pages use an indexed keyset LIMIT read and project only the selected rows; advanced filters classify the bounded owner source before LIMIT. Complete projections retain the typed fast path. historyComplete now means retained coverage, separate from projectionComplete and historySource. The UI discloses indexed retained-history reads without claiming those rows disappeared. Missing historical counters remain unavailable.

Pre-attribution legacy rows that do not yet have canonical indexed ownership remain explicitly incomplete, not guessed. Rollout/cutover for those older shards stays held until the pre-existing attribution index is ready; a partial attribution state is not a successful supported-baseline upgrade. No new automatic backfill is introduced.

## Native authenticated upgrade proof

The test/helper archives exact baseline source, runs its real Worker and Durable Objects, creates synthetic principals/credentials/policies and generates real proxy/accounting/queue-ingested usage. It then restarts the candidate on the same persisted SQLite/KV storage and uses the actual shipped session/report routes. It does not stub the report or authorization decision. Setup/state inspection, fixture clock offset and the synthetic upstream are adapters.

Recorded evidence in authenticated-upgrade.json includes 600 baseline accounting events, 300 owned calls before and immediately after upgrade, zero historical reporting rows written by reads, and 301 owned calls after one new owned request. Raw payload digest, policy/credential/connection settings and old 5,100-micro debit are unchanged across upgrade/read; the new owned request adds exactly 17. Another owner is excluded. Removed bindings and disabled policies fail closed; disabled-policy proxy calls are denied. Old reasoning remains unreported; only the new owned request contributes ten reasoning tokens.

Explicit dry-run/apply is exercised only on this local synthetic corpus. The final real deployment/backfill remains unauthorized. Native local-session authorization is real shipped code, but this is not live production, real provider billing or Cloudflare Access JWT acceptance evidence. The fixture shifts its monotonic clock to UTC noon to avoid month-boundary flakes; latency uses live performance.now.

## Performance and review gate

The refreshed main benchmark measures immediate retained-ledger cutover with an empty reporting projection. The separate projected fixture is labeled. See ../../performance/personal-usage/README.md for every sample and the disclosed 30-day read-through overhead, default-seven-day responsiveness, bounded event pages and actual-route small-corpus measurements. No synthetic measurement is presented as production latency.

The final committed range, bundle checksum and exact Studio command are supplied in the handoff. No ordinary AutoReview substitutes for the pinned full runner. Publication is held for Hannes's passing final-head receipt; merge, deployment and production backfill remain unauthorized.
