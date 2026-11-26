import { expect, test, type Route } from "@playwright/test";

test("Fusion keeps later edits through save acknowledgement and foreground refresh", async ({ page }) => {
  let fusion = { version: 1, modelId: "clawrouter/fusion", strategy: "single", enabled: true, adviserModels: [], aggregatorModel: "openai/original", adviserTimeoutMs: 1000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 };
  const policies = ["policy_a", "policy_b"].map(policyId => ({ policyId, enabled: true, providers: [], retainRequestContent: false }));
  const writes: Route[] = [], reads: Route[] = [];
  let holdRead = false;
  const bootstrap = () => ({ policies, fusion, credentials: [], connections: [], users: [], bindings: [], grants: [], rules: [], providers: [], tenants: [], overview: {} });
  await page.route("**/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/v1/admin/fusion" && request.method() === "PUT") { writes.push(route); return; }
    if (path === "/v1/admin/bootstrap" && holdRead) { reads.push(route); return; }
    const body: Record<string, unknown> = {
      "/v1/providers": { providers: [] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "operator@example.test", entitlements: { providers: [] } },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [] }, "/v1/admin/bootstrap": bootstrap(),
      "/v1/admin/fusion/preview": { policyId: request.method() === "POST" ? request.postDataJSON().policyId : "policy_a", policyEnabled: true, configEnabled: true, executable: true, advertisable: true, readyAdviserCount: 0, adviserCount: 0, callCount: 1, estimatedReservationMicros: 0, budgetConfigured: false, budgetLedger: "unmetered", remainingBudgetMicros: null, budgetSufficientForAll: null, estimateNote: "Synthetic readiness", calls: [] },
    };
    await route.fulfill({ status: path in body ? 200 : 404, json: body[path] ?? {} });
  });
  await page.goto("/dashboard/access?resource=fusion");
  const model = page.getByRole("combobox", { name: "final synthesizer", exact: true });
  const policy = page.getByRole("combobox", { name: "readiness policy", exact: true });
  const save = page.getByRole("button", { name: "Save fusion model", exact: true });
  await expect(model).toHaveValue("openai/original");
  await model.fill("openai/submitted");
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].request().postDataJSON().aggregatorModel).toBe("openai/submitted");
  await model.fill("openai/later");
  await policy.selectOption("policy_b");
  holdRead = true;
  fusion = { ...fusion, aggregatorModel: "openai/submitted" };
  await writes[0].fulfill({ json: fusion });
  await expect.poll(() => reads.length).toBe(1);
  await expect(model).toHaveValue("openai/later");
  await model.fill("openai/latest");
  await reads[0].fulfill({ json: bootstrap() });
  await expect(save).toBeEnabled();
  await expect(model).toHaveValue("openai/latest");
  await expect(policy).toHaveValue("policy_b");
  await expect(page.getByText("Readiness pending", { exact: true })).toBeVisible();

  holdRead = false;
  await save.click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].request().postDataJSON().aggregatorModel).toBe("openai/latest");
  fusion = { ...fusion, aggregatorModel: "openai/canonical" };
  await writes[1].fulfill({ json: fusion });
  await expect(save).toBeEnabled();
  await expect(model).toHaveValue("openai/canonical");
  await expect(policy).toHaveValue("policy_b");
});
