# Novita native catalog declaration

This finite compiler contract consumes the native catalog leaf in
[PR683](https://github.com/openclaw/clawrouter/pull/683), source
`e4b4811dd1182484b03b2244a8dfa1a60d015a25`, landed as
`047d9b984f38bada332cd71beaf1fe2f368c590e`. The actual exports are
`NOVITA_MODELS_FORMAT`, `novitaCatalogRequest`, `filterNovitaModels` and
`readNovitaModels`. No codec or provider source is copied.

## Exact declaration

- Provider `novita`, canonical base `https://api.novita.ai/openai/v1`.
- Original required Bearer API-key scheme and private router caller/grant.
- One `models.list` endpoint: bodyless `GET /models`, paired `novita.models`
  request and response formats, native proxy enabled.
- No query, path parameters/remapping, transport override, caller-supplied auth
  headers, streaming, lifecycle, model passthrough or inference tariff.
- Manifest may fix `accept: application/json`; the actual constructor owns the
  complete JSON headers and the original selected Bearer credential.

The constructor sends only to `https://api.novita.ai/openai/v1/models`, with
ambient credentials omitted, redirects rejected and the existing deadline
signal. There is no anonymous retry or older `/v3/openai` substitution. The
existing configured inference origin and native prefixes remain source4-owned.

## Native observations

The bounded reader requires the actual data-only envelope, exact unique IDs,
`object: model`, a native Unix timestamp and positive native context size.
Original grant filtering uses each unchanged upstream ID. Empty results remain
empty; no seed or configured model refills an upstream result.

`input_token_price_per_m` and `output_token_price_per_m` remain independent
integer observations. Their per-million denominator does not qualify currency
scale, a USD conversion, cache rate or an executable tariff. Missing or invalid
values stay absent; an observed zero does not create a free model card.
Context size is an observation, not serving entitlement or an inferred output
limit. Names, replacement hints, modalities and destination URLs are not copied.

## Integration and proof

Seven composed fixtures cover canonical key/path binding, closed declaration
expansions, exact policy filtering of the seven frozen identities, required
native facts, unknown price units, complete native reading and the unchanged
strict OpenAI decoder. Existing Chat cards and endpoint compilation remain
unchanged. The fixtures do not add model rows or establish runtime eligibility.

Source1 owns actual native discovery dispatch, original grant filtering and
fresh revalidation, bounded cache/deadline handling and selected credential
binding. Source4 owns the provider YAML and finite cards. Source2 owns actual
strict-refresh/configured-catalog behavior; source6 owns serialized snapshots
and composed native proof. No provider YAML, generated snapshot, common runtime,
account, credential or deployment is changed here. Helper/schema proof alone
does not activate discovery or establish current prices and entitlement.

The published leaf's [primary contract and wire evidence](novita-model-catalog.md)
remain the source for request/response details; this slice introduces no broader
catalog universe, media routes, pricing conversion or fallback behavior.
