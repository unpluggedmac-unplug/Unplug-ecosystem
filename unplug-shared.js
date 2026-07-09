// Shared across every Unplug frontend (Admin Dashboard, Checkout, Member
// Dashboard) — the API-calling helper, toast notification, and session
// persistence logic that were previously copy-pasted into each file
// independently.

const UnplugAPI = (function () {
  // Defaults to the live Railway backend. For local development, either set
  // localStorage.unplug_api_base to 'http://localhost:4000', or use the API
  // base input on the admin/checkout/member dashboards.
  let apiBase = localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem-production.up.railway.app';
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
(function () {
  const API_BASE = 'https://unplug-ecosystem-production.up.railway.app';

  let sessionId = localStorage.getItem('unplug_analytics_session');
  if (!sessionId) {
    sessionId = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('unplug_analytics_session', sessionId);
  }

  fetch(API_BASE + '/analytics/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pagePath: window.location.pathname, sessionId }),
  }).catch(() => {
    // Silently ignore failures — tracking should never disrupt the
    // actual page for a visitor, even if the backend is briefly down.
  });
})();
