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
| `GET` | `/v1/models` | OpenAI-style model list scoped to the proxy credential |
| `GET` | `/v1/catalog` | Executable providers, models, formats, and transports scoped to the proxy credential |
| `GET` | `/v1/me` | Proxy-credential identity and policy summary |
| `GET` | `/v1/usage` | Caller policy or principal budget and usage summary |
| `GET` | `/v1/key/inspect` | Proxy-credential verification and readiness status |

`GET /v1/catalog` is the client integration contract. Each provider row reports whether the unified OpenAI-compatible route is executable, its native proxy base URL, and the request and response formats for executable native routes.

`/v1/models` and `/v1/catalog` use the same executable model projection. It applies the selected policy, provider budget, grant eligibility and cooldown, and endpoint requirements without selecting or refreshing credentials. A configured but unavailable grant pool never falls back to an environment credential. Token counting retains its zero-cost exemption; Fusion discovery still uses its separate readiness projection.

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

## WebSocket contract

Send authenticated upgrades to `/v1/responses` or
`/v1/native/openai/v1/responses`. Unified upgrades select their model on the first
`response.create`, so an HTTP 101 alone does not prove model access or upstream
readiness. Every create rechecks credential, policy, provider, grant, retention,
and budget before dispatch. The connection pins its provider route and grant
revision; changing either requires a new connection.

The bridge forwards native response IDs, errors, metadata, tool results,
`previous_response_id`, and `stream_options`. Prewarm `generate: false` requests
receive normal admission and accounting. It never replays requests or switches
grants after dispatch. A terminal response with usable usage settles once;
disconnects and deadlines without final usage retain the reservation. If budget
settlement and its durable recovery both fail, or usage publication fails, the
socket reports `accounting_unavailable` and closes before accepting more work.

Limits per connection are 16 active responses, 32 named lanes plus the default
lane, 48 buffered creates, 4 MiB per incoming frame, 8 MiB total buffered create
bytes, and 16 MiB cumulative downstream output. The output limit bounds a slow
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
| `PUT` | `/v1/session/credentials/<credential-id>` | Create or rotate a caller-owned credential |
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
| `PUT` | `/v1/admin/credentials/<credential-id>` | Create or update an issued credential |
| `POST` | `/v1/admin/credentials/<credential-id>/revoke` | Revoke one issued credential |
| `PUT` | `/v1/admin/connections/<provider-id>` | Update a global provider connection |
| `PUT` | `/v1/admin/upstream-grants/<policies\|tenants>/<scope-id>/<token-ref>` | Create or update a scoped upstream grant |
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

Successful responses settle to reported usage, including cached input where available. Non-2xx and transport failures refund the reservation. Missing or interrupted usage remains charged at the conservative reservation. Streaming responses are metered without buffering the client stream.

Usage events are delivered through `USAGE_QUEUE` to tenant- and policy-sharded `USAGE_LEDGER` Durable Objects. Settlement and audit delivery retry independently, and exhausted messages move to the configured usage dead-letter queue. Ledgers keep bounded identity, route, timing, outcome, token, cost, request ID, and trace metadata; they do not store prompts or completions.

Policies can retain LLM request bodies in the separate `CONTENT_ARCHIVE` R2 binding. Retention failure is fail-closed before upstream traffic. See [Request content retention](content-retention.md) for the policy and disclosure contract.

Every Worker-owned response returns the canonical `X-Request-ID`, and CORS exposes it to clients. Valid W3C trace and span IDs are preserved in usage metadata. Agent attribution headers, pricing fields, and reservation semantics are documented in [Agent spend control](agent-spend-control.md).
