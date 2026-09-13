'use strict';

(function growthIntegration(){
  if (window.__unplugGrowthIntegrationLoaded) return;
  window.__unplugGrowthIntegrationLoaded = true;

  const API = String(window.UNPLUG_RUNTIME_API || 'https://unplug-ecosystem.onrender.com').replace(/\/$/, '');
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const MEMBER_V2 = '/unplug-growth-application-v2.html';
  const ADMIN_V2 = '/unplug-growth-applications-admin-v2.html';

  function isMemberDashboard() {
    return /^\/unplug-member-dashboard(?:\.html)?\/?$/i.test(path);
  }

  function isGrowthMemberV2() {
    return /^\/unplug-growth-application-v2(?:\.html)?\/?$/i.test(path);
  }

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
    if (!/^\/unplug-admin-dashboard(?:\.html)?\/?$/i.test(path)) return;

    const legacySelector = 'a[href="/unplug-growth-applications-admin"],a[href="/unplug-growth-applications-admin.html"]';
    document.querySelectorAll(legacySelector).forEach((a) => a.remove());

    const v2Selector = 'a[href="/unplug-growth-applications-admin-v2"],a[href="/unplug-growth-applications-admin-v2.html"]';
    const existing = Array.from(document.querySelectorAll(v2Selector));
    if (existing.length) {
      const keep = existing.shift();
      keep.href = ADMIN_V2;
      keep.textContent = 'Growth Applications';
      keep.setAttribute('data-unplug-growth-admin-link', 'true');
      existing.forEach((a) => a.remove());
      return;
    }

    if (document.querySelector('[data-unplug-growth-admin-link]')) return;
    const group = document.querySelector('.nav-group[data-group="marketing"] .nav-group-items')
      || document.querySelector('.nav-group-items')
      || document.querySelector('nav');
    if (!group) return;
    const a = document.createElement('a');
    a.href = ADMIN_V2;
    a.textContent = 'Growth Applications';
    a.setAttribute('data-unplug-growth-admin-link', 'true');
    a.style.cssText = 'display:block;padding:9px 12px;text-decoration:none';
    group.appendChild(a);
  }

  function addMemberJourneyLink() {
    if (!isMemberDashboard()) return;
    if (document.querySelector('[data-unplug-growth-journey-link]')) return;
    const sidebar = document.querySelector('.ms-sidebar');
    if (!sidebar) return;
    const a = document.createElement('a');
    a.href = MEMBER_V2;
    a.className = 'ms-navlink';
    a.setAttribute('data-unplug-growth-journey-link', 'true');
    a.innerHTML = '<span aria-hidden="true">🌱</span> My Growth Journey';
    const services = sidebar.querySelector('[data-ms="services"]');
    sidebar.insertBefore(a, services || sidebar.querySelector('.ms-logout') || null);
  }

  function placementKey() {
    if (isMemberDashboard()) return 'member_dashboard';
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
      + `<a href="${MEMBER_V2}" style="display:inline-block;background:#ff2f00;color:#fff;text-decoration:none;font:800 13px/1 Inter,Arial,sans-serif;padding:13px 18px;border-radius:999px">Start My Growth Journey</a>`
      + '</div>';
    const header = document.querySelector('.site-header, header');
    if (header && header.parentNode) header.parentNode.insertBefore(block, header.nextSibling);
    else document.body.insertBefore(block, document.body.firstChild);
  }

  async function maybePromptMember(config) {
    if (!isMemberDashboard()) return;
    if (config.site_visibility !== 'visible') return;
    const enabled = (config.placements || []).some((p) => p.page_key === 'member_dashboard' && p.enabled === true);
    if (!enabled || !token()) return;
    try {
      const mine = await json('/growth-application/v2/applications');
      if ((mine.applications || []).length > 0) return;
      if (document.getElementById('unplug-growth-member-prompt')) return;

      const overlay = document.createElement('div');
      overlay.id = 'unplug-growth-member-prompt';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px';
      overlay.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="growthPromptTitle" style="max-width:560px;width:100%;background:#ebe9e9;color:#000001;border-radius:20px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.3)">'
        + '<div style="font:800 11px/1.2 Inter,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#e83b00">My Growth Journey</div>'
        + '<h2 id="growthPromptTitle" style="font:700 34px/1.05 Georgia,serif;margin:8px 0 10px">Want Unplug to understand where you want to grow?</h2>'
        + '<p style="font:14px/1.55 Inter,Arial,sans-serif">Start the free Growth Application. It saves as you go and becomes your ongoing Growth Journey once submitted.</p>'
        + `<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:18px"><a href="${MEMBER_V2}" style="background:#ff2f00;color:#fff;text-decoration:none;padding:12px 17px;border-radius:999px;font-weight:800">Start Growth Application</a>`
        + '<button type="button" id="growthPromptLater" style="border:1px solid #000;background:transparent;padding:11px 16px;border-radius:999px;font-weight:800;cursor:pointer">Maybe later</button></div></div>';
      document.body.appendChild(overlay);
      document.getElementById('growthPromptLater').onclick = () => overlay.remove();
    } catch (_) {
      // Growth integration is additive; dashboard usability is never dependent on it.
    }
  }

  function enhanceGrowthMemberV2() {
    if (!isGrowthMemberV2()) return;

    if (!document.getElementById('unplug-growth-ux-fixes')) {
      const style = document.createElement('style');
      style.id = 'unplug-growth-ux-fixes';
      style.textContent = [
        '#flash:not(:empty){position:fixed;right:18px;top:78px;z-index:2147482500;width:min(430px,calc(100vw - 36px));box-shadow:0 14px 40px rgba(0,0,0,.2);border-radius:12px}',
        '.unplug-growth-inline-status{font-size:12px;font-weight:850;min-height:18px;padding:4px 2px}',
        '.unplug-growth-inline-status.ok{color:#146c43}',
        '.unplug-growth-inline-status.error{color:#9c1c00}',
        '.unplug-growth-inline-status.working{color:#6e6864}',
      ].join('');
      document.head.appendChild(style);
    }

    const top = document.querySelector('.top');
    if (top && !top.querySelector('[data-unplug-growth-back]')) {
      const existingBack = top.querySelector('a[href*="unplug-member-dashboard"]');
      if (existingBack) existingBack.setAttribute('data-unplug-growth-back', 'true');
      else {
        const back = document.createElement('a');
        back.href = '/unplug-member-dashboard.html';
        back.textContent = '← My Unplug';
        back.setAttribute('data-unplug-growth-back', 'true');
        back.style.cssText = 'color:#fff;text-decoration:none;font-size:13px;font-weight:800';
        top.appendChild(back);
      }
    }

    const stepStoreKey = (id) => `unplug_growth_last_step_${id}`;
    const currentAppId = () => document.querySelector('.app-row.active[data-app]')?.dataset.app || '';

    function cleanStepLabels() {
      document.querySelectorAll('.step-tab').forEach((button) => {
        const text = String(button.textContent || '').trim();
        const cleaned = text.replace(/^(\d+)\.\s+\1\.\s+/, '$1. ');
        if (cleaned !== text) button.textContent = cleaned;
      });
    }

    function ensureInlineStatus() {
      const actions = document.querySelector('#growthForm .actions');
      if (!actions) return null;
      let status = actions.querySelector('.unplug-growth-inline-status');
      if (!status) {
        status = document.createElement('span');
        status.className = 'unplug-growth-inline-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        actions.appendChild(status);
      }
      return status;
    }

    function setInlineStatus(message, type) {
      const status = ensureInlineStatus();
      if (!status) return;
      status.textContent = message || '';
      status.className = `unplug-growth-inline-status ${type || ''}`.trim();
    }

    function storeStep(index) {
      const id = currentAppId();
      if (!id || !Number.isInteger(index) || index < 0) return;
      try { localStorage.setItem(stepStoreKey(id), String(index)); } catch (_) {}
    }

    function rememberActiveStep() {
      const tabs = Array.from(document.querySelectorAll('.step-tab'));
      const active = tabs.findIndex((button) => button.classList.contains('active'));
      if (active >= 0) storeStep(active);
    }

    let restoreTimer = null;
    function restoreSavedStep() {
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        cleanStepLabels();
        ensureInlineStatus();
        const id = currentAppId();
        const tabs = Array.from(document.querySelectorAll('.step-tab'));
        if (!id || !tabs.length) return;
        let saved = 0;
        try { saved = Number(localStorage.getItem(stepStoreKey(id)) || 0); } catch (_) {}
        if (!Number.isInteger(saved) || saved < 0 || saved >= tabs.length) saved = 0;
        const active = tabs.findIndex((button) => button.classList.contains('active'));
        if (saved !== active) tabs[saved].click();
      }, 120);
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest('.step-tab,#prev,#save,#next,#submit,[data-app]');
      if (!button) return;

      const tabs = Array.from(document.querySelectorAll('.step-tab'));
      const activeIndex = tabs.findIndex((item) => item.classList.contains('active'));
      if (event.isTrusted && button.matches('.step-tab')) storeStep(tabs.indexOf(button));
      if (event.isTrusted && button.matches('#next') && activeIndex >= 0) storeStep(Math.min(tabs.length - 1, activeIndex + 1));
      if (event.isTrusted && button.matches('#prev') && activeIndex >= 0) storeStep(Math.max(0, activeIndex - 1));

      if (button.matches('#save,#next')) {
        const original = String(button.textContent || '').trim();
        setInlineStatus('Saving…', 'working');
        setTimeout(() => {
          if (!button.isConnected) return;
          button.dataset.unplugOriginalText = original;
          button.textContent = 'Saving…';
          button.disabled = true;
        }, 0);
      }

      if (button.matches('[data-app]')) setTimeout(restoreSavedStep, 260);
    }, true);

    const flash = document.getElementById('flash');
    if (flash) {
      new MutationObserver(() => {
        const message = String(flash.textContent || '').trim();
        if (!message) return;
        const ok = /^(Saved\.|Growth Application created|Private upload saved|Growth Application submitted)/i.test(message);
        setInlineStatus(ok ? 'Saved ✓' : message, ok ? 'ok' : 'error');
        if (!ok) rememberActiveStep();
        document.querySelectorAll('#save,#next').forEach((button) => {
          button.disabled = false;
          if (button.dataset.unplugOriginalText) {
            button.textContent = button.dataset.unplugOriginalText;
            delete button.dataset.unplugOriginalText;
          }
        });
        setTimeout(() => {
          const status = document.querySelector('.unplug-growth-inline-status');
          if (status && status.textContent === 'Saved ✓') status.textContent = '';
        }, 3500);
      }).observe(flash, { childList: true, subtree: true, characterData: true });
    }

    const workspace = document.getElementById('workspace');
    if (workspace) {
      new MutationObserver(() => {
        cleanStepLabels();
        ensureInlineStatus();
        restoreSavedStep();
      }).observe(workspace, { childList: true, subtree: true });
    }

    cleanStepLabels();
    ensureInlineStatus();
    restoreSavedStep();
  }

  async function init() {
    addAdminLink();
    addMemberJourneyLink();
    enhanceGrowthMemberV2();
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
