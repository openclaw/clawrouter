# Request content retention

ClawRouter access policies retain authorized LLM request bodies for 30 days by
default. This is an access condition for administrator-funded credentials, not
application logging. Provider completions are not retained.

The locked FakeCo staging profile overrides the environment default to off.
New or migrated FakeCo policies without an explicit setting therefore remain
metadata-only; request retention requires an explicit policy opt-in.

## Contract

- Policy field: `retainRequestContent` (default `true`).
- User field: `contentRetentionDisabled` (default `false`). A user exemption wins
  across Cloudflare Access and every proxy credential whose `principalId` is that
  user's email.
- Credentials should identify their owner with `principalId`. Legacy unowned
  credentials follow the policy setting and cannot use a per-user exemption.
- Authorized LLM request content is written to `CONTENT_ARCHIVE` after access and
  budget checks, immediately before the upstream request. If required storage is
  unavailable, ClawRouter returns `503 content_retention_unavailable` and does not
  call the provider.
- R2 encrypts objects at rest. The `request-content-v1-30-days` lifecycle rule
  schedules deletion under the dedicated `v1/` archive prefix after 30 days without
  affecting unrelated bucket content. Physical deletion is asynchronous. Usage
  metadata remains separate.
- Cloudflare AI Gateway universal requests retain their ordered provider queries
  and configuration, but omit each entry's entire `headers` map and `authorization` field.
  These fields can contain upstream credentials. The forwarded request is
  unchanged; the retention header still reports `on` when query content is stored.
- Admin reads deny expired archives even while their objects still exist. Local
  self-host storage does not yet delete expired archive objects automatically;
  denying reads does not remove those persisted bytes.

## Disclosure

The console header shows `retention on · 30d` or `retention off`. Proxy-key users
can inspect `GET /v1/me`. Every proxied response also includes:

```text
x-clawrouter-content-retention: on; retention-days=30
```

or `off`. Browsers may read this header through CORS.

## Administration

Admins configure retention in Access → Policies and exemptions in Users. The Usage
screen marks events whose request content was retained and can load the archived
body through its server-generated, collision-resistant content reference. Admin
content reads require administrator authorization and return `Cache-Control: no-store`.
Only v1 records matching the requested tenant and reference with a finite, future
expiry are readable. Missing, expired, malformed, or mismatched records return the
same `404 content_not_found` response with no archived content and the same cache
protection. Storage failures remain server errors.

Do not copy archived bodies into logs, screenshots, issue reports, usage events, or
other analytics systems.
