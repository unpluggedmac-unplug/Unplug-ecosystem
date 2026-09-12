// Unplug account + checkout continuity helpers.
//
// This file is loaded site-wide by /runtime-config. It has two deliberately
// small jobs:
//   1. Give every USER-facing standalone portal a Sign In / Sign Out control
//      without replacing the richer account controls that already exist on the
//      magazine shell, Member Dashboard or admin workspaces.
//   2. Keep checkout state intact while a customer reads the real Terms page.
//      The Terms open in a separate same-origin tab; accepting there signals
//      the original checkout tab, checks its existing mandatory checkbox, and
//      returns focus to checkout. The backend Terms gate remains unchanged.
(function unplugAccountAndTermsTools() {
  'use strict';

  if (window.__unplugAccountAndTermsToolsInstalled) return;
  window.__unplugAccountAndTermsToolsInstalled = true;

  var TOKEN_KEY = 'unplug_auth_token';
  var REVIEW_KEY = 'unplug_terms_review_request';
  var ACCEPT_KEY = 'unplug_terms_accept_payload';
  var REVIEW_MAX_AGE_MS = 30 * 60 * 1000;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function apiBase() {
    var configured = String(window.UNPLUG_RUNTIME_API || '').replace(/\/$/, '');
    if (configured) return configured;
    try {
      return String(localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem.onrender.com').replace(/\/$/, '');
    } catch (_) {
      return 'https://unplug-ecosystem.onrender.com';
    }
  }

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
    if (window.UnplugAPI && typeof window.UnplugAPI.setToken === 'function') {
      try { window.UnplugAPI.setToken(value || null); } catch (_) {}
    }
  }

  function jsonStorageGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }

  function jsonStorageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function pathName() {
    return String(location.pathname || '').toLowerCase();
  }

  function isAdminWorkspace() {
    var p = pathName();
    return p.indexOf('unplug-admin-dashboard') !== -1 || p.indexOf('unplug-agreements-admin') !== -1;
  }

  function hasFirstPartyAccountUi() {
    var p = pathName();
    return !!document.getElementById('navAccount') ||
      p.indexOf('unplug-member-dashboard') !== -1 ||
      p.indexOf('offline.html') !== -1 ||
      p === '/' || p.slice(-10) === '/index.html';
  }

  function makeButton(label) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = 'border:1px solid currentColor;background:transparent;color:inherit;border-radius:999px;padding:6px 10px;font:700 11px/1.2 Inter,Arial,sans-serif;cursor:pointer;white-space:nowrap;';
    return btn;
  }

  function ensurePortalAccountHost() {
    if (isAdminWorkspace() || hasFirstPartyAccountUi()) return null;
    var existing = document.getElementById('unplugPortalAccount');
    if (existing) return existing;

    var host = document.createElement('div');
    host.id = 'unplugPortalAccount';
    host.setAttribute('aria-live', 'polite');
    host.style.cssText = 'display:flex;align-items:center;gap:8px;font:600 11.5px/1.3 Inter,Arial,sans-serif;color:inherit;';

    var topbar = document.querySelector('.topbar');
    if (topbar) {
      topbar.appendChild(host);
    } else {
      host.style.cssText += 'position:fixed;top:12px;right:12px;z-index:2147483000;background:#111;color:#fff;padding:7px 10px;border-radius:999px;box-shadow:0 3px 14px rgba(0,0,0,.2);';
      document.body.appendChild(host);
    }
    return host;
  }

  function renderPortalAccount(user) {
    var host = ensurePortalAccountHost();
    if (!host) return;
    host.textContent = '';

    if (user && user.email) {
      var who = document.createElement('span');
      who.textContent = 'Signed in as ' + user.email;
      who.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      host.appendChild(who);

      var out = makeButton('Sign Out');
      out.addEventListener('click', function () {
        setToken(null);
        renderPortalAccount(null);
        window.dispatchEvent(new CustomEvent('unplug:auth-changed', { detail: { user: null } }));
      });
      host.appendChild(out);
      return;
    }

    var signIn = makeButton('Sign In');
    signIn.addEventListener('click', function () {
      var loginCard = document.getElementById('loginCard');
      if (loginCard && !loginCard.classList.contains('section-hidden')) {
        loginCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var email = document.getElementById('loginEmail');
        if (email) setTimeout(function () { email.focus(); }, 250);
        return;
      }
      openSignInDialog();
    });
    host.appendChild(signIn);
  }

  async function restorePortalAccount() {
    if (isAdminWorkspace() || hasFirstPartyAccountUi()) return;
    var token = getToken();
    if (!token) {
      renderPortalAccount(null);
      return;
    }
    try {
      var res = await fetch(apiBase() + '/auth/me', {
        headers: { Authorization: 'Bearer ' + token }
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.user) throw new Error('session expired');
      if (window.UnplugAPI && typeof window.UnplugAPI.setToken === 'function') {
        try { window.UnplugAPI.setToken(token); } catch (_) {}
      }
      renderPortalAccount(body.user);
    } catch (_) {
      setToken(null);
      renderPortalAccount(null);
    }
  }

  function closeSignInDialog() {
    var overlay = document.getElementById('unplugPortalLoginOverlay');
    if (overlay) overlay.remove();
  }

  function openSignInDialog() {
    if (document.getElementById('unplugPortalLoginOverlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'unplugPortalLoginOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Sign in to Unplug');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483400;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:18px;';

    var card = document.createElement('div');
    card.style.cssText = 'width:min(430px,100%);background:#f3efe7;color:#111;border:1px solid rgba(0,0,0,.18);box-shadow:0 20px 60px rgba(0,0,0,.35);padding:26px;border-radius:10px;font-family:Inter,Arial,sans-serif;';

    var title = document.createElement('h2');
    title.textContent = 'Sign In to Unplug';
    title.style.cssText = 'margin:0 0 6px;font:800 24px/1.15 Georgia,serif;';
    card.appendChild(title);

    var note = document.createElement('p');
    note.textContent = 'Use your Unplug member account. You will stay on this page after signing in.';
    note.style.cssText = 'margin:0 0 18px;color:#5e5a54;font-size:13px;line-height:1.5;';
    card.appendChild(note);

    function field(labelText, type, autocomplete) {
      var wrap = document.createElement('label');
      wrap.style.cssText = 'display:block;margin:0 0 12px;font-size:12px;font-weight:700;';
      var label = document.createElement('span');
      label.textContent = labelText;
      label.style.cssText = 'display:block;margin-bottom:5px;';
      var input = document.createElement('input');
      input.type = type;
      input.autocomplete = autocomplete;
      input.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #c8c1b6;background:#fff;color:#111;padding:11px 12px;border-radius:6px;font:400 16px/1.2 Inter,Arial,sans-serif;';
      wrap.appendChild(label);
      wrap.appendChild(input);
      card.appendChild(wrap);
      return input;
    }

    var email = field('Email', 'email', 'email');
    var password = field('Password', 'password', 'current-password');

    var error = document.createElement('div');
    error.setAttribute('role', 'alert');
    error.style.cssText = 'display:none;margin:0 0 12px;padding:9px 10px;background:#fdeceb;border:1px solid #f3c6c3;color:#b00020;border-radius:6px;font-size:12.5px;';
    card.appendChild(error);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px;';
    var cancel = makeButton('Cancel');
    cancel.style.color = '#111';
    var submit = makeButton('Sign In');
    submit.style.cssText += 'background:#111;color:#fff;border-color:#111;padding:9px 16px;';
    row.appendChild(cancel);
    row.appendChild(submit);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    cancel.addEventListener('click', closeSignInDialog);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSignInDialog(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key !== 'Escape' || !document.getElementById('unplugPortalLoginOverlay')) return;
      document.removeEventListener('keydown', onKey);
      closeSignInDialog();
    });

    async function submitLogin() {
      error.style.display = 'none';
      var address = email.value.trim();
      var secret = password.value;
      if (!address || !secret) {
        error.textContent = 'Email and password are required.';
        error.style.display = 'block';
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      try {
        var res = await fetch(apiBase() + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: address, password: secret })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.token) throw new Error(data.error || 'Could not sign in.');
        setToken(data.token);
        closeSignInDialog();
        renderPortalAccount(data.user || { email: address });
        window.dispatchEvent(new CustomEvent('unplug:auth-changed', { detail: { user: data.user || { email: address } } }));
      } catch (err) {
        error.textContent = err.message || 'Could not sign in.';
        error.style.display = 'block';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Sign In';
      }
    }

    submit.addEventListener('click', submitLogin);
    password.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitLogin(); });
    setTimeout(function () { email.focus(); }, 0);
  }

  function termsCheckbox() {
    return document.getElementById('termsAcceptChk');
  }

  function termsPaymentCardVisible() {
    var gate = document.getElementById('termsGate');
    if (!gate) return false;
    var payment = document.getElementById('paymentCard');
    if (!payment) return true;
    return !payment.classList.contains('section-hidden');
  }

  function applyTermsAcceptance() {
    var checkbox = termsCheckbox();
    if (!checkbox || !termsPaymentCardVisible()) return false;
    checkbox.disabled = false;
    checkbox.checked = true;
    var row = document.getElementById('termsAcceptRow');
    if (row) row.style.opacity = '1';
    var hint = document.getElementById('termsHint');
    if (hint) {
      hint.textContent = 'Terms accepted — you can continue with checkout.';
      hint.style.color = '#1f7a34';
      hint.style.fontWeight = '700';
    }
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function currentUrlMatches(returnUrl) {
    if (!returnUrl) return false;
    try {
      var wanted = new URL(returnUrl, location.href);
      var current = new URL(location.href);
      wanted.searchParams.delete('terms_accept');
      current.searchParams.delete('terms_accept');
      return wanted.origin === current.origin && wanted.pathname === current.pathname && wanted.search === current.search;
    } catch (_) { return false; }
  }

  function reviewIsFresh(payload) {
    return payload && payload.acceptedAt && (Date.now() - Number(payload.acceptedAt)) <= REVIEW_MAX_AGE_MS;
  }

  function removeTermsAcceptParam() {
    try {
      var url = new URL(location.href);
      if (!url.searchParams.has('terms_accept')) return;
      url.searchParams.delete('terms_accept');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (_) {}
  }

  function tryApplyReturnedAcceptance() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (_) { return false; }
    var requestedId = params.get('terms_accept');
    var payload = jsonStorageGet(ACCEPT_KEY);
    if (!payload || !reviewIsFresh(payload)) return false;
    if (requestedId && payload.id !== requestedId) return false;
    if (!currentUrlMatches(payload.returnUrl)) return false;
    if (!applyTermsAcceptance()) return false;
    storageRemove(ACCEPT_KEY);
    storageRemove(REVIEW_KEY);
    removeTermsAcceptParam();
    return true;
  }

  function beginTermsReview(anchor) {
    var checkbox = termsCheckbox();
    if (!checkbox) return;

    var id = 'terms-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
    var request = { id: id, returnUrl: location.href, startedAt: Date.now() };
    jsonStorageSet(REVIEW_KEY, request);
    storageRemove(ACCEPT_KEY);

    var hint = document.getElementById('termsHint');
    if (hint) {
      hint.textContent = 'The Terms opened in a new tab. Read them there, then click “I understand — Accept & Continue” to return here.';
      hint.style.color = '';
      hint.style.fontWeight = '';
    }

    var url;
    try {
      url = new URL(anchor.href, location.href);
      url.searchParams.set('terms_review', id);
    } catch (_) {
      return;
    }

    var child = null;
    try { child = window.open(url.toString(), '_blank'); } catch (_) {}
    if (!child) location.href = url.toString();
  }

  function setupCheckoutTermsIntercept() {
    if (!termsCheckbox()) return;

    // Capture phase is intentional: the legacy checkout listener used to
    // enable the checkbox merely because the policy link was clicked. We stop
    // that event before it reaches the old listener, so acceptance now happens
    // only from the explicit button on the Terms page.
    document.addEventListener('click', function (e) {
      var anchor = e.target && e.target.closest ? e.target.closest('.viewTermsLink') : null;
      if (!anchor) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      beginTermsReview(anchor);
    }, true);

    window.addEventListener('storage', function (e) {
      if (e.key !== ACCEPT_KEY || !e.newValue) return;
      var payload;
      try { payload = JSON.parse(e.newValue); } catch (_) { return; }
      if (!reviewIsFresh(payload) || !currentUrlMatches(payload.returnUrl)) return;
      if (!applyTermsAcceptance()) return;
      storageRemove(ACCEPT_KEY);
      storageRemove(REVIEW_KEY);
    });

    // Same-tab fallback (popup blocked): once the customer comes back, wait
    // until the payment step is actually visible before checking acceptance.
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (tryApplyReturnedAcceptance() || attempts > 240) clearInterval(timer);
    }, 500);
    tryApplyReturnedAcceptance();
  }

  function termsReturnUrl(reviewId) {
    var request = jsonStorageGet(REVIEW_KEY);
    if (!request || request.id !== reviewId || !request.returnUrl) return '';
    return request.returnUrl;
  }

  function goBackFromTerms(reviewId, accepted) {
    var returnUrl = termsReturnUrl(reviewId);
    if (accepted) {
      jsonStorageSet(ACCEPT_KEY, { id: reviewId, returnUrl: returnUrl, acceptedAt: Date.now() });
    }

    try {
      if (window.opener && !window.opener.closed) {
        window.opener.focus();
        window.close();
        return;
      }
    } catch (_) {}

    if (returnUrl) {
      try {
        var url = new URL(returnUrl, location.href);
        if (accepted) url.searchParams.set('terms_accept', reviewId);
        location.href = url.toString();
        return;
      } catch (_) {}
    }
    if (history.length > 1) history.back();
  }

  function mountTermsReturnBar() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (_) { return; }
    var reviewId = params.get('terms_review');
    if (!reviewId || params.get('p') !== 'refunds') return;
    if (document.getElementById('unplugTermsReturnBar')) return;

    var bar = document.createElement('div');
    bar.id = 'unplugTermsReturnBar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Return to checkout');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:' + (/^staging|preview$/i.test(String(window.UNPLUG_ENV || '')) ? '34px' : '0') + ';z-index:2147483600;background:#111;color:#fff;border-top:3px solid #ff2f00;padding:12px 16px;box-shadow:0 -8px 28px rgba(0,0,0,.22);font-family:Inter,Arial,sans-serif;';

    var inner = document.createElement('div');
    inner.style.cssText = 'max-width:1180px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;';

    var text = document.createElement('div');
    var strong = document.createElement('div');
    strong.textContent = 'When you are ready, return to checkout.';
    strong.style.cssText = 'font-weight:800;font-size:13px;';
    var small = document.createElement('div');
    small.textContent = 'Your checkout is still open in the previous tab — nothing you entered there has been lost.';
    small.style.cssText = 'font-size:11.5px;color:#d8d8d8;margin-top:2px;';
    text.appendChild(strong);
    text.appendChild(small);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    var back = makeButton('Back without accepting');
    back.style.color = '#fff';
    var accept = makeButton('I understand — Accept & Continue');
    accept.style.cssText += 'background:#ff2f00;border-color:#ff2f00;color:#000;padding:9px 14px;';
    actions.appendChild(back);
    actions.appendChild(accept);

    inner.appendChild(text);
    inner.appendChild(actions);
    bar.appendChild(inner);
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '92px';

    back.addEventListener('click', function () { goBackFromTerms(reviewId, false); });
    accept.addEventListener('click', function () { goBackFromTerms(reviewId, true); });
  }

  ready(function () {
    if (!isAdminWorkspace()) restorePortalAccount();
    setupCheckoutTermsIntercept();
    mountTermsReturnBar();
  });

  window.addEventListener('storage', function (e) {
    if (e.key === TOKEN_KEY && !isAdminWorkspace() && !hasFirstPartyAccountUi()) restorePortalAccount();
  });
})();
