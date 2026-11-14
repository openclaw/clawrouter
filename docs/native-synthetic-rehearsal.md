# Synthetic-only native rehearsal

Executable complement to [the isolated controller](native-cutover-qualification.md),
not a qualification receipt. All outputs remain **qualified:false**. The
coordinator owns provisioning, credentials, versions, Actions dispatch, evidence
review and resource deletion. These helpers neither provision nor upload.

## Boundaries

- Only an isolated `worker` named `clawrouter-native-qualification-<12 lowercase hex>`
  and its exact HTTPS workers.dev origin. One matching `<worker>-large-http`
  container app; local actors only; no routes or service bindings.
- Actual production ContinuousController and eight-slot inspection. Do **not** set
  LARGE_HTTP_DEADLINE: that selects another controller. Ordinary build/start
  defaults stay unchanged. Only the explicit synthetic entry substitutes startup.
- Before start: HTTPS intercepts for api.openai.com and the owned origin; deny
  other HTTP; Internet disabled. Node trusts
  `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. No disabled TLS checks.
  The provider handler never fetches a provider. Callback forwarding allows only
  runtime/settings/dispatch/finish/do/kv/queue/archive at the owned origin and
  refuses redirects. Authorization and generation fencing remain production code.
- One-shot old-format policy/credential state, two actual synthetic grants, real
  reserve budgets and usage queues. Request content retention is disabled.
- At most 40 native starts, 64 provider attempts, one hour from preparation.
  A durable expiry alarm closes admission; the startup wrapper also terminates
  each process at expiry. Neither bound alters the native asset. Cleanup is still
  mandatory; process exit is not proof of resource deletion.
- Synthetic answers require the seed present in the **actual request context**.
  Each follow-up omits that seed and changes the case/direction challenge. Only
  IDs, timestamps, digests, accounting totals and outcomes enter evidence.

## Coordinator preparation contract

Use a clean exact reviewed source and its locked shared dependency graph. Have
an existing built console and an inspected rendered TOML with account_id,
no_bundle/keep_vars, the seven canonical actor bindings, separate policy KV,
queue/DLQ, content bucket, native container and the current migrations. Set:

```toml
[vars]
LARGE_HTTP_ORIGIN = "https://clawrouter-native-qualification-<id>.<subdomain>.workers.dev"
CLAWROUTER_PUBLIC_ORIGIN = "https://clawrouter-native-qualification-<id>.<subdomain>.workers.dev"
LARGE_HTTP_CAPACITY = "8"
LARGE_HTTP_TESTING = "1"
```

Do not include plaintext secrets, runtime digest/size overrides, fixture vars,
foreign actor script names, production container names or an existing fixture
binding. The helper adds its own eighth actor, NativeRehearsalState, using a
separate migration. Resolve all persistent owner IDs against production before
upload; name checks alone cannot establish namespace isolation. Also inspect
queue consumers, cron and native resources outside version metadata.

From the reviewed checkout, package into a **new directory under that checkout**
so the old source build uses the existing dependency graph:

```sh
node scripts/prepare-native-rehearsal.mjs \
  /private/owned-rendered.toml .native-rehearsal-package \
  "$OLD_NATIVE_SOURCE_SHA" "$OLD_NATIVE_SHA256"
