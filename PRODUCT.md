# Product

## Register

product

## Users

ClawRouter is for maintainers, operators, and engineers managing an OpenRouter-like access surface for OpenClaw services. Maintainers need to log in, see what they can access, inspect provider and tool coverage, and run playground traffic through the same policy path users hit. Admins need to bind Cloudflare Access users and groups to scoped policies, manage provider connections, issue proxy credentials, revoke access, and audit requests and budgets by tenant. The catalog is service-first: an LLM provider is one service with models inside its detail/playground context, not one row per model.

## Product Purpose

ClawRouter gives OpenClaw a provider-neutral control plane and high-throughput edge data plane for model APIs, search APIs, tool APIs, and future service providers. Success means a maintainer can understand their entitlements immediately, test a model or tool route in the playground, and trust that admin-granted policies, provider allowlists, budgets, OAuth grants, and revocation all apply consistently.

## Brand Personality

Clean, sophisticated, sharp. The product should feel future-facing without feeling flashy, cheap, or excessively techy. It should read like serious infrastructure software with enough visual precision to earn trust quickly.

## Anti-references

Avoid generic dark terminal aesthetics, neon cyberpunk styling, rounded toy-like SaaS dashboards, cheap gradient-heavy AI-tool visuals, and busy provider marketplace pages. Do not make the interface feel like a demo console, a marketing landing page, or a decorative metrics wall.

## Design Principles

- Keep entitlements visually obvious: identity, tenant, role, policy bindings, credential state, provider scope, playground readiness, and budget state should be faster to parse than secondary metadata.
- Use earned familiarity: standard admin patterns, tables, forms, and controls should feel polished rather than reinvented.
- Make authority visible: destructive actions, revocation, Access state, and budget limits need clear hierarchy and predictable feedback.
- Stay provider-neutral: the interface should organize many providers without making one upstream vendor feel like the center of gravity.
- Prefer sharp restraint: strong alignment, crisp borders, compact density, and disciplined contrast beat decoration.

## Accessibility & Inclusion

Target WCAG AA. Preserve keyboard-first operation, visible focus states, sufficient color contrast, reduced-motion compatibility, and redundant status cues so active, revoked, error, and loading states are not conveyed by color alone.
