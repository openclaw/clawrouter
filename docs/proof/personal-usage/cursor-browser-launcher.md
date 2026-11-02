# Cursor browser qualification launcher

The tracked Playwright configuration and browser tests remain unchanged except for the new regression file. On this host, Node's normal HTTP URL-readiness probe refuses Host/request-authority before any browser test runs. Playwright1.64.1 explicitly documents webServer.wait.stdout in its installed types. A temporary configuration selects that supported readiness mode; actual Chromium navigation and every test assertion still execute. Do not change proxy/bypass environment, weaken a security guard or claim a setup failure tested the product.

Temporary config imports admin/playwright.config.ts. Retain its projects, baseURL, viewport, timezone, trace and snapshots. Resolve testDir to admin/browser and snapshotDir to admin/browser/__screenshots__, with output under the permitted scratch/artifact directory. Set webServer cwd to admin and command to:

    pnpm exec vite preview --host 127.0.0.1 --port 4317 --strictPort

Replace only the Node URL-readiness selector with:

    url: undefined,
    wait: { stdout: /127[.]0[.]0[.]1:4317/ },
    reuseExistingServer: false

Run from repository root using that temporary configuration (adjust its location, not the tests):

    pnpm --dir admin build
    pnpm --dir admin exec playwright test --config=../.openclaw/tmp/cursor-playwright.config.ts personal-usage-cursor.spec.ts --workers=2
    pnpm --dir admin exec playwright test --config=../.openclaw/tmp/cursor-playwright.config.ts --workers=2

Observed exit0: focused4/4 desktop/mobile; complete484/484 desktop/mobile, about1.5minutes. No snapshots were updated. The actual configuration and logs are retained in the task's ignored .openclaw/tmp directory. A fresh checkout must create its own temporary configuration with these options; the ignored path is not a delivered executable dependency. Standard environments without the Node readiness issue can use the tracked configuration normally.
