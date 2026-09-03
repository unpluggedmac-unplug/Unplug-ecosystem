// Shared across every Unplug frontend (Admin Dashboard, Checkout, Member
// Dashboard) — the API-calling helper, toast notification, and session
// persistence logic that were previously copy-pasted into each file
// independently.

const UnplugAPI = (function () {
  // Live backend on Render. For local development, either set
  // localStorage.unplug_api_base to 'http://localhost:4000', or use the API
  // base input on the admin/checkout/member dashboards.
  const LIVE_API_BASE = 'https://unplug-ecosystem.onrender.com';
  // Drop a saved API base that cannot possibly work from here.
  //
  // Two cases, both of which leave the site looking broken with no clue why:
  //
  //   railway.app — the retired backend. A returning visitor whose browser
  //     still has it cached would keep calling a host that no longer answers.
  //
  //   localhost / 127.0.0.1 on a page that is NOT itself being served locally
  //     — a developer's leftover. On https the browser blocks it as mixed
  //     content or, now, as a CSP violation, and every fetch on the site fails
  //     at once. The dashboards have discarded these for a while; the magazine
  //     did not, which meant one stale value could break the actual site for
  //     whoever's browser held it. Found by hitting it.
  const savedApiBase = localStorage.getItem('unplug_api_base');
  const servedLocally = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (savedApiBase && (savedApiBase.indexOf('railway.app') !== -1
      || (!servedLocally && /(?:localhost|127\.0\.0\.1)/.test(savedApiBase)))) {
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
      // A tag that was tapped, or the words typed into search.
      label: o.label || null,
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
    const elReaders = document.getElementById('statReaders');
    const elMembers = document.getElementById('statMembers');
    const elArticles = document.getElementById('statArticles');
    // If none of the elements exist on this page, nothing to do.
    if (!elReaders && !elMembers && !elArticles) return;

    const fmt = (n) => {
      if (n == null) return '—';
      if (n >= 1000000) return Math.floor(n / 1000000) + 'M+';
      if (n >= 1000) return Math.floor(n / 1000) + 'K+';
      return String(n);
    };

    // One attempt, then — if it failed — one retry after a short pause rather
    // than giving up immediately. The backend is on Render's free tier and can
    // be asleep; the very first request after idle can take long enough to
    // fail or time out, while a second request moments later (once the
    // instance is awake) succeeds. Confirmed live: the page-load call left the
    // em-dash placeholders in place, while calling the same endpoint by hand a
    // few seconds later returned real numbers immediately.
    async function attempt() {
      return UnplugAPI.api('/analytics/public-stats');
    }

    let data = null;
    try {
      data = await attempt();
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        data = await attempt();
      } catch (err2) {
        data = null;
      }
    }

    if (data) {
      if (elReaders) elReaders.textContent = fmt(data.monthlyReaders);
      if (elMembers) elMembers.textContent = fmt(data.registeredMembers);
      if (elArticles) elArticles.textContent = fmt(data.articlesPublished);
      return;
    }

    // Both attempts failed. An em-dash placeholder reads as broken rather than
    // loading — hide the row instead, matching how the rest of this section
    // already handles "nothing to show" (the project spotlight card does the
    // same). Deliberately NO hardcoded number fallback: these stats exist to
    // show REAL platform numbers, and silently swapping in invented ones
    // (12K+/340+) on an API failure would mislead the exact investors this
    // section is meant to build credibility with.
    const row = (elReaders || elMembers || elArticles).closest('.inv-stats');
    if (row) row.style.display = 'none';
  })();
});
// ---------------------------------------------------------------------------
// STEP X OF Y (spec §19)
//
//   "DURING SUBMISSION · Show: Step X of Y with a progress indicator.
//    Example:  ●────○────○────○────○
//              1     2    3    4    5"
//
// ONE component, used by every multi-step flow. The spec asks for this in every
// flow, and a per-flow copy is how five slightly different indicators end up on
// one site.
//
// It is told which steps are IN THIS PATH and which one the user is on, and it
// works the rest out. That matters because a flow's length is not fixed: the
// checkout shows a package step for a Directory listing and skips it for
// everything else, which is why two of its cards were both hand-labelled
// "Step 2" — with the count computed, that cannot happen.
//
// Built with createElement rather than innerHTML: step names come from callers,
// and one day a caller will pass something a member typed.
window.UnplugSteps = (function () {
  // Draw into `host`. `steps` is the labels for this path, `currentIndex` is
  // 0-based. Returns the host so a caller can chain.
  function render(host, steps, currentIndex) {
    if (!host) return host;
    const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
    host.textContent = '';
    if (list.length < 2) return host;   // one step is not a journey

    const index = Math.max(0, Math.min(Number(currentIndex) || 0, list.length - 1));

    const wrap = document.createElement('div');
    wrap.className = 'unplug-steps';

    // "Step 2 of 4" — the words the spec asks for, and what a screen reader
    // reads out. The dots below are decorative and are hidden from it.
    const label = document.createElement('div');
    label.className = 'unplug-steps-label';
    label.textContent = 'Step ' + (index + 1) + ' of ' + list.length
      + (list[index] ? ' \u00b7 ' + list[index] : '');
    wrap.appendChild(label);

    const track = document.createElement('div');
    track.className = 'unplug-steps-track';
    track.setAttribute('aria-hidden', 'true');

    list.forEach(function (name, i) {
      if (i > 0) {
        const line = document.createElement('span');
        line.className = 'unplug-steps-line' + (i <= index ? ' done' : '');
        track.appendChild(line);
      }
      const dot = document.createElement('span');
      dot.className = 'unplug-steps-dot'
        + (i < index ? ' done' : '')
        + (i === index ? ' current' : '');
      dot.title = name;
      track.appendChild(dot);
    });

    wrap.appendChild(track);
    host.appendChild(wrap);
    return host;
  }

  // The styles, injected once. Kept with the component so a page cannot use it
  // and get an unstyled row of nothing.
  function ensureStyles() {
    if (document.getElementById('unplug-steps-style')) return;
    const style = document.createElement('style');
    style.id = 'unplug-steps-style';
    style.textContent = [
      '.unplug-steps{margin:0 0 14px;}',
      '.unplug-steps-label{font-size:11px;text-transform:uppercase;letter-spacing:0.06em;',
      'color:var(--red,#d20709);font-weight:700;margin-bottom:6px;}',
      '.unplug-steps-track{display:flex;align-items:center;gap:0;}',
      '.unplug-steps-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;',
      'background:transparent;border:2px solid var(--paper-line,#ddd);}',
      '.unplug-steps-dot.done{background:var(--red,#d20709);border-color:var(--red,#d20709);}',
      '.unplug-steps-dot.current{background:var(--red,#d20709);border-color:var(--red,#d20709);',
      'box-shadow:0 0 0 3px rgba(210,7,9,0.18);}',
      '.unplug-steps-line{height:2px;flex:1 1 auto;min-width:18px;',
      'background:var(--paper-line,#ddd);}',
      '.unplug-steps-line.done{background:var(--red,#d20709);}',
    ].join('');
    document.head.appendChild(style);
  }

  return {
    render: function (host, steps, currentIndex) {
      ensureStyles();
      return render(host, steps, currentIndex);
    },
  };
})();
