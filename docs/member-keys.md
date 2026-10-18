# Member keys

Members of the OpenClaw GitHub organization sign in at `/dashboard` through
Cloudflare Access and create their own ClawRouter key under **My keys**. The
secret is displayed once. Store it securely; the dashboard cannot retrieve it.
Upstream provider keys remain on the router.

## Operator rollout

Deploy the separate catalog change adding `openai/gpt-6.1-sol` **before** applying
member provisioning. The script deliberately keeps that default model and the
admin API rejects it if it is not in the deployed catalog.

Set `CLAWROUTER_URL` to the router's HTTPS origin and provide
`CLAWROUTER_ADMIN_TOKEN` through the operator's approved secret environment.
Preview without making network requests:

```sh
pnpm cf:members -- --dry-run --weekly-usd 5000
```

The default assignment rule ID is `github_org_openclaw`, matching the existing
letters, digits, and underscores contract for assignment IDs.

Inspect the planned policy and assignment requests. After the catalog and this
Worker version are deployed, explicitly use `--apply` to upsert them. Repeating
an identical apply makes no writes. `--policy-id`, `--rule-id`, `--github-org`,
repeatable `--model`, `--weekly-usd`, optional `--daily-usd` / `--monthly-usd`, and `--hint` customize the member setup.
The default hint directs heavy users to the OpenClaw team server without a
personal cap. The script does not create keys or change Access configuration.

`--team-server` also prepares an unbudgeted `team_server` policy. It allows
Ultrafast only on `openai/gpt-6.1-sol`; other models, including
`openai/gpt-6-astra`, retain Default, Flex and Fast. Attach a team-server key
separately with the console or existing `cf:key:put` flow. Do not assign the
team policy to the general members group.

The default `member_weekly` policy allows OpenAI `openai/gpt-6.1-sol`, a $5,000 weekly allowance
per signed-in principal, Default/Flex/Fast, and no request-content retention.
Every key for that principal under that policy shares the allowance. An optional
daily or monthly cap is enforced independently; neither is configured by default.
Weeks follow ISO week numbering and reset Monday at 00:00 UTC.

### Patch existing team and Stable policies

To preserve an existing policy's budget, routing, providers, models, and other
settings, use the repeatable `--ultrafast-policy` option. The intended targets
are the team server policy (normally `team_server`) and `openclaw_stable`:

```sh
pnpm cf:members -- --ultrafast-policy team_server --ultrafast-policy openclaw_stable
# After reviewing the preview:
pnpm cf:members -- --ultrafast-policy team_server --ultrafast-policy openclaw_stable --apply
```

This mode reads the admin API even for a dry run and requires the URL and token.
It does not provision the member policy or assignment rule. It sets only the
`openai/gpt-6.1-sol` model override to Default/Flex/Fast/Ultrafast, preserving
every other policy field and all other tier entries. If tier configuration is
absent, the global default remains Default/Flex/Fast. In particular, it never
adds Ultrafast to `openai/gpt-6-astra`. Repeated apply makes no further writes;
a missing target fails before any write.

## Client setup and limits

Choose 30, 90, or 180 days in **My keys**, then create the key. Fast is selected
by default; clear it to restrict this key to slower tiers. Ultrafast appears only
when the policy grants it, starts unchecked, and names its permitted models.
Key options can narrow the policy's permissions. An API request cannot override
the effective tier or model allowlist.

Configure an OpenAI-compatible client with the router URL and personal key:

```sh
export OPENAI_BASE_URL="https://router.example/v1"
export OPENAI_API_KEY="<your-personal-clawrouter-key>"
```

Set the client's model to `openai/gpt-6.1-sol`. For clients with an explicit API
base setting, use the same `/v1` URL. Dashboard displays each configured allowance,
including outstanding reservations, the reset time, and the policy's steering
message. A 402 daily/weekly/monthly refusal or a tier/model refusal includes that hint.
For sustained usage, use the OpenClaw team server.

## Renewal and legacy keys

Keys normally expire after 180 days. The list warns below 14 days. **Renew**
rotates the secret and resets its lifetime; it also works after expiry as long
as the credential, owner and policy are enabled and the policy is still held.
Replace the key in every client immediately; the previous secret stops working.
Dispatched requests finish, but new requests, WebSocket turns, background
creations and continuations fail with 401 `proxy_key_expired` after expiry.

Operators may set `CLAWROUTER_CREDENTIAL_DEFAULT_TTL_DAYS` (default 180) and
`CLAWROUTER_CREDENTIAL_MAX_TTL_DAYS` (default 366). Personal maximum lifetime
is the smaller value. The console's fixed choices must fit that configured cap;
out-of-range selections are rejected by the API. Admin-created keys also
receive the default, while an explicit admin expiry may extend to the maximum.

Existing credentials without expiry remain valid until an operator stamps one.
Use Access → Credentials → Set expiry, or
`PUT /v1/admin/credentials/<id>` with the existing `policyId` and a future UTC
`expiresAt`, for example `2027-01-01T00:00:00Z`. Omit `secretSha256` to preserve
the existing secret. Supply the existing owner and tier restrictions when using
PUT; the console preserves them. An admin PUT omitting expiry preserves the
stored expiry, including a legacy null. New IDs always require a secret hash
and get a finite expiry. Null cannot be used to clear an expiry.
