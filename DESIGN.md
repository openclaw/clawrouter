# ClawRouter console design

The console uses the Patchboard system: copper accents on porcelain in light
mode and graphite in dark mode. The implementation is authoritative:
[design tokens](admin/src/styles/tokens.css), [shared components](admin/src/components.tsx),
and [screen styles](admin/src/style.css). The [redesign record](docs/redesign/README.md)
contains before/after captures; [PRODUCT.md](PRODUCT.md) describes the audience
and workflows.

## Visual system

- Archivo Variable carries interface text. Spline Sans Mono carries numbers,
  code, and compact labels. Both are bundled through Fontsource; no runtime
  font service is required.
- Light surfaces use `--canvas: #f2f0ea`, `--panel: #fbfaf7`, and
  `--accent: #bc3c08`. Dark surfaces use `#0c0e11`, `#121418`, and `#ff7847`.
  Use the semantic CSS variables so theme and contrast remain consistent.
- Panels use thin borders and compact spacing. Controls use the shared 4px
  radius; tags use 2px. Copper rails identify selected or active content.
- Status colors have distinct meanings: green for healthy, ochre for attention,
  red for failure. Pair color with text or an icon; provider branding does not
  replace readiness or access state.
- Lucide supplies interface icons. Bundled provider marks identify services,
  with a service-kind icon when no mark is available.

## Screen structure

The shell keeps navigation and session posture visible. Dashboard presents
scoped traffic, budgets, readiness, and personal credentials. Catalog groups
models under their provider service and pairs the service table with an
inspector. Access owns policies, credentials, upstream grants, connections,
assignment rules, and Fusion configuration. Users manages identity and direct
policy bindings. Usage combines aggregate charts with request-level audit.

Playground is conversation-first, with a transcript, composer, model/service
selection, and a request/response inspector. It exercises the same policy and
accounting path as client traffic. Its exact payload view belongs in the
inspector rather than the main conversation.

Use existing table, status, inspector, and error components before adding new
patterns. Keep provider access, configured readiness, recent verification, and
budget state distinct. An administrator's role alone grants no provider access.
Do not reveal an issued credential after the one-time copy surface is cleared.

Dashboard **My keys** creates keys for held policies. Access **Credentials**
creates a new credential or selects an existing key to rotate or revoke. Rotation
changes only the secret of an active key. A key whose policy is no longer held
can still be revoked. Copy a new secret before dismissing it or leaving the panel;
the console cannot retrieve it later. If a request outcome is uncertain, refresh
the key list before choosing another action. Creation drafts survive refreshes.

Protected console data belongs to one verified browser session. Confirmed sign-in
loss clears editors, one-time secrets, Playground history and retained request
content. Sign in locally or reload through managed Access, then verify the session
before showing protected data again. Reauthentication starts a fresh draft lifetime;
ordinary reporting failures retain the current identity and show refresh errors.
Already-sent key operations keep admission until they settle and are never replayed
by sign-in recovery.

## Accessibility and validation

Preserve visible keyboard focus, labeled controls, reduced motion, and WCAG AA
contrast in both themes. Mobile layouts must retain the information and actions
available on desktop. Empty, loading, error, and disabled states need explicit
explanations.

Filters that change one result list use labeled groups of native buttons with
`aria-pressed` for the active choice. Reserve tab semantics for controls that
switch between associated panels.

`pnpm --dir admin test:browser` builds the console and runs desktop/mobile
screenshot, accessibility, keyboard-focus, and self-service credential checks.
The committed screenshot baselines are for CI's Linux Chromium environment;
review intended visual changes before updating them. Demo mode uses synthetic
identities, usage, and the generated provider catalog for safe captures.
Select it explicitly with `?demo=1`, or use `?demo=user` on loopback for a user
session. A network or sign-in failure never switches the console into demo mode.
