'use strict';

(function growthAdminBuilderHelper(){
  if (window.__unplugGrowthAdminBuilderHelper) return;
  window.__unplugGrowthAdminBuilderHelper = true;

  const EXTRA_TYPES = [
    'short_text','long_text','rich_text','currency','percentage','date_range','social_url','video_url','audio_url',
    'tags','rating','scale','address','country','province','city','suburb','industry','category','skills','interests',
    'image_upload','document_upload','portfolio_upload','consent','declaration','heading','info','admin_only',
  ];
  const fieldCache = new Map();
  let activeFieldId = null;

  const originalFetch = window.fetch.bind(window);

  function cacheVersionPayload(payload){
    const version = payload && payload.version;
    if (!version || !Array.isArray(version.fields)) return;
    version.fields.forEach((field) => fieldCache.set(Number(field.id), field));
  }

  function selectedConditionalRule(field){
    const rules = field && field.visibility_rules;
    if (!rules || typeof rules !== 'object') return null;
    const all = Array.isArray(rules.all) ? rules.all : [];
    return all.length === 1 ? all[0] : null;
  }

  function addExpandedTypeOptions(select){
    const present = new Set([...select.options].map((option) => option.value));
    EXTRA_TYPES.forEach((type) => {
      if (present.has(type)) return;
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type.replaceAll('_', ' ');
      select.appendChild(option);
    });
    const field = activeFieldId ? fieldCache.get(activeFieldId) : null;
    if (field && field.field_type) select.value = field.field_type;
  }

  function buildFieldSelector(currentField){
    const fields = [...fieldCache.values()]
      .filter((field) => !currentField || Number(field.id) !== Number(currentField.id))
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    return '<option value="">Always show</option>' + fields.map((field) =>
      `<option value="${String(field.field_key).replace(/"/g, '&quot;')}">${String(field.label || field.field_key).replace(/</g, '&lt;')}</option>`
    ).join('');
  }

  function enhanceFieldModal(){
    const typeSelect = document.getElementById('fType');
    if (!typeSelect || document.getElementById('growthFieldRules')) return;
    addExpandedTypeOptions(typeSelect);

    const current = activeFieldId ? fieldCache.get(activeFieldId) : null;
    const simpleRule = selectedConditionalRule(current);
    const advanced = current && current.visibility_rules && Object.keys(current.visibility_rules).length
      ? JSON.stringify(current.visibility_rules, null, 2) : '';
    const grid = typeSelect.closest('.form-grid');
    if (!grid) return;

    const panel = document.createElement('div');
    panel.id = 'growthFieldRules';
    panel.className = 'wide';
    panel.style.cssText = 'border-top:1px solid #ddd3ce;margin-top:8px;padding-top:12px';
    panel.innerHTML = `
      <div class="form-grid">
        <div>
          <label>Who can see this field?</label>
          <select id="gaAudience">
            <option value="applicant">Applicant</option>
            <option value="admin">Admin only</option>
            <option value="both">Applicant and admin</option>
          </select>
        </div>
        <div>
          <label>Show this field only when</label>
          <select id="gaConditionField">${buildFieldSelector(current)}</select>
        </div>
        <div>
          <label>Condition</label>
          <select id="gaConditionOperator">
            <option value="equals">Equals</option>
            <option value="not_equals">Does not equal</option>
            <option value="includes">Includes</option>
            <option value="truthy">Is yes / true</option>
            <option value="not_empty">Is not empty</option>
          </select>
        </div>
        <div>
          <label>Value</label>
          <input id="gaConditionValue" placeholder="e.g. yes">
        </div>
        <div class="wide">
          <label>Advanced conditional rules JSON <span style="font-weight:400;color:#6e6864">(optional — use for multiple ALL/ANY conditions)</span></label>
          <textarea id="gaRulesJson" spellcheck="false" placeholder='{"all":[{"field":"growth_portfolio_exists","operator":"equals","value":"yes"}]}'></textarea>
          <div style="font-size:11px;color:#6e6864;margin-top:5px">Supported operators: equals, not_equals, includes, truthy, not_empty. Advanced JSON overrides the simple condition above.</div>
        </div>
      </div>`;
    grid.appendChild(panel);

    document.getElementById('gaAudience').value = current && current.audience ? current.audience : 'applicant';
    if (simpleRule) {
      document.getElementById('gaConditionField').value = simpleRule.field || '';
      document.getElementById('gaConditionOperator').value = simpleRule.operator || 'equals';
      document.getElementById('gaConditionValue').value = simpleRule.value == null ? '' : String(simpleRule.value);
      // A simple rule is represented in the friendly controls. Keep the
      // advanced box empty so changing the friendly controls takes effect.
      document.getElementById('gaRulesJson').value = '';
    } else if (advanced) {
      document.getElementById('gaRulesJson').value = advanced;
    }
  }

  function rulesFromModal(){
    const advanced = document.getElementById('gaRulesJson');
    if (advanced && advanced.value.trim()) {
      const parsed = JSON.parse(advanced.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Conditional rules JSON must be an object.');
      return parsed;
    }
    const field = document.getElementById('gaConditionField')?.value || '';
    if (!field) return {};
    const operator = document.getElementById('gaConditionOperator')?.value || 'equals';
    const rawValue = document.getElementById('gaConditionValue')?.value || '';
    const condition = { field, operator };
    if (!['truthy','not_empty'].includes(operator)) condition.value = rawValue;
    return { all: [condition] };
  }

  window.fetch = async function growthAwareFetch(input, init){
    const url = typeof input === 'string' ? input : String(input && input.url || '');
    const method = String((init && init.method) || 'GET').toUpperCase();
    let nextInit = init;

    const isFieldMutation = /\/growth-admin\/(?:fields\/\d+|steps\/\d+\/fields)(?:$|\?)/.test(url)
      && (method === 'POST' || method === 'PATCH');
    if (isFieldMutation && init && typeof init.body === 'string' && document.getElementById('growthFieldRules')) {
      const body = JSON.parse(init.body);
      body.audience = document.getElementById('gaAudience')?.value || 'applicant';
      body.visibilityRules = rulesFromModal();
      nextInit = Object.assign({}, init, { body: JSON.stringify(body) });
    }

    const response = await originalFetch(input, nextInit);
    if (/\/growth-admin\/versions\/\d+(?:\/sensitive)?(?:$|\?)/.test(url) && method === 'GET' && response.ok) {
      response.clone().json().then(cacheVersionPayload).catch(() => {});
    }
    return response;
  };

  document.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-field]');
    const add = event.target.closest('[data-add-field]');
    if (edit) activeFieldId = Number(edit.dataset.editField) || null;
    if (add) activeFieldId = null;
  }, true);

  const observer = new MutationObserver(() => enhanceFieldModal());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();