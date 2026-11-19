# AGENTS.md

Telegraph style. Keep the data plane provider-neutral and the hot path small.

## Architecture

- TypeScript Worker modules own request classification, key checks, routing, budget preflight, provider transforms, and usage event construction.
- TypeScript owns the admin frontend, Cloudflare Access/GitHub glue, generated clients, and provisioning scripts.
- Provider support starts with `providers/<id>.provider.yaml`. Add a focused TypeScript adapter only when the manifest cannot express the provider safely.
- No upstream provider secrets in source, tests, fixtures, logs, screenshots, or docs.
- Do not log raw prompts or completions by default.
- Warm hot path: zero foreground backend calls before upstream fetch. Admission, selection, credentials, budget verdicts in isolate memory; counters, retention, settlement async.
- Revocation/policy changes: bounded staleness ≤ hot-cache max age (`CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS`, default 60 s; `0` = authoritative per request). Explicit `reserve` budgets stay foreground and authoritative.

## Validation

- Run focused Worker and admin TypeScript tests for touched surfaces.
- Validate all bundled provider manifests after provider changes.
- Run autoreview before handoff for non-trivial code changes.

## Git

- Use focused commits.
- Keep `main` stable; feature work belongs on branches.
- PRs should include summary, verification, deployment status, and remaining risk.

## Deployment compatibility

- Production deploys through **Deploy ClawRouter** (`deploy-cloudflare.yml`). One
  main dispatch; no release modes, preparatory PRs, source hold, or operator scripts.
- A feature that changes native payload, control/state/callback contracts,
  credentials, accounting or Cloudflare deployment configuration owns its upgrade
  and recovery behavior. Preserve existing persistent owners and pending work;
  never replay uncertain inference or deployment writes.
- Read `docs/deployment-compatibility.md` before changing these contracts. Add the
  automatic transition and controlled old-state/continuation/accounting proof in
  the same PR. An unsupported transition is a development failure; do not replace
  it with a deploy-owner runbook, qualification registry entry or bypass flag.
- Session continuity means the saved Codex session can later answer a distinct
  context-dependent turn. A momentary interrupted-turn failure/retry is allowed.
