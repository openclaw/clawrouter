# GitHub Copilot account identity

`worker/provider-copilot.ts` implements the account/catalog requests, public or
enterprise identity qualification, scoped model filtering and native inference
request construction. These helpers remain inactive without common credential
materialization and dispatch integration. They do not read GitHub CLI, Git or environment
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

Catalog and inference require the same explicit `CopilotRuntimeIdentity`:

```ts
type CopilotRuntimeIdentity = Readonly<{
  ownerBinding: string;
  integrationId: string;
  editorVersion: string;
  editorPluginVersion: string;
  userAgent: string;
}>;
type CopilotInferenceContext = Readonly<{
  initiator: "user" | "agent";
  hasImages: boolean;
}>;
```

`buildCopilotRuntimeHeaders(identity, selectedOwnerBinding, runtimeIdentity)`
requires all three owner bindings to match. `copilotCatalogRequest(identity,
selectedOwnerBinding, githubToken, runtimeIdentity)` constructs `GET /models`
on the qualified account base. `prepareCopilotRequest` takes `runtimeIdentity`
and `CopilotInferenceContext` after its existing format argument. Both factories
repeat binding and origin validation and use the explicitly supplied original
GitHub token. The common owner must bind that token, account endpoint and runtime
identity to the same original grant generation; string equality is not token or
account verification.

The runtime identity is closed: no unknown fields, header bag or defaults.
Header values must be nonempty, trimmed printable ASCII of at most 512 characters;
the integration ID permits only letters, digits, dots, underscores and hyphens.
These are local input bounds, not vendor limits. An absent identity fails instead
of impersonating VSCode. Catalog and inference share the supplied editor/plugin,
user-agent and integration identity plus fixed `Accept-Encoding: identity` and
`Openai-Organization: github-copilot`. No unrelated configured headers forward.

Only inference receives common-derived `x-initiator` and, for actual image input,
`Copilot-Vision-Request: true`. The closed context does not accept caller header
overrides. Messages alone receives `anthropic-version: 2023-06-01`; the selected
stream flag chooses JSON versus SSE acceptance. Shared runtime still owns body
validation, context derivation, fresh authority, deadline/cancellation, response
and redirect rejection, replay handling and accounting. These factories perform
no fetch, token exchange, consent or refresh operation.

`copilotModelFormats` qualifies only advertised `/chat/completions`, `/responses`
and `/messages` endpoints. A Claude-like name alone is not transport evidence.
`isCopilotCatalogModelVisible` implements the frozen picker rule: literal
`model_picker_enabled: true`, excluding normalized `disabled` and `unconfigured`
policy states. `filterCopilotModels` intersects this visibility with advertised
transports and the supplied caller-policy predicate. Empty results stay empty;
there is no static-seed fallback or automatic consent. Missing or unknown policy
states remain facts, not evidence of inference entitlement. Deprecated model
facts do not imply shutdown or permit replacing a selected ID.

The request helper also rejects hidden and unconfigured rows, including manually
supplied ones. This is a conservative admission prerequisite, not a grant of
account access. The common owner must separately authorize inference against the
current original grant, model and policy before any dispatch.
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
plus [`runtime-identity.ts`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/github-copilot/runtime-identity.ts)
and [`stream.ts`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/github-copilot/stream.ts),
not an unpinned future client. Run
`node --test worker/test/provider-copilot.test.mjs` for deterministic identity,
endpoint, policy filtering and credential isolation fixtures.
