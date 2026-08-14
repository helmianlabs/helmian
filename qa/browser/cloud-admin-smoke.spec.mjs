import { test, expect } from '@playwright/test';

test.describe('Helmian Cloud authenticated fixture smoke', () => {
  test('member sees Envoy/Cora/preparation surfaces without Admin controls', async ({ page }) => {
    await page.goto('/admin/?envoy=empty');
    await expect(page.getByText('Maestro workspace')).toBeVisible();
    await expect(page.getByText('No Envoy channels are available for this Organization.')).toBeVisible();
    await expect(page.locator('[data-admin-only]')).toBeHidden();
    await expect(page.getByText('Internal tenant usage ledger only.')).toBeVisible();
    await expect(page.getByText('Preview intent prepared; no agent, provider, filesystem, build, or external execution occurred.')).toBeVisible();
  });

  test('admin visibility is role-aware and revoked Envoy is explicit', async ({ page }) => {
    await page.goto('/admin/?role=admin&envoy=revoked');
    await expect(page.locator('[data-admin-only]')).toBeVisible();
    await expect(page.getByText('Envoy membership was revoked. Sign in again.')).toBeVisible();
    await expect(page.getByText('No audited status')).toHaveCount(6);
  });

  test('member keeps the authenticated shell when Envoy storage is unavailable', async ({ page }) => {
    await page.goto('/admin/?envoy=unavailable');
    await expect(page.locator('#signed-in')).toBeVisible();
    await expect(page.getByText('Envoy unavailable: the authenticated chat store is not ready.')).toBeVisible();
    await expect(page.getByText('Cora prepare desk')).toBeVisible();
  });

  test('member keeps the authenticated shell when control surface storage is unavailable', async ({ page }) => {
    await page.goto('/admin/?control=unavailable&envoy=empty');
    await expect(page.locator('#signed-in')).toBeVisible();
    await expect(page.locator('#result')).toHaveText('Control surface unavailable: authenticated storage/readiness is not configured.');
    await expect(page.getByText('Cora prepare desk')).toBeVisible();
  });

  test('member can prepare a bounded Cora request and sees a not-executed receipt', async ({ page }) => {
    await page.goto('/admin/?envoy=empty');
    await page.getByLabel('Cora preparation goal').fill('Prepare an internal orientation outline');
    await page.getByLabel('Cora preparation context').fill('training-draft-1');
    await page.getByRole('button', { name: 'Prepare request' }).click();
    await expect(page.getByText(/Prepared receipt recorded.*fixture-cora-receipt.*execution not_performed/u)).toBeVisible();
    await expect(page.getByText('Cora preparation request recorded. Prepared only; nothing was executed.')).toBeVisible();
  });

  test('member can recheck read-only Organization readiness without execution', async ({ page }) => {
    await page.goto('/admin/?envoy=empty');
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText('Read-only readiness rechecked. No action, agent, provider, or external write was performed.')).toBeVisible();
  });

  test.fixme('visual baselines are not generated in this source-only pass', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page).toHaveScreenshot('cloud-admin-member.png', { animations: 'disabled' });
  });
});
