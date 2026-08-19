// Shared across every Unplug frontend (Admin Dashboard, Checkout, Member
// Dashboard) — the API-calling helper, toast notification, and session
// persistence logic that were previously copy-pasted into each file
// independently.

const UnplugAPI = (function () {
  // Live backend on Render. For local development, either set
  // localStorage.unplug_api_base to 'http://localhost:4000', or use the API
  // base input on the admin/checkout/member dashboards.
  const LIVE_API_BASE = 'https://unplug-ecosystem.onrender.com';
  // Migrate returning visitors off the old Railway backend: if their browser
  // still has the retired Railway URL cached, drop it so they pick up Render.
  const savedApiBase = localStorage.getItem('unplug_api_base');
  if (savedApiBase && savedApiBase.indexOf('railway.app') !== -1) {
    localStorage.removeItem('unplug_api_base');
  }
  let apiBase = localStorage.getItem('unplug_api_base') || LIVE_API_BASE;
  let token = null;

  function setApiBase(value) {
    apiBase = value.trim().replace(/\/$/, '');
    localStorage.setItem('unplug_api_base', apiBase);
  }
  function getApiBase() {
    return apiBase;
  }
  function setToken(value) {
    token = value;
    if (value) {
      localStorage.setItem('unplug_auth_token', value);
    } else {
      localStorage.removeItem('unplug_auth_token');
    }
  }
  function getToken() {
    return token;
  }

  async function api(path, options = {}) {
    const res = await fetch(apiBase + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(options.headers || {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no JSON body */ }
    if (!res.ok) {
      throw new Error((body && body.error) || `Request failed (${res.status})`);
    }
    return body;
  }

  // Restores a saved session on page load (so refreshing doesn't log the
  // user straight back out), calling onSuccess(user) or onFailure() once
  // the check completes.
  async function restoreSession(onSuccess, onFailure) {
    const savedToken = localStorage.getItem('unplug_auth_token');
    if (!savedToken) {
      if (onFailure) onFailure();
      return;
    }
    token = savedToken;
    try {
      const data = await api('/auth/me');
      if (onSuccess) onSuccess(data.user);
    } catch (err) {
      token = null;
      localStorage.removeItem('unplug_auth_token');
      if (onFailure) onFailure();
    }
  }

  return { api, setApiBase, getApiBase, setToken, getToken, restoreSession };
})();

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}


// Unplug — Page View Tracking
// Sends one lightweight "someone viewed this page" ping to the backend
// each time this script runs. No personal data — sessionId is just a
// random ID this browser makes up for itself and stores locally, purely
// to count "unique visitors" without identifying anyone.
// UnplugAnalytics — one place that decides who a visitor is, which visit
// this is, and where that visit came from.
//
// TWO different ids, which the previous version conflated:
//   visitorId — permanent, in localStorage. Answers "have they been here
//     before". Random, first-party, and meaningless outside this site.
//   sessionId — one VISIT. Rolls over after 30 minutes of inactivity, so
//     "sessions" measures visits rather than browsers. The old code kept a
//     single localStorage id for ever and called it a session, which meant a
//     reader who came back weekly for a year counted as one session.
//
// Nothing here runs, and NO ID IS EVER MINTED, until the visitor has actively
// accepted on the consent bar. Declining leaves nothing behind at all.
window.UnplugAnalytics = (function () {
  const API_BASE = 'https://unplug-ecosystem.onrender.com';
  const SESSION_GAP_MS = 30 * 60 * 1000;

  function allowed() {
    try { return localStorage.getItem('unplug_consent_analytics') === 'accepted'; }
    catch (e) { return false; }
  }

  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  const rand = (p) => p + Math.random().toString(36).slice(2) + Date.now().toString(36);

  function visitorId() {
    let id = get('unplug_analytics_visitor');
    if (!id) {
      // Reuse the old key when it exists, so everybody who has already visited
      // stays recognisable as a returning reader instead of the switch
      // resetting the entire audience to "new".
      id = get('unplug_analytics_session') || rand('v-');
      set('unplug_analytics_visitor', id);
    }
    return id;
  }

  function sessionId() {
    const now = Date.now();
    const last = parseInt(get('unplug_analytics_sid_ts') || '0', 10);
    let id = get('unplug_analytics_sid');
    if (!id || !last || (now - last) > SESSION_GAP_MS) {
      id = rand('s-');
      set('unplug_analytics_sid', id);
      // A new visit means new attribution: whatever brought them back this
      // time is the source of THIS visit.
      captureAttribution(true);
    }
    set('unplug_analytics_sid_ts', String(now));
    return id;
  }

  // Where this visit came from, worked out once at the start of the visit and
  // then reused. Read on a later page the referrer would be our own site and
  // the UTM tags would be gone from the address bar, so a visit that began on
  // Instagram would quietly reclassify itself as Direct.
  function captureAttribution(force) {
    if (!force && get('unplug_analytics_attr')) return;
    let params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
    // The root redirect stub (index.html) hands the browser on to the magazine
    // page, which makes THIS page's referrer our own domain — a self-referral
    // that would file a click from Instagram as "Direct". The stub stashes the
    // real one on the way through; it is used only when what the browser is
    // reporting is our own site or nothing at all, so a genuine referrer is
    // never overridden by a stale stash.
    let entryReferrer = '';
    try { entryReferrer = sessionStorage.getItem('unplug_entry_referrer') || ''; } catch (e) { /* ignore */ }
    const liveReferrer = document.referrer || '';
    const ownSite = liveReferrer && liveReferrer.indexOf(window.location.host) !== -1;

    const attr = {
      referrer: (!liveReferrer || ownSite) && entryReferrer ? entryReferrer : liveReferrer,
      utmSource: params ? (params.get('utm_source') || '') : '',
      utmMedium: params ? (params.get('utm_medium') || '') : '',
      utmCampaign: params ? (params.get('utm_campaign') || '') : '',
    };
    set('unplug_analytics_attr', JSON.stringify(attr));
    return attr;
  }

  function attribution() {
    try { return JSON.parse(get('unplug_analytics_attr') || '{}'); }
    catch (e) { return {}; }
  }

  function send(path, payload) {
    if (!allowed()) return Promise.resolve();
    const headers = { 'Content-Type': 'application/json' };
    // Sent when we have one, so a signed-in visit can be tied to its account.
    // The server reads the account FROM THE TOKEN and never from anything the
    // browser claims about who it is.
    let token = null;
    try { token = localStorage.getItem('unplug_auth_token'); } catch (e) { /* private mode */ }
    if (token) headers.Authorization = 'Bearer ' + token;

    return fetch(API_BASE + path, {
      method: 'POST', headers, body: JSON.stringify(payload),
    }).catch(() => { /* analytics must never disturb the page */ });
  }

  function pageView(pagePath, opts) {
    if (!allowed()) return Promise.resolve();
    const o = opts || {};
    return send('/analytics/track', Object.assign({
      pagePath: pagePath || window.location.pathname,
      sessionId: sessionId(),
      visitorId: visitorId(),
      entityType: o.entityType || null,
      entityId: o.entityId || null,
    }, attribution()));
  }

  // A conversion that happens in the browser. Anything involving money is
  // recorded by the server instead — a value posted from a page can be made up.
  function event(eventName, opts) {
    if (!allowed() || !eventName) return Promise.resolve();
    const o = opts || {};
    return send('/analytics/event', Object.assign({
      eventName: eventName,
      pagePath: o.pagePath || window.location.pathname,
      sessionId: sessionId(),
      visitorId: visitorId(),
      entityType: o.entityType || null,
      entityId: o.entityId || null,
    }, attribution()));
  }

  // Ties this visit to the account that just signed in. Without it a payment
  // has a customer but no idea which visit brought that person to the site.
  function identify() {
    if (!allowed()) return Promise.resolve();
    return send('/analytics/identify', { sessionId: sessionId(), visitorId: visitorId() });
  }

  // GOOGLE ANALYTICS, loaded only when a real property is configured AND the
  // visitor has accepted. An unconfigured tag that fires at nothing is worse
  // than no tag, because it looks like it is working.
  function loadGoogleAnalytics() {
    if (!allowed() || window.__unplugGaLoaded) return;
    fetch(API_BASE + '/analytics/config').then((r) => r.json()).then((cfg) => {
      const id = cfg && cfg.ga4MeasurementId;
      if (!id || window.__unplugGaLoaded) return;
      window.__unplugGaLoaded = true;
      const tag = document.createElement('script');
      tag.async = true;
      tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
      document.head.appendChild(tag);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      // anonymize_ip is set because the visitor accepted analytics, not
      // tracking — the country is all any report here needs.
      window.gtag('config', id, { anonymize_ip: true });
    }).catch(() => { /* GA is optional; the first-party tracking stands alone */ });
  }

  if (allowed()) {
    captureAttribution(false);
    pageView(window.location.pathname);
    loadGoogleAnalytics();
  }

  return { allowed, visitorId, sessionId, attribution, pageView, event, identify, loadGoogleAnalytics };
})();


// ---------------------------------------------------------------------------
// Platform stats: populate the investor spotlight numbers on any page that
// includes the stat elements with IDs statReaders / statMembers / statArticles.
// This central implementation lives in unplug-shared.js so the same behaviour
// works across pages without duplicating code in each HTML file.
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  (async function loadPlatformStatsShared() {
    try {
      const elReaders = document.getElementById('statReaders');
      const elMembers = document.getElementById('statMembers');
      const elArticles = document.getElementById('statArticles');
      // If none of the elements exist on this page, nothing to do.
      if (!elReaders && !elMembers && !elArticles) return;

      // Use the shared API helper so it respects localStorage overrides
      // (for local development) and any auth token if present.
      const data = await UnplugAPI.api('/analytics/public-stats');

      const fmt = (n) => {
        if (n == null) return '—';
        if (n >= 1000000) return Math.floor(n / 1000000) + 'M+';
        if (n >= 1000) return Math.floor(n / 1000) + 'K+';
        return String(n);
      };

      if (elReaders) elReaders.textContent = fmt(data.monthlyReaders);
      if (elMembers) elMembers.textContent = fmt(data.registeredMembers);
      if (elArticles) elArticles.textContent = fmt(data.articlesPublished);
    } catch (err) {
      // Leave the existing em-dash placeholders rather than showing 0 or an
      // error. Deliberately NO hardcoded number fallback here: these stats
      // exist to show REAL platform numbers, and silently swapping in
      // invented ones (12K+/340+) on an API hiccup would mislead the exact
      // investors this section is meant to build credibility with.
    }
  })();
});
