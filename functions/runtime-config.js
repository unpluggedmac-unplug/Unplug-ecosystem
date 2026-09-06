// Runtime public configuration for Cloudflare Pages.
// This endpoint intentionally exposes only non-secret values required by the browser.
const PRODUCTION_API = 'https://unplug-ecosystem.onrender.com';

export async function onRequest({ env }) {
  const environment = String((env && env.UNPLUG_ENV) || 'production').toLowerCase();
  const configured = String((env && env.UNPLUG_API) || '').trim().replace(/\/+$/, '');
  const staging = environment === 'staging' || environment === 'preview';
  const api = configured || (staging ? 'https://staging-api-not-configured.invalid' : PRODUCTION_API);
  const badStaging = staging && (!configured || configured === PRODUCTION_API);

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
      '// display fitting, orientation-aware page banners and broken-image',
      '// fallbacks. Loaded only in Preview/Staging while it is being smoke-tested.',
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
      '  add("/media/scripts/unplug-image-viewer.js?v=20260906-1");',
      '  add("/media/scripts/unplug-image-viewer-guard.js?v=20260906-1");',
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
