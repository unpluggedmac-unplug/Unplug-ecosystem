(function stagingRuntimeGuard() {
  'use strict';

  // Defence in depth for release-candidate pages. The normal source of truth is
  // /runtime-config, but a staging page must never fall through to production
  // merely because that script is delayed, blocked or accidentally omitted.
  // This guard is deliberately host-scoped and is a complete no-op in production.
  var host = String(window.location && window.location.hostname || '').toLowerCase();
  var canonical = host === 'unplug-staging.pages.dev';
  var immutable = /^[a-f0-9]{8}\.unplug-staging\.pages\.dev$/i.test(host);
  var branchPreview = host === 'staging-control-centre.unplug-magazine.pages.dev';
  if (!canonical && !immutable && !branchPreview) return;

  var stagingApi = 'https://unplug-ecosystem-staging.onrender.com';
  window.UNPLUG_ENV = 'staging';
  window.UNPLUG_RUNTIME_API = stagingApi;
  if (typeof window.UNPLUG_RUNTIME_CONFIG_ERROR !== 'string') {
    window.UNPLUG_RUNTIME_CONFIG_ERROR = '';
  }
  try { window.localStorage.setItem('unplug_api_base', stagingApi); } catch (_) {}

  function mountRibbon() {
    if (!document.body || document.getElementById('unplug-staging-ribbon')) return;
    var ribbon = document.createElement('div');
    ribbon.id = 'unplug-staging-ribbon';
    ribbon.setAttribute('role', 'status');
    ribbon.setAttribute('aria-label', 'UNPLUG STAGING isolated test environment');
    ribbon.textContent = 'UNPLUG STAGING • ISOLATED TEST ENVIRONMENT';
    ribbon.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#ff2f00;color:#000001;border-top:2px solid #000001;padding:7px 12px;text-align:center;font:800 12px/1.2 Inter,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;box-shadow:0 -2px 12px rgba(0,0,0,.18);pointer-events:none';
    document.body.appendChild(ribbon);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountRibbon, { once: true });
  } else {
    mountRibbon();
  }
})();
