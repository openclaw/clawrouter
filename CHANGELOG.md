# Changelog

## Unreleased

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
