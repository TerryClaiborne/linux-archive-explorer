'use strict';

(function () {
  function storedTheme() {
    try { return localStorage.getItem('lae-theme') === 'dark' ? 'dark' : 'light'; }
    catch (_) { return 'light'; }
  }
  function setTheme(theme) {
    const chosen = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = chosen;
    try { localStorage.setItem('lae-theme', chosen); } catch (_) {}
    document.querySelectorAll('[data-theme-preload-toggle]').forEach((button) => {
      button.textContent = chosen === 'dark' ? '☀ Light' : '☾ Dark';
      button.setAttribute('aria-label', chosen === 'dark' ? 'Switch to Light mode' : 'Switch to Dark mode');
      button.title = chosen === 'dark' ? 'Switch to Light mode' : 'Switch to Dark mode';
    });
  }

  setTheme(storedTheme());
  document.addEventListener('DOMContentLoaded', () => {
    setTheme(document.documentElement.dataset.theme || storedTheme());
    document.querySelectorAll('[data-theme-preload-toggle]').forEach((button) => {
      button.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    });
  }, { once: true });
})();
