(function () {
  'use strict';
  if (String(window.location.pathname || '').indexOf('unplug-agreement-generator-admin.html') === -1) return;

  function parameter(name) {
    try { return new URL(window.location.href).searchParams.get(name); }
    catch (_) { return null; }
  }

  const templateId = parameter('template');
  const agreementId = parameter('agreement');
  const requestedTab = parameter('tab');
  if (!templateId && !agreementId && !requestedTab) return;

  let tries = 0;
  let timer;

  function findByData(selector, dataName, value) {
    const nodes = document.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i += 1) {
      if (String(nodes[i].getAttribute('data-' + dataName) || '') === String(value)) return nodes[i];
    }
    return null;
  }

  function focus() {
    tries += 1;
    const tabName = agreementId ? 'agreements' : (requestedTab || 'templates');
    const tab = document.querySelector('[data-tab="' + tabName + '"]');
    if (tab && !tab.classList.contains('active')) tab.click();

    let complete = true;
    if (templateId) {
      const row = findByData('#templateList [data-template]', 'template', templateId);
      if (row) {
        if (!row.classList.contains('active')) row.click();
        row.scrollIntoView({ block: 'center' });
      } else complete = false;
    }
    if (agreementId) {
      const row = findByData('#agreementList [data-record]', 'record', agreementId);
      if (row) {
        if (!row.classList.contains('active')) row.click();
        row.scrollIntoView({ block: 'center' });
      } else complete = false;
    }

    if (complete || tries >= 60) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start() {
    focus();
    timer = setInterval(focus, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}());
