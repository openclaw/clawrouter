# Test cleanup ledger

Audit base: `6fceb88`. Inventory: 165 Worker, 15 admin unit, 79 script/runtime,
and 20 browser test files (279 total). Fixture/helper references and identical
file contents were checked across the repository; no unreferenced fixture or
identical test file was found. Semantic duplication still needs manual review.

| Change | Evidence and retained coverage | Validation |
| --- | --- | --- |
| Remove `worker/test/structure.test.mjs` (2 tests) | Line count, banned toolchain words, and exact package command spelling constrain source layout without exercising behavior. CI already compiles providers, typechecks, builds the Worker and admin, and runs runtime smokes. | Both tests passed before deletion. Existing CI build and runtime gates retained. |
| Remove `admin/test/retained-content.test.mjs` (9 tests and fake React harness) | Slices `UsageScreen` source before JSX and supplies its own hooks. `admin/browser/retained-content.spec.ts` exercises the same stale success/error ordering, cancellation, close/reopen, clearing and navigation through real React. Added late-error navigation coverage to match the removed harness. | All 9 removed tests passed before deletion. Browser validation runs in CI on desktop and mobile. |

Browser tests mock admin HTTP responses; they validate UI integration, not the
full deployed service. Worker workerd fixtures run the real runtime and local
ledgers with synthetic upstreams. Neither proves live provider compatibility.

Next: audit remaining source-rewriting admin hook harnesses against browser
coverage; script workflow text assertions; fixture payload relevance; overlapping
Worker unit/workerd cases; native Codex optional skips and CI coverage. Provider
or feature removals require concrete defects, not test volume alone.
