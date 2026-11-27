# Copilot device-code codec boundary

`worker/provider-copilot-device.ts` supplies four pure, inactive helpers. It does
not perform HTTP, open a login page, acquire consent or install credentials.
The protocol is frozen to OpenClaw
[`login.ts`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/github-copilot/login.ts).
Existing account discovery and runtime headers remain in `provider-copilot.ts`.

- `prepareCopilotDeviceRequest(context, currentOwner)` returns the fixed device
  POST descriptor, public client ID `Iv1.b507a08c87ecfe98` and `read:user` scope.
- `decodeCopilotDeviceAuthorization(text, status, context, currentOwner)` returns
  the bound device/user codes, canonical verification URL, relative expiry and
  initial polling interval. Invalid responses throw content-free errors.
- `prepareCopilotDevicePollRequest(authorization, currentOwner)` returns the
  selected-domain token POST with the original device code and device-code grant.
- `decodeCopilotDevicePoll(text, status, authorization, currentOwner, intervalMs)`
  returns authorized, pending, expired, access-denied or a closed terminal error.
  It never echoes provider errors. Invalid owner/state inputs throw before decode.

The closed context is `{ githubDomain, ownerBinding }`. Reused
`copilotGithubDomain` allows public `github.com` or one selected `*.ghe.com`
tenant. Every helper repeats domain and owner checks. The common credential owner
must derive and persist this pair from the original private attempt and current
grant generation; equality checks cannot authenticate an arbitrary supplied
object. Domain changes require a new authorized attempt, never a public fallback.
The authorization retains that pair and exposes only canonical
`https://<selected-domain>/login/device`, dropping query/fragment data and rejecting
credentials, foreign hosts, alternate paths or nondefault ports.

Request descriptors use manual redirects, form encoding and a 30-second request
timeout. That timeout is not the device lifetime. Both TEXT decoders check actual
UTF-8 byte length before JSON parsing, bounded to 8 KiB. This is an operational
cap, not a vendor limit. The future common transport must independently enforce
the wire cap, fatal UTF-8, at most 8192 reads **including empty chunks**, redirect
rejection, original cancellation and cleanup. These pure tests do not qualify
that transport reader.

Expiry must be a positive safe duration supplied upstream; there is no fallback
lifetime or fabricated absolute date. The initial interval defaults to 5 seconds
only when absent and has a 1-second floor. The FIRST poll must wait that interval.
Pending preserves the current interval. Each slow-down adds 5 seconds, saturating
at the safe-integer bound; a valid provider interval can raise it further, never
lower it. Unknown, malformed, contradictory and non-2xx results are terminal.
The common owner must persist the returned interval, bound each timer to remaining
monotonic lifetime and supported timer windows, and enforce the schedule before
every physical poll. A returned request descriptor grants no permission to poll.

Successful decoding returns the exact original GitHub access token. It invents
neither refresh behavior nor token expiry, and does not turn scope or picker
visibility into inference entitlement. The common owner still owns private
durable attempt state, account/actor authorization, deletion and cancellation
fences, expiry at dispatch and publication, single-attempt uncertain-exchange
handling, and atomic token installation against the original generation. Admin
or repository authentication is not provider account consent.

Run `node --test worker/test/provider-copilot-device.test.mjs` for pure form,
domain/owner, response-size, polling-result and original-token fixtures. No live
account, onboarding route, provider entitlement or end-to-end parity is claimed.
