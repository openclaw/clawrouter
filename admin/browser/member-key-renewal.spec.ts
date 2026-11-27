import { expect, test } from "@playwright/test";
import type { ProxyCredential } from "../src/ui-types";
import { fixtureResponses } from "./fixtures/personal-usage";

const expiresAt = "2026-11-27T12:00:00.000Z";
const policyId = "studio";
const reason = "This key cannot be renewed because its policy changed. If you hold a policy, create a replacement key under it and update your client to use the new key.";

for (const offset of [-1, 0, 1]) {
  test(`member renewal eligibility at expiry ${offset}ms: an explicitly mismatched policy never becomes renewable`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(Date.parse(expiresAt) + offset));
    const expired = offset >= 0;
    const base = { policyId, enabled: true, active: !expired, expiresAt, expired, principalId: "member@example.com" };
    const keys: ProxyCredential[] = [
      { ...base, credentialId: "current_key", generationMatches: true },
      { ...base, credentialId: "mismatched_key", active: false, generationMatches: false },
      { ...base, credentialId: "unreported_key" },
      { ...base, credentialId: "revoked_key", enabled: false, active: false, generationMatches: true },
      { ...base, credentialId: "former_key", policyId: "former_policy", generationMatches: true },
    ];
    const budget = { configured: false, ledger: "unmetered", limitMicros: null, spentMicros: 0, remainingMicros: null };
    const responses: Record<string, unknown> = { ...fixtureResponses,
      "/v1/session": { ...fixtureResponses["/v1/session"] as object, entitlements: { providers: [], policies: [{ policyId, budget }] } },
      "/v1/session/usage": { ...fixtureResponses["/v1/session/usage"] as object, policies: [{ kid: policyId, policyId, enabled: true, providers: [], budget }] },
      "/v1/session/credentials": { credentials: keys }, "/v1/session/usage/report": { kind: "no_access" },
    };
    const forbidden: string[] = [];
    await page.route("**/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET" || path.startsWith("/v1/admin/")) {
        forbidden.push(path);
        return route.abort();
      }
      return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? {} });
    });
    await page.goto("/dashboard/home");
    const card = page.locator(".myKeysPanel");
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    const row = (id: string) => card.locator("article").filter({ has: page.getByText(id, { exact: true }) });
    const renew = (id: string) => row(id).getByRole("button", { name: "Renew", exact: true });
    await expect(renew("current_key")).toBeEnabled();
    await expect(renew("unreported_key")).toBeEnabled();
    await expect(row("unreported_key")).not.toContainText(reason);
    await expect(renew("revoked_key")).toBeDisabled();
    await expect(renew("former_key")).toBeDisabled();
    await expect(renew("mismatched_key")).toBeDisabled();
    await expect(renew("mismatched_key")).toHaveAccessibleDescription(reason);
    await expect(row("mismatched_key").getByText(reason)).toBeVisible();
    if (expired) {
      await expect(row("current_key")).toContainText("expired on 2026-11-27");
      await expect(renew("current_key")).not.toHaveAttribute("title", /Only active/);
    }
    await row("mismatched_key").getByRole("button", { name: "Rename" }).press("Tab");
    await expect(row("mismatched_key").getByRole("button", { name: "Revoke" })).toBeFocused();
    await row("current_key").getByRole("button", { name: "Rename" }).press("Tab");
    await expect(renew("current_key")).toBeFocused();
    expect(forbidden).toEqual([]);
  });
}
