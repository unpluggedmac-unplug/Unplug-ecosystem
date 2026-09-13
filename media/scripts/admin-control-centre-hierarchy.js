(function () {
  'use strict';

  var path = String(window.location.pathname || '').toLowerCase();

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function token() {
    try {
      return localStorage.getItem('unplug_admin_token') || localStorage.getItem('adminAccessToken') || localStorage.getItem('accessToken') || '';
    } catch (_) { return ''; }
  }

  function apiBase() {
    return String(window.UNPLUG_RUNTIME_API || localStorage.getItem('unplug_api_base') || 'https://unplug-ecosystem.onrender.com').replace(/\/$/, '');
  }

  async function requestJson(endpoint, options) {
    var t = token();
    var opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}, opts.headers || {});
    var r = await fetch(apiBase() + endpoint, opts);
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error((data && data.error) || ('Request failed (' + r.status + ')'));
    return data;
  }

  function getJson(endpoint) { return requestJson(endpoint); }

  async function getBlob(endpoint) {
    var t = token();
    var r = await fetch(apiBase() + endpoint, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
    if (!r.ok) {
      var data = await r.json().catch(function () { return {}; });
      throw new Error((data && data.error) || ('Request failed (' + r.status + ')'));
    }
    return r.blob();
  }

  function decodeRole() {
    try {
      var t = token();
      if (!t || t.split('.').length < 2) return '';
      var part = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      var payload = JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(part), function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')));
      return String(payload.role || '').toLowerCase();
    } catch (_) { return ''; }
  }

  function loadDashboardStyles() {
    if (document.querySelector('link[data-cc-hierarchy-style]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/media/styles/admin-control-centre-hierarchy.css?v=20260913-1';
    l.setAttribute('data-cc-hierarchy-style', 'true');
    document.head.appendChild(l);
  }

  // -----------------------------------------------------------------------
  // Agreement Generator deep links used by the Control Centre tree.
  // -----------------------------------------------------------------------
  function initAgreementDeepLink() {
    ready(function () {
      var q = new URLSearchParams(location.search);
      var template = q.get('template');
      var preset = q.get('preset');
      var tab = q.get('tab');
      var status = q.get('status');
      var action = q.get('action');
      if (!template && !preset && !tab && !status && !action) return;

      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        if (preset) {
          var ps = document.getElementById('presetSelect');
          if (ps && Array.from(ps.options).some(function (o) { return String(o.value) === String(preset); })) {
            ps.value = preset;
            ps.dispatchEvent(new Event('change', { bubbles: true }));
            preset = null;
          }
        }
        if (template) {
          var row = document.querySelector('[data-template="' + CSS.escape(String(template)) + '"]');
          if (row) {
            row.click();
            template = null;
            if (action === 'edit') setTimeout(function () { document.getElementById('editAgreement')?.click(); }, 250);
          }
        }
        if (tab === 'agreements' || status) {
          var tabBtn = document.querySelector('[data-tab="agreements"]');
          if (tabBtn) {
            tabBtn.click();
            tab = null;
            if (status) {
              setTimeout(function () {
                var f = document.getElementById('statusFilter');
                if (f && Array.from(f.options).some(function (o) { return o.value === status || o.textContent.trim().toLowerCase() === status; })) {
                  f.value = status;
                  f.dispatchEvent(new Event('change', { bubbles: true }));
                }
                status = null;
              }, 180);
            }
          }
        }
        if ((!template && !preset && !tab && !status) || attempts > 50) clearInterval(timer);
      }, 120);
    });
  }

  // -----------------------------------------------------------------------
  // Growth Application deep links used by the Control Centre tree.
  // -----------------------------------------------------------------------
  function initGrowthDeepLink() {
    ready(function () {
      var q = new URLSearchParams(location.search);
      var status = q.get('status');
      var view = q.get('view');
      var preview = q.get('preview');
      if (!status && !view && !preview) return;
      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        var filter = document.getElementById('filter');
        var settings = document.getElementById('settingsBtn');
        if (status && filter) {
          var mapped = status === 'completed' || status === 'archived' ? 'closed' : status;
          if (Array.from(filter.options).some(function (o) { return o.value === mapped; })) {
            filter.value = mapped;
            filter.dispatchEvent(new Event('change', { bubbles: true }));
          }
          status = null;
        }
        if ((view === 'settings' || preview) && settings) {
          settings.click();
          view = null;
          if (preview) {
            var want = preview;
            preview = null;
            setTimeout(function () {
              var btn = document.querySelector('#detail [data-preview="' + CSS.escape(want) + '"]');
              if (btn) btn.click();
            }, 350);
          }
        }
        if ((!status && !view && !preview) || attempts > 30) clearInterval(timer);
      }, 120);
    });
  }

  // -----------------------------------------------------------------------
  // Main Control Centre hierarchy.
  // -----------------------------------------------------------------------
  function initDashboard() {
    loadDashboardStyles();

    var sidebar = document.getElementById('admSidebar');
    var search = document.getElementById('navSearch');
    var main = document.querySelector('.main');
    if (!sidebar || !search || !main || sidebar.dataset.ccHierarchyReady === '1') return;
    sidebar.dataset.ccHierarchyReady = '1';

    var originalAnchors = {};
    sidebar.querySelectorAll('a[data-section]').forEach(function (a) {
      if (a.dataset.section && !originalAnchors[a.dataset.section]) originalAnchors[a.dataset.section] = a;
    });

    var externalAnchors = {
      agreementsLegacy: sidebar.querySelector('a[href*="unplug-agreements-admin"]'),
      agreementGenerator: sidebar.querySelector('a[href*="unplug-agreement-generator-admin"]'),
      growth: sidebar.querySelector('a[href*="unplug-growth-applications-admin"]:not([href*="-v2"])'),
      growthV2: sidebar.querySelector('a[href*="unplug-growth-applications-admin-v2"]')
    };

    Object.keys(originalAnchors).forEach(function (k) { originalAnchors[k].remove(); });
    Object.keys(externalAnchors).forEach(function (k) { if (externalAnchors[k]) externalAnchors[k].remove(); });
    sidebar.querySelectorAll('.nav-pinned,.nav-group').forEach(function (el) { el.remove(); });

    search.placeholder = 'Find a section, tool or template…';

    var root = document.createElement('div');
    root.className = 'cc-nav-root';
    root.id = 'ccNavRoot';
    search.insertAdjacentElement('afterend', root);

    var source = document.createElement('div');
    source.className = 'cc-nav-source';
    source.setAttribute('aria-hidden', 'true');
    Object.keys(originalAnchors).forEach(function (k) { source.appendChild(originalAnchors[k]); });
    Object.keys(externalAnchors).forEach(function (k) { if (externalAnchors[k]) source.appendChild(externalAnchors[k]); });
    sidebar.appendChild(source);

    var state = {
      usedSections: new Set(),
      currentKey: 'section:overview',
      currentPath: ['Dashboard', 'Overview'],
      aliases: [],
      nodeByKey: new Map(),
      dynamicTemplatesHost: null,
      counts: {}
    };

    var STORAGE = {
      open: 'unplug_cc_open_nodes_v2',
      fav: 'unplug_cc_favourites_v2',
      recent: 'unplug_cc_recent_v2',
      collapsed: 'unplug_cc_collapsed_cards_v2'
    };

    function readJson(key, fallback) {
      try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (_) { return fallback; }
    }
    function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }

    var openState = readJson(STORAGE.open, {});
    var favourites = new Set(readJson(STORAGE.fav, []));
    var recent = readJson(STORAGE.recent, []);

    function icon(text) { return '<span class="cc-icon" aria-hidden="true">' + text + '</span>'; }
    function nodeSection(section, label, iconText, opts) { return Object.assign({ type: 'section', section: section, label: label, icon: iconText || '•' }, opts || {}); }
    function nodeHref(href, label, iconText, opts) { return Object.assign({ type: 'href', href: href, label: label, icon: iconText || '↗' }, opts || {}); }
    function nodeAction(key, label, iconText, action, opts) { return Object.assign({ type: 'action', key: key, label: label, icon: iconText || '•', action: action }, opts || {}); }
    function nodeDisabled(key, label, iconText, note) { return { type: 'disabled', key: key, label: label, icon: iconText || '·', note: note || 'Not connected yet' }; }
    function branch(id, label, iconText, overview, children, opts) { return Object.assign({ type: 'branch', id: id, label: label, icon: iconText || '▣', overview: overview || null, children: children || [] }, opts || {}); }

    function agreementHref(params) {
      var q = new URLSearchParams(params || {});
      return '/unplug-agreement-generator-admin.html' + (q.toString() ? '?' + q.toString() : '');
    }
    function growthHref(params) {
      var q = new URLSearchParams(params || {});
      return '/unplug-growth-applications-admin.html' + (q.toString() ? '?' + q.toString() : '');
    }

    var model = [
      branch('dashboard', 'Dashboard', '⌂', { section: 'overview' }, [
        nodeSection('overview', 'Overview', '⌂'),
        nodeSection('queue', 'Needs Attention / Approval Centre', '!', { attention: true }),
        nodeSection('manage', 'All Content', '≡'),
        nodeSection('checkouthealth', 'Site & Checkout Health', '♥'),
        nodeSection('activitylog', 'Recent Activity', '↺')
      ]),
      branch('content', 'Content & Publishing', '✎', { section: 'manage' }, [
        branch('content-articles', 'Articles', 'A', { section: 'publish' }, [
          nodeSection('publish', 'Articles & Publishing', '✎'),
          nodeSection('manage', 'All Articles / Content', '≡'),
          nodeSection('queue', 'Pending / Approval Queue', '!'),
          nodeSection('highlights', 'Highlights / Featured', '★'),
          nodeSection('contributors', 'Contributors', '☺'),
          nodeSection('tags', 'Categories & Tags', '#')
        ]),
        branch('content-media', 'Gallery & Media', '▧', { section: 'gallerymgmt' }, [
          nodeSection('gallerymgmt', 'Gallery', '▧'),
          nodeSection('covers', 'Cover Images', '▰')
        ]),
        branch('content-events', 'Events & Editions', '◫', { section: 'calevents' }, [
          nodeSection('calevents', 'Events', '◫'),
          nodeSection('editions', 'Editions', 'E'),
          nodeSection('edcal', 'Editions Calendar', '▦')
        ]),
        branch('content-engagement', 'Participation Content', '✦', { section: 'shoutouts' }, [
          nodeSection('shoutouts', 'Shout-Outs', '✦'),
          nodeSection('birthdays', 'Birthdays', '🎂'),
          nodeSection('polls', 'Polls', '◉'),
          nodeSection('comments', 'Comments', '☷'),
          nodeSection('testimonials', 'Testimonials', '❝'),
          nodeSection('sasl', 'SASL Videos', '▶'),
          nodeSection('deafjobs', 'Deaf Jobs', '◈'),
          nodeSection('deafpassports', 'Deaf Passports', '◇')
        ])
      ]),
      branch('forms', 'Forms', '☑', { section: 'forms' }, [
        nodeSection('forms', 'All Forms', '☑'),
        nodeSection('forms', 'Form Templates', '▤'),
        nodeSection('forms', 'Published Forms', '●'),
        nodeSection('forms', 'Draft Forms', '○'),
        nodeSection('forms', 'Responses / Submissions', '↧'),
        nodeSection('forms', 'Archived Forms', '□'),
        nodeAction('forms:new', 'Create New Form', '+', function () {
          activateSection('forms', ['Forms', 'Create New Form']);
          setTimeout(function () { document.getElementById('fbNew')?.click(); }, 180);
        }),
        nodeSection('forms', 'Form Settings', '⚙')
      ]),
      branch('agreements', 'Agreements', '✍', { href: agreementHref() }, [
        nodeHref(agreementHref(), 'Overview', '⌂', { adminOnly: true }),
        nodeHref(agreementHref(), 'Agreement Generator', '✍', { adminOnly: true }),
        nodeHref(agreementHref({ preset: 'master' }), 'Master Agreement Details', '◆', { adminOnly: true, dynamicMaster: true }),
        branch('agreement-templates', 'Templates', '▤', { href: agreementHref() }, [
          nodeDisabled('agreement:templates:loading', 'Loading templates…', '…', 'Templates load after sign-in')
        ], { dynamic: 'agreementTemplates' }),
        branch('agreement-records', 'Agreement Records', '▥', { href: agreementHref({ tab: 'agreements' }) }, [
          nodeHref(agreementHref({ tab: 'agreements', status: 'draft' }), 'Draft Agreements', '○', { adminOnly: true, countKey: 'agreements:draft' }),
          nodeHref(agreementHref({ tab: 'agreements', status: 'sent' }), 'Sent / Awaiting Signature', '→', { adminOnly: true, countKey: 'agreements:sent' }),
          nodeHref(agreementHref({ tab: 'agreements', status: 'submitted' }), 'Submitted', '↧', { adminOnly: true, countKey: 'agreements:submitted' }),
          nodeHref(agreementHref({ tab: 'agreements', status: 'signed' }), 'Signed', '✓', { adminOnly: true, countKey: 'agreements:signed' }),
          nodeDisabled('agreement:expired', 'Expired', '◷', 'No separate expired workflow status exists yet'),
          nodeHref(agreementHref({ tab: 'agreements', status: 'archived' }), 'Archived', '□', { adminOnly: true, countKey: 'agreements:archived' })
        ]),
        nodeHref('/unplug-agreements-admin.html', 'Agreement Settings / Legacy Forms', '⚙', { adminOnly: true })
      ], { adminOnly: true }),
      branch('growth', 'Growth', '↗', { href: growthHref() }, [
        nodeHref(growthHref(), 'Overview', '⌂', { adminOnly: true }),
        branch('growth-applications', 'Applications', '▥', { href: growthHref() }, [
          nodeHref(growthHref({ status: 'new' }), 'New', '●', { adminOnly: true, countKey: 'growth:new' }),
          nodeHref(growthHref({ status: 'in_progress' }), 'In Progress', '◐', { adminOnly: true, countKey: 'growth:in_progress' }),
          nodeHref(growthHref(), 'Submitted', '↧', { adminOnly: true, countKey: 'growth:submitted' }),
          nodeHref(growthHref({ status: 'under_review' }), 'Under Review', '◒', { adminOnly: true, countKey: 'growth:under_review' }),
          nodeHref(growthHref({ status: 'completed' }), 'Completed', '✓', { adminOnly: true, countKey: 'growth:closed', note: 'Mapped to the current Closed workflow status' }),
          nodeHref(growthHref({ status: 'archived' }), 'Archived', '□', { adminOnly: true, countKey: 'growth:closed', note: 'Mapped to the current Closed workflow status' })
        ]),
        branch('growth-form', 'Application Form', '☷', { href: growthHref({ view: 'settings' }) }, [
          nodeHref(growthHref({ view: 'settings', preview: 'quick_profile' }), 'Quick Profile', '1', { adminOnly: true }),
          nodeHref(growthHref({ view: 'settings', preview: 'growth_assessment' }), 'Growth Assessment', '2', { adminOnly: true }),
          nodeHref(growthHref({ view: 'settings', preview: 'deep_discovery' }), 'Deep Discovery', '3', { adminOnly: true }),
          nodeHref(growthHref({ view: 'settings', preview: 'resume' }), 'Resume Page', '4', { adminOnly: true }),
          nodeHref(growthHref({ view: 'settings', preview: 'pdf' }), 'PDF / Reports', 'PDF', { adminOnly: true }),
          nodeHref(growthHref({ view: 'settings' }), 'Form Settings', '⚙', { adminOnly: true }),
          nodeHref(growthHref({ view: 'settings' }), 'Placement & Visibility', '◫', { adminOnly: true })
        ])
      ], { adminOnly: true }),
      branch('directory', 'Directory', '⌖', { section: 'dirprofiles' }, [
        branch('directory-profiles', 'Profiles', '☺', { section: 'dirprofiles' }, [
          nodeSection('dirprofiles', 'All Profiles', '≡'),
          nodeSection('dirprofiles', 'Individuals', '☺'),
          nodeSection('dirprofiles', 'Businesses', '▣'),
          nodeSection('claims', 'Pending / Listing Claims', '!'),
          nodeSection('dirprofiles', 'Published', '✓')
        ]),
        nodeSection('reviews', 'Reviews', '★'),
        nodeSection('highlights', 'Highlights', '✦'),
        nodeSection('tags', 'Categories', '#'),
        nodeSection('dirprofiles', 'Map / Location View', '⌖'),
        nodeSection('projects', 'Investor Projects', '◆'),
        nodeSection('consultants', 'Representatives', '☏')
      ]),
      branch('community', 'Community', '♟', { section: 'users' }, [
        nodeSection('users', 'Members & Users', '♟'),
        nodeSection('myunplug', 'My Unplug Profiles', '☺'),
        nodeSection('partmembers', 'Participation Members', '◇'),
        nodeSection('staff', 'Staff & Permissions', '♜'),
        nodeSection('communitysettings', 'Community Settings', '⚙')
      ]),
      branch('gamification', 'Gamification', '★', { section: 'unplugmembers' }, [
        nodeSection('unplugmembers', 'Leaderboards / Member Scores', '↟'),
        nodeSection('badges', 'Badges & Recognition', '★'),
        nodeSection('unplugmissions', 'Missions', '✓'),
        nodeSection('unplugbizstatus', 'Business Status', '▣'),
        nodeSection('unplugmemberstatus', 'Member Status', '☺'),
        nodeSection('unplugstreaktiers', 'Streak Tiers', '≋'),
        nodeSection('unplugpointvalues', 'Point Values', '+'),
        nodeSection('halloffame', 'Hall of Fame', '♛')
      ]),
      branch('top10', 'Top 10', '10', { section: 'votebundles' }, [
        nodeSection('votebundles', 'Charts', '▥'),
        nodeSection('votebundles', 'Contestants', '☺'),
        nodeSection('votebundles', 'Entries', '↧'),
        nodeSection('votebundles', 'Free Votes', '○'),
        nodeSection('votebundles', 'Bulk Votes', '+'),
        nodeSection('votebundles', 'Vote Codes', '#'),
        nodeSection('top10monthly', 'Rankings / Results', '↟'),
        nodeSection('votebundles', 'Sponsors', '◆'),
        nodeSection('unplugtrust', 'Settings / Trust & Anti-Cheat', '⚙')
      ]),
      branch('competitions', 'Competitions', '🏆', { section: 'competitions' }, [
        nodeSection('competitions', 'Current', '●'),
        nodeSection('competitions', 'Upcoming', '◷'),
        nodeSection('competitions', 'Entries', '↧'),
        nodeSection('competitions', 'Winners', '★'),
        nodeSection('competitions', 'Prizes', '◆'),
        nodeSection('competitions', 'Sponsors', '▣'),
        nodeSection('competitions', 'Settings', '⚙')
      ]),
      branch('finance', 'Finance', 'R', { section: 'payqueue' }, [
        nodeSection('payqueue', 'Payments', 'R'),
        nodeSection('payqueue', 'Orders', '▥'),
        nodeSection('payments', 'EFT Proofs', '↧'),
        nodeSection('payqueue', 'Invoices', 'I'),
        nodeSection('payqueue', 'Receipts', '✓'),
        nodeSection('vouchers', 'Credits', '+'),
        nodeSection('cancellations', 'Refunds / Cancellations', '↶'),
        nodeSection('vouchers', 'Vouchers / Codes', '#'),
        nodeSection('payqueue', 'Transactions', '≡'),
        nodeSection('payqueue', 'Finance Reports', '▥'),
        nodeSection('checkouthealth', 'Checkout Health', '♥'),
        nodeSection('pricing', 'Service Pricing', 'R')
      ]),
      branch('advertising', 'Advertising', '▰', { section: 'adbanners' }, [
        nodeSection('adbanners', 'Banner Bookings', '▰'),
        nodeSection('adbanners', 'Homepage Banners', '⌂'),
        nodeSection('adbanners', 'Section Banners', '▤'),
        nodeSection('adbanners', 'Campaigns', '▶'),
        nodeSection('adbanners', 'Advertisers', '☺'),
        nodeSection('adbanners', 'Scheduled Banners', '◷'),
        nodeSection('adbanners', 'Expired', '□'),
        nodeSection('adbanners', 'Reports', '▥'),
        nodeSection('unplugsponsors', 'Sponsor Campaigns', '◆'),
        nodeSection('social', 'Social Feed', '@')
      ]),
      branch('impact-makers', 'Impact Makers', '✦', { section: 'impactmakers' }, [
        nodeSection('impactmakers', 'Impact Makers', '✦'),
        nodeSection('impactmakers', 'Banner Faces', '▧'),
        nodeSection('impactmakers', 'Categories', '#')
      ]),
      branch('unplug-live', 'Unplug Live', '▶', null, [
        nodeDisabled('live:events', 'Events (Coming Soon)', '◫', 'Coming Soon — this admin module has not been built yet.'),
        nodeDisabled('live:streams', 'Streams (Coming Soon)', '▶', 'Coming Soon — this admin module has not been built yet.'),
        nodeDisabled('live:tickets', 'Tickets / Orders (Coming Soon)', '▥', 'Coming Soon — this admin module has not been built yet.'),
        nodeDisabled('live:viewers', 'Viewers / Replays (Coming Soon)', '☺', 'Coming Soon — this admin module has not been built yet.'),
        nodeDisabled('live:organisers', 'Organisers / Payouts / Sponsors (Coming Soon)', '◆', 'Coming Soon — this admin module has not been built yet.'),
        nodeDisabled('live:settings', 'Settings (Coming Soon)', '⚙', 'Coming Soon — this admin module has not been built yet.')
      ]),
      branch('marketing', 'Marketing & CRM', '◎', { section: 'crm' }, [
        nodeSection('crm', 'Sales & CRM', '◎'),
        nodeSection('inquiries', 'Enquiries', '?'),
        nodeSection('emailmarketing', 'Email Marketing', '✉')
      ]),
      branch('pages', 'Pages & Layout', '▤', { section: 'pagecms' }, [
        nodeSection('pagecms', 'Page Content & Sections', '▤'),
        nodeSection('pagevisibility', 'Page Visibility', '◉'),
        nodeSection('comingsoon', 'Coming Soon Mode', '◷'),
        nodeSection('sitebuttons', 'Floating Buttons', '●'),
        nodeSection('popups', 'Popups', '▣'),
        nodeSection('placements', 'Marketplace Placements', '⌖')
      ]),
      branch('reports', 'Analytics & Reports', '▥', { section: 'analytics' }, [
        nodeSection('analytics', 'Website Analytics', '▥'),
        nodeSection('unplugpanalytics', 'Participation Analytics', '↟'),
        nodeSection('activitylog', 'Activity & Audit Log', '↺'),
        nodeSection('notifications', 'Notifications', '●')
      ]),
      branch('admin-tools', 'Admin Tools', '⚙', { section: 'sitesettings' }, [
        nodeSection('sitesettings', 'Site Settings', '⚙'),
        nodeSection('backups', 'Backups', '⬡'),
        nodeSection('checkouthealth', 'System / Checkout Health', '♥'),
        nodeSection('activitylog', 'Audit Logs', '↺'),
        nodeSection('notifications', 'Notifications / Email Signals', '✉'),
        nodeSection('redirects', 'Redirects & 404s', '↪'),
        nodeSection('spam', 'Spam Filter', '⊘')
      ]),
      branch('danger', 'Danger Zone', '⚠', null, [
        nodeSection('backups', 'Backup / Restore Controls', '⚠', { danger: true }),
        nodeSection('sitesettings', 'System-Level Settings', '⚠', { danger: true })
      ], { danger: true })
    ];

    function keyFor(node) {
      if (node.key) return node.key;
      if (node.type === 'section') return 'section:' + node.section + ':' + node.label;
      if (node.type === 'href') return 'href:' + node.href;
      if (node.type === 'branch') return 'branch:' + node.id;
      return node.type + ':' + node.label;
    }

    function visibleOriginal(section) {
      var a = originalAnchors[section];
      return !!a && a.style.display !== 'none';
    }

    function recordRecent(node, pathParts) {
      var key = keyFor(node);
      recent = recent.filter(function (x) { return x.key !== key; });
      recent.unshift({ key: key, label: node.label, section: node.section || '', href: node.href || '', path: pathParts || [] });
      recent = recent.slice(0, 6);
      writeJson(STORAGE.recent, recent);
      renderQuickLists();
    }

    function setFavourite(node, on) {
      var key = keyFor(node);
      if (on) favourites.add(key); else favourites.delete(key);
      writeJson(STORAGE.fav, Array.from(favourites));
      renderQuickLists();
      document.querySelectorAll('[data-cc-fav-key]').forEach(function (b) {
        if (b.dataset.ccFavKey === key) b.textContent = favourites.has(key) ? '★' : '☆';
      });
    }

    function findNodeByKey(key) { return state.nodeByKey.get(key) || null; }

    function activateSection(section, pathParts, node) {
      var a = originalAnchors[section];
      if (!a || a.style.display === 'none') return;
      a.click();
      state.currentKey = 'section:' + section;
      state.currentPath = pathParts || [section];
      setContext(state.currentPath);
      if (node) recordRecent(node, state.currentPath);
      syncActive(section);
    }

    function openHref(node, pathParts) {
      if (node.adminOnly && decodeRole() === 'staff') return;
      recordRecent(node, pathParts);
      window.location.href = node.href;
    }

    function syncActive(section) {
      document.querySelectorAll('.cc-leaf,.cc-branch-title').forEach(function (el) { el.classList.remove('active'); });
      document.querySelectorAll('[data-cc-section="' + CSS.escape(section) + '"]').forEach(function (el) { el.classList.add('active'); });
      var canonical = originalAnchors[section];
      if (canonical) {
        var group = canonical.closest('.cc-nav-group');
        if (group) group.classList.add('has-active');
      }
    }

    function decorateOriginal(a, node) {
      var badges = Array.from(a.querySelectorAll('span[id]'));
      badges.forEach(function (b) { b.remove(); });
      a.textContent = '';
      a.classList.add('cc-leaf');
      a.dataset.ccSection = node.section;
      a.dataset.ccLabel = node.label;
      a.insertAdjacentHTML('beforeend', icon(node.icon));
      var text = document.createElement('span');
      text.className = 'cc-leaf-text';
      text.textContent = node.label;
      a.appendChild(text);
      badges.forEach(function (b) { b.classList.add('cc-native-badge'); a.appendChild(b); });
      if (node.countKey) a.dataset.ccCountKey = node.countKey;
      if (node.attention) a.classList.add('attention');
      if (node.danger) a.classList.add('danger');
      return a;
    }

    function makeLeaf(node, pathParts) {
      var wrap = document.createElement('div');
      wrap.className = 'cc-nav-leaf-row';
      var key = keyFor(node);
      state.nodeByKey.set(key, node);

      var control;
      if (node.type === 'section' && originalAnchors[node.section] && !state.usedSections.has(node.section)) {
        state.usedSections.add(node.section);
        control = decorateOriginal(originalAnchors[node.section], node);
        control.addEventListener('click', function () {
          state.currentPath = pathParts.concat(node.label);
          setContext(state.currentPath);
          recordRecent(node, state.currentPath);
          syncActive(node.section);
        });
      } else if (node.type === 'section') {
        control = document.createElement('button');
        control.type = 'button';
        control.className = 'cc-leaf cc-alias';
        control.dataset.ccSection = node.section;
        control.dataset.ccLabel = node.label;
        control.innerHTML = icon(node.icon) + '<span class="cc-leaf-text"></span>';
        control.querySelector('.cc-leaf-text').textContent = node.label;
        control.addEventListener('click', function () { activateSection(node.section, pathParts.concat(node.label), node); });
        state.aliases.push({ el: control, section: node.section });
      } else if (node.type === 'href') {
        control = document.createElement('a');
        control.className = 'cc-leaf';
        control.href = node.href;
        control.dataset.ccLabel = node.label;
        control.innerHTML = icon(node.icon) + '<span class="cc-leaf-text"></span>';
        control.querySelector('.cc-leaf-text').textContent = node.label;
        control.addEventListener('click', function (e) {
          if (node.adminOnly && decodeRole() === 'staff') { e.preventDefault(); return; }
          recordRecent(node, pathParts.concat(node.label));
        });
      } else if (node.type === 'action') {
        control = document.createElement('button');
        control.type = 'button';
        control.className = 'cc-leaf';
        control.dataset.ccLabel = node.label;
        control.innerHTML = icon(node.icon) + '<span class="cc-leaf-text"></span>';
        control.querySelector('.cc-leaf-text').textContent = node.label;
        control.addEventListener('click', function () { node.action(); recordRecent(node, pathParts.concat(node.label)); });
      } else {
        control = document.createElement('button');
        control.type = 'button';
        control.disabled = true;
        control.className = 'cc-leaf cc-disabled';
        control.title = node.note || 'Not available';
        control.dataset.ccLabel = node.label;
        control.innerHTML = icon(node.icon) + '<span class="cc-leaf-text"></span>';
        control.querySelector('.cc-leaf-text').textContent = node.label;
      }

      if (node.note) control.title = node.note;
      if (node.adminOnly) control.dataset.ccAdminOnly = 'true';
      if (node.countKey) {
        var count = document.createElement('span');
        count.className = 'cc-count';
        count.dataset.ccCount = node.countKey;
        count.hidden = true;
        control.appendChild(count);
      }
      wrap.appendChild(control);

      if (node.type !== 'disabled') {
        var fav = document.createElement('button');
        fav.type = 'button';
        fav.className = 'cc-fav';
        fav.dataset.ccFavKey = key;
        fav.setAttribute('aria-label', 'Pin ' + node.label);
        fav.title = 'Pin / unpin';
        fav.textContent = favourites.has(key) ? '★' : '☆';
        fav.addEventListener('click', function (e) { e.stopPropagation(); setFavourite(node, !favourites.has(key)); });
        wrap.appendChild(fav);
      }
      return wrap;
    }

    function branchTarget(node, pathParts) {
      var ov = node.overview;
      if (!ov) return;
      if (ov.section) activateSection(ov.section, pathParts.concat(node.label));
      else if (ov.href) window.location.href = ov.href;
    }

    function makeBranch(node, depth, pathParts, topLevel) {
      var el = document.createElement('div');
      el.className = topLevel ? 'cc-nav-group nav-group' : 'cc-nav-branch';
      el.dataset.ccNode = node.id;
      if (node.adminOnly) el.dataset.ccAdminOnlyGroup = 'true';
      if (node.danger) el.classList.add('danger');
      var key = 'branch:' + node.id;
      state.nodeByKey.set(key, node);

      var head = document.createElement('div');
      head.className = topLevel ? 'cc-group-head' : 'cc-branch-head';
      var title = document.createElement('button');
      title.type = 'button';
      title.className = topLevel ? 'cc-group-title' : 'cc-branch-title';
      title.innerHTML = icon(node.icon) + '<span></span>';
      title.querySelector('span:last-child').textContent = node.label;
      title.title = node.overview ? 'Open ' + node.label + ' overview' : node.label;
      if (node.overview) title.addEventListener('click', function () { branchTarget(node, pathParts); });
      else title.disabled = true;

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'cc-toggle';
      toggle.setAttribute('aria-label', 'Expand ' + node.label);
      toggle.innerHTML = '<span aria-hidden="true">▾</span>';
      head.appendChild(title);
      head.appendChild(toggle);
      el.appendChild(head);

      var body = document.createElement('div');
      body.className = topLevel ? 'cc-group-items nav-group-items' : 'cc-branch-items';
      el.appendChild(body);

      var open = openState[node.id];
      if (open == null) open = ['dashboard', 'content'].includes(node.id);
      el.classList.toggle('open', !!open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.addEventListener('click', function () {
        var next = !el.classList.contains('open');
        el.classList.toggle('open', next);
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
        openState[node.id] = next;
        writeJson(STORAGE.open, openState);
      });

      if (node.dynamic === 'agreementTemplates') state.dynamicTemplatesHost = body;
      else node.children.forEach(function (child) {
        if (child.type === 'branch') body.appendChild(makeBranch(child, depth + 1, pathParts.concat(node.label), false));
        else body.appendChild(makeLeaf(child, pathParts.concat(node.label)));
      });
      return el;
    }

    // Quick areas above the full tree.
    var quick = document.createElement('div');
    quick.className = 'cc-quick-area';
    quick.innerHTML = '<div class="cc-quick-block"><div class="cc-quick-head">★ Favourites</div><div id="ccFavourites"></div></div>' +
      '<div class="cc-quick-block"><div class="cc-quick-head">↺ Recently Used</div><div id="ccRecent"></div></div>';
    root.appendChild(quick);

    var tree = document.createElement('nav');
    tree.className = 'cc-tree';
    tree.setAttribute('aria-label', 'Control Centre sections');
    root.appendChild(tree);
    model.forEach(function (n) { tree.appendChild(makeBranch(n, 0, [], true)); });

    function quickButton(item, node) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cc-quick-link';
      b.textContent = item.label || node?.label || 'Item';
      b.addEventListener('click', function () {
        if (node) {
          if (node.type === 'section') activateSection(node.section, item.path || [node.label], node);
          else if (node.type === 'href') openHref(node, item.path || [node.label]);
          else if (node.type === 'action') node.action();
        } else if (item.section) activateSection(item.section, item.path || [item.label]);
        else if (item.href) location.href = item.href;
      });
      return b;
    }

    function renderQuickLists() {
      var favHost = document.getElementById('ccFavourites');
      var recentHost = document.getElementById('ccRecent');
      if (!favHost || !recentHost) return;
      favHost.textContent = '';
      var favNodes = Array.from(favourites).map(findNodeByKey).filter(Boolean).slice(0, 5);
      if (!favNodes.length) {
        var empty = document.createElement('div'); empty.className = 'cc-quick-empty'; empty.textContent = 'Use ☆ beside any tool to pin it.'; favHost.appendChild(empty);
      } else favNodes.forEach(function (n) { favHost.appendChild(quickButton({ label: n.label, path: [n.label] }, n)); });

      recentHost.textContent = '';
      if (!recent.length) {
        var re = document.createElement('div'); re.className = 'cc-quick-empty'; re.textContent = 'Your recent tools will appear here.'; recentHost.appendChild(re);
      } else recent.slice(0, 5).forEach(function (r) { recentHost.appendChild(quickButton(r, findNodeByKey(r.key))); });
    }
    renderQuickLists();

    // Override the legacy sidebar filter so nested groups, external routes and
    // templates participate in the same search.
    search.addEventListener('input', function (e) {
      e.stopImmediatePropagation();
      var q = String(search.value || '').trim().toLowerCase();
      document.querySelectorAll('#ccNavRoot .cc-nav-leaf-row').forEach(function (row) {
        var label = (row.querySelector('[data-cc-label]')?.dataset.ccLabel || row.textContent || '').toLowerCase();
        row.classList.toggle('cc-search-hidden', !!q && !label.includes(q));
      });
      document.querySelectorAll('#ccNavRoot .cc-nav-branch,#ccNavRoot .cc-nav-group').forEach(function (g) {
        var matching = g.querySelector('.cc-nav-leaf-row:not(.cc-search-hidden)');
        g.classList.toggle('cc-search-hidden', !!q && !matching);
        if (q && matching) g.classList.add('open');
      });
      if (q) quick.classList.add('cc-search-hidden'); else quick.classList.remove('cc-search-hidden');
    }, true);

    // Breadcrumb + back-to-parent context bar.
    var contextBar = document.createElement('div');
    contextBar.className = 'cc-context-bar';
    contextBar.innerHTML = '<button type="button" class="cc-back" id="ccBack">← Back</button><div class="cc-breadcrumb" id="ccBreadcrumb"></div>';
    var globalSearch = main.querySelector('.global-search-wrap');
    if (globalSearch) globalSearch.insertAdjacentElement('afterend', contextBar); else main.prepend(contextBar);

    function setContext(parts) {
      state.currentPath = parts && parts.length ? parts : ['Dashboard', 'Overview'];
      var b = document.getElementById('ccBreadcrumb');
      if (b) b.textContent = ['Control Centre'].concat(state.currentPath).join('  ›  ');
      var back = document.getElementById('ccBack');
      if (back) back.hidden = state.currentPath.length < 2;
    }
    setContext(['Dashboard', 'Overview']);
    document.getElementById('ccBack').addEventListener('click', function () {
      if (state.currentPath.length <= 1) return activateSection('overview', ['Dashboard', 'Overview']);
      var parent = state.currentPath.slice(0, -1);
      if (parent[0] === 'Dashboard') activateSection('overview', ['Dashboard', 'Overview']);
      else {
        var top = model.find(function (n) { return n.label === parent[0]; });
        if (top && top.overview?.section) activateSection(top.overview.section, parent);
        else if (top && top.overview?.href) location.href = top.overview.href;
        else activateSection('overview', ['Dashboard', 'Overview']);
      }
    });

    function syncPermissions() {
      state.aliases.forEach(function (x) { x.el.closest('.cc-nav-leaf-row').hidden = !visibleOriginal(x.section); });
      if (decodeRole() === 'staff') {
        document.querySelectorAll('[data-cc-admin-only="true"]').forEach(function (el) {
          var row = el.closest('.cc-nav-leaf-row');
          if (row) row.hidden = true; else el.hidden = true;
        });
        document.querySelectorAll('[data-cc-admin-only-group="true"]').forEach(function (g) { g.hidden = true; });
      }
      // Reversed each pass, not just set true: a group whose only content
      // arrives asynchronously (Agreements' templates, e.g.) can genuinely
      // look empty on an early pass, before that content has loaded. A
      // one-way hide here would then hide it forever, since nothing ever
      // reconsiders a group once marked hidden. Recomputing both directions
      // every time means a group that gains content later becomes visible
      // again on the next pass (see the explicit re-sync calls at the end of
      // hydrateAgreementNavigation/hydrateGrowthCounts below, since neither
      // one's DOM insertion is an attribute change the MutationObserver here
      // would otherwise notice).
      //
      // The inline style is cleared explicitly, not left to `.hidden` alone:
      // something upstream of this script (order not established, and not
      // this script) sets `style.display:none` directly on these same
      // elements, which the `hidden` IDL property does not touch or
      // override. Setting style.display here is what actually makes a
      // previously-empty-looking group reappear once it has content.
      document.querySelectorAll('.cc-nav-group,.cc-nav-branch').forEach(function (g) {
        var visibleLeaf = Array.from(g.querySelectorAll(':scope > .cc-group-items > .cc-nav-leaf-row, :scope > .cc-branch-items > .cc-nav-leaf-row')).some(function (r) { return !r.hidden && !r.classList.contains('cc-search-hidden'); });
        var visibleBranch = Array.from(g.querySelectorAll(':scope > .cc-group-items > .cc-nav-branch, :scope > .cc-branch-items > .cc-nav-branch')).some(function (r) { return !r.hidden; });
        var shouldHide = !visibleLeaf && !visibleBranch && !g.querySelector('.cc-disabled');
        g.hidden = shouldHide;
        g.style.display = shouldHide ? 'none' : '';
      });
    }
    setTimeout(syncPermissions, 80);
    setTimeout(syncPermissions, 600);
    setTimeout(syncPermissions, 2500);
    new MutationObserver(function () { syncPermissions(); }).observe(sidebar, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });

    function setCount(key, value, tone) {
      var n = Number(value || 0);
      state.counts[key] = n;
      document.querySelectorAll('[data-cc-count="' + CSS.escape(key) + '"]').forEach(function (el) {
        el.textContent = String(n);
        el.hidden = false;
        el.classList.toggle('attention', tone === 'attention' || n > 0);
        el.classList.toggle('ok', tone === 'ok' && n === 0);
      });
    }

    function makeAgreementTemplateLeaf(t, pathParts) {
      var title = t.title || t.name || ('Template #' + t.id);
      var node = nodeHref(agreementHref({ template: t.id }), title, 'A', {
        adminOnly: true,
        note: 'Admin template · ' + (t.approval_status || 'draft')
      });
      var row = makeLeaf(node, pathParts);
      row.classList.add('cc-template-leaf-row');

      var fav = row.querySelector('.cc-fav');
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'cc-template-more';
      more.textContent = '⋯';
      more.title = 'Template quick actions';
      more.setAttribute('aria-label', 'Quick actions for ' + title);

      var menu = document.createElement('div');
      menu.className = 'cc-template-menu';
      menu.hidden = true;
      function action(label, fn, disabled, help) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.disabled = !!disabled;
        if (help) b.title = help;
        if (fn) b.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden = true; fn(); });
        menu.appendChild(b);
      }
      action('Open', function () { location.href = agreementHref({ template: t.id }); });
      action('Edit', function () { location.href = agreementHref({ template: t.id, action: 'edit' }); });
      action('Duplicate', async function () {
        var name = prompt('Name for duplicated template:', title + ' — Copy');
        if (!name) return;
        try {
          await requestJson('/agreement-forms/generator/admin/templates/' + encodeURIComponent(t.id) + '/duplicate', { method: 'POST', body: JSON.stringify({ name: name }) });
          alert('Template duplicated.');
          hydrateAgreementNavigation();
        } catch (e) { alert(e.message || 'Could not duplicate template.'); }
      });
      action('Preview', async function () {
        try {
          var blob = await getBlob('/agreement-forms/admin/' + encodeURIComponent(t.id) + '/preview/document');
          var u = URL.createObjectURL(blob);
          window.open(u, '_blank', 'noopener');
          setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
        } catch (e) { alert(e.message || 'Could not preview template.'); }
      });
      action('Create Agreement', async function () {
        if (!confirm('Create a new individual agreement from “' + title + '”?')) return;
        try {
          var d = await requestJson('/agreement-forms/generator/admin/agreements', { method: 'POST', body: JSON.stringify({ templateId: t.id }) });
          alert('Agreement created' + (d.agreement && d.agreement.reference ? ': ' + d.agreement.reference : '.'));
          location.href = agreementHref({ tab: 'agreements', status: 'draft' });
        } catch (e) { alert(e.message || 'Could not create agreement.'); }
      });
      var canRetire = String(t.approval_status || '').toLowerCase() === 'published';
      action('Archive / Retire', async function () {
        if (!confirm('Retire “' + title + '”? Existing agreement records stay unchanged.')) return;
        try {
          await requestJson('/agreement-forms/generator/admin/templates/' + encodeURIComponent(t.id) + '/approval', { method: 'POST', body: JSON.stringify({ status: 'retired', reason: 'Retired from Control Centre quick actions' }) });
          alert('Template retired.');
          hydrateAgreementNavigation();
        } catch (e) { alert(e.message || 'Could not retire template.'); }
      }, !canRetire, canRetire ? '' : 'The current workflow only allows Published templates to be retired.');
      action('Delete', null, true, 'Permanent template deletion is not exposed by the current Agreement Generator API. Use Archive / Retire instead.');

      more.addEventListener('click', function (e) {
        e.stopPropagation();
        document.querySelectorAll('.cc-template-menu').forEach(function (m) { if (m !== menu) m.hidden = true; });
        menu.hidden = !menu.hidden;
      });
      row.addEventListener('click', function (e) { if (!e.target.closest('.cc-template-menu,.cc-template-more')) menu.hidden = true; });
      if (fav) row.insertBefore(more, fav); else row.appendChild(more);
      row.appendChild(menu);
      return row;
    }

    document.addEventListener('click', function () {
      document.querySelectorAll('.cc-template-menu').forEach(function (m) { m.hidden = true; });
    });

    async function hydrateAgreementNavigation() {
      try {
        var results = await Promise.all([
          getJson('/agreement-forms/generator/admin/presets').catch(function () { return { presets: [] }; }),
          getJson('/agreement-forms/generator/admin/templates').catch(function () { return { templates: [] }; }),
          getJson('/agreement-forms/generator/admin/agreements').catch(function () { return { agreements: [] }; })
        ]);
        var presets = results[0].presets || [];
        var templates = results[1].templates || [];
        var agreements = results[2].agreements || [];

        ['draft','sent','submitted','signed','archived'].forEach(function (s) {
          setCount('agreements:' + s, agreements.filter(function (a) { return String(a.workflow_status) === s; }).length, s === 'draft' || s === 'sent' || s === 'submitted' ? 'attention' : '');
        });

        var host = state.dynamicTemplatesHost;
        if (!host) return;
        host.textContent = '';
        var sys = branch('agreement-system-templates', 'System Templates', 'S', { href: agreementHref() }, [], {});
        presets.slice(0, 8).forEach(function (p) {
          sys.children.push(nodeHref(agreementHref({ preset: p.id }), p.name || p.title || 'System template', 'S', { adminOnly: true, note: 'System preset' }));
        });
        if (presets.length > 8) sys.children.push(nodeHref(agreementHref(), 'View all system templates', '…', { adminOnly: true }));

        var adm = branch('agreement-admin-templates', 'Admin-Created Templates', 'A', { href: agreementHref() }, [], {});

        host.appendChild(makeBranch(sys, 2, ['Agreements','Templates'], false));
        var admEl = makeBranch(adm, 2, ['Agreements','Templates'], false);
        var admBody = admEl.querySelector('.cc-branch-items');
        templates.slice(0, 8).forEach(function (t) { admBody.appendChild(makeAgreementTemplateLeaf(t, ['Agreements','Templates','Admin-Created Templates'])); });
        if (!templates.length) admBody.appendChild(makeLeaf(nodeDisabled('agreement:no-admin-templates', 'No admin-created templates yet', '·', 'Create one in Agreement Generator'), ['Agreements','Templates','Admin-Created Templates']));
        if (templates.length > 8) admBody.appendChild(makeLeaf(nodeHref(agreementHref(), 'View all admin templates', '…', { adminOnly: true }), ['Agreements','Templates','Admin-Created Templates']));
        host.appendChild(admEl);
        renderQuickLists();

        // Replace the static Master link with the real master preset id when available.
        var master = presets.find(function (p) { return /agreement details.*master/i.test(String(p.name || p.title || '')); });
        if (master) {
          document.querySelectorAll('a.cc-leaf').forEach(function (a) {
            if (a.textContent.trim().includes('Master Agreement Details')) a.href = agreementHref({ preset: master.id });
          });
        }
      } catch (_) {}
      // The template/agreement fetch above is what the Agreements group's
      // visibility actually depends on (see syncPermissions' comment) — this
      // inserts new nodes via appendChild, which the style/class-only
      // MutationObserver never sees, so nothing else would ever re-check the
      // group once this resolves. Re-synced here regardless of success or
      // failure: on failure the group's own static leaves (Overview, Agreement
      // Generator, etc.) still keep it correctly visible.
      syncPermissions();
    }

    async function hydrateGrowthCounts() {
      try {
        var d = await getJson('/growth-application/admin/applications');
        var apps = d.applications || [];
        ['new','in_progress','under_review','closed'].forEach(function (s) {
          setCount('growth:' + s, apps.filter(function (a) { return String(a.status) === s; }).length, ['new','under_review'].includes(s) ? 'attention' : '');
        });
        setCount('growth:submitted', apps.filter(function (a) { return !!a.submitted_at; }).length, '');
      } catch (_) {}
      syncPermissions();
    }

    function addOverviewCards() {
      var overview = document.getElementById('section-overview');
      if (!overview || overview.querySelector('.cc-overview-grid')) return;
      var heading = overview.querySelector('.main-head');
      var grid = document.createElement('div');
      grid.className = 'cc-overview-grid';
      var cards = [
        ['Today', 'Open your operational inbox and act on what needs attention.', 'queue', '!'],
        ['Pending Approvals', 'Review submissions, requests and pending website changes.', 'queue', '✓'],
        ['Payments', 'Payments, EFT proof, orders, credits and cancellations.', 'payqueue', 'R'],
        ['Growth Applications', 'Research workspace, stages and Growth Journey applications.', null, '↗', growthHref()],
        ['Agreements', 'Templates, individual agreements, signing and records.', null, '✍', agreementHref()],
        ['Content', 'Articles, gallery, events, editions and participation content.', 'manage', '✎'],
        ['Members', 'Members, profiles, staff access and community administration.', 'users', '♟'],
        ['Site Health', 'Checkout and system-facing operational health controls.', 'checkouthealth', '♥'],
        ['Recent Activity', 'Audit trail and recent administrator activity.', 'activitylog', '↺'],
        ['Admin Tools', 'Backups, settings, redirects, spam and system controls.', 'sitesettings', '⚙']
      ];
      cards.forEach(function (c) {
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'cc-overview-card';
        card.innerHTML = '<span class="cc-overview-icon">' + c[3] + '</span><strong></strong><span></span><b>Open →</b>';
        card.querySelector('strong').textContent = c[0];
        card.querySelector('span:nth-of-type(2)').textContent = c[1];
        card.addEventListener('click', function () { if (c[2]) activateSection(c[2], [c[0]]); else location.href = c[4]; });
        grid.appendChild(card);
      });
      if (heading) heading.insertAdjacentElement('afterend', grid); else overview.prepend(grid);

      // User selected collapsible cards/panels, but not rearrangeable.
      var collapsed = readJson(STORAGE.collapsed, {});
      overview.querySelectorAll('.panel').forEach(function (panel, i) {
        var head = panel.querySelector('.panel-head');
        var body = panel.querySelector('.panel-body');
        if (!head || !body || head.querySelector('.cc-collapse')) return;
        var key = 'overview-panel-' + i;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cc-collapse';
        btn.textContent = collapsed[key] ? 'Show' : 'Hide';
        body.hidden = !!collapsed[key];
        btn.addEventListener('click', function () {
          body.hidden = !body.hidden;
          collapsed[key] = body.hidden;
          btn.textContent = body.hidden ? 'Show' : 'Hide';
          writeJson(STORAGE.collapsed, collapsed);
        });
        head.appendChild(btn);
      });
    }
    addOverviewCards();

    // Existing native badge spans already receive live counts. Mirror them into
    // a consistent count-chip treatment after loaders update them.
    function normalizeNativeBadges() {
      sidebar.querySelectorAll('.cc-native-badge').forEach(function (b) {
        b.classList.add('cc-count', 'attention');
        b.hidden = b.textContent.trim() === '' || b.style.display === 'none';
      });
    }
    setInterval(normalizeNativeBadges, 1200);

    // Keep the current section highlighted even when the dashboard's own router
    // changes active classes after this enhancement has rendered.
    var activeWatch = new MutationObserver(function () {
      var active = Object.values(originalAnchors).find(function (a) { return a.classList.contains('active'); });
      if (active) syncActive(active.dataset.section);
    });
    activeWatch.observe(source, { attributes: true, subtree: true, attributeFilter: ['class'] });

    // Counts/templates are non-blocking; the dashboard remains usable if any
    // optional module endpoint is unavailable.
    setTimeout(function () {
      hydrateAgreementNavigation();
      hydrateGrowthCounts();
    }, 350);

    // Mobile: selecting an enhanced navigation item closes the existing drawer.
    root.addEventListener('click', function (e) {
      if (!e.target.closest('.cc-leaf,.cc-quick-link')) return;
      if (window.matchMedia('(max-width:800px)').matches) {
        sidebar.classList.remove('m-open');
        var backdrop = document.getElementById('admBackdrop');
        if (backdrop) backdrop.hidden = true;
        var menu = document.getElementById('admMenuBtn');
        if (menu) menu.setAttribute('aria-expanded', 'false');
      }
    });
  }

  if (path.indexOf('unplug-agreement-generator-admin') !== -1) initAgreementDeepLink();
  else if (path.indexOf('unplug-growth-applications-admin') !== -1 && path.indexOf('-v2') === -1) initGrowthDeepLink();
  else if (path.indexOf('unplug-admin-dashboard') !== -1) ready(initDashboard);
})();
