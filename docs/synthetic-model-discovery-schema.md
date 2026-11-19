# Synthetic native discovery declaration contract

The exact YAML and compiled mapping uses camelCase `upstreamPath`:

```yaml
models_list:
  method: GET
  path: /models
  upstreamPath: /openai/v1/models
  requestFormat: synthetic.models
  responseFormat: synthetic.models
  timeoutMs: 30000
```

This is a `models.list` capability with exactly `methods: [GET]`. The
provider is `synthetic`, the selected origin is `https://api.synthetic.new`,
and the original credential uses `Authorization: Bearer ${secret}` with
`secretKind: api_key`. Caller authorization still uses `/models`; only dispatch
uses `/openai/v1/models`. No URL, query, path parameter, credential override,
stream, model passthrough, inference tariff or lifecycle control is eligible.
The initial contract excludes declared grant-transport overrides. It does not
exclude selecting an otherwise qualified original API-key grant at runtime.

The [primary API overview](https://dev.synthetic.new/docs/api/overview), checked
2026-11-03, documents the OpenAI API prefix and models endpoint. The observed
native envelope is `{data: [...]}` without required OpenAI object tags.
`worker/synthetic-model-catalog.ts` exports the landed
`filterSyntheticModels(payload, allows)` codec. Shared runtime dispatch must
call it with the original policy/grant model filter, retaining the existing
bounded JSON reader, deadline, re-admission and metadata accounting. Do not
copy the codec or weaken the strict `openai.models` decoder. The compiler
fixtures consume the actual codec and `discoveryAllows`; they do not claim
that shared native dispatch has already been wired.

The response preserves native data-only shape and only permitted active text
models. Missing limits, features and prices remain absent. Published decimal
price strings are observations, not qualified hard-budget tariffs. An anonymous
HTTP 200 does not establish public-auth or account-entitlement semantics.

Activation dependencies remain separate: shared runtime must classify and
dispatch `synthetic.models` with this mapped path; the provider owner then
qualifies the actual native/manifest Worker fixtures before serialized snapshot
integration. This schema change neither edits the Synthetic manifest nor
activates discovery. Existing Chat/Messages and OpenAI/Anthropic metadata
mapping contracts remain unchanged.
