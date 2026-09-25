# API reference

ClawRouter serves discovery, proxy, session, and administration APIs from one Worker. This page lists the HTTP surface; deployment and resource configuration live in [Deploy ClawRouter on Cloudflare](deploy-cloudflare.md), and state ownership and failure behavior live in [Architecture](architecture.md).

## Authentication

Proxy credentials use `Authorization: Bearer <clawrouter-key>`. Authentication resolves the issued credential and its policy from the serialized `ACCESS_CONTROL` Durable Object authority before any provider secret is used.

Browser session, playground, and OAuth routes require a verified Cloudflare Access session. Admin routes accept that verified session for configured admins or `Authorization: Bearer <admin-token>` against `CLAWROUTER_ADMIN_TOKEN_SHA256`. Admin status does not grant provider access, and provider access does not grant admin status. A pool-submission route accepts only its one-time scoped ticket; neither proxy nor admin credentials are interpreted there.

The Docker self-hosting profile has no Cloudflare Access identity. Its admin API uses the bearer token, and clients use normal proxy credentials.

The optional `/private/v1/{models,catalog,responses}` facade has its own pinned owner or isolated-workload authentication and never accepts generic proxy/admin credentials. See the [private alias contract](private-codex.md) for exact paths, configuration, protocol limits, and isolation requirements. It is absent from public discovery.

## Discovery and client routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Service health, application version, and observability mode |
| `GET` | `/v1/providers` | Compiled provider snapshot |
| `GET` | `/v1/routes` | Compiled OpenAI-compatible, manifest, and native route catalog |
| `GET` | `/v1/models` | Model list scoped to the authenticated credential or session |
| `GET` | `/v1/catalog` | Authorized configured providers and operation/model/transport offers |
| `GET` | `/v1/me` | Proxy-credential identity and policy summary |
| `GET` | `/v1/usage` | Caller policy or principal budget and usage summary |
| `GET` | `/v1/key/inspect` | Proxy-credential verification and readiness status |

Usage summaries, provider totals, and daily totals remain shared across each
authorized policy. The budget follows the policy's configured policy or principal
scope. Recent `usage.events` on `/v1/usage` and `/v1/session/usage` contain only
events attributed to the authenticated principal. A service key without a
principal sees only events with its exact credential ID and no principal.
Unattributed historical events without that credential ID remain admin-only;
reassigning a credential does not transfer a previous principal's event history.
This tightens earlier releases' policy-wide recent-event visibility. Administrators
use `/v1/admin/usage` for the complete audit; their personal session endpoint
still returns only their own events. Retained request content remains admin-only.

`GET /v1/catalog` is the client integration contract. It reports `scope`
(auth type, credential, principal) and `observedAt`. Only authorized configured
providers appear; configured but unavailable rows remain inspectable. Static
`/v1/providers` and `/v1/routes` describe registration, not caller eligibility.
Use those endpoints for setup inventory; client catalogs can omit unconfigured
providers.

`nativeBaseUrl` preserves the v1 route-location string: `/v1/native/<provider>`,
or `/v1` for Fusion, including in session catalogs. It is legacy location
metadata, not authorization or transport eligibility. Consumers should select a
matching eligible `offer` under the returned `scope`, rather than infer access
from `nativeBaseUrl`, `routes`, or provider-wide readiness.

Each provider's `offers` identifies an endpoint, model (or an operation form
without a selected model), route, transport, selected policy and generation,
`eligible`, and an optional `reasonCode`. `affordability` is `exact-covered`, `exact-blocked`, or
`request-dependent`: fixed tariffs can be compared with observed balances,
while token-priced requests depend on their actual input and parameters. Free
token counting and declared zero-price operations remain available at exhausted
positive limits. A configured zero limit still blocks ordinary requests.
Affordability describes the plain operation; request parameters and hosted
tools are assessed again at dispatch. A form without a selected model remains
request-dependent when an eligible declared model is available; it does not
make a model-less or opaque request priced.

The projection observes the actual principal's policy ledger and the provider
ledger without reserving budget, selecting credentials, refreshing accounts, or
probing upstream. Observations are advisory; HTTP dispatch and every WebSocket
create authenticate, check current grants, and reserve budget independently.
Policy order is chosen by grant/transport eligibility before price or budget;
an exhausted selected policy never causes a switch to a richer policy. Within
that policy, deterministic credential/configuration checks precede grant
priority, so an unusable account cannot displace a configured sibling.

