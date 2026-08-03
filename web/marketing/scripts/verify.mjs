import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const css = await readFile(resolve(root, 'styles.css'), 'utf8');
const config = await readFile(resolve(root, 'site-config.js'), 'utf8');
const heraldHtml = await readFile(resolve(root, 'herald/index.html'), 'utf8');
const heraldManifestText = await readFile(resolve(root, 'herald/manifest.webmanifest'), 'utf8');
const heraldWorker = await readFile(resolve(root, 'herald/sw.js'), 'utf8');
const heraldShell = await readFile(resolve(root, 'herald/shell.js'), 'utf8');
const legacyHeraldApp = await readFile(resolve(root, 'herald/app.js'), 'utf8');

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

for (const id of ['product', 'workflow', 'security', 'demos', 'contact']) {
  expect(html.includes(`id="${id}"`), `missing #${id} section`);
}

for (const slot of ['desktop-overview', 'guard-review', 'project-flow']) {
  expect(html.includes(`data-video-key="${slot}"`), `missing ${slot} video slot`);
  expect(config.includes(`'${slot}'`), `missing ${slot} video configuration`);
}

for (const media of [
  'media/helmian-desktop-overview.mp4',
  'media/helmian-desktop-overview.jpg',
  'media/helmian-guard-review.mp4',
  'media/helmian-guard-review.jpg',
]) {
  try { await access(resolve(root, media)); }
  catch { failures.push(`missing configured demo media: /${media}`); }
}

for (const claim of [
  /SOC\s*2\s*(certified|compliant)/i,
  /trusted by/i,
  /\bcustomers?\s+love\b/i,
  /\bguaranteed\b/i,
  /\bmarket[- ]leading\b/i,
]) {
  expect(!claim.test(html), `unsupported marketing claim matched ${claim}`);
}

expect(html.includes('Unknown, not safe'), 'unknown-state language is missing');
expect(html.includes('does not claim certification'), 'claim boundary is missing');
expect(css.includes('--accent: #65d5f5'), 'Midnight accent must match the desktop palette');
expect(!/<script(?![^>]*\bsrc=)/i.test(html), 'inline script found; keep the CSP strict');
expect(!/<style\b/i.test(html), 'inline style found; keep presentation in styles.css');

for (const id of ['appShell', 'workspace', 'contextDrawer', 'composer', 'messageInput', 'shortcutsDialog']) {
  expect(heraldHtml.includes(`id="${id}"`), `Helmian PWA is missing #${id}`);
}
expect(!/<script(?![^>]*\bsrc=)/i.test(heraldHtml), 'inline PWA script found; keep the CSP strict');
expect(!/<style\b/i.test(heraldHtml), 'inline PWA style found; keep presentation in styles.css');
expect(/<main class="workspace" id="workspace">/.test(heraldHtml), 'Helmian workspace must render without identity or pairing');
for (const visibleSurface of [
  'Projects', 'Console', 'Browser', 'Canvas', 'Preview', 'Create', 'Integrations',
  'Guard', 'Review &amp; History', 'TEAM COLLABORATION', 'MAESTRO',
  'Disconnected', 'Desktop not connected', 'Team providers not connected',
  'Connect Slack', 'Connect Discord', 'Unknown, not safe',
]) {
  expect(heraldHtml.includes(visibleSurface), `Helmian visible workspace surface is missing: ${visibleSurface}`);
}
for (const misleading of ['Personal Pilot', 'Helmian Remote Control', 'NOT PAIRED', 'Connect this remote console']) {
  expect(!heraldHtml.includes(misleading), `legacy pairing-first copy remains visible: ${misleading}`);
}
for (const asset of ['/herald/styles.css', '/herald/shell.js', '/herald/icons.svg', '/herald/manifest.webmanifest']) {
  expect(heraldHtml.includes(asset), `PWA must use a clean-URL-safe absolute asset path: ${asset}`);
}
expect(heraldShell.includes('!remoteTransport || !selectedControl'), 'PWA send moment must require a selected live account transport');
expect(heraldShell.includes("'Accepted by the secure relay; waiting for Desktop acknowledgement.'"), 'PWA must distinguish relay acceptance from Desktop completion');
expect(legacyHeraldApp.includes("createHeraldTransport"), 'secure Herald transport integration source must remain intact');
expect(legacyHeraldApp.includes("approval.decide"), 'secure Herald approval integration source must remain intact');
expect(heraldWorker.includes("url.pathname.startsWith('/api/')"), 'PWA service worker must bypass every API request');
try {
  const manifest = JSON.parse(heraldManifestText);
  expect(manifest.scope === '/herald/', 'PWA manifest scope must stay inside /herald/');
  expect(manifest.name === 'Helmian', 'PWA manifest must use the Helmian product name');
  expect(manifest.display === 'standalone', 'PWA manifest must remain installable');
  expect(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'PWA manifest icon is missing');
} catch {
  failures.push('Herald manifest must be valid JSON');
}

const localReferences = [...html.matchAll(/(?:href|src)="(?!https?:|#|\/\/)([^"#?]+)"/g)]
  .map((match) => match[1]);
for (const path of new Set(localReferences)) {
  // path is a site-root-relative URL (e.g. "/herald/"), never a filesystem
  // path — resolve() treats a leading "/" as drive-absolute on Windows and
  // silently checks the wrong location, so it must be stripped first.
  const relative = path.replace(/^\/+/, '');
  try { await access(resolve(root, relative)); }
  catch { failures.push(`missing local asset: /${relative}`); }
}

const heraldReferences = [...heraldHtml.matchAll(/(?:href|src)="(?!https?:|#|\/\/)([^"#?]+)"/g)]
  .map((match) => match[1]);
for (const path of new Set(heraldReferences)) {
  const localPath = path.startsWith('/') ? resolve(root, path.slice(1)) : resolve(root, 'herald', path);
  try { await access(localPath); }
  catch { failures.push(`missing Herald asset: /herald/${path}`); }
}

if (failures.length > 0) {
  console.error(`Marketing verification failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Marketing and Helmian PWA verification passed: honest local states, complete navigation, preserved secure source, offline shell, and themes.');
}
