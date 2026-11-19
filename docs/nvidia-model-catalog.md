# NVIDIA hosted model catalog

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/nvidia/openclaw.plugin.json` and `provider-catalog.ts`.
Primary qualification: 2026-11-03. This scope is the hosted NIM Chat service,
not containers, partner deployments or Enterprise entitlement.

## Finite model disposition

| Exact upstream identity | Disposition and primary evidence |
| --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b` | Hosted Chat available; [build example](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/build) and [API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer). |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Hosted Chat available; [build example](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/build) and [model card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard). |
| `nvidia/nemotron-3.5-super-vl-120b-a12b` | Hosted multimodal Chat; [native API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer) preserves content parts, tools and reasoning. |
| `moonshotai/kimi-k2.6` | Hosted Chat; [native API](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6-infer) qualifies tools, reasoning replay and user image parts. |
| `meta/llama-3.1-8b-instruct` | Prior router seed, outside the frozen four. The current [hosted playground](https://build.nvidia.com/meta/llama-3_1-8b-instruct/playground) explicitly marks its endpoint deprecated. Excluded from hosted offers; partner/download availability is separate. No exact shutdown date is asserted. |

A credential-free read of the [public inventory](https://integrate.api.nvidia.com/v1/models)
listed all four frozen identities and omitted the prior Llama seed. The explicit
deprecation notice, rather than omission alone, supports removing that seed.
The closed manifest prevents its continued use through arbitrary passthrough.
Other hosted families' passthrough behavior is unchanged. Unified model IDs add
the router provider prefix; `nvidia/nvidia/nemotron-3-ultra-550b-a55b` therefore
maps to the unchanged upstream `nvidia/nemotron-3-ultra-550b-a55b`.

## Public refresh contract

`worker/nvidia-model-catalog.ts` exports:

- `nvidiaPublicCatalogRequests(inferenceBaseUrl, signal)` returns fixed inventory
  and featured GET requests. Only the canonical `https://integrate.api.nvidia.com/v1`
  service is eligible. Both requests omit credentials and reject redirects;
  the second origin is fixed to NVIDIA's assets service.
- `parseNvidiaPublicCatalog(inventory, featured, permittedModelIds)` intersects
  fresh native inventory, qualified featured/frozen Chat metadata and exact
  caller-permitted upstream IDs. Featured ordering is retained, followed by
  remaining frozen models. No wildcard authorization or inference-key probe.
- `readNvidiaPublicCatalog(inventoryResponse, featuredResponse, signal, permittedModelIds)`
  uses the existing bounded JSON reader for both responses: complete HTTP 200
  JSON, fatal UTF-8, length/range/redirect checks, 2 MiB each, cancellation,
  4,096 inventory rows and 32 featured rows. Malformed or duplicate inventory
  identities fail; malformed featured rows are skipped, but a nonempty catalog
  without usable rows fails. Oversize row sets fail instead of truncating.

An empty inventory is authoritative even if featured metadata fails. For a
nonempty inventory, both sources must qualify. A stale featured recommendation
cannot revive an absent identity. Unclassified inventory rows may be embeddings
or another API and do not become Chat offers. An explicitly permitted new featured
identity can carry metadata, but has unknown input/reasoning facts and prices;
this does not expand the four-model manifest or authorize automatic activation.

The [featured catalog](https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json)
supplies `model`, `model-name`, `context` and `max-output`. Name and limits override
the corresponding frozen observations. Output token budgets are recommendations,
not universal service maxima: Ultra's current API allows 32,768 and Super's
131,072, while their featured defaults are 8,192. The source tag preserves that
distinction. All pricing stays null; the frozen zero costs are not vendor rates.
Frozen input/reasoning observations remain explicit, without claiming entitlement.

## Integration and proof boundaries

Source1 must execute both fixed public requests under one discovery deadline,
retain original grant authorization/revocation before and after reads, and pass
only caller-permitted upstream IDs. Public failure must not invalidate inference
credentials or trigger an authenticated/alternate-origin fallback. Source1 owns
refresh/cache publication and the common runtime; source3 owns projecting model
facts and qualified tariffs. This helper does not activate refresh by itself.

Source2 retains actual client selection, replay and parameter normalization.
The router preserves supplied `chat_template_kwargs`, `reasoning_budget`,
`reasoning_effort`, content parts and native tool calls. It does not inject the
frozen Ultra thinking-off defaults, flatten multimodal content to satisfy a
client compatibility hint, or alias newer models. Source6 owns actual consumer
acceptance and the separately assigned generated-snapshot slot.

Deterministic tests exercise the codec and real Worker/SQLite request path,
including both route forms, SSE, grant isolation, fixed-policy accounting and
deprecated-model rejection. They do not prove live entitlement, hosted inference
quality, deployment, self-hosted runtime parity or full-family completion.
