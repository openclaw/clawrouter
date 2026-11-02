# Personal usage reporting

Read-only session APIs:

Quota refreshes may use `GET /v1/session/usage?budgets_only=true`. The existing session/policies/budget shape is unchanged, but usage is `emptyUsageSnapshot("not_requested")` and no usage shard is queried. Only one exact lowercase `budgets_only=true` opts in; ordinary requests and other values retain full legacy behavior. This quota view remains session-authenticated and private/no-store.

- `GET /v1/session/usage/report` → `PersonalUsageReport`.
- `GET /v1/session/usage/events` → `PersonalUsageEvents`.

See `shared/usage-report.ts` for the response allowlist. Existing usage APIs are unchanged. Neither endpoint accepts an owner, tenant, credential owner, or policy selector. The verified browser session supplies the principal and currently held enabled policies; SQL also requires the exact event tenant and policy. A proxy key alone cannot authenticate these endpoints. Responses are private/no-store. Reporting reads never contact providers or fetch retained content.

## Query and bounds

`from` / `to`: YYYY-MM-DD interpreted in `timezone`, or RFC3339 instants with explicit UTC offset. Half-open [from, to). Default: rolling seven days ending now. Maximum: 30 days (30 local dates for a calendar-date range, including DST). Requests cannot end in the future. Start is clipped to the rolling 30-day retention boundary and reported as `clampedStart`. `timezone` defaults to UTC; server-side bounded Intl conversion resolves fractional-hour offsets, 23/25-hour DST days, half-hour transitions, midnight gaps/folds and skipped dates. No client-supplied bucket boundaries are trusted. At most 32 clipped local-day buckets.

`groupBy=model|provider|key` (default model). Exact optional `model`, `provider`, `key`, `status`, `costClass` and `lane` filters. Duplicate or unrecognized query parameters are rejected. A null model/key group remains null, not a fabricated identity. Key reporting uses the retained personal `credential_id`, never the legacy `key_id` policy fallback or an upstream grant handle. Dashboard session calls without a personal credential have `keyId=null`.

Report groups: deterministic UTF-8/BINARY lexical first 100 (null first), with `groupsTruncated`; totals and all daily buckets include omitted groups. There is no event payload on the report. SQL materializes one indexed owner/tenant/policy/time range then aggregates total, bucket, and selected-group dimensions. It does not parse raw ledger JSON or detail JSON during reports. The new projection index is `usage_report_owner_range(tenant_id, policy_id, principal_key, occurred_at_ms DESC, id DESC)`.

Events: `limit=1..100` (default 25). The opaque cursor anchors the resolved query range and binds the normalized owner, exact query and policy set. Keyset ordering is timestamp descending, event ID UTF-8 descending, then shard identity descending, preserving equal timestamp/ID events across shards. Query scope is always reapplied from session authority; cursors grant no authority. Changing filters or owner/policy membership requires a new first page. Retention continues advancing during pagination. Concurrent/late ingestion is not a snapshot transaction; late-arriving rows older than the last position can appear on later pages; newer rows require restarting. Each shard returns at most limit+1 rows. Every policy shard participates, at most eight concurrently. Any shard failure fails the request, never partial-success totals.

## Interpretation: calls, tokens, money

These are **model-call** counts, not client-request success rates. Compound adviser/synthesizer stages count independently. `successfulCalls`, `errorCalls` and `deniedCalls` cover all calls, including utility. Denied is separate from errors. `generationCalls` vs `utilityCalls` is a classification, never a filter that drops costs/tokens. Only known discovery/count/moderation request formats are utility (Anthropic count requires its known messages format plus count capability); unknown/future formats default to generation. No missing token counter is inferred to be zero: detail is null and aggregate `*ReportedCalls` exposes coverage. Summed token values are only reported counters. Reasoning is a subset of inclusive output, not additional tokens. Reporting marks reasoning unavailable if inclusive output is missing/invalid or reasoning exceeds it. Cache reads/writes each require a valid inclusive input total and cannot exceed it; if two individually plausible disjoint allocations sum above input, both allocations are unavailable. This validation also applies to explicitly migrated history, without changing the original event. Do not add cache categories again to input totals.

Reporting classes derive from retained accounting evidence, never current tariffs:

| Basis | Class |
| --- | --- |
| manifest_pricing / realtime_modality_usage / realtime_input_transcription_usage | calculated |
| policy_fixed | fixed |
| request_character_estimate / manifest_reservation | estimated |
| manifest_rate_upper_bound / realtime_full_context_bound | upper_bound |
| partial / partial_usage, or unpriced_* with a positive retained charge component | partial |
| none with recorded zero | no_charge |
| unpriced / fallback / unrecognized or contradictory evidence | unknown |

