# Chutes public catalog declaration

This finite contract consumes [PR654](https://github.com/openclaw/clawrouter/pull/654),
source `0be53a224b2b2b1930b069e0e5fc805d40b7a4e0`, landed as
`0b5543d8f3972ba70f1227380e008214ce274a3c`. The actual exports are
`CHUTES_MODELS_FORMAT`, `chutesCatalogRequest(base, signal)`,
`filterChutesModels(payload, allows)` and `readChutesModels(response, signal, allows)`.
See [the codec contract](chutes-native-catalog.md).

The [primary Agent Hub](https://chutes.ai/agents), checked 2026-11-03, explicitly
qualifies public GET `https://llm.chutes.ai/v1/models`. Inference uses a separate
Bearer-authenticated request. No live inference or credential probe is needed.

## Exact declaration

Use provider `chutes`, every base URL exactly `https://llm.chutes.ai/v1`, and one
required Bearer `api_key` scheme for the existing private provider selection.
Declare one `models.list` capability with methods `[GET]` and an endpoint with
explicit `method: GET`, `path: /models`, paired request/response formats
`chutes.models` and native proxy enabled. No `upstreamPath`, query defaults,
path parameters, caller headers, endpoint auth override, credential/grant
transport override, adapter injection, inference pricing or generation/lifecycle
features are permitted. The only optional fixed header is `accept: application/json`.

There is no new public-caller flag. Compiled `auth` remains null. The native format
selects the published public request constructor, whose ABI accepts **no key**.
Source1 must call that constructor with only the canonical base and original
abort signal: never copy selected inference headers, OAuth tokens, cookies or
caller headers to this public upstream. The router request remains private and
requires original caller/grant authentication, policy filtering and revalidation.
Provider configuration is not permission to forward its credential to every route.

## Observations and activation

The five frozen identities in the codec remain exact; a deprecated Qwen row is
not silently rewritten. `TEE` or `thinking` in a name creates no capability fact.
Missing limits, modalities, flags and prices stay absent. Explicit non-text rows
are excluded from Chat. The boolean `confidential_compute` remains an observed
flag, not attestation, account entitlement or a grant to process confidential data.

Numeric prices remain native numeric observations. The current primary prose
and table use inconsistent per-token/per-million labels; this compiler performs
no conversion, inference tariff assignment or zero fallback. Explicit observed
zero is preserved. Separate `price` fields, control-plane IDs and unknown fields
are not projected. Independent context/output limits are not serving guarantees.

Seven focused cases compose declarations with the actual codec: public header
isolation, rejected paths/formats/overrides, exact policy identities, sparse/explicit
metadata, unchanged numeric units and strict envelopes. Existing Baseten/Arcee
compiler tests preserve their separate original-key upstream contracts.

Source1 retains native format dispatch, private original-grant authorization,
complete bounded response/deadline handling, cache ownership, revocation and
stopped-model filtering. Source4 owns Chutes YAML only after both shared contracts
and actual Worker proof; source2 owns actual client consumption and source6 the
serialized snapshot/client proof. This slice changes no YAML, model cards,
snapshot, shared runtime, auth account or deployment. It does not activate native
discovery or extend the separate OAuth execution contract.
