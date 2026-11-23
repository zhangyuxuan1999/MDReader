// public/theme-boot.js — applies the persisted theme before first paint so there is no light/dark
// flash. Deliberately a separate, render-blocking classic script and NOT an inline <script>: the
// desktop shell serves the renderer with a strict Content-Security-Policy (electron/protocol.mjs),
// and `script-src 'self' app:` must hold without 'unsafe-inline'. Keep it in sync with
// src/app/theme.ts (LS_THEME = 'mdr.theme').
(function () {
  try {
    var p = localStorage.getItem('mdr.theme');
    var dark = p === 'dark' || (p !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
