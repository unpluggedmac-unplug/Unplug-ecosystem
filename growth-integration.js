'use strict';

(function growthIntegration(){
  if (window.__unplugGrowthIntegrationLoaded) return;
  window.__unplugGrowthIntegrationLoaded = true;

  const API = String(window.UNPLUG_RUNTIME_API || 'https://unplug-ecosystem.onrender.com').replace(/\/$/, '');
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  function token() {
    try { return localStorage.getItem('unplug_auth_token') || ''; }
    catch (_) { return ''; }
  }

  async function json(url, options) {
    const opts = options || {};
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const response = await fetch(API + url, Object.assign({}, opts, { headers }));
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error((body && body.error) || `Request failed (${response.status})`);
    return body;
  }

  function addAdminLink() {
    if (!/unplug-admin-dashboard\.html$/i.test(path)) return;
    if (document.querySelector('[data-unplug-growth-admin-link]')) return;
    const group = document.querySelector('.nav-group[data-group="marketing"] .nav-group-items')
      || document.querySelector('.nav-group-items')
      || document.querySelector('nav');
    if (!group) return;
    const a = document.createElement('a');
    a.href = '/unplug-growth-applications-admin.html';
    a.textContent = 'Growth Applications';
    a.setAttribute('data-unplug-growth-admin-link', 'true');
    a.style.cssText = 'display:block;padding:9px 12px;text-decoration:none';
    group.appendChild(a);
  }

  function addMemberJourneyLink() {
    if (!/unplug-member-dashboard\.html$/i.test(path)) return;
    if (document.querySelector('[data-unplug-growth-journey-link]')) return;
    const sidebar = document.querySelector('.ms-sidebar');
    if (!sidebar) return;
    const a = document.createElement('a');
    a.href = '/unplug-growth-application.html';
    a.className = 'ms-navlink';
    a.setAttribute('data-unplug-growth-journey-link', 'true');
    a.innerHTML = '<span aria-hidden="true">↗</span> My Growth Journey';
    const logout = sidebar.querySelector('.ms-logout');
    sidebar.insertBefore(a, logout || null);
  }

  function addResumeLinkControl() {
    if (!/unplug-growth-application\.html$/i.test(path) || !token()) return;
    if (document.getElementById('unplug-growth-resume-control')) return;
    const wrap = document.querySelector('main.wrap') || document.querySelector('main') || document.body;
    const box = document.createElement('section');
    box.id = 'unplug-growth-resume-control';
    box.style.cssText = 'max-width:1100px;margin:0 auto 18px;background:#fff;border:1px solid #d7d1cd;border-radius:16px;padding:15px 18px;box-sizing:border-box';
    box.innerHTML = '<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">'
      + '<div><strong style="display:block">Resume this journey later</strong><span style="font-size:12px;color:#6b6764">Your member dashboard also resumes your current draft automatically.</span></div>'
      + '<button type="button" id="unplugGrowthShowResume" style="border:0;border-radius:999px;background:#000001;color:#fff;padding:10px 14px;font-weight:800;cursor:pointer">Show my resume link</button></div>'
      + '<div id="unplugGrowthResumeResult" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid #eee9e6"></div>';
    const hero = wrap.querySelector('.hero');
    if (hero && hero.parentNode) hero.parentNode.insertBefore(box, hero.nextSibling);
    else wrap.insertBefore(box, wrap.firstChild);

    document.getElementById('unplugGrowthShowResume').onclick = async () => {
      const out = document.getElementById('unplugGrowthResumeResult');
      out.style.display = 'block';
      out.textContent = 'Creating a fresh secure resume link…';
      try {
        const mine = await json('/growth-application/applications/me');
        const apps = mine.applications || [];
        const target = apps.find((item) => !item.submitted_at) || apps[0];
        if (!target) {
          out.textContent = 'Start a Growth Application first. Your resume link will appear here immediately afterwards.';
          return;
        }
        const data = await json(`/growth-application/applications/${encodeURIComponent(target.id)}/resume-link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        out.innerHTML = '<div style="font-size:12px;color:#6b6764;margin-bottom:6px">Keep this link private. A fresh copy was also sent to your member email.</div>'
          + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input id="unplugGrowthResumeUrl" readonly style="flex:1;min-width:230px;padding:10px;border:1px solid #bbb;border-radius:9px" value="">'
          + '<button type="button" id="unplugGrowthCopyResume" style="border:1px solid #000;background:#fff;padding:9px 12px;border-radius:999px;font-weight:800;cursor:pointer">Copy link</button></div>';
        const input = document.getElementById('unplugGrowthResumeUrl');
        input.value = data.resume_url || '';
        document.getElementById('unplugGrowthCopyResume').onclick = async () => {
          try { await navigator.clipboard.writeText(input.value); }
          catch (_) { input.select(); document.execCommand('copy'); }
        };
      } catch (err) {
        out.textContent = err.message || 'Could not create a resume link right now.';
      }
    };
  }

  function placementKey() {
    if (/unplug-member-dashboard\.html$/i.test(path)) return 'member_dashboard';
    if (!/unplug-magazine\.html$/i.test(path) && path !== '/' && !/index\.html$/i.test(path)) return null;
    const p = String(params.get('p') || 'home').toLowerCase();
    const map = {
      home: 'homepage', homepage: 'homepage', news: 'latest_news', latest: 'latest_news',
      directory: 'directory', gallery: 'gallery', editions: 'editions',
      top10: 'top10', competitions: 'competitions', competition: 'competitions',
    };
    return map[p] || null;
  }

  function renderPlacement(config) {
    const key = placementKey();
    if (!key || key === 'member_dashboard') return;
    if (config.site_visibility !== 'visible') return;
    const enabled = (config.placements || []).some((p) => p.page_key === key && p.enabled === true);
    if (!enabled || document.getElementById('unplug-growth-placement')) return;

    const block = document.createElement('section');
    block.id = 'unplug-growth-placement';
    block.setAttribute('aria-label', 'Unplug Growth Application');
    block.style.cssText = 'max-width:1180px;margin:20px auto;padding:0 24px;box-sizing:border-box';
    block.innerHTML = '<div style="background:#000001;color:#ebe9e9;border-radius:18px;padding:24px 26px;display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap">'
      + '<div><div style="font:800 11px/1.2 Inter,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#ff4d00">Unplug Growth Journey</div>'
      + '<div style="font:700 clamp(22px,3vw,38px)/1.05 Georgia,serif;margin-top:6px">Ready to understand your next level?</div>'
      + '<p style="margin:8px 0 0;max-width:720px;color:#d9d4d0;font:14px/1.5 Inter,Arial,sans-serif">A free, member-only Growth Application designed to help Unplug understand your credibility, visibility, barriers, opportunities and next steps.</p></div>'
      + '<a href="/unplug-growth-application.html" style="display:inline-block;background:#ff2f00;color:#fff;text-decoration:none;font:800 13px/1 Inter,Arial,sans-serif;padding:13px 18px;border-radius:999px">Start My Growth Journey</a>'
      + '</div>';
    const header = document.querySelector('.site-header, header');
    if (header && header.parentNode) header.parentNode.insertBefore(block, header.nextSibling);
    else document.body.insertBefore(block, document.body.firstChild);
  }

  async function maybePromptMember(config) {
    if (!/unplug-member-dashboard\.html$/i.test(path)) return;
    if (config.site_visibility !== 'visible') return;
    const enabled = (config.placements || []).some((p) => p.page_key === 'member_dashboard' && p.enabled === true);
    if (!enabled || !token()) return;
    try {
      const mine = await json('/growth-application/applications/me');
      if ((mine.applications || []).length > 0) return;
      if (document.getElementById('unplug-growth-member-prompt')) return;

      const overlay = document.createElement('div');
      overlay.id = 'unplug-growth-member-prompt';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px';
      overlay.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="growthPromptTitle" style="max-width:560px;width:100%;background:#ebe9e9;color:#000001;border-radius:20px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.3)">'
        + '<div style="font:800 11px/1.2 Inter,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#e83b00">My Growth Journey</div>'
        + '<h2 id="growthPromptTitle" style="font:700 34px/1.05 Georgia,serif;margin:8px 0 10px">Want Unplug to understand where you want to grow?</h2>'
        + '<p style="font:14px/1.55 Inter,Arial,sans-serif">Start the free Growth Application. It autosaves, can be resumed later and becomes your ongoing Growth Journey once submitted.</p>'
        + '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:18px"><a href="/unplug-growth-application.html" style="background:#ff2f00;color:#fff;text-decoration:none;padding:12px 17px;border-radius:999px;font-weight:800">Start Growth Application</a>'
        + '<button type="button" id="growthPromptLater" style="border:1px solid #000;background:transparent;padding:11px 16px;border-radius:999px;font-weight:800;cursor:pointer">Maybe later</button></div></div>';
      document.body.appendChild(overlay);
      document.getElementById('growthPromptLater').onclick = () => overlay.remove();
    } catch (_) {
      // Dashboard remains usable if Growth configuration is temporarily unavailable.
    }
  }

  async function init() {
    addAdminLink();
    addMemberJourneyLink();
    addResumeLinkControl();
    try {
      const config = await json('/growth-application/public-config');
      renderPlacement(config);
      await maybePromptMember(config);
    } catch (_) {
      // Growth integration is additive; failure must not break existing pages.
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
