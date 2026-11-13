# Deployment train after the large HTTP launch

The source deployment hold remains enabled. This follow-up does not authorize
or perform a production deployment, secret rotation or infrastructure change.

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
native owner/fingerprint protocol sources are also refused. A separate compatible
single cutover can be designed and rehearsed for such changes, allowing temporary
turn failures; this follow-up does not add that unattended path. Do not introduce
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

## Validation and behavior proof

Claim: ordinary deployment cannot silently drop the supported large request
envelope, native runtime or persistent owners; neither recovery owner restores
an incompatible version.

Focused checks:

```sh
node --test test/deploy-train*.test.mjs test/large-http-release.test.mjs
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
Removing the source hold remains a separate reviewed and authorized decision.
