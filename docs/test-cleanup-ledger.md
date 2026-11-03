# Test cleanup ledger

Audit base: `6fceb88`. Inventory: 165 Worker, 15 admin unit, 79 script/runtime,
and 20 browser test files (279 total). Initial reference and identical-content
scans found no orphaned fixture names or identical test files. Consumer tracing then found the inert provider fixture
references below. Semantic duplication still needs manual review.

| Change | Evidence and retained coverage | Validation |
| --- | --- | --- |
| Remove `worker/test/structure.test.mjs` (2 tests) | Line count, banned toolchain words, and exact package command spelling constrain source layout without exercising behavior. CI already compiles providers, typechecks, builds the Worker and admin, and runs runtime smokes. | Both tests passed before deletion; all CI checks passed. Landed in [#359](https://github.com/openclaw/clawrouter/pull/359). |
| Remove `admin/test/retained-content.test.mjs` (9 tests and fake React harness) | Slices `UsageScreen` source before JSX and supplies its own hooks. `admin/browser/retained-content.spec.ts` exercises the same stale success/error ordering, cancellation, close/reopen, clearing and navigation through real React. Added late-error navigation coverage to match the removed harness. | 9 removed tests and 227 remaining admin unit tests passed. Crabbox: 26 desktop/mobile browser cases, admin build and all three Worker smokes passed; CI passed. Landed in [#359](https://github.com/openclaw/clawrouter/pull/359). |
| Remove 12 `providers/_fixtures` payloads and `tests.fixtures` manifest metadata | Only six manifests reference the paths. The compiler validates strings but never reads the payloads or emits the metadata; the smoke planner selects targets from compiled endpoints. Remove the inert schema field and reject it through the existing unknown-field test. | Crabbox: all 22 manifests compile, focused compiler/native-capability/smoke-plan/smoke-format tests pass, generated snapshot equality passes, strict smoke plan passes. Autoreview clean through P2. |

Browser tests mock admin HTTP responses; they validate UI integration, not the
full deployed service. Worker workerd fixtures run the real runtime and local
ledgers with synthetic upstreams. Neither proves live provider compatibility.

Native Codex skips are intentional when no pinned engine is supplied locally;
CI supplies four pinned versions and passed all four jobs for #359. No skip
removal is justified. Browser timer sites inspected use zero-delay event-loop
flushes, not arbitrary elapsed-time sleeps.

Next: audit remaining source-rewriting admin hook harnesses against browser
coverage; script workflow text assertions; fixture payload relevance; overlapping
Worker unit/workerd cases and timer-based runtime tests. Provider
or feature removals require concrete defects, not test volume alone.
