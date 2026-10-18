# Browser proof and snapshots

Build before running the suite: `pnpm --dir admin build`, then
`pnpm --dir admin exec playwright test`. The configuration serves `admin/dist`
through Vite preview and records desktop/mobile Chromium snapshots with a
platform suffix. Accessibility checks run alongside the visual assertions.

The `admin` CI job uses Ubuntu x86_64 and the Playwright version pinned in
`admin/package.json`. Generate Linux baselines on Linux x86_64, for example
with `mcr.microsoft.com/playwright:v1.63.0-noble` and Docker's
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
