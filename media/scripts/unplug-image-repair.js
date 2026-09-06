// ---------------------------------------------------------------------------
// Staging image-source repair layer
// ---------------------------------------------------------------------------
// Loaded after the universal viewer. It never points staging at production.
// It only asks the already-selected Unplug API for another *existing* image
// belonging to the same public profile when a stored headline image is missing
// or broken. If no real alternate exists, the viewer's branded placeholder
// remains in place.
(function installUnplugImageRepair() {
  'use strict';
  if (window.UnplugImageRepair) return;

  const profileCache = new Map();
  let top10Promise = null;
  let highlightedPromise = null;
  const repairing = new WeakSet();
  const backgroundRepairing = new WeakSet();
  const backgroundsSeen = new WeakSet();
  const emptyFramesSeen = new WeakSet();

  function apiBase() {
    try {
      if (window.UnplugAPI && typeof window.UnplugAPI.getApiBase === 'function') {
        return String(window.UnplugAPI.getApiBase() || '').replace(/\/+$/, '');
      }
    } catch (_) {}
    return String(window.UNPLUG_RUNTIME_API || '').replace(/\/+$/, '');
  }

  async function getJson(path) {
    const base = apiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + path, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  function cleanUrl(value) {
    let raw = String(value || '').trim();
    if (!raw || raw.indexOf('data:image/svg+xml') === 0) return '';
    if (/^javascript:/i.test(raw)) return '';
    if (raw.startsWith('//')) raw = 'https:' + raw;
    if (location.protocol === 'https:' && /^http:\/\//i.test(raw)) raw = raw.replace(/^http:/i, 'https:');
    try {
      // Relative media paths are site assets. Resolve them from the origin,
      // not from a pretty-URL page such as /unplug-magazine.
      if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith('/')) {
        return new URL('/' + raw.replace(/^\.\//, ''), location.origin).href;
      }
      return new URL(raw, location.href).href;
    } catch (_) {
      return '';
    }
  }

  function sameUrl(a, b) {
    const aa = cleanUrl(a); const bb = cleanUrl(b);
    return !!aa && !!bb && aa === bb;
  }

  function extractBackgroundUrl(value) {
    if (!value || value === 'none') return '';
    const match = String(value).match(/url\((?:\"|')?(.*?)(?:\"|')?\)/i);
    return match ? match[1] : '';
  }

  function slugFromHref(href) {
    if (!href) return '';
    try {
      const u = new URL(href, location.href);
      if (u.searchParams.get('p') !== 'profile') return '';
      return String(u.searchParams.get('slug') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function slugFromNode(node) {
    if (!node || !node.closest) return '';
    const own = node.closest('[data-slug]');
    if (own && own.dataset.slug) return String(own.dataset.slug).trim();

    const card = node.closest('.member-card,.dir-card-wrap,.card-shell,.profile-header,.rank-row,.poll-row,.new-entry-card') || node;
    const links = card.querySelectorAll ? card.querySelectorAll('a[href]') : [];
    for (const link of links) {
      const slug = slugFromHref(link.getAttribute('href'));
      if (slug) return slug;
    }

    const here = new URLSearchParams(location.search);
    if (here.get('p') === 'profile' && here.get('slug')) return here.get('slug');
    return '';
  }

  function labelFromNode(node) {
    if (!node || !node.closest) return '';
    if (node.tagName === 'IMG' && node.alt) return String(node.alt).trim();
    const card = node.closest('.member-card,.dir-card-wrap,.card-shell,.rank-row,.poll-row,.new-entry-card') || node;
    const label = card.querySelector && card.querySelector('h1,h2,h3,h4,.rank-name,.poll-name,.gallery-title');
    return label ? String(label.textContent || '').trim() : '';
  }

  function profileCandidates(data) {
    if (!data) return [];
    const out = [];
    if (data.profile && data.profile.feature_image_url) out.push(data.profile.feature_image_url);
    (data.gallery || []).forEach(function (g) { if (g && g.image_url) out.push(g.image_url); });
    return out.map(cleanUrl).filter(Boolean);
  }

  function fetchProfile(slug) {
    const key = String(slug || '').trim();
    if (!key) return Promise.resolve(null);
    if (!profileCache.has(key)) {
      profileCache.set(key, getJson('/profiles/' + encodeURIComponent(key)));
    }
    return profileCache.get(key);
  }

  async function candidateFromProfile(slug, failed) {
    const data = await fetchProfile(slug);
    for (const candidate of profileCandidates(data)) {
      if (!sameUrl(candidate, failed)) return candidate;
    }
    return '';
  }

  function fetchTop10() {
    if (!top10Promise) top10Promise = getJson('/competitions/top-10');
    return top10Promise;
  }

  async function top10Candidate(node, failed) {
    if (!node || !node.closest || !node.closest('.rank-row,.poll-row,.new-entry-card,#homeTop10Grid')) return '';
    const data = await fetchTop10();
    if (!data || !Array.isArray(data.entries)) return '';
    const label = labelFromNode(node).toLowerCase();
    const entry = data.entries.find(function (e) {
      return String(e.display_name || '').trim().toLowerCase() === label;
    });
    if (!entry) return '';

    for (const direct of [entry.cover_image_url, entry.image_url, entry.manual_image_url]) {
      const candidate = cleanUrl(direct);
      if (candidate && !sameUrl(candidate, failed)) return candidate;
    }
    if (entry.profile_slug) return candidateFromProfile(entry.profile_slug, failed);
    return '';
  }

  async function highlightedDirectoryData() {
    if (highlightedPromise) return highlightedPromise;
    highlightedPromise = (async function () {
      const active = await getJson('/highlights/active');
      const rows = active && Array.isArray(active.highlights)
        ? active.highlights.filter(function (h) { return h.target_type === 'directory'; }).slice(0, 12)
        : [];
      if (!rows.length) return [];
      const ids = rows.map(function (h) { return h.target_id; }).filter(Boolean);
      const dir = await getJson('/directory?ids=' + encodeURIComponent(ids.join(',')) + '&limit=60');
      const profiles = dir && Array.isArray(dir.profiles) ? dir.profiles : [];
      return profiles;
    })();
    return highlightedPromise;
  }

  async function highlightedCandidate(node, failed) {
    if (!node || !node.closest || !node.closest('#highlightedProfilesGrid')) return '';
    const label = labelFromNode(node).toLowerCase();
    if (!label) return '';
    const profiles = await highlightedDirectoryData();
    const profile = profiles.find(function (p) {
      return String(p.display_name || '').trim().toLowerCase() === label;
    });
    if (!profile) return '';
    const direct = cleanUrl(profile.feature_image_url);
    if (direct && !sameUrl(direct, failed)) return direct;
    return candidateFromProfile(profile.slug, failed);
  }

  async function contextualCandidate(node, failed) {
    const slug = slugFromNode(node);
    if (slug) {
      const profile = await candidateFromProfile(slug, failed);
      if (profile) return profile;
    }
    const top = await top10Candidate(node, failed);
    if (top) return top;
    return highlightedCandidate(node, failed);
  }

  function clearViewerPlaceholderState(img) {
    delete img.dataset.unplugPlaceholder;
    delete img.dataset.unplugOriginalSrc;
    delete img.dataset.unplugFallback;
    delete img.dataset.unplugImageSetup;
    img.classList.remove('unplug-img-broken');
  }

  function removePictureSources(img) {
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (picture) picture.querySelectorAll('source').forEach(function (source) { source.removeAttribute('srcset'); });
    img.removeAttribute('srcset');
  }

  function setBackgroundCandidate(el, candidate) {
    return new Promise(function (resolve) {
      const url = cleanUrl(candidate);
      if (!url) return resolve(false);
      const probe = new Image();
      probe.onload = function () {
        delete el.dataset.unplugPlaceholder;
        delete el.dataset.unplugOriginalBgSrc;
        delete el.dataset.unplugBgChecked;
        delete el.dataset.unplugBgMedia;
        delete el.dataset.unplugBgSrc;
        el.classList.remove('unplug-img-broken');
        el.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
        el.style.backgroundSize = 'contain';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundPosition = 'center';
        if (window.UnplugImageViewer && typeof window.UnplugImageViewer.scan === 'function') {
          window.UnplugImageViewer.scan();
        }
        resolve(true);
      };
      probe.onerror = function () { resolve(false); };
      probe.src = url;
    });
  }

  async function repairBackground(el, failedSource) {
    if (!el || backgroundRepairing.has(el) || el.closest('.unplug-lightbox')) return;
    backgroundRepairing.add(el);
    try {
      const failed = cleanUrl(failedSource || el.dataset.unplugOriginalBgSrc || el.dataset.unplugBgSrc || '');
      const contextual = cleanUrl(await contextualCandidate(el, failed));
      if (contextual && !sameUrl(contextual, failed)) {
        await setBackgroundCandidate(el, contextual);
      }
      // If there is no genuine same-profile alternate, leave the viewer's
      // branded placeholder. We never invent or borrow another person's image.
    } finally {
      backgroundRepairing.delete(el);
    }
  }

  function inspectBackground(el) {
    if (!el || backgroundsSeen.has(el) || el.closest('.unplug-lightbox')) return;
    const computed = getComputedStyle(el).backgroundImage || '';
    const src = extractBackgroundUrl(computed);
    if (!src) return;
    backgroundsSeen.add(el);

    if (src.indexOf('data:image/svg+xml') === 0 || el.dataset.unplugPlaceholder === 'true') {
      repairBackground(el, el.dataset.unplugOriginalBgSrc || '');
      return;
    }

    const original = cleanUrl(src);
    if (!original) return;
    const probe = new Image();
    probe.onload = function () {};
    probe.onerror = function () {
      el.dataset.unplugOriginalBgSrc = original;
      repairBackground(el, original);
    };
    probe.src = original;
  }

  function setCandidate(img, candidate) {
    return new Promise(function (resolve) {
      const url = cleanUrl(candidate);
      if (!url) return resolve(false);
      clearViewerPlaceholderState(img);
      removePictureSources(img);
      let settled = false;
      const done = function (ok) {
        if (settled) return;
        settled = true;
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        resolve(ok);
      };
      const onLoad = function () {
        img.dataset.unplugOriginal = url;
        if (window.UnplugImageViewer && typeof window.UnplugImageViewer.scan === 'function') {
          window.UnplugImageViewer.scan();
        }
        done(true);
      };
      const onError = function () { done(false); };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      img.src = url;
    });
  }

  async function repairImage(img) {
    if (!img || repairing.has(img) || img.closest('.unplug-lightbox')) return;
    repairing.add(img);
    try {
      const failed = img.dataset.unplugOriginalSrc || img.dataset.unplugOriginal || img.currentSrc || img.getAttribute('src') || '';
      const tried = new Set([cleanUrl(failed)].filter(Boolean));

      // A <picture> may have selected a broken mobile/derived source while its
      // ordinary <img src> original is perfectly good. Always try that first.
      const originalAttr = cleanUrl(img.getAttribute('src'));
      if (originalAttr && !tried.has(originalAttr) && await setCandidate(img, originalAttr)) return;
      if (originalAttr) tried.add(originalAttr);

      const explicit = cleanUrl(img.dataset.unplugFallbackSrc || '');
      if (explicit && !tried.has(explicit) && await setCandidate(img, explicit)) return;
      if (explicit) tried.add(explicit);

      const contextual = cleanUrl(await contextualCandidate(img, failed));
      if (contextual && !tried.has(contextual) && await setCandidate(img, contextual)) return;

      // No genuine alternate exists. The universal viewer has already replaced
      // the failed source with its Unplug placeholder; leave that in place.
    } finally {
      repairing.delete(img);
    }
  }

  async function fillProfileFrame(frame) {
    if (!frame || emptyFramesSeen.has(frame)) return;
    if (frame.querySelector('img')) return;
    const bg = getComputedStyle(frame).backgroundImage || '';
    if (bg && bg !== 'none' && /url\(/i.test(bg)) return;
    const slug = slugFromNode(frame);
    if (!slug) return;
    emptyFramesSeen.add(frame);
    const data = await fetchProfile(slug);
    const candidates = profileCandidates(data);
    if (!candidates.length) return;

    const img = document.createElement('img');
    img.alt = labelFromNode(frame);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.unplugViewer = 'true';
    img.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain;object-position:center;';
    const placeholderMark = frame.querySelector('.print-mark');
    if (placeholderMark) placeholderMark.remove();
    frame.appendChild(img);
    await setCandidate(img, candidates[0]);
  }

  function scanBackgrounds(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const selectors = '.dir-photo,.profile-photo-lg,.profile-gallery-item,[data-ad-slot],[class*="banner"],[class*="poster"],[class*="maker"],[class*="cover"]';
    if (scope.matches && scope.matches(selectors)) inspectBackground(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(selectors).forEach(inspectBackground);
  }

  function scanEmptyFrames(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const frames = [];
    if (scope.matches && scope.matches('.member-card .dir-photo,.dir-card[data-slug] .dir-photo,.profile-photo-lg')) frames.push(scope);
    if (scope.querySelectorAll) {
      scope.querySelectorAll('.member-card .dir-photo,.dir-card[data-slug] .dir-photo,.profile-photo-lg').forEach(function (frame) { frames.push(frame); });
    }
    frames.forEach(function (frame) { fillProfileFrame(frame); });
  }

  function scanBroken(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const imgs = [];
    if (scope.tagName === 'IMG') imgs.push(scope);
    if (scope.querySelectorAll) scope.querySelectorAll('img').forEach(function (img) { imgs.push(img); });
    imgs.forEach(function (img) {
      if (img.dataset.unplugPlaceholder === 'true' || (img.complete && !img.naturalWidth && !String(img.src || '').startsWith('data:'))) {
        repairImage(img);
      }
    });
    scanBackgrounds(scope);
    scanEmptyFrames(scope);
  }

  document.addEventListener('error', function (event) {
    if (event.target && event.target.tagName === 'IMG') {
      // The viewer's own error handler may run first and paint the placeholder.
      // Defer one microtask so its original-source marker is available to us.
      Promise.resolve().then(function () { repairImage(event.target); });
    }
  }, true);

  const observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) scanBroken(node);
      });
      if (mutation.type === 'attributes' && mutation.target) {
        if (mutation.target.tagName === 'IMG') {
          scanBroken(mutation.target);
        } else if (mutation.attributeName === 'style') {
          // A SPA renderer may reuse a frame with a new background URL.
          backgroundsSeen.delete(mutation.target);
          inspectBackground(mutation.target);
        }
      }
    });
  });

  function init() {
    scanBroken(document);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.UnplugImageRepair = { scan: function () { scanBroken(document); }, repairImage: repairImage };
})();
