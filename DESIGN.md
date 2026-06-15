---
name: ClawRouter
description: Provider-neutral control plane for routing, keys, budgets, and Access-backed administration.
colors:
  foreground: "#374151"
  foreground-strong: "#111827"
  soft-background: "#fafafe"
  surface: "#ffffff"
  muted-text: "#64748b"
  light-slate: "#94a3b8"
  border: "#e2e8f0"
  primary: "#5b5ef6"
  active-fill: "#dcfce7"
  revoked-fill: "#ffe4e6"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0"
rounded:
  control: "5px"
  panel: "5px"
  pill: "999px"
icons:
  library: "lucide-react + simple-icons"
  defaultSize: "14px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "18px"
  xxl: "24px"
  shell: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
    height: "30px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-strong}"
    rounded: "{rounded.control}"
    padding: "5px 9px"
    height: "30px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "12px"
  status-active:
    backgroundColor: "{colors.active-fill}"
    textColor: "{colors.foreground-strong}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  status-revoked:
    backgroundColor: "{colors.revoked-fill}"
    textColor: "{colors.foreground-strong}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
---

# Design System: ClawRouter

## 1. Overview

**Creative North Star: "The Sharp Control Plane"**

ClawRouter is a restrained product interface for maintainers and admins managing provider access. It should feel like a precise control plane: compact, legible, aligned, and fast to scan. The surface follows an Opik-like application grammar: soft page background, white panels, compact controls, local brand marks for services, lucide icons for controls, dense tables, and clear list/detail workflows.

The current UI is an access console with persistent navigation, session posture, provider catalog coverage, policy bindings, user access, and playground traffic. Future work should preserve that workflow shape: identity first, catalog next, policy builder and playground always close at hand.

It explicitly rejects generic dark terminal aesthetics, neon cyberpunk styling, rounded toy-like SaaS dashboards, cheap gradient-heavy AI-tool visuals, busy provider marketplace pages, demo-console looseness, landing-page composition, and decorative metrics walls.

**Key Characteristics:**

- Restrained, provider-neutral access-console density.
- Sharp alignment, thin borders, small radii, and 30px controls.
- Local provider marks as first-class service identity, with lucide icons reserved for nav, buttons, panels, and status.
- One sans family across UI, labels, data, and controls.
- Semantic status color used sparingly.
- Flat-by-default surfaces with no decorative shadow vocabulary.

## 2. Colors

The palette is a cool restrained neutral system with one violet product primary and quiet semantic fills.

### Primary

