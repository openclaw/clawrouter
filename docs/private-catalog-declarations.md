# Private catalog declarations

This declaration adds only `models.list` / `models_list` to the existing
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

## Qualified source and remaining integration

[PR751](https://github.com/openclaw/clawrouter/pull/751), qualified squash
`752a16c82fd242b71d2ddeea03c39fc46d90f8a6`, supplies the actual private dispatch
and owner checks. This declaration uses frozen qualified base
`fa12bfab595f438a8abb61fb95d3cd2347936552`, which contains that squash and the
workerd-compatible manual-redirect factories from
[PR794](https://github.com/openclaw/clawrouter/pull/794). All current Baseten,
Arcee and Novita cards, prices and inference blocks remain byte-identical to
that base. No old card set is restored.

The existing contracts are [Baseten](baseten-models-schema.md),
[Arcee](arcee-models-schema.md), [Novita](novita-models-schema.md) and the
[shared runtime](keyed-model-discovery-runtime.md). No new schema or codec is
introduced. The additive Novita hunk preserves the frozen Chat cards already
present in this qualified base; this branch neither copies nor replaces them.

The actual source4 factory correction and common private-authority runtime are
qualified. This declaration adds no runtime logic. Source6 retains the existing
serialized snapshot/composed queue after
[PR799](https://github.com/openclaw/clawrouter/pull/799). Source2 retains actual
client route selection and unknown-fact materialization; the accepted handoff
is not client execution or completed E01 parity. No snapshot is generated here.

The new cases compile the actual declarations and exercise native/manifest
Worker dispatch, original credentials, policy filtering, empty inventories,
caller override denial, revocation and decision exclusion through the real
readers and existing Worker/SQLite fixture. All 19 cases remain authored but
unrun locally because this retained checkout has no qualified dependencies.
Syntax, byte-preservation and privacy checks pass; all-manifest validation and
hosted final-head checks remain required. Node fixture execution would not by
itself prove workerd constructor compatibility.
