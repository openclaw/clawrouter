# Isolated edge cancellation proof

This is an offline preparation route for an **instrumented frozen-candidate edge composition**. It does not deploy resources, enable a service, qualify a production release, or prove another provider's cancellation behavior. Cloud deployment, the actual SDK controls, protocol observations and remote retirement remain unrun until separately authorized.

The server source is frozen at `5cfafe8c8df43102365ec900431b8b3be1dd4eb0`, tree `6da1d6ea30f74d18730365c875b2978c61f34ce2`. The builder reads tracked Git objects into a private capsule. It does not merge the candidate's unpublished provider changes into this branch. The four dependency inputs must match the build checkout. The SDK consumer is frozen at `d8bb939408aa4d2be7df0161748edb52ebf3b1fb`.

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

The `edge-offline-packaging` job uses a fresh standard Ubuntu 24.04 VM, Node 24.22.1 and pnpm 11.28.4. Checkout and the frozen dependency install are **online setup**, not offline bootstrap. Checkout does not persist credentials. The job has only `contents: read`, no environment or injected cloud/provider secrets, no OIDC, cache, upload, deployment or SDK execution. The pinned server commit and tree must be publicly fetchable through the ordinary repository source route. An unavailable commit fails admission; there is no carrier ref, alternative source or uploaded capsule fallback. Publication of this harness is held until that source publication is qualified.

After setup, `node scripts/edge-proof.mjs offline-ci` creates private user, network, PID and mount namespaces with the installed `unshare`. The child must observe distinct namespace identities, PID 1, only loopback, no external IPv4/IPv6 routes and a private proc mount. Unsupported unprivileged namespaces, ambiguous evidence and shared mounts fail. There is no sudo, sysctl, host-network or privilege fallback. The mount projection is private; it does not change host mounts.

The packaging environment is rebuilt with an explicit PATH and fresh HOME, XDG and temporary directories; metrics and tracking are disabled. GitHub tokens, cloud credentials, proxies and parent environment overrides are not inherited. This is **not filesystem confinement**: files readable by the same runner UID remain readable. The fresh job must never receive Foundation, Cloudflare or provider credentials.

The private namespace init supervises original build and CLI processes. Each command has a separate owned process group, original close result, bounded private output and a monitor restricted to the private proc view. TERM/INT are forwarded; a timeout escalates only the owned group. The enclosing `unshare` process is also supervised. Killing its direct namespace-init child destroys the private PID namespace, including descendants that create new groups; `--kill-child` alone is not the descendant proof. Success requires no remaining private descendants and original successful closes. Runtime namespace admission and this Linux lifecycle remain unqualified until the genuine job executes.

Two capsules must independently reproduce all 600 source files, 268 dependency files, four exact AST erasures and equal path-clean bundle hashes. The same installed Wrangler 4.156.0 direct CLI then runs `deploy --dry-run` once for each dedicated config, with a 60-second bound per CLI. A zero exit alone is insufficient: the original signal/close outcome, completion marker and exact output bundle hash must all agree. Offline configs contain explicitly synthetic resource placeholders, which are never cloud custody or resource availability evidence. Nothing is uploaded. Ephemeral job files contain build receipts only; no runtime credentials are created.

The earlier macOS packaging attempt failed at `process.cwd` with `EPERM`; that route is closed. Linux capability, actual packaging, cloud resources and SDK execution are still unrun. Local process and refusal tests qualify the runner logic only. The ordinary repository CI and consumer selector remain unchanged outside the added job; their results are separate from offline packaging.

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
