// Unplug — the two things every public form sends besides its own fields.
//
// A form token, fetched when the page loads and posted back on submit. It
// carries two signals that cost a reader nothing and are worth more than any
// amount of keyword matching:
//
//   1. JavaScript ran. Something posting straight to the endpoint has no
//      token, because getting one means making a request first.
//   2. How long the form was open. People read, think and type. Two seconds
//      from load to submit is not a person.
//
// NEITHER BLOCKS ANYTHING. The server treats a missing token as one small
// signal among several — worth a few points, nowhere near enough on its own.
// So a reader with JavaScript disabled, or on a browser that fails to fetch
// this, still gets through. That is deliberate: a contact form that silently
// refuses people is worse than one that receives some spam.
//
// The honeypot field is added the same way, so every form gets both without
// each one having to remember.

window.UnplugForms = (function () {
  'use strict';

  var token = null;
  var fetched = false;

  function apiBase() {
    try {
      return (window.UnplugAPI && UnplugAPI.getApiBase && UnplugAPI.getApiBase())
        || 'https://unplug-ecosystem.onrender.com';
    } catch (e) {
      return 'https://unplug-ecosystem.onrender.com';
    }
  }

  // Fetched once per page load. The token records WHEN it was issued, so
  // asking early is the point — that is what makes the elapsed time mean
  // something.
  function load() {
    if (fetched) return;
    fetched = true;
    fetch(apiBase() + '/spam/form-token')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.formToken) token = d.formToken; })
      .catch(function () {
        // Silent. No token simply means the server scores this submission a
        // few points higher, and the reader never knows or suffers for it.
      });
  }

  // Adds the token and the honeypot to whatever is about to be posted.
  //
  //   body = UnplugForms.decorate({ name: ..., email: ... })
  function decorate(body) {
    var out = body || {};
    if (token) out.formToken = token;
    // The trap: a field no person sees. Sent empty, always. Naive bots fill
    // every field they find, and the server treats a filled one as conclusive.
    if (out.website === undefined) out.website = '';
    return out;
  }

  // For forms built as real <form> elements: adds a hidden honeypot input so
  // the field exists in the DOM for a bot to find.
  //
  // Positioned off-screen rather than display:none — some bots skip fields
  // that are not rendered at all, and the point is for them to find it.
  function attachHoneypot(form) {
    if (!form || form.querySelector('input[name="website"]')) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.name = 'website';
    input.tabIndex = -1;
    input.autocomplete = 'off';
    input.setAttribute('aria-hidden', 'true');
    input.style.cssText = 'position:absolute; left:-9999px; width:1px; height:1px; opacity:0;';
    form.appendChild(input);
  }

  function attachAll() {
    var forms = document.querySelectorAll('form:not([data-no-honeypot])');
    for (var i = 0; i < forms.length; i++) attachHoneypot(forms[i]);
  }

  load();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachAll);
  } else {
    attachAll();
  }

  return {
    decorate: decorate,
    attachHoneypot: attachHoneypot,
    attachAll: attachAll,
    hasToken: function () { return Boolean(token); },
    _setToken: function (t) { token = t; },   // for tests
  };
})();
