// Runtime public configuration for Cloudflare Pages.
// This endpoint intentionally exposes only non-secret values required by the browser.
const PRODUCTION_API = 'https://unplug-ecosystem.onrender.com';
const STAGING_API = 'https://unplug-ecosystem-staging.onrender.com';
const STAGING_HOSTS = new Set([
  'unplug-staging.pages.dev',
  'staging-control-centre.unplug-magazine.pages.dev'
]);

export async function onRequest({ env, request }) {
  const requestedHost = (() => { try { return new URL(request.url).hostname.toLowerCase(); } catch (_) { return ''; } })();
  const configuredEnvironment = String((env && env.UNPLUG_ENV) || 'production').toLowerCase();
  const configured = String((env && env.UNPLUG_API) || '').trim().replace(/\/+$/, '');
  const stagingHost = STAGING_HOSTS.has(requestedHost);
  const staging = stagingHost || configuredEnvironment === 'staging' || configuredEnvironment === 'preview';
  const environment = stagingHost ? 'staging' : configuredEnvironment;
  const api = stagingHost ? STAGING_API : (configured || (staging ? 'https://staging-api-not-configured.invalid' : PRODUCTION_API));
  const badStaging = staging && (!api || api === PRODUCTION_API || api === 'https://staging-api-not-configured.invalid');

  const lines = [
    'window.UNPLUG_ENV=' + JSON.stringify(environment) + ';',
    'window.UNPLUG_RUNTIME_API=' + JSON.stringify(api) + ';',
    'window.UNPLUG_RUNTIME_CONFIG_ERROR=' + JSON.stringify(badStaging ? 'Staging frontend is not connected to an isolated staging API.' : '') + ';'
  ];

  // The Agreement builder is a separate admin workspace so the very large
  // Control Centre stays stable. Inject one ordinary same-origin link into the
  // Marketing & CRM group. It has no data-section attribute, so the existing
  // section router correctly treats it as normal navigation.
  lines.push(
    '(function(){',
    ' function addAgreementAdminLink(){',
    '  if (location.pathname.indexOf("unplug-admin-dashboard.html") === -1) return;',
    '  if (document.querySelector("a[data-unplug-agreements-link]")) return;',
    '  var group=document.querySelector(".nav-group[data-group=marketing] .nav-group-items");',
    '  if (!group) return;',
    '  var a=document.createElement("a");',
    '  a.href="/unplug-agreements-admin.html";',
    '  a.textContent="Agreements";',
    '  a.setAttribute("data-unplug-agreements-link","true");',
    '  group.appendChild(a);',
    ' }',
    ' if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",addAgreementAdminLink,{once:true}); else addAgreementAdminLink();',
    '})();',
    '',
    '// Agreement admin exports/previews are protected API endpoints. Browsers',
    '// do not attach a bearer token to a plain href/window.open request, so',
    '// intercept these two controls in capture phase and fetch the blob with',
    '// the existing admin token instead. This preserves server-side auth.',
    '(function(){',
    ' if (location.pathname.indexOf("unplug-agreements-admin.html") === -1) return;',
    ' document.addEventListener("click", async function(e){',
    '  var preview=e.target && e.target.closest ? e.target.closest("#preview") : null;',
    '  var csv=e.target && e.target.closest ? e.target.closest("#csv") : null;',
    '  if (!preview && !csv) return;',
    '  e.preventDefault(); e.stopImmediatePropagation();',
    '  var token="";',
    '  try { token=localStorage.getItem("adminAccessToken")||localStorage.getItem("accessToken")||""; } catch (_) {}',
    '  if (!token) { alert("Your admin session is missing. Please sign in again."); return; }',
    '  var base=String(window.UNPLUG_RUNTIME_API||"").replace(/\\\/$/,"");',
    '  var path;',
    '  if (preview) {',
    '   var active=document.querySelector("#list .row.active[data-id]");',
    '   var id=active && active.getAttribute("data-id");',
    '   if (!id) { alert("Choose an agreement first."); return; }',
    '   path="/agreement-forms/admin/"+encodeURIComponent(id)+"/preview/document";',
    '  } else path="/agreement-forms/admin/records.csv";',
    '  try {',
    '   var r=await fetch(base+path,{headers:{Authorization:"Bearer "+token}});',
    '   if (!r.ok) { var d=await r.json().catch(function(){return {};}); throw new Error(d.error||("Request failed ("+r.status+")")); }',
    '   var blob=await r.blob(); var url=URL.createObjectURL(blob);',
    '   if (preview) { window.open(url,"_blank","noopener"); setTimeout(function(){URL.revokeObjectURL(url);},60000); }',
    '   else { var a=document.createElement("a"); a.href=url; a.download="agreement-records.csv"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(url);},1000); }',
    '  } catch (err) { alert(err.message||"Could not load the protected file."); }',
    ' },true);',
    '})();'
  );

  if (staging) {
    lines.push(
      '(function(){',
      '  function addStagingRibbon(){',
      '    if (!document.body || document.getElementById("unplug-staging-ribbon")) return;',
      '    var ribbon=document.createElement("div");',
      '    ribbon.id="unplug-staging-ribbon";',
      '    ribbon.textContent="UNPLUG STAGING • ISOLATED TEST ENVIRONMENT";',
      '    ribbon.setAttribute("role","status");',
      '    ribbon.setAttribute("aria-label","UNPLUG STAGING isolated test environment");',
      '    ribbon.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#ff2f00;color:#000001;border-top:2px solid #000001;padding:7px 12px;text-align:center;font:800 12px/1.2 Inter,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;box-shadow:0 -2px 12px rgba(0,0,0,.18);pointer-events:none";',
      '    document.body.appendChild(ribbon);',
      '  }',
      '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addStagingRibbon, { once:true }); else addStagingRibbon();',
      '})();',
      '',
      '(function(){',
      '  var api=window.UNPLUG_RUNTIME_API;',
      '  try { localStorage.setItem("unplug_api_base", api); } catch (_) {}',
      '  function apply(){',
      '    ["apiBaseInput","forgotApiBaseInput"].forEach(function(id){ var el=document.getElementById(id); if (el) el.value=api; });',
      '  }',
      '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once:true }); else apply();',
      '})();',
      '',
      '(function(){',
      '  if (window.__unplugImageViewerRequested) return;',
      '  window.__unplugImageViewerRequested=true;',
      '  function add(src){ var s=document.createElement("script"); s.src=src; s.async=false; s.setAttribute("data-unplug-no-lightbox","true"); (document.head||document.documentElement).appendChild(s); }',
      '  add("/media/scripts/unplug-image-viewer.js?v=20260906-2");',
      '  add("/media/scripts/unplug-image-viewer-guard.js?v=20260906-2");',
      '  add("/media/scripts/unplug-image-repair.js?v=20260906-3");',
      '  add("/media/scripts/unplug-image-interactions.js?v=20260906-2");',
      '})();'
    );
  }

  return new Response(lines.join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' }
  });
}
