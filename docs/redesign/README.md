# Console redesign — "Patchboard"

Visual system for the ClawRouter browser console (July 2026). Screenshots in
this directory are demo-mode captures at 1440×1000 used for the redesign PR.

## System

- **Identity**: patch-panel instrument console. Copper signal accent
  (`#bc3c08` light / `#ff7847` dark) on blueprint-paper porcelain (light) and
  graphite ink (dark). Semantic colors stay independent: moss = healthy,
  ochre = attention, oxide = blocked.
- **Type**: [Archivo Variable](https://fonts.google.com/specimen/Archivo)
  carries UI text and uses its width axis for display headlines;
  [Spline Sans Mono](https://fonts.google.com/specimen/Spline+Sans+Mono)
  carries every numeral, code path, table header, and stencil label. Both are
  bundled through Fontsource — no runtime font requests, no unloaded
  font-family references.
- **Geometry**: sharp 1px hairline panels, 4px control radius, rectangular
  stencil status tags, 3px accent rails for selection (nav, table rows,
  callouts, attention metrics).
- **Structure**: stylesheets are semantic modules under `admin/src/styles/`
  (`tokens`, `base`, `shell`, `tables`, `workspace`, `dashboard`,
  `playground`, `usage`) replacing the append-only numbered files
  (`01.css`–`07.css`) whose later layers overrode earlier ones.

## Files

- `before-*.png` — previous design, light theme.
- `after-*.png` — Patchboard, light theme.
- `after-dark-*.png` — Patchboard, dark theme.
