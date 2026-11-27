# Preprovisioned MiniMax Messages credentials

MiniMax Messages accepts only an explicitly qualified, original credential owner.
Legacy grants, generic OAuth metadata, environment keys, subscription credentials
and native speech permission do not authorize this route. This foundation does
not add provider declarations, account onboarding or live consent.

An authorized administrator may include `minimaxAnthropicAuthorization` in the
existing upstream-grant PUT. The object has exactly these fields:

```json
{
  "version": "clawrouter.minimax-anthropic.v1",
  "kind": "oauth",
  "region": "global",
  "issuer": "https://account.minimax.io",
  "tokenEndpoint": "https://account.minimax.io/oauth2/token",
  "resource": "https://api.minimax.io/anthropic"
}
```

This is an explicit operator attestation of already provisioned credential
provenance. The server does not infer issuer history or perform authorization.
For `cn`, the issuer is `https://account.minimaxi.com` and its token endpoint is
`/oauth2/token`. The canonical resource is `https://api.minimaxi.com/anthropic`.
OAuth may explicitly bind `https://api.minimax.cn/anthropic` instead. The existing
API-key codec supports only each region's canonical resource; a CN alias API-key
binding is rejected rather than treated as OAuth.

`kind: api_key` requires the sole scalar `credential` slot. `kind: oauth` requires
the sole `accessToken`/`refreshToken` pair plus an absolute `expiresAt`. Bundled or
mixed credential sources, subscription metadata and generic refresh overrides
are rejected. The binding's kind must equal the owner kind. Its token endpoint
records regional provenance for API keys; it does not authorize refreshing them.

Omission preserves an existing attestation only for the same actual owner,
credential, account and lineage. Explicit `null` removes it. Replacement needs a
new attestation. Legacy import, OAuth completion and pool metadata cannot create
or inherit one. Owner materialization and routing projection explicitly overwrite
unqualified caller metadata with `null`. The admin response contains the
secret-free normalized binding.

The runtime accepts the registered MiniMax `llm.chat` endpoint with paired
`anthropic.messages`, POST `/anthropic/v1/messages`, and an explicitly eligible
registered model. The caller route stays stable; only the validated original
owner selects the regional resource. Query, transport, URL, credential and model
passthrough overrides remain closed. Native preparation runs before serialization
and fixes the original credential, model and native API headers.

Expiring OAuth credentials refresh inside the existing durable owner, including
materialization and scheduled maintenance. The native request uses the attested
regional token endpoint. Existing token ownership, durable attempt markers and
generation checks fence rotation. Native status, `expired_in` and unchanged
resource are required; an omitted refresh token preserves the original, while an
empty token fails. Incomplete, rejected or unpersisted native refresh results
retain uncertainty and cannot replay the old token. There is no out-of-owner
refresh or inference retry/fallback path.

After budget and retention awaits, fresh caller/policy authorization precedes a
final credential-owner inspection. The selected generation, lineage, binding and
expiry must still match; caches cannot replace this check. This guarantees
freshness at the check, not instantaneous revocation between its reply and fetch.
Existing unknown-dollar admission and separately labeled fixed-policy accounting
remain in force. No rate or invoice is inferred from credential qualification.
