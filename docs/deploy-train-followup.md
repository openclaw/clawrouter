# Deployment train after the large HTTP launch

The ordinary source hold is released. This follow-up does not authorize or
perform a production deployment, secret rotation or infrastructure change.
Cross-digest activation is separately fail-closed until its exact payload pair
and controller bytes have reviewed hosted qualification.

## Compatible ordinary deployments

The train accepts the ingress-enabled launch version
`c5fd84d0-0767-4df5-83d3-78c0588c8689`, tagged with landed source
`434a526a37fff4d91e04cc1caa5cd6aa2eff2d82`, as its initial native artifact
anchor. Its native digest is
`6475f07303ec02b2a981825e95224b0e89e38d2d7ab0079279d839beb31e3671`.
Source selection already accepts this full tag; no manual-journal exception or
live annotation rewrite is needed. Subsequent uploads carry a versioned native
digest receipt alongside their existing preserved-secret lineage marker.

Before console publication, queue observation or version upload, the train:

1. Verifies unchanged native lifecycle/classes, actor declarations, container
   configuration and fingerprint/owner protocol sources. Existing cron, queue,
   routes, unsafe-format and source-hold checks remain in force.
2. Builds the actual Worker/native/assets once. Checks native digest against
   blue, hashes every build input, verifies the Worker and private runtime bytes,
   and compares rendered owner bindings and overridden vars to blue. Changed
   capacity, credentials, state owners or native configuration need a separately
   reviewed release.
3. Freezes the existing release package, verifies its manifest and complete file
   inventory, and uploads only its ingress-enabled green configuration, without
   build hooks. Account, Worker and source identities must match. Bootstrap and
   ingress-closed blue are never ordinary upload or recovery targets.

After upload, before even 0% inclusion, blue and green must retain matching
native receipts and exactly matching version binding metadata. This includes
the seven actor namespace IDs, KV, queue, archive bucket, all vars, secret names,
and the private assets binding. The existing latest-upload lineage check covers
secret inheritance; matching names alone cannot establish equal secret values.
Private runtime files stay in version assets, outside public console R2 assets.

`runtimeConfig` includes the runtime digest, control token and settings in the
native fingerprint. A mismatch drains existing slots in the shared allocator.
Therefore a percentage rollout across different fingerprints is refused, even
at 0%: override smoke and non-HTTP triggers can touch shared state. Changes to
native owner/fingerprint protocol sources are also refused by the ordinary train.
The explicit, qualified native cutover below is separate; it never includes an
incompatible candidate in a percentage split, including 0%. Do not introduce
socket migration or seamless handoff solely to avoid a momentary failed turn.

The normal rollout steps and timing remain unchanged. Both in-process recovery
and the independent fresh-runner job re-read immutable blue/green metadata and
latest-upload lineage before restoring blue. Missing receipts, pre-migration or
ingress-closed versions, different native digests and owner/secret drift stop
recovery without a rollback write. Preserve uncertainty and repair forward if no
compatible target can be established. Never blindly replay upstream inference.

The completion journal includes the non-secret native receipt so a fresh runner
does not depend on local installation or artifact paths. Existing deployment
ownership and ambiguous-write readback guards remain required.

## Explicit native payload replacement

Manual native-cutover mode retains exact-head CI, source/owner/configuration,
secret-lineage, logging, immutable artifact and health/smoke gates. No source hold,
credential, class, storage owner, provider pool, native lifecycle or envelope is
removed. The only protocol-source exception is the reviewed additive control in
continuous.ts, lifecycle.ts and native-slot.ts; its bytes are included in the
qualification identity. Other owner/fingerprint changes still refuse.

Before any publication or upload, config/native-cutovers.json must contain one
reviewed entry for the exact blueRuntimeSha / greenRuntimeSha, tested source
commit (source), hosted Actions evidence URL (evidence), and controlSha256
returned by nativeControlDigest(). The tested commit must be an ancestor of the
candidate with byte-identical determining code (the later registry commit cannot
self-reference). The registry is currently empty: offline
fixtures are not permission or hosted qualification. Changing determining release,
workflow or control bytes invalidates the qualification. Do not populate this
registry with a local test result or a run that did not exercise both directions.

Two ingress-enabled immutable versions are uploaded without secret changes:

- Candidate: current edge/control and current native payload.
- Compatible recovery: **current edge/control** plus the exactly reproduced
  deployed native payload. Its native source is separately annotated. Recovery
  never returns to the original unfenced control code or ingress-closed bootstrap.
  A temporary source-only archive reproduces those native bytes using the current
  pinned shared dependencies, refuses any digest mismatch, and is deleted after
  consumption. No historical dependency install is attempted.

The coordinator journals its recovery version and identities remotely before the
first admission write. An ordinary completed rollout may retain an older version
at 0%; the coordinator first verifies its identical native digest and owners, then
removes it in that blue-only journal before draining. It closes admission on original blue, waits for all eight
slots to be idle after exact-generation destruction acknowledgement and observed
absence, with no grants/members/replay history, then selects **only** candidate at
100%. The drained switch requests Cloudflare's immediate DO code-update strategy;
its readback must retain that strategy. Neither this option nor an edge version
header substitutes for runtime inspection.

