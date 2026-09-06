(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  ready(function () {
    var section = document.getElementById('section-shoutouts');
    if (!section || document.getElementById('dailyShoutoutStudio')) return;

    var apiBase = String(
      window.UNPLUG_RUNTIME_API ||
      (window.UnplugAPI && typeof window.UnplugAPI.getApiBase === 'function' ? window.UnplugAPI.getApiBase() : '') ||
      localStorage.getItem('unplug_api_base') || ''
    ).replace(/\/+$/, '');
    var token = localStorage.getItem('unplug_admin_token') || '';

    function todayKey() {
      var d = new Date();
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    }
    function dateKey(value) { return String(value || '').slice(0, 10); }
    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function humanDate(value) {
      var key = dateKey(value);
      if (!key) return 'No date';
      var d = new Date(key + 'T12:00:00');
      return isNaN(d.getTime()) ? key : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
      return Promise.resolve();
    }
    function api(path, options) {
      options = options || {};
      if (!apiBase || /not-configured\.invalid/.test(apiBase)) return Promise.reject(new Error('Staging API is not configured.'));
      var headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
      if (token) headers.Authorization = 'Bearer ' + token;
      if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      return fetch(apiBase + path, Object.assign({}, options, { headers: headers })).then(async function (res) {
        var text = await res.text();
        var data = null;
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text || ('Request failed (' + res.status + ')') }; }
        if (!res.ok) {
          var err = new Error((data && (data.error || data.message)) || ('Request failed (' + res.status + ')'));
          err.status = res.status; err.data = data; throw err;
        }
        return data || {};
      });
    }

    var studio = document.createElement('div');
    studio.id = 'dailyShoutoutStudio';
    studio.innerHTML = '' +
      '<div class="dso-shell">' +
        '<div class="dso-head"><div><div class="dso-kicker">Content · Daily Recognition</div><h2>Daily Shout-Out Studio</h2>' +
        '<p>Create one branded shout-out per date, preview it, save a draft, schedule it and generate the three locked social formats. Existing public nomination moderation below stays unchanged.</p></div>' +
        '<div class="dso-env">Staging Control Centre</div></div>' +
        '<div class="dso-grid">' +
          '<div class="dso-editor"><div class="dso-form-grid">' +
            '<div class="dso-field dso-span"><label for="dsoRecipient">Recipient name &amp; surname</label><input id="dsoRecipient" list="dsoRecipientList" maxlength="200" placeholder="e.g. Naledi Mokoena"><datalist id="dsoRecipientList"></datalist><div class="dso-hint">No recipient photograph is used. The name is the hero.</div></div>' +
            '<div class="dso-field"><label for="dsoDate">Feature date</label><input id="dsoDate" type="date"></div>' +
            '<div class="dso-field"><label for="dsoPose">Mascot pose</label><select id="dsoPose"><option value="">Loading poses…</option></select></div>' +
            '<div class="dso-field dso-span"><label for="dsoCaption">Share caption (optional)</label><textarea id="dsoCaption" placeholder="Leave empty to use the locked default caption."></textarea></div>' +
          '</div>' +
          '<div class="dso-actions">' +
            '<button type="button" id="dsoPreview">Preview</button>' +
            '<button type="button" id="dsoSaveDraft" class="dso-dark">Save Draft</button>' +
            '<button type="button" id="dsoSchedule">Schedule</button>' +
            '<button type="button" id="dsoPublish" class="dso-primary">Publish</button>' +
            '<button type="button" id="dsoRegenerate" disabled>Regenerate Images</button>' +
          '</div><div id="dsoStatus" class="dso-status" aria-live="polite"></div>' +
          '</div>' +
          '<div class="dso-preview-wrap"><div class="dso-preview-label"><span>Browser preview</span><span>Generated PNGs are rendered server-side</span></div>' +
            '<div class="dso-preview-card" id="dsoPreviewCard"><div class="dso-card-brand"><strong>UNPLUG</strong><span>DAILY SHOUT-OUT</span></div>' +
              '<div class="dso-card-copy"><div class="dso-card-kicker">Today we power on</div><h3 class="dso-card-name" id="dsoPreviewName">Your Person Here</h3><div class="dso-card-line">Was here. Made a difference.</div><span class="dso-pose-pill" id="dsoPreviewPose">Pose</span></div>' +
              '<div class="dso-power">POWER ON.</div><div class="dso-card-foot"><span id="dsoPreviewDate">Date</span><span>www.unplugnews.com</span></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="dso-subgrid">' +
          '<div class="dso-box"><div class="dso-box-head"><h3>Drafts</h3><button type="button" id="dsoRefreshDrafts">Refresh</button></div><div id="dsoDrafts" class="dso-list"><div class="dso-empty">Loading drafts…</div></div></div>' +
          '<div class="dso-box"><div class="dso-box-head"><h3>Published &amp; Scheduled</h3><button type="button" id="dsoRefreshCalendar">Refresh</button></div><div id="dsoCalendar" class="dso-list"><div class="dso-empty">Loading calendar…</div></div></div>' +
        '</div>' +
        '<div id="dsoAnalytics" class="dso-analytics"><div class="dso-analytics-head"><h3 id="dsoAnalyticsTitle">Shout-Out Analytics</h3><button type="button" id="dsoCloseAnalytics">Close</button></div><div id="dsoMetrics" class="dso-metrics"></div><div id="dsoPlatforms" class="dso-platforms"></div></div>' +
      '</div><div id="dsoToast" class="dso-toast" role="status"></div>';

    var firstPanel = section.querySelector('.panel');
    if (firstPanel) section.insertBefore(studio, firstPanel); else section.appendChild(studio);

    var els = {
      recipient: document.getElementById('dsoRecipient'), date: document.getElementById('dsoDate'), pose: document.getElementById('dsoPose'),
      caption: document.getElementById('dsoCaption'), status: document.getElementById('dsoStatus'), previewName: document.getElementById('dsoPreviewName'),
      previewDate: document.getElementById('dsoPreviewDate'), previewPose: document.getElementById('dsoPreviewPose'), drafts: document.getElementById('dsoDrafts'),
      calendar: document.getElementById('dsoCalendar'), datalist: document.getElementById('dsoRecipientList'), regenerate: document.getElementById('dsoRegenerate'),
      analytics: document.getElementById('dsoAnalytics'), metrics: document.getElementById('dsoMetrics'), analyticsTitle: document.getElementById('dsoAnalyticsTitle'),
      platforms: document.getElementById('dsoPlatforms'), toast: document.getElementById('dsoToast')
    };
    els.date.value = todayKey();

    var state = { draftId: null, activeSlug: null, poses: [], calendar: [], drafts: [] };
    var toastTimer = null;
    function toast(message, error) {
      clearTimeout(toastTimer); els.toast.textContent = message; els.toast.className = 'dso-toast is-show' + (error ? ' is-error' : '');
      toastTimer = setTimeout(function () { els.toast.className = 'dso-toast'; }, 4200);
    }
    function status(message, kind) {
      els.status.textContent = message || '';
      els.status.className = 'dso-status' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
    }
    function setBusy(busy) {
      ['dsoPreview','dsoSaveDraft','dsoSchedule','dsoPublish'].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = !!busy; });
      if (state.activeSlug) els.regenerate.disabled = !!busy; else els.regenerate.disabled = true;
    }
    function updatePreview() {
      els.previewName.textContent = els.recipient.value.trim() || 'Your Person Here';
      els.previewDate.textContent = humanDate(els.date.value || todayKey());
      var opt = els.pose.options[els.pose.selectedIndex];
      els.previewPose.textContent = opt && opt.textContent ? opt.textContent : (els.pose.value || 'Automatic pose');
    }
    ['input','change'].forEach(function (evt) {
      els.recipient.addEventListener(evt, updatePreview); els.date.addEventListener(evt, updatePreview); els.pose.addEventListener(evt, updatePreview);
    });

    function payload() {
      var name = els.recipient.value.trim();
      var featureDate = els.date.value;
      if (!name) throw new Error('Enter a recipient name and surname.');
      if (!featureDate) throw new Error('Choose a feature date.');
      if (!els.pose.value) throw new Error('Choose a mascot pose.');
      return {
        recipientName: name,
        featureDate: featureDate,
        mascotPoseKey: els.pose.value,
        shareCaption: els.caption.value.trim() || null,
        draftId: state.draftId || undefined
      };
    }
    function resetIdentity() {
      state.draftId = null; state.activeSlug = null; els.regenerate.disabled = true;
    }
    function loadIntoEditor(item, isDraft) {
      els.recipient.value = item.recipient_name || item.recipientName || item.name || '';
      els.date.value = dateKey(item.feature_date || item.featureDate || item.date) || todayKey();
      els.pose.value = item.mascot_pose_key || item.mascotPoseKey || (state.poses[0] && state.poses[0].key) || '';
      els.caption.value = item.share_caption || item.shareCaption || '';
      state.draftId = isDraft ? String(item.id) : null;
      state.activeSlug = isDraft ? null : (item.shareSlug || item.share_slug || null);
      els.regenerate.disabled = !state.activeSlug;
      updatePreview();
      status(isDraft ? 'Draft loaded. Edit it and save, schedule or publish.' : 'Published/scheduled shout-out loaded.', 'ok');
      studio.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function loadPoses() {
      try {
        var data = await api('/shoutouts/admin/poses'); state.poses = data.poses || [];
        els.pose.innerHTML = '';
        state.poses.forEach(function (p) {
          var o = document.createElement('option'); o.value = p.key; o.textContent = p.label || p.key; els.pose.appendChild(o);
        });
        if (!state.poses.length) { var empty = document.createElement('option'); empty.value = ''; empty.textContent = 'No active poses'; els.pose.appendChild(empty); }
        updatePreview();
      } catch (err) { els.pose.innerHTML = '<option value="">Could not load poses</option>'; status(err.message, 'error'); }
    }

    async function loadRecipientSuggestions() {
      try {
        var data = await api('/admin/shoutouts');
        var rows = data.shoutouts || []; var seen = Object.create(null); els.datalist.innerHTML = '';
        rows.forEach(function (r) {
          var name = String(r.nominee_name || r.recipient_name || r.name || '').trim(); if (!name || seen[name.toLowerCase()]) return; seen[name.toLowerCase()] = true;
          var o = document.createElement('option'); o.value = name; els.datalist.appendChild(o);
        });
      } catch (_) { /* suggestions are optional; do not block the studio */ }
    }

    async function loadDrafts() {
      els.drafts.innerHTML = '<div class="dso-empty">Loading drafts…</div>';
      try {
        var data = await api('/shoutouts/admin/drafts'); state.drafts = data.drafts || []; els.drafts.innerHTML = '';
        if (!state.drafts.length) { els.drafts.innerHTML = '<div class="dso-empty">No saved drafts.</div>'; return; }
        state.drafts.forEach(function (d) {
          var item = document.createElement('div'); item.className = 'dso-item';
          item.innerHTML = '<div class="dso-item-top"><div><strong>' + esc(d.recipient_name) + '</strong><div class="dso-meta">' + esc(humanDate(d.feature_date)) + ' · ' + esc(d.mascot_pose_key || 'pose') + '</div></div><span class="dso-pill">Draft</span></div><div class="dso-item-actions"></div>';
          var actions = item.querySelector('.dso-item-actions');
          var load = document.createElement('button'); load.type = 'button'; load.textContent = 'Load'; load.addEventListener('click', function () { loadIntoEditor(d, true); }); actions.appendChild(load);
          var del = document.createElement('button'); del.type = 'button'; del.className = 'dso-danger'; del.textContent = 'Delete'; del.addEventListener('click', async function () {
            if (!confirm('Delete this Daily Shout-Out draft?')) return;
            try { await api('/shoutouts/admin/drafts/' + encodeURIComponent(d.id), { method: 'DELETE' }); if (String(state.draftId) === String(d.id)) resetIdentity(); toast('Draft deleted.'); loadDrafts(); }
            catch (err) { toast(err.message, true); }
          }); actions.appendChild(del); els.drafts.appendChild(item);
        });
      } catch (err) { els.drafts.innerHTML = '<div class="dso-empty">Could not load drafts: ' + esc(err.message) + '</div>'; }
    }

    function assetLink(url, label) {
      if (!url) return null;
      var a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label; return a;
    }
    async function loadCalendar() {
      els.calendar.innerHTML = '<div class="dso-empty">Loading calendar…</div>';
      try {
        var data = await api('/shoutouts/admin/calendar?limit=180'); state.calendar = data.shoutouts || []; els.calendar.innerHTML = '';
        if (!state.calendar.length) { els.calendar.innerHTML = '<div class="dso-empty">No scheduled or published shout-outs yet.</div>'; return; }
        state.calendar.forEach(function (s) {
          var future = dateKey(s.featureDate || s.date) > todayKey();
          var pubState = future ? 'scheduled' : 'published';
          var item = document.createElement('div'); item.className = 'dso-item';
          var top = document.createElement('div'); top.className = 'dso-item-top';
          top.innerHTML = '<div><strong>' + esc(s.recipientName || s.name) + '</strong><div class="dso-meta">' + esc(humanDate(s.featureDate || s.date)) + ' · ' + esc(s.mascotPoseKey || 'pose') + ' · ' + Number(s.totalEvents || 0) + ' events</div></div><div><span class="dso-pill ' + pubState + '">' + pubState + '</span> <span class="dso-pill ' + esc(s.assetStatus || '') + '">' + esc(s.assetStatus || (s.assetsReady ? 'ready' : 'pending')) + '</span></div>';
          item.appendChild(top);
          var assets = document.createElement('div'); assets.className = 'dso-assets';
          [[s.imagePortraitUrl,'1080×1350'],[s.imageSquareUrl,'1080×1080'],[s.imageOgUrl,'1200×630']].forEach(function (x) { var a = assetLink(x[0], x[1]); if (a) assets.appendChild(a); });
          if (assets.childNodes.length) item.appendChild(assets);
          if (s.assetError) { var er = document.createElement('div'); er.className = 'dso-meta'; er.textContent = 'Asset error: ' + s.assetError; item.appendChild(er); }
          var actions = document.createElement('div'); actions.className = 'dso-item-actions';
          var edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Load'; edit.addEventListener('click', function () { loadIntoEditor(s, false); }); actions.appendChild(edit);
          if (s.shareUrl) {
            var open = document.createElement('a'); open.className = 'dso-linkbtn'; open.href = s.shareUrl; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open Permalink'; actions.appendChild(open);
            var copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy Link'; copy.addEventListener('click', function () { copyText(s.shareUrl).then(function () { toast('Immutable permalink copied.'); }).catch(function () { toast('Could not copy the link.', true); }); }); actions.appendChild(copy);
          }
          if (s.shareSlug) {
            var regen = document.createElement('button'); regen.type = 'button'; regen.textContent = 'Regenerate'; regen.addEventListener('click', function () { regenerate(s.shareSlug); }); actions.appendChild(regen);
            var stats = document.createElement('button'); stats.type = 'button'; stats.textContent = 'Analytics'; stats.addEventListener('click', function () { loadAnalytics(s.shareSlug, s.recipientName || s.name); }); actions.appendChild(stats);
          }
          item.appendChild(actions); els.calendar.appendChild(item);
        });
      } catch (err) { els.calendar.innerHTML = '<div class="dso-empty">Could not load calendar: ' + esc(err.message) + '</div>'; }
    }

    async function saveDraft() {
      try {
        var p = payload(); if (state.draftId) p.id = state.draftId;
        setBusy(true); status('Saving draft…');
        var data = await api('/shoutouts/admin/drafts', { method: 'POST', body: JSON.stringify(p) });
        state.draftId = data.draft && data.draft.id ? String(data.draft.id) : state.draftId;
        status('Draft saved. Nothing has gone live.', 'ok'); toast('Daily Shout-Out draft saved.'); await loadDrafts();
      } catch (err) { status(err.message, 'error'); toast(err.message, true); } finally { setBusy(false); }
    }

    async function publish(mode, replace) {
      try {
        var p = payload(); p.replace = !!replace;
        if (mode === 'schedule' && p.featureDate <= todayKey()) throw new Error('Choose a future date to schedule. Use Publish for today or a past/current date.');
        if (mode === 'publish' && p.featureDate > todayKey()) throw new Error('That date is in the future. Use Schedule so the status is clear.');
        setBusy(true); status(mode === 'schedule' ? 'Scheduling and generating all three social images…' : 'Publishing and generating all three social images…');
        var data = await api('/shoutouts/admin/publish', { method: 'POST', body: JSON.stringify(p) });
        state.draftId = null; state.activeSlug = data.shoutout && data.shoutout.shareSlug || null; els.regenerate.disabled = !state.activeSlug;
        status(data.message || (mode === 'schedule' ? 'Scheduled.' : 'Published.'), 'ok'); toast(data.message || 'Daily Shout-Out saved.');
        await Promise.all([loadDrafts(), loadCalendar()]);
      } catch (err) {
        if (err.status === 409 && err.data && err.data.requiresReplace && !replace) {
          var existing = err.data.existing || {};
          var who = existing.recipientName || existing.name || 'another person';
          if (confirm((els.date.value || 'That date') + ' already has a shout-out for ' + who + '. Replace that date with this one?')) return publish(mode, true);
        }
        status(err.message, 'error'); toast(err.message, true);
      } finally { setBusy(false); }
    }

    async function regenerate(slug) {
      slug = slug || state.activeSlug;
      if (!slug) { toast('Load a published or scheduled shout-out first.', true); return; }
      if (!confirm('Regenerate all three social images for this shout-out? The permalink stays the same.')) return;
      try {
        setBusy(true); status('Regenerating 1080×1350, 1080×1080 and 1200×630 images…');
        var data = await api('/shoutouts/admin/regenerate/' + encodeURIComponent(slug), { method: 'POST' });
        status(data.message || 'Images regenerated.', 'ok'); toast(data.message || 'Images regenerated.'); await loadCalendar();
      } catch (err) { status(err.message, 'error'); toast(err.message, true); } finally { setBusy(false); }
    }

    async function loadAnalytics(slug, name) {
      try {
        var data = await api('/shoutouts/admin/analytics/' + encodeURIComponent(slug));
        var events = data.events || []; var counts = Object.create(null); events.forEach(function (e) { counts[e.event_type] = Number(e.count || 0); });
        var total = events.reduce(function (sum, e) { return sum + Number(e.count || 0); }, 0);
        var shares = ['shoutout_share_open','shoutout_share_facebook','shoutout_share_whatsapp','shoutout_share_instagram_native','shoutout_share_linkedin','shoutout_share_x'].reduce(function (sum, k) { return sum + (counts[k] || 0); }, 0);
        var downloads = ['shoutout_download_portrait','shoutout_download_square','shoutout_download_og'].reduce(function (sum, k) { return sum + (counts[k] || 0); }, 0);
        var metrics = [
          ['Views', counts.shoutout_view || 0], ['Share actions', shares], ['Downloads', downloads], ['Copied links', counts.shoutout_copy_link || 0], ['Nominate clicks', counts.shoutout_nominate_click || 0], ['All events', total]
        ];
        els.analyticsTitle.textContent = 'Analytics — ' + (name || data.shoutout && data.shoutout.recipientName || slug);
        els.metrics.innerHTML = metrics.map(function (m) { return '<div class="dso-metric"><b>' + m[1] + '</b><span>' + esc(m[0]) + '</span></div>'; }).join('');
        els.platforms.textContent = events.length ? 'Event detail: ' + events.map(function (e) { return e.event_type.replace(/^shoutout_/, '').replace(/_/g, ' ') + ' ' + e.count; }).join(' · ') : 'No recorded interactions yet.';
        els.analytics.classList.add('is-open'); els.analytics.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) { toast(err.message, true); }
    }

    document.getElementById('dsoPreview').addEventListener('click', function () { updatePreview(); status('Browser preview refreshed. Generated PNG artwork is created only when you schedule/publish.', 'ok'); });
    document.getElementById('dsoSaveDraft').addEventListener('click', saveDraft);
    document.getElementById('dsoSchedule').addEventListener('click', function () { publish('schedule', false); });
    document.getElementById('dsoPublish').addEventListener('click', function () { publish('publish', false); });
    els.regenerate.addEventListener('click', function () { regenerate(); });
    document.getElementById('dsoRefreshDrafts').addEventListener('click', loadDrafts);
    document.getElementById('dsoRefreshCalendar').addEventListener('click', loadCalendar);
    document.getElementById('dsoCloseAnalytics').addEventListener('click', function () { els.analytics.classList.remove('is-open'); });

    if (!token) status('Sign in to the Control Centre to use the Daily Shout-Out Studio.', 'error');
    Promise.all([loadPoses(), loadRecipientSuggestions(), loadDrafts(), loadCalendar()]).catch(function () {});
    updatePreview();

    window.UnplugDailyShoutoutAdmin = { refresh: function () { return Promise.all([loadDrafts(), loadCalendar()]); } };
  });
})();
