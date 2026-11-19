# Four public catalog declarations

This source candidate adds only catalog capabilities and endpoints to the existing
Cerebras, NVIDIA, Chutes and Venice manifests. Every Chat endpoint, model identity,
model fact, pricing reference, authentication scheme and inference origin stays
unchanged. No account entitlement, executable tariff or additional model follows
from a public catalog observation.

## Exact caller and wire contracts

| Provider | Endpoint | Paired request/response format | Caller exposure | JSON response |
| --- | --- | --- | --- | --- |
| Cerebras | `public_models` | `cerebras.public_catalog` | Manifest only | `{ providerId, catalog }`; `catalog` is a fact array |
| NVIDIA | `public_models` | `nvidia.public_catalog` | Manifest only | `{ providerId, catalog }`; `catalog` is a fact array |
| Chutes | `models_list` | `chutes.models` | Native and manifest | Native `{ object, data }` envelope |
| Venice | `models_list` | `venice.models` | Native and manifest | Native `{ object, type, data }` text envelope |

Each endpoint declares `models.list`, bodyless `GET /models`, JSON Accept and a
10-second operation deadline. The aggregate endpoints explicitly set
`nativeProxy: false`; Chutes and Venice set it to true. No model card acquires a
`models.list` capability. Native Chutes/Venice callers use
`GET /v1/native/{provider}/models`. Their caller catalog advertises the native
offer; manifest dispatch remains independently available without a duplicate
offer. Cerebras/NVIDIA advertise only their manifest offers. Their registered
discovery client uses bodyless `GET /v1/proxy/{provider}/{endpoint}`. Explicit
manifest-envelope callers can also use `POST /v1/proxy/{provider}/{endpoint}` with this envelope:

```json
{ "method": "GET", "body": {}, "query": {}, "pathParams": {} }
```

There is no caller model, body, query, path, credential, header or transport
selection. In particular, Venice's fixed `type=text` is owned by its factory;
callers cannot supply that query themselves. Cerebras/NVIDIA have no invented
native catalog alias. `/models` is their compiled operation selector, not a
physical upstream URL.

## Original authority and fixed factories

The existing private router caller must have the selected original owner-backed
API-key grant. Public upstream metadata never makes caller access anonymous and
never authorizes an inference account. Environment fallback, legacy or unrelated
grants cannot replace that original owner. Shared runtime rechecks the same
caller, policy, lineage and owner before each physical request and after parsing.
Only originally permitted compiled IDs survive final policy filtering.

Factories receive the canonical base and original operation signal, with no
inference key or prepared credential headers:

- [Cerebras](cerebras-model-catalog.md): one GET to
  `https://api.cerebras.ai/public/v1/models`.
- [NVIDIA](nvidia-model-catalog.md): on a successful path, two GETs to
  `https://integrate.api.nvidia.com/v1/models` and
  `https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json`.
  Authority or cancellation can stop before the second fetch.
- [Chutes](chutes-native-catalog.md): one GET to
  `https://llm.chutes.ai/v1/models`.
- [Venice](venice-model-catalog.md): one GET to
  `https://api.venice.ai/api/v1/models?type=text`.

Readers preserve normalized arrays versus native envelopes, exact observed price
units, unknown facts and authoritative empty results. NVIDIA's output budget is
not an account maximum. Chutes confidentiality flags are observations; Venice
USD and DIEM fields are independent. None becomes an admitted inference tariff,
zero-price fallback or a restored cached/static model. Metadata accounting is
separate from inference accounting and does not prove upstream inference access.

## Qualification boundary

The compiler foundation is [PR781](https://github.com/openclaw/clawrouter/pull/781),
qualified squash `222627d0b9ee3a6fc88c68304b9f9b270d1fac51`. This source candidate
is based on the qualified shared runtime [PR782](https://github.com/openclaw/clawrouter/pull/782),
squash `523302a8b14eddf54e3501368f088fdc0a1525f8` from final source
`a5ce00502a393d149d784929f60079fe45774414`. Its helper blob
`7072ed423fd7035895c7ed197543471d2467224d` exactly matches qualified
[PR779](https://github.com/openclaw/clawrouter/pull/779), squash
`b39e0d16652eac2c14028dcd0ddd881cdc6d8df5` from final source
`3f1c651756a6127ab3e606c74c4dae989c9b77b3`. No helper or common dispatch is copied.

The generated snapshot composes these four declarations with the existing provider
inventory. `worker/test/public-catalog-declarations.test.mjs` supplies twelve
cases: four preservation checks, four original-grant manifest/empty-result
accounting checks, and four catalog/native exposure plus zero-egress override
checks. The compiler fixture avoids duplicate setup capabilities while retaining
its existing assertions. Redirects remain manual and explicitly rejected by the
shared reader; metadata requests never follow a redirect with owner credentials.

`test/openclaw-public-catalogs.test.mjs` exercises actual workerd and SQLite for
the four formats, exact upstream destinations, authoritative empty inventories,
stale-grant denials, malformed responses and original reader retirement. Its
registered-client companion is pinned to public OpenClaw source
`1536faab19f2adf524b7ef1acef5c24501b35652`. Sixteen authored client tests cover
twenty acquisitions through the actual plugin registration and catalog adapter,
including two-key cache isolation and cancellation. Those client tests require
their own hosted execution; local Worker proof is not client qualification.

The pinned live-catalog cache rejects an aborted caller while its shared load
finishes separately. The contract joins the original physical read promises,
Worker retirement and real dispatcher release before cleanup. It does not claim
immediate physical pre-header disconnect propagation, inference entitlement,
vendor availability, a known tariff for unpriced models, or deployment.

Featherless remains a separate keyed numeric-pagination runtime contract. These
public declarations neither activate it nor change its pages, keys or limits.
