# Test cleanup ledger

Initial audit base: `6fceb88` (279 test files). The final inventory and candidate
screen at frozen revision `62ad4e0` cover every checked-in test: 188 Worker,
81 script/runtime, 14 admin unit and 20 browser files (303 total), plus 26 support
files. No tests were found outside these four roots; every support file has a
consumer reference. The normalized scan parsed all 329 source files without
failures. Its 57 clone groups are a subset of the 68 groups already reviewed at
`56f3e24`: mostly small setup/assertion blocks and distinct embedded Worker
scripts normalized as string literals. These are candidate-screening results,
not a claim that a clone score measures correctness. Concurrent feature additions
after the frozen inventory need their own review.

The continuation at frozen revision `ed4bc0e` parsed 385 test/support files
without failures and screened nine newly reported clone groups. Consolidate the
four hosted-provider contract suites below. Keep small adapter override helpers,
compiler rejection loops, codec-specific assertions and usage receipt polls
local: their surrounding contracts differ. OpenClaw search and embedding
consumer tests have a dedicated pinned-source workflow; their ordinary-CI skips
are intentional. The chat transport matrix exercises Worker/SQL boundaries,
while the hosted contract table checks manifest configuration and local helpers.

| Change | Evidence and retained coverage | Validation |
| --- | --- | --- |
| Fold platform and specialist suites into the shared hosted contract table | At frozen `526e2048`, two additional suites duplicate the same assertions. Move their nine provider rows into the existing table, preserving all 48 cases across 24 providers and Particle’s distinct catalog/upstream IDs. Add their foreign product bindings to the shared isolation check. Removes two compiler subprocesses and 83 net test source lines. | Crabbox: all 48 original cases passed; 738 focused contract, compiler, chat transport and smoke tests passed after consolidation, zero skips. Bundled snapshot equality, strict smoke plan and Worker typechecking passed. Autoreview clean through P2. |
| Consolidate four hosted-provider contract suites | One 15-provider table preserves all 30 named cases, explicit model/URL/binding facts, aliases, opaque model handling and tool/reasoning replay. Test each provider against the union of foreign product credentials. Compile in process; dedicated CLI tests retain process/output contracts. Removes four compiler subprocesses and 124 source lines. | Crabbox: all 30 original cases passed before consolidation; 576 focused compiler, contract, transport and smoke tests passed afterward, zero skips. Bundled snapshot equality, strict smoke plan and Worker typechecking passed. Autoreview clean through P2. |
| Measure realtime revocation after the authority mutation is acknowledged | A hosted run failed at 339 ms; its 250 ms check included the mutation RPC and host polling wake-up. The exact cause of that excess is unproven. Start the enforcement interval after acknowledgement and timestamp the close event itself. Preserve the 250 ms ceiling, egress bound, expected errors and no-egress-after-close checks; report mutation latency separately. | Crabbox: a 300 ms simulated mutation ACK delay fails the old measurement and passes the corrected one (19 ms close). Four concurrent authority-matrix runs passed; all 20 cadence/runtime tests passed with no skips. Autoreview clean through P2. Landed in [#451](https://github.com/openclaw/clawrouter/pull/451). |
| Finish moving Worker manifest mutations in process | The shared compiler helper already ran directly, but quota, reasoning, tier, grant-endpoint, Codex alias and pricing cases still forked the CLI. Keep every mutation and error match through the imported compiler; remove JSON round-trips. The dedicated CLI suite owns stdout/file equality and no-output failure behavior. | Crabbox: 75 focused compiler and smoke-plan/format tests passed, no skips; bundled snapshot equality and strict smoke plan passed. Autoreview clean through P2. Landed in [#441](https://github.com/openclaw/clawrouter/pull/441). |
| Gate transcription disconnect on an explicitly held provider response | The 500 ms provider delay could expire before the caller abort on a slow runner. Hold completion in the existing fixture Durable Object, observe the gate, assert AbortError, then release and verify accounting. Add phase context to transport failures. | Eight unchanged fixture runs passed in Crabbox (four concurrent); the prior CI EPIPE did not reproduce. All eight gated runs also passed, with four concurrent and no skips. Autoreview clean through P2; the EPIPE cause remains unknown. Landed in [#437](https://github.com/openclaw/clawrouter/pull/437). |
| Require the exact-release storage upgrade test in CI | CI shallow checkouts never loaded the pinned v0.4.0 commit, so the real release-to-head case silently skipped. Fetch only that immutable commit with Git maintenance disabled and fail on a missing baseline in CI; preserve local shallow-checkout skips. | Crabbox: missing-baseline negative control fails in CI mode; all five workerd cases pass after the bounded fetch, including the exact-release case, with zero skips. Autoreview clean through P2. Landed in [#417](https://github.com/openclaw/clawrouter/pull/417). |
| Remove `worker/test/structure.test.mjs` (2 tests) | Line count, banned toolchain words, and exact package command spelling constrain source layout without exercising behavior. CI already compiles providers, typechecks, builds the Worker and admin, and runs runtime smokes. | Both tests passed before deletion; all CI checks passed. Landed in [#359](https://github.com/openclaw/clawrouter/pull/359). |
| Remove `admin/test/retained-content.test.mjs` (9 tests and fake React harness) | Slices `UsageScreen` source before JSX and supplies its own hooks. `admin/browser/retained-content.spec.ts` exercises the same stale success/error ordering, cancellation, close/reopen, clearing and navigation through real React. Added late-error navigation coverage to match the removed harness. | 9 removed tests and 227 remaining admin unit tests passed. Crabbox: 26 desktop/mobile browser cases, admin build and all three Worker smokes passed; CI passed. Landed in [#359](https://github.com/openclaw/clawrouter/pull/359). |
| Assert content provisioning commands instead of source spelling | The render-config suite scanned provisioner source for adjacent lifecycle ID/prefix literals. The executable provisioner test only checked four argument words and could miss the wrong bucket or retention. Assert complete emitted commands in that test; keep deploy ordering and rendered-config checks. | Seven focused tests passed before and after; a temporary 3-day retention mutation failed the emitted-command assertion, then the production script was restored byte-for-byte. Autoreview clean through P2. Landed in [#412](https://github.com/openclaw/clawrouter/pull/412). |
| Run native-capability compiler mutations in process | The suite launched a fresh compiler process and temporary manifest for each case, repeating CLI behavior already owned by `test/provider-compiler.test.mjs`. Keep all native metadata mutations and index assertions through the imported compiler. Keep one invalid-native CLI case proving no partial output/file; bundled snapshot equality remains in the Worker compiler suite. | Crabbox: all four original tests and 28 refactored/related compiler tests passed, with no skips. All 22 manifests match the shipped snapshot. Autoreview clean through P2. Removes 28 subprocesses from the native suite; one invalid-native CLI check remains. Landed in [#405](https://github.com/openclaw/clawrouter/pull/405). |
| Remove 12 `providers/_fixtures` payloads and `tests.fixtures` manifest metadata | Only six manifests reference the paths. The compiler validates strings but never reads the payloads or emits the metadata; the smoke planner selects targets from compiled endpoints. Remove the inert schema field and reject it through the existing unknown-field test. | Crabbox: all 22 manifests compile, focused compiler/native-capability/smoke-plan/smoke-format tests pass, generated snapshot equality passes, strict smoke plan passes. Autoreview clean through P2. Landed in [#365](https://github.com/openclaw/clawrouter/pull/365). |
| Verify self-host revocation through a subsequent scoped catalog request | The smoke only checked successful revocation mutation responses before claiming success. Require HTTP 403 and `proxy_key_revoked` with the same key after revocation. | Built-container CI confirmed revoked keys return 403. Update the existing liveness fixture to model revocation and reject ignored revocation or server failure. Focused liveness tests cover the smoke contract. Landed in [#369](https://github.com/openclaw/clawrouter/pull/369). |
| Remove `admin/test/use-usage.test.mjs` (11 tests and fake React harness) | Browser refresh tests already cover initial/retry reads, stale snapshot/time retention, off-screen invalidation, coalescing, and principal remounts. Add late ledger failures to metadata ordering and principal replacement cases. Drop internal promise/object identity checks with the source-rewriting harness. | 11 tests passed before deletion; remaining admin unit suite passed. Crabbox: admin build and 40 desktop/mobile refresh cases passed with retries disabled. Autoreview clean through P2. Landed in [#387](https://github.com/openclaw/clawrouter/pull/387). |
| Gate four refresh-runtime races on provider response release | Fixed 300 ms delays could settle before the stale-generation write, disconnect, or reconnect. Hold provider responses until the competing action is observed; assert the caller receives AbortError and poll persisted rotation after disconnect instead of sleeping 500 ms. | Crabbox: frozen install and all 25 workerd cases passed with no skips. Autoreview clean through P2 after moving the gate into a fixture Durable Object; no production changes. Landed in [#395](https://github.com/openclaw/clawrouter/pull/395). |
| Gate unit-test concurrency instead of waiting 15–40 ms | Budget overlap, rotating refresh, admission prefetch and cold colo coalescing depend on responses remaining pending. Hold those responses explicitly. Force budget responses to complete in reverse order while requiring returned reservations to retain plan order. Keep upper-bound test timeouts. | Crabbox: all 100 tests passed in each of eight runs, four concurrent, with zero skips. Autoreview clean through P2. Landed in [#448](https://github.com/openclaw/clawrouter/pull/448). |

Requested outcomes and evidence:

- **Fix tests and remove junk:** 22 redundant/layout-only tests and 12 inert
  provider payloads removed. Real React late-error coverage replaces the removed
  hook harness cases; the retained assertions are recorded above.
- **Remove broken mappings:** remove the unused `tests.fixtures` field from six
  manifests and the schema. An executable negative case rejects that obsolete
  metadata. All 22 bundled manifests compile and match the shipped snapshot.
- **Refactor:** native and Worker compiler mutations call the compiler directly;
  the dedicated CLI suite retains process/output contracts. Explicit response
  gates replace timer-dependent refresh, transcription and unit-test ordering.
- **Close gaps:** verify revoked catalog access, execute the pinned release-to-head
  storage upgrade in CI, cover late browser failures, require AbortError before
  provider release, and preserve realtime revocation limits while correcting its
  measurement boundary. Each code slice has focused validation and autoreview;
  each landed PR passed CI.

Retained candidates:

- The three remaining admin source-rewriting harnesses cover synchronous
  pre-render admission, same-value/ABA intent, OAuth ownership and lost-ACK cases
  that browser journeys do not fully replace. They prove hook logic, not React
  integration. The removed harnesses had equivalent browser coverage.
- The four remaining provider payloads are consumed by protocol-adapter tests.
  The four Worker fixture entrypoints have runtime/config consumers; all 12
  platform/device screenshot baselines are used by named visual assertions.
- Worker unit and workerd overlap checks different boundaries: local decisions
  versus real runtime, SQL persistence and cancellation. Small shared setup blocks
  do not establish duplicate behavior. Workflow configuration checks retain
  environment/secret binding and command-order contracts; emitted lifecycle
  commands now replace the redundant provisioner source check.
- Remaining timer sites model deadlines, expiry/cadence inputs, bounded polling,
  readiness or post-retirement observation. Browser timer sites only flush the
  event loop. Native engine skips are local opt-outs; CI supplies four pinned
  versions. The pinned storage-upgrade case now fails on a missing baseline in CI.

Browser journeys use real React with mocked HTTP responses. Workerd fixtures use
real local runtime/stores with synthetic upstreams. Protocol fixtures qualify
codecs; none of these proves live provider compatibility or a deployed service.
No release or deployment was invoked for this audit.

The transcription disconnect gate fixed an independent ordering flaw. The
original EPIPE did not reproduce in eight unchanged or eight gated Crabbox runs.
A later [CI recurrence](https://github.com/openclaw/clawrouter/actions/runs/41647646499/job/125957107176)
failed during grant selection/request validation, without identifying the call.
Sixty-four unchanged fixture runs and 300 ordinary unauthenticated uploads passed.
Amplifying that early-rejected upload with 1,000 synthetic multipart fields
reproduced EPIPE in 40/40 requests with the same Undici write stack. Encoding the
same multipart body first passed 40/40 requests. This identifies a reproducible
transport race, but does not prove which call failed in the historical CI run.

The fixture now buffers only the finite unauthenticated upload, keeps the
amplified case, and labels individual requests and upstream counter reads.
Successful uploads and the explicitly gated caller disconnect still use real
TCP and FormData. No retry or production request-body drain was added.

A separate pinned Linux CI run (Node 24.22.1, Miniflare 5.20261023.3-beta,
workerd 1.20261021.1) reproduced the small, unamplified fixture failure:
[5 of 24 independent runs failed](https://github.com/openclaw/clawrouter/actions/runs/41661086524),
all labeled `unauthenticated transcription rejection` with EPIPE. Pre-encoding
only that tiny upload passed [24/24](https://github.com/openclaw/clawrouter/actions/runs/41661785170)
and another [24/24](https://github.com/openclaw/clawrouter/actions/runs/41661865146).
These observations locate a current CI failure without amplifying the payload;
they do not establish which request failed in the earlier historical run.

Run `node test/diagnostics/transcription-transport.mjs` with the checkout's
qualified dependencies to repeat the current fixture 24 times, four processes
at a time. The manual diagnostic has a 90-second global deadline, captures
bounded subprocess output, reports every result and fails on any failed run.
It does not retry failed requests or run automatically in ordinary CI.
