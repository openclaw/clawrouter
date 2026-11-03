# Synthetic native Messages and discovery

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/synthetic/provider-catalog.ts`, `onboard.ts` and `models.ts`.
The native inference default is Anthropic Messages, not the existing Chat seed.
Primary qualification: 2026-11-03.

## Endpoint and credential contract

The [API overview](https://dev.synthetic.new/docs/api/overview) separates OpenAI
and Anthropic paths on the same service. The [Claude Code configuration](https://dev.synthetic.new/docs/guides/claude-code)
uses the selected Synthetic key as a bearer token. No Anthropic account key,
foreign provider grant or subscription interchange is implied.

| Router public path | Exact upstream path on `https://api.synthetic.new` |
| --- | --- |
| `/chat/completions` | `/openai/v1/chat/completions` |
| `/v1/messages` | `/anthropic/v1/messages` |
| `/models` | `/openai/v1/models` |

The manifest consumes endpoint `upstreamPath`; source3 owns its schema/compiler
publication. `CompiledEndpoint.upstreamPath?: string`, same-origin assembly and
selected-grant behavior remain source1-owned. Public route paths remain the caller route and authorization identity. The first
slice accepts only literal canonical paths, rejects a conflicting grant-transport
path, and keeps the original origin/key fixed. No path parameters, templates,
encoded traversal, query, fragment, absolute URL,
credential-bearing redirect or alternate-service fallback can substitute for
that shared implementation. The source4 Synthetic manifest and 29 real Worker
fixtures consume this contract in a separate source slice, not PR397. They must
not activate before both common owners' implementation and proof are available.

The [Messages reference](https://dev.synthetic.new/docs/anthropic/messages)
qualifies user/assistant messages, text/image parts, `tool_use`/`tool_result`,
thinking/redacted-thinking blocks, tools/tool choice and SSE. Preserve native
replay and response usage; do not translate them through Chat Completions.
The guide recommends provider-managed `syn:` aliases for native Messages,
although an older request-table note mentions only `hf:` identities. Alias
resolution belongs to Synthetic; the router must not substitute a concrete
model or silently activate a newer frozen-external model.

## Model inventory and native envelope

Both the [current model page](https://dev.synthetic.new/docs/api/models) and a
credential-free GET to `https://api.synthetic.new/openai/v1/models` qualify these
two frozen concrete identities. The existing `syn:large:text` alias remains
available, with vendor-controlled resolution. The API response is `{data:[...]}`:
neither its envelope nor model rows contain OpenAI `object` tags. Public metadata
availability does not prove a selected account's entitlement.

| Frozen identity | Current disposition |
| --- | --- |
| `hf:openai/gpt-oss-120b` | Advertised and present; text, 131,072 context, 65,536 output limit. |
| `hf:zai-org/GLM-4.7-Flash` | Advertised and present; text, 196,608 context, 65,536 output limit. |
| `hf:MiniMaxAI/MiniMax-M3` | Absent from current public inventory; not bundled as an active offer. No retirement date or alias invented. |
| `hf:moonshotai/Kimi-K2.7-Code` | Absent from current public inventory; no implicit K3 substitution. |
| `hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | Absent from current public inventory; no inference from NVIDIA's separate hosted service. |
| `hf:Qwen/Qwen3.6-27B` | Absent from current public inventory; no implicit Qwen 3.8 substitution. |
| `hf:zai-org/GLM-5.2` | Absent from current public inventory; no implicit GLM 5.3 substitution. |

The [native list API](https://dev.synthetic.new/docs/openai/models) and frozen
projection use rich row metadata. `worker/synthetic-model-catalog.ts` exports
`filterSyntheticModels(payload, allows): { data: SyntheticModelRow[] }` for the
proposed explicit `synthetic.models` format. It does not relax `openai.models`.

The codec checks the data array, 4,096-row limit and bounded identities; invalid
envelopes/IDs and duplicate visible identities fail. It excludes deprecated,
inactive, non-text and invalid-context rows, calls the supplied original-policy
predicate, and returns deterministic projected rows. Unknown properties are
dropped. Known input/output modalities, features, reasoning efforts and limits
remain native observations. Missing optional fields stay absent; output limits
cannot exceed context. It never revives absent rows from the frozen seed list.

Native price strings are retained only in bounded decimal form, including an
explicit dollar prefix if present. There is no numeric conversion, zero default,
cache-price fallback or tariff activation. Source2 must preserve unknown prices
when consuming this metadata instead of restoring the frozen client's zero-cost
fallback. Source3 retains common fact and qualified tariff projection.

## Remaining integration

Source1 must add the explicit discovery format to metadata classification and
dispatch this codec using `id => discoveryAllows(originalPolicy, provider, id)`.
Preserve existing response byte/deadline/cancellation, original-grant revocation,
zero inference charge for discovery and unsupported-query guards. The codec
does not perform HTTP or choose credentials. Keep the OpenAI envelope strict.

The provider declaration retains the Chat alias and adds the two currently
qualified frozen concrete identities to Chat and Messages. Its model facts use
current native observations, not copied frozen prices or output limits. The 29
Worker fixtures cover both route forms, every declared identity, thinking/tool
replay, fragmented SSE, original credentials, cancellation, usage and dispatch
path isolation. Discovery uses its actual native envelope and policy filtering.

Common path/discovery implementation, execution of the dependent native Worker
tests, actual source2 client and source6 serialized snapshot/consumer proof remain
activation gates. Codec fixtures alone do not complete native Messages or
provider parity. No inference, login, provisioning, deployment or snapshot
regeneration occurs in this source slice.
