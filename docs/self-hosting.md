# Self-hosting ClawRouter with Docker

This profile runs the stock ClawRouter Worker on Cloudflare's open-source
workerd runtime. It uses Wrangler's local implementations of Durable Objects,
KV, queues, and R2. Durable Objects, KV, and R2 use filesystem persistence;
the local queue broker is memory-only. No Cloudflare account or Cloudflare
network connection is involved.

## Quickstart

Requirements: Docker with Compose, Node.js 24, and OpenSSL.

Generate an admin bearer token, retain the raw value in your secret manager,
and write only its SHA-256 digest to the container environment:

```sh
read -r CLAWROUTER_ADMIN_TOKEN < <(openssl rand -hex 32)
export CLAWROUTER_ADMIN_TOKEN
export CLAWROUTER_ADMIN_TOKEN_SHA256="$(printf '%s' "$CLAWROUTER_ADMIN_TOKEN" | openssl dgst -sha256 | awk '{print $2}')"
install -m 600 /dev/null deploy/self-host/.env
printf 'CLAWROUTER_ADMIN_TOKEN_SHA256=%s\n' "$CLAWROUTER_ADMIN_TOKEN_SHA256" > deploy/self-host/.env
docker compose -f deploy/self-host/docker-compose.yml up --build -d
```

Compose publishes port 8787 on host loopback only. Keep bearer tokens on a
trusted host. For remote access, put an authenticated HTTPS reverse proxy in
front of `127.0.0.1:8787`; do not publish the plaintext port directly.

Provider bindings declared by the compiled provider snapshot are passed to the
Worker when they are present in `deploy/self-host/.env`. For example:

```dotenv
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

For a custom manifest or another intentional Worker variable, add its name to
the comma-separated `CLAWROUTER_SELF_HOST_VARS` value. Never add the raw
`CLAWROUTER_ADMIN_TOKEN`; the Worker receives only its digest.

## Console sign-in

Local console sign-in is opt-in. Add `CLAWROUTER_LOCAL_AUTH=enabled` to
`deploy/self-host/.env`, recreate the container, then open
`http://localhost:8787/dashboard` and paste the raw admin token into the
sign-in form; the browser receives a 12-hour session cookie. Without the
flag the console stays API-only. Scripts can obtain the same cookie
directly:

```sh
curl --fail -c cookies.txt http://localhost:8787/v1/session/login \
  -H 'content-type: application/json' \
  --data "{\"token\": \"$CLAWROUTER_ADMIN_TOKEN\"}"
curl --fail -b cookies.txt http://localhost:8787/v1/session
```

The session authenticates the dashboard, the playground, and the
`/v1/session/*` endpoints (including self-service maintainer keys) as an
administrator identified by `CLAWROUTER_LOCAL_ADMIN_EMAIL` (default
`admin@local`). `POST /v1/session/logout` revokes the session. Sign-in
attempts are rate limited. Local sign-in is refused whenever Cloudflare
Access variables are configured, so it cannot be enabled on a managed
deployment.

## Create a proxy key

The normal key helper uses the running Worker's admin bearer-token API. It does
not use Wrangler, Cloudflare credentials, or direct local KV mutation unless
`--local` is explicitly supplied.

```sh
export CLAWROUTER_BASE_URL=http://localhost:8787
read -r CLAWROUTER_PROXY_SECRET < <(openssl rand -hex 24)
export CLAWROUTER_PROXY_SECRET
printf '%s' "$CLAWROUTER_PROXY_SECRET" | node scripts/key-put.mjs \
  --kid self_host \
  --secret-stdin \
  --providers firecrawl \
  --request-cost-micros 1
export CLAWROUTER_KEY="clawrouter-live-self_host-$CLAWROUTER_PROXY_SECRET"
```

`firecrawl` is usable without a provider key at its upstream free rate limit.
Choose another provider after adding its required configuration to the env
file, then recreate the container so it receives the new environment:

```sh
docker compose -f deploy/self-host/docker-compose.yml up -d --force-recreate
```

## Smoke test

```sh
curl --fail http://localhost:8787/v1/health
curl --fail http://localhost:8787/v1/catalog \
  -H "authorization: Bearer $CLAWROUTER_KEY"

CLAWROUTER_BASE_URL=http://localhost:8787 \
CLAWROUTER_ADMIN_TOKEN="$CLAWROUTER_ADMIN_TOKEN" \
node scripts/smoke-self-host.mjs
```

The smoke script creates a temporary policy and credential through the admin
API, verifies its scoped catalog, and revokes it.

## Persistence, backup, and upgrades

Durable Object, KV, and R2 state lives under `/data`, backed by the named
Compose volume `clawrouter-data`. Stop the container before taking a
filesystem-consistent backup of that volume. Losing it loses policies, proxy
credentials, grants, budgets, settled usage records, and retained content.
Pending, delayed, or retrying local queue messages are memory-only and are lost
on a crash or restart; drain request traffic before planned maintenance.

Upgrading past 0.1.0 does not change the console posture: local sign-in is
opt-in, so the dashboard keeps failing closed until the operator sets
`CLAWROUTER_LOCAL_AUTH=enabled`. With the flag set, the dashboard shell and
`/v1/session/login` become reachable; the login still requires the admin
token, and every API behind the shell stays session-gated.

To upgrade a source checkout, back up `/data`, pull the new source, review the
release notes, then pull fresh base layers, rebuild, and restart:

```sh
docker compose -f deploy/self-host/docker-compose.yml build --pull
docker compose -f deploy/self-host/docker-compose.yml up -d
```

## Version 1 limitations

Cloudflare Access is absent. GitHub maintainer auto-provisioning is
unavailable, browser OAuth connect flows are untested in this profile, and
local console sign-in currently supports a single admin-token identity
rather than per-user passwords.
Manage the service through the console session or the admin bearer-token API
and repository scripts; clients use normal proxy keys. This profile is one
local workerd process and does not provide Cloudflare's distributed
availability, durable queue delivery, or managed backups.
