# MiniMax regional auth codecs

E09 follows frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`:
`extensions/minimax/oauth.ts`, `index.ts`, `provider-models.ts` and `thinking.ts`.
The [official MiniMax CLI](https://github.com/MiniMax-AI/cli#mmx-auth) also documents
Global/CN device authorization with PKCE and token refresh. The frozen OpenClaw
implementation defines the precise account endpoints and response fields here;
no newer CLI transport or model inventory is substituted.

## Runtime handoff

`worker/provider-minimax-oauth.ts` performs no fetch, login, browser operation or
persistence. Every request is a value for the credential owner to execute.

- `createMiniMaxDeviceSession` creates private PKCE/state material scoped to an
  opaque owner/grant-version binding. Never log or expose the returned verifier.
- `prepareMiniMaxDeviceRequest` builds the regional account POST with S256,
  public registered client ID, frozen scope and request ID.
- `decodeMiniMaxDeviceAuthorization` checks HTTP status, echoed state, absolute
  millisecond deadline and the regional HTTPS approval host. Pairing UI/consent
  must occur before `prepareMiniMaxTokenRequest` is executed. The grant uses
  `user_code`, not an invented `device_code` field.
- `miniMaxPollDelay` preserves the frozen millisecond interval and deadline clamp.
  The owner serializes polling and rechecks cancellation/current authorization
  before and after every await. These helpers do not schedule requests.
- `decodeMiniMaxTokenResponse` distinguishes pending, success and content-free
  errors, reads at most 8 KiB, and resolves relative seconds, epoch seconds or
  epoch milliseconds. Successful credentials include the original owner,
  issuing token endpoint and qualified regional resource.
- `prepareMiniMaxRefreshRequest` sends refresh secrets only to the recorded
  regional account endpoint. Missing issuer history, changed owner or changed
  resource requires reauthorization. A refresh response may omit an unrotated
  refresh token; an explicitly empty token is invalid. Refresh never changes the
  original resource binding. No fallback to another region or credential pool.
- `prepareMiniMaxAnthropicRequest` uses the admitted model and original credential
  at `/anthropic/v1/messages`. OAuth and API-key grants remain separate tagged
  identities even though both use Bearer headers. Expiring OAuth access is rejected
  before the hot path; refresh belongs to credential materialization.

## Qualified resource boundary

Global resources are pinned to `api.minimax.io`; CN uses `api.minimaxi.com` or the
frozen `api.minimax.cn` alias. Root and `/anthropic` resource paths normalize to
`/anthropic`. Query credentials, userinfo, fragments, nondefault ports, other
regions and unknown resource paths are refused. A future custom resource requires
explicit primary qualification; a returned URL alone grants no new secret egress.
Requests use manual redirects and a 30-second auth timeout. The executor must
honor those controls and reject redirects rather than forwarding credentials.

API keys, OAuth grants and subscription entitlements are not interchangeable.
These codecs do not infer plan eligibility, provision secrets, price requests,
refresh on inference dispatch or certify live account consent. Tests use only
synthetic credentials and make no upstream calls.

## Client and manifest dependencies

Existing MiniMax YAML and model rows stay with the manifest owner. Client thinking
hooks retain the frozen M3 adaptive default, M2 budget/off behavior and M3.1 Flash
or Flash Preview adaptive effort range. Their native payload patch, signed-history
preparation and real model output cap remain client-owned. The codec preserves
those supplied Anthropic fields; it does not silently replace thinking options.
Actual OAuth UI, durable grant storage/rotation/revocation and native client/router
end-to-end proof remain common-runtime/client/integration work.
