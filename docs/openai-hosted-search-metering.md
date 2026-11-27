# OpenAI hosted search: observed SOFT-budget component

This is call metering, not hard-budget qualification or native tool enablement.
The Responses endpoint's versioned `toolPricing` card is compiled from the
provider manifest into the Worker snapshot. API pricing checked October 20, 2026:

- Non-preview web search: 10,000 USD micros per call ($10 / 1,000).
- Preview search: 10,000 micros for explicitly listed reasoning models;
  25,000 for the explicitly listed non-reasoning model, GPT-4.1 mini.
- Unknown preview model classes, conflicting declared tariffs, and opaque
  retained/dynamically loaded inventories have no rate. Current declarations
  cannot override that uncertainty. Never infer a billing class from a model-name
  regex or current reasoning effort.

Sources: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing#tools)
and [web-search protocol](https://developers.openai.com/api/docs/guides/tools-web-search).
[Tool-search persistence](https://developers.openai.com/api/docs/guides/tools-tool-search)
requires keeping inherited search tariffs unknown without a compatible inventory.
The protocol describes search actions as incurring a tool-call cost, but does not
establish that every query in a multi-query action is separately billed, or that
failed/incomplete actions always incur exactly one fee. No paid sample or account
usage query was used to claim a universal invoice match or upper bound.

## Observation and settlement

The existing bounded JSON/SSE metadata parser supplies its tool-evidence
projection to a small count collector. It selects only action.type in addition to
existing item identity/status fields. Queries, URLs, search results, message
content and raw provider output are not retained for accounting. Streaming uses
the existing reader, demand, cancellation and UTF-8/JSON/SSE boundaries, not a
parallel parser, output buffer or eager tee.

- Count final `web_search_call` items. Exclude known `open_page` and
  `find_in_page` actions. Missing/new action discriminants conservatively count
  as search candidates; this is an assumption, not a new exact billing rule.
- One observed search item contributes one nominal call fee, including a failed
  search item in an otherwise terminal response. A multi-query item still counts
  once: its universal per-query and failure billing remain unqualified.
- Added/done/repeated-done/terminal representations of the same item cannot add
  multiple fees. The bounded terminal output snapshot supplies the enumeration;
  conflicting identities, duplicate terminal IDs or unavailable projection make
  it incomplete. Done-only anonymous items defer to that terminal enumeration;
  they never acquire guessed stream positions or duplicate partial charges.
  Uncorroborated anonymous search cannot assert a complete zero count. Both
  ID and index associations must independently agree with the final item;
  compatible separately observed aliases reconcile without duplicate fees.
  Status/content-event selectors must also belong to that same enumeration,
  before or after the terminal. One selector cannot hide another contradictory
  item. Qualification remains open until delivery EOF: bounded
  terminal identities/counts reject later conflicting item, terminal or error
  facts without retaining content. Exact identifiable repeats remain idempotent;
  unresolvable late anonymous items cannot qualify a fee. Partial counts are
  observed evidence, never an exact zero bill.
- Only a complete delivered enumeration plus authoritative terminal token usage
  can add the nominal component to an already-admitted SOFT budget with actual
  budget legs. Missing usage, interruption, cancellation, failed response,
  oversized selected metadata or missing terminal do not mint a call fee.
- Existing measured token cost and the nominal call component settle together
  through the same `/charge` owner/chargeId. Usage publication is reporting,
  never another billing sink. Replay retains existing SQL idempotency.

Additive `clawrouter.usage.v1` fields:

| Field | Meaning |
| --- | --- |
| `hosted_tool_calls.web_search` | Observed search-candidate item count, not a query count. |
| `hosted_tool_calls_complete` | Complete selected enumeration, **not** complete price qualification. |
| `hosted_tool_cost_micros` | Nominal published call-rate component included in actual cost, or null when not applied/unknown. |
| `hosted_tool_pricing_ref` | Frozen card version, or null if no current declaration qualifies a tariff. |

Absent count fields mean no selected search-call observation, not proof that
unobserved hosted work was free. A zero count can also represent a fully observed
open/find action. Incomplete counts must not be interpreted as total usage.

Search content tokens remain unknown; no fixed 8,000-token block is blindly
added to input usage. The existing reported input may already contain content
charges and the protocol does not expose all billing partitions. The overall
`cost_basis` stays `unpriced_usage`, even with complete counts and a known rate.
Do not market `actual_cost_micros` as a complete upstream invoice or upper bound.

## Unchanged safety boundaries

- Reserve-mode enforced budgets still return `pricing_required` before upstream
  dispatch for these hosted tools. A call tariff alone cannot qualify reserve.
- Unmetered/default-reserve callers retain zero/unpriced hosted cost.
- Explicit SOFT mode without any caps retains its existing measured-token
  reporting, with no additional tool fee and no budget write.
- Fixed request tariffs remain fixed, even when counts are recorded.
- Provider selection, native primary/fallback, Fast/high preferences, credential
  binding and continuation ownership are unchanged. API rates are not evidence
  of a subscription account's invoice; auth provenance remains in usage fields.
- This HTTP lane does not qualify WebSocket/background tool metering, other
  hosted tools, opaque inherited tariffs, native enabling or hard reserves.

Tests exercise the actual handler plus isolated production SQL, and actual HTTP
through workerd with durable SQL/queue delivery. No live state, provider secrets,
private transcripts, deployment or paid search is required.
