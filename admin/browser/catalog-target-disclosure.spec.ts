import { expect, test, type Page } from "@playwright/test";
import { fixtureResponses } from "./fixtures/personal-usage";

const voice = "mixed/voice-studio", firstChat = "mixed/chat-default", secondChat = "mixed/chat-pro";
const fallbackLabel = "Open " + firstChat + " in Playground";

async function openMixedCatalog(page: Page, allowed = true, executable = true) {
  const providers = ["mixed", "other"].map(id => ({ id, display_name: id === "mixed" ? "Mixed Studio" : "Other Studio", class: "openai_compatible", service_kind: "model_provider", capabilities: [] }));
  const access = providers.map(p => ({ provider: p.id, displayName: p.display_name, serviceKind: p.service_kind, allowed, policies: allowed ? ["research"] : [], readiness: {
    id: p.id, displayName: p.display_name, class: p.class, serviceKind: p.service_kind, configPresent: true, connectionEnabled: executable, verified: executable,
    status: executable ? "verified" : "disabled", reasons: [], executable, requiredConfig: [], optionalConfig: [], missingConfig: [], oauthGrantRequired: false,
    oauthGrantCount: 0, upstreamGrantCount: 0, openaiCompatible: true, modelCount: 3, manifestRoutes: 1,
  } }));
  const chat = (id: string) => ({ id, capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] });
  const responses: Record<string, unknown> = { ...fixtureResponses,
    "/v1/providers": { providers },
    "/v1/routes": { openaiCompatible: [
      { provider: "mixed", endpoints: ["/v1/chat/completions", "/v1/embeddings"], models: [chat(firstChat), chat(secondChat), { id: "mixed/embed", capabilities: ["llm.embeddings"], endpoints: ["/v1/embeddings"] }] },
      { provider: "other", endpoints: ["/v1/chat/completions"], models: [chat("other/chat")] },
    ], manifestProxy: [{ provider: "mixed", endpoint: "speak", route: "/v1/proxy/mixed/speak", methods: ["POST"], models: [{ id: voice, capabilities: ["audio.speech"] }] }] },
    "/v1/session": { ...fixtureResponses["/v1/session"] as object, entitlements: { policies: [], providers: access } },
  };
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().method()).toBe("GET");
    expect(path).not.toMatch(/^\/v1\/(admin|playground)\//);
    if (path === "/v1/session/avatar") return route.fulfill({status: 204});
    await route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? {} });
  });
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  return page.getByRole("textbox", { name: "search catalog" });
}

test("an exact manifest-only match names the different chat target before launch, without sending", async ({page, isMobile}) => {
  if (isMobile) await page.setViewportSize({width: 320, height: 760});
  const search = await openMixedCatalog(page);
  const normal = page.getByRole("button", { name: "Try in playground", exact: true });
  for (const ordinary of ["Mixed Studio", "voice-stu"]) { await search.fill(ordinary); await expect(normal).toBeEnabled(); }
  await search.fill("  " + voice.toUpperCase() + "  ");
  const launch = page.getByRole("button", { name: fallbackLabel, exact: true });
  await expect(launch).toHaveText(fallbackLabel);
  await expect(launch).toBeEnabled();
  await expect(page.locator(".inspector").getByText(voice, {exact:true})).toHaveCount(0);
  expect(await launch.evaluate(el => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await launch.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Model or route" })).toHaveValue("model:" + firstChat);
  await expect(page.locator(".chatExchange")).toHaveCount(0);
  await page.getByRole("navigation", {name:"console"}).getByRole("button", {name:"Catalog",exact:true}).press("Enter");
  await search.fill(secondChat);
  await expect(page.locator(".inspector").getByText(secondChat, {exact:true})).toBeVisible();
  await expect(normal).toBeEnabled();
  await search.fill("mixed/embed"); await expect(normal).toBeDisabled();
  await search.fill("Other Studio"); await page.locator(".tableRow").press("Enter"); await search.fill(voice);
  await expect(page.locator(".inspectorHeader")).toContainText("Other Studio");
  await expect(page.locator(".inspectorHeader")).toContainText("outside current filters");
  await expect(normal).toBeEnabled(); await expect(launch).toHaveCount(0);
});

for (const blocked of ["denied", "not ready"]) test("the exact proxy-only match does not advertise a fallback when " + blocked, async ({page}) => {
  const search = await openMixedCatalog(page, blocked !== "denied", blocked !== "not ready");
  await search.fill(voice);
  await expect(page.getByRole("button", {name:"Try in playground",exact:true})).toBeDisabled();
  await expect(page.getByRole("button", {name:fallbackLabel,exact:true})).toHaveCount(0);
});
