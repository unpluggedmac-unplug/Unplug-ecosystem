(function () {
  'use strict';

  const path = String(location.pathname || '').toLowerCase();
  if (path.indexOf('unplug-admin-dashboard') === -1) return;
  if (window.__unplugAgreementFormsRouteFixLoaded) return;
  window.__unplugAgreementFormsRouteFixLoaded = true;

  const MASTER_NAME = 'Agreement Details — Master';
  const PANEL_ID = 'agreementFormsControlCentrePanel';
  const API = String(window.UNPLUG_RUNTIME_API || localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem.onrender.com').replace(/\/$/, '');
  let presets = [];
  let templates = [];
  let loading = false;

  function adminToken() {
    try {
      return localStorage.getItem('unplug_admin_token') || localStorage.getItem('adminAccessToken') || localStorage.getItem('accessToken') || '';
    } catch (_) { return ''; }
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function normal(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  async function api(pathname, options) {
    const token = adminToken();
    const opt = options || {};
    const response = await fetch(API + pathname, Object.assign({}, opt, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, opt.headers || {})
    }));
    const type = response.headers.get('content-type') || '';
    const data = type.indexOf('json') !== -1 ? await response.json().catch(function () { return {}; }) : await response.text();
    if (!response.ok) {
      const err = new Error(data && data.error ? data.error : 'Request failed (' + response.status + ')');
      err.status = response.status;
      throw err;
    }
    return data;
  }
  async function protectedBlob(pathname) {
    const token = adminToken();
    const response = await fetch(API + pathname, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (!response.ok) {
      const data = await response.json().catch(function () { return {}; });
      throw new Error(data.error || 'Could not load that preview.');
    }
    return response.blob();
  }
  function notify(message, isError) {
    if (typeof window.showToast === 'function') return window.showToast(message, !!isError);
    alert(message);
  }
  function masterPreset() {
    return presets.find(function (p) { return normal(p.name) === normal(MASTER_NAME); })
      || presets.find(function (p) { return p.is_builtin && normal(p.category) === 'master'; }) || null;
  }
  function workingMaster(master) {
    if (!master) return templates.find(function (t) { return normal(t.name) === normal(MASTER_NAME); }) || null;
    return templates.find(function (t) { return Number(t.template_id) === Number(master.id) && normal(t.name) === normal(MASTER_NAME); })
      || templates.find(function (t) { return normal(t.name) === normal(MASTER_NAME); }) || null;
  }
  function openTemplate(id) { location.href = '/unplug-agreement-generator-admin?template=' + encodeURIComponent(id); }

  async function ensureWorkingMaster(master) {
    if (!master) throw new Error('Agreement Details — Master is not available.');
    let existing = workingMaster(master);
    if (existing) return existing;
    try {
      const made = await api('/agreement-forms/generator/admin/templates', {
        method: 'POST', body: JSON.stringify({ presetId: master.id, name: MASTER_NAME })
      });
      existing = made.form;
    } catch (err) {
      if (err.status !== 409) throw err;
      const data = await api('/agreement-forms/generator/admin/templates');
      templates = data.templates || [];
      existing = workingMaster(master);
      if (!existing) throw err;
    }
    if (!templates.some(function (t) { return Number(t.id) === Number(existing.id); })) templates.unshift(existing);
    return existing;
  }

  async function duplicateTemplate(id) {
    const source = templates.find(function (t) { return Number(t.id) === Number(id); }) || (await api('/agreement-forms/generator/admin/templates/' + encodeURIComponent(id))).form;
    const name = prompt('Name for the duplicated agreement template:', (source.name || source.title || 'Agreement') + ' — Copy');
    if (name === null || !String(name).trim()) return;
    const made = await api('/agreement-forms/generator/admin/templates/' + encodeURIComponent(id) + '/duplicate', {
      method: 'POST', body: JSON.stringify({ name: String(name).trim() })
    });
    notify('Agreement template duplicated. The copy is independent from the master.', false);
    await refresh();
    openTemplate(made.form.id);
  }
  async function previewTemplate(id) {
    const blob = await protectedBlob('/agreement-forms/admin/' + encodeURIComponent(id) + '/preview/document');
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  async function createAgreement(template) {
    const body = { templateId: template.id };
    if (template.signer_type === 'choice') {
      const type = prompt('Party B type: type "individual" or "business". Leave blank to let Party B choose later.', '');
      if (type === null) return;
      if (type && ['individual', 'business'].indexOf(String(type).toLowerCase()) === -1) throw new Error('Party B type must be individual or business.');
      if (type) body.partyBType = String(type).toLowerCase();
    }
    const made = await api('/agreement-forms/generator/admin/agreements', { method: 'POST', body: JSON.stringify(body) });
    notify('Agreement created: ' + (made.agreement && made.agreement.reference ? made.agreement.reference : 'new record'), false);
    location.href = '/unplug-agreement-generator-admin?tab=agreements&agreement=' + encodeURIComponent(made.agreement.id);
  }
  async function createTemplateFromMaster() {
    const master = masterPreset();
    if (!master) throw new Error('Agreement Details — Master is not available.');
    const name = prompt('Name this new agreement template:', 'New Agreement');
    if (name === null || !String(name).trim()) return;
    const made = await api('/agreement-forms/generator/admin/templates', {
      method: 'POST', body: JSON.stringify({ presetId: master.id, name: String(name).trim() })
    });
    notify('Agreement template created from the master.', false);
    await refresh();
    openTemplate(made.form.id);
  }

  function card(template, isMaster) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:16px 18px;border-bottom:1px solid var(--paper-line);';
    const title = esc(template.title || template.name || MASTER_NAME);
    const status = esc(String(template.approval_status || (isMaster ? 'master' : 'draft')).replace(/_/g, ' '));
    const fields = Number(template.field_count != null ? template.field_count : ((template.fields || []).length || 0));
    wrap.innerHTML = '<div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap;">'
      + '<div style="flex:1;min-width:270px;">'
      + (isMaster ? '<span class="status-pill approved" style="margin-right:6px;">MASTER</span><span class="status-pill">SYSTEM TEMPLATE</span>' : '<span class="status-pill pending">' + status + '</span>')
      + '<div style="margin-top:8px;"><strong style="font-family:\'Playfair Display\',serif;font-size:17px;">' + title + '</strong></div>'
      + '<div style="font-size:12px;color:var(--slate);margin-top:4px;">' + (template.version ? 'v' + esc(template.version) : 'system definition') + ' · ' + fields + ' fields</div>'
      + '<p style="font-size:12.5px;line-height:1.55;color:var(--slate);margin:9px 0 0;">' + (isMaster ? 'Reusable master for Agreement Identification, Party A, Party B, Scope, Financial, Rights/IP, Privacy, Legal, Agreement-Specific Questions and Declarations/Signatures.' : 'Agreement template created from the master framework.') + '</p>'
      + '</div><div class="row-actions" style="display:flex;gap:6px;flex-wrap:wrap;">'
      + '<button class="approve" data-action="edit">' + (isMaster ? 'Edit Master' : 'Edit / Full Access') + '</button>'
      + '<button data-action="duplicate">Duplicate</button><button data-action="preview">Preview</button><button data-action="create">Create Agreement</button>'
      + '</div></div>';
    wrap.querySelectorAll('[data-action]').forEach(function (button) {
      button.addEventListener('click', async function () {
        button.disabled = true;
        try {
          let actual = template;
          if (isMaster) actual = await ensureWorkingMaster(masterPreset());
          if (button.dataset.action === 'edit') openTemplate(actual.id);
          if (button.dataset.action === 'duplicate') await duplicateTemplate(actual.id);
          if (button.dataset.action === 'preview') await previewTemplate(actual.id);
          if (button.dataset.action === 'create') await createAgreement(actual);
        } catch (err) { notify(err.message || 'Could not complete that agreement action.', true); }
        finally { button.disabled = false; }
      });
    });
    return wrap;
  }

  function ensurePanel() {
    const standard = document.getElementById('fbListPanel');
    if (!standard || !standard.parentNode) return null;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.className = 'panel';
      panel.innerHTML = '<div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;"><div><h3 style="margin:0;">Agreement Templates</h3><div style="font-size:12px;color:var(--slate);margin-top:4px;">The Agreement Details master and every agreement created from it. Admin has full builder access.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn" id="afRouteOpen">Open Agreement Generator</button><button class="btn btn-solid" id="afRouteNew">New Agreement From Master</button></div></div><div class="panel-body" id="afRouteList" style="padding:0;"><div class="loading-state">Loading agreement templates…</div></div>';
      standard.parentNode.insertBefore(panel, standard);
      panel.querySelector('#afRouteOpen').onclick = function () { location.href = '/unplug-agreement-generator-admin'; };
      panel.querySelector('#afRouteNew').onclick = function () { createTemplateFromMaster().catch(function (err) { notify(err.message, true); }); };
    }
    const head = standard.querySelector('.panel-head span');
    if (head && normal(head.textContent) === 'your forms') head.textContent = 'Standard Forms';
    const newForm = document.getElementById('fbNew');
    if (newForm && normal(newForm.textContent) === 'new form') newForm.textContent = 'New Standard Form';
    return panel;
  }

  async function refresh() {
    if (loading) return;
    const panel = ensurePanel();
    if (!panel) return;
    const host = document.getElementById('afRouteList');
    if (!adminToken()) { host.innerHTML = '<div class="empty-state">Sign in as an administrator to load agreement templates.</div>'; return; }
    loading = true;
    host.innerHTML = '<div class="loading-state">Loading agreement templates…</div>';
    try {
      const result = await Promise.all([api('/agreement-forms/generator/admin/presets'), api('/agreement-forms/generator/admin/templates')]);
      presets = result[0].presets || [];
      templates = result[1].templates || [];
      host.innerHTML = '';
      const master = masterPreset();
      const editable = workingMaster(master);
      if (master) host.appendChild(card(editable || Object.assign({}, master, { title: master.name, approval_status: 'master' }), true));
      else host.innerHTML = '<div class="empty-state" style="color:var(--red);">Agreement Details — Master was not returned by the server.</div>';
      templates.filter(function (t) { return !editable || Number(t.id) !== Number(editable.id); }).forEach(function (t) { host.appendChild(card(t, false)); });
      if (!templates.length && master) host.appendChild(document.createElement('div')).className = 'empty-state';
    } catch (err) {
      host.innerHTML = '<div class="empty-state" style="color:var(--red);">Could not load agreement templates: ' + esc(err.message) + '</div>';
    } finally { loading = false; }
  }

  function install() {
    ensurePanel();
    document.addEventListener('click', function (event) {
      const link = event.target && event.target.closest ? event.target.closest('[data-section="forms"]') : null;
      if (link) setTimeout(refresh, 0);
    });
    window.addEventListener('unplug:auth-changed', function () { setTimeout(refresh, 0); });
    const forms = document.getElementById('section-forms');
    if (forms && forms.classList.contains('active')) refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}());