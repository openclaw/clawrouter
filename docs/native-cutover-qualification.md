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

During owned deployment convergence, a snapshot GET returning HTTP 500 from
the exact selected Worker version or an explicitly allowed previous immutable
version is recorded as pending within the existing phase deadline. A previous
version may still answer after the deployment API selects its replacement.
Immediate Durable Object code adoption can interrupt a snapshot; HTTP 500 alone
does not establish either cause. Ownership is checked before every
observation, and only a successful validated snapshot can establish readiness.
Persistent errors time out; authentication errors, unknown versions and malformed
successful responses fail immediately. No activation, admission or inference
mutation is replayed. The shared `observeNativeControl` helper also supports
coordinator startup observation with its own admission/runtime guards.

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
- Green carrying current reviewed edge/control and current native payload for
  `kind: payload` (the default). For explicit `kind: control`, green retains
  exactly the blue native payload and its original native-source annotation.
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
For control adoption, the verified old-payload/current-control package is uploaded
twice as distinct green and recovery versions. Generate each message with `uploadMessage`, never manually rewrite deployed
metadata. Green and recovery share `state.run`, `state.sha` and original
`state.blue`; recovery additionally has `nativeSource` and the old native digest.
Keep the entire contiguous preserved-secret lineage. No secret rotation occurs.

The ordinary `prepareNativeUpload`/`nativeUploadConfig` production train remains
production-only; do not fake a production environment or relax its owner/settings
checks to upload this fixture. The coordinator's isolated provisioning/config and
immutable release upload are a separately authorized preparation step.

**Synthetic-only transport:** use the explicit fixture build and client described
in [native-synthetic-rehearsal.md](native-synthetic-rehearsal.md). It registers
Cloudflare HTTPS interception before native startup, trusts the runtime CA and
disables Internet access. Both native modules retain their exact bytes. The
ordinary production build does not import this entrypoint. Local transport and
client tests do not attest hosted interception; that remains an execution gate.

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

Before activating a prepared rehearsal, run **Read-only isolated native
authentication** (`preflight-native-auth.yml`) on exact reviewed main, supplying
`expected_sha`, `worker` and `origin`. This separate five-minute workflow uses
the actual `native-qualification` environment credentials. It reads the selected
version, verifies isolated persistent owners and its configured admin hash, sends
an anonymous HEAD expecting 401 followed by an authenticated HEAD expecting 404,
then confirms deployment stability. Both responses must identify the selected
version. The existing admin router authenticates before rejecting HEAD; HEAD
never calls the pool. This deliberate authentication probe has no GET fallback,
and a changed route/status contract blocks it. Owner checks admit disabled
bootstrap versions without requiring native payload lineage; cutover readiness
checks remain unchanged. Management requests are GETs; there is no activation, admission mutation,
fixture initialization, inference, retry or recovery job. A previously closed
isolated Worker can be used without reusing its terminal fixture. Only the safe
`native-auth-<run>-<attempt>/native-auth.json` receipt is retained.

`NATIVE_QUALIFICATION_ADMIN_TOKEN` contains the **raw bearer** (locally injected as
`NATIVE_REHEARSAL_ADMIN_TOKEN`), while the isolated Worker's
`CLAWROUTER_ADMIN_TOKEN_SHA256` plain-text configuration contains its SHA-256 hash.
This check supplements the metadata-only rehearsal preflight, which does not
authenticate to the Worker. Authentication does not establish native readiness,
session continuity or cutover qualification. Stop on failure; do not activate or
retry the campaign. Recheck if credentials or the target configuration change.

The coordinator supplies these non-secret dispatch inputs:

| Input | Value |
| --- | --- |
| `expected_sha` | Full reviewed source SHA, equal to dispatch SHA |
| `worker` | Prepared isolated Worker name above |
| `origin` | Exact HTTPS workers.dev origin, no trailing slash |
| `versions` | JSON `{"blue":"<UUID>","green":"<UUID>","recovery":"<UUID>","run":"<numeric upload-lineage run>"}` |
| `mode` | `cutover`, `fail-smoke`, `interrupt-drain`, `interrupt-green`, or `recover` |
| `kind` | `payload` (default, different native bytes) or `control` (equal native bytes); preserve for recovery |
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

## Compatible control adoption

Use the explicit production `native-control` mode when old slot controllers must
adopt a repair before replacing native bytes. Packaging reproduces the deployed
payload using its original native source and refuses a digest mismatch; both
candidate and distinct compatible recovery contain that payload with current
control. This mode permits reviewed lifecycle/service changes, retains all
owner/configuration/secret/source/CI checks, and requires a separate registry row
with `kind: "control"` and equal blue/green digests. Ordinary `native-cutover`
still requires different digests and cannot use that row.

Both modes reuse the existing ordered drain, exact absence, full selection,
bounded observation and fenced recovery. Before reopening admission, the pool
and all eight actual slot controllers must attest `artifactProtocol: 1`, as well
as matching configured runtime/fingerprint. Warmth additionally checks each
persisted generation, boot and runtime against the pool. The capability marks
journal-selected artifact authorization; equal payload fingerprints alone cannot
prove that old slot code has adopted it. It adds no inference-path calls.

Pending observations retain bounded sanitized per-slot readiness fields and a
last snapshot on failure. Hosted receipts retain the first 16 and latest 48
observations plus the total count. They do not retain tokens, prompts or grant
IDs. Authentication, ownership, selected-version and deadline failures retain
their existing stop semantics; no mutation is retried.

For a targeted adoption repair, reuse independently valid unchanged payload,
accounting and session evidence. Newly prove adoption from unpatched control,
mixed-version artifact delivery, eight-slot readiness and distinct compatible
recovery. Separately qualify the subsequent exact payload replacement with the
same repaired control. This is not permission to relabel historical results or
skip a changed behavior. Record the finite case/evidence checklist before launch.
No local test or controller receipt populates the qualification registry.

After control adoption, a manual `native-cutover` can select the same source tag
again if its exact main CI passes: the bridge deliberately retained old native
bytes. Packaging must still prove a different payload and the registry must
qualify that exact pair. Scheduled selection and ordinary same-source rollouts
remain no-ops. Production authorization is separate for both stages.

## Production smoke

Native-cutover production smoke no longer runs `cf:smoke`'s mandatory real-provider
inference. It retains selected-version health, console verification, provider
catalogue and unauthenticated inference rejection. Exact payload/owner/secret
checks, eight-slot runtime attestation and reviewed hosted qualification remain
mandatory. Ordinary same-runtime rollouts retain their existing golden-provider
smoke; this is not a global skip-live flag.