A positive component under an `unpriced_*` basis remains partial at its recorded amount, not a complete price or zero. An explicitly captured reporting-only estimate may classify otherwise unknown evidence as estimated when there is no known positive unpriced component. Its calculation uses the frozen admission price card and carries no budget authority. Historical migration does not invent estimates or reprice events. Unknown detail has `reportingCostMicros=null`; the cost summary zero accumulator for unknown is **not** a free-price claim. `recordedChargeMicros` preserves the original debit separately; neither projection nor migration changes `actual_cost_micros`, reservations or enforcement. Never sum unknown/estimated/upper-bound values into an unlabeled invoice total.

Lanes: subscription → subscription; api_key/environment → api; missing/unrecognized → unattributed. Subscription reporting values are not assertions about a provider subscription invoice. Credential handles, raw secrets, prompts/completions, session/agent/project IDs, trace IDs and retained-content references are never copied into detail. Only the explicit shared allowlist is returned.

## Explicit historical migration (no automatic production backfill)

Deploying creates an empty reporting projection and a fixed historical watermark; new events atomically insert ledger payload plus projection under the same event ID. Duplicates preserve the first payload. New empty shards initialize `historyComplete=true` because there is no historical work to recover. Any consulted shard with preexisting history remains `historyComplete=false` until an operator explicitly applies its reporting migration. Reads, alarms, startup and the older attribution backfill never populate historical reporting rows. The older attribution mechanism remains unchanged for compatibility.

The supplied tool is **offline/internal only**, has no network or production credentials and exposes no public mutation endpoint. Use an independently approved local/backup SQLite ledger database; do not directly edit a live workerd database. First inspect a dry-run:

    node scripts/usage-report-migrate.mjs --database <offline-ledger.sqlite> --batch-size 500

Default dry-run opens SQLite read-only, projects at most 500 retained event metadata records in memory, emits only counts/watermarks and per-lane/per-class `effects` (calls, `proposedReportingMicros`, `recordedChargeMicros`), and changes neither schema nor progress. `--after-rowid N` can preview the next dry-run batch. Batches are bounded to 1..2000. Unknown proposed reporting amounts are null, never a free-price claim; raw debit sums stay separate from proposed reporting sums. No payload or identity is printed.

After separate operator approval of the exact database and write operation:

    node scripts/usage-report-migrate.mjs --database <offline-ledger.sqlite> --batch-size 500 --apply

Run another explicit apply batch until `complete=true`. Apply resumes the saved watermark, never accepts a caller override for it, and atomically inserts reporting rows plus progress. A crash/failure rolls both back. It writes **only** `usage_report_events`, its reporting indexes and `usage_report_migration`. It never changes original event JSON, actual cost, budgets or pricing metadata. Only retained metadata is eligible. Recovery/import to a running service is intentionally not automated by this tool; follow that service's approved maintenance/restore procedure. Production migration requires separately authorized private in-runtime tooling using `migrateUsageReportShard(env, { tenantId, policyId }, options)` (private Durable Object binding transport) or the underlying `migrateUsageReport(sql, transaction, options)` helper, not a new public route. The private binding operation also defaults to dry-run; no public Worker path forwards to it.

## Local verification and benchmark hooks

    pnpm exec tsc -p worker/tsconfig.json --noEmit
    node --test worker/test/usage-report.test.mjs worker/test/usage-report-runtime.test.mjs worker/test/usage-report-migrate.test.mjs

`worker/test/usage-report-fixture.mjs` exports `usageReportFixture` (in-memory Node SQLite, synthetic-only metadata), query/ingest/migrate/report/events helpers and SQL query capture. `queryUsageReport`, `queryUsageEvents`, `parseUsageReportQuery`, `mergeUsageReports` and `mapUsageShards` are exported for repeatable cardinality/EXPLAIN/timing harnesses. Benchmark report after explicit local projection; include owner cardinality, non-owner cardinality, selected range, dimensions, result count, cold/warm timing and index-plan evidence. Do not benchmark historical JSON migration as report latency.


## Console behavior

Members see **My usage** in Workspace and the same personal summary on their home dashboard. Administrators open **My usage** from the existing administration Usage page; their gateway overview/navigation stays unchanged. Pool usage does not appear in member analytics; only the explicitly labeled budget panel contains shared-pool context. Budget/credential metadata uses budgets_only=true and cannot trigger legacy activity scans.

Home refreshes its visible personal report every 30 seconds; inactive/hidden pages do no periodic reporting work. Seven/30-day presets advance their end instant on Refresh. A custom range is pinned and preserved on Refresh. Full report/detail pagination stays on its displayed range until explicit refresh, so inspection does not jump between periods. Summary, events and export work remain independent. The displayed report-generation timestamp is separate from the access-metadata refresh timestamp.
