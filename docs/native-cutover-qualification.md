# Isolated native controller qualification

This is the controller execution path, **not a complete qualification harness**.
No result here authorizes production, edits the qualification registry, or proves
synthetic-provider, accounting, old-state or Codex-session behavior by itself.
The deployment coordinator owns authorization, resource/credential preparation,
synthetic workloads, evidence review and teardown. No resources are provisioned
or uploaded by this workflow.

## Prepared target and versions

Use a temporary Worker named `clawrouter-native-qualification-<12 lowercase hex>`
and its exact `https://<worker>.<account-subdomain>.workers.dev` origin. Production
and FakeCo targets are not accepted. The account is the production account so
live, read-only production binding metadata can establish disjoint persistent
owners. A missing/denied production metadata read is a blocker, not an override.
The API adapter allows mutations only to the isolated Worker's deployments.
Native admin requests retain bearer authentication, optional paired Access
credentials, redirect refusal and selected-version response checks.

Before dispatch the coordinator must prepare, inspect and own:

- Separate seven actor namespaces, policy KV, content bucket, queue/DLQ,
  non-HTTP consumers/triggers and native resources. The runner compares all
  namespace/queue/bucket binding identities with current production and requires
  the isolated origin; it does not provision or attest non-versioned consumers.
- Synthetic-only policy/grants and upstream transport; no real provider keys or
  production client sessions. Do not substitute the real service named Synthetic
  for a deterministic test upstream.
- Original blue carrying the exact deployed old native bytes, healthy at 100%,
  with real old persistent state. Its source and native digest must have the
  normal native receipt. Do not relabel a mock as the launch payload.
- Green carrying current reviewed edge/control and current native payload.
- Recovery carrying the **same current edge/control** and exactly reproduced
  old payload, with the normal native-source annotation. Never restore unfenced
  old control as recovery.

Existing packaging mechanisms are `build-default-worker.mjs`,
`prepareNativeRecovery` in `build-native-recovery.mjs`, and
`prepareLargeHttpRelease` / `verifyLargeHttpRelease`. Build the current artifacts
once using the pinned shared dependencies. Prepare an explicitly isolated rendered
config (its Worker/account/origin/owners must be inspected). Set
`state.cutover.nativeSource` and `state.cutover.blueRuntimeSha` to the real old
source/digest when invoking `prepareNativeRecovery`; it refuses a reproduction
mismatch. Upload only the verified green stages with the existing Wrangler
`versions upload --config <green.toml> --tag <source> --message <receipt>` mechanism.
Generate each message with `uploadMessage`, never manually rewrite deployed
metadata. Green and recovery share `state.run`, `state.sha` and original
`state.blue`; recovery additionally has `nativeSource` and the old native digest.
Keep the entire contiguous preserved-secret lineage. No secret rotation occurs.

The ordinary `prepareNativeUpload`/`nativeUploadConfig` production train remains
production-only; do not fake a production environment or relax its owner/settings
checks to upload this fixture. The coordinator's isolated provisioning/config and
immutable release upload are a separately authorized preparation step.

**Unresolved synthetic egress prerequisite:** OpenAI's origin is compiled into
the old native payload, and this path adds no origin override or native shim.
A source-patched old native module is not the exact old payload. The coordinator
must first establish a reviewed synthetic-only transport that preserves the
claimed payload bytes and accounting behavior. Until then, do not run paid
inference and do not claim the full hosted gate passed. The controller can be
exercised without inference, but that does not close this prerequisite.

## Actions inputs

Workflow: `qualify-native-cutover.yml`, manual dispatch on exact reviewed main.
The checkout, `expected_sha`, green/recovery tags and controlling source must
agree. Forward execution also requires successful exact-source main push CI and
all existing required jobs. Recovery does not depend on CI being available.
No package installation or local artifact is required on either runner.

Environment `native-qualification` supplies only these distinct secrets:

- `NATIVE_QUALIFICATION_CF_API_TOKEN`, `NATIVE_QUALIFICATION_CF_ACCOUNT_ID`
- `NATIVE_QUALIFICATION_ADMIN_TOKEN` (the bearer, not its hash)
- Optional paired `NATIVE_QUALIFICATION_ACCESS_CLIENT_ID` and
  `NATIVE_QUALIFICATION_ACCESS_CLIENT_SECRET`

The coordinator supplies six non-secret dispatch inputs:

| Input | Value |
| --- | --- |
| `expected_sha` | Full reviewed source SHA, equal to dispatch SHA |
| `worker` | Prepared isolated Worker name above |
| `origin` | Exact HTTPS workers.dev origin, no trailing slash |
| `versions` | JSON `{"blue":"<UUID>","green":"<UUID>","recovery":"<UUID>","run":"<numeric upload-lineage run>"}` |
| `mode` | `cutover`, `fail-smoke`, `interrupt-drain`, `interrupt-green`, or `recover` |
| `hold_seconds` | 0–300; default 120, after green's actual eight-slot warm check |

`cutover` exercises successful terminal forward completion. `fail-smoke`
executes the real ordered recovery in-process after a deliberate smoke failure.
`interrupt-drain` exits after the acknowledged admission-close mutation;
`interrupt-green` exits after actual green warmth/non-inference smoke and the
bounded hold. Neither writes terminal success. A different Actions job/runner
reconstructs the exact journal and executes recovery without downloading the
first job's receipt. Real runner failure/cancellation also requests this recovery
job. For an interrupted/cancelled workflow whose recovery job did not run, rerun
that job at the original Actions source; never blindly redispatch a mutation.
`recover` is also available while the exact original source remains main.
Foreign journals, drift or uncertain destruction fail closed.

The optional hold is an observation window, **not synchronization proof**. The
coordinator must observe the independent synthetic client and time actual active
turn overlap; a timer or workflow success is not evidence of that overlap.
After each direction complete a distinct context-dependent follow-up in the same
saved Codex session. Preserve content-free session/turn IDs, timestamps, native
attestations, version/payload IDs, recovery time and intervention. A later HTTP
request, a fresh session or an unsaved thread is insufficient. Cover old persistent
state/mixed callbacks, admission/drain/absence, shared allocation/non-HTTP triggers,
pending/uncertain accounting and no replay, max/overflow envelopes, normal failure,
interruption and a fresh runner. Reusing the already-terminal same tuple is not
another forward exercise; coordinator preparation must establish the next exact
owned starting tuple without bypassing fences or clearing custody.

Receipts contain source, determining-control digest, payload pair, versions,
Actions run/attempt and content-free snapshots. They always say `qualified:false`.
Review all external evidence plus both runner artifacts before a separate registry
PR. Registry `source` is the tested source ancestor, `controlSha256` the recorded
digest, and `evidence` the actual Actions run URL. Determining code changes,
including this workflow/smoke/target path, invalidate earlier qualification.

## Production smoke

Native-cutover production smoke no longer runs `cf:smoke`'s mandatory real-provider
inference. It retains selected-version health, console verification, provider
catalogue and unauthenticated inference rejection. Exact payload/owner/secret
checks, eight-slot runtime attestation and reviewed hosted qualification remain
mandatory. Ordinary same-runtime rollouts retain their existing golden-provider
smoke; this is not a global skip-live flag.
