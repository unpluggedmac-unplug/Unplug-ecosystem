(function () {
  'use strict';

  if (window.__unplugStagingMemberChangeEditor) return;
  window.__unplugStagingMemberChangeEditor = true;

  function toast(message, isError) {
    if (typeof window.showToast === 'function') return window.showToast(message, !!isError);
    window.alert(message);
  }

  function apiCall(path, options) {
    if (typeof window.api !== 'function') throw new Error('Member API is not ready yet. Refresh and try again.');
    return window.api(path, options || {});
  }

  var FIELD_MAP = {
    title:              { prop: 'title',              body: 'title',            label: 'Headline' },
    subtitle:           { prop: 'subtitle',           body: 'subtitle',         label: 'Standfirst' },
    kicker_supplied_by: { prop: 'kicker_supplied_by', body: 'kickerSuppliedBy', label: 'Supplied by' },
    author_name:        { prop: 'author_name',        body: 'authorName',       label: 'Written by' },
    meta_description:   { prop: 'meta_description',   body: 'metaDescription',  label: 'Search summary' },
    body:               { prop: 'body',               body: 'body',             label: 'Body' },
    conclusion:         { prop: 'conclusion',         body: 'conclusion',       label: 'Closing' },
    cta_label:          { prop: 'cta_label',          body: 'ctaLabel',         label: 'Button label' },
    cta_url:            { prop: 'cta_url',            body: 'ctaUrl',           label: 'Button link' },
    banner_image_url:   { prop: 'banner_image_url',   body: 'bannerImageUrl',   label: 'Cover image URL' }
  };

  async function editArticle(articleId, button) {
    button.disabled = true;
    var oldText = button.textContent;
    button.textContent = 'Loading…';
    try {
      var results = await Promise.all([
        apiCall('/articles/mine'),
        apiCall('/change-requests/mine')
      ]);
      var articles = results[0].articles || [];
      var requests = results[1].changeRequests || [];
      var article = articles.find(function (a) { return Number(a.id) === Number(articleId); });
      var request = requests.find(function (r) {
        return r.submission_type === 'article' && Number(r.submission_id) === Number(articleId);
      });
      if (!article) throw new Error('Could not load this article.');
      if (!request) throw new Error('No open change request was found for this article.');

      var fields = Array.isArray(request.fields) ? request.fields : [];
      var payload = {};
      for (var i = 0; i < fields.length; i += 1) {
        var field = fields[i];
        var cfg = FIELD_MAP[field];
        if (!cfg) continue;
        var current = article[cfg.prop] == null ? '' : String(article[cfg.prop]);
        var next = window.prompt('Update ' + cfg.label + ':', current);
        if (next === null) {
          button.disabled = false;
          button.textContent = oldText;
          return;
        }
        next = next.trim();
        if (field === 'title' && !next) throw new Error('Headline cannot be blank.');
        payload[cfg.body] = next;
      }
      if (!Object.keys(payload).length) throw new Error('There are no editable fields in this request.');

      await apiCall('/articles/' + articleId, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });

      button.textContent = 'Changes saved';
      toast('Requested changes saved. Go to My Profile and click “I HAVE MADE THESE CHANGES” to resubmit.');
    } catch (err) {
      button.disabled = false;
      button.textContent = oldText;
      toast(err.message || 'Could not save the requested changes.', true);
    }
  }

  async function enhanceRows() {
    if (location.pathname.indexOf('unplug-member-dashboard') === -1) return;
    if (typeof window.api !== 'function') return;

    var data;
    try {
      data = await apiCall('/articles/mine');
    } catch (_) {
      return;
    }
    var articles = (data.articles || []).filter(function (a) { return a.status === 'changes_requested'; });
    if (!articles.length) return;

    var rows = Array.prototype.slice.call(document.querySelectorAll('.subs-row'));
    articles.forEach(function (article) {
      var row = rows.find(function (r) {
        var title = r.querySelector('.subs-title');
        return title && title.textContent.trim() === String(article.title || '').trim();
      });
      if (!row || row.querySelector('[data-staging-change-editor]')) return;

      var side = row.lastElementChild;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-line';
      button.setAttribute('data-staging-change-editor', String(article.id));
      button.style.cssText = 'width:auto; padding:6px 10px; font-size:11px; margin-left:8px;';
      button.textContent = 'EDIT REQUESTED FIELDS';
      button.addEventListener('click', function () { editArticle(article.id, button); });

      if (side) {
        var wrap = document.createElement('span');
        wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;';
        side.parentNode.replaceChild(wrap, side);
        wrap.appendChild(side);
        wrap.appendChild(button);
      } else {
        row.appendChild(button);
      }
    });
  }

  function start() {
    enhanceRows();
    var observer = new MutationObserver(function () {
      window.clearTimeout(window.__unplugStagingMemberChangeEditorTimer);
      window.__unplugStagingMemberChangeEditorTimer = window.setTimeout(enhanceRows, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
