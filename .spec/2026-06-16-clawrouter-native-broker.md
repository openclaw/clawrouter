# ClawRouter Native Broker Spec

Status: implementation target

## Purpose

ClawRouter is the credential broker and policy-enforced transport for OpenClaw
provider traffic.

Users keep canonical provider and model identities such as
`anthropic/claude-opus-*`, `openai/gpt-*`, and `google/gemini-*`. OpenClaw
authenticates once to ClawRouter instead of storing every upstream provider key.
ClawRouter selects an allowed upstream connection, injects its credential, and
forwards the provider-native request without changing its wire contract.

This phase implements the ClawRouter side only. Changes to `openclaw/openclaw`
and the OpenClaw ClawRouter plugin are explicitly out of scope.

## Product Contract

A maintainer must be able to:

1. Authenticate to ClawRouter using a scoped machine credential or a verified
   Cloudflare Access session.
2. Discover the providers, models, routes, and upstream connection types they
   are entitled to use.
3. Send a native provider request through ClawRouter without possessing the
   upstream provider credential.
4. Receive the upstream status, body, stream, and safe headers without
   ClawRouter normalizing or reserializing the payload.
5. Use an API-key, OAuth, or subscription-backed upstream connection selected
   by policy.
6. Have access revoked immediately through the existing policy and credential
   authority.

An administrator must be able to:

1. Register, inspect, disable, and revoke named upstream grants.
2. Scope grants to a policy or tenant.
3. Distinguish API-key, OAuth, and subscription-backed grants without exposing
   their secrets.
4. See which transport routes and grants make a provider executable.
5. Start and complete provider-approved browser OAuth flows without manually
   handling access or refresh tokens.

## Security Boundaries

- OpenClaw never receives an upstream provider secret, OAuth access token,
  refresh token, or subscription credential.
- ClawRouter client authentication and upstream provider authentication are
  separate credentials.
- The native broker is manifest-allowlisted. It is not an unrestricted forward
  proxy.
- Incoming provider auth headers and cookies are never forwarded upstream.
- Hop-by-hop and Cloudflare Access headers are never forwarded upstream.
- Upstream response cookies and unsafe hop-by-hop headers are never returned.
- Request and response bodies are never logged.
- Policy authorization, provider connection state, and budget preflight happen
  before the upstream request.
- Revocation and budget checks remain on the authoritative data-plane path.

## Public Data-Plane API

### Native provider transport

```text
<METHOD> /v1/native/<provider>/<provider-native-path>
```

Examples:

```text
POST /v1/native/anthropic/v1/messages
POST /v1/native/openai/v1/responses
POST /v1/native/google-gemini/v1beta/models/gemini-2.5-pro:generateContent
GET  /v1/native/replicate/v1/predictions/<id>
```

The provider-native path must match an endpoint declared by that provider's
manifest. Endpoint path parameters use the existing safe segment and safe
relative-path validation.

The native route:

1. Resolves the provider and manifest endpoint from method and path.
2. Authorizes the ClawRouter caller for that provider.
3. Selects the caller's policy-scoped or tenant-scoped upstream grant.
4. Preserves the original query string.
5. Preserves the original request body bytes.
6. Copies only manifest-declared safe request headers.
7. Removes incoming provider authorization and injects the selected upstream
   grant.
8. Preserves the upstream response body/stream and status.
9. Copies only safe response headers.
10. Emits the existing audit, usage, and budget events.

The route accepts both:

- ClawRouter proxy credentials in `Authorization: Bearer clawrouter-*`.
- Verified Cloudflare Access sessions when the request is not browser-only and
  the application token is valid.

Access-session support must not reuse the playground CSRF exception. The
playground remains a browser surface; `/v1/native/*` is a client API surface.

### Discovery

```text
GET /v1/models
GET /v1/catalog
```

`/v1/models` returns the OpenAI-compatible model-list shape and only includes
models allowed by the caller's effective policies.

`/v1/catalog` returns the richer ClawRouter contract:

```json
{
  "providers": [
    {
      "id": "anthropic",
      "allowed": true,
      "executable": true,
      "nativeBaseUrl": "/v1/native/anthropic",
      "routes": [
        {
          "endpoint": "messages",
          "methods": ["POST"],
          "path": "/v1/messages",
          "streaming": "sse"
        }
      ],
      "models": [],
      "connectionTypes": ["api_key", "oauth", "subscription"],
      "reasons": []
    }
  ]
}
```

Discovery responses are private to the authenticated caller. They may use
private caching and `ETag`, but must never be shared across policies or users.

## Provider Manifest Contract

Provider manifests remain the authority for executable upstream paths.

Each existing endpoint is automatically eligible for native proxying when:

