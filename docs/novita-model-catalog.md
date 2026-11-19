# Novita native model catalog

This focused leaf implements the keyed, data-only native model catalog required
by frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/novita/{openclaw.plugin.json,index.ts}`. The frozen family uses
strict refreshable discovery, configured-model augmentation and seven finite
Chat identities. This change declares no provider endpoint or additional model.

## Primary contract

Checked 2026-11-03:

- [List models](https://docs.novita.ai/api-reference/model-apis-llm-list-models).
- [Authentication](https://docs.novita.ai/api-reference/basic-authentication).
- [Chat reference](https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion).
- [Published documentation index](https://docs.novita.ai/llms.txt).

The current reference specifies Bearer GET
`https://api.novita.ai/openai/v1/models`, with `Content-Type: application/json`
and a root `data` array. It does not specify a root `object: list`. Each row has
an exact `id`, `object: model`, Unix `created` and `context_size`. Native
`input_token_price_per_m`/`output_token_price_per_m` are integer observations.
The reference states a per-million-token denominator but does not qualify the
currency scale used by its 3900 example. Neither a decimal USD rate nor a zero
cache price may be inferred from that integer. Keep input and output independent.
A bounded anonymous GET returned 403; no key was acquired and no anonymous
retry or alternate-account behavior is implemented.

Older `/v3/openai` examples and SDK examples omitting `/v1` do not override the
explicit current HTTP endpoint. The request helper accepts only the existing
canonical inference base with an optional final slash; it fixes the full models
URL. Other bases, credentials in URLs, query/fragment remapping, ports,
control-plane paths and malformed keys are rejected. No model page URL,
returned metadata or configured model can become an upstream destination.

## Published exports

```ts
NOVITA_MODELS_FORMAT = "novita.models"
novitaCatalogRequest(base: string, selectedApiKey: string, signal: AbortSignal): Request
filterNovitaModels(payload: unknown, allows: (id: string) => boolean): NovitaModelCatalog
readNovitaModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<NovitaModelCatalog>
```

The request is bodyless, carries only the original selected Bearer key and JSON
headers, omits ambient credentials, refuses redirects and shares cancellation.
The parser requires a data-only envelope of at most 4096 unique bounded IDs,
`object: model`, a nonnegative safe-integer timestamp and positive safe-integer
context. Original policy filtering uses the unmodified native ID. It retains
independent nonnegative safe-integer input/output price observations; absent or
malformed prices remain absent. Titles, descriptions, destination hints,
unsupported capabilities and unrelated pricing shapes are not copied. There is
no name-derived reasoning, modality, output cap, tariff, alias or seed refill.

The existing native JSON reader enforces complete HTTP-200 JSON, 2 MiB,
MIME/UTF-8/range/length integrity and abort/EOF behavior. Tests cover all seven
frozen IDs, strict envelopes/duplicates/bounds, exact filtering, unknown prices,
fragmentation, cancellation and native Node loading without the test resolver.

## Finite continuation and owners

The next provider slice retains the existing seed and accounts for exactly:
`moonshotai/kimi-k3`, `moonshotai/kimi-k2.7-code`, `minimax/minimax-m3`,
`zai-org/glm-5.2`, `deepseek/deepseek-v4-pro`, `qwen/qwen3.7-max`, and
`minimax/minimax-m2.7`. Frozen costs and deprecated/replacedBy hints require
primary qualification; they are not copied as present prices or dated shutdowns.

Sources1/3 must publish actual `novita.models` dispatch and paired bodyless
GET `/models` validation at the canonical base, consuming this original-key
helper/reader. Keep provider Bearer configuration, private caller authorization,
original-grant filtering, stopped/alias eligibility, scan/deadline/cache guards
and credential/destination binding. Do not relax the strict OpenAI decoder or
use the Synthetic format to accept this unrelated native contract. Source4
owns only the new leaf and later new-family provider files; no common types or
runtime change is included. Discovery declaration waits for actual integration.

Source2 owns actual client strict discovery and configured-catalog augmentation.
Source6 owns later serialized snapshot and composed native proof. The video
provider registered by the frozen Novita plugin remains with the media owner;
this leaf creates no media offers or media registry entries.

Local execution is code-only. Hosted exact-head tests qualify this leaf; passing
helper tests alone does not establish Worker activation, account access, price
settlement or end-to-end parity. No live inference, login, provisioning or manual
deployment occurred. No provider snapshot is changed by this codec-only slice.
