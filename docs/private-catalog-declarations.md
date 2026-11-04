# Private catalog declaration preparation

This local candidate adds only `models.list` / `models_list` to the existing
Baseten, Arcee and Novita manifests. Cards, Chat endpoints, prices, auth, service
keys, native prefixes and adapters remain unchanged.

| Provider | Paired request/response format | Fixed upstream GET |
| --- | --- | --- |
| Baseten | `baseten.models` | `https://inference.baseten.co/v1/models` |
| Arcee | `arcee.models` | `https://api.arcee.ai/api/v1/models` |
| Novita | `novita.models` | `https://api.novita.ai/openai/v1/models` |

Each existing compiler contract permits native exposure: literal `/models`,
`method: GET`, `nativeProxy: true`, one GET capability and optional fixed
`accept: application/json`. The 10-second endpoint ceiling is the existing
compiler/runtime fixture value. There are no body, query, path parameters,
upstream mapping, caller-header overrides or inferred OpenAI catalog aliases.
Native and manifest callers use bodyless, query-free GETs:
`/v1/native/<provider>/models` and `/v1/proxy/<provider>/models_list`.

The actual runtime requires the original selected **owner-backed API-key grant**.
An environment key, OAuth access token, bundle, replacement account or caller
header cannot satisfy that authority. It rechecks the caller and original
credential owner immediately before dispatch. Declaration metadata does not
create a credential, entitlement or new authority field.

Results retain the native `{data:[...]}` envelope and exact upstream IDs. Empty
authorized results stay empty. Baseten excludes the entire `decision-models/`
namespace from Chat discovery. Missing prices/limits stay absent; observed units
are neither converted nor promoted to model-card prices or serving entitlement.
The existing zero-inference-cost metadata operation does not make inference free.

## Source pins and activation hold

[PR751](https://github.com/openclaw/clawrouter/pull/751), qualified squash
`752a16c82fd242b71d2ddeea03c39fc46d90f8a6`, supplies the actual private dispatch
and owner checks. This preparation uses retained qualified base
`b8b33d5bdd771bfa0904ac493b2fc6129b2768db`, which contains that squash and preserves
its keyed-discovery module/test blobs exactly while retaining the later Arcee
cards. No old card set is restored.

The existing contracts are [Baseten](baseten-models-schema.md),
[Arcee](arcee-models-schema.md), [Novita](novita-models-schema.md) and the
[shared runtime](keyed-model-discovery-runtime.md). No new schema or codec is
introduced. The additive Novita hunk must preserve the independently prepared
cards in [PR687](https://github.com/openclaw/clawrouter/pull/687) when source6
integrates its existing queue; this branch neither copies nor replaces them.

Publication, CI, snapshots and discovery activation remain held. Source4 owns
the concrete request-factory compatibility fix: `redirect: "error"` is unsupported
by workerd. The current factories therefore are not qualified for activation
despite the earlier Node/runtime checks. Source1 must qualify the current common
path with those exact corrected factories; source2/source6 own actual-client
acceptance and serialized snapshots. No redirect behavior is guessed here.
The existing compiler tests' direct-factory redirect assertions must consume the
actual source4 contract before subsequent qualification, without changing their
credential, URL or no-retry assertions.

The new cases compile the actual declarations and exercise native/manifest
Worker dispatch, original credentials, policy filtering, empty inventories,
caller override denial, revocation and decision exclusion through the real
readers and existing Worker/SQLite fixture. They are authored but unrun. Node
fixture execution would not by itself prove workerd constructor compatibility.
