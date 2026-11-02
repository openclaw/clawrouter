# Rollback/re-upgrade coverage repair

The coordinator reports the pinned full review of3cb0326 complete/checkout-verified/exit0, with expired-query behavior accepted, existing runtime proof sufficient and security clear. One concrete compatibility P2 remained: a saved complete projection could miss a later canonical event written by original6fceb88 after rollback. A completed historical upper-rowid snapshot could also fail to discover it. Studio report: /Users/hrudolph/Data/clawsweeper-local-reviews/clawrouter-dashboard-20261102-3cb0326/full-review/0.md (coordinator relay; not independently read here).

## Focused implementation

- Canonical INSERT/DELETE/UPDATE triggers persist a singleton mutation generation across old-writer rollback. DELETE/UPDATE also retire the corresponding reporting row, never the canonical payload.
- Projection reads require migration completion AND verified generation matching current generation. Otherwise the existing owner-indexed canonical read-through is authoritative, without a UNION/double count or automatic historical projection.
- Paired current ingestion/retention runs inside its existing synchronous transaction. It advances only acknowledgments that were already current, so a successful current write/duplicate/cleanup cannot erase an older gap. No persistent bypass flag survives a crash.
- The first tracking rollout trusts only truly empty canonical and projection tables. Existing non-empty databases, including old complete=1 records, conservatively use read-through until explicit repair.
- Coverage detection uses singleton primary-key state, not MAX(rowid), counts or a per-read anti-join. Query-plan tests retain the canonical owner index.

Explicit apply pins an upper rowid and coverage generation. Current-generation interrupted rounds preserve their bound/resume point, including paired new ingests. Unpaired old-writer changes invalidate the round and start a fresh bounded scan from zero with a new bound, catching rowid reuse below old cursors. Pre-tracking interrupted progress conservatively restarts because its coverage was never authenticated.

Apply refreshes stale projection metadata and prunes orphan/expired reporting rows before completing. Canonical history, recorded charges and budget logic remain unchanged. The orphan anti-join is explicit-migration-only; it may traverse projection metadata while deletes are capped at one batch. It is never a reporting-read coverage scan. Default dry-run remains read-only; batch selection, reporting writes and watermarks share one transaction. No production backfill or deployment was performed.

## Affected verification

- Worker TypeScript check passed.
- **110/110 affected usage tests passed**, zero failures/skips: reporting, coverage, migration, counters/costs, time/range behavior, native routes, ingest, snapshots and visibility. No unrelated full suite, frontend suite, screenshots or AutoReview was rerun.
- Nine new real-SQL coverage regressions include old-writer gaps, duplicate ingestion, deletion/rowid reuse, stale metadata, atomic failure, initial rollout and pinned/resumed current-generation rounds. Six initial regressions were red on the original implementation.
- The required persisted native test uses actual shipped proxy, accounting/queue, authority/session report/events routes and the same SQLite/KV resources across code restarts. It covers both initially empty and completed historical projection states, first with a pre-tracking3cb gap and then with a future rollback after repaired tracking is installed.

| Starting state | Exact old3cb omission after6f write | Repaired report/events before apply | Future old-writer rollback | Preserved debit micros |
|---|---|---|---|---|
| Initially empty | 0calls, falsely complete, versus1canonical call | 1call via retained ledger, projection incomplete | 2calls via retained ledger; explicit repair restores projection | 17then34 |
| Completed3call historical projection | 3calls, falsely complete, versus4canonical calls | 4calls via retained ledger, projection incomplete | 5calls via retained ledger; explicit repair restores projection | 68then85 |

In every repaired cycle historyComplete remains truthful through canonical reads; reads do not backfill. Dry-run is read-only, explicit apply uses batchSize2, and raw payload digest/settings/debits/event IDs are preserved. See rollback-reupgrade.json; source hashes bind the repaired runtime. Reproduce with node --test worker/test/usage-report-rollback-runtime.test.mjs. Source archives are exact6fceb88 and3cb0326; synthetic credentials/provider wire/clock setup only, no production traffic or real billing/JWT acceptance claim.

## Accepted evidence and remaining gates

The accepted navigation-runtime.json and authenticated-upgrade.json are retained **3cb0326 source snapshots**, not rerun or relabeled as proof of this later store patch. Their source identities are checked against that Git revision. The new rollback artifact covers this changed source. Earlier screenshots/performance measurements retain their prior capture provenance.

The coordinator accepted the qualified original-base validation: CLI/WebSocket cases reproduced on original6f; JSON body reuse remains context-dependent/unclassified. Preserve those limitations in the PR, without claiming all-green or blocking the open PR on unrelated harness repair. Source correctness review of the new exact committed range remains the publication hold; CI and merge gates are separate. No merge/deployment authority is implied. No ordinary AutoReview substitutes for the required pinned full review.
