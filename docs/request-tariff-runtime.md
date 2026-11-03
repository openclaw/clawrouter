# Request tariff runtime

The Worker consumes the closed variants in [the source contract](request-tariff-contract.md).
No bundled tariff manifest is activated by this change. The common endpoint and
client catalog types preserve the source, version, date and receipt qualification.
A catalog offer remains request-dependent; a zero-token card cannot erase a
possible request charge.

For the xAI outcome variant, admission freezes the selected native model and
version alongside the original caller, provider, credential and accounting event.
It uses `estimateModelCost` with the qualified outcome card. This preserves the
full model output reserve and adds the possible outcome charge exactly once.
Only this path can discharge `request_fee`; independent tool, tier, media and
ancestry bounds still apply. A post-request receipt never supplies a pre-egress
bound. Background operations and WebSockets are outside this variant.

The selected dispatch URL must be the qualified global native endpoint. Redirects
and automatic grant retries are forbidden for a declared request tariff. The
existing ledger dispatch acknowledgment precedes fetch; the existing settlement
and usage recovery outbox owns completion. No second job store or replay path is
introduced. Pre-dispatch failures release the hold. After dispatch, an HTTP error,
empty response, missing receipt or interrupted delivery retains the original
conservative reserve with `manifest_request_reservation`, independently of the
ordinary nonbillable HTTP shortcut.

The existing Responses stream tokenizer projects only bounded identity, model,
status and charge scalars. It preserves output bytes, backpressure and cancellation.
Unary JSON must complete; SSE needs one delimited native terminal Response and
complete transport. Running receipts, conflicting identities, duplicate terminals,
malformed tails and unsafe numbers cannot discount a reservation. `incomplete` is
a native terminal status and can carry a valid receipt; incomplete delivery cannot.
Exact native model equality is required. Any response-model alias needs separate
source qualification before it can provide a measured charge.

`requestOutcomeCost` converts the authoritative whole-request total to integer
USD micros. It is labeled `provider_reported`, including explicit zero, and is
never summed with token charges or another outcome fee. Totals above the admission
reserve remain visible. Neither HTTP status, refusal content nor an exact $0.05
amount is classified as a violation. Explicit policy prices retain `policy_fixed`.
All fixtures are synthetic; no live violation-triggering prompts are used.

The successful-request variant freezes one selected Perplexity Search price.
Absent `search_type` selects the declared default; malformed or unknown present
values fail before egress. Complete success/free-error observation is a separate
focused adapter contract. Until that observer is integrated, delivery retains the
selected reserve with an uncertainty basis; no Perplexity tariff is activated or
advertised as measured upstream cost.
