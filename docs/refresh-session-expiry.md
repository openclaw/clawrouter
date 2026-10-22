# Refresh/session expiry

ClawRouter preserves provider-issued `refresh_token_expires_in` on OAuth code
exchange and every refresh. It stores the absolute UTC timestamp as
`refreshTokenExpiresAt`, separately from the access token's `expiresAt`.
A finite, safe, non-negative integer number of seconds is accepted; zero means
expiry now. Missing or malformed lifetime metadata never invents a deadline.

On rotation, a missing/invalid lifetime retains the previous known absolute
refresh deadline, even if the provider returns a new refresh token. A valid
returned lifetime replaces it relative to receipt time. This follows the
observed Claude Code 2.1.286 behavior: its refresh parser does not apply the
initial-login default, and its credential writer retains `refreshTokenExpiresAt`
when omitted. This is compatibility evidence, not a universal OAuth guarantee.
A fresh OAuth authorization, explicit full replacement, or refresh-token
replacement clears an unspecified old deadline instead of assigning it to a
new login. A merge that updates only the access token retains the existing
refresh token and its dates.

`lastManualAuthorizationAt` records a successful interactive OAuth exchange,
or a supplied original authorization date on import. Automatic refresh never
changes it. Existing grants and imports without that fact remain unknown;
creation time is not substituted. Replacing refresh authority without a supplied
manual date clears the prior login's date. Metadata-only edits preserve both
owner-held dates, without copying stale KV dates back into the owner.

## Import

The admin grant PUT and pool-submission APIs accept `refreshTokenExpiresAt` and
`lastManualAuthorizationAt` as ISO-8601 timestamps or epoch milliseconds (the
format of Claude Code's `refreshTokenExpiresAt`). Submit these fields alongside
the credential fields; the entire nested `claudeAiOauth` document is not an API
payload. Do not copy a login still rotated by another client: use a dedicated
login for the server. Import time is not manual authorization time.

`oauth-put.mjs` and `pool-contribute.mjs` accept `--refresh-token-expires-at` and
`--last-manual-authorization-at` ISO timestamps. These are nonsecret metadata;
continue supplying token material through the existing protected inputs.
Omit unknown values. Admin responses contain canonical timestamps or `null`,
never the tokens. No raw provider response or error description is retained.

## Dashboard only

The admin response exposes `refreshExpiryWarning`: `unknown`, `none`, `warning`
(at most 3 days), `critical` (at most 12 hours), or `expired` (deadline reached).
Warnings are computed at read time, not stored snapshots that age silently.
Subscription cards and the Access inspector show the deadline and manual date.
The main dashboard groups upcoming deadlines by enabled policy pool, including
when another grant or paid fallback is healthy. Failed access reads display
unavailable/stale health. The console's existing periodic refresh updates dates;
no provider I/O or extra maintenance alarm is needed to generate warnings.

Renew from a fresh dedicated login before the deadline. The warning does not
revoke, disable, or change routing eligibility by itself. Setup/access-only
tokens have no refresh lifetime and do not receive these warnings. Unknown
lifetimes receive no invented 28/30-day warning: peer observations are not a
provider contract. See [better-ccflare #461](https://github.com/tombii/better-ccflare/pull/461)
and [Claude Code login renewal](https://code.claude.com/docs/en/authentication#renew-an-expiring-login)
for context, not a guaranteed session length.

Keep-warm inference does not extend a fixed session lifetime. This change adds
no inference pings, external notifications, OAuth owner enforcement, refresh
outcome taxonomy, or retry/backoff policy. Those are separate follow-ups.
