# Isolated native rehearsal evidence — 2026-11-18

Official Codex 0.167.1 used one saved conversation through an isolated Cloudflare forward cutover and fresh-process recovery. Five synthetic requests completed, including follow-ups requiring prior context; no replay or manual intervention. Admission close to completed follow-up: 23.931 s forward, 22.420 s recovery. Policy/provider accounting matched at 35 synthetic micros with five distinct usage events.

- [Session continuity receipt](SESSION-CONTINUITY-PROOF.json)
- [Attempt result, bounds, timing, accounting and limits](ATTEMPT-RESULT.json)
- [Forward controller observations](CONTROLLER-interrupt-green-PROJECTION.json)
- [Fresh-process recovery observations](CONTROLLER-recover-PROJECTION.json)
- [Independent cleanup verification](HOSTED-CLEANUP-VERIFIED.json)
- [Original file hashes and projection provenance](PROVENANCE.json)

Receipts describe source `e3bfa63b8bd162d2bfd632bafec8842902f74a28` and determining-control digest `1e9d87757d9dcfce668aeb5000e95a0adb6dc26d1d0d3cc9520624835c22afa1`. They are historical evidence, not a qualification registry entry. Controller projections preserve phase, time, ownership/version identities, control state and aggregate counters; detailed per-slot inspection arrays and origin are omitted. No credentials, conversation text, prompts or completions are published.

The subsequent digest-membership repair adds bootstrap/egress helpers to the determining inputs. It changes qualification identity and rejects stale reuse; it does not change the executed controllers, rehearsal helpers or native payloads. The runtime proof is reused only for those unchanged execution paths. The repaired source still requires a new exact-source GitHub Actions qualification before production rollout.

Limits: one bounded rehearsal, synthetic upstream, local exported controllers and deliberate interruption followed by a fresh local recovery process. Held active turns finished during drain; no failed-turn transport retry was forced. This is not a reliability or performance campaign. All owned hosted resources and copied synthetic credentials were removed; production was unchanged.

## Qualification-identity repair proof

Claim: the actual qualification functions admit an unchanged descendant and reject descendants changing only the controller, only `bootstrap.ts`, or only `egress.ts`. Each change starts independently from the same accepted Git commit. [Node/Git execution output](QUALIFICATION-PROOF.tap), command on macOS with Node 24.22.1:

```sh
node --test --test-name-pattern='qualification requires' test/deploy-native-cutover.test.mjs
```

The test creates real disposable Git commits and exercises `assertNativeQualification` against their blobs. It performs no hosted mutations and grants no production qualification. The broader focused suite passed all 104 tests; Worker typechecking also passed.
