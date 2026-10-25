import { loadClerkBrowser } from '/herald/account-runtime.js?v=14';
import { planDownloads } from './downloads.mjs';

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
  $('#gs-title').textContent = 'Setting up your workspace...';
  $('#gs-lede').textContent = email ? `Signed in as ${email}.` : 'Signed in.';
  status('Creating your trial workspace. This takes a moment.');

  try {
    // Get Clerk session token for the signup API call
    const token = await clerk.session?.getToken?.();
    const headers = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    const res = await fetch('/api/signup', { method: 'POST', headers });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Signup failed');
    }

    // Deliver what the product includes. The Windows installer starts only
    // when /api/latest-release reports a real published release; until one
    // exists the page says so plainly instead of firing a dead download.
    const plan = planDownloads({
      items: product.items,
      release: product.items.includes('exe') ? await exeRelease() : null,
      guard: GUARD,
    });
    const box = $('#gs-downloads');
    box.replaceChildren();
    let started = null;
    for (const entry of plan) {
      if (entry.ready) {
        const line = el('p');
        line.append(el('a', { href: entry.url, download: '' }, `Download ${entry.name}`));
        box.append(line);
        if (!started) started = entry;
      } else if (entry.kind === 'exe') {
        box.append(el('p', {}, 'Helmian for Windows is not published yet, so there is no installer to download today. Your workspace is ready in the web app.'));
      }
    }
    if (plan.length) box.hidden = false;
    if (started) startDownload(started.url);

    // Success: redirect to /app
    $('#gs-title').textContent = 'You are all set.';
    $('#gs-lede').textContent = data.created
      ? 'Your trial workspace is ready.'
      : 'Welcome back.';
    status(started ? `Your download of ${started.name} has started. Taking you to Helmian...` : 'Taking you to Helmian...');
    setTimeout(() => { location.href = '/app'; }, 1500);
  } catch (err) {
    $('#gs-title').textContent = 'Something went wrong';
    $('#gs-lede').textContent = err.message || 'Could not create your workspace.';
    status('Please try refreshing the page.');
  }
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
