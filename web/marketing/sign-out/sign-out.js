import { loadClerkBrowser } from '/herald/account-runtime.js?v=14';

// The second half of /admin/auth/logout. The server has already revoked the
// Helmian session and cleared its cookie; this page ends the Clerk browser
// session itself, with the same signOut() call the Herald shell's account
// action uses. Without it, the Clerk session on the account host survives
// logout and the next Helmian login silently re-authenticates the same user.
//
// Only the two destinations the logout handler mints are honored — the app
// or the owner console. Anything else falls back to the console, so this
// page can never be used as an open redirect.
const DESTINATIONS = new Set(['/app/', '/admin/']);
const requested = new URLSearchParams(location.search).get('return');
const destination = DESTINATIONS.has(requested) ? requested : '/admin/';

async function main() {
  try {
    const cfg = await (await fetch('/api/herald-config', { headers: { accept: 'application/json' } })).json();
    const account = cfg?.accountIdentity;
    if (account?.configured && account?.publishableKey) {
      const clerk = await loadClerkBrowser(account.publishableKey);
      if (clerk.isSignedIn) await clerk.signOut();
    }
  } catch {
    // Never trap the user here: the Helmian session is already revoked, so
    // landing on the destination signed out of Helmian is still correct —
    // it just degrades to the old behavior for this one sign-out.
  }
  location.replace(destination);
}
void main();
