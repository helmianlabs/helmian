import { chromium } from 'playwright';
try {
  const browser = await chromium.launch({ headless: false, channel: 'msedge' }).catch(async () => chromium.launch({ headless: false }));
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('https://discord.com/developers/applications', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);
  console.log('URL', page.url());
  console.log('TITLE', await page.title());
  const text = await page.locator('body').innerText().catch(()=>'');
  console.log('BODY', text.slice(0,900).replace(/\n/g,' | '));
  await page.screenshot({ path: 'E:/Helmion/artifacts/discord-dev-portal.png' });
  console.log('SHOT_OK');
  // leave browser open 30s for user
  await page.waitForTimeout(15000);
} catch (e) {
  console.error('FAIL', e.message);
  process.exit(1);
}