```

Inputs are the real deployed native-source receipt, not a new native patch.
prepareNativeRecovery must reproduce the exact digest or preparation refuses.
The preparation.json reports source/control/payload identities and immutable
manifest paths. Both payloads share the same frozen asset inventory. It supplies:

- bootstrap: old payload/current control, native lifecycle disabled;
- blue: old payload/current control, ingress enabled;
- green: current payload/current control, ingress enabled;
- recovery: the same artifact/config as blue, **uploaded as a distinct version**.

Coordinator: deploy the bootstrap first, provision only isolated scoped secrets,
run client setup below, then activate blue and await actual eight-slot warmth.
Upload blue/green/recovery using the immutable release mechanism and normal
uploadMessage receipts/secret lineage described in the controller document.
Blue and recovery receipts need nativeSource set to OLD_NATIVE_SOURCE_SHA;
green/recovery tags use the exact controlling source. Do not copy production
secret values or change the production upload adapter's target guard.

## Saved-client commands

Inject only temporary inputs into the command environment:

- NATIVE_REHEARSAL_ACCOUNT_ID: inspected account ID (not a token);
- NATIVE_REHEARSAL_ADMIN_TOKEN: isolated admin bearer;
- CLAWROUTER_CODEX_BINARY: explicit official Codex executable;
- optional paired CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET, accepted by the
  fixture origin. Catalog and native Codex calls carry the same pair.

No Cloudflare management credential is consumed by the client. It creates a
private Codex HOME, session secret and random seed. Never publish its session.json
or codex directory; publish only evidence.json and the content-free controller
receipts. Do not run two mutating clients against one directory. An owner
subdirectory prevents concurrent writers; an abrupt runner death leaves that
lock for operator reconciliation, not automatic inference replay.

```sh
P=.native-rehearsal-package/preparation.json
C=/private/new-native-client
node scripts/native-rehearsal-client.mjs setup "$P" "$C"
# Coordinator activates prepared blue and observes eight real healthy slots.
node scripts/native-rehearsal-client.mjs seed "$P" "$C" "$BLUE_VERSION"
node scripts/native-rehearsal-client.mjs overlap "$P" "$C" forward "$BLUE_VERSION" "$GREEN_VERSION"
```

While overlap runs, use another terminal for read-only inspection. Wait until its
case is active before dispatching the existing controller workflow. The client
observes a dispatched grant and unfinished native turn at actual admission close,
then releases the provider hold. It waits for exact replacement attestation and
completes a distinct context-dependent follow-up in the same saved thread. A
120-second hold bounds coordination; a timeout is a failed case, not proof.

For fail-smoke or interrupt-green, choose a 30-second green hold. After forward
overlap **finishes**, promptly start recovery overlap during that hold. The native
router's unmodified 120-second request deadline bounds the entire held turn. If
Actions queue/startup cannot reach admission close in that window, record a failed
case and clean up; do not lengthen the old native timeout or call it proof:

```sh
node scripts/native-rehearsal-client.mjs overlap "$P" "$C" recovery "$GREEN_VERSION" "$RECOVERY_VERSION"
node scripts/native-rehearsal-client.mjs workloads "$P" "$C" "$RECOVERY_VERSION"
node scripts/native-rehearsal-client.mjs inspect "$P" "$C"
```

Workloads send success, definitive HTTP 400 rejection, a partial-response loss,
exactly 64 MiB and 64 MiB + 1. They check actual selected version, settlement,
content non-retention, no replay, quarantine of only the affected slot and no
provider call for overflow. The lost attempt must remain charged/quarantined;
rejection must refund. Upstream scanning permits 1 MiB transform overhead beyond
the native ingress limit (e.g. inserted store:false); client limits do not change.

Every mutation records an intent first. On failure, run inspect; do not rerun a
pending seed/turn/workload or clear its journal to get a green result. Keep the
failed observation and clean up. After an externally confirmed interrupted-drain
recovery that never exposed green, use an ordinary saved-thread follow-up:

```sh
node scripts/native-rehearsal-client.mjs followup "$P" "$C" recovery "$RECOVERY_VERSION"
```

This checks continuity but does not claim overlapping green-to-old replacement.

## Complete hosted matrix, not a single green workflow

Use fresh isolated namespaces/version lineage/client directory for each row;
do not reuse a terminal tuple or clear custody to force another forward run.

| Controller mode | Required independent client evidence |
| --- | --- |
| cutover | seed, forward overlap/follow-up, workloads on green |
| fail-smoke | seed, both overlaps/follow-ups; ordered recovery and workloads |
| interrupt-green | both overlaps; recovery in the workflow's separate runner, no downloaded first-run state |
| interrupt-drain | old-state seed/workload, interrupted admission/drain, fresh-runner recovery, saved-thread follow-up |

Review actual Actions source/head/run/attempt, version receipts, owner isolation,
all eight attestations, closed admission/absence before each replacement, old
callbacks settling after close, unchanged old persistent owners, accounting,
quarantine/no replay, maximum/overflow isolation, non-HTTP consumers/triggers,
recovery latency and intervention. Missing evidence stays missing. Neither a
controller receipt nor local tests can populate config/native-cutovers.json.

## Cleanup and local verification

```sh
node scripts/native-rehearsal-client.mjs cleanup "$P" "$C"
```

Cleanup closes admission through the real fenced controller, waits for native
absence, and removes local session material. Its receipt explicitly says
hostedResourcesDeleted:false. The coordinator must delete the owned Worker,
container resources, isolated namespaces/KV/bucket/queue/DLQ/consumers/triggers and
temporary secrets, reconcile actual absence, then remove consumed packages. Keep
only the compact evidence needed for review. Do not restart Odin or the Mac app.

```sh
CLAWROUTER_CODEX_BINARY=/absolute/path/to/codex node --test \
  test/native-rehearsal.test.mjs test/native-rehearsal-runtime.test.mjs \
  test/prepare-native-rehearsal.test.mjs
```

The runtime test executes the exact old/current native bundles against real
fixture DO/SQLite budgets using a local-only transport adapter. Its allocator
ACKs are controlled; it does not test Cloudflare interception or eight containers.
The official saved-Codex test proves request-context compatibility locally, not a
hosted cutover. Without the explicit binary that test reports skipped, not passed.
