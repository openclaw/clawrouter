# Personal usage candidate verification

Baseline: **6fceb88d4d165ba66281c931b74c3047772a2ef5**. Refetched main after implementation; unchanged. The final head is supplied in the handoff/bundle receipt, not guessed in this document.

## Final local results

Linux x64, Node v26.12.1, locked pnpm dependencies; no package/lock/provider snapshot changes.

| Gate | Command | Result |
| --- | --- | --- |
| Worker TypeScript + tests | NO_PROXY=127.0.0.1,localhost pnpm worker:check | **2,840 passed**, zero failed/skipped |
| Admin TypeScript | npm --prefix admin run check | passed |
| Admin unit tests | npm --prefix admin test | **258 passed** |
| Script/workerd integration tests | NO_PROXY=127.0.0.1,localhost node --test --test-concurrency=1 test/*.test.mjs | **964 passed, 20 skipped**, zero failed |
| Admin production build | npm --prefix admin run build | passed |
| Full Chromium browser suite | NO_PROXY=127.0.0.1,localhost node node_modules/@playwright/test/cli.js test --workers=4 (from admin) | **480 passed**, desktop/mobile |
| Local protocol smokes | NO_PROXY=127.0.0.1,localhost pnpm worker:e2e | HTTP, Responses WebSocket and content cleanup passed |
| Whitespace | git diff --check | passed |
| End-to-end performance | NO_PROXY=127.0.0.1,localhost BROWSER=1 node scripts/benchmark-personal-usage.mjs | completed, 200,000 retained synthetic events; zero browser errors |

Full browser coverage includes duplicate cross-shard event IDs with unique page-local anchors, non-URI-safe ledger IDs, actual producer estimate-reason warnings, WCAG AA axe checks, report loading/errors/empty states, independent event failures, filters, key grouping, safe CSV, cancellation, identity replacement, pool isolation and rolling/custom range refresh. Existing administrator Linux baselines are unchanged; new personal-report snapshots are intentional synthetic fixtures. Administrator access to My usage is tested through the existing Usage page, avoiding unrelated shell/snapshot churn. macOS was not available for native execution; no Darwin baseline was fabricated or replaced.

Native workerd date tests include Kolkata, Kathmandu, Chatham, both New York DST transitions, Lord Howe half-hour DST, midnight gaps/skipped dates and arbitrary half-open boundaries. Ownership tests exercise real local session authority, tenant/policy/principal/key constraints, cursor/query binding, duplicate IDs across shards, SQL index plans and fail-closed fanout. Migration tests cover interruption/resume, atomic rollback, default dry-run and original ledger payload/debit preservation. Token/pricing tests preserve settlement amounts/bases, cache subset semantics, reasoning inclusion exactly once, unknown vs genuine no-charge and optional reporting-only estimates.

## Initial failures and reruns

The first combined parallel run had two local WebSocket CLI fixture failures and one realtime freshness timing failure (373 ms); the serial script run above passed the same assertions without widening thresholds or changing those production/test paths. The browser launcher initially routed loopback through the host proxy and rejected a Host/authority mismatch. Explicit NO_PROXY for localhost/127.0.0.1 resolved that local harness condition. These are disclosed local-run observations, not a claim about production reliability or a universal introducing cause.

The local HTTP smoke initially matched the word completion in the new request_format metadata value. It now asserts the exact expected format and applies its unchanged content/secret sentinel regex to all remaining metadata. No privacy checks were removed.

## Reporting-only history preview

[dry-run.json](dry-run.json) is an actual default read-only CLI preview over the actual Anthropic guard and soft hosted-tool receipt producers using synthetic input. Its SQLite file SHA-256 was identical before/after. It proposes an unknown 7,626-micro retained reservation and a genuine 56-micro partial component, with recorded debit values separate. No original charges or payloads change. Resumable apply is tested only against local synthetic fixtures.

**No production usage read, production impact preview, backfill, deployment or budget migration was executed.** Live impact counts remain unavailable until separately authorized owner/operator metadata is available. The supported-baseline upgrade preserves historical visibility immediately using read-only indexed canonical history while the reporting projection is incomplete. Historical migration only projects retained evidence; it never prices old events with today's rate card or reconstructs missing reasoning/counters.

## Publication and review

Hannes authorized an open PR through the existing Team managed publisher after tests and the required exact-source local ClawSweeper review. No merge, deployment or production backfill is authorized. Pinned source 7af0b3df82e30c661bd041fa09216724b3587658 supports openclaw/clawrouter through its generic OpenClaw profile, and Hannes completed its non-passing review on ffdc0c5. The requested Studio runner remains operator-controlled; this replacement needs full re-review. The [handoff](review-handoff.md) specifies the immutable range and Studio command. Full pinned re-review of this replacement is **pending**, not replaced by ordinary AutoReview or these tests. Publication must wait for the exact-head review result.

Ignored .openclaw scratch, registry cache, baseline archives, logs and raw request traces are preserved locally but excluded from the candidate. Only focused source/tests/docs and intentional rendered proof are committed.

## Review acceptance additions

See [review-remediation.md](review-remediation.md) for the two P2 fixes, bounded history transition, actual producer ingestion/migration/export regressions and the authenticated persisted baseline-to-candidate runtime proof. [authenticated-upgrade.json](authenticated-upgrade.json) records observed counts, preserved debits/settings, source hashes, revocation and strict range validation. The current source preserves historical visibility before any explicit apply; no production operation was performed.
