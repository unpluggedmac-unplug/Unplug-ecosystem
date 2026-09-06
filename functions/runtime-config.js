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
      '// Staging enhancements. All files are same-origin and each enhancement',
      '// is defensive/no-op outside the page it owns. Deduplication matters on',
      '// dedicated pages that also include their critical CSS/JS directly.',
      '(function(){',
      '  if (window.__unplugStagingEnhancementsRequested) return;',
      '  window.__unplugStagingEnhancementsRequested=true;',
      '  function already(kind,path){',
      '    var nodes=document.querySelectorAll(kind === "style" ? "link[rel=stylesheet][href]" : "script[src]");',
      '    for(var i=0;i<nodes.length;i++){',
      '      var value=kind === "style" ? nodes[i].getAttribute("href") : nodes[i].getAttribute("src");',
      '      if(value && value.split("?")[0] === path) return true;',
      '    }',
      '    return false;',
      '  }',
      '  function addStyle(href){',
      '    var path=href.split("?")[0]; if(already("style",path)) return;',
      '    var l=document.createElement("link"); l.rel="stylesheet"; l.href=href;',
      '    l.setAttribute("data-unplug-runtime-asset","true");',
      '    (document.head||document.documentElement).appendChild(l);',
      '  }',
      '  function addScript(src){',
      '    var path=src.split("?")[0]; if(already("script",path)) return;',
      '    var s=document.createElement("script"); s.src=src; s.async=false;',
      '    s.setAttribute("data-unplug-no-lightbox","true");',
      '    s.setAttribute("data-unplug-runtime-asset","true");',
      '    (document.head||document.documentElement).appendChild(s);',
      '  }',
      '',
      '  // Phase 13 image system.',
      '  addScript("/media/scripts/unplug-image-viewer.js?v=20260906-2");',
      '  addScript("/media/scripts/unplug-image-viewer-guard.js?v=20260906-2");',
      '  addScript("/media/scripts/unplug-image-repair.js?v=20260906-3");',
      '  addScript("/media/scripts/unplug-image-interactions.js?v=20260906-2");',
      '',
      '  // Daily Shout-Out v2 public card + share actions.',
      '  addStyle("/media/styles/daily-shoutout-v2.css?v=20260906-4");',
      '  addScript("/media/scripts/daily-shoutout-v2.js?v=20260906-4");',
      '',
      '  // Daily Shout-Out Studio in the existing Control Centre section.',
      '  addStyle("/media/style/daily-shoutout-control-centre.css?v=20260906-1");',
      '  addScript("/media/scripts/daily-shoutout-control-centre.js?v=20260906-1");',
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
