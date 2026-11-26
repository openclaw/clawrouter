import { expect, test, type Page } from '@playwright/test';

// Local fixture: no provider traffic; only an explicit connection PATCH may change the cap.
async function openCatalog(page: Page) {
  const providers = ['harbor', 'reef'].map(id => ({ id, display_name: id, service_kind: 'model_provider', capabilities: [] }));
  const model = { email: 'first@example.test', cap: 10, used: 1 };
  const writes: Array<{ path: string; method: string; payload: unknown }> = [];
  const connection = (providerId: string) => ({ providerId, enabled: true, monthlyBudgetMicros: (providerId === 'harbor' ? model.cap : 70) * 1e6, spentMicros: model.used * 1e6 });
  await page.route('**/v1/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') {
      const payload = req.postDataJSON();
      writes.push({ path, method: req.method(), payload });
      if (req.method() === 'PATCH' && path === '/v1/admin/connections/harbor') {
        model.cap = payload.monthlyBudgetMicros / 1e6;
        await route.fulfill({ json: connection('harbor') });
      } else await route.fulfill({ status: 405 });
      return;
    }
    const responses: Record<string, unknown> = {
      '/v1/providers': { providers }, '/v1/routes': { openaiCompatible: [], manifestProxy: [] },
      '/v1/session': { authenticated: true, auth: 'cloudflare_access', role: 'admin', email: model.email, entitlements: { providers: [] } },
      '/v1/session/credentials': { credentials: [] }, '/v1/session/usage': { policies: [] },
      '/v1/admin/bootstrap': { policies: [], credentials: [], users: [], bindings: [], grants: [], rules: [], providers: [], connections: providers.map(({id}) => connection(id)), fusion: { enabled: false, adviserModels: [], aggregatorModel: '' }, overview: null, tenants: [] },
    };
    if (path === '/v1/session/avatar') await route.fulfill({ status: 204 });
    else await route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? {} });
  });
  await page.goto('/dashboard/catalog');
  const budget = page.getByRole('textbox', { name: 'monthly provider budget ($)' });
  await expect(budget).toHaveValue('10');
  async function refresh(cap: number) {
    model.cap = cap;
    model.used++;
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/v1/admin/bootstrap');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
    await expect(page.locator('.providerBudgetEditor')).toContainText('$' + model.used.toFixed(2) + ' used');
  }
  return { budget, model, refresh, writes };
}

test('untouched caps follow refresh; a dirty provider budget survives refresh until explicitly saved', async ({ page }) => {
  const { budget, refresh, writes } = await openCatalog(page);
  await refresh(18);
  await expect(budget).toHaveValue('18');
  await budget.fill('42.50');
  await refresh(25);
  await expect(budget).toHaveValue('42.50');
  await expect(budget).toHaveAccessibleDescription('Draft amount · Last reported cap: $25');
  // Even a coincidentally matching refresh is not a save acknowledgment.
  await refresh(42.5);
  await refresh(26);
  await expect(budget).toHaveValue('42.50');
  expect(writes).toEqual([]);
  const save = page.getByRole('button', { name: 'Save budget' });
  await save.click();
  await expect.poll(() => writes).toEqual([{ path: '/v1/admin/connections/harbor', method: 'PATCH', payload: { monthlyBudgetMicros: 42_500_000 } }]);
  await expect(save).toBeEnabled();
  await refresh(48);
  await expect(budget).toHaveValue('48');
  await expect(budget).toHaveAccessibleDescription('');
  expect(writes).toHaveLength(1);
});

test('provider and verified identity changes never carry the previous budget draft', async ({ page }) => {
  const { budget, model, refresh, writes } = await openCatalog(page);
  await budget.fill('42');
  await page.locator('.tableRow').filter({ hasText: 'reef' }).click();
  await expect(budget).toHaveValue('70');
  await page.locator('.tableRow').filter({ hasText: 'harbor' }).click();
  await expect(budget).toHaveValue('10');
  await budget.fill('81');
  model.email = 'next@example.test';
  await refresh(10);
  await expect(page.locator('.tenantSwitch strong')).toHaveText(model.email);
  await expect(budget).toHaveValue('10');
  expect(writes).toEqual([]);
});
