import { loadClerkBrowser } from '/herald/account-runtime.js?v=14';

const PRODUCTS = {
  helmian_individual: { name: 'Helmian for Windows', items: ['exe'] },
  helmian_guard: { name: 'Helmian Guard', items: ['guard'] },
  helmian_bundle: { name: 'Helmian + Guard', items: ['exe', 'guard'] },
};
const GUARD = { name: 'helmian-guard-0.2.3.zip', url: '/downloads/helmian-guard-0.2.3.zip' };
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const key = PRODUCTS[params.get('product')] ? params.get('product') : 'helmian_individual';
const product = PRODUCTS[key];

function el(tag, attrs = {}, text = '') { const n = document.createElement(tag); Object.assign(n, attrs); if (text) n.textContent = text; return n; }
function status(text) { const s = $('#gs-status'); s.replaceChildren(el('p', {}, text)); }

async function exeRelease() {
  try { const r = await fetch('/api/latest-release', { headers: { accept: 'application/json' } }); return r.ok ? await r.json() : { available: false }; } catch { return { available: false }; }
}

function startDownload(url) { const a = el('a', { href: url, download: '' }); document.body.append(a); a.click(); a.remove(); }

async function deliver(email) {
  $('#gs-clerk').replaceChildren();
  $('#gs-title').textContent = `You're signed up. Here's ${product.name}.`;
  $('#gs-lede').textContent = email ? `Signed in as ${email}.` : 'Signed in.';
  const box = $('#gs-downloads'); box.hidden = false; box.replaceChildren();
  let auto = null;
  for (const item of product.items) {
    const card = el('article', { className: 'feature-card' });
    if (item === 'guard') {
      card.append(el('h3', {}, 'Helmian Guard (browser extension)'), el('p', {}, 'Unzip it, then load it in Chrome or Edge via Extensions → Developer mode → Load unpacked. Store listings are not live yet.'));
      card.append(el('a', { className: 'button button-primary', href: GUARD.url, download: '' }, `Download ${GUARD.name}`));
      auto ??= GUARD.url;
    } else {
      const rel = await exeRelease();
      card.append(el('h3', {}, 'Helmian for Windows'));
      if (rel.available) {
        card.append(el('p', {}, `Version ${rel.version ?? ''}. Windows may show a SmartScreen notice for new apps: choose More info, then Run anyway.`));
        card.append(el('a', { className: 'button button-primary', href: rel.url }, `Download ${rel.name}`));
        auto ??= rel.url;
      } else {
        card.append(el('p', {}, `The Windows installer is coming soon. You're on the list${email ? ` and we'll email ${email}` : " and we'll email you"} as soon as it's ready.`));
      }
    }
    box.append(card);
  }
  status(auto ? 'Your download should start automatically. If it doesn’t, use the button below.' : 'Thanks for signing up!');
  if (auto) startDownload(auto);
}

async function main() {
  $('#gs-title').textContent = `Create your free account to get ${product.name}`;
  let clerk;
  try {
    const cfg = await (await fetch('/api/herald-config', { headers: { accept: 'application/json' } })).json();
    const account = cfg?.accountIdentity;
    if (!account?.configured || !account?.publishableKey) throw new Error('sign-up is not configured');
    clerk = await loadClerkBrowser(account.publishableKey);
  } catch {
    status('Sign-up is temporarily unavailable. Please try again shortly.');
    return;
  }
  const render = () => {
    if (clerk.isSignedIn) return void deliver(clerk.user?.primaryEmailAddress?.emailAddress ?? '');
    status('Already have an account? Use the “Sign in” link inside the form.');
    const mount = $('#gs-clerk'); mount.replaceChildren();
    const opts = { forceRedirectUrl: location.href, signInForceRedirectUrl: location.href };
    if (clerk.mountSignUp) clerk.mountSignUp(mount, opts); else clerk.mountSignIn(mount, opts);
  };
  let delivered = false;
  clerk.addListener?.(() => { if (clerk.isSignedIn && !delivered) { delivered = true; render(); } });
  if (clerk.isSignedIn) delivered = true;
  render();
}
void main();
