# Baseten native catalog declaration

This compiler contract consumes the codec from [PR644](https://github.com/openclaw/clawrouter/pull/644),
final source `85677c8e3f1b905deaf45689167e7e0b62fe5bf2`, landed as
`a5089d5332a99c4d59abbbd14b01ac399139e25f`. It adds no provider YAML, model,
shared runtime registration or snapshot.

The qualified declaration is one `models.list` capability with methods `[GET]`
and a bodyless endpoint:

```yaml
method: GET
path: /models
requestFormat: baseten.models
responseFormat: baseten.models
headers:
  accept: application/json
```

The provider is `baseten`, its base is `https://inference.baseten.co/v1`, and its
original selected API key uses `Authorization: Bearer ${secret}`. No path
remapping, alternate origin/product, query, credential override, body transform,
stream, lifecycle, model passthrough or inference tariff is qualified. Native
proxy is enabled; the endpoint cannot be declared as Chat or `openai.models`.
Current [primary documentation](https://docs.baseten.co/inference/model-apis/overview#list-available-models)
confirms the authenticated catalog path and warns that catalog limits may differ
from enforced serving limits (checked 2026-11-03).

The actual exports are `BASETEN_MODELS_FORMAT`, `basetenCatalogRequest`,
`filterBasetenModels` and `readBasetenModels`. Preserve the native data-only
response and exact original-policy/grant filtering. Exclude every
`decision-models/` identity from Chat, including identities outside the three
frozen SystemOne cards. SystemOne remains a separate decision route.

Absent prices, features and limits stay unknown. Explicit zero is only a native
observation; neither observed rates nor metadata presence grant a router tariff,
serving limit, default model or entitlement. Authorized empty results stay empty.
The strict OpenAI catalog decoder remains unchanged.

Source1 must register this exact format and consume the landed codec with the
existing selected original credential, deadline, complete-response guards,
cache/revalidation and stopped-model filtering. The opaque Chat selector also
needs the full decision-namespace exclusion. Source4 owns the later provider
activation and actual Worker fixtures after both contracts qualify. Source2
owns actual client consumption; source6 owns serialized snapshot integration.
No helper/compiler test substitutes for those runtime or client proofs.

Six focused cases compose compiled declarations with the actual codec, reject
invalid routes/auth, preserve existing Chat and model rows, exercise policy and
decision filtering, retain unknown/native observations and preserve strict
OpenAI decoding. No live credential or inference call is needed.
