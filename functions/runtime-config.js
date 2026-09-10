// Runtime public configuration for Cloudflare Pages.
// This endpoint intentionally exposes only non-secret values required by the browser.
const PRODUCTION_API = 'https://unplug-ecosystem.onrender.com';
const STAGING_API = 'https://unplug-ecosystem-staging.onrender.com';
const STAGING_HOSTS = new Set([
  'unplug-staging.pages.dev'
]);

export async function onRequest({ env, request }) {
  const requestedHost = (() => {
    try { return new URL(request.url).hostname.toLowerCase(); }
    catch (_) { return ''; }
  })();

  const configuredEnvironment = String((env && env.UNPLUG_ENV) || 'production').toLowerCase();
  const configured = String((env && env.UNPLUG_API) || '').trim().replace(/\/+$/, '');
  const stagingHost = STAGING_HOSTS.has(requestedHost);
  const staging = stagingHost || configuredEnvironment === 'staging' || configuredEnvironment === 'preview';
  const environment = stagingHost ? 'staging' : configuredEnvironment;

  // The dedicated staging Pages hostname is a hard safety boundary. It must
  // never inherit a production API value from missing/misconfigured Pages
  // environment variables or from a stale browser setting.
  const api = stagingHost
    ? STAGING_API
    : (configured || (staging ? 'https://staging-api-not-configured.invalid' : PRODUCTION_API));
  const badStaging = staging && (!api || api === PRODUCTION_API || api === 'https://staging-api-not-configured.invalid');

  const lines = [
    'window.UNPLUG_ENV=' + JSON.stringify(environment) + ';',
    'window.UNPLUG_RUNTIME_API=' + JSON.stringify(api) + ';',
    'window.UNPLUG_RUNTIME_CONFIG_ERROR=' + JSON.stringify(badStaging ? 'Staging frontend is not connected to an isolated staging API.' : '') + ';'
  ];

  // Staging must never let a legacy hidden API input or stale localStorage
  // value switch the browser back to production. Several older dashboard
  // login handlers still read #apiBaseInput when the button is clicked.
  // Force those compatibility fields to the isolated staging API before the
  // user can interact with the page. Production behaviour is untouched.
  if (staging) {
    lines.push(
      '(function(){',
      '  var api=window.UNPLUG_RUNTIME_API;',
      '  try { localStorage.setItem("unplug_api_base", api); } catch (_) {}',
      '  function apply(){',
      '    ["apiBaseInput","forgotApiBaseInput"].forEach(function(id){',
      '      var el=document.getElementById(id);',
      '      if (el) el.value=api;',
      '    });',
      '  }',
      '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once:true });',
      '  else apply();',
      '})();',
      '',
      '// Phase 13 staging image system: full-image lightbox, non-destructive',
      '// display fitting, orientation-aware page banners, broken-image',
      '// fallbacks, source repair and capture-safe image/card interactions.',
      '(function(){',
      '  if (window.__unplugImageViewerRequested) return;',
      '  window.__unplugImageViewerRequested=true;',
      '  function add(src){',
      '    var s=document.createElement("script");',
      '    s.src=src;',
      '    s.async=false;',
      '    s.setAttribute("data-unplug-no-lightbox","true");',
      '    (document.head||document.documentElement).appendChild(s);',
      '  }',
      '  add("/media/scripts/unplug-image-viewer.js?v=20260906-2");',
      '  add("/media/scripts/unplug-image-viewer-guard.js?v=20260906-2");',
      '  add("/media/scripts/unplug-image-repair.js?v=20260906-3");',
      '  add("/media/scripts/unplug-image-interactions.js?v=20260906-2");',
      '})();'
    );
  }

  const body = lines.join('\n');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