Session offers target HTTP playground routes only. A session catalog cannot
certify an issued key's native or WebSocket access; fetch the catalog with that
key. The same session projection appears in `/v1/session`'s
`entitlements.catalog` and in `/v1/entitlements`'s `catalog`.
Policies without `tenantId` now use the dispatch/ledger tenant `default`
consistently during Access selection and discovery, instead of inheriting the
session tenant only in those two views.

`/v1/models` uses the same eligible model projection. Grant-pool ownership stays
unchanged: when canonical selection reports a configured pool with no available
candidate, discovery does not reopen environment authorization. Fusion's
advertised model uses the same concrete aggregator eligibility.

Fusion emits one HTTP `clawrouter/fusion` offer for the synthesizer's selected
policy and generation. Its route is `/v1/chat/completions` for a key or
`/v1/playground/v1/chat/completions` for a session. A sibling native or WebSocket
operation cannot make that Chat offer eligible. Fixed-price observations account
for the synthesizer first and shared adviser budgets; if only a subset of
advisers may fit, the usable offer remains `request-dependent`. Unavailable
advisers fail open. These observations do not replace request-time admission or
the separate administrator preview of an unsaved Fusion configuration.

Environment credentials become eligible only after account-inventory activation.
After activation, paused and reauthorization-required accounts retain attachment
presence and prevent environment fallback even when none is selectable. Before
activation, would-be environment fallback returns `503 grant_pool_not_ready`;
scoped accounts and administrator recovery remain available.

Account recovery uses the existing administrator authentication and browser CSRF checks:

- `GET /v1/admin/grant-pools/readiness`: baseline, revision, scan cursor, bounded unresolved keys, and activation time. It is independent of account listing.
- `POST /v1/admin/grant-pools/baseline`: `{revision, baseline: "existing" | "fresh", confirmed: true}`. This records an explicit storage/inventory attestation; an empty scan never accepts it automatically.
- `POST /v1/admin/grant-pools/scan`: `{revision}` starts or restarts a bounded inventory scan.
- `POST /v1/admin/grant-pools/advance`: `{scanRevision, phase, cursor}` processes the next page of at most 32 keys. The server owns the next cursor and repair outcomes.
- `POST /v1/admin/grant-pools/activate`: `{revision}` activates only a complete unchanged scan with no unresolved evidence. Stale commands return `409 grant_pool_readiness_changed`.
- `POST /v1/admin/grant-pools/repair`: `{cursor: null | string}` reconciles up to 32 indexed account keys without contacting providers, including committed owners with missing or stale KV projections. The returned cursor advances past unresolved keys; matching projections are not rewritten.

