> Historical evidence, preserved unchanged below. Its registry checker must be
> run at the original recorded source revision, where that registry/policy existed.
> Current releases use automatic isolated evidence; see
> [deployment compatibility](../../deployment-compatibility.md).

# Native bootstrap/control adoption qualification

This evidence supports two purpose-specific registry entries at tested source
`0d237fb6e1bd23b27862761ada6588d818150f9b`: adopt repaired controllers while
preserving the old native payload, then replace that payload. It authorizes no
production operation. The two controller runs used isolated resources on the
current Cloudflare plan and a synthetic provider, with eight slots.

| Case | Evidence and disposition |
| --- | --- |
| Adopt repaired control over actual legacy controllers | [Control run](https://github.com/openclaw/clawrouter/actions/runs/44459687964): old native bytes retained; pool and all eight slot controllers attested before reopen; intentional interruption recovered on a distinct Actions runner. |
| Replace payload and recover | [Payload run](https://github.com/openclaw/clawrouter/actions/runs/44459962727): exact new native warmed; intentional smoke failure recovered the exact old payload using current controllers. |
| Saved Codex session | Both rows completed context-dependent turns after restarting the official Codex app server and resuming the same saved thread in each row. Ordinary admission-close-to-answer times were 19.8–23.4 seconds. Loss-induced quarantined recovery took 437.2 seconds; its follow-up turn took 2.0 seconds. No client/session intervention or inference replay was required. Interrupted-turn success and zero retry notices are observations, not universal pass requirements. |
| Independent payload cases on new native | Small success 200; definitive rejection 400/refund; 67,108,864-byte request 200; 67,108,865-byte request 413 with no provider execution. |
| Accounting | Exactly 14 provider executions and 14 events, 91 synthetic micro-units, zero replay, 40 native starts. The deliberate loss has delivery_unknown, one charge and one unclean finish. |
| Deliberate non-streaming loss | Reuse the previously accepted [revision-2 loss/SDK proof](../native-cutover-20261119/QUALIFICATION-ACCEPTANCE.md). Nine relevant delivery/fixture modules are byte-identical to its tested source; see SOURCE-EQUIVALENCE.json. The full native binary changed with the control repair. This campaign's old transport-specific assertion failed after HTTP 200/clean EOF and did not capture the body; that failure is retained, and this proposal does not claim a fresh exact-body capture. |
| Non-HTTP configuration and cleanup | An external coordinator's cached OAuth token received 401 during final reads/cleanup. A fresh process recaptured the same authorized Wrangler OAuth route, verified exact ownership and terminal workflows, confirmed unchanged schedules/queue owner, closed the fixture once, proved zero native/Container instances, and removed private client credentials/conversations within the original deadline. No campaign/deployment/inference write was replayed. Definition deletion remains user-operated. Production identity was unchanged. |

The raw payload-row and campaign verdicts remain false. This is an aggregate
qualification disposition using independent case receipts and reusable accepted
evidence, not a claim that the current campaign passed every original assertion.
The serving/response-loss modules and SDK evidence were not changed by the
bootstrap/control repair. No new wire-body behavior is inferred from this
campaign's discarded body; the previously accepted response-loss scope and client
limitations remain in force. This does not qualify every SDK, raw-response APIs,
SSE/WebSocket loss semantics, or retry behavior on timeouts/transport failures.

HOSTED-PROJECTION.json contains selected receipts, including the original failed
cases. PROVENANCE.json hashes the locally retained originals and portable files;
these are maintainer-reported projections, not signed execution attestations.
No credentials, raw prompts/completions, or private Codex state are included.

Run the actual local registry/ancestry guard with Node 24.22.1:

```sh
node docs/proof/native-bootstrap-adoption-20261119/check-registry.mjs /absolute/path/outside/checkout/registry-proof.json
```

This exercises positive and negative registry decisions without deployment or
network calls. Production activation remains separately held. Registry changes do
not alter inference routing, accounting, native code, or the existing source-hold
configuration. Performance evidence for the unchanged serving path is reused.
