# Personal usage: transition performance proof

Measurement point: **af23e0bb9f55810bb85a3ca7cc8777ae5f0b278a**. The large-corpus timings/screenshots and asset identities below are retained evidence for that candidate, not silently relabeled as measurements of the later cursor-lifecycle fix. The later fix has dedicated real-cursor navigation/retry browser regressions; current native cost-path proof is recorded separately.

Read-through run: 2026-11-02T19:49:14.806Z. [Raw samples/source and asset hashes](measurements.json). Separate projected fixture: 2026-11-02T19:50:01.501Z, [measurements](projected/measurements.json). All data is synthetic, local and provider-free. No production deployment/backfill.

## Workload and interpretation

- 200,000 retained events across four SQLite DOs, 50,000 per shard; 40,000 owned by the selected principal (20%), spanning 29 days with 1,024 padding bytes per raw event. Two providers, 12 models, eight keys, mixed outcomes/pricing.
- Main run is **immediate cutover before any projection apply**: canonical owner-attributed ledger populated, reporting projection empty/incomplete. Retained history is read through, not silently backfilled. The second run seeds the same-size typed projection as an explicitly labeled steady-state fixture.
- Node v26.12.1, Linux x64 shared AMD EPYC host, 128 logical CPUs; Chromium 156.0.8078.4, unthrottled. Browser baseline UI archive 6fceb88; backend legacy function is current repository usageSnapshots, not an archived binary. Candidate assets are frozen/hash-bound.
- Loopback HTTP → Worker → four SQLite DOs → merge → body read/JSON.parse. API first plus 11 sequential warm requests. First follows seeding/resident objects, **not** process/disk-cold. Small-sample nearest-rank p95 is not a production percentile/SLO.

## Large-corpus API measurements

| Mode | Query | First ms | Warm median ms | Warm p95 ms | JSON bytes | Owned calls / page rows |
|---|---|---:|---:|---:|---:|---:|
| Read-through before apply | legacy30 | 376.6 | 372.1 | 378.7 | 172,810 | 40,000 |
| Read-through before apply | report7 | 130.5 | 117.5 | 118.7 | 14,308 | 9,656 |
| Read-through before apply | report30 | 498.6 | 497.7 | 507.9 | 33,194 | 40,000 |
| Read-through before apply | filtered7 | 110.4 | 105.9 | 107.9 | 10,537 | 6,436 |
| Read-through before apply | events25 | 3.9 | 2.3 | 3.1 | 14,851 | 25 |
| Projected fixture | legacy30 | 402.7 | 401.6 | 411.4 | 172,810 | 40,000 |
| Projected fixture | report7 | 45.2 | 34.3 | 34.8 | 14,302 | 9,656 |
| Projected fixture | report30 | 149.9 | 148.1 | 150.1 | 33,188 | 40,000 |
| Projected fixture | filtered7 | 26.1 | 24.1 | 25.2 | 10,531 | 6,436 |
| Projected fixture | events25 | 3.1 | 2.2 | 3.6 | 14,845 | 25 |

**Tradeoff, not hidden:** same-30-day read-through is 497.7 ms versus 372.1 ms legacy in that run, 33.8% slower while preserving all history and producing the richer personal report. Default seven-day read-through is 117.5 ms. Unfiltered 25-event pages remain 2.3 ms and do not classify the entire retained range.

The typed projected path is 148.1 ms for 30 days in its separate run (legacy 401.6 ms). This is not permission to apply a production migration. Both paths return roughly 33 KB instead of 173 KB for the equal 30-day workload, about 80.8% less JSON. Shared-host baseline variation between runs is retained. Seven-day results are smaller workloads, not equal-work 30-day speedups.

## Browser before/after default experience

Eight alternating home navigations per UI: first fresh browser context and seven reloads. Direct and in-app My usage each have one first plus five repeats. Times include action delivery, ready UI state and two animation frames; not INP/paint/Web Vitals. Browser routing disables HTTP cache, backend is API-warm, detached reads drain outside timings. Baseline readiness is Connected plus legacy data; candidate is Connected plus personal statistics. Baseline defaults to 30-day pool/owner view; candidate defaults to seven personal days. Events do not gate summary.

| View | First ms | Repeated median ms | Repeated p95 ms |
|---|---:|---:|---:|
| Baseline home | 509.3 | 459.3 | 481.5 |
| Candidate home, read-through | 227.8 | 196.5 | 213.0 |
| Direct My usage: report | 255.4 | 215.3 | 222.7 |
| Direct My usage: events | 287.6 | 247.5 | 255.0 |
| Home → My usage: report | 75.7 | 83.4 | 89.5 |
| Home → My usage: events | 107.1 | 114.6 | 121.0 |