Bootstrap also includes `grantPoolReadiness`. The status endpoint and recovery screen remain reachable when bootstrap cannot list a malformed legacy account. An `attached`, `detached`, `unattached`, `pending_cancelled`, or unresolved repair outcome describes storage reconciliation, not credential verification. See [deployment activation and forward recovery](deploy-cloudflare.md#account-routing-activation-and-recovery).

Proxy (including native), admin, and pool-submission route identifiers are
decoded once. Invalid percent escapes or invalid percent-encoded UTF-8 return
HTTP 400 with `invalid_path_encoding`, after applicable authentication checks.
Semantic identifier and path validation still applies after decoding.

## Proxy routes

| Method | Path | Contract |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat routing |
| `POST` | `/v1/responses` | OpenAI Responses routing |
| `GET` upgrade | `/v1/responses`, qualified native Responses paths | Authenticated, bounded [Responses WebSocket sessions](#websocket-contract) |
| `POST` | `/v1/embeddings` | OpenAI-compatible embeddings routing |
| `POST` | `/v1/messages` | Anthropic Messages routing |
| `POST` | `/v1/messages/count_tokens` | Anthropic token counting |
| manifest-defined | `/v1/proxy/<provider>/<endpoint>` | Manifest request, query, header, path, and auth mapping |
| manifest-defined | `/v1/native/<provider>/<provider-native-path>` | Provider-native request and response formats |

OpenAI-compatible requests select a provider-qualified model in the request body, for example `openai/gpt-4.1-mini`. Native and manifest routes resolve the provider and endpoint from the compiled snapshot instead of accepting arbitrary upstream URLs.

Unified routes require matching OpenAI request and response formats. A provider's
Chat or embeddings capability alone is insufficient: use its native route when
the protocol differs, such as Cohere's `/v2/embed` with `texts` input.

Native routes preserve the selected provider's upstream model namespace. For example, `openai/gpt-6-astra` in an OpenRouter request remains an OpenRouter model identifier. Known models must support the selected endpoint. Caller-supplied unknown models require that endpoint's explicit `modelPassthrough` declaration; this preserves opaque model selection on the bundled model-provider routes without claiming model availability or copying another model's capabilities. Such models remain absent from discovery and unpriced unless the endpoint declares an applicable pricing reference. The local Chat endpoint explicitly retains its zero API charge. Either a policy or provider budget requires declared pricing or an explicit fixed request tariff before dispatch.

Opaque native IDs are preserved even when they begin with the provider's routing
prefix. For example, use `openrouter/free` on the native OpenRouter Chat route;
the same model on unified Chat is `openrouter/openrouter/free`.

Native Responses JSON and SSE routes include:

| Provider | ClawRouter path | Upstream contract |
| --- | --- | --- |
| Azure OpenAI | `/v1/native/azure-openai/openai/v1/responses` | Deployment name in `model`; endpoint and API key required; no inherited dated `api-version` |
| OpenRouter | `/v1/native/openrouter/v1/responses` | OpenRouter model identifier in `model`; bearer credential required; `OPENROUTER_SITE_URL` attribution optional |

Azure's legacy deployment chat and embeddings routes still require `AZURE_OPENAI_API_VERSION`. The default `azure-openai/deployment` model is listed only when `AZURE_OPENAI_DEPLOYMENT` is configured; explicit native deployment routes remain available without that default. The placeholder Azure deployment and OpenRouter `auto` catalog entries do not attest a particular model's Responses support or price. See the upstream [Azure Responses contract](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses) and [OpenRouter Responses contract](https://openrouter.ai/docs/api/api-reference/responses/create-responses); operators must verify model access with their own provider account.

A manifest proxy request for Tavily looks like this:

```sh
curl "$CLAWROUTER_BASE_URL/v1/proxy/tavily/search" \
  -H "authorization: Bearer $CLAWROUTER_KEY" \
  -H "content-type: application/json" \
  --data '{"body":{"query":"openclaw"},"query":{"topic":"news"}}'
```

`clawrouter/fusion` is an optional virtual model on `/v1/chat/completions`. It fans a bounded text-only prompt out to configured adviser models and asks one configured synthesizer for the final response. Every subrequest uses normal policy, budget, readiness, retention, and usage-accounting paths. See [Fusion routing](fusion-router.md).

## Responses continuation contract

Responses HTTP/SSE and WebSocket routes preserve upstream `previous_response_id` and
`x-codex-turn-state` bytes. The router binds returned identities to the caller's
authorization scope, provider route, and credential owner before publishing them.
Every continuation still checks current authorization, grant eligibility, and
budgets. It cannot fail over to another account. Ordinary stateless requests keep
their configured pool routing and failover behavior.

Owner-controlled token refresh preserves the binding. Replacing credentials or
account identity, revoking a grant, changing the route, or losing the original
owner requires a restart. HTTP 409 `continuation_restart_required` means resend
full input without either continuation field. Unknown or expired identities are
rejected before upstream dispatch, including environment/API-key routes. This
also applies after upgrading: state created before this binding contract must be
restarted with full input. Stateless requests and known environment/API-key
continuations remain supported.

Bindings expire 30 days after first publication, independently of upstream state
retention. Each authorization scope admits up to one million hashed identities;
it never evicts a live binding to admit another. Binding-store failure or capacity
exhaustion returns `continuation_unavailable` before headers, or terminates an
already-started stream. The upstream call can still incur charges. Response IDs
are limited to 256 UTF-8 bytes and turn state to 8 KiB. Output/frame size is not
limited by HTTP identity observation, and raw identities and model output are not
stored in this index.

The router records bounded retained-tool evidence on response identities for a
future pricing consumer. This does not change current pricing or admission, and
does not claim complete inherited-tool enforcement. Unknown, legacy, and opaque
history remain unqualified. Reusing a response identity belonging to another
producer fails publication with `continuation_unavailable`; resend full input.
This also applies to older claim-less writers encountering qualified-producer
rows. Transient proof-finalization failure after a confirmed identity claim can
preserve delivery and accounting while leaving evidence unqualified.

This contract covers `previous_response_id` and Codex turn state. Responses
`conversation` selectors remain an unpinned, separate contract gap; do not rely on
pooled account affinity for them. WebSockets also use the connection contract below.

HTTP endpoint deadlines start after preflight and end after response
normalization, before continuation-header registration and body delivery. For
streaming SSE requests, normalization includes bounded first-event inspection; for
successful JSON responses, it ends at the response headers. These deadlines do
not impose a total or idle timeout on body delivery. Caller cancellation remains
active through EOF. Fusion advisers retain their separate consumption deadline.
Caller cancellation, router deadline, and upstream or publication failure retain
the first observed cause in usage receipts. The selected HTTP status stays
separate from that outcome. An accepted HTTP rejection keeps its status when JSON
or SSE error details cannot be read; later cancellation still ends delivery.
A parsed terminal usage event retains its measured
charge if delivery later stops; dispatched work without final usage retains its
estimate. This does not guarantee that every transport reports an idle client
disconnect.

### HTTP cancellation diagnostics

Cancellation accounting starts when the runtime reports an ingress abort or
response-body cancellation. A client-local abort alone does not guarantee a
prompt server notification or a receipt within ten seconds for an indefinitely
idle HTTP response.

`pnpm test:scripts` includes the seven affirmative deadline and cancellation
cases: progressing JSON/SSE delivery, initial-response deadlines, active-delivery
cancellation, and cancellation observed after independently delayed JSON output.
Each cancellation case requires upstream shutdown, one receipt, and settlement
in both real budget ledgers. The strict idle-disconnect reproduction is explicit:

```sh
pnpm diagnostic:http-idle-disconnect
```

That command replays the original eight-case sequence, including the final
whitespace-only response. It retains every strict assertion and exits nonzero
when the limitation reproduces. Its nested entry point is outside the default
`test/*.test.mjs` script-test glob; no result is suppressed or treated as a pass.

At commit `750a4093c9685829e9423f124c56022e7a2ce838`, the
[hosted diagnostic run](https://github.com/openclaw/clawrouter/actions/runs/35856640488/job/107166567427)
used Node 24.21.0, Miniflare 5.20260918.0-alpha and workerd 1.20260918.1.
The delayed-output case received HTTP 200/gzip headers and zero decoded body
bytes before the client aborted at 1.048 seconds. Independent payload output
started at 2.044 seconds; ingress abort followed at 2.452 seconds, before EOF.
It recorded one `200`/`client_error` receipt with unknown tokens and a fixed
charge of 7 micros in both ledgers. The unchanged whitespace-only case recorded no
ingress abort or receipt, and both reservations remained unsettled during the
observation window. That limitation remains unresolved.

The pinned [KJ disconnect contract](https://github.com/capnproto/capnproto/blob/0501d343/c++/src/kj/async-io.h#L205-L214)
allows detection to remain pending without a write; its
[HTTP implementation discusses the half-close tradeoff](https://github.com/capnproto/capnproto/blob/0501d343/c++/src/kj/compat/http.c++#L8278-L8287).
Node 24.21.0 [Fetch abort](https://github.com/nodejs/node/blob/v24.21.0/deps/undici/src/lib/web/fetch/index.js#L104-L126)
reaches [HTTP/1 socket destruction](https://github.com/nodejs/node/blob/v24.21.0/deps/undici/src/lib/dispatcher/client-h1.js#L1198-L1206),
whose [ordinary-close path is distinct from reset](https://github.com/nodejs/node/blob/v24.21.0/lib/net.js#L1097-L1130).
The fixture does not establish physical FIN/RST behavior, compression causality,
or deployed HTTP/2 behavior. No idle or total-delivery timeout is added.

## WebSocket contract

Send authenticated upgrades to `/v1/responses` or
`/v1/native/openai/v1/responses`. Unified upgrades select their model on the first
`response.create`, so an HTTP 101 alone does not prove model access or upstream
readiness. Every create rechecks credential, policy, provider, grant, retention,
and budget before dispatch. The connection pins its provider route and grant
revision; changing either requires a new connection.

Response IDs and `response.metadata` turn state are bound to each create's fresh
authorization scope and actual upstream owner before forwarding. Codex can then
reconnect with `client_metadata["x-codex-turn-state"]` or fall back to HTTP with
the same turn state and account. Conflicting header and metadata tokens are
rejected; every supplied continuation identity must name the same owner.
An upgrade header alone
does not create a synthetic metadata event. Metadata may precede
`response.created`; it identifies the response without proving execution started.
Pending publication preserves frame order and blocks the next same-lane create
until publication and settlement finish. Closing the connection suppresses late
publication acknowledgments and queued output.

The bridge forwards native response IDs, errors, metadata, tool results,
`previous_response_id`, and `stream_options`. Prewarm `generate: false` requests
receive normal admission and accounting. It never replays requests or switches
grants after dispatch. A terminal response with usable usage settles once;
sent requests interrupted by disconnects or deadlines without final usage retain
the reservation. Unsent admitted requests release it; queued requests have no
receipt. The first terminal outcome or close cause owns settlement, including
when admission finishes after cancellation. A client disconnect records
`client_error` with `status_code: null`; only the response whose deadline expired
records `timeout`/504. Other active lanes closed with that connection do not
inherit its timeout. If budget
settlement and its durable recovery both fail, or usage publication fails, the
socket reports `accounting_unavailable` and closes before accepting more work.

Limits per connection are 16 active responses, 32 named lanes plus the default
lane, 48 buffered creates, 4 MiB per incoming frame, 8 MiB total buffered create
bytes, at most 48 output frames/8 MiB awaiting publication, and 16 MiB cumulative
downstream output. The output limit bounds a slow
reader because Workers' WebSocket API has no supported drain/queue metric.
Connections last at most 60 minutes; each response uses its endpoint deadline,
capped at 600 seconds. Clients must reconnect after a limit or deadline closes
the connection. Binary frames, steering events, and background execution are
rejected visibly. This contract runs on the Worker deployment; other hosts must
qualify native upgrade forwarding before advertising it.

See the upstream [Responses WebSocket contract](https://developers.openai.com/api/docs/guides/websocket-mode). An authenticated catalog route advertises `websocket: "openai.responses"` only when its endpoint and grant transport are eligible.

## Access session routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/session` | Verified Access identity, entitlements, and readiness |
| `GET` | `/v1/session/avatar` | Proxied user avatar |
| `GET` | `/v1/session/usage` | Session quota and usage summary |
| `GET` | `/v1/entitlements` | Compatibility entitlement response |
| `GET` | `/v1/session/credentials` | Credentials owned by the signed-in user |
| `POST` | `/v1/session/credentials` | Create a caller-owned credential; reject an existing ID |
| `PUT` | `/v1/session/credentials/<credential-id>` | Create or rotate a caller-owned credential |
| `POST` | `/v1/session/credentials/<credential-id>/rotate` | Replace only an active credential's secret hash |
| `POST` | `/v1/session/credentials/<credential-id>/revoke` | Revoke a caller-owned credential |
| `POST` | `/v1/playground/<route>` | Run a console playground request through an allowed route |
| `GET` | `/v1/oauth/callback` | Complete a provider-approved browser OAuth flow |

The Worker redirects `/` to `/dashboard`, and `/dashboard` to `/dashboard/home`. A production Cloudflare Access application protects `/dashboard/*`, `/v1/session*`, `/v1/playground/*`, `/v1/admin/*`, and `/v1/oauth/callback` before the request reaches the Worker.

## Admin reads

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/admin/bootstrap` | Coherent authority, configuration, and readiness snapshot |
| `GET` | `/v1/admin/overview` | Policy, credential, tenant, provider, and budget totals |
| `GET` | `/v1/admin/tenants` | Tenant summaries |
| `GET` | `/v1/admin/usage` | Budget rows, aggregate usage, and recent request audit |
| `GET` | `/v1/admin/content?tenant=<id>&ref=<ref>` | Retained request content from the separate archive |
| `GET` | `/v1/admin/policies` | Access policies |
| `GET` | `/v1/admin/credentials` | Issued proxy credentials without raw secrets |
| `GET` | `/v1/admin/connections` | Global provider connections and kill switches |
| `GET` | `/v1/admin/access-users` | Materialized Access users |
| `GET` | `/v1/admin/policy-bindings` | User and group policy bindings |
| `GET` | `/v1/admin/provider-status` | Policy-aware provider readiness |
| `GET` | `/v1/admin/provider-health` | Persisted provider smoke status |
| `GET` | `/v1/admin/upstream-grants` | Sanitized policy- and tenant-scoped upstream grants |
| `GET` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>` | Pure canonical credential-owner view, generation and publication state |
| `GET` | `/v1/admin/assignment-rules` | Access identity assignment rules |
| `GET` | `/v1/admin/fusion` | Fusion configuration |

## Admin mutations

| Method | Path | Purpose |
| --- | --- | --- |
| `PUT` | `/v1/admin/access-users/<email>` | Update a materialized user's tenant, status, groups, or retention exemption |
| `PUT` | `/v1/admin/access-user-grants/<email>` | Update a user and atomically replace direct policy grants |
| `PUT` | `/v1/admin/policy-bindings` | Create or update a user or group binding |
| `PUT` | `/v1/admin/policies/<policy-id>` | Create or update a policy |
| `POST` | `/v1/admin/policies/<policy-id>/revoke` | Disable a policy and every credential bound to it |
| `POST` | `/v1/admin/credentials` | Create an issued credential; reject an existing ID |
| `PUT` | `/v1/admin/credentials/<credential-id>` | Create or update an issued credential |
| `POST` | `/v1/admin/credentials/<credential-id>/rotate` | Replace only an active credential's secret hash |
| `POST` | `/v1/admin/credentials/<credential-id>/revoke` | Revoke one issued credential |
| `PUT` | `/v1/admin/connections/<provider-id>` | Update a global provider connection |
| `PATCH` | `/v1/admin/connections/<provider-id>` | Update only supplied connection fields |
| `PUT` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>` | Create or update a scoped upstream grant |
| `POST` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>` | Create only, using a caller-retained `acct_UUIDv4` reference |
| `PATCH` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>` | Update supplied metadata against the current credential generation |
| `POST` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>/replace` | Replace credential material against the current generation |
| `POST` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>/revoke` | Revoke a scoped upstream grant and remove its secrets |
| `POST` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>/refresh` | Refresh an OAuth grant |
| `POST` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>/quota-refresh` | Refresh provider-reported grant quota state |
| `POST` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>/authorize` | Begin a browser OAuth authorization |
| `POST` | `/v1/admin/pool-submission-tickets` | Issue a short-lived, one-time credential contribution ticket for one pool slot |
| `PUT` | `/v1/admin/assignment-rules/<rule-id>` | Create or update an identity assignment rule |
| `POST` | `/v1/admin/assignment-rules/reconcile` | Reconcile materialized users against assignment rules |
| `PUT` | `/v1/admin/fusion` | Update Fusion routing configuration |
| `POST` | `/v1/admin/fusion/preview` | Evaluate Fusion readiness and estimated reservations for a policy |

The legacy `GET|PUT /v1/admin/keys...`, `POST /v1/admin/keys/<kid>/revoke`, and `GET /v1/admin/users` routes remain compatibility aliases. New control-plane clients use policies, credentials, and tenants directly. Legacy top-level console and `/api/*` aliases redirect or normalize to their `/dashboard/*` and `/v1/*` equivalents.

Upstream grant PUT preserves unspecified credentials by default. Add
`?mode=replace` to replace the complete grant, clearing omitted credentials and
account or refresh metadata. Replacement requires a fresh primary credential;
credential-presence flags are insufficient. Other mode values return HTTP 400.
The `cf:oauth:put` CLI uses replacement mode.

New account-management clients use the strict routes:

- Generate and retain `acct_` plus a lowercase UUIDv4 **before** create-only POST.
  The reference is the final path segment. The server echoes it and rejects an
  existing owner, tombstone, legacy KV record or retained attachment evidence with
  HTTP 409. A duplicate POST never becomes an update. The UUID restriction applies
  to creation only; canonical older references still support GET, PATCH and replace.
- GET reads the strong owner without refreshing, importing or repairing it. It
  returns a secret-free view with `credentialGeneration` and `publication`
  (`ready` or `pending`). It omits raw credentials, refresh extra parameters,
  credential lineage and internal admission receipts. An uninitialized legacy
  account needs the existing explicit PUT replacement or revocation flow.
- PATCH and POST `/replace` require `expectedCredentialGeneration`. A mismatch,
  including one caused by automatic refresh, returns HTTP 409
  `grant_generation_changed` with the safe current view in `error.detail.grant`.
  Read and inspect that state before another mutation; do not retry automatically.
- PATCH accepts `label`, `enabled`, `priority`, `weight`, `maintenance`, `expiresAt`,
  `scopes`, `accountId`, `subscription` and `refresh`. Omission keeps the existing
  value. Null clears label, expiry, account, subscription or refresh override;
  `scopes: []` clears scopes. Booleans and numbers cannot be null. The sole secret
  operation is `refreshToken: null`, which clears that token and rotates credential
  lineage. Non-null refresh tokens, primary credentials, provider/kind changes and
  owner status fields are rejected. Metadata edits never heal reauthorization or
  revocation. Clearing `refresh` removes the override; provider refresh configuration
  can still apply. Clear the refresh token to prevent its use. Refresh `extraParams`
  accepts public extensions such as `scope` and `audience`, not credential fields or
  overrides of the owner-controlled grant type and client authentication.
- POST `/replace` requires a fresh primary credential. It clears omitted or competing
  old credential forms and old token type, expiry, scopes, account, subscription and
  refresh material. Omitted token type defaults to `Bearer`. Routing identity, label,
  priority, weight, maintenance and creation time remain unless explicitly editable
  fields are supplied. An inactive account, including a revoked one, stays inactive
  unless the replacement explicitly supplies `enabled: true`.

Strict mutations return `{ "outcome": "committed", "grant": <safe owner view> }`.
Creation returns HTTP 201 and edits return HTTP 200 when finalization completes.
HTTP 202 means the exact credential write committed, but scheduling, attachment or
KV publication still needs acknowledgement; its view has `publication: "pending"`.
An uncertain owner write returns HTTP 503 `grant_mutation_unconfirmed`, never a
claimed commit based on another row. After any lost reply, inspect the retained
identity with GET before deciding what to do next.

GET does **not** repair a pending mutation. Use **Repair account publication** in
the Upstream panel, POST `/v1/admin/grant-pools/repair` with its bounded resume cursor,
or `pnpm cf:accounts`. This also completes paused or revoked owners with no alarm.
The existing PUT/CLI adapters retain their non-2xx outcome when publication is pending.

Grant revocation accepts an optional JSON object with `kind`, `provider`, and
`label` hints for legacy grants that have no credential owner. Existing owners
ignore these hints and retain their canonical identity. Revocation stores a
secretless, disabled tombstone and cancels maintenance; an unknown grant returns
HTTP 404. Retrying revocation preserves the same tombstone generation.

Explicit replacement and revocation can recover an existing legacy KV grant with
invalid JSON or metadata larger than the 3 MiB migration limit. Corrupt or oversized
bytes are discarded, never imported into the credential owner. Supply fresh credentials
through `cf:oauth:put` or `PUT ...?mode=replace`, or use `cf:oauth:revoke` to remove
the account. Ordinary edits, OAuth callbacks, contributions, refresh and automatic
migration remain strict. A failed KV read is unavailable state, not proof of an
absent account. Recovery preserves retained pool generations; a newer index than
an existing owner requires operator recovery instead of resetting ownership.
When both the owner and KV record are missing, either PUT mode creates an account
only after confirming an empty attachment index. Retained legacy membership or
generation history returns HTTP 409, including generation-zero legacy rows.

### Credential creation, rotation, and revocation

Use `POST /v1/admin/credentials` or `POST /v1/session/credentials` with
`{ "credentialId": "my_key", "policyId": "my_policy", "secretSha256": "<64 hex characters>" }`
to create a key. IDs must contain 4–128 letters, digits, or underscores so the key
can be authenticated. Success returns `201`; an existing ID returns `409 credential_exists`
without replacing the key or pruning retained records. Admin creation also accepts
`enabled` (default `true`) and `principalId` (an email or `null`, default `null`).
Personal creation always enables the key and assigns the signed-in user as owner.

Use `POST .../credentials/<credential-id>/rotate` with only
`{ "secretSha256": "<64 hex characters>" }` to replace a key's hash. Rotation preserves
its owner, policy, generation, and enabled state. It requires an enabled key, an
enabled policy with the same generation, and an owner who is not disabled. An
inactive key returns `409 credential_inactive`; a missing key returns `404`.
Rotation cannot reactivate a revoked key or renew a revoked policy generation.

The existing `PUT .../credentials/<credential-id>` remains an upsert: it can replace
the owner or policy on an admin key, reenable a key, and bind the current policy
generation. Personal PUT keeps its existing forced-enabled, caller-owned behavior.
Use create and rotate for operations that must not overwrite an existing key or
change its authorization. Secret hashes are lowercase SHA-256 hex; responses never
include a raw secret or hash and describe the record committed by that operation.

Personal create, PUT, and rotate recheck the current enabled user, groups, bindings,
and policy at the serialized write boundary. Personal revoke requires ownership
but remains available after group, binding, or policy access is removed. Revoke
disables the latest record, preserves any intervening hash rotation, and is
idempotent for an existing key. Local administrator disable or demotion is also
rechecked before credential writes; Cloudflare administrator status comes from
the verified Access configuration. Personal keys remain limited to 10 enabled
and 100 retained records; creating another key can prune revoked records in ID
order at the retention limit. Rotation consumes no additional slot.

## Pool contribution

`POST /v1/pool-submissions/<ticket-id>/consume` accepts a ticket bearer secret
and one credential bundle. The ticket, not the request body, supplies the pool
scope, token reference, provider, grant kind, priority, and weight. Accepted
body fields are `credential`, `credentials`, `accessToken`, `refreshToken`,
`tokenType`, `expiresAt`, `scopes`, `accountId`, and bounded `subscription`
metadata. Contributor-defined refresh endpoints and OAuth client settings are
not accepted. Keep-warm follows the provider manifest default; Claude subscription
tickets default to enabled. The administrator may set `keepWarm: false` on the
ticket to opt out. Contributors cannot alter maintenance behavior in their
submission.

The route consumes the ticket once, but an identical retry can recover an
interrupted submission and returns the same receipt after completion. The
response exposes only the grant key and submission timestamp. Raw credential
material is stored in the grant's Durable Object; the KV grant record contains
only routing metadata and credential-presence flags.

## Routing and authorization behavior

Before forwarding a request, the Worker authenticates the credential, resolves its policy, checks the provider connection and scoped grant readiness, and reserves a conservative budget. Policies can select grants by priority, round robin, least used, reported remaining quota, consume-until-threshold, or weighted random choice. Threshold routing owns pool affinity; other modes may use identity or session stickiness.

Provider grants can be scoped to a policy or tenant. When several token references are eligible, ClawRouter applies the policy strategy within the active priority tier. An upstream 401, 403, or 429 records sanitized grant state and can trigger one same-provider alternate when policy allows failover.

Disable one credential to revoke one key, disable a policy to revoke every credential bound to it, or disable a provider connection to stop that provider globally. Policy and credential generations must match, so incomplete rotations and stale migration records fail closed.

## Budgets, usage, and retention

Budgeted requests reserve an upper-bound token cost before the upstream call when the selected model has versioned pricing. A policy `requestCostMicros` value is a fixed-cost override; budgeted routes without versioned pricing or an override fail closed.

Successful responses settle to reported usage, including cached input where available, or the explicit fixed policy tariff. Known-unsent work and received non-2xx responses settle at zero with `cost_basis: none`. Transport failures after dispatch, and missing or interrupted usage, retain the qualified estimate or fixed tariff because upstream work may have occurred. Streaming responses are metered without buffering the client stream.

Declared Responses JSON and SSE bodies are inspected incrementally for usage and terminal status, including fields after large output. The observer retains only bounded metadata; excessive nesting or oversized selected fields leave usage unknown and preserve the applicable estimate or fixed tariff. These inspection limits do not impose a response-size limit or change delivered bytes.

Usage events are delivered through `USAGE_QUEUE` to tenant- and policy-sharded `USAGE_LEDGER` Durable Objects. Settlement and audit delivery retry independently, and exhausted messages move to the configured usage dead-letter queue. Ledgers keep bounded identity, route, timing, outcome, token, cost, request ID, and trace metadata; they do not store prompts or completions.

Policies can retain LLM request bodies in the separate `CONTENT_ARCHIVE` R2 binding. Retention failure is fail-closed before upstream traffic. See [Request content retention](content-retention.md) for the policy and disclosure contract.

Every Worker-owned response returns the canonical `X-Request-ID`, and CORS exposes it to clients. Valid W3C trace and span IDs are preserved in usage metadata. Agent attribution headers, pricing fields, and reservation semantics are documented in [Agent spend control](agent-spend-control.md).
