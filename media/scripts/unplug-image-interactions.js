// Staging interaction layer for the universal image viewer.
//
// Goals:
// - a click directly on a meaningful image always opens the image viewer,
//   even when the image sits inside a profile/card/advertiser link;
// - the card/name itself keeps its normal navigation behaviour;
// - Top 10/profile thumbnails do not clip the full photograph into a circle;
// - filled page-banner slots follow the active image's real landscape/portrait
//   ratio instead of forcing every advertiser into one 16:9 box;
// - the viewer's advertiser CTA still records the existing first-party click.
(function installUnplugImageInteractions() {
  'use strict';
  if (window.UnplugImageInteractions) return;

  let pendingAdvert = null;
  const processed = new WeakSet();

  const style = document.createElement('style');
  style.id = 'unplugImageInteractionStyles';
  style.textContent = `
    /* A full photograph must not be clipped merely because an older card used
       a circular avatar treatment. The surrounding card can remain compact. */
    .rank-photo img[data-unplug-media="true"],
    .rank-photo img.unplug-media-fit,
    .profile-photo-lg img[data-unplug-media="true"],
    .profile-photo-lg img.unplug-media-fit {
      border-radius: 0 !important;
      object-fit: contain !important;
      object-position: center !important;
    }
    .rank-photo:has(img[data-unplug-media="true"]),
    .profile-photo-lg:has(img[data-unplug-media="true"]),
    .profile-photo-lg[data-unplug-bg-media="true"] {
      border-radius: 0 !important;
      overflow: visible !important;
      background: #f3efe8 !important;
    }

    /* Directory/member cards are allowed to follow the photograph's real
       orientation. This avoids chopping portrait or landscape photos into a
       compulsory square while preserving the existing grid width. */
    .dir-photo[data-unplug-natural-frame="true"] {
      height: auto !important;
      min-height: 120px;
      max-height: 620px;
      overflow: hidden;
      background: #f3efe8 !important;
    }
    .dir-photo[data-unplug-natural-frame="true"] > img {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
      object-position: center !important;
    }

    /* Filled ad/page-banner slots used to be hard locked to 16:9. In staging,
       follow the active banner's own ratio. Standalone portrait/square slots
       are centred and kept large enough to read without stretching. */
    [data-ad-slot].ad-slot-filled.unplug-banner-landscape {
      width: 100% !important;
      max-width: 1440px;
      margin-left: auto !important;
      margin-right: auto !important;
    }
    [data-ad-slot].ad-slot-filled.unplug-banner-portrait:not(.ad-card) {
      width: min(680px, 100%) !important;
      max-width: 680px;
      margin-left: auto !important;
      margin-right: auto !important;
    }
    [data-ad-slot].ad-slot-filled.unplug-banner-square:not(.ad-card) {
      width: min(860px, 100%) !important;
      max-width: 860px;
      margin-left: auto !important;
      margin-right: auto !important;
    }
    [data-ad-slot].ad-slot-filled .ad-slide img[data-unplug-media="true"] {
      object-fit: contain !important;
      object-position: center !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  function ratioType(w, h) {
    if (!w || !h) return 'landscape';
    const ratio = w / h;
    if (ratio > 1.12) return 'landscape';
    if (ratio < 0.89) return 'portrait';
    return 'square';
  }

  function adaptNaturalFrame(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const frame = img.closest('.dir-photo');
    if (!frame) return;
    // Natural-ratio cards are appropriate for Directory/Members/highlighted
    // profiles. Keep tiny specialist avatars untouched.
    frame.dataset.unplugNaturalFrame = 'true';
    frame.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
  }

  function activeBannerImage(slot) {
    if (!slot) return null;
    const active = slot.querySelector('.ad-slide.is-active img');
    return active || slot.querySelector('.ad-slide img, img');
  }

  function adaptBannerSlot(slot) {
    if (!slot || !slot.classList.contains('ad-slot-filled')) return;
    const img = activeBannerImage(slot);
    if (!img) return;
    const apply = function () {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const type = ratioType(img.naturalWidth, img.naturalHeight);
      slot.classList.remove('unplug-banner-landscape', 'unplug-banner-portrait', 'unplug-banner-square');
      slot.classList.add('unplug-banner-' + type);
      slot.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
      slot.dataset.unplugBannerOrientation = type;
    };
    if (img.complete) apply();
    else img.addEventListener('load', apply, { once: true });
  }

  function processImage(img) {
    if (!img || processed.has(img)) return;
    processed.add(img);
    const apply = function () {
      adaptNaturalFrame(img);
      const slot = img.closest('[data-ad-slot]');
      if (slot) adaptBannerSlot(slot);
    };
    if (img.complete && img.naturalWidth) apply();
    else img.addEventListener('load', apply, { once: true });
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    if (scope.tagName === 'IMG') processImage(scope);
    if (scope.querySelectorAll) scope.querySelectorAll('img').forEach(processImage);
    if (scope.matches && scope.matches('[data-ad-slot].ad-slot-filled')) adaptBannerSlot(scope);
    if (scope.querySelectorAll) scope.querySelectorAll('[data-ad-slot].ad-slot-filled').forEach(adaptBannerSlot);
  }

  function mediaFromTarget(target) {
    if (!target || !target.closest) return null;
    const media = target.closest('[data-unplug-media="true"]');
    if (!media || media.dataset.unplugPlaceholder === 'true') return null;
    if (media.closest('.unplug-lightbox')) return null;
    return media;
  }

  function rememberAdvert(media) {
    pendingAdvert = null;
    if (!media || !media.closest) return;
    const link = media.closest('a[data-ad-click]');
    if (!link) return;
    const id = String(link.getAttribute('data-ad-click') || '').trim();
    const href = String(link.getAttribute('href') || '').trim();
    if (id && href) pendingAdvert = { id: id, href: href };
  }

  function openMedia(media, event) {
    if (!media || !window.UnplugImageViewer || typeof window.UnplugImageViewer.open !== 'function') return false;
    rememberAdvert(media);
    if (event) {
      event.preventDefault();
      // Capture phase matters here. Some profile/Top-10 cards have their own
      // navigation handlers; image clicks belong to the viewer instead.
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    }
    window.UnplugImageViewer.open(media);
    return true;
  }

  function apiBase() {
    try {
      if (window.UnplugAPI && typeof window.UnplugAPI.getApiBase === 'function') {
        return String(window.UnplugAPI.getApiBase() || '').replace(/\/+$/, '');
      }
    } catch (_) {}
    return String(window.UNPLUG_RUNTIME_API || '').replace(/\/+$/, '');
  }

  function recordAdvertClick(id) {
    const base = apiBase();
    if (!base || !id) return;
    const url = base + '/ad-banners/' + encodeURIComponent(id) + '/event';
    // Mirror the site's existing first-party tracker. Using fetch + keepalive
    // avoids cross-origin sendBeacon/content-type ambiguity while still
    // allowing navigation to continue immediately after the CTA is clicked.
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'click' }),
        keepalive: true
      }).catch(function () {});
    } catch (_) {}
  }

  // Capture-phase image click: image opens; card/name links remain normal when
  // the user clicks the text rather than the photograph.
  document.addEventListener('click', function (event) {
    const cta = event.target && event.target.closest && event.target.closest('.unplug-lightbox-cta');
    if (cta) {
      if (pendingAdvert) {
        recordAdvertClick(pendingAdvert.id);
        pendingAdvert = null;
      }
      return;
    }

    const media = mediaFromTarget(event.target);
    if (media) openMedia(media, event);
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const media = mediaFromTarget(event.target);
    if (!media) return;
    openMedia(media, event);
  }, true);

  const observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) scan(node);
      });
      if (mutation.type === 'attributes') {
        const node = mutation.target;
        if (node && node.nodeType === 1) {
          if (node.matches && node.matches('.ad-slide')) {
            const slot = node.closest('[data-ad-slot]');
            if (slot) adaptBannerSlot(slot);
          } else if (node.tagName === 'IMG') {
            processImage(node);
          }
        }
      }
    });
  });

  function init() {
    scan(document);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'src', 'srcset']
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.UnplugImageInteractions = {
    scan: function () { scan(document); },
    adaptBannerSlot: adaptBannerSlot
  };
})();