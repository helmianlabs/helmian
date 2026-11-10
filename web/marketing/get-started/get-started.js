import { loadClerkBrowser } from '/herald/account-runtime.js?v=14';

import { planDownloads } from './downloads.mjs';

const PRODUCTS = {
  helmian_individual: { name: 'Helmian for Windows', items: ['exe'] },
  helmian_guard: { name: 'Helmian Guard', items: ['guard'] },
  helmian_bundle: { name: 'Helmian + Guard', items: ['exe', 'guard'] },
};
const GUARD = { name: 'helmian-guard-chromium-0.2.4.zip', url: '/downloads/helmian-guard-chromium-0.2.4.zip' };
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

async function deliver(clerk, email) {
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
  $('#gs-title').textContent = 'Create your account';
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
  let delivered = false;
  // True while the already-signed-in choice below is on screen: the Clerk
  // listener must not mistake the pre-existing session for a just-completed
  // sign-up and deliver behind the visitor's back.
  let gatePending = false;
  const deliverOnce = () => {
    if (delivered) return;
    delivered = true;
    void deliver(clerk, clerk.user?.primaryEmailAddress?.emailAddress ?? '');
  };
  const mountAuthForm = () => {
    gatePending = false;
    status('Already have an account? Use the “Sign in” link inside the form.');
    const mount = $('#gs-clerk'); mount.replaceChildren();
    const opts = { forceRedirectUrl: location.href, signInForceRedirectUrl: location.href };
    if (clerk.mountSignUp) clerk.mountSignUp(mount, opts); else clerk.mountSignIn(mount, opts);
  };
  // Arriving already signed in must not sweep the visitor into the existing
  // workspace: get-started is also how a signed-in user deliberately starts
  // a NEW account. Delivering is one explicit click, and the new-account
  // path ends the current Clerk session first so the sign-up form can
  // register someone else.
  const showSignedInGate = () => {
    gatePending = true;
    const email = clerk.user?.primaryEmailAddress?.emailAddress ?? '';
    $('#gs-title').textContent = 'You are already signed in';
    $('#gs-lede').textContent = email ? `Signed in as ${email}.` : 'Signed in.';
    status('Open your workspace, or sign out here to create a different account.');
    const mount = $('#gs-clerk'); mount.replaceChildren();
    const open = el('button', { type: 'button' }, 'Open my workspace');
    open.addEventListener('click', deliverOnce);
    const fresh = el('button', { type: 'button' }, 'Create a new account');
    fresh.addEventListener('click', async () => {
      open.disabled = true;
      fresh.disabled = true;
      try {
        await clerk.signOut();
      } catch {
        showSignedInGate();
        status('Still signed in — the sign-out did not complete. Try again, or open your workspace.');
        return;
      }
      $('#gs-title').textContent = 'Create your account';
      mountAuthForm();
    });
    mount.append(open, fresh);
  };
  const render = () => {
    if (clerk.isSignedIn) return void showSignedInGate();
    mountAuthForm();
  };
  clerk.addListener?.(() => { if (clerk.isSignedIn && !delivered && !gatePending) deliverOnce(); });
  render();
}
void main();