- its method is declared;
- its path template is valid;
- its auth scheme is executable; and
- its runtime base URL/config placeholders are resolvable.

New optional endpoint fields:

```yaml
endpoints:
  responses:
    path: /v1/responses
    methods: [POST]
    nativeProxy: true
    requestHeaders: [OpenAI-Organization, OpenAI-Project]
    responseHeaders: [content-type, request-id, x-request-id]
```

Defaults:

- `nativeProxy: true`
- request headers inherit `adapter.passthroughHeaders`
- safe response headers include content type, content encoding, cache metadata,
  retry metadata, rate-limit metadata, and request-id metadata

An endpoint may set `nativeProxy: false` when its provider-native contract
cannot safely be brokered.

## Wire Preservation

Native transport is intentionally separate from the normalized OpenAI and
manifest-wrapper routes.

Native transport must not:

- parse or serialize a JSON body;
- rename fields;
- rewrite a model identifier;
- wrap a request body;
- convert a multipart body;
- buffer or parse an SSE response;
- reinterpret an upstream error response.

Native transport may:

- buffer request bytes when required by the Cloudflare Worker runtime;
- replace upstream auth;
- apply manifest-declared static headers and query parameters;
- perform SigV4 signing;
- add ClawRouter trace/audit headers;
- remove unsafe headers;
- clone a small JSON response only for usage extraction when doing so does not
  alter the returned response.

Conformance fixtures must prove exact request-body preservation for:

- JSON with unknown fields and non-canonical whitespace;
- multipart/binary bodies;
- empty GET/HEAD bodies;
- SSE/streaming responses;
- upstream JSON and non-JSON errors.

## Upstream Grant Model

The existing `oauth/<policy-or-tenant>/<tokenRef>` records become versioned
upstream grant records while retaining compatibility with legacy access-token
records.

Canonical record:

```json
{
  "version": 1,
  "enabled": true,
  "kind": "oauth",
  "provider": "openai",
  "label": "maintainer subscription",
  "credentials": {
    "providerSpecificField": "<secret>"
  },
  "tokenType": "Bearer",
  "accessToken": "<secret>",
  "refreshToken": "<secret>",
  "expiresAt": "2026-06-16T12:00:00Z",
  "scopes": ["..."],
  "accountId": "redacted-stable-identifier",
  "subscription": {
    "plan": "plus",
    "subject": "redacted-stable-identifier"
  },
  "refresh": {
    "tokenUrl": "https://provider.example/oauth/token",
    "clientIdConfig": "PROVIDER_OAUTH_CLIENT_ID",
    "clientSecretConfig": "PROVIDER_OAUTH_CLIENT_SECRET",
    "extraParams": {}
  },
  "createdAt": "2026-06-16T00:00:00Z",
  "updatedAt": "2026-06-16T00:00:00Z"
}
```

Supported kinds:

- `api_key`
- `oauth`
- `subscription`

`subscription` means that the credential was acquired through a user
subscription flow. It does not bypass provider terms or imply that every
subscription transport can be safely proxied.

`credentials` is an optional opaque, write-only credential bundle for auth
schemes that require multiple fields. ClawRouter interprets only fields
declared by the provider auth scheme. For SigV4, the canonical fields are
`accessKeyId`, `secretAccessKey`, and optional `sessionToken`.

Legacy records containing only `accessToken`, `access_token`, or a raw token
remain readable.

### Browser authorization

A provider may declare a standard browser authorization flow:

```yaml
auth:
  authorization:
    authorizeUrl: https://provider.example/oauth/authorize
    tokenUrl: https://provider.example/oauth/token
    clientId: public-client-id
    scopes: [openid, profile, offline_access]
    grantKind: subscription
    extraAuthorizeParams:
      originator: clawrouter
    accountIdJsonPointer: /provider/account_id
```

ClawRouter accepts only authorization and token endpoints, client bindings,
scopes, extra parameters, grant kind, and JWT metadata pointers approved by the
provider manifest. It never accepts those values from an admin request.

The browser flow:

1. Requires a verified Cloudflare Access admin session.
2. Generates a high-entropy state and PKCE verifier.
3. Stores the state, verifier, initiating admin, target grant key, provider,
   redirect URI, and expiry in the authoritative Access Control Durable Object.
4. Returns a provider authorization URL containing the one-time state and
   `S256` PKCE challenge.
5. Requires the same verified Access admin on callback.
6. Atomically consumes the state before exchanging the authorization code.
7. Exchanges the code only at the manifest-approved token URL.
8. Persists the resulting canonical upstream grant and redirects back to the
   upstream-grant admin surface.

