// Unplug — floating site buttons.
//
// A small, always-visible stack of admin-configured CTA buttons (icon +
// label + link) in the bottom-right corner of every page that loads this
// file. Distinct from unplug-popups.js: a popup interrupts on a scroll
// trigger and can be dismissed away; these are meant to always be
// reachable, the way a WhatsApp chat bubble or a "back to top" button is —
// no dismissal, no frequency capping, no consent gate (nothing personal is
// collected or shown).
//
// One script, no dependencies, no build step. If this file fails to load,
// or the endpoint is unreachable, or the visitor is offline, nothing
// appears and the page is unaffected — the same failure contract as
// unplug-popups.js.

(function () {
  'use strict';

  var API = (function () {
    try {
      return (localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem.onrender.com')
        .replace(/\/$/, '');
    } catch (e) {
      return 'https://unplug-ecosystem.onrender.com';
    }
  })();

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render(buttons) {
    var host = document.createElement('div');
    host.id = 'unplugSiteButtons';
    // z-index 900: above ordinary page content, but below every full-screen
    // overlay on this site (welcome gate 1000, consent bar 1100, search
    // overlay 99997+) — a floating button must never sit visually on top of
    // a modal that is supposed to have the visitor's full attention.
    host.style.cssText =
      'position:fixed; right:14px; bottom:14px; z-index:900;'
      + 'display:flex; flex-direction:column; gap:8px; align-items:flex-end;';

    buttons.forEach(function (b) {
      var a = document.createElement('a');
      a.href = b.url;
      // An internal link (e.g. "unplug-magazine.html?p=directory") behaves
      // like any other in-site navigation; only an external one opens a new
      // tab, so a visitor is never unexpectedly taken off the page they were
      // reading by a corner button they weren't focused on.
      var isExternal = /^https?:\/\//i.test(b.url) && !new RegExp('^https?://' + window.location.hostname).test(b.url);
      if (isExternal) { a.target = '_blank'; a.rel = 'noopener'; }
      a.style.cssText =
        'display:flex; align-items:center; gap:6px; padding:10px 16px;'
        + 'background:var(--ink,#0F0E0E); color:var(--cream,#FAF6F0); text-decoration:none;'
        + 'border-radius:24px; font-size:13px; font-weight:700; white-space:nowrap;'
        + 'box-shadow:0 6px 20px rgba(0,0,0,0.25);';
      a.innerHTML = (b.icon ? '<span aria-hidden="true">' + escapeHtml(b.icon) + '</span>' : '')
        + '<span>' + escapeHtml(b.label) + '</span>';
      host.appendChild(a);
    });

    document.body.appendChild(host);
  }

  function init() {
    fetch(API + '/site-buttons')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { if (Array.isArray(list) && list.length) render(list); })
      .catch(function () { /* no buttons is the correct failure */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
