// Helmian marketing theme — pre-paint resolution + header toggle wiring.
//
// Dark is the default (the :root token block in styles.css); light is
// data-theme="light" on <html>, with values from the B0 palette
// (theme-B0-light-palette-2026-11-04.md). Pattern (theme audit §3): system
// by default, explicit choice remembered. The visitor's choice is stored
// per person in localStorage; before any choice, prefers-color-scheme
// decides, and OS changes are followed live until a choice is made.
//
// This file is loaded synchronously in <head> so the attribute and the
// theme-color meta are set before first paint (no flash of wrong theme).
// The site CSP allows external scripts only, so the pre-paint step cannot
// be an inline block; a tiny same-origin file is the compliant form.
(function () {
  var STORAGE_KEY = 'helmian.marketing.theme';
  var LIGHT_CHROME = '#F4F6F8';
  var root = document.documentElement;

  // The page's own shipped theme-color is its dark chrome color (each
  // surface keeps its exact dark value); capture it before any apply.
  var meta = document.querySelector('meta[name="theme-color"]');
  var pageDarkChrome = meta ? meta.getAttribute('content') : '#07111D';
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }

  function storedTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (error) {
      return null;
    }
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function syncToggles(theme) {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      buttons[i].setAttribute(
        'aria-label',
        theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
      );
    }
  }

  function applyTheme(theme, persist) {
    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      root.removeAttribute('data-theme');
    }
    meta.setAttribute('content', theme === 'light' ? LIGHT_CHROME : pageDarkChrome);
    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
      } catch (error) {
        // Storage unavailable (private mode): the choice holds for the page.
      }
    }
    syncToggles(theme);
    return theme;
  }

  function toggleTheme() {
    return applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
  }

  applyTheme(storedTheme() || systemTheme(), false);

  if (window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: light)');
    var onSystemChange = function (event) {
      if (!storedTheme()) applyTheme(event.matches ? 'light' : 'dark', false);
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onSystemChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(onSystemChange);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', toggleTheme);
    }
    syncToggles(currentTheme());
  });

  window.HelmianTheme = {
    apply: function (theme) {
      return applyTheme(theme === 'light' ? 'light' : 'dark', true);
    },
    toggle: toggleTheme,
    current: currentTheme,
  };
})();
