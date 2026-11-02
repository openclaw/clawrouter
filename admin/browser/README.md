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

## Personal usage proof

Run `pnpm --dir admin exec playwright test my-usage.spec.ts` after building.
`fixtures/personal-usage.ts` provides synthetic, metadata-only report and event
responses; these are not live usage or a fallback for a disconnected account.
The spec covers price-quality/billing-lane separation, token coverage, exact
filters, bounded pagination, independent event errors, cancellation, member
pool isolation, and accepted-identity replacement. Desktop/mobile screenshots
and WCAG AA checks exercise the same production screen.

The JSON reporter retains `synthetic-report-performance` and
`responsive-navigation` attachments. Navigation is timed with an event read
held open; the 1.5-second bound is a UI responsiveness regression guard, not
a production gateway/backend latency claim. Production report/event limits
remain 100 groups / 25 requested events per page.

Member budget context and personal-credential policy metadata request
`/v1/session/usage?budgets_only=true`; they must not trigger legacy activity
snapshot scans. Null credential IDs are labeled **Dashboard session** in
call details and key grouping (including breakdown CSV), never inferred from
a policy ID. Recorded budget charges remain separate from reporting-only
prices and are not invoice amounts.

The daily table includes reporting costs separated by lane and price quality,
including unknown-price call counts; it never calculates a grand total.
Available self-service key metadata supplies name + actual ID for key groups,
active filters and event details without an additional fetch. Missing metadata
falls back to the credential ID, while null remains Dashboard session.

Breakdown CSV has **exactly one row per displayed group**. Calls, token totals
and field-coverage counts appear once, so summing a metrics column down the
rows cannot multiply it by that group's price classes. Each of the three
lanes × seven price classes has independent `_calls` and
`_reporting_amount_usd` columns. Missing amounts and unknown-price amounts are
blank (not zero); known no-charge amounts may be zero. Never add different
price qualities or billing lanes into an invoice/grand total. A truncated
export covers only its displayed groups, as flagged in `groups_truncated`.
Event CSV keeps reporting microdollars, recorded budget-charge microdollars
and estimate reason in separate explicit columns; neither export includes
extra scope/identity/content/secret fields.

Call-detail anchors are page-local row identifiers, not URI-encoded ledger IDs. Duplicate IDs from separate shards and legacy non-URI-safe IDs retain distinct rows and correct Fusion peer links. Estimate-bound warnings recognize the producer's complete reason string, not only a shortened fixture label.
