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
    await expect(page.locator('#agent-cards .agent-status')).toHaveCount(5);
  });

  test('admin can apply a real workspace preset and persist it', async ({ page }) => {
    await page.goto('/admin/?role=admin');
    await page.getByRole('button', { name: 'Workspace settings' }).click();
    await page.getByRole('button', { name: 'Focus prepare' }).click();
    await expect(page.locator('#workspace-layout-status')).toHaveText('Workspace layout loaded for this signed-in user.');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#section-chat')).toBeVisible();
    await expect(page.locator('#section-cora')).toBeHidden();
    await expect(page.locator('#section-prepare')).toBeVisible();
  });

  test.fixme('visual baselines are not generated in this source-only pass', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page).toHaveScreenshot('cloud-admin-member.png', { animations: 'disabled' });
  });
});
