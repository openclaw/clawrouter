# Personal usage: local performance evidence

Final measurement: 2026-11-02T19:06:00.996Z. Raw latency samples, response sizes, source/built-asset SHA-256 hashes and per-action request-class counts: [measurements.json](measurements.json). No production deployment or provider call.

## Workload and limits

- 200,000 synthetic retained events across four SQLite Durable Objects, 50,000 per shard. 40,000 owner events (20%); 29 days, 1,024 padding bytes per raw event. Two providers, 12 models, eight keys, mixed outcomes and priced/unpriced usage.
- Node v26.12.1, Linux x64, AMD EPYC 9555 shared host (128 logical CPUs), unthrottled. Headless Chromium 156.0.8078.4. Desktop 1440×1000; mobile 393×851, UTC/light/reduced-motion.
- Browser baseline is an immutable UI archive of 6fceb88. Backend for both is current usageSnapshots/personalUsage, not an archived Worker binary. Candidate assets were frozen at browser-run start; hashes identify the exact measured build.
- Actual Node loopback HTTP → Worker → four SQLite DOs → merge → body read/JSON.parse. Browser report/events obtain those real responses. Synthetic session/policy authority and empty budget metadata exclude Cloudflare Access verification, policy resolution and budget lookup. No mock report latency or artificial provider delay.
- Seed inserts raw/reporting rows and marks projection complete. Does not benchmark migration, queue ingestion/settlement throughput, cleanup, WAN latency, browser throttling or high-cardinality worst cases. Local workerd co-schedules DOs and disables idle eviction; this is not production Cloudflare topology.

## API: first plus 11 sequential warm requests

First is query-first after seeding, not process/disk-cold; objects are resident. p95 uses nearest rank on small local samples, not a production SLO.

| Query | First ms | Warm median ms | Warm p95 ms | JSON bytes | Owner calls / page rows |
|---|---:|---:|---:|---:|---:|
| legacy30 | 599.0 | 404.6 | 433.8 | 172,810 | 40,000 |
| report7 | 45.3 | 34.1 | 35.7 | 14,249 | 9,656 |
| report30 | 158.9 | 156.0 | 162.0 | 33,134 | 40,000 |
| filtered7 | 28.1 | 26.2 | 27.2 | 10,477 | 6,436 |
| events25 | 3.7 | 2.3 | 3.9 | 14,790 | 25 |

Equal 30-day/40,000-owner-call report median is 61.4% lower, with 80.8% less JSON. Legacy returns pool aggregates plus owner summary/raw recent events; the new report returns personal groups, daily buckets and cost quality. Default seven days is a smaller workload, not an equal-work comparison.

## Browser: navigation to usable statistics

Eight home navigations per UI, alternating order: first fresh context and seven reloads. Full direct report and in-app opening each have one first plus five repeats. Timings include action/navigation delivery, rendered ready state and two animation frames. Backend was already warmed; browser request routing disables HTTP cache. Detached reads drain to networkidle outside each trial. This is not an INP/paint/Web Vitals measurement.

| View | First ms | Repeated median ms | Repeated p95 ms |
|---|---:|---:|---:|
| Baseline home | 541.6 | 510.7 | 601.3 |
| Candidate home | 175.8 | 116.1 | 196.6 |
| Direct My usage: report | 174.7 | 214.7 | 269.8 |
| Direct My usage: events | 206.6 | 247.1 | 301.4 |
| Home → My usage: report | 93.4 | 101.4 | 119.1 |
| Home → My usage: events | 125.4 | 133.5 | 150.6 |

Baseline readiness = Connected + legacy usage loaded; candidate = Connected + personal report rendered. Baseline home shows the previous 30-day policy/owner experience, candidate defaults to seven personal days. Events do not gate summary readiness. In-app opening reuses the fresh home report where possible.

**Budget-only integration verified:** baseline made 8 legacy scans; all candidate variants made zero. Candidate home/direct/mobile budget-only read counts: 8/6/1. Worker visibility tests independently verify the real budgets_only=true route makes zero usage-shard reads. Budget lookup time remains outside this synthetic benchmark.

## Browser: click/select to report rendered

One first plus five repeats per action. Refresh clears the report cache. Repeats may hit or miss the 15-second frontend cache; JSON retains per-action request-class counts. First uncached 30-day selection and subsequent cached selections are kept distinct.

| Action | First ms | Repeat median ms | Repeat p95 ms | First fetched report? |
|---|---:|---:|---:|---|
| group-provider | 105.1 | 96.1 | 127.4 | yes |
| group-key | 127.8 | 95.9 | 112.1 | yes |
| group-model | 48.6 | 63.9 | 64.4 | no (cached) |
| filter-model | 79.8 | 111.4 | 112.9 | yes |
| clear-model-filter | 95.5 | 92.5 | 94.1 | no (cached) |
| filter-provider | 99.2 | 124.2 | 160.5 | yes |
| clear-provider-filter | 89.9 | 108.9 | 109.7 | no (cached) |
| filter-key | 96.5 | 112.0 | 128.2 | yes |
| clear-key-filter | 94.3 | 109.9 | 125.2 | no (cached) |
| refresh-model-report | 160.2 | 111.9 | 127.8 | yes |
| range-30d | 304.6 | 111.9 | 128.2 | yes |
| range-7d | 95.2 | 96.4 | 127.9 | no (cached) |

Browser/unexpected-route errors: 0. Mobile document width 393 px at 393 px viewport, no document-level horizontal overflow. Shared-host variation is visible in samples. No invented performance acceptance target.

## Rendered proof

Synthetic owner@example.test and invented model/key metadata only; no prompts, completions, access tokens, provider secrets or real-user data.

- [Baseline home](baseline-home-desktop.png)
- [Candidate home](candidate-home-desktop.png)
- [Candidate My usage desktop](candidate-my-usage-desktop.png)
- [Candidate My usage mobile](candidate-my-usage-mobile.png)

## Reproduce

From the repository root with locked dependencies and Playwright Chromium installed, prepare the baseline by archiving `6fceb88 admin shared worker/generated/provider-snapshot.json` into `.openclaw/tmp/baseline-ui`. Symlink its `admin/node_modules` to the current admin node_modules, then build both admin directories using the direct Node Vite entrypoint. Do not invoke pnpm inside the archived snapshot (it lacks the workspace root and can install a different dependency tree).

```sh
NO_PROXY=127.0.0.1,localhost BROWSER=1 node scripts/benchmark-personal-usage.mjs
```

Strict loopback preview ports 4321/4322, temporary workerd/storage and browser children are disposed by the harness. Default is 50,000 events per shard; EVENTS_PER_SHARD=1000 with EVIDENCE_DIR=.openclaw/tmp/personal-usage-smoke is a smaller harness smoke, not this published workload. BASELINE_UI selects another prepared baseline admin directory. Without BROWSER, only API measurements run. Full per-request traces stay excluded in .openclaw/tmp/personal-usage-benchmark-full.json; committed JSON retains raw latency samples and compact counts, not duplicated request query strings.
