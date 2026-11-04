import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  ACCOUNT_MENU_ITEMS,
  ISSUE_CONTACT,
  LOGOUT_HREF,
  SHORTCUTS,
  accountIdentityModel,
  downloadsModel,
  reportIssueHref,
} from '../app/account-menu.mjs';

// The bottom-corner account menu: Troy's spec (2026-11-04) is Settings,
// Keyboard shortcuts, Download apps, Report an issue, Log out — in that
// order, with those plain labels.
test('menu items are the five from the spec, in order', () => {
  assert.deepEqual(ACCOUNT_MENU_ITEMS.map((i) => i.id), ['settings', 'shortcuts', 'downloads', 'report', 'logout']);
  assert.deepEqual(ACCOUNT_MENU_ITEMS.map((i) => i.label), ['Settings', 'Keyboard shortcuts', 'Download apps', 'Report an issue', 'Log out']);
});

// Log out rides the one shipped sign-out road (/admin/auth/logout →
// /sign-out handoff → Clerk signOut). The constant, the menu item and
// the anchor rendered in index.html must all be that exact href, so
// the menu can never grow a second sign-out path.
test('log out is the shipped sign-out road, in the model and in the page', async () => {
  assert.equal(LOGOUT_HREF, '/admin/auth/logout?return=/app');
  assert.equal(ACCOUNT_MENU_ITEMS.find((i) => i.id === 'logout').href, LOGOUT_HREF);
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, new RegExp(`<a class="acct-item" role="menuitem" href="${LOGOUT_HREF.replace(/[?]/g, '\\?')}">Log out</a>`));
  assert.doesNotMatch(html, /id="signout"/);
});

test('the page carries the menu, its four panel items, and the panel shell', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const id of ['account-menu-btn', 'account-menu', 'account-panel', 'account-panel-title', 'account-panel-body', 'account-panel-close', 'account-name', 'account-avatar', 'account']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
  for (const item of ['settings', 'shortcuts', 'downloads', 'report']) {
    assert.ok(html.includes(`data-acct-item="${item}"`), `index.html is missing the ${item} menu item`);
  }
  const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(js, /from '\.\/account-menu\.mjs'/);
});

test('identity model shows name, email, workspace and role when all exist', () => {
  const m = accountIdentityModel(
    { tenantId: 'acme-team', role: 'owner' },
    { fullName: 'Troy Shoemaker', primaryEmailAddress: { emailAddress: 'troy@example.com' } },
  );
  assert.equal(m.headline, 'Troy Shoemaker');
  assert.equal(m.initial, 'T');
  assert.equal(m.hasEmail, true);
  assert.deepEqual(m.rows.map((r) => [r.label, r.value]), [
    ['Name', 'Troy Shoemaker'],
    ['Email', 'troy@example.com'],
    ['Workspace', 'acme-team'],
    ['Your role', 'owner'],
  ]);
});

test('identity model invents nothing without a Clerk user', () => {
  const m = accountIdentityModel({ tenantId: '0d7ca4d3-a2f4-458a-936b-d8a002a569e0', role: 'member' }, null);
  assert.equal(m.headline, 'Your account');
  assert.equal(m.hasEmail, false);
  // A raw tenant UUID is never shown to a person (friendlyWorkspace).
  assert.deepEqual(m.rows.map((r) => [r.label, r.value]), [
    ['Workspace', 'your workspace'],
    ['Your role', 'member'],
  ]);
});

test('identity model falls back to first + last name, then to email', () => {
  const byParts = accountIdentityModel({ tenantId: 'x', role: 'admin' }, { firstName: 'Ada', lastName: 'Lynn', primaryEmailAddress: { emailAddress: 'ada@example.com' } });
  assert.equal(byParts.headline, 'Ada Lynn');
  const byEmail = accountIdentityModel({ tenantId: 'x', role: 'admin' }, { primaryEmailAddress: { emailAddress: 'ada@example.com' } });
  assert.equal(byEmail.headline, 'ada@example.com');
  assert.deepEqual(byEmail.rows.map((r) => r.label), ['Email', 'Workspace', 'Your role']);
});

test('downloads model offers Windows only on a vouched https release', () => {
  const rows = downloadsModel({ available: true, name: 'Helmian-Setup-1.0.3-win-x64.exe', url: 'https://github.com/helmianlabs/helmian/releases/download/v1.0.3/Helmian-Setup-1.0.3-win-x64.exe', version: 'v1.0.3' });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.platform), ['Windows', 'Mac', 'Linux']);
  assert.equal(rows[0].ready, true);
  assert.equal(rows[0].version, 'v1.0.3');
  assert.match(rows[0].url, /^https:\/\//);
});

test('downloads model never fakes an installer', () => {
  for (const release of [null, {}, { available: false }, { available: true, url: 'http://insecure.example/x.exe' }, { available: true }]) {
    const rows = downloadsModel(release);
    assert.ok(rows.every((r) => r.ready === false && r.url === null), `expected no ready rows for ${JSON.stringify(release)}`);
    assert.match(rows[0].note, /not available right now/);
  }
  const rows = downloadsModel({ available: true, name: 'x.exe', url: 'https://example.com/x.exe', version: null });
  // Mac and Linux say plainly that they are not available yet.
  assert.match(rows[1].note, /Mac app is not available yet/);
  assert.match(rows[2].note, /Linux app is not available yet/);
});

test('report href composes the product contact email, encoded', () => {
  assert.equal(ISSUE_CONTACT, 'helmianlabs@gmail.com');
  const href = reportIssueHref({ subject: 'Chat broke', details: 'I pressed send & nothing happened', page: '#desktop' });
  assert.ok(href.startsWith(`mailto:${ISSUE_CONTACT}?subject=`));
  assert.ok(href.includes(encodeURIComponent('Chat broke')));
  assert.ok(href.includes(encodeURIComponent('I pressed send & nothing happened')));
  assert.ok(href.includes(encodeURIComponent('Page: #desktop')));
  const bare = reportIssueHref({});
  assert.ok(bare.includes(encodeURIComponent('Helmian issue report')));
  assert.ok(!bare.includes('&body='));
});

test('shortcuts list carries only real bindings, keys and words on every row', () => {
  assert.ok(SHORTCUTS.length >= 8);
  for (const s of SHORTCUTS) {
    assert.ok(s.keys && s.action && s.where, `shortcut row is incomplete: ${JSON.stringify(s)}`);
  }
  const actions = SHORTCUTS.map((s) => s.action).join(' · ');
  assert.match(actions, /Send the message/);
  assert.match(actions, /Close the open menu, picker or dialog/);
});
