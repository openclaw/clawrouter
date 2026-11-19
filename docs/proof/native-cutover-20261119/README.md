# Reviewed native cutover qualification

This record supports the single entry in `config/native-cutovers.json`. It is an
aggregate reviewed disposition, not a claim that every original attempt passed.
The production source hold remains **true**. Publishing this record does not
authorize production activation or credential changes.

## Frozen identities

| Identity | Value |
| --- | --- |
| Tested source | `25c972712d995070ffe0777a7888a749e433bdf4` |
| Determining controller SHA256 | `c68cd35e5c66bab05e7fc86f8242c46966df3de20d2ec194b6f1e5d9f497554c` |
| Blue native SHA256 | `6475f07303ec02b2a981825e95224b0e89e38d2d7ab0079279d839beb31e3671` |
| Green native SHA256 | `b62d0f6555b44447f15edb8ad87151cee222b5b2672a254e7b858213a4302472` |
| Blue native source | `2b89f2dd9ca6710558716f540dcf9049548e0f2c` |
| Targeted external harness commit | `2161429c0b7be401906bfe0dac7df1d8240af457` |

The registry gate checks the exact pair, a tested source ancestor, and unchanged
determining bytes at the tested and selected source. A different runtime pair or
controller requires its own evidence. Native payload identity alone does not
justify reusing changed serving behavior.

## Independent cases

| Case | Evidence | Disposition and scope |
| --- | --- | --- |
| Cutover | [Targeted Actions run](https://github.com/openclaw/clawrouter/actions/runs/44426289658) | Deployment and context-dependent saved-session follow-up passed; payload assertion reported separately below. |
| Smoke-failure recovery | [Original Actions run](https://github.com/openclaw/clawrouter/actions/runs/44413192211) | See `attempt-02-fail-smoke` in the projection for the authoritative run URL, original source/digest and both saved-session results. Reused across the controller admission-observation repair only. |
| Interruption after green, fresh runner | [Repaired-controller Actions run](https://github.com/openclaw/clawrouter/actions/runs/44423189515) | Distinct runners; no first-job state download; both context-dependent saved-session directions completed 23.523 / 24.691 s after admission close. Turns took 2.011 / 2.012 s. |
| Interruption during drain, fresh runner | [Targeted Actions run](https://github.com/openclaw/clawrouter/actions/runs/44425737088) | Distinct runner recovered without admitting green; same saved session completed a context-dependent turn 42.149 s after close (2.012 s turn). |
| Small success, rejection/refund, 64 MiB, 64 MiB + 1 overflow | [Original Actions run](https://github.com/openclaw/clawrouter/actions/runs/44411329244) and independent workload receipts in the projection | Passed independently under the original source/digest shown in the record. Exact native payloads unchanged; later repairs affected controller observation, not these serving paths. The original aggregate attempt failed its later loss assertion. |
| Deliberate non-streaming loss | [Targeted Actions run](https://github.com/openclaw/clawrouter/actions/runs/44426289658), [retained capture](LOSS-RESPONSE.json), [SDK receipt](SDK-CLIENT-PROOF.json) | Original response assertion **failed**: HTTP 200, clean EOF after six invalid JSON bytes. Accepted only under [the explicitly revised criterion](QUALIFICATION-ACCEPTANCE.md): actual SDK rejects without resend, plus independent exact accounting and quarantine. |
| Accounting, quarantine, non-HTTP state | [Case-level projections](HOSTED-PROJECTION.json) | 27 synthetic provider attempts / events, 182 synthetic micro-units across six attempts. No replay or real-provider inference. Targeted loss: one unclean finish, charged once, one draining slot/generation and seven unaffected members. Rejection refunds; overflow reaches no provider. |
| Runtime cleanup | Independent cleanup fields in each projected attempt | All native pools absent, zero Container instances, fixtures closed, private session material removed, production identity unchanged. Hosted resource definitions retained for user-operated deletion; deletion is not claimed. |

Actions URLs identify the controller runs. Independent local client/fixture and
cleanup receipts supply payload, accounting and saved-session observations; a
green Actions badge alone is not their proof. The earlier failed
`attempt-03-interrupt-green` remains failed and is superseded only for its repaired
controller observation by attempt 4. Original helper outputs still say
`qualified:false`; only maintainer-reviewed aggregate evidence admits the registry.

The accepted continuity requirement permits a temporary request/turn failure.
Success requires a subsequent context-dependent turn in the same saved official
Codex session, retaining prior context. Reconnection alone is insufficient. These
observed turns needed no inference replay or manual session repair. Zero retry
notifications in these observations is not a universal acceptance requirement.

## Portable evidence and local reproduction

[HOSTED-PROJECTION.json](HOSTED-PROJECTION.json) retains original source/digest,
case verdicts, content-free session/turn IDs and timing, workload response checks,
accounting, quarantine pools, runner identities and independent cleanup.
[PROVENANCE.json](PROVENANCE.json) records original hashes and exported hashes.
All 934 original sealed files verified unchanged at export. Projections omit
large repeated snapshots, complete controller state and private client material;
they are not signed attestations or standalone reproductions of hosted execution.
The SDK receipt is historical; its capture path names the original local layout.

From the repository root, with Node 24.22.1 and fresh absolute output paths:

```sh
node docs/proof/native-cutover-20261119/check-registry.mjs /outside/checkout/registry-proof.json
node --test test/deploy-native-cutover.test.mjs test/deploy-native-isolated.test.mjs test/large-http-release.test.mjs
npm ci --prefix docs/proof/native-cutover-20261119/client --ignore-scripts --no-audit --no-fund
node docs/proof/native-cutover-20261119/client/replay.mjs /outside/checkout/sdk-proof.json
```

The first command exercises the real gate, Git ancestry, negative tuples and
source hold. The replay uses the actual pinned official OpenAI Node SDK 7.60.0,
loopback HTTP and a fake credential. Retry defaults remain two; the safety timeout
is five seconds. It requires rejection with `SyntaxError` after one POST, followed
by one distinct valid control. Its fetch guard refuses non-loopback destinations
and redirects. No Cloudflare or real-provider request is made.

Limits: only parsed non-streaming `responses.create` in that SDK/version is
certified for the revised loss case. Original headers other than status/type
were not retained. This is not proof for every client, raw-response bypass,
SSE/WebSocket loss, or timeout retries. The positive control is not saved-session
proof; hosted official-Codex evidence supplies that independently. This registry
change alters no runtime/controller bytes and does not reopen prior performance
qualification. The ordinary eight-slot production controller, current plan,
ownership/secret lineage guards and source hold remain in force.
