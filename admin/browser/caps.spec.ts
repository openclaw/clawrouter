import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-18T00:00:00.000Z'));
  await page.addInitScript(() => localStorage.setItem('clawrouter-theme', 'light'));
});

test('Caps defaults and member override editors are accessible and visually stable', async ({ page }) => {
  await page.goto('/dashboard/users?demo=1');
  await page.getByRole('button', { name: 'Caps', exact: true }).click();
  await page.getByLabel('Caps policy').selectOption('maintainer_models');
  await expect(page.getByRole('heading', { name: 'Member caps' })).toBeVisible();
  const editor = page.getByRole('combobox', { name: 'Default weekly cap mode' });
  await editor.selectOption('number');
  await page.getByLabel('Default weekly cap USD').fill('5000');
  await page.getByRole('button', { name: 'Save Default weekly cap', exact: true }).click();
  await expect(page.getByText('$5000.00 (inherited)', { exact: false }).first()).toBeVisible();
  const member = page.getByRole('combobox', { name: / weekly cap mode$/ }).nth(1);
  const label = (await member.getAttribute('aria-label'))!.replace(/ mode$/, '');
  await member.selectOption('number');
  await page.getByLabel(`${label} USD`).fill('2500');
  await page.getByRole('button', { name: `Save ${label}`, exact: true }).click();
  await expect(page.getByText('$2500.00 (override)', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: `${label} mode`, exact: true }).selectOption('unlimited');
  await page.getByRole('button', { name: `Save ${label}`, exact: true }).click();
  await expect(page.getByText('unlimited (override)', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: `${label} mode`, exact: true }).selectOption('inherit');
  await page.getByRole('button', { name: `Save ${label}`, exact: true }).click();
  await expect(page.getByText('$2500.00 (override)', { exact: false })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('.capsView').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await expect(page).toHaveScreenshot('caps.png', { animations: 'disabled', fullPage: true });
});

test('Members do not see the Caps view', async ({ page }) => {
  await page.goto('/dashboard/users?demo=user');
  await expect(page.getByRole('button', { name: 'Caps', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Caps', exact: true })).toHaveCount(0);
});
