import { expect, test, type Page } from '@playwright/test';
import type { AccessUser, PolicyBinding } from '../src/ui-types';

const ada = 'ada@example.test', bea = 'bea@example.test';
const email = (page: Page) => page.getByLabel('email', { exact: true });
const groups = (page: Page) => page.getByLabel('groups', { exact: true });
const grant = (page: Page) => page.getByRole('checkbox', { name: /team_policy/ });
const row = (page: Page, owner: string) => page.locator('.tableRow').filter({ hasText: owner });
const save = (page: Page) => page.getByRole('button', { name: 'Save user', exact: true });

async function openUsers(page: Page) {
  const users: AccessUser[] = [ada, bea].map((owner, i) => ({ email: owner, role: 'user', tenantId: i ? 'beta' : 'alpha', enabled: true, groups: [i ? 'ops' : 'design'], contentRetentionDisabled: false }));
  const state = {
    users, bindings: [] as PolicyBinding[], writes: [] as {email:string; policyIds:string[]; groups:string[]}[],
    bootstrapReads: 0, admin: 'admin@example.test', reject: false, offline: false,
    write: Promise.withResolvers<void>(), refresh: Promise.withResolvers<void>(),
  };
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'PUT') {
      const owner = decodeURIComponent(path.split('/').at(-1)!);
      expect(path).toBe('/v1/admin/access-user-grants/' + encodeURIComponent(owner));
      const {policyIds, groups} = route.request().postDataJSON();
      state.writes.push({email:owner, policyIds, groups}); await state.write.promise;
      if (state.reject) { await route.fulfill({status:503, json:{error:{message:'Synthetic save failure'}}}); return; }
      const user = state.users.find(u => u.email === owner)!;
      user.groups = groups;
      const bindings = policyIds.map((policyId: string) => ({policyId, principalType:'user' as const, principalId:owner, priority:100, enabled:true}));
      state.bindings = [...state.bindings.filter(b=>b.principalId!==owner), ...bindings];
      await route.fulfill({json:{user, bindings}}); return;
    }
    if (path === '/v1/admin/bootstrap' && ++state.bootstrapReads > 1) {
      await state.refresh.promise;
      if (state.offline) { await route.fulfill({status:503, body:'Synthetic refresh failure'}); return; }
    }
    const responses: Record<string, unknown> = {
      '/v1/session': {authenticated:true, role:'admin', auth:'cloudflare_access', email:state.admin, tenantId:'default', entitlements:{providers:[]}},
      '/v1/providers': {providers:[]}, '/v1/routes': {openaiCompatible:[],manifestProxy:[]},
      '/v1/session/credentials': {credentials:[]}, '/v1/session/usage': {policies:[]},
      '/v1/admin/usage': {policies:[], usage:{ledger:'ready', providers:[], daily:[], events:[], summary:{requestCount:0, totalTokens:0, actualCostMicros:0}}},
      '/v1/admin/bootstrap': {policies:[{policyId:'team_policy',tenantId:'default',enabled:true,providers:[],grantRouting:{eligibleGrants:{}}}],
        credentials:[], connections:[], users:state.users, bindings:state.bindings, grants:[], rules:[], providers:[], tenants:[], overview:null,
        fusion:{enabled:false,adviserModels:[],aggregatorModel:''}},
    };
    await route.fulfill({status:path in responses ? 200 : 404,json:responses[path] ?? {}});
  });
  await page.goto('/dashboard/users'); await expect(email(page)).toHaveValue(ada);
  await expect(page.locator('.connectionMeta strong')).toHaveText('Connected');
  return state;
}

for (const phase of ['sending','refreshing'] as const) {
  test('a newer user draft survives the previous save while ' + phase, async ({page}) => {
    const f = await openUsers(page);
    try {
      await grant(page).check(); await save(page).click();
      await expect.poll(() => f.writes).toEqual([{email:ada, groups:['design'], policyIds:['team_policy']}]);
      if (phase === 'refreshing') { f.write.resolve(); await expect.poll(() => f.bootstrapReads).toBe(2); }
      const search = page.getByPlaceholder('search identities or groups');
      await search.fill('ops'); await row(page, bea).click(); await grant(page).check(); await groups(page).fill('ops, bea-draft');
      f.write.resolve(); f.refresh.resolve();
      await expect(save(page)).toBeEnabled(); await expect(email(page)).toHaveValue(bea); await expect(grant(page)).toBeChecked();
      await expect(groups(page)).toHaveValue('ops, bea-draft'); await expect(row(page,bea)).toHaveClass(/selected/);
      await search.fill(''); await expect(row(page,ada).locator('[data-label="policies"]')).toHaveText('1');
      await expect(row(page,bea).locator('[data-label="policies"]')).toHaveText('0'); expect(f.writes).toHaveLength(1);
    } finally { f.write.resolve(); f.refresh.resolve(); }
  });
}

