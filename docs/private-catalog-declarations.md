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
credential owner immediately before dispatch and again after complete private
metadata input retirement, before publication. Declaration metadata does not
create a credential, entitlement or new authority field.

Results retain the native `{data:[...]}` envelope and exact upstream IDs. Empty
authorized results stay empty. Baseten excludes the entire `decision-models/`
namespace from Chat discovery. Missing prices/limits stay absent; observed units
are neither converted nor promoted to model-card prices or serving entitlement.
The existing zero-inference-cost metadata operation does not make inference free.

## Shipping activation and local evidence

The generated snapshot now includes these three declarations. The other 84
provider records, model index and unrelated capability-index entries remain
identical to the frozen parent. Only three discovery capability entries are added.
Existing Chat endpoints, model cards, prices and authentication declarations
remain unchanged. No snapshot row is replaced by a runtime test injection.

The cases run the actual Worker under the locked Workerd runtime with real
SQLite Durable Objects. They cover native and manifest GETs, empty inventory,
caller override rejection, original-grant revocation and rotation, redirect
refusal, exact upstream destinations, filtered IDs and zero-cost metadata
settlement. The queue sink explicitly ingests original events into the real
UsageLedger; this is not a hosted queue-delivery claim. Original fetch, response
read, cancellation, reader-closed and Worker continuation outcomes are joined
independently before fixture disposal.

## Publication authority

After a complete, validated native response reaches EOF and releases its reader,
the Worker reads current caller authority and inspects the same selected grant's
metadata. It retains the admitted model permissions before asynchronous work and
intersects them with current permissions. Narrowing can produce HTTP 200 with an
empty native envelope; broadening cannot expose models outside the original
admission. There is no grant reselection, secret rematerialization, environment
fallback or second upstream request.

Revoked, disabled, expired or newly ineligible owners cannot publish inventory.
Caller revocation, policy disablement, stale policy generation and provider
removal retain their canonical denial responses. Upstream errors remain sanitized
even for unrestricted callers. The original post-read authority task is awaited
through settlement when cancellation occurs; cancellation is not a substitute
for completion of that task.

Real Workerd/SQLite cases cover all three providers over native and manifest
routes. A nonempty upstream prefix precedes an actual durable policy or owner
mutation; the original producer then completes its response. The witness checks
EOF/unlock before the production authority snapshot, mutation before refresh,
and refresh before publication, separately from verifier reads. It also checks
original operation outcomes, producer completion without expiry, one upstream
GET and one zero-inference-cost metadata event per dispatched case.

These are sequential authority observations, not atomic revocation through
client delivery or across separate stores. This extends the earlier
[pre-dispatch contract](keyed-model-discovery-runtime.md); the previous witness
was not proof of a violation of that narrower contract.

The existing contracts are [Baseten](baseten-models-schema.md),
[Arcee](arcee-models-schema.md) and [Novita](novita-models-schema.md). Registered
OpenClaw client execution remains separate and unrun by this declaration test;
client defaults must not become vendor price, context or entitlement facts.
