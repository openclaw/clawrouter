# Featherless native catalog declaration

This finite declaration consumes [PR658](https://github.com/openclaw/clawrouter/pull/658),
source `8741e03f43fff15433364f710999b255a18db2ef`, landed as
`68e272ea9293399316eec9f3bbca1f8cb94efd22`. Its actual exports are
`FEATHERLESS_MODELS_FORMAT`, `featherlessCatalogRequest(base, selectedApiKey, page, signal)`,
`filterFeatherlessModels(payload, allows, expectedPage)` and
`readFeatherlessModels(response, signal, allows, expectedPage)`.
See [the codec contract](featherless-model-catalog.md).

## Exact declaration

Use provider `featherless`, every base URL exactly `https://api.featherless.ai/v1`,
and one required Bearer `api_key` scheme. Declare one `models.list` capability
with methods `[GET]` and one endpoint with explicit `method: GET`, `path: /models`,
paired request/response formats `featherless.models` and native proxy enabled.
No alternate dispatch path, query defaults, path parameters, caller headers,
endpoint auth override, grant transport, adapter injection, inference pricing or
generation/lifecycle features qualify. The only optional fixed header is
`accept: application/json`.

The published constructor owns `capabilities=chat&page=N&per_page=100` and sends
the **same original selected API key on every page**, with redirects rejected.
The router caller remains private and original-grant authorized. An anonymous
upstream response does not authorize a public-caller route, anonymous retry,
credential replacement or account entitlement.

## Page observations and activation

The native envelope is `{data, pagination, total}`. Expected page, fixed page
size, total and page count must agree. Policy filtering may produce no rows,
and upstream may return a short page while advertising later pages. Continue
from validated `current_page < total_pages`, never from returned row count.
Source1 owns the bounded complete scan: one discovery deadline, per-page original
credential and grant revalidation, aggregate byte/row/page bounds and conservative
handling of inventory changes. These compiler fixtures do not implement or prove
that scan, caching or runtime dispatch.

Frozen identity `Qwen/Qwen3-32B` stays exact in policy tests; this slice adds no
model card or catalog universe. Missing prices, limits and feature flags stay
absent. Native decimal price strings and explicit zero remain observations,
not converted inference tariffs. False account availability and inactive or
explicit non-model rows are excluded; true flags do not establish serving rights.
The [primary plan documentation](https://featherless.ai/docs/api-reference-plan),
checked 2026-11-03, distinguishes model limits from the account's separate ceiling.
No plan lookup or login is performed here.

Seven focused cases compose the actual codec with compiler output: original-key
pagination, declaration/credential rejection, exact policy filtering, nonterminal
empty pages, unknown account facts, independent prices and strict decoder bounds.
The OpenAI decoder stays unchanged. Source4 owns provider YAML after source1's
shared runtime and actual Worker proof; source2 owns actual client consumption
and source6 serialized snapshot proof. This slice changes no YAML, generated
snapshot, shared runtime, account or deployment and does not activate discovery.