Candidate variants made **zero** legacy usage scans; baseline made 8. Budget-only reads remain separate from personal analytics. A real shipped-route test verifies budgets_only=true performs zero usage-shard reads.

## Browser controls

One first plus five repeats per action. Report cache freshness is 15 seconds, bounded/scoped by accepted identity. Refresh clears it; JSON contains raw latency samples and request-class counts.

| Action | First ms | Repeat median ms | Repeat p95 ms | First fetched report? |
|---|---:|---:|---:|---|
| group-provider | 179.4 | 160.2 | 176.3 | yes |
| group-key | 175.7 | 176.0 | 176.5 | yes |
| group-model | 48.1 | 47.9 | 48.4 | no (cached) |
| filter-model | 160.1 | 159.9 | 176.4 | yes |
| clear-model-filter | 87.9 | 78.8 | 79.4 | no (cached) |
| filter-provider | 160.2 | 160.3 | 176.0 | yes |
| clear-provider-filter | 94.7 | 79.1 | 94.7 | no (cached) |
| filter-key | 159.8 | 144.1 | 192.2 | yes |
| clear-key-filter | 95.7 | 64.2 | 79.6 | no (cached) |
| refresh-model-report | 207.7 | 191.7 | 208.4 | yes |
| range-30d | 592.4 | 95.6 | 112.2 | yes |
| range-7d | 79.3 | 80.1 | 96.1 | no (cached) |

Browser/unexpected-route errors: 0. Mobile document width 393 at 393 viewport pixels, with horizontally scrollable labeled tables. No invented performance target.

## Authenticated, accounting-driven native upgrade proof

The large benchmark isolates query/render cost: its session metadata is synthetic and it seeds rows directly. It **does not prove authorization or accounting ingestion**. The separate [native proof](../../proof/personal-usage/authenticated-upgrade.json) uses actual shipped local-session verification, authority policy resolution, proxy requests, accounting publication, queue ingestion and persisted SQLite/KV restart from exact baseline 6fceb88. Only setup/state inspection, an offset fixture clock and the upstream are adapters.

It generated 600 baseline accounting events (300 per owner), observed 300 personal calls before and 300 immediately after upgrade, with 0 projection rows and no raw/settings/debit changes caused by reads. Two new calls yield 301 owned calls, not a partial history. Other-owner exclusion, removed bindings, disabled policies, proxy rejection and strict future-custom validation are asserted. Historical reasoning coverage stays zero; only the new owned call reports ten reasoning tokens.

The authenticated proof JSON records paired local timings for the same 301 owned calls before/after an explicit synthetic projection. Its source-hashed observations are refreshed independently from the af23 large-corpus benchmark. The local migration phase remains fixture-only; these small-corpus timings are not production latency or a replacement for retained-volume measurements.

## Rendered proof and limits

[Baseline home](baseline-home-desktop.png) · [Candidate read-through home](candidate-home-desktop.png) · [Desktop details](candidate-my-usage-desktop.png) · [Mobile details](candidate-my-usage-mobile.png). Invented metadata only; no prompts/completions, access tokens, provider secrets or real-user usage.

- Large benchmark excludes actual Access verification, policy resolution, budget lookup, queue/ingestion cost and WAN. Native proof covers shipped local-session/authority/accounting paths, **not** live production, real provider billing or Cloudflare Access JWT verification.
- Native fixture clock uses a monotonic UTC-noon offset across restart to avoid calendar-window flakes; performance.now remains live.
- Local workerd co-schedules DOs and disables idle eviction; no claim about production topology, worst-case cardinality, browser throttling or production load.
- Source/asset hashes, raw timing samples and request-class counts are committed. Verbose traces are scratch-only and overwritten per run; they are not required to interpret the retained samples.

## Reproduce

Prepare immutable baseline with git archive 6fceb88 admin shared worker/generated/provider-snapshot.json under .openclaw/tmp/baseline-ui; symlink its admin/node_modules to current locked dependencies. Build each admin with the direct Node Vite entrypoint. Do not invoke pnpm in the archive (no workspace root). Install Playwright Chromium.

```sh
NO_PROXY=127.0.0.1,localhost PROJECTION=0 BROWSER=1 node scripts/benchmark-personal-usage.mjs
NO_PROXY=127.0.0.1,localhost PROJECTION=1 EVIDENCE_DIR=docs/performance/personal-usage/projected node scripts/benchmark-personal-usage.mjs
NO_PROXY=127.0.0.1,localhost node scripts/prove-personal-usage-upgrade.mjs
```

Native proof needs the exact baseline Git object; shallow checkouts must fetch it explicitly. Its Worker test reports a skip rather than inventing evidence when absent; the recorded local run executed it. Harness children/storage are disposed. Preview ports 4321/4322 are loopback only. EVENTS_PER_SHARD=1000 is a smaller harness smoke, not the published workload.
