# AGENTS.md

Telegraph style. Keep the data plane provider-neutral and the hot path small.

## Architecture

- Rust/Wasm owns request classification, key checks, routing, budget preflight, provider transforms, and usage event construction.
- TypeScript owns the admin frontend, Cloudflare Access/GitHub glue, generated clients, and provisioning scripts.
- Provider support starts with `providers/<id>.provider.yaml`. Add custom Rust adapters only when the manifest cannot express the provider safely.
- No upstream provider secrets in source, tests, fixtures, logs, screenshots, or docs.
- Do not log raw prompts or completions by default.
- Revocation and hard budget enforcement must stay faster and more authoritative than reporting/billing systems.

## Validation

- Run focused Rust and TypeScript tests for touched surfaces.
- Validate all bundled provider manifests after provider changes.
- Run autoreview before handoff for non-trivial code changes.

## Git

- Use focused commits.
- Keep `main` stable; feature work belongs on branches.
- PRs should include summary, verification, deployment status, and remaining risk.

