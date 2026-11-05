# LiteLLM configured model discovery

The `models_list` declaration uses bodyless, query-free `GET /models`, exposed
through `/v1/native/litellm/models` and `/v1/proxy/litellm/models_list`.
It appends `/models` to the explicitly configured `LITELLM_BASE_URL`. Configure
the gateway's API base, including its deployment prefix and `/v1` when used.
The router adds no version segment or default host and does not change Chat.

Only the original selected managed API-key grant can authorize this catalog.
The key belongs to that configured gateway; a direct-provider key, caller header,
environment fallback or another grant cannot replace it. Discovery establishes
no administrative or master-key authority. Common original-owner runtime from
PR798 checks caller policy, credential lineage and destination before fetch and
after complete parsing. Returned IDs intersect the admitted and current model
policies. Broader permissions acquired during the read cannot widen the result.
One operation owns the deadline, cancellation and bounded response lease.

The supported response is `{object: "list", data: [{id: "..."}]}`. IDs are opaque
gateway aliases; the router does not resolve them to an underlying vendor model.
The policy identity is `litellm/<returned-id>`. Empty inventory stays empty, with
no configured-card or cached-catalog replacement. Additional upstream row fields
remain opaque metadata: they do not set router token limits, model capabilities,
prices, account entitlements or administrative permissions. Unknown inference
costs remain unknown; a nonbillable metadata operation is not free inference.

## Frozen client contract and remaining integration

At OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/litellm/index.ts:256-271` selects strict live discovery and the
configured base. A base ending in `/v1` uses `models`; otherwise it uses
`v1/models`. That source records LiteLLM's root and versioned model-list routes.
`src/plugin-sdk/provider-catalog-live-acquisition.internal.ts:82-118` accepts
arrays or a `data` envelope and sends the resolved discovery key as Bearer.
This declaration keeps the stricter existing `openai.models` envelope; it does
not activate a data-only or array decoder, or retry another path after failure.

The frozen normalizer in
`src/plugin-sdk/provider-catalog-live-normalize.internal.ts:200-345` can infer
context, output limits and zero costs. Those client defaults are not qualified
LiteLLM account facts and are not copied into this declaration. The existing
configured card and its unknown prices remain unchanged.

Snapshot activation belongs to the serialized integration owner. Actual client
qualification remains separate: the qualified public client at
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`,
`extensions/clawrouter/provider-catalog.ts:463-489`, reads `/v1/catalog`; this
server declaration alone does not make it refresh LiteLLM's upstream list.
The client owner must consume the offered native/manifest discovery route with
the router credential, preserve the caller operation and cancellation, and keep
unknown facts distinct from defaults. No direct gateway-key forwarding, live
gateway provisioning or additional provider scope is included here.
