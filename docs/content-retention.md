# Request content retention

ClawRouter access policies retain authorized LLM request bodies, speech input
and image-generation input JSON for 30 days by default. This is an access condition for administrator-funded
credentials, not application logging. Provider completions, including generated
audio and images, are not retained.

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
- Authorized LLM request content, speech input and image-generation input JSON
  are written to `CONTENT_ARCHIVE` best-effort, in the background, right after the
  upstream request is dispatched. The content ref is allocated first, so usage
  events still reference it; a failed write is logged (request ID only) and does
  not fail the request, which can leave a usage row whose archive object is
  missing. Two cases keep the write before dispatch and still return
  `503 content_retention_unavailable` without calling the provider: durable
  background Responses jobs, and Claude bodies above the 8 MiB parser bound
  (their streamed archive copy must not overlap transport memory).
- R2 encrypts objects at rest. The `request-content-v1-30-days` lifecycle rule
  schedules deletion under the dedicated `v1/` archive prefix after 30 days without
  affecting unrelated bucket content. Physical deletion is asynchronous. Usage
  metadata remains separate.
- Content provisioning reads back the rule after creation, including when its ID
  already exists. Deployment stops if that rule is disabled, targets another
  prefix, or does not expire objects after 30 days. Review conflicting rules
  explicitly; provisioning does not replace them.
- Cloudflare AI Gateway universal requests retain their ordered provider queries
  and configuration, but omit each entry's entire `headers` map and `authorization` field.
  These fields can contain upstream credentials. The forwarded request is
  unchanged; the retention header still reports `on` when query content is stored.
- Admin reads deny expired archives even while their objects still exist. The
  upload time plus 30 days caps the archive deadline; a valid earlier `expiresAt`
  metadata value shortens it. Missing or invalid metadata uses the upload deadline.
- Self-hosting sweeps the `v1/` archive prefix after startup and once per minute.
  Each tick scans at most 1,000 objects (local metadata pages can be shorter),
  deletes expired objects, and checkpoints the cursor in a dedicated Durable
  Object. It resumes after restart and scans from the start again at EOF, including
  legacy archives and captures with no usage record. Large backlogs and outages
  delay physical removal; this is not an exact-at-30-days deletion guarantee.
- Cleanup logs report scanned/deleted counts for the current pass, backlog, and
  last completion time without content or archive keys. Failed ticks are visible
  and retry without advancing the cursor. Managed R2 uses its lifecycle rule;
  no Cloudflare cron is configured.
- Local R2 removes its object index before deleting backing blobs asynchronously.
  A crash in that runtime window can leave unindexed blob bytes that archive
  sweeps cannot find. This cleanup guarantees R2-visible removal after a successful
  delete, not crash-proof erasure of every backing byte or backup copy.

## Large Claude requests

When retention is enabled, the complete authorized Claude request is archived,
including **whole documents/PDFs and inline image data**, not merely extracted
text. Messages and token-counting ingress accepts up to **32,000,000 bytes**;
the R2 record also includes a small metadata envelope. Large records use a
known-length stream, not another whole-document serialization. Upload still
finishes before provider dispatch, so retaining large media adds storage cost
and admission latency. The existing 30-day expiry, user exemption and admin-only
read controls are unchanged. See [Claude JSON request limits](anthropic-request-limits.md).

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
