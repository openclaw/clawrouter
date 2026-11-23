# Deployment compatibility

Production deployment has one entrypoint: **Deploy ClawRouter** in GitHub Actions
(`deploy-cloudflare.yml`). Select `main`, then **Run workflow**. There are no
release inputs, preparation scripts, qualification PRs or mid-run approvals. The
weekday schedule uses the same action. `pnpm cf:deploy` dispatches that action
through your GitHub login; it never invokes Wrangler locally.

The action freezes the event's main SHA, displays it, and waits at most 15 minutes
for that exact source's main push CI. It never substitutes an older green commit.
Main advancing during a release does not change the selected source. A failed or
unfinished CI run stops before exposure. CI is a deployment requirement, not a
merge-enforcement rule; main may advance while its CI is failed or incomplete.
If the source and native artifact already run, the action is a no-op. A completed control bridge with the desired payload
still pending is detected automatically on the next run, even at the same SHA.

## Automatic release paths

| Change | Behavior |
| --- | --- |
| Same native artifact and determining control | Existing 0/10/50/100 rollout, repeated smoke, two- and three-minute holds, analytics when available; compatible blue recovery |
| Native payload | Build/freeze exact candidate and compatible current-control/old-payload recovery; isolate qualification; close admission, drain, replace, attest eight slots, reopen, smoke |
| Native control/state/callback code, same payload | Same isolated upgrade/recovery qualification and ordered replacement; no payload-mode selection |
| Legacy control lacking artifact adoption protocol | Automatically qualify/adopt current control with old payload first; then qualify/replace payload in the same action |
| Versioned tenant/start limits | Validate supported bounds, qualify and replace in order; preserve all owners and credentials |
| Unsupported lifecycle/configuration/destructive transition | Fail compatibility CI; feature PR must implement an automatic compatible transition, never an operator procedure |

No data-plane algorithm or foreground backend call is added by this coordinator.
Existing product/performance evidence remains applicable to unchanged product and
runtime bytes. A controller change does not by itself require another broad
performance campaign.

## What the isolated check proves

The action creates unique KV, queues, R2, Worker and container resources in the
existing account/current plan. Every persistent owner and origin is isolated from
production. It generates short-lived isolated credentials in memory, uses the
bounded synthetic-only provider fixture, and removes the credentials, saved Codex
home and resources afterward. No real provider key enters qualification.

Blue is built from the **deployed control source**, with its exact reproduced
native payload. Green uses candidate control/payload. Recovery uses candidate
compatible control with the exact old native payload. The source, determining
controller digest, artifact manifests, runtime pair and production starting version
bind the automatic evidence. There is no source-controlled qualification registry.

Each isolated check plans nine synthetic requests, at most eight provider
attempts, 40 native starts and 64 fixture requests. Those are ceilings, not retries.
It seeds a real saved Codex conversation, starts a held turn, deploys while it is
active, resumes the same saved thread and demands a distinct context-dependent
answer. The interrupted turn may succeed, fail or notify retries; its observed
outcome, retry count and recovery time are recorded. It is never blindly resent.

Candidate success, rejection, exact 64 MiB, 64 MiB+1 overflow and delivery-unknown
probes exercise envelope limits and deterministic accounting independently of the
continuity verdict. A deliberate isolated smoke failure exercises compatible
recovery, followed by another context-dependent turn in the same saved session.
Unexpected results cannot authorize production. Partial case evidence survives.
Each qualification subprocess is bounded to 40 minutes; the workflow's existing
phase deadlines and independent recovery bound production work. No soak test.

Deployment, continuity, payload, accounting, recovery and cleanup have separate
outcomes. Cleanup is required before qualification authorizes production. An
additional fresh-runner cleanup job covers cancellation/runner loss. It consumes
the same attempt's automatically uploaded last mutation intents so stale KV reads
cannot erase queue custody or replay a pending delete. If that handoff is missing,
cleanup retains owned queue resources for investigation instead of guessing. A later
cleanup failure cannot rewrite an already completed production deployment as an
undeployed release: inspect the deployment result; do not deploy again to clean up.

## Developer responsibility

Read this file when changing payload/controller protocols, persistent schemas,
pending callbacks/messages, credentials, continuation ownership, accounting or
Cloudflare deployment configuration. Root `AGENTS.md` points fresh coding-agent
sessions here; the PR template and compatibility CI reinforce the requirement.

In the feature PR:

1. Preserve persistent identities and access to existing credentials. Define how
   current code reads previously stored values and handles in-flight old-format
   callbacks/messages, continuation ownership, reservations and settlement.
2. Prefer additive, backward-compatible reads/writes and lazy migrations. Include
   compatible recovery; reverting a Worker version does not undo stored data.
3. Add focused behavior proof starting with old stored state and outstanding work.
   Verify one execution/accounting outcome, correct ownership and a distinct saved
   session follow-up. Tests/fixtures must reflect the actual transition, not a
   newly initialized candidate on both sides.
4. For a change outside the supported paths, implement its automatic transition
   and recovery in the coordinator in the same PR, with local actual-entrypoint
   proof and isolated rehearsal. CI intentionally rejects unimplemented lifecycle,
   actor, owner or non-versioned settings changes. Editing an approval list or
   writing a manual release runbook does not supply a transition.

`check-deployment-compatibility.mjs` runs against CI's immutable base and head.
Normal Worker upgrade tests cover old formats and ownership; coordinator tests
cover delayed reads, lost acknowledgments, foreign ownership and fresh-runner
recovery. The canonical action supplies exact-release Cloudflare evidence before
activation. A failed setup/tooling case is not evidence of a product regression.

## Standing setup and emergency operations

Existing production Cloudflare/admin/Access/smoke credentials remain GitHub secrets.
The Cloudflare deployment credential additionally needs create/read/delete access
to qualification Workers, DO/container applications, KV, queues and R2 in the same
account. The action reads the account workers.dev subdomain. Account, domain,
Access administration and genuinely new provider credentials are standing setup;
those are not per-release deployment steps. No plan upgrade is required.

Manual and scheduled runs automatically check compatibility, perform any required
isolated qualification, roll out and recover within the same action. No manual
release authorization, external qualification artifact, preparatory operator
procedure or routine configuration toggle is required.

All production releases and recovery share one non-cancelling workflow concurrency
group. Single-shot writes are journaled before exposure, reconciled through bounded
reads, and fenced by deployment ownership/expected versions. Lost acknowledgments
never trigger blind POST/PUT or inference replay. A fresh job recovers from the
remote journal without candidate installation or private runner files. An unknown
or foreign owner stops writes and preserves custody.

The action is the supported entrypoint, not a new Cloudflare IAM boundary: an
account administrator with a broad API token can still make out-of-band changes.
Local development, tests and PR publication do not authorize any hosted change or
production activation.
