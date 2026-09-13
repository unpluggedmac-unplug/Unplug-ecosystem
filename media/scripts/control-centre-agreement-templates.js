(function () {
  'use strict';

  if (location.pathname.indexOf('unplug-admin-dashboard.html') === -1) return;

  const API = String(window.UNPLUG_RUNTIME_API || '').replace(/\/$/, '');
  const TOKEN = localStorage.getItem('unplug_admin_token')
    || localStorage.getItem('adminAccessToken')
    || localStorage.getItem('accessToken')
    || '';

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === 'className') node.className = value;
      else if (key === 'style') node.style.cssText = value;
      else node.setAttribute(key, value);
    });
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
      opts.headers || {}
    );
    const response = await fetch(API + path, Object.assign({}, opts, { headers }));
    const type = response.headers.get('content-type') || '';
    const body = type.includes('json') ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) throw new Error((body && body.error) || ('Request failed (' + response.status + ')'));
    return body;
  }

  function openGenerator() {
    location.href = '/unplug-agreement-generator-admin.html';
  }

  function addButton(row, label, onClick, primary) {
    const button = el('button', { type: 'button', className: primary ? 'btn btn-solid' : 'btn' }, label);
    button.style.width = 'auto';
    button.addEventListener('click', onClick);
    row.appendChild(button);
    return button;
  }

  function statusPill(text) {
    const span = el('span', { className: 'status-pill approved' }, text);
    span.style.marginRight = '7px';
    return span;
  }

  function templateCard(template, reload) {
    const card = el('div', { style: 'padding:15px 18px;border-bottom:1px solid var(--paper-line);' });
    const top = el('div', { style: 'display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;' });
    const copy = el('div', { style: 'min-width:240px;flex:1;' });
    const title = el('strong', {}, template.title || template.name || 'Agreement template');
    title.style.fontSize = '14px';
    copy.appendChild(title);
    const meta = el('div', { style: 'font-size:12px;color:var(--slate);margin-top:5px;' });
    meta.appendChild(statusPill((template.approval_status || 'draft').replace('_', ' ')));
    meta.appendChild(document.createTextNode('v' + (template.version || 1) + ' · ' + (template.field_count || 0) + ' fields'));
    copy.appendChild(meta);
    top.appendChild(copy);

    const actions = el('div', { style: 'display:flex;gap:7px;flex-wrap:wrap;' });
    addButton(actions, 'Edit / Full Access', openGenerator, false);
    addButton(actions, 'Duplicate', async function () {
      const name = prompt('Name for duplicated template:', (template.name || template.title || 'Agreement') + ' — Copy');
      if (name === null) return;
      try {
        await api('/agreement-forms/generator/admin/templates/' + encodeURIComponent(template.id) + '/duplicate', {
          method: 'POST',
          body: JSON.stringify({ name: name })
        });
        await reload();
      } catch (err) {
        alert(err.message || 'Could not duplicate the agreement template.');
      }
    }, false);
    addButton(actions, 'Create Agreement', async function () {
      try {
        const result = await api('/agreement-forms/generator/admin/agreements', {
          method: 'POST',
          body: JSON.stringify({ templateId: template.id })
        });
        const ref = result && result.agreement && result.agreement.reference ? ' ' + result.agreement.reference : '';
        alert('Agreement created.' + ref + ' Opening the Agreement Generator now.');
        openGenerator();
      } catch (err) {
        alert(err.message || 'Could not create an agreement from this template.');
      }
    }, true);
    top.appendChild(actions);
    card.appendChild(top);
    return card;
  }

  function masterCard(master, reload) {
    const card = el('div', { style: 'padding:16px 18px;border-bottom:1px solid var(--paper-line);background:rgba(210,7,9,.035);' });
    const top = el('div', { style: 'display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;' });
    const copy = el('div', { style: 'min-width:260px;flex:1;' });
    const heading = el('strong', {}, 'Agreement Details — Master Template');
    heading.style.fontSize = '15px';
    copy.appendChild(heading);
    const badges = el('div', { style: 'margin-top:6px;' });
    badges.appendChild(statusPill('System Master'));
    const agreementBadge = statusPill('Agreement');
    agreementBadge.className = 'status-pill pending';
    badges.appendChild(agreementBadge);
    copy.appendChild(badges);
    copy.appendChild(el('p', { style: 'font-size:12.5px;color:var(--slate);margin:9px 0 0;line-height:1.55;' },
      'Reusable master containing the full agreement framework. Create an editable template from it, then change wording, fields, sections, clauses, notes, uploads, signatures and agreement-specific questions without changing the protected system master.'));
    top.appendChild(copy);

    const actions = el('div', { style: 'display:flex;gap:7px;flex-wrap:wrap;' });
    addButton(actions, 'Open Master', openGenerator, false);
    addButton(actions, 'Duplicate / Create Template', async function () {
      const name = prompt('Name for the new agreement template:', 'Agreement Details — Master Copy');
      if (name === null) return;
      try {
        await api('/agreement-forms/generator/admin/templates', {
          method: 'POST',
          body: JSON.stringify({ presetId: master.id, name: name || undefined })
        });
        await reload();
      } catch (err) {
        alert(err.message || 'Could not create a template from the master.');
      }
    }, true);
    top.appendChild(actions);
    card.appendChild(top);
    return card;
  }

  async function render() {
    const section = document.getElementById('section-forms');
    const genericList = document.getElementById('fbListPanel');
    if (!section || !genericList) return;

    let panel = document.getElementById('agreementTemplateBridge');
    if (!panel) {
      panel = el('div', { id: 'agreementTemplateBridge', className: 'panel' });
      genericList.parentNode.insertBefore(panel, genericList);
    }

    panel.textContent = '';
    const head = el('div', { className: 'panel-head', style: 'display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;' });
    const headCopy = el('div');
    headCopy.appendChild(el('h3', { style: 'margin:0;' }, 'Agreement Templates'));
    headCopy.appendChild(el('div', { style: 'font-size:12px;color:var(--slate);margin-top:4px;' }, 'Master template and every agreement template created from it.'));
    head.appendChild(headCopy);
    addButton(head, 'Open Agreement Generator', openGenerator, true);
    panel.appendChild(head);

    const body = el('div', { className: 'panel-body', style: 'padding:0;' });
    body.appendChild(el('div', { className: 'loading-state' }, 'Loading agreement templates…'));
    panel.appendChild(body);

    if (!TOKEN) {
      body.textContent = '';
      body.appendChild(el('div', { className: 'empty-state' }, 'Your admin session is missing. Sign in again to load agreement templates.'));
      return;
    }

    try {
      const [presetData, templateData] = await Promise.all([
        api('/agreement-forms/generator/admin/presets'),
        api('/agreement-forms/generator/admin/templates')
      ]);
      const presets = presetData.presets || [];
      const templates = templateData.templates || [];
      const master = presets.find((p) => p.name === 'Agreement Details — Master') || presets[0] || null;

      body.textContent = '';
      if (master) body.appendChild(masterCard(master, render));
      else body.appendChild(el('div', { className: 'empty-state' }, 'The Agreement Details master preset could not be found.'));

      if (templates.length) {
        templates.forEach((template) => body.appendChild(templateCard(template, render)));
      } else {
        body.appendChild(el('div', { className: 'empty-state' }, 'No editable agreement templates have been created yet. Use the Master Template above to create the first one.'));
      }
    } catch (err) {
      body.textContent = '';
      body.appendChild(el('div', { className: 'empty-state' }, 'Could not load Agreement Templates: ' + (err.message || 'Unknown error')));
    }
  }

  function boot() {
    render();
    const formNav = document.querySelector('a[data-section="forms"]');
    if (formNav) formNav.addEventListener('click', function () { setTimeout(render, 0); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
