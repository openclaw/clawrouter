# Changelog

## Unreleased

- Accept HTTP bearer authentication schemes case-insensitively for admin API tokens.
- Validate provider request paths and templates before reserving budget so malformed manifest requests fail without temporarily consuming quota.
- Automatically bind GitHub organization and team assignment rules from Cloudflare Access's verified same-origin identity on first sign-in, including existing users whose prior reconciliation lacked GitHub evidence.
- Document first-party OpenClaw setup, plugin and model allowlists, credential-scoped dynamic model discovery, supported transports, multi-provider smoke testing, and quota reporting on a standalone integration page.
- Join the console into a full-bleed racked frame with a flush header, connected hairlines, and one 16px alignment datum; make action buttons monochrome so copper is reserved for state, selection, and focus; calm right-rail notes, facts, and attention metrics; and replace the provider-usage list with a ranked share readout with per-provider error callouts.
- Redesign the console with the Patchboard visual system: copper-on-graphite dark and blueprint-paper light themes, bundled Archivo and Spline Sans Mono variable fonts, semantic stylesheet modules replacing the numbered append-only files, and higher-contrast status, focus, and selection states.
- Make accounting finalization independently retryable, scope readiness to entitled policies, move canonical access state out of KV fallback paths, shard usage by tenant/policy, consolidate admin bootstrap refreshes, and split shared contracts and access controllers into focused modules.
- Collapse provider-readiness connection checks into one authority lookup so cold catalog requests no longer fan out across provider Durable Objects.
- Replace the Rust/Wasm data plane and provider compiler with a modular TypeScript Worker while preserving Durable Object storage and public API contracts.
- Add a persistent Light/Dark console toggle, refine interactive states and page alignment, and simplify the signed-in identity footer.
- Normalize current OpenAI reasoning-model token limits and omit unsupported Playground temperature values.
- Add current flagship model catalogs, including GPT-5.5, Claude Opus 4.8, Gemini 3.5 Flash, and GLM-5.2, with a provider-first Playground picker.
- Show proxied Gravatar thumbnails for signed-in users without exposing email hashes or user network metadata to the browser.
- Make repeated content-retention provisioning tolerate an existing lifecycle rule.
- Resolve configured model aliases in OpenAI-compatible Playground requests instead of forwarding manifest placeholders.
- Rebuild the Playground as a multi-turn chat with a bottom model/service composer and per-turn request/response inspection.
- Add default-on, policy-controlled 30-day request-content retention with visible user disclosure, per-user exemptions, token ownership, and admin inspection.
- Collapse healthy gateway status into the header while retaining the full status row for work, warnings, and errors.
- Automatically refresh dashboard data every 30 seconds and on tab focus without overwriting unsaved admin edits.
- Merge overlapping model and manifest routes into one catalog entry per provider.
- Add role-aware user and admin dashboards with service readiness, shared quota pools, traffic diagrams, and privacy-safe Access-session usage totals.
- Gate the Cloudflare console by verified GitHub organization membership and support secure bulk provider-secret deployment.
- Add versioned list pricing for Together Qwen 2.5 7B, DeepSeek V4 Flash, and MiniMax M3 budget enforcement.
- Fix the Anthropic token-count live smoke request so provider verification no longer sends a messages-only field.
- Allow Access provisioning to use an explicitly allowed GitHub identity provider without identity-provider list permission.
- Replace stale Google, Groq, xAI, and Hugging Face defaults with live models and dated list pricing where provider-stable rates exist.
- Generate route-specific Playground service requests so switching providers no longer sends stale bodies or path values.
- Resolve configured dynamic model aliases for Playground service routes such as Azure OpenAI deployments.
- Apply provider request transforms to manifest-proxy calls so service routes match model-proxy behavior.
- Add the Mistral embedding model and list pricing so embedding requests no longer select a chat-only model.
- Remove stale provider IDs when editing policies so valid access changes are not blocked by obsolete catalog entries.
