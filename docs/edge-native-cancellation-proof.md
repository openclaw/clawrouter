# Isolated edge cancellation proof

This is an offline preparation route for an **instrumented frozen-candidate edge composition**. It does not deploy resources, enable a service, qualify a production release, or prove another provider's cancellation behavior. Cloud deployment, the actual SDK controls, protocol observations and remote retirement remain unrun until separately authorized.

The server source is frozen at `5cfafe8c8df43102365ec900431b8b3be1dd4eb0`, tree `6da1d6ea30f74d18730365c875b2978c61f34ce2`. The builder reads tracked Git objects into a private capsule. It does not merge the candidate's unpublished provider changes into this branch. The four dependency inputs must match the frozen materialized build root; directly building an incompatible current checkout still fails this equality. The SDK consumer is frozen at `d8bb939408aa4d2be7df0161748edb52ebf3b1fb`.

The capsule also contains byte-exact copies of the qualified `stream-chain` and `stream-json` runtime packages, with per-file hashes. This is a bounded build input copy, not an install. Esbuild uses its normal resolver inside that capsule; emitted module identifiers contain no private checkout or temporary paths.

## Resource boundary

The reviewed resource plan must name an account, run, fresh exclusive custody, both public HTTPS origins and exact existing resource IDs. No account or resource availability is implied by the repository template.

| Resource | Isolated name or class |
| --- | --- |
| Candidate Worker | `clawrouter-edge-proof` |
| Synthetic upstream Worker | `clawrouter-upstream-proof` |
| Policy KV | `clawrouter-edge-proof-policy` |
| Usage queue / dead letter queue | `clawrouter-edge-proof-usage` / `clawrouter-edge-proof-usage-dlq` |
| Original SQLite owners | `BudgetLedgerObject`, `UsageLedgerObject`, `PolicyBindingIndexObject`, `GrantCredentialObject` |
| Proof-only receipt owners | `ProofRecords`, `UpstreamRecords` |

The projections preserve the source compatibility date and `enable_request_signal`. They omit assets, cron jobs, R2, containers, Large HTTP and content retention. They cannot qualify those omitted paths. The generic production provisioning, config and target commands refuse this profile.

No deployment or teardown executor is included in this code-only route. Creating the named Workers, KV, queues and SQLite migrations, establishing the public origins, configuring their secrets and validating their remote bindings require a separately reviewed execution plan and authorization. Do not use `cf:provision` or production deployment defaults. A local custody declaration is not authenticated remote custody evidence.

## Offline preparation

With an explicitly reviewed resource plan, the nonmutating plan command is:

```sh
node scripts/edge-proof.mjs plan --profile edge-proof --source-sha 5cfafe8c8df43102365ec900431b8b3be1dd4eb0 --plan-file /path/to/reviewed-plan.json
```

`build` uses the same arguments plus `--output /path/to/new-private-capsule`. It refuses an existing output directory. `render` projects the two dedicated TOML files into an existing owned output directory and refuses existing config files. Neither route reads cloud credentials or calls a cloud API. `--execute`, activation, provisioning and deletion are rejected.

