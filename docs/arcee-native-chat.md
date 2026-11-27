# Arcee direct Chat contract

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/arcee/models.ts` and `provider-catalog.ts`. Primary checked 2026-11-03.
This slice preserves the existing Mini route and adds exactly the two missing
direct cards. It does not broaden to current third-party models or Trinity Nano.

| Router ID | Direct upstream ID | Declared input | Reasoning disposition |
| --- | --- | --- | --- |
| `arcee/trinity-mini` | `trinity-mini` | text | Frozen non-reasoning; no effort/default claim |
| `arcee/trinity-large-preview` | `trinity-large-preview` | text | Frozen non-reasoning; no effort/default claim |
| `arcee/trinity-large-thinking` | `trinity-large-thinking` | text | Native reasoning replay; no effort/default claim |

The current [Trinity page](https://www.arcee.ai/trinity) documents tool use across
the family and explicitly describes Thinking's agentic behavior. The
[function-calling guide](https://docs.arcee.ai/capabilities/function-calling)
documents `tools`, `tool_calls`, linked tool results and `tool_choice: auto` on
the direct API. This primary evidence qualifies tool support, including Thinking,
rather than copying its frozen `supportsTools: false` client compatibility flag.
It does not establish support for arbitrary effort controls or vision.

The direct [first-call](https://docs.arcee.ai/api-reference/your-first-api-call)
and [streaming](https://docs.arcee.ai/capabilities/streaming-messages) guides use
`https://api.arcee.ai/api/v1/chat/completions`. The current
[Chat reference](https://docs.arcee.ai/api-reference/chat-completion) instead
shows `/v1/chat/completions`. The existing documented frozen route is preserved;
the router does not silently switch spellings or follow an alternate product.
Only the original selected direct Arcee Bearer grant or explicitly configured
`ARCEEAI_API_KEY` belongs to this service. OpenRouter credentials and model IDs
are separate. An anonymous catalog 403 is neither entitlement nor retirement proof.

## Replay, streaming and accounting

The [reasoning guide](https://docs.arcee.ai/capabilities/reasoning-traces) names
`reasoning_content` on direct responses and accepts `reasoning_content` or
`reasoning` in assistant input. Tool replay retains the complete assistant/tool
exchange and uses empty-string assistant content when there is no text. The
router preserves the caller's native body; it does not synthesize reasoning,
repair client history or translate it into OpenRouter `reasoning_details`.
Self-hosted vLLM behavior is a separate runtime contract.

JSON and fragmented OpenAI SSE responses preserve native messages, tool deltas,
observed usage and `[DONE]`. Synthetic observed usage is a transport fixture,
not a promise that every vendor stream supplies terminal usage. Missing usage
stays unknown. Client disconnect cancels the local upstream body and retains
conservative settlement; it does not prove provider-side generation cancellation.
HTTP rejection preserves status and never retries another product, model or key.
The documented detail envelope and OpenAI stream-error envelope are exercised.

All three cards remain unpriced. The current
[pricing page](https://docs.arcee.ai/get-started/pricing) does not list these IDs;
absence alone does not prove retirement. No frozen rates, zero-cost cache fields
or inferred entitlement are copied. A fixture's explicit seven-micro policy cost
is `policy_fixed`, not a vendor tariff. Frozen numeric limits and rounded hosted
context claims also stay out of the manifest: the Trinity page distinguishes
open-weight context from the served Preview/Thinking API context. The native
catalog codec separately preserves observed limits without declaring them enforced.

## Proof and remaining ownership

`worker/test/arcee-native-chat.test.mjs` compiles this source manifest and replaces
only its existing bundled row inside isolated actual Worker fixtures. Thirty-two
cases cover the three IDs across native/manifest JSON/SSE routes, eligible catalog
offers, original credential isolation, grants/revocation, unknown prices, tool and
reasoning replay, observed/missing usage, errors and disconnect settlement.
The generated provider snapshot is deliberately not edited by this source slice.
Source6 must integrate it in a later explicitly assigned serialized slot and run
actual client/Worker acceptance before the new cards are shipped.

The landed `arcee.models` leaf codec has a separate contract in
[arcee-native-catalog.md](arcee-native-catalog.md). Source1 runtime dispatch and
source3 format validation remain prerequisites to any discovery endpoint here.
This Chat declaration does not activate discovery or weaken strict OpenAI decoding.

Source2 owns the actual direct client, Thinking replay and removal of any stale
client compatibility suppression. Source3 owns the existing OpenRouter manifest:
its finite preset contains only `arcee-ai/trinity-large-preview` and
`arcee-ai/trinity-large-thinking`, not Mini. Those IDs must retain OpenRouter's
own original credential, endpoint, serving facts and tariff; no router alias or
direct-key fallback is authorized. Live account proof remains separate. No host,
account, consent, credential provisioning or deployment is performed.