Authorization state expires after ten minutes. State values and PKCE verifiers
are never written to KV, logs, or admin responses after the authorization URL
is created.

### Grant selection

Selection order:

1. policy-scoped explicit token reference;
2. policy-scoped provider/OAuth-provider grant;
3. tenant-scoped explicit token reference;
4. tenant-scoped provider/OAuth-provider grant.

The first enabled, usable grant wins. A policy-scoped revoked or invalid grant
fails closed and must not silently fall through to a personal or broader tenant
grant.

### Refresh

When an OAuth/subscription grant is expired or within the refresh window:

1. Resolve the manifest-approved token URL and client config bindings.
2. Exchange the refresh token using the standard OAuth refresh-token grant.
3. Persist the rotated access token, refresh token, and expiry.
4. Retry the upstream authorization step once.

Refresh requests must never accept an arbitrary token URL supplied by a client.
Provider-specific non-standard refresh flows require an explicit adapter.

## Control-Plane API

New admin endpoints:

```text
GET    /v1/admin/upstream-grants
PUT    /v1/admin/upstream-grants/<scope>/<scope-id>/<token-ref>
POST   /v1/admin/upstream-grants/<scope>/<scope-id>/<token-ref>/authorize
POST   /v1/admin/upstream-grants/<scope>/<scope-id>/<token-ref>/revoke
POST   /v1/admin/upstream-grants/<scope>/<scope-id>/<token-ref>/refresh
GET    /v1/oauth/callback
```

`scope` is `policies` or `tenants`.

List/read responses return metadata only. They must never include access tokens,
refresh tokens, API keys, or client secrets.

Mutation bodies may contain secrets, but errors, logs, audit records, and
responses must not echo them.

The existing `cf:oauth:put` and `cf:oauth:revoke` scripts remain compatibility
tools and are updated to write the canonical record.

## Cloudflare Access And Auto Assignment

ClawRouter already creates a first-login Access user as enabled `user` with no
groups or grants. That fail-closed behavior remains.

Assignment reconciliation is a separate control-plane concern:

- exact email -> group/policy;
- verified email domain -> group/policy;
- GitHub organization/team -> group/policy.

Rules must carry provenance, priority, and revoke-on-membership-loss behavior.
Reconciliation runs on login and asynchronously/scheduled, never on every
provider request.

This spec reserves:

```text
GET /v1/admin/assignment-rules
PUT /v1/admin/assignment-rules/<rule-id>
POST /v1/admin/assignment-rules/reconcile
```

The native broker and grant lifecycle must not depend on assignment-rule
implementation.

## Compatibility

The following existing surfaces remain supported:

- `/v1/chat/completions`
- `/v1/responses`
- `/v1/embeddings`
- `/v1/proxy/<provider>/<endpoint>`
- `/v1/playground/*`
- legacy OAuth grant records and scripts

They may internally reuse the new grant parser and selection logic. They do not
become wire-preserving routes.

## Delivery Order

1. Add this specification and executable manifest metadata.
2. Add native route matching and byte-preserving request/response transport.
3. Add authenticated entitlement-filtered `/v1/models` and `/v1/catalog`.
4. Add canonical upstream-grant records and metadata-only admin APIs.
5. Add standard OAuth refresh and subscription metadata support.
6. Add one-time browser OAuth authorization and callback handling.
7. Add opaque multi-field credential bundles for provider auth schemes such as
   SigV4.
8. Update scripts, docs, smoke coverage, and admin readiness.
9. Add assignment-rule reconciliation in a later isolated change.
10. Implement OpenClaw core/plugin integration after the ClawRouter contract is
   deployed and proven.

## Acceptance Criteria

- A caller allowed for Anthropic can send a native `/v1/messages` request
  through `/v1/native/anthropic/v1/messages` without an Anthropic key.
- A caller denied for Anthropic receives `provider_not_allowed` before any
  upstream request.
- Unknown provider-native paths and methods fail closed.
- Native transport preserves request body bytes and upstream response status and
  body bytes.
- Incoming provider auth and cookies never reach the upstream.
- API-key, OAuth, and subscription grant metadata are represented and listed
  without returning secrets.
- Expiring standard OAuth grants can refresh through manifest-approved
  configuration.
- Browser OAuth uses a one-time, expiring, admin-bound PKCE state and persists
  a canonical grant without exposing tokens to the browser.
- SigV4 requests can use policy- or tenant-scoped multi-field credential
  bundles without requiring Worker-global AWS credentials.
- `/v1/models` and `/v1/catalog` show only caller-entitled providers/models.
- Existing normalized and manifest-wrapper routes remain compatible.
- Focused Rust, manifest, script, and deployed smoke tests cover the new
  contract.
