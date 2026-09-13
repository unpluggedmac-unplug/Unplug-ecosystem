(function () {
  'use strict';

  if (String(location.pathname || '').indexOf('unplug-admin-dashboard.html') === -1) return;

  const MASTER_NAME = 'Agreement Details — Master';
  const PANEL_ID = 'agreementFormsControlCentrePanel';
  let presets = [];
  let templates = [];
  let loading = false;

  function apiBase() {
    return String(window.UNPLUG_RUNTIME_API || localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem.onrender.com').replace(/\/$/, '');
  }

  function adminToken() {
    try {
      return localStorage.getItem('unplug_admin_token')
        || localStorage.getItem('adminAccessToken')
        || localStorage.getItem('accessToken')
        || '';
    } catch (_) { return ''; }
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normal(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  async function api(path, options) {
    const opt = options || {};
    const token = adminToken();
    const response = await fetch(apiBase() + path, Object.assign({}, opt, {
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        opt.headers || {}
      )
    }));
    const type = response.headers.get('content-type') || '';
    const data = type.indexOf('json') !== -1
      ? await response.json().catch(function () { return {}; })
      : await response.text();
    if (!response.ok) {
      const err = new Error(data && data.error ? data.error : 'Request failed (' + response.status + ')');
      err.status = response.status;
      throw err;
    }
    return data;
  }

  async function protectedBlob(path) {
    const token = adminToken();
    const response = await fetch(apiBase() + path, {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    if (!response.ok) {
      const data = await response.json().catch(function () { return {}; });
      throw new Error(data.error || 'Could not load that preview.');
    }
    return response.blob();
  }

  function notify(message, isError) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, !!isError);
      return;
    }
    let box = document.getElementById('agreementFormsControlCentreToast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'agreementFormsControlCentreToast';
      box.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:99999;background:#000001;color:#fff;padding:12px 16px;font:600 12px/1.4 Inter,Arial,sans-serif;max-width:420px;box-shadow:0 8px 28px rgba(0,0,0,.25)';
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.style.background = isError ? '#8a1010' : '#000001';
    clearTimeout(box._hideTimer);
    box._hideTimer = setTimeout(function () { if (box.parentNode) box.remove(); }, 5000);
  }

  function ensurePanel() {
    const standardPanel = document.getElementById('fbListPanel');
    if (!standardPanel || !standardPanel.parentNode) return null;

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = PANEL_ID;
      panel.innerHTML = [
        '<div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">',
        '  <div><h3 style="margin:0;">Agreement Templates</h3><div style="font-size:12px;color:var(--slate);margin-top:4px;">The Agreement Details master and every agreement created from it. Admin has full builder access without mixing these records into standard forms.</div></div>',
        '  <div style="display:flex;gap:8px;flex-wrap:wrap;">',
        '    <button type="button" class="btn btn-line" id="afccOpenGenerator" style="width:auto;">Open Agreement Generator</button>',
        '    <button type="button" class="btn btn-solid" id="afccNewAgreement" style="width:auto;">New Agreement From Master</button>',
        '  </div>',
        '</div>',
        '<div class="panel-body" id="afccList" style="padding:0;"><div class="loading-state">Loading agreement templates…</div></div>'
      ].join('');
      standardPanel.parentNode.insertBefore(panel, standardPanel);

      panel.querySelector('#afccOpenGenerator').addEventListener('click', function () {
        location.href = '/unplug-agreement-generator-admin.html';
      });
      panel.querySelector('#afccNewAgreement').addEventListener('click', createTemplateFromMaster);
    }

    const standardHead = standardPanel.querySelector('.panel-head span');
    if (standardHead && normal(standardHead.textContent) === 'your forms') standardHead.textContent = 'Standard Forms';
    const newForm = document.getElementById('fbNew');
    if (newForm && normal(newForm.textContent) === 'new form') newForm.textContent = 'New Standard Form';
    return panel;
  }

  function masterPreset() {
    return presets.find(function (p) { return normal(p.name) === normal(MASTER_NAME); })
      || presets.find(function (p) { return p.is_builtin && normal(p.category) === 'master'; })
      || null;
  }

  function workingMaster(master) {
    if (!master) return templates.find(function (t) { return normal(t.name) === normal(MASTER_NAME); }) || null;
    return templates.find(function (t) {
      return Number(t.template_id) === Number(master.id) && normal(t.name) === normal(MASTER_NAME);
    }) || templates.find(function (t) { return normal(t.name) === normal(MASTER_NAME); }) || null;
  }

  function statusLabel(t) {
    return String((t && (t.approval_status || t.status)) || 'draft').replace(/_/g, ' ');
  }

  function cardHtml(t, options) {
    const opt = options || {};
    const isMaster = !!opt.master;
    const fieldCount = Number(t.field_count != null ? t.field_count : ((t.fields || []).length || 0));
    const version = t.version ? 'v' + esc(t.version) : 'system definition';
    const badge = isMaster
      ? '<span class="status-pill approved" style="margin-right:6px;">MASTER</span><span class="status-pill" style="background:rgba(0,0,0,.06);color:var(--slate);">SYSTEM TEMPLATE</span>'
      : '<span class="status-pill pending">' + esc(statusLabel(t)) + '</span>';
    const note = isMaster
      ? 'Reusable master for Agreement Identification, Party A, Party B, Scope, Financial, Rights/IP, Privacy, Legal, Agreement-Specific Questions and Declarations/Signatures.'
      : esc(t.description || 'Agreement template created from the master framework.');

    return [
      '<div data-afcc-card="' + esc(t.id) + '" style="padding:16px 18px;border-bottom:1px solid var(--paper-line);">',
      '  <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap;">',
      '    <div style="flex:1;min-width:260px;">',
      '      <div style="margin-bottom:7px;">' + badge + '</div>',
      '      <strong style="font-family:\'Playfair Display\',serif;font-size:17px;">' + esc(t.title || t.name || MASTER_NAME) + '</strong>',
      '      <div style="font-size:12px;color:var(--slate);margin-top:4px;">' + version + ' · ' + fieldCount + ' fields' + (t.latest_approved_version ? ' · latest approved v' + esc(t.latest_approved_version) : '') + '</div>',
      '      <p style="font-size:12.5px;line-height:1.55;color:var(--slate);margin:9px 0 0;max-width:900px;">' + note + '</p>',
      '    </div>',
      '    <div class="row-actions" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">',
      '      <button type="button" class="approve" data-afcc-action="edit" data-afcc-id="' + esc(t.id) + '" data-afcc-master="' + (isMaster ? '1' : '0') + '">' + (isMaster ? 'Edit Master' : 'Edit / Full Access') + '</button>',
      '      <button type="button" data-afcc-action="duplicate" data-afcc-id="' + esc(t.id) + '" data-afcc-master="' + (isMaster ? '1' : '0') + '">Duplicate</button>',
      '      <button type="button" data-afcc-action="preview" data-afcc-id="' + esc(t.id) + '" data-afcc-master="' + (isMaster ? '1' : '0') + '">Preview</button>',
      '      <button type="button" data-afcc-action="create" data-afcc-id="' + esc(t.id) + '" data-afcc-master="' + (isMaster ? '1' : '0') + '">Create Agreement</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function bindCards() {
    const host = document.getElementById('afccList');
    if (!host) return;
    host.querySelectorAll('[data-afcc-action]').forEach(function (button) {
      button.addEventListener('click', async function () {
        const action = button.getAttribute('data-afcc-action');
        const isMaster = button.getAttribute('data-afcc-master') === '1';
        let id = Number(button.getAttribute('data-afcc-id'));
        button.disabled = true;
        try {
          if (isMaster) {
            const master = masterPreset();
            const working = await ensureWorkingMaster(master);
            id = working.id;
          }
          if (action === 'edit') {
            openGeneratorTemplate(id);
          } else if (action === 'duplicate') {
            await duplicateTemplate(id);
          } else if (action === 'preview') {
            await previewTemplate(id);
          } else if (action === 'create') {
            const t = templates.find(function (x) { return Number(x.id) === Number(id); }) || await getTemplate(id);
            await createIndividualAgreement(t);
          }
        } catch (err) {
          notify(err.message || 'Could not complete that agreement action.', true);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  function render() {
    const host = document.getElementById('afccList');
    if (!host) return;
    const master = masterPreset();
    const editableMaster = workingMaster(master);
    const cards = [];

    if (master) {
      const displayMaster = editableMaster || Object.assign({}, master, {
        title: master.name,
        field_count: (master.fields || []).length,
        version: null,
        approval_status: 'master'
      });
      cards.push(cardHtml(displayMaster, { master: true }));
    } else {
      cards.push('<div style="padding:16px 18px;color:var(--red);">The Agreement Details master definition was not returned by the server. Check that the Agreement Generator migrations have been applied.</div>');
    }

    templates.filter(function (t) {
      return !editableMaster || Number(t.id) !== Number(editableMaster.id);
    }).forEach(function (t) { cards.push(cardHtml(t)); });

    host.innerHTML = cards.join('');
    bindCards();
  }

  async function refreshAgreementTemplates() {
    if (loading) return;
    const panel = ensurePanel();
    if (!panel) return;
    const host = document.getElementById('afccList');
    if (!adminToken()) {
      if (host) host.innerHTML = '<div style="padding:16px 18px;color:var(--slate);">Sign in as an administrator to load agreement templates.</div>';
      return;
    }
    loading = true;
    if (host) host.innerHTML = '<div class="loading-state">Loading agreement templates…</div>';
    try {
      const result = await Promise.all([
        api('/agreement-forms/generator/admin/presets'),
        api('/agreement-forms/generator/admin/templates')
      ]);
      presets = result[0].presets || [];
      templates = result[1].templates || [];
      render();
    } catch (err) {
      if (host) host.innerHTML = '<div style="padding:16px 18px;color:var(--red);">Could not load agreement templates: ' + esc(err.message) + '</div>';
    } finally {
      loading = false;
    }
  }

  async function ensureWorkingMaster(master) {
    if (!master) throw new Error('Agreement Details — Master is not available.');
    let existing = workingMaster(master);
    if (existing) return existing;

    try {
      const made = await api('/agreement-forms/generator/admin/templates', {
        method: 'POST',
        body: JSON.stringify({ presetId: master.id, name: MASTER_NAME })
      });
      existing = made.form;
    } catch (err) {
      if (err.status !== 409) throw err;
      const d = await api('/agreement-forms/generator/admin/templates');
      templates = d.templates || [];
      existing = workingMaster(master);
      if (!existing) throw err;
    }

    if (!templates.some(function (t) { return Number(t.id) === Number(existing.id); })) templates.unshift(existing);
    render();
    return existing;
  }

  async function getTemplate(id) {
    const d = await api('/agreement-forms/generator/admin/templates/' + encodeURIComponent(id));
    return d.form;
  }

  function openGeneratorTemplate(id) {
    location.href = '/unplug-agreement-generator-admin.html?template=' + encodeURIComponent(id);
  }

  async function createTemplateFromMaster() {
    try {
      const master = masterPreset() || (await api('/agreement-forms/generator/admin/presets')).presets.find(function (p) { return normal(p.name) === normal(MASTER_NAME); });
      if (!master) throw new Error('Agreement Details — Master is not available.');
      const name = prompt('Name this new agreement template:', 'New Agreement');
      if (name === null || !String(name).trim()) return;
      const made = await api('/agreement-forms/generator/admin/templates', {
        method: 'POST',
        body: JSON.stringify({ presetId: master.id, name: String(name).trim() })
      });
      notify('Agreement template created from the master.', false);
      await refreshAgreementTemplates();
      openGeneratorTemplate(made.form.id);
    } catch (err) {
      notify(err.message || 'Could not create the agreement template.', true);
    }
  }

  async function duplicateTemplate(id) {
    const source = templates.find(function (t) { return Number(t.id) === Number(id); }) || await getTemplate(id);
    const name = prompt('Name for the duplicated agreement template:', (source.name || source.title || 'Agreement') + ' — Copy');
    if (name === null || !String(name).trim()) return;
    const made = await api('/agreement-forms/generator/admin/templates/' + encodeURIComponent(id) + '/duplicate', {
      method: 'POST',
      body: JSON.stringify({ name: String(name).trim() })
    });
    notify('Agreement template duplicated. The copy is independent from the master.', false);
    await refreshAgreementTemplates();
    openGeneratorTemplate(made.form.id);
  }

  async function previewTemplate(id) {
    const data = await protectedBlob('/agreement-forms/admin/' + encodeURIComponent(id) + '/preview/document');
    const url = URL.createObjectURL(data);
    window.open(url, '_blank', 'noopener');
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  async function createIndividualAgreement(template) {
    if (!template || !template.id) throw new Error('Choose an agreement template first.');
    const body = { templateId: template.id };
    if (template.signer_type === 'choice') {
      const type = prompt('Party B type: type "individual" or "business". Leave blank to let Party B choose later.', '');
      if (type === null) return;
      if (type && ['individual', 'business'].indexOf(String(type).toLowerCase()) === -1) throw new Error('Party B type must be individual or business.');
      if (type) body.partyBType = String(type).toLowerCase();
    }
    const made = await api('/agreement-forms/generator/admin/agreements', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (made.secureLink && navigator.clipboard) navigator.clipboard.writeText(made.secureLink).catch(function () {});
    notify('Agreement created: ' + (made.agreement && made.agreement.reference ? made.agreement.reference : 'new record'), false);
    location.href = '/unplug-agreement-generator-admin.html?tab=agreements&agreement=' + encodeURIComponent(made.agreement.id);
  }

  function rewriteStandardEmptyState() {
    const host = document.getElementById('fbList');
    if (!host) return;
    const text = normal(host.textContent);
    if (text.indexOf('no forms yet') === 0) {
      const p = host.querySelector('p');
      if (p) p.textContent = 'No standard forms yet. Agreement templates are managed above.';
    }
  }

  function install() {
    ensurePanel();

    const original = window.loadForms;
    if (typeof original === 'function' && !original.__agreementTemplatesIntegrated) {
      const wrapped = function () {
        const result = original.apply(this, arguments);
        Promise.resolve(result).finally(function () {
          rewriteStandardEmptyState();
          refreshAgreementTemplates();
        });
        return result;
      };
      wrapped.__agreementTemplatesIntegrated = true;
      window.loadForms = wrapped;
    }

    document.addEventListener('click', function (event) {
      const link = event.target && event.target.closest ? event.target.closest('[data-section="forms"]') : null;
      if (!link) return;
      setTimeout(function () {
        ensurePanel();
        rewriteStandardEmptyState();
        refreshAgreementTemplates();
      }, 0);
    });

    const formsSection = document.getElementById('section-forms');
    if (formsSection && formsSection.classList.contains('active')) refreshAgreementTemplates();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}());