Enabling requires the new pool control protocol. Warm completion requires each
actual native journal's generation, boot, fingerprint and payload digest to match
the pool, current slot configuration and selected artifact. An optimistic pool
ready bit, mixed slot runtime, unknown inspection or legacy slot journal cannot
pass. Admission uses a durable revision CAS and an operation ID: late enable
requests cannot reopen a newer recovery drain. Legacy boolean-only control can
only be used to **close** original blue; it is never a recovery enable path.
After a managed fence exists, manual admission control also requires the current
expectedRevision from GET and a new bounded operationId with the accepting
boolean. Do not clear the fence to restore old operator commands.

In-process and fresh-runner recovery use the same ordered replacement: fence and
drain whichever owned version is active, select only the compatible recovery
version, enable with a fresh CAS, verify exact native warmth, then record terminal
recovery. A runner lost while warming recovery resumes warming instead of draining
it again. Mutation-response loss is reconciled with reads, never a blind POST
retry. Foreign deployment/lineage, blocked destruction or unresolved custody stops
without overwriting another owner or clearing a native journal.

Each drain/warm wait is bounded at ten minutes (the runtime's 460-second drain
is unchanged); control-code convergence is bounded at one minute per direction.
The recovery job has a 25-minute ceiling. Exhausted startup credit or ambiguous
destruction can still require operator repair; a terminal distribution alone is
not a successful recovery. Existing pending accounting/debt remains with its
canonical actors and no upstream inference is replayed.

The deploy and recovery jobs need a usable existing admin bearer in the
runner-only CLAWROUTER_NATIVE_ADMIN_TOKEN secret, plus the paired native Access
service-token secrets where Access requires them. The existing admin **hash** is
not a bearer. This change adds references only; it creates/rotates no credential,
Access policy or infrastructure. Credential availability must be verified before
publication/upload. Missing access is a blocker, not a reason to weaken auth.

The [isolated controller Actions path](native-cutover-qualification.md) supplies
explicit non-production targeting and fresh-runner execution. Its receipts remain
controller-only until the external synthetic/Codex/accounting evidence is complete.
Production native-cutover smoke is non-inference; ordinary rollouts retain their
existing golden-provider smoke.

Hosted qualification must use authorized isolated resources and synthetic upstream
credentials. Cover old/new callbacks, shared allocation and non-HTTP triggers,
actual slot adoption, pending/uncertain accounting, maximum/overflow envelopes,
admission/drain/absence, both cutover and fresh-runner recovery at interruption
boundaries. Deploy during a real Codex turn, then complete a **distinct,
context-dependent follow-up in the same saved session** after each direction.
Record source/artifacts/versions, session/turn identities, timestamps, recovery
duration and intervention. HTTP reconnects and local allocator fixtures do not
satisfy this gate. No current isolated resource/access has been qualified by this
change; production must not be mutated merely to fill that evidence gap.

## Validation and behavior proof

Claim: ordinary deployment cannot silently drop the supported large request
envelope, native runtime or persistent owners; neither recovery owner restores
an incompatible version.

Focused checks:

```sh
node --test test/deploy-train*.test.mjs test/deploy-native-cutover.test.mjs \
  test/build-native-recovery.test.mjs test/large-http-cutover-control.test.mjs \
  test/large-http-release.test.mjs
```

Controlled real coordinator proof, with dependencies/admin assets built first:

```sh
pnpm --dir admin build
node scripts/build-default-worker.mjs
node scripts/proof-deploy-train.mjs /absolute/path/to/a/new-proof-directory
```

The proof uses actual build/release artifacts, the real upload command adapter,
train coordinator and a separate recovery process. A local CLI shim replaces
Wrangler, and HTTP is redirected to a local API fixture. No live credentials or
Cloudflare resources are used. The proof records head, artifact digests, API
requests, frozen config selection and fresh-process recovery. Negative tests
exercise disabled ingress/lifecycle, missing token/assets, changed owners,
configuration and containers, corrupted files and unknown upload lineage.

This controlled proof establishes coordinator behavior; it does not establish
Cloudflare rollout convergence. The isolated real Codex rehearsal separately
deploys while a turn is active, then completes a distinct context-dependent
follow-up in the same saved session. Record recovery time, active overlap and
manual intervention. Reconnection alone is insufficient; uncertain inference is
not replayed. HTTP/SSE evidence does not establish WebSocket continuity or
statistical performance qualification.

The sole pinned performance baseline remains
`17cb1a003efa00e572f2c88f227517c5bd9008f3`. This deployment-only follow-up does
not change the data plane or close the earlier Cloudflare WebSocket uncertainty.
Any source hold remains authoritative; this path does not bypass it.