- **Product Primary** (#5b5ef6): Primary button fill, active nav state, active table tint, and selected action emphasis. Use it as an interface affordance, not a decorative wash.
- **Strong Foreground** (#111827): Provider names, headings, active table data, and highest-authority text.

### Neutral

- **Soft Background** (#fafafe): Page background and selected-row family. Keeps the shell light without becoming beige.
- **Panel White** (#ffffff): Sidebar, main panels, inputs, inspector, and table containers.
- **Foreground** (#374151): Standard product text and table data.
- **Muted Slate** (#64748b): Secondary copy, compact metadata, labels, and status text.
- **Light Slate** (#94a3b8): Low-emphasis icons and placeholder text.
- **Structure Border** (#e2e8f0): Sidebar, panel, table, input, and divider stroke.

### Tertiary

- **Active Wash** (#dcfce7): Low-volume active state fill for grants and status chips.
- **Revoked Wash** (#ffe4e6): Low-volume revoked state fill. Pair with explicit text so color is not the only cue.

### Named Rules

**The Neutral First Rule.** Screens should remain mostly Soft Background, Panel White, Foreground, and border neutrals. Product Primary appears in navigation, primary actions, and selected state only.

**The No Vendor Center Rule.** Provider colors and logos should not dominate the admin surface. The interface stays provider-neutral even when listing many upstreams.

## 3. Typography

**Display Font:** Inter, with system sans fallbacks.
**Body Font:** Inter, with system sans fallbacks.
**Label/Mono Font:** Ubuntu Mono or system monospace for generated secrets and code-like output.

**Character:** One-family product typography, compact and operational. Weight and placement carry hierarchy; the system does not use display fonts, fluid type, or theatrical letter spacing.

### Hierarchy

- **Display** (not currently used): Avoid display-scale typography in the admin shell. This is a task surface, not a landing page.
- **Headline** (700, 22px, 1.15): Page title and primary screen identity.
- **Title** (700, 15px, 1.25): Panel headings such as Policy editor, Coverage, and Request builder.
- **Body** (400 to 600, 13px, 1.4): Table cells, provider metadata, form-adjacent text, and compact UI copy.
- **Label** (600 to 700, 11px, 0 letter spacing, uppercase in current controls): Form labels, table headers, role chips, and status chips.

### Named Rules

**The No Display Labels Rule.** Labels, buttons, and data stay in the product sans scale. Do not introduce display type for flavor inside admin UI.

**The Case With Care Rule.** The current uppercase labels are acceptable at 12px and short lengths. Do not use uppercase for body copy, long helper text, or error messages.

## 4. Elevation

ClawRouter is flat by default. Depth is conveyed through tonal layering, borders, spacing, and containment rather than shadows. Panels sit on Soft Background as white surfaces with a 1px Structure Border; table rows use the same border system. Inputs may use a tiny hover shadow, but broad ambient shadows are out.

### Named Rules

**The No Ambient Shadow Rule.** Do not add broad soft shadows to cards, buttons, panels, or tables. If a lifted state is needed later, keep it state-driven and small.

**The Border Is Structure Rule.** Use 1px borders for containment and hierarchy. Do not use colored side stripes or thick decorative borders.

## 5. Components

### Buttons

- **Shape:** Compact rectangle with a small radius (5px) and minimum height of 30px.
- **Primary:** Product Primary background, Panel White text, 1px Product Primary border, 5px 10px padding.
- **Secondary:** White background, Structure Border stroke, Foreground text, and Product Primary hover tint.
- **Icons:** Buttons use 14px lucide icons when the action has a familiar symbol. Service rows use local provider marks from simple-icons when available, with stable type-icon fallback.
- **Hover / Focus:** Buttons change color; focus uses a 1px Product Primary outline.
- **Disabled:** Uses opacity 0.45 and not-allowed cursor.

### Chips

- **Style:** Pill shape (999px), 2px 7px padding, 11px bold uppercase text, optional 12px lucide state icon.
- **State:** Active uses Active Wash; revoked uses Revoked Wash. Every chip must include text such as active, revoked, admin, user, or not signed in.

### Cards / Containers

- **Corner Style:** Panels, inspector surfaces, and table containers use 6px radius.
- **Background:** Panel White on Soft Background.
- **Shadow Strategy:** No shadows at rest.
- **Border:** 1px Structure Border for panels, inspectors, table containers, and rows.
- **Internal Padding:** 8px to 10px is the default panel interior and header padding.

### Inputs / Fields

- **Style:** Panel White fill, Structure Border stroke, Strong Foreground text, 5px radius, 30px minimum height.
- **Focus:** Inputs use a crisp 1px Product Primary focus outline with 1px offset.
- **Error / Disabled:** Error and disabled field states are not yet standardized.

### Navigation

- **Style, typography, default/hover/active states, mobile treatment.** The console uses persistent 232px left navigation on desktop and a single compact rail on small screens. Nav rows are 26px high with 14px lucide icons. Active state uses Product Primary text on a pale primary tint.

### Access Console

Catalog is the home surface. It lists services, not individual model SKUs. LLM providers are one service row with model count/details in the inspector; tools and manifest endpoints are service rows. Each row shows provider/service identity, kind, capability, route, and access state.

### Usage

Usage is an audit surface, not a decorative dashboard. Budget, request-cost, and service-coverage data should stay dense, table-like, and policy-scoped.

### Tables and Provider Rows

Tables and provider rows are dense, left-aligned, and border-separated. Entity rows use 12px text with 6px 10px padding and 42px row height. Desktop keeps a table/detail split with explicit column widths; mobile converts rows to label/value blocks before the inspector. Do not explode an LLM provider into one row per model.

### Playground

Playground is prompt-first. The main surface is a large composer for system and user prompts with compact controls for model, endpoint, tokens, temperature, and run. Response stays visible beside or below the composer. Raw JSON/curl request output is hidden in a disclosure by default and opened only when the user wants to inspect it. The playground is not a toy demo; it uses the same proxy-key policy path as production calls.

## 6. Do's and Don'ts

### Do:

- **Do** keep screens mostly Soft Background (#fafafe), Panel White (#ffffff), Strong Foreground (#111827), Product Primary (#5b5ef6), and neutral borders.
- **Do** keep controls compact: 30px minimum height, 5px radius for fields/buttons/panels, 26px nav rows, and 42px table rows.
- **Do** use real provider marks for service rows and lucide-react icons for nav items, primary actions, status chips, and panel headers.
- **Do** use status fills only with explicit text labels such as active and revoked.
- **Do** preserve provider neutrality when listing upstreams. Keep provider identity subordinate to routing, key, tenant, policy, and budget state.
- **Do** keep focus, loading, empty, and error states visible before adding visual flair.
- **Do** keep Access, Catalog, Policies, and Playground as first-class destinations. They are the product, not secondary admin clutter.

### Don't:

- **Don't** make the UI feel cheap, overly techy, or like a sci-fi terminal.
- **Don't** use generic dark terminal aesthetics, neon cyberpunk styling, cheap gradient-heavy AI-tool visuals, or busy provider marketplace pages.
- **Don't** turn usage into a decorative metrics wall. The counters are operational summaries tied to access, routes, keys, and budget.
- **Don't** use toy-like rounded SaaS cards. Containers top out at 6px unless a real component need earns otherwise.
- **Don't** add broad ambient shadows, glassmorphism, gradient text, thick colored side stripes, or decorative provider color fields.
- **Don't** rely on color alone for status. Pair Active Wash (#dcfce7) and Revoked Wash (#ffe4e6) with iconography, text, and accessible state semantics.
