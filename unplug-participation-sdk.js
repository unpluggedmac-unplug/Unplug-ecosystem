// Unplug Participation SDK — thin wrapper around the /participation/*
// routes added in Stage F. Include after unplug-shared.js (needs
// UnplugAPI). Calls that award points are fire-and-forget by design: a
// failed or slow points call must never block the actual action a
// member came to do (voting, recognising someone, etc).
//
// Usage:
//   UnplugParticipation.action('top10_vote', { contentType: 'top10', contentId: entryId });
//   const dashboard = await UnplugParticipation.getDashboard();
//   await UnplugParticipation.recognise(profileUserId, 'inspiring', 'Great work!');

const UnplugParticipation = (() => {
  const api = UnplugAPI.api;

  // Fire-and-forget: awards points for a standard action. Silently no-ops
  // when signed out (points are always tied to a member) or on any
  // network/API failure — never surfaces an error to the visitor for
  // something this incidental to what they were actually doing.
  function action(actionCode, { contentType, contentId, contentOwner } = {}) {
    if (!UnplugAPI.getToken()) return Promise.resolve(null);
    return api('/participation/action', {
      method: 'POST',
      body: JSON.stringify({ actionCode, contentType, contentId, contentOwner }),
    }).catch(() => null);
  }

  async function getDashboard() {
    return api('/participation/dashboard');
  }

  async function getStatusLevels() {
    return api('/participation/status-levels');
  }

  async function getRecognitionTypes() {
    return api('/participation/recognition-types');
  }

  async function getLeaderboard(type = 'overall', limit = 50, offset = 0) {
    return api(`/participation/leaderboard?type=${encodeURIComponent(type)}&limit=${limit}&offset=${offset}`);
  }

  async function getBiggestMovers(limit = 10) {
    return api(`/participation/leaderboard/movers?limit=${limit}`);
  }

  async function getHomepage() {
    return api('/participation/homepage');
  }

  async function getMyReferrals() {
    return api('/participation/referrals');
  }

  // Called once, right after a new member finishes signing up, if they
  // arrived via someone's referral link. See registerPendingReferral()
  // below for the sessionStorage handoff across the signup flow.
  async function registerReferral(referralCode) {
    return api('/participation/referrals/register', {
      method: 'POST',
      body: JSON.stringify({ referralCode }),
    });
  }

  async function recognise(toUserId, recognitionType, message, isPublic = true) {
    return api('/participation/recognitions', {
      method: 'POST',
      body: JSON.stringify({ toUserId, recognitionType, message, isPublic }),
    });
  }

  async function getRecognitionsFor(userId) {
    return api(`/participation/recognitions/${userId}`);
  }

  async function markNotificationsRead(ids) {
    return api('/participation/notifications/read', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    });
  }

  // ---------------------------------------------------------------------
  // Referral lifecycle.
  //
  // A referral link is anonymous when it is opened, so the click is recorded
  // now and its opaque row id is carried in sessionStorage into registration.
  // That lets signup attach the exact click later instead of guessing which of
  // several visits converted. One code is recorded once per browser session;
  // navigating around the site must not inflate the referrer's click count.
  // ---------------------------------------------------------------------
  const REFERRAL_CODE_KEY = 'unplug_referral_code';
  const REFERRAL_CLICK_ID_KEY = 'unplug_referral_click_id';
  const REFERRAL_CLICK_CODE_KEY = 'unplug_referral_click_code';

  function sessionGet(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (_) { return ''; }
  }
  function sessionSet(key, value) {
    try {
      if (value == null || value === '') sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, String(value));
    } catch (_) { /* private mode: referral tracking is best-effort */ }
  }

  function captureReferralFromUrl() {
    let ref = '';
    try {
      const params = new URLSearchParams(window.location.search);
      ref = String(params.get('ref') || '').trim().slice(0, 20);
    } catch (_) { /* malformed URL cannot break the site */ }
    if (ref) {
      // A new code means a genuinely different referral journey. Drop the old
      // click marker so this new link can be counted once.
      if (sessionGet(REFERRAL_CODE_KEY) !== ref) {
        sessionSet(REFERRAL_CLICK_ID_KEY, '');
        sessionSet(REFERRAL_CLICK_CODE_KEY, '');
      }
      sessionSet(REFERRAL_CODE_KEY, ref);
    }
    return ref || sessionGet(REFERRAL_CODE_KEY);
  }

  async function recordReferralClick(code) {
    const clean = String(code || '').trim().slice(0, 20);
    if (!clean) return null;

    // Already recorded this referral during this browser session.
    if (sessionGet(REFERRAL_CLICK_CODE_KEY) === clean) {
      return sessionGet(REFERRAL_CLICK_ID_KEY) || null;
    }

    try {
      const result = await api('/acquisition/referral-clicks', {
        method: 'POST',
        body: JSON.stringify({ code: clean, from: document.referrer || '' }),
      });
      // Store the code even if an older backend did not return clickId. That
      // still prevents page-to-page navigation from creating duplicate clicks.
      sessionSet(REFERRAL_CLICK_CODE_KEY, clean);
      if (result && result.clickId) sessionSet(REFERRAL_CLICK_ID_KEY, result.clickId);
      return result && result.clickId ? result.clickId : null;
    } catch (_) {
      // Analytics/attribution must never interrupt a visitor's page.
      return null;
    }
  }

  async function registerPendingReferral() {
    const code = sessionGet(REFERRAL_CODE_KEY);
    if (!code || !UnplugAPI.getToken()) return;
    // Kept for signed-in flows that existed before referral-at-registration.
    // Registration itself now submits the same code directly to /auth/register.
    try {
      await registerReferral(code);
      sessionSet(REFERRAL_CODE_KEY, '');
      sessionSet(REFERRAL_CLICK_ID_KEY, '');
      sessionSet(REFERRAL_CLICK_CODE_KEY, '');
    } catch (err) {
      // Most failures here are expected/benign (self-referral, already
      // registered) — nothing for the visitor to act on either way.
    }
  }


  return {
    action,
    getDashboard,
    getStatusLevels,
    getRecognitionTypes,
    getLeaderboard,
    getBiggestMovers,
    getHomepage,
    getMyReferrals,
    registerReferral,
    recognise,
    getRecognitionsFor,
    markNotificationsRead,
    captureReferralFromUrl,
    recordReferralClick,
    registerPendingReferral,
  };
})();

window.UnplugParticipation = UnplugParticipation;

// Run after the public module exists. Every referral action is best-effort and
// intentionally decoupled from page rendering.
function initialiseUnplugReferralLifecycle() {
  try {
    const code = UnplugParticipation.captureReferralFromUrl();
    if (code) UnplugParticipation.recordReferralClick(code);
    UnplugParticipation.registerPendingReferral();
  } catch (_) { /* referral tracking must never disturb the page */ }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialiseUnplugReferralLifecycle, { once: true });
} else {
  initialiseUnplugReferralLifecycle();
}
