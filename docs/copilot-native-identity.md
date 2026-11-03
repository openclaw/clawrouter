# GitHub Copilot account identity

`worker/provider-copilot.ts` implements the account-discovery request, public or
enterprise identity qualification, scoped model filtering and native inference
request construction. It does not read ambient GitHub CLI, Git or environment
credentials. Supply the selected Copilot grant's credential explicitly; ordinary
repository authentication is unrelated.

The frozen OpenClaw client resolves `GET /copilot_internal/user` on
`api.github.com` or the selected `api.<tenant>.ghe.com`. It then sends the original
GitHub token to the qualified CAPI endpoint. Do not reintroduce the retired
`/v2/token` exchange. The codec pins HTTPS product/tenant origins and manual
redirect handling. An invalid enterprise domain fails rather than silently
falling back to the public account.

Shared credential-owner integration must perform bounded account/model discovery,
bind the result to grant identity and version, and apply normal revocation and
cache staleness limits. `ownerBinding` is that owner's opaque identity/version
binding. It is not an account claim decoded from an unverified token. Discovery
must not add a foreground backend call to warm inference.

`copilotModelFormats` qualifies only advertised `/chat/completions`, `/responses`
and `/messages` endpoints. A Claude-like name alone is not transport evidence.
`prepareCopilotRequest` binds the selected model and identity. The shared runtime
owns caller policy, native format validation, tool/reasoning replay, continuation
ownership, usage observation and settlement. A subscription allowance is not a
zero-dollar tariff; keep premium-request and dollar accounting distinct.

No device login, OAuth app, account-policy change, token provisioning or hosted
SDK runtime is installed here. OAuth acquisition and organization installation
tokens have separate identity contracts. This source slice does not certify
account access, model availability, native SDK sessions or end-to-end parity.

Primary authentication reference:
[GitHub Copilot authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate).
Protocol compatibility is pinned to OpenClaw
[`runtime-auth.ts`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/github-copilot/runtime-auth.ts)
and [`models.ts`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/github-copilot/models.ts),
not an unpinned future client. Run
`node --test worker/test/provider-copilot.test.mjs` for deterministic identity,
endpoint, policy filtering and credential isolation fixtures.
