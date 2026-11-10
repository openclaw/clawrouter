# Browser proof and snapshots

Build before running the suite: `pnpm --dir admin build`, then
`pnpm --dir admin exec playwright test`. The configuration serves `admin/dist`
through Vite preview and records desktop/mobile Chromium snapshots with a
platform suffix. Accessibility checks run alongside the visual assertions.

The `admin` CI job uses Ubuntu x86_64 and the Playwright version pinned in
`admin/package.json`. Generate Linux baselines on Linux x86_64, for example
with `mcr.microsoft.com/playwright:v1.64.1-noble` and Docker's
`--platform linux/amd64 --ipc=host`. Copy the source into a scratch directory,
excluding `.git`, `node_modules`, `admin/dist`, and previous test results, and
mount that directory as `/repo`. Inside the container, run:

```sh
npm install -g pnpm@11.28.4
pnpm install --frozen-lockfile
pnpm --dir admin build
pnpm --dir admin exec playwright test dashboard.spec.ts --grep 'dashboard is WCAG AA clean and visually stable$' --update-snapshots
pnpm --dir admin exec playwright test
```

Inspect the changed images before copying only the intended `*-linux.png`
files back from `admin/browser/__screenshots__`. Keep the exact visual
threshold and WCAG assertions. Never rename macOS output to a Linux filename.
For Darwin baselines, use the same build and update commands on macOS and
copy only the corresponding `*-darwin.png` files. The separate macOS CI job
checks the mobile Fusion snapshot.

## Complete usage journeys

The personal display specs retain the chart, keyboard, accessibility and viewport
checks. Their chart scenarios use an explicit complete-envelope display adapter;
these synthetic totals are not end-to-end export or authority evidence.

The personal-usage-cursor and usage-by-user specs use the shipped parser, current
authority inventory, retained-row SQLite, root registry, 100-row cursor pagination
and fresh export client. Only identity verification and private DO transport are
synthetic. The Worker HTTP suite separately exercises signed Access assertions and
real local login, credential binding and live revocation. Node fixture tests qualify
the data path, not browser layout or interaction.

- Summary reads allocate no cut; full views use replaceable browse cuts.
- Leaving a view retires its roots and cancels exports. Reentry starts fresh.
- Presets use server-time days. Custom controls use absolute RFC3339 instants.
  Refinements retain the base; widening and Refresh allocate a fresh base.
- Outside-retention is an error state, not a zero. Partial clipping is disclosed;
  event pages use the returned effective interval. Retries preserve cursor/query.
- Retained owners and credential IDs identify historical rows. Current key names
  appear only in the own-key selector, not as renamed historical events.
- Current-page and current-rank CSVs are explicitly partial, include scope and
  coverage metadata, and keep unknown amounts blank. Full CSV/JSON export captures
  fresh usage with intent=export, reconciles all events, validates current authority
  and the complete source vector, then downloads; 50,000 events / 16 MiB maximum.
- Admin user → key → event → JSON journey uses retained identities, not live key
  inventory. Legacy allowance/diagnostic reads remain separate and unchanged;
  member allowance reads continue to request budgets_only=true.
- Coverage always discloses non-exhaustive historical locations and unknown former
  location late writes. Recorded accounting amounts are not settlement evidence.

Existing screenshots require native-browser inspection/regeneration when layout
changes. Do not claim Node/SSR tests or compiled specs as browser proof, weaken
visual/WCAG thresholds, or regenerate baselines without inspection. This task's
native browser owner retains the execution/admission gate and view-proof work.
