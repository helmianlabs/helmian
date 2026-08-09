import { chromium } from 'playwright';
const userData = process.env.LOCALAPPDATA + '/Google/Chrome/User Data';
let browser;
try {
  browser = await chromium.launchPersistentContext(userData + '/Default', {
    headless: false,
    channel: 'chrome',
    args: ['--profile-directory=Default'],
    viewport: { width: 1400, height: 900 },
  });
} catch (e) {
  console.log('PERSIST_FAIL', e.message);
  browser = await chromium.launch({ headless: false, channel: 'chrome' });
  browser = await browser.newContext({ viewport: { width: 1400, height: 900 } });
}
const page = browser.pages()[0] || await browser.newPage();
await page.goto('https://discord.com/developers/applications', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(5000);
console.log('URL', page.url());
console.log('TITLE', await page.title());
const text = await page.locator('body').innerText().catch(()=>'');
console.log('BODY', text.slice(0,800).replace(/\n/g,' | '));
await page.screenshot({ path: 'E:/Helmion/artifacts/discord-dev-portal.png' });
console.log('SHOT_OK');
// leave open
await page.waitForTimeout(3000);