test('edits made to the same identity after submission survive refresh and are saved only on the next submit', async ({page}) => {
  const f = await openUsers(page);
  try {
    await grant(page).check(); await save(page).click(); await expect.poll(() => f.writes.length).toBe(1);
    f.write.resolve(); await expect.poll(() => f.bootstrapReads).toBe(2);
    await grant(page).uncheck(); await groups(page).fill('later');
    f.refresh.resolve(); await expect(save(page)).toBeEnabled();
    await expect(row(page,ada).locator('[data-label="policies"]')).toHaveText('1');
    await expect(grant(page)).not.toBeChecked(); await expect(groups(page)).toHaveValue('later');
    expect(f.writes).toHaveLength(1); await save(page).click(); await expect.poll(() => f.writes[1]).toEqual({email:ada,groups:['later'],policyIds:[]});
  } finally { f.write.resolve(); f.refresh.resolve(); }
});

test('refresh failure keeps the acknowledged grant and does not reset the replacement editor', async ({page}) => {
  const f = await openUsers(page);
  try {
    await grant(page).check(); await save(page).click(); await expect.poll(() => f.writes.length).toBe(1);
    await row(page,bea).click(); await groups(page).fill('ops, bea-draft'); f.offline=true;
    f.write.resolve(); f.refresh.resolve(); await expect(page.locator('.statusBar')).toContainText('Console data refresh failed');
    await expect(email(page)).toHaveValue(bea); await expect(groups(page)).toHaveValue('ops, bea-draft');
    await expect(row(page,ada).locator('[data-label="policies"]')).toHaveText('1');
    f.offline = false; await page.getByRole('button', {name:'Retry refresh'}).click();
    await expect(page.locator('.connectionMeta strong')).toHaveText('Connected');
    await expect(email(page)).toHaveValue(bea); await expect(groups(page)).toHaveValue('ops, bea-draft'); expect(f.writes).toHaveLength(1);
  } finally { f.write.resolve(); f.refresh.resolve(); }
});

test('failed save is not attached to another user or retried by its reconciliation read', async ({page}) => {
  const f = await openUsers(page);
  try {
    await grant(page).check(); await save(page).click(); await expect.poll(() => f.writes.length).toBe(1);
    await row(page,bea).click(); await groups(page).fill('ops, bea-draft'); f.reject = true;
    f.write.resolve(); f.refresh.resolve(); await expect.poll(() => f.bootstrapReads).toBe(2);
    await expect(page.locator('.statusBar')).toContainText('Synthetic save failure');
    await expect(email(page)).toHaveValue(bea); await expect(groups(page)).toHaveValue('ops, bea-draft');
    await expect(page.locator('.inspector')).not.toContainText('Synthetic save failure'); expect(f.writes).toHaveLength(1);
  } finally { f.write.resolve(); f.refresh.resolve(); }
});

test('a new verified admin session does not inherit the previous save or its draft', async ({page}) => {
  const f = await openUsers(page);
  try {
    await grant(page).check(); await save(page).click(); await expect.poll(() => f.writes.length).toBe(1);
    await row(page,bea).click(); await groups(page).fill('former-session-draft');
    f.admin = 'new-admin@example.test'; f.write.resolve(); f.refresh.resolve();
    await expect(page.locator('.tenantSwitch strong')).toHaveText(f.admin);
    await expect(page.locator('.connectionMeta strong')).toHaveText('Connected'); await expect(email(page)).toHaveValue(ada);
    await row(page,bea).click(); await expect(groups(page)).toHaveValue('ops'); await expect(grant(page)).not.toBeChecked();
    expect(f.writes).toHaveLength(1);
  } finally { f.write.resolve(); f.refresh.resolve(); }
});