Before any future activation, verify the actual account, complete resource inventory, exclusive ownership, fresh source/build receipts, configured origins, absence of foreign bindings and absence of ambient vendor secrets. The only deployment credential consumer would be Wrangler, scoped to `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for this nonproduction account. No credential lookup or status check is part of preparation.

## Fresh Linux packaging qualification

The `edge-offline-packaging` job uses a fresh standard Ubuntu 24.04 VM and a pinned Node 24.22.1 host controller. Checkout does not persist credentials. The job has only `contents: read`: no environment, injected cloud/provider secrets, OIDC, cache, artifact upload, deployment or SDK execution. Image and dependency acquisition are **online setup**, not offline bootstrap.

The workflow explicitly selects `node scripts/edge-proof.mjs container-ci`. The older `offline-ci` user-namespace implementation remains separate and unchanged; it is not an automatic fallback. Earlier unprivileged-namespace jobs failed before an accepted child entry. Their cause remains unknown. The new container route is implemented and locally tested, but its actual Linux execution is **UNRUN** until a separately authorized ordinary candidate CI run.

### Image and input custody

The official linux/amd64 base is `docker.io/library/node@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02`. Registry manifest bytes and digest metadata were verified without downloading layers. The image config, daemon and actual runtime still require admission; a Dockerfile or tag is not an execution receipt.

The controller constructs an exclusive build context from the 22 explicitly enumerated harness files, the four frozen install inputs and a verified Git snapshot object closure for the exact public Worker source. This copies neither the checkout's `.git` nor its home, configuration, hooks, credentials or unrelated history. A configuration-free anonymous HTTPS fetch occurs during online setup. Original commit, tree and blob identities are verified before writing the minimal object store. The frozen pnpm workspace contains only `admin`; both frozen package manifests, the lockfile and workspace policy are hashed. Version 3 of the context manifest separately binds the current candidate commit/tree, regular-file bytes verified against Git, the complete root/admin/provider-plugin workspace manifests and the plugin package’s eight tracked packaging sources. The current workspace inventory is observed only: it is neither installed nor natively qualified by this proof. Its lockfile and workspace policy can differ from the four frozen bytes, which are materialized directly from verified pinned Git blobs only in the fresh proof context. The whole owner manifest and materialized inventory are bound into `contextHash`; the image revalidates that schema and byte closure. No checkout file or installed dependency is substituted. Ordinary current-workspace CI must independently install and pass the provider-plugin pack/export/isolated-consumer test; source inclusion is not a passing result. Unexpected links, special files, changed inputs or unavailable source fail admission. Source availability has no alternative pin or carrier fallback.

Bookworm amd64 installs its own pnpm 11.28.4 frozen dependencies inside the image. It never borrows Ubuntu or macOS node_modules. The image attests Node 24.22.1 / ABI 137, the exact install inputs, contained workspace links and immutable absolute Node, Git, TypeScript, esbuild and Wrangler paths and hashes. The container supplies the builder's absolute Git executable and fixed credential-free Git environment; no PATH fallback or `safe.directory` override is used. The normal TypeScript and esbuild package resolvers must resolve the attested installed Linux binaries. Executables remain in the immutable image, including native esbuild; writable capsules are never executable binary locations.

The trusted parent uses a new empty Docker configuration and an explicit environment with one local Unix daemon socket. No inherited proxy, auth configuration, remote Docker endpoint or build arguments are accepted. Base and derived image inspection rejects ONBUILD, volumes and unexpected command/environment defaults. The final image ID comes from the successful build's iidfile and is checked against actual image inspection, context/Dockerfile hashes, source/install inputs and the native receipt. A fresh invocation nonce prevents treating an old derived image as this invocation's resource. Labels alone are not proof.

### Builder native-child completion

The builder uses the public `child_process` diagnostics channel before importing its build module. This is source-qualified against Node 24.22.1 commit `ce7aaf1cee78b8cf0ce17364260535c418d3ed26`: constructor publication precedes spawn, while the original `close` follows process exit/error and stdio closure. It uses `errorMonitor`, never an added `error` listener, and never replaces `spawn` or inspects private process handles. The pinned TypeScript 7.0.2 synchronous API uses one same-thread `SyncRpcChannel` child with `--api --cwd <capsule>`; esbuild 0.28.2 asynchronous builds use one service child with `--service=0.28.2 --ping`. The image rechecks these acquisition sources before import:

| Source | SHA256 |
| --- | --- |
| TypeScript `dist/api/sync/api.js` | `e27255574a3c1a3236c4083c769758de3327bba8d3cd19f015551b619ae783d2` |
| TypeScript `dist/api/sync/client.js` | `4cca322e20fff9460d1843a62b2cac4ee963109b4d07e984bed9f54e7baa10b8` |
| TypeScript `dist/api/syncChannel.js` | `132714a6e2dd7fd079f7f67bf9ed41d4123ab2ab4d94043a34ea3b1a8f1fb001` |
| TypeScript `dist/api/options.js` | `b47b35b4b92d2ede9c72018859528eef2a1b57c4539cb7b58eaf1b5be193ea58` |
| TypeScript `lib/getExePath.js` | `96c10fd3a18e165d7323de8e314ac8d755ad96811f9fbc304a5b3ba4e05285cc` |
| esbuild `lib/main.js` | `61ec0ba144ff93f4bf0e96ad6fab6f430ede0aa13e27ace8063ed63ba416b3cd` |

Constructor observation is not spawn confirmation. Exact public executable/argument metadata must match the attested immutable executable and expected route; unknown, missing, duplicate or conflicting routes deny success. A constructor left without a confirmed launch or observable close fails without inventing completion or waiting forever for an impossible event. Original errors, including `undefined`, remain independent of close completion and observation faults.

After the original TypeScript close and esbuild stop calls, the owner refs unresolved original children and joins their actual close promises. A bounded fixed-point drain includes late acquisitions before removing only its own subscriber and listeners. The existing outer builder deadline still bounds unresolved closes. Subscription, listener, ref, drain and reporting failures deny success independently of original build/stop failures. Capsule operations and bytes are unchanged; successful builder completion waits for this barrier. The parent still requires its original builder close, zero final census for **both live and zombie rows**, and independent cgroup retirement. The barrier is not a PID1 reaper, continuous custody proof, or attribution of a previously observed zombie. Hosted execution of this change remains **UNRUN**; inert Node 26 tests do not qualify Node 24 native behavior or SDK/cloud operations.

### Runtime isolation and supervision

The container uses a private PID, network, mount, IPC and cgroup view; network mode is `none`. It drops all capabilities, enables no-new-privileges, requires seccomp filtering and a read-only root, and exposes no caller bind mount, Docker socket, device, port or secret. Docker-generated proc/dev/shm and resolver metadata mounts have an explicit checked topology. The parent correlates the daemon's exact per-container metadata paths with filesystem device/root entries in its own and the target's kernel mount tables; those target mounts must be read-only. It does not traverse Docker's root-owned storage. Ambiguous or changing mappings fail. `/task` is a 2 GiB noexec/nosuid/nodev tmpfs, inside a 4 GiB memory limit with no extra swap; the process limit is 128 and CPU limit is two cores. HOME, XDG, temporary files and logs are created there before use.

The parent records all four real/effective/saved/filesystem UID and GID columns and its exact supplementary groups. Each tuple must be equal, canonical and positive; there is no arbitrary minimum UID. Image ownership and `--user` use those exact host IDs. The child permits no supplementary group except its own primary group. Parent identity is rechecked before start, admission and retirement. Host-visible target IDs, uid/gid mappings, process start identity, namespace IDs and cgroup constraints are read independently by the parent. Matching UID is necessary but does not bypass proc permission, LSM or dumpability failures: unreadable evidence fails. No sudo, capability addition, sysctl, helper container or privilege fallback exists.

This route does **not** claim a private user namespace or cross-UID DAC isolation from the trusted parent. It trusts the local Docker daemon and shared kernel. Compared with the earlier same-UID namespace route, the child has no host-home or arbitrary host filesystem mount. The parent and daemon remain outside that filesystem boundary.

Node PID 1 emits one nonce/context-bound READY frame and waits on its original stdin. Before granting permission, the parent admits the actual container ID/image, host PID/start identity, private namespaces, mappings, mounts and effective cgroup limits. Missing, duplicate or foreign READY fails. The builder is a direct child of PID 1, never PID 1 itself. Two capsules independently reproduce all 600 source files, 268 dependency files, four exact AST erasures and equal path-clean bundles. The same unchanged builder and Wrangler verification pipeline serve both isolation routes.

Each original builder has a 120-second bound; each direct Wrangler 4.156.0 `deploy --dry-run` has a 60-second bound, inside the 480-second container supervisor. Success requires each original close/exit/signal, completion marker and bundle hash, both roots' byte equality, path privacy and no remaining private descendants. The CLI hash is frozen. The parent's attach and wait operations are joined independently; `docker wait` returning process exit zero cannot replace the numeric container exit it reports. Final inspection must show exit zero without OOM, timeout or interruption, followed by independently observed owned cgroup emptiness or removal.

On failure, only the full inspected container ID from this invocation can be stopped and, if necessary, killed. Killing a Docker CLI is never retirement evidence. Ambiguous create/start, denied proc access, PID reuse or unknown cgroup state remains failed. Primary and cleanup failures, including `undefined`, are retained independently. Only the known stopped container and nonce-bound derived image are removable after verified retirement; the shared base and global Docker cache are never pruned. This code contains that future CI cleanup route; no local Docker execution or cleanup has been performed.

Local helper tests qualify the predicates, protocol and original-process bookkeeping only. Passing packaging later would qualify an **instrumented frozen-candidate edge composition**, not an unchanged binary, actual SDK behavior, cloud resource custody, deployment or cancellation. No packaging artifact is uploaded. Cloud and SDK execution remain separate **UNRUN** boundaries.

Runtime authority comes from fresh cryptographic randomness: one admin token and eight distinct sets of proxy, upstream-data and control tokens. Never publish the authority file, tokens, request headers, bodies or child output. Install only the relevant secret projection in each Worker. The SDK receives its explicit proxy credential; production grant selection supplies the distinct upstream credential. `LITELLM_BASE_URL` points at the owned synthetic public upstream and `LITELLM_MODEL` is `tenant/edge-proof`. No vendor environment credential, alternate origin, URL rewrite, SDK adapter or live billing is involved.

The SDK cases are sequential. Independently, the server's one-time per-case catalog/inference claims bound admitted source calls to sixteen, even if authorized clients overlap. Control actions are also single-use. Upstream requests are limited to 8 KiB, control reports to 32 KiB and observation records to 256 per request. A held producer expires after ten seconds and expiry always fails proof. Authority expires within ten minutes. Proof data is retained for the separately authorized teardown; expiration does not certify physical cleanup or delete cloud resources.

## Fidelity and acceptance

The TypeScript parser locates calls in four exact blob-anchored source files. Counts are fixed. Removing the inserted observation syntax must reconstruct every original byte. The original receivers, operands, return values, promises and synchronous exceptions are retained. Original `reader.closed`, reads, cancels, source tails, retirement promises, release-lock returns and delegated `waitUntil` work are joined dynamically. No observer performs an extra read, cancel, signal bridge or request substitution. Observer failure, capacity overflow, missing correlation and unknown protocol invalidate proof.

Added promise reactions affect scheduling. Byte-exact erasure proves the transformation boundary; it does not prove an unchanged binary or identical timing. The observer's default remains strict: rejected or unknown original cleanup never becomes a passing cancellation disposition. Any future disposition change needs evidence from the actual controls and its own review.

The actual registered LiteLLM catalog and public `stream` / `streamSimple` paths each receive fresh EOF, pre-abort, partial caller-abort and provider-error cases: eight authored executions, all unrun until genuine ephemeral CI. The existing `runOpenClawConsumer` helper, exclusive fixture copy, native SDK runner and 240-second child bound are unchanged. Local compilation and pure observer tests are not SDK execution.

The server build uses Node 24.22.1 and the server's frozen pnpm 11.28.4 inputs. The separate ephemeral SDK checkout must use its own frozen pnpm 12.15.0 package-manager integrity and workspace inputs. Server dependency qualification does not qualify that SDK install or its loader.

H1 is eligible. Record the protocol from the actual edge ingress; do not replace the SDK dispatcher to obtain H2. Caller abort, the original Worker input signal, the original upstream cancellation and non-expiring source settlement, request-lease release, original reader joins and SQLite accounting are independent requirements. Unknown state fails. Fixture expiry, teardown, response status or a client rejection alone supplies no retirement credit.

Metadata has zero request cost. Inference reserves the explicit seven-micro policy charge, retains null token usage where unknown and does not claim a zero vendor tariff. A dispatched provider error does not imply free work. The consumer independently reads the original usage and budget owners.

## Later execution and teardown

The hosted outer requires a fresh reviewed plan, a private authority file, the exact ephemeral SDK checkout and explicit `CLAWROUTER_EDGE_PROOF_EXECUTE=1`. It must never be run locally by setting `CI`. The SDK's registry, transport guard and request leases must all be observed; missing guard attachment fails the first genuine controls. No result may be credited until the helper and all independent Worker, upstream and accounting checks pass.

Remote receipt publication and usage-queue completion must be qualified on the real deployment. A missing receipt is unknown, not an invitation to repeat a paid request. There is no teardown-on-failure credit and no automatic resource deletion. A later destructive lease must first establish exact owned IDs, joined originals, synthetic credential revocation, both queues drained and no foreign references. `teardownGuard` validates the complete requested evidence; it performs no deletion. Retain resources and report the failed prerequisite when any condition is unknown.
