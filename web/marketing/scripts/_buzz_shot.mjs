import { chromium } from 'playwright';
const out = 'E:/Helmion/artifacts/ui-compare';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto('https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out + '/buzz-marketing.png', fullPage: false });
  console.log('BUZZ_OK');
} catch (e) {
  console.log('BUZZ_FAIL', e.message);
}
try {
  await page.goto('https://github.com/block/buzz', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: out + '/buzz-github.png', fullPage: false });
  console.log('GH_OK');
} catch (e) {
  console.log('GH_FAIL', e.message);
}
await browser.close();
