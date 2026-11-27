# Managed dispatch qualification

The shared controller retains the existing scoped BackgroundStore, reservation,
idempotency and outbox. New registry entries remain source-owned. The protocol
union alone does not register a route or authorize a caller's raw job/asset ID.

## Selected credential and region

`ManagedLifecycleAdapter.assertDispatch(request)` is synchronous and pure. It
receives a copy of the prepared URL/method/headers, including the selected provider
credential. It must not refresh, perform I/O, select another account, log its
arguments or mutate the request. A thrown error or returned Promise denies egress
with a sanitized error. The create path checks before admission and dispatch;
controls check immediately before fetch in both environment and credential-owner
paths, after original-owner and current-caller authorization. Collectors and
cancel/result follow-ups use those same boundaries.

The `dashscope.video` protocol requires this hook. Its source wrapper must enforce
the native Bearer scheme and call `assertWanStandardCredential(selectedSecret,
new URL(request.url).origin)`. Canonical provider `alibaba` uses the original
regional Standard grant and `MODELSTUDIO_API_KEY`. Server aliases require explicit
qualification. Hosted Qwen is separate; no caller-secret or plan-key fallback.
A rejected selected credential does not cause pool reselection.

## Control headers and identity

`control()` may return `headers: Headers`. These headers are regenerated at every
actual control. Authentication, tenancy, replay and transport-framing headers are
rejected, including custom provider credential header names. Values and counts
are bounded; different existing configured values cannot be silently replaced
(except protocol-owned Accept, Content-Type and normalized Cancel-After).

Stable control header values join the original route digest. Thus changing
Runway's `X-Runway-Version` invalidates an old job's route. For fresh UUID-only
diagnostics, return `transientHeaders: ["ai-trace-id"]` alongside the headers.
The digest pins that header name and volatility, not a randomly generated value.
Only canonical version-4 UUID values qualify. PixVerse's source wrapper uses this
field; it must generate a new trace ID on every `control()` call.

`identityProbe` optionally supplies one valid, non-secret example ID for route
qualification. PixVerse uses a positive safe decimal ID. It is never dispatched,
persisted as a real job, or accepted as caller authority. Existing Replicate
identity and route digests retain their original shape.

## Activation boundaries

Wan, PixVerse, Runway and Together protocol names are available to shared types.
Actual registry/YAML/snapshot activation still requires the matching qualified
source contract and end-to-end runtime tests. Observation loss uses the same
immutable conservative receipt, separately from a native execution terminal.
Runway's qualified cancel/delete acknowledgement remains bodyless HTTP 204.

PixVerse image mode and uploaded media references remain closed until the
controller durably binds caller, policy, provider, region and original credential
before publishing or accepting an asset ID. Unknown uploads must not replay. No
new global job/asset index or separate settlement framework is introduced here.
