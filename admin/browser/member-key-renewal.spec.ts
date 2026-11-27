import { expect, test } from "@playwright/test";
import { fixtureResponses } from "./fixtures/personal-usage";

const recovery = "This key could not be renewed. If you hold a policy, create a replacement key under it and update your client to use the new key.";
const keyId = "studio_key", policyId = "studio";
const inactive = "only an active credential can be rotated";
const uncertain = `Change to ${keyId} could not be confirmed. Refresh and check this key before trying again; the server may have applied it. No secret can be recovered.`;

for (const [scenario, action, status, code, expected] of [
  ["confirmed inactive renewal", "Renew", 409, "credential_inactive", recovery],
  ["different conflict code", "Renew", 409, "policy_conflict", `Request failed (409): ${inactive}`],
  ["different rejection status", "Renew", 400, "credential_inactive", `Request failed (400): ${inactive}`],
  ["revoke instead of renewal", "Revoke", 409, "credential_inactive", `Request failed (409): ${inactive}`],
  ["server error", "Renew", 503, "credential_inactive", uncertain],
  ["lost response", "Renew", 0, "", uncertain],
] as const) {
  test(`personal key feedback: ${scenario}`, async ({ page }) => {
    // Match GET /v1/session/credentials: no generation, owner or policy-state fields.
    const key = { credentialId: keyId, name: "Studio laptop", policyId, enabled: true, active: false,
      expiresAt: "2026-01-01T00:00:00Z", expired: true, serviceTiers: ["default"] };
    const budget = { configured: false, ledger: "unmetered", limitMicros: null, spentMicros: 0, remainingMicros: null };
    const responses: Record<string, unknown> = { ...fixtureResponses,
      "/v1/session": { ...fixtureResponses["/v1/session"] as object, entitlements: { providers: [], policies: [{ policyId, budget }] } },
      "/v1/session/credentials": { credentials: [key] },
      "/v1/session/usage": { ...fixtureResponses["/v1/session/usage"] as object, policies: [{ kid: policyId, policyId, enabled: true, providers: [], budget }] },
      "/v1/session/usage/report": { kind: "no_access" },
    };
    const mutation = `/v1/session/credentials/${keyId}/${action === "Renew" ? "rotate" : "revoke"}`;
    const writes: string[] = [], forbidden: string[] = [];
    let lists = 0;
    await page.route("**/v1/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === mutation) {
        writes.push(path);
        return status === 0 ? route.abort("failed") : route.fulfill({ status, json: { error: { code, message: inactive } } });
      }
      if (request.method() !== "GET" || path.startsWith("/v1/admin/")) { forbidden.push(path); return route.abort(); }
      if (path === "/v1/session/credentials") lists++;
      return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? {} });
    });
    await page.goto("/dashboard/home");
    const card = page.locator(".myKeysPanel"), row = card.locator("article").filter({ hasText: keyId });
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    await expect(row.getByRole("button", { name: "Renew", exact: true })).toBeEnabled();
    await expect(card.getByRole("alert")).toHaveCount(0);
    expect(writes).toEqual([]);
    const initialReads = lists;
    await row.getByRole("button", { name: action, exact: true }).click();
    await expect(card.getByRole("alert")).toHaveText(expected);
    await expect.poll(() => lists).toBeGreaterThan(initialReads); // Existing metadata reconciliation.
    await expect(card.locator(".issuedKey")).toHaveCount(0);
    const beforeRefresh = lists;
    await card.getByRole("button", { name: "Refresh keys", exact: true }).press("Enter");
    await expect.poll(() => lists).toBeGreaterThan(beforeRefresh);
    await expect(row.getByRole("button", { name: "Renew", exact: true })).toBeEnabled();
    await expect(card.getByRole("alert")).toHaveText(expected);
    expect(writes).toEqual([mutation]);
    expect(forbidden).toEqual([]);
  });
}
