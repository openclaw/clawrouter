import { expect, test } from "@playwright/test";
import type { GrantPoolReadiness } from "../../shared/contracts";

test("first admin recovers and activates while legacy bootstrap is unavailable", async ({ page }) => {
  let state: GrantPoolReadiness = { revision: 0, baseline: null, acceptedAt: null, phase: "idle", cursor: null, scanRevision: null, scanned: 0, issues: [], overflow: false, activatedAt: null };
  const actions: string[] = [];
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    if (path === "/v1/admin/bootstrap") return route.fulfill({ status: 500, json: { error: { code: "admin_error", message: "legacy account listing unavailable" } } });
    if (path.startsWith("/v1/admin/grant-pools/")) {
      const action = path.split("/").at(-1)!;
      if (action !== "readiness") actions.push(action);
      if (action === "baseline") {
        expect(body).toEqual({ revision: 0, baseline: "existing", confirmed: true });
        state = { ...state, revision: 1, baseline: "existing", acceptedAt: "2026-09-23T00:00:00Z" };
      }
      if (action === "scan") state = { ...state, revision: 2, scanRevision: 2, phase: "kv" };
      if (action === "advance") {
        expect(body).toEqual({ scanRevision: 2, phase: "kv", cursor: null });
        state = { ...state, phase: "complete", scanned: 1 };
        return route.fulfill({ json: { readiness: state, outcomes: [{ key: "oauth/policy/account", outcome: "attached" }] } });
      }
      if (action === "activate") { expect(body).toEqual({ revision: 2 }); state = { ...state, revision: 3, activatedAt: "2026-09-23T00:00:00Z" }; }
      return route.fulfill({ json: state });
    }
    const responses: Record<string, unknown> = {
      "/v1/providers": { providers: [] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "local", role: "admin", email: "admin@example.com", entitlementsError: "grant_pool_not_ready" },
      "/v1/session/usage": { policies: [] }, "/v1/session/credentials": { credentials: [] },
    };
    return route.fulfill({ status: responses[path] ? 200 : 503, json: responses[path] ?? { error: { message: "environment fallback waits for activation" } } });
  });
  await page.goto("/dashboard/access?resource=upstream");
  const panel = page.getByRole("region", { name: "account routing recovery" });
  await expect(panel).toContainText("Environment fallback is blocked");
  await expect(panel.getByRole("button", { name: "Accept baseline" })).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Accept baseline" }).click();
  await panel.getByRole("button", { name: "Start account scan" }).click();
  await expect(panel.getByRole("button", { name: "Activate account routing" })).toBeDisabled();
  await panel.getByRole("button", { name: "Reconcile next page" }).click();
  await expect(panel.getByLabel("last repair outcomes")).toContainText("attached");
  await panel.getByRole("button", { name: "Activate account routing" }).click();
  await expect(panel).toContainText("Active. Paused");
  expect(actions).toEqual(["baseline", "scan", "advance", "activate"]);
});
