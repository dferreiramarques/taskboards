/* nimbleUI theme helper (no deps, CSP-safe: load as an external script in <head>, no inline code).
   Preference = auto | light | dark, stored in localStorage('nimble-theme'; absent = auto).
   Sets <html data-theme="light|dark"> (resolved) and data-theme-pref (the preference).
   Buttons: [data-theme-toggle] flips the resolved theme (explicit); [data-theme-set="auto|light|dark"] sets it
   and gets aria-pressed. Fires document 'nimble:theme' {theme, pref} after every change. Add data-theme-icon to a toggle for an auto sun/moon icon. <meta name="nimble-theme-key" content="my-key"> reuses an existing storage key. Accent: <html data-accent="rose|indigo"> (omit for emerald). */
(function () {
  var root = document.documentElement, KEY = 'nimble-theme';
  var metaKey = document.querySelector('meta[name="nimble-theme-key"]');   // optional: reuse an app's existing storage key
  if (metaKey && metaKey.content) KEY = metaKey.content;
  var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  var MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
  function pref() {   // 'light' | 'dark' | 'auto'; a quoted JSON value ("dark") or anything else is read leniently
    try { var v = String(localStorage.getItem(KEY) || '').replace(/^"|"$/g, ''); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function resolve(p) { return p === 'auto' ? (mq.matches ? 'dark' : 'light') : p; }
  function apply() {
    var p = pref();
    root.setAttribute('data-theme', resolve(p));
    root.setAttribute('data-theme-pref', p);
    var bs = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i].getAttribute('data-theme-set') === p));
    // [data-theme-toggle][data-theme-icon]: shows the icon of the theme you would switch TO (in the button, or in a .theme-ico inside it)
    var ic = document.querySelectorAll('[data-theme-toggle][data-theme-icon]'), dark = root.getAttribute('data-theme') === 'dark';
    for (var j = 0; j < ic.length; j++) (ic[j].querySelector('.theme-ico') || ic[j]).innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (dark ? SUN : MOON) + '</svg>';
    document.dispatchEvent(new CustomEvent('nimble:theme', { detail: { theme: root.getAttribute('data-theme'), pref: p } }));   // apps can repaint their own icons/labels
  }
  function set(p) {
    try { if (p === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch (e) {}
    apply();
  }
  apply();
  if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply);
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-theme-toggle],[data-theme-set]');
    if (!t) return;
    if (t.hasAttribute('data-theme-toggle')) set(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    else set(t.getAttribute('data-theme-set'));
  });
  window.NimbleTheme = { get: pref, set: set };
})();
