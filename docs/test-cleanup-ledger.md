# Test cleanup ledger

Audit base: `6fceb88`. Inventory: 165 Worker, 15 admin unit, 79 script/runtime,
and 20 browser test files (279 total). Initial reference and identical-content
scans found no orphaned fixture names or identical test files. Consumer tracing then found the inert provider fixture
references below. Semantic duplication still needs manual review.

| Change | Evidence and retained coverage | Validation |
| --- | --- | --- |
| Remove `worker/test/structure.test.mjs` (2 tests) | Line count, banned toolchain words, and exact package command spelling constrain source layout without exercising behavior. CI already compiles providers, typechecks, builds the Worker and admin, and runs runtime smokes. | Both tests passed before deletion; all CI checks passed. Landed in [#359](https://github.com/openclaw/clawrouter/pull/359). |
| Remove `admin/test/retained-content.test.mjs` (9 tests and fake React harness) | Slices `UsageScreen` source before JSX and supplies its own hooks. `admin/browser/retained-content.spec.ts` exercises the same stale success/error ordering, cancellation, close/reopen, clearing and navigation through real React. Added late-error navigation coverage to match the removed harness. | 9 removed tests and 227 remaining admin unit tests passed. Crabbox: 26 desktop/mobile browser cases, admin build and all three Worker smokes passed; CI passed. Landed in [#359](https://github.com/openclaw/clawrouter/pull/359). |
| Assert content provisioning commands instead of source spelling | The render-config suite scanned provisioner source for adjacent lifecycle ID/prefix literals. The executable provisioner test only checked four argument words and could miss the wrong bucket or retention. Assert complete emitted commands in that test; keep deploy ordering and rendered-config checks. | Seven focused tests passed before and after; a temporary 3-day retention mutation failed the emitted-command assertion, then the production script was restored byte-for-byte. Autoreview clean through P2. |
| Run native-capability compiler mutations in process | The suite launched a fresh compiler process and temporary manifest for each case, repeating CLI behavior already owned by `test/provider-compiler.test.mjs`. Keep all native metadata mutations and index assertions through the imported compiler. Keep one invalid-native CLI case proving no partial output/file; bundled snapshot equality remains in the Worker compiler suite. | Crabbox: all four original tests and 28 refactored/related compiler tests passed, with no skips. All 22 manifests match the shipped snapshot. Autoreview clean through P2. Removes 28 subprocesses from the native suite; one invalid-native CLI check remains. |
| Remove 12 `providers/_fixtures` payloads and `tests.fixtures` manifest metadata | Only six manifests reference the paths. The compiler validates strings but never reads the payloads or emits the metadata; the smoke planner selects targets from compiled endpoints. Remove the inert schema field and reject it through the existing unknown-field test. | Crabbox: all 22 manifests compile, focused compiler/native-capability/smoke-plan/smoke-format tests pass, generated snapshot equality passes, strict smoke plan passes. Autoreview clean through P2. |
| Verify self-host revocation through a subsequent scoped catalog request | The smoke only checked successful revocation mutation responses before claiming success. Require HTTP 403 and `proxy_key_revoked` with the same key after revocation. | Built-container CI confirmed revoked keys return 403. Update the existing liveness fixture to model revocation and reject ignored revocation or server failure. Focused liveness tests cover the smoke contract. |
| Remove `admin/test/use-usage.test.mjs` (11 tests and fake React harness) | Browser refresh tests already cover initial/retry reads, stale snapshot/time retention, off-screen invalidation, coalescing, and principal remounts. Add late ledger failures to metadata ordering and principal replacement cases. Drop internal promise/object identity checks with the source-rewriting harness. | 11 tests passed before deletion; remaining admin unit suite passed. Crabbox: admin build and 40 desktop/mobile refresh cases passed with retries disabled. Autoreview clean through P2. |

| Gate four refresh-runtime races on provider response release | Fixed 300 ms delays could settle before the stale-generation write, disconnect, or reconnect. Hold provider responses until the competing action is observed; assert the caller receives AbortError and poll persisted rotation after disconnect instead of sleeping 500 ms. | Crabbox: frozen install and all 25 workerd cases passed with no skips. Autoreview clean through P2 after moving the gate into a fixture Durable Object; no production changes. |

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
