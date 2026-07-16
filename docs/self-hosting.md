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

To upgrade a source checkout, back up `/data`, pull the new source, review the
release notes, then pull fresh base layers, rebuild, and restart:

```sh
docker compose -f deploy/self-host/docker-compose.yml build --pull
docker compose -f deploy/self-host/docker-compose.yml up -d
```

## Version 1 limitations

Cloudflare Access is absent. Console sign-in, browser OAuth, and GitHub
maintainer auto-provisioning are unavailable. Manage the service through the
admin bearer-token API and repository scripts; clients use normal proxy keys.
The dashboard and Access-session endpoints remain fail-closed without an Access
identity. This profile is one local workerd process and does not provide
Cloudflare's distributed availability, durable queue delivery, or managed
backups.
