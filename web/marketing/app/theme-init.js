// Helmian app — pre-paint theme resolution.
//
// Loaded synchronously in <head> (index.html), before the stylesheets,
// so the saved theme is already on <html data-theme="…"> at the first
// paint and a light-theme user never sees the dark default flash. The
// /app CSP allows external scripts only (script-src 'self', no
// 'unsafe-inline'), so this step cannot be an inline block — the inline
// copy that used to sit in index.html never executed under that CSP,
// and the theme only landed when app.js booted and flipped it.
//
// Behaviour mirrors app.js's store and its 'system' resolution exactly:
// the choice lives at localStorage 'helmian.app.theme' (JSON), 'system'
// follows prefers-color-scheme, and an unreadable or absent value
// falls back to 'midnight', the shipped default. app.js re-asserts the
// same value at boot and owns the theme switch; this file only paints.
try {
  var helmianTheme = JSON.parse(localStorage.getItem('helmian.app.theme')) || 'midnight';
  if (helmianTheme === 'system') helmianTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'midnight';
  document.documentElement.dataset.theme = helmianTheme;
  if (helmianTheme === 'light') document.querySelector('meta[name="theme-color"]').content = '#F4F6F8';
} catch (e) {}
