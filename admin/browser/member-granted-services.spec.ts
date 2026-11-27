import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { ProviderAccess, ProviderRow } from '../src/ui-types';
import { completeDisplayOutcome } from './fixtures/complete-usage';
import { fixtureNow, fixtureReport, fixtureResponses } from './fixtures/personal-usage';

// Session-scoped synthetic inventory. Failed or stale checks do not remove a callable route.
const inventory = [
  ['anthropic', 'Anthropic', 'failed'], ['aws-bedrock', 'AWS Bedrock', 'disabled'],
  ['azure-openai', 'Azure OpenAI', 'missing_config'], ['google-gemini', 'Google Gemini', 'unverified'],
  ['openai', 'OpenAI', 'verified'], ['tavily', 'Tavily', 'denied'],
] as const;
const privateDiagnostic = 'synthetic diagnostic not for this row';
async function member(page: Page) {
  const providers: ProviderRow[] = inventory.map(([id, display_name]) => ({ id, display_name, service_kind: 'llm', class: 'api_key', capabilities: [] }));
  const grants: ProviderAccess[] = inventory.map(([id, displayName, status]) => {
    const disabled = status === 'disabled', missing = status === 'missing_config', allowed = status !== 'denied';
    const verified = status === 'verified', stale = status === 'unverified';
    return { provider: id, displayName, serviceKind: 'llm', allowed, policies: allowed ? ['research_models'] : [], readiness: {
      id, displayName, class: 'api_key', serviceKind: 'llm', requiredConfig: [], optionalConfig: [], missingConfig: missing ? ['SYNTHETIC_CONFIG_KEY'] : [],
      connectionEnabled: !disabled, configPresent: !missing, oauthGrantRequired: false, oauthGrantCount: 0, upstreamGrantCount: 0,
      openaiCompatible: true, manifestRoutes: 1, modelCount: 0, executable: !disabled && !missing, verified,
      lastCheckedAt: new Date(fixtureNow - (stale ? 3 * 86_400_000 : 45_000)).toISOString(), status: allowed ? status : 'unverified', reasons: [privateDiagnostic],
    } };
  });
  await page.clock.setFixedTime(new Date(fixtureNow));
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe('GET');
    expect(url.pathname.startsWith('/v1/admin/')).toBe(false);
    let body = fixtureResponses[url.pathname];
    if (url.pathname === '/v1/session') body = { ...body as object, entitlements: { providers: grants, policies: [] } };
    else if (url.pathname === '/v1/providers') body = { providers };
    else if (url.pathname.endsWith('/usage/report')) body = completeDisplayOutcome(fixtureReport(url.searchParams), url);
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  return { providers, grants };
}
const panel = (page: Page) => page.locator('.servicePanel');

for (const theme of ['light', 'dark']) test('granted services separate callability from provider verification in ' + theme, async ({page}) => {
  await member(page);
  await page.addInitScript(theme => localStorage.setItem('clawrouter-theme', theme), theme);
  await page.goto('/dashboard/home');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  const services = panel(page), rows = services.getByRole('article');
  await expect(services.getByText('3 of 5 usable', {exact: true})).toBeVisible();
  await expect(rows.locator('strong')).toHaveText(['Anthropic', 'AWS Bedrock', 'Azure OpenAI', 'Google Gemini', 'OpenAI']);
  await expect(rows.locator('.status')).toHaveText(['usable', 'unavailable', 'unavailable', 'usable', 'usable']);
  for (const [name, note] of [
    ['Anthropic', 'Last provider check failed.'], ['AWS Bedrock', 'The provider connection is disabled.'],
    ['Azure OpenAI', 'Provider setup is incomplete.'], ['Google Gemini', 'No recent verification.'], ['OpenAI', 'Last provider check passed.'],
  ]) {
    const row = services.getByRole('article', {name, exact: true});
    await expect(row.getByText(note, {exact: true})).toBeVisible();
    await expect(row).toContainText('research_models');
  }
  await expect(services).not.toContainText(/Tavily|SYNTHETIC_CONFIG_KEY|synthetic diagnostic/);
  expect((await new AxeBuilder({page}).include('.servicePanel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await expect(rows.getByRole('button')).toHaveCount(0);
  const catalog = services.getByRole('button', {name: 'View catalog'});
  await catalog.focus(); await expect(catalog).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('.catalogPane')).toBeVisible();
});

test('unknown statuses stay neutral and long names and grants wrap at 320px', async ({page}) => {
  const { grants, providers } = await member(page);
  providers[1].display_name = 'A_synthetic_service_name_long_enough_to_wrap_without_truncation';
  grants[0].readiness.status = 'unknown-diagnostic-code';
  grants[0].readiness.verified = undefined;
  grants[0].readiness.lastCheckedAt = null;
  grants[1].readiness.status = 'other-blocker-code';
  grants[1].policies = ['synthetic_very_long_policy_identifier_which_must_be_fully_readable'];
  await page.setViewportSize({width: 320, height: 800});
  await page.goto('/dashboard/home');
  const services = panel(page);
  await expect(services).toContainText('Verification not reported.');
  await expect(services).toContainText('No callable route for this grant.');
  await expect(services).not.toContainText(/unknown-diagnostic-code|other-blocker-code/);
  const row = services.getByRole('article', {name: providers[1].display_name, exact: true});
  for (const text of [row.locator('strong'), row.getByText(/synthetic_very_long_policy_identifier/)]) {
    await expect(text).toBeVisible();
    expect(await text.evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).whiteSpace !== 'nowrap')).toBe(true);
  }
  expect(await services.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
});

test('known denials are not missing access, and missing access never becomes a grant', async ({page}) => {
  const { grants } = await member(page);
  for (const grant of grants) { grant.allowed = false; grant.policies = []; }
  await page.goto('/dashboard/home');
  const services = panel(page);
  await expect(services.getByText('No services assigned')).toBeVisible();
  await expect(services.getByRole('article')).toHaveCount(0);
  grants.length = 0;
  await page.reload();
  await expect(services.getByText('Service access unavailable')).toBeVisible();
  await expect(services).not.toContainText('No services assigned');
  await expect(services.getByRole('article')).toHaveCount(0);
});
