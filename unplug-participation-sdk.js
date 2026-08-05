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
  // Referral link capture: call once on every page load. If the URL has
  // ?ref=CODE, stash it; if a stashed code exists once the visitor is
  // signed in, register it and clear it so it never double-fires.
  // ---------------------------------------------------------------------
  function captureReferralFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref) sessionStorage.setItem('unplug_referral_code', ref);
  }

  async function registerPendingReferral() {
    const code = sessionStorage.getItem('unplug_referral_code');
    if (!code || !UnplugAPI.getToken()) return;
    sessionStorage.removeItem('unplug_referral_code');
    try {
      await registerReferral(code);
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
    registerPendingReferral,
  };
})();

window.UnplugParticipation = UnplugParticipation;
